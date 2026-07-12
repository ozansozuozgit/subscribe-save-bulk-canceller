// Background service worker — owns the single run-state object and the queue state machine.
// State is stored under one key `sns_run` so we get atomic reads/writes and a clean shape
// to render the UI from (no juggling of loose keys like v1 did).

const KEY = 'sns_run';
const OPTS_KEY = 'sns_options';

const DEFAULT_OPTIONS = {
  reason: "I don't want this item anymore",
  // Short, human-paced gap between items. Kept non-zero so Amazon's session
  // doesn't see machine-gun navigation. Tunable in Settings.
  jitterMs: [600, 1200],
  maxAttempts: 1,
};

const EMPTY_RUN = {
  status: 'idle', // idle | reviewing | previewing | running | paused | done
  items: [],
  currentIndex: -1,
  reason: DEFAULT_OPTIONS.reason,
  jitterMs: DEFAULT_OPTIONS.jitterMs,
  startedAt: 0,
  finishedAt: 0,
  tabId: null,
};

// ---------- Storage helpers ----------
async function getRun() {
  const r = await chrome.storage.local.get(KEY);
  return r[KEY] || { ...EMPTY_RUN };
}

async function setRun(run) {
  await chrome.storage.local.set({ [KEY]: run });
  return run;
}

async function patchRun(patch) {
  const cur = await getRun();
  const next = { ...cur, ...patch };
  await setRun(next);
  return next;
}

async function getOptions() {
  const r = await chrome.storage.local.get(OPTS_KEY);
  return { ...DEFAULT_OPTIONS, ...(r[OPTS_KEY] || {}) };
}

// ---------- Queue helpers ----------
function nextPendingIndex(items, fromIndex = 0) {
  for (let i = Math.max(0, fromIndex); i < items.length; i++) {
    const it = items[i];
    if (!it.keep && it.status === 'pending') return i;
  }
  return -1;
}

function summarize(items) {
  let cancelled = 0, failed = 0, kept = 0, pending = 0, inflight = 0, skipped = 0;
  for (const it of items) {
    if (it.keep) { kept++; continue; }
    if (it.status === 'done') cancelled++;
    else if (it.status === 'failed') failed++;
    else if (it.status === 'inflight') inflight++;
    else if (it.status === 'skipped') skipped++;
    else pending++;
  }
  return { cancelled, failed, kept, pending, inflight, skipped, total: items.length };
}

// ---------- Tab navigation ----------
async function navigateTo(tabId, url) {
  try {
    if (tabId) {
      await chrome.tabs.update(tabId, { url, active: true });
      return tabId;
    }
  } catch (e) {
    console.warn('SNS BG: tab nav failed, falling back', e);
  }
  // Fallback: pick first Amazon tab or create a new one
  const tabs = await chrome.tabs.query({ url: 'https://www.amazon.com/*' });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { url, active: true });
    return tabs[0].id;
  }
  const t = await chrome.tabs.create({ url, active: true });
  return t.id;
}

// Pick the URL we actually drive in the tab. Prefer the constructed
// /cancelSubscription URL when we have a subscriptionId — it lands directly
// on the working confirm page and skips the broken /ajax/subscription
// detail page that errors when loaded standalone.
function urlForItem(it) {
  return it.cancelUrl || it.editUrl;
}

async function advanceToNext(fromIndex) {
  const run = await getRun();
  if (run.status !== 'running') return;
  const nextIdx = nextPendingIndex(run.items, (fromIndex ?? run.currentIndex) + 1);
  if (nextIdx === -1) {
    await finishRun(run);
    return;
  }
  // Jitter delay then navigate
  const [lo, hi] = run.jitterMs || DEFAULT_OPTIONS.jitterMs;
  const delay = Math.floor(lo + Math.random() * Math.max(1, hi - lo));
  setTimeout(async () => {
    const fresh = await getRun();
    if (fresh.status !== 'running') return;
    const updated = { ...fresh, currentIndex: nextIdx };
    updated.items = fresh.items.map((it, i) =>
      i === nextIdx ? { ...it, status: 'inflight', attempts: (it.attempts || 0) + 1 } : it
    );
    await setRun(updated);
    await navigateTo(fresh.tabId, urlForItem(fresh.items[nextIdx]));
  }, delay);
}

async function finishRun(run) {
  const summary = summarize(run.items);
  await setRun({ ...run, status: 'done', finishedAt: Date.now() });
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/128.png',
      title: 'Subscribe & Save — Done',
      message:
        `Cancelled ${summary.cancelled} of ${summary.cancelled + summary.failed + summary.skipped}` +
        (summary.failed ? ` · ${summary.failed} failed` : '') +
        (summary.kept ? ` · ${summary.kept} kept` : ''),
    });
  } catch (e) {
    console.warn('SNS BG: notification failed', e);
  }
}

// ---------- Message handlers ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'sns:getState') {
        sendResponse(await getRun());
        return;
      }

      if (msg?.type === 'sns:getOptions') {
        sendResponse(await getOptions());
        return;
      }

      if (msg?.type === 'sns:setOptions') {
        const cur = await getOptions();
        const next = { ...cur, ...(msg.options || {}) };
        await chrome.storage.local.set({ [OPTS_KEY]: next });
        sendResponse({ ok: true, options: next });
        return;
      }

      if (msg?.type === 'sns:scanComplete') {
        // Seed run state from a fresh scan. Preserve user options.
        const opts = await getOptions();
        const items = (msg.items || []).map((it) => ({
          ...it,
          keep: false,
          status: 'pending',
          attempts: 0,
        }));
        const run = {
          ...EMPTY_RUN,
          status: 'reviewing',
          items,
          reason: opts.reason,
          jitterMs: opts.jitterMs,
          tabId: sender?.tab?.id || null,
        };
        await setRun(run);
        sendResponse({ ok: true, run });
        return;
      }

      if (msg?.type === 'sns:setKeep') {
        // toggle keep for a list of item ids
        const cur = await getRun();
        const keepSet = new Set(msg.keepIds || []);
        const items = cur.items.map((it) => ({ ...it, keep: keepSet.has(it.id) }));
        await setRun({ ...cur, items });
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'sns:startRun') {
        const cur = await getRun();
        const opts = await getOptions();
        const items = cur.items.map((it) => {
          if (it.keep) return { ...it, status: 'skipped', attempts: 0, error: undefined };
          // No edit link captured (common on the new subscriptionList layout) —
          // we cannot drive a cancel without it. Mark up front so the user sees it
          // in the Needs Attention list instead of silently navigating to "null".
          if (!it.editUrl && !it.cancelUrl) {
            return { ...it, status: 'failed', attempts: 0, error: 'No subscription ID detected — cancel manually from Amazon.' };
          }
          return { ...it, status: 'pending', attempts: 0, error: undefined };
        });
        const firstIdx = nextPendingIndex(items, 0);
        if (firstIdx === -1) {
          // Nothing we can drive — but save the failed/skipped statuses so the
          // popup can show the user what happened.
          await setRun({ ...cur, items, status: 'done', finishedAt: Date.now() });
          const failedCount = items.filter((i) => i.status === 'failed').length;
          sendResponse({
            ok: false,
            error: failedCount
              ? `None of these have a direct edit link. Open them from the extension popup to cancel manually.`
              : 'Nothing to cancel.',
          });
          return;
        }
        const run = {
          ...cur,
          status: 'running',
          items,
          currentIndex: firstIdx,
          // Honor an explicitly-empty reason as "no preference — skip reason step"
          reason: Object.prototype.hasOwnProperty.call(msg, 'reason') ? (msg.reason || '') : (opts.reason || cur.reason || ''),
          jitterMs: opts.jitterMs,
          startedAt: Date.now(),
          finishedAt: 0,
          tabId: sender?.tab?.id || cur.tabId || null,
        };
        run.items[firstIdx] = { ...run.items[firstIdx], status: 'inflight', attempts: 1 };
        await setRun(run);
        await navigateTo(run.tabId, urlForItem(run.items[firstIdx]));
        sendResponse({ ok: true, run });
        return;
      }

      if (msg?.type === 'sns:itemDone') {
        const cur = await getRun();
        if (cur.status !== 'running' || cur.currentIndex < 0) {
          sendResponse({ ok: false });
          return;
        }
        const idx = cur.currentIndex;
        const items = cur.items.map((it, i) =>
          i === idx ? { ...it, status: 'done', finishedAt: Date.now(), error: undefined } : it
        );
        await setRun({ ...cur, items });
        sendResponse({ ok: true });
        await advanceToNext(idx);
        return;
      }

      if (msg?.type === 'sns:itemFailed') {
        const cur = await getRun();
        if (cur.status !== 'running' || cur.currentIndex < 0) {
          sendResponse({ ok: false });
          return;
        }
        const idx = cur.currentIndex;
        const items = cur.items.map((it, i) =>
          i === idx ? { ...it, status: 'failed', finishedAt: Date.now(), error: msg.error || 'Unknown error' } : it
        );
        await setRun({ ...cur, items });
        sendResponse({ ok: true });
        await advanceToNext(idx);
        return;
      }

      if (msg?.type === 'sns:pause') {
        const cur = await getRun();
        if (cur.status === 'running') await setRun({ ...cur, status: 'paused' });
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'sns:resume') {
        const cur = await getRun();
        if (cur.status !== 'paused') {
          sendResponse({ ok: false });
          return;
        }
        const idx = nextPendingIndex(cur.items, Math.max(0, cur.currentIndex));
        if (idx === -1) {
          await finishRun(cur);
          sendResponse({ ok: true });
          return;
        }
        const items = cur.items.map((it, i) =>
          i === idx ? { ...it, status: 'inflight', attempts: (it.attempts || 0) + 1 } : it
        );
        const run = { ...cur, status: 'running', items, currentIndex: idx };
        await setRun(run);
        await navigateTo(run.tabId, urlForItem(run.items[idx]));
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'sns:skipCurrent') {
        const cur = await getRun();
        if (cur.status !== 'running' || cur.currentIndex < 0) {
          sendResponse({ ok: false });
          return;
        }
        const idx = cur.currentIndex;
        const items = cur.items.map((it, i) =>
          i === idx ? { ...it, status: 'skipped', error: 'Skipped by user' } : it
        );
        await setRun({ ...cur, items });
        sendResponse({ ok: true });
        await advanceToNext(idx);
        return;
      }

      if (msg?.type === 'sns:stop') {
        const cur = await getRun();
        await setRun({ ...cur, status: 'done', finishedAt: Date.now() });
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'sns:reset') {
        await setRun({ ...EMPTY_RUN });
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: 'Unknown message' });
    } catch (err) {
      console.error('SNS BG: handler error', err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true; // async
});

// On install: seed defaults
chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get([KEY, OPTS_KEY]);
  if (!cur[KEY]) await chrome.storage.local.set({ [KEY]: { ...EMPTY_RUN } });
  if (!cur[OPTS_KEY]) await chrome.storage.local.set({ [OPTS_KEY]: { ...DEFAULT_OPTIONS } });
});
