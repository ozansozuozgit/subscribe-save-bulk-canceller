// Real-browser layout test: loads the unpacked extension into Playwright's
// Chromium, serves a mocked Subscribe & Save page that carries hostile global
// CSS (like Amazon's, only worse), and checks that the launcher, review panel,
// confirm dialog, progress card and finish summary still render at a sensible
// size and position. Every request is answered locally; nothing reaches the
// real amazon.com.
//
// Needs Playwright with its bundled Chromium. It is looked up as `playwright`,
// then $SNS_PLAYWRIGHT, then ../../work/node_modules/playwright. Without it the
// test is skipped with a message; set SNS_REQUIRE_BROWSER=1 to fail instead.
// Set SNS_SHOTS_DIR=/some/dir to save a screenshot of each step.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const REQUIRE_BROWSER = process.env.SNS_REQUIRE_BROWSER === '1';

function loadPlaywright() {
  const candidates = ['playwright', process.env.SNS_PLAYWRIGHT, path.resolve(ROOT, '../work/node_modules/playwright')].filter(Boolean);
  for (const id of candidates) {
    try { return require(id); } catch (_) { /* try the next one */ }
  }
  return null;
}

// Extensions only load in Chromium's new headless mode (channel "chromium"),
// or headful when a display is available (e.g. under xvfb-run).
async function launch(chromium, extDir) {
  const args = [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run'];
  const attempts = [{ channel: 'chromium', headless: true }];
  if (process.env.DISPLAY) attempts.push({ headless: false });
  const errors = [];
  for (const opts of attempts) {
    let ctx;
    try {
      ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'sns-browser-')), {
        ...opts, args, viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1,
      });
      // A cold first start (empty disk cache, busy machine) can take a while.
      const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 60000 });
      return { ctx, sw };
    } catch (err) {
      errors.push(`${JSON.stringify(opts)}: ${String(err.message || err).split('\n')[0]}`);
      await ctx?.close().catch(() => {});
    }
  }
  throw new Error(`could not start Chromium with the extension (${errors.join('; ')})`);
}

// A copy with only the extension's own files (no node_modules or tests).
function copyExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sns-ext-'));
  for (const name of fs.readdirSync(ROOT)) {
    if (name.startsWith('.') || ['node_modules', 'tests'].includes(name)) continue;
    fs.cpSync(path.join(ROOT, name), path.join(dir, name), { recursive: true });
  }
  return dir;
}

// Global page CSS that would wreck any UI it can reach.
const HOSTILE_CSS = `
  * { max-width: 80px !important; white-space: normal !important; font-size: 20px !important; line-height: 2 !important; }
  html, body { font: 24px/3 serif; letter-spacing: 3px; word-spacing: 12px; text-align: center; color: #f0f; }
  button { display: block; width: 100%; padding: 30px; margin: 20px; border: 4px solid lime; }
  div { position: static !important; }
  span, strong, em { display: block; padding: 6px; }
  svg { width: 200px; height: 200px; }
  section, h2, ul, li, details, summary, input, select { display: block; margin: 40px; float: left; }
  html > :not(head):not(body) { transform: scale(0.5) !important; opacity: 0.2 !important; filter: blur(3px) !important; }
  * { box-sizing: content-box !important; }
`;

// A real-sized product image. The scanner treats images narrower than 24 px
// as lazy-load placeholders and keeps rescanning (for up to ~8 s) until real
// ones load, so a 1x1 image would slow every scan down.
function solidPng(size, [r, g, b]) {
  const zlib = require('node:zlib');
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3).map((_, i) => [r, g, b][i % 3])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(size).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = solidPng(64, [230, 120, 90]);
const ITEMS = [
  ['SNST0_T1', 'Paper Towels, 12 Double Rolls', 'Sat, Nov 7', '1 unit every 1 month'],
  ['SNST0_T2', 'Coffee Pods, Medium Roast, 72 Count', 'Wed, Nov 4', '1 unit every 2 weeks'],
  ['SNST0_T3', 'Dish Soap, Lemon Scent, 3-Pack', 'Sat, Nov 21', '1 unit every 3 months'],
];

function mockPage(cancelled) {
  const live = ITEMS.filter(([sid]) => !cancelled.has(sid));
  const tile = ([sid, title, date, freq]) => `
    <div class="tile" data-edit-url="/auto-deliveries/ajax/subscription/?subscriptionId=${sid}&amp;subAsin=B0TEST${sid.slice(-1)}">
      <img alt="${title}" src="https://www.amazon.com/test-assets/${sid}.png" width="80" height="80">
      <span class="a-truncate-full a-offscreen">${title}</span>
      <div>${title}</div><div><span>Next delivery by ${date}</span></div><div><span>${freq}</span></div>
      <div role="button" data-edit-link="true" data-sid="${sid}">Edit</div>
    </div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Test page</title><style>${HOSTILE_CSS}</style></head><body>
<h1>Subscribe &amp; Save (test page)</h1>
<div id="grid">${live.map(tile).join('')}</div>
<script>
(function(){
  let back = null;
  const close = () => { if (back) { back.remove(); back = null; } };
  function open(sid) {
    close();
    back = document.createElement('div');
    back.innerHTML = '<div role="dialog" aria-label="Edit subscription"><a href="/auto-deliveries/cancelSubscription?subscriptionId=' + sid + '">Cancel subscription</a></div>';
    document.body.appendChild(back);
    back.querySelector('a').addEventListener('click', (e) => { e.preventDefault(); setTimeout(() => form(sid), 100); });
  }
  function form(sid) {
    const dlg = back.querySelector('[role=dialog]');
    dlg.innerHTML = '<form action="/auto-deliveries/ajax/cancelSubscriptionAction?subscriptionId=' + sid + '" method="post">' +
      '<select name="sns-cancellation-dropdown"><option value="">Select</option><option value="unused">I no longer use this product</option></select>' +
      '<button type="submit">Cancel my subscription</button></form>';
    dlg.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await fetch(e.target.action, { method: 'POST', body: new FormData(e.target) });
      dlg.innerHTML = '<h4>Your subscription has been cancelled.</h4>';
    });
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit-link]');
    if (b) setTimeout(() => open(b.dataset.sid), 100);
  });
})();
</script></body></html>`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Waits until the element's own animations (entrance slide/fade) have finished,
// so its box is final. Infinite ones (spinners) are ignored.
async function animationsDone(locator) {
  await locator.evaluate((el) => Promise.all(el.getAnimations()
    .filter((a) => a.effect?.getTiming().iterations !== Infinity)
    .map((a) => a.finished.catch(() => {}))));
}
async function boxOf(locator) {
  const box = await locator.boundingBox();
  assert.ok(box, 'element has a layout box');
  return box;
}
// The card is re-drawn on every per-item page load; retry across navigations.
async function settle(fn, { timeout = 60000 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    try { return await fn(); } catch (err) {
      if (Date.now() > end) throw err;
      await sleep(150);
    }
  }
}

test('injected UI keeps its size and position under hostile page CSS (real Chromium)', { timeout: 300000 }, async (t) => {
  const pw = loadPlaywright();
  if (!pw) {
    const why = 'Playwright not found (npm i playwright, or set SNS_PLAYWRIGHT)';
    if (REQUIRE_BROWSER) throw new Error(why);
    t.skip(why); return;
  }
  const extDir = copyExtension();
  let ctx, sw;
  try {
    ({ ctx, sw } = await launch(pw.chromium, extDir));
  } catch (err) {
    if (REQUIRE_BROWSER) throw err;
    t.skip(`${err.message}. Install it with \`npx playwright install chromium\` or run under xvfb-run.`); return;
  }
  const cancelled = new Set();
  const escaped = [];
  try {
    // Swallow handler errors: a request still in flight when the context closes
    // must not surface as an unhandled rejection after the test has ended.
    await ctx.route('**/*', (route) => handle(route).catch(() => {}));
    async function handle(route) {
      const u = new URL(route.request().url());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return route.continue();
      if (u.hostname !== 'www.amazon.com') { escaped.push(u.href); return route.abort(); }
      if (/^\/auto-deliveries(\/subscriptionList)?\/?$/.test(u.pathname)) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: mockPage(cancelled) });
      if (u.pathname.startsWith('/test-assets/')) return route.fulfill({ contentType: 'image/png', body: PNG });
      if (u.pathname === '/auto-deliveries/ajax/cancelSubscriptionAction') {
        cancelled.add(u.searchParams.get('subscriptionId'));
        return route.fulfill({ contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 404, body: '' });
    }
    await sw.evaluate(() => chrome.storage.local.set({ sns_options: { reason: '', jitterMs: [300, 400] } }));
    const page = ctx.pages()[0] || await ctx.newPage();
    const vw = 1280, vh = 720;
    const shot = async (name) => {
      if (process.env.SNS_SHOTS_DIR) await page.screenshot({ path: path.join(process.env.SNS_SHOTS_DIR, `hostile-${name}.png`) }).catch(() => {});
    };
    await page.goto('https://www.amazon.com/auto-deliveries/subscriptionList');

    // The hostile CSS really is live on the page.
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#grid')).maxWidth), '80px');

    // Launcher: one line, bottom-right, not squashed.
    const launcher = page.locator('#sns-launcher');
    await page.waitForFunction(() => /3 subscriptions · Review/.test(document.getElementById('sns-root')?.shadowRoot?.getElementById('sns-launcher')?.textContent || ''), null, { timeout: 90000 });
    const lb = await boxOf(launcher);
    assert.ok(lb.height < 48, `launcher is one line (height ${lb.height})`);
    assert.ok(lb.width > 180, `launcher is not squashed (width ${lb.width})`);
    assert.ok(Math.abs(vw - 16 - (lb.x + lb.width)) <= 2, `launcher is 16px from the right (right edge ${lb.x + lb.width})`);
    assert.ok(Math.abs(vh - 16 - (lb.y + lb.height)) <= 2, `launcher is 16px from the bottom (bottom edge ${lb.y + lb.height})`);
    const textBox = await boxOf(page.locator('#sns-launcher-text'));
    assert.ok(textBox.height < 24, `launcher text did not wrap (height ${textBox.height})`);
    const textStyle = await page.locator('#sns-launcher-text').evaluate((el) => {
      const cs = getComputedStyle(el); return { fontSize: cs.fontSize, whiteSpace: cs.whiteSpace, letterSpacing: cs.letterSpacing };
    });
    assert.deepEqual(textStyle, { fontSize: '13.5px', whiteSpace: 'nowrap', letterSpacing: 'normal' }, 'page styles do not reach the launcher');
    const hostStyle = await page.evaluate(() => { const cs = getComputedStyle(document.getElementById('sns-root')); return [cs.opacity, cs.transform, cs.filter]; });
    assert.deepEqual(hostStyle, ['1', 'none', 'none'], 'page rules that match the host itself are overridden');
    await shot('1-launcher');

    // Review panel: opens at its designed size, anchored bottom-right.
    await launcher.click();
    const card = page.locator('.sns-card');
    await card.waitFor();
    await page.locator('.sns-item').nth(2).waitFor();
    await animationsDone(card); // entrance slide-in
    await shot('2-panel');
    const cb = await boxOf(card);
    assert.ok(cb.width >= 360 && cb.width <= 400, `panel width ${cb.width}`);
    assert.ok(cb.height >= 400 && cb.height <= vh - 32 + 1, `panel height ${cb.height}`);
    assert.ok(Math.abs(vw - 16 - (cb.x + cb.width)) <= 2 && Math.abs(vh - 16 - (cb.y + cb.height)) <= 2, 'panel anchored bottom-right');
    for (const row of await page.locator('.sns-item').all()) {
      const rb = await boxOf(row);
      assert.ok(rb.height < 90 && rb.width > 300, `row ${rb.width}x${rb.height}`);
    }
    const seg = await boxOf(page.locator('.sns-seg'));
    assert.ok(seg.height < 44, `filter buttons on one line (height ${seg.height})`);
    const preview = await boxOf(page.locator('#sns-preview'));
    assert.ok(preview.height < 48 && preview.y + preview.height <= vh, 'footer button visible');
    if (await page.locator('#sns-how-done').isVisible()) await page.locator('#sns-how-done').click();
    assert.equal(await page.evaluate(() => document.getElementById('sns-root').shadowRoot.activeElement?.id || null), 'sns-help', 'focus is managed across the shadow boundary');

    // Pick two to cancel, then the confirm dialog.
    await page.locator('.sns-item', { hasText: 'Paper Towels' }).click();
    await page.locator('.sns-item', { hasText: 'Dish Soap' }).click();
    await page.locator('#sns-preview').click();
    const dialog = page.locator('.sns-modal');
    await dialog.waitFor();
    await animationsDone(dialog);
    await shot('3-confirm');
    const db = await boxOf(dialog);
    assert.ok(db.width >= 500 && db.width <= 520, `dialog width ${db.width}`);
    assert.ok(Math.abs(db.x + db.width / 2 - vw / 2) <= 2, 'dialog is centred');
    assert.ok(db.y >= 0 && db.y + db.height <= vh, 'dialog fits the viewport');
    assert.equal(await page.locator('#sns-modal-title').textContent(), 'Cancel 2 subscriptions, keep 1.');
    const confirmBox = await boxOf(page.locator('#sns-confirm-run'));
    assert.ok(confirmBox.height < 48 && confirmBox.width < 200, `confirm button ${confirmBox.width}x${confirmBox.height}`);
    await page.locator('#sns-confirm-run').click();

    // Progress card: drawn while the run moves from page to page.
    await settle(async () => {
      const pb = await page.locator('.sns-progress').boundingBox({ timeout: 1000 });
      assert.ok(pb, 'progress card visible');
      assert.ok(pb.width >= 320 && pb.width <= 360, `progress width ${pb.width}`);
      assert.ok(pb.height >= 120 && pb.height <= vh - 32, `progress height ${pb.height}`);
      assert.ok(Math.abs(vw - 16 - (pb.x + pb.width)) <= 2 && Math.abs(vh - 16 - (pb.y + pb.height)) <= 2, 'progress card anchored bottom-right');
      assert.match(await page.locator('.sns-progress__label').textContent({ timeout: 1000 }), /Cancelling|Paused/);
    });
    await shot('4-progress');

    // Finish summary: visible, not covered, sensible size.
    await page.locator('.sns-progress__dot--done').waitFor({ timeout: 120000 });
    const finish = await settle(() => page.evaluate(() => {
      const host = document.getElementById('sns-progress-root');
      const card = host.shadowRoot.querySelector('.sns-progress');
      const r = card.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      return {
        w: r.width, h: r.height, right: r.right, bottom: r.bottom,
        topIsHost: document.elementFromPoint(x, y) === host,
        inCard: card.contains(host.shadowRoot.elementFromPoint(x, y)),
        title: card.querySelector('.sns-progress__title').textContent,
        managerShown: !!document.getElementById('sns-root')?.shadowRoot?.querySelector('.sns-card,.sns-launcher'),
      };
    }));
    await shot('5-finished');
    assert.equal(finish.title, '2 cancelled, 1 kept.');
    assert.ok(finish.topIsHost && finish.inCard, 'finish summary is not covered');
    assert.equal(finish.managerShown, false, 'the review panel stays out of the way');
    assert.ok(finish.w >= 320 && finish.w <= 360 && finish.h >= 150, `finish summary ${finish.w}x${finish.h}`);
    assert.ok(Math.abs(vw - 16 - finish.right) <= 2 && Math.abs(vh - 16 - finish.bottom) <= 2, 'finish summary anchored bottom-right');

    assert.deepEqual([...cancelled].sort(), ['SNST0_T1', 'SNST0_T3']);
    assert.deepEqual(escaped, [], 'no request left the mock');
  } finally {
    await ctx.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    await ctx.close().catch(() => {});
    fs.rmSync(extDir, { recursive: true, force: true });
  }
});
