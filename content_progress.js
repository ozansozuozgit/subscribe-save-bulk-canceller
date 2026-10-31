// Renders the persistent floating progress card while a run is active, and the
// finish summary when it ends. Runs on the subscription pages so it survives
// the tab navigations of a run (one full page load per item).
// State source: chrome.storage.local 'sns_run' (mirrors bg.js).
//
// v2.1.2: this script is injected at document_start and draws the card
// straight from the saved run state, without an entrance animation, so the
// card no longer blinks out and fades back in on every per-item page load.
// The .sns-progress element is created once per page and only its contents
// are replaced, and only when the rendered markup actually changes.

(function () {
  if (window.__SNS_PROGRESS_BOOTED__) return;
  window.__SNS_PROGRESS_BOOTED__ = true;

  // Use a SEPARATE root from content_manager so we never stomp on each other's UI.
  const ROOT_ID = 'sns-progress-root';
  const OWNED_ATTR = 'data-sns-progress-owned';
  const SUBS_URL = 'https://www.amazon.com/auto-deliveries/subscriptionList';
  const DEFAULT_PER_ITEM_MS = 9000; // first estimate, before any item has finished

  let panelEl = null;
  let lastHtml = '';
  let latestRun;
  let renderQueued = false;
  let notice = ''; // local message, e.g. when the extension was reloaded

  const nextFrame = (fn) => (window.requestAnimationFrame ? window.requestAnimationFrame(fn) : setTimeout(fn, 16));

  function ensureRoot() {
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      root.setAttribute(OWNED_ATTR, '1');
      document.documentElement.appendChild(root);
    }
    return root;
  }

  function ensurePanel() {
    const root = ensureRoot();
    if (!panelEl || panelEl.parentNode !== root) {
      root.replaceChildren();
      panelEl = document.createElement('div');
      // Restored from saved state on page load: no entrance animation.
      panelEl.className = 'sns-progress sns-progress--restored';
      panelEl.setAttribute('role', 'region');
      panelEl.setAttribute('aria-label', 'Cancellation progress');
      panelEl.addEventListener('click', onClick);
      root.appendChild(panelEl);
      lastHtml = '';
    }
    return panelEl;
  }

  function clearOwnRoot() {
    const root = document.getElementById(ROOT_ID);
    if (root) root.replaceChildren();
    panelEl = null;
    lastHtml = '';
  }

  // Never throws (see content_manager.js): resolves undefined when the
  // extension can't be reached, e.g. after it was reloaded mid-run.
  function msg(type, payload) {
    return new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ type, ...(payload || {}) }, (reply) => {
          void chrome.runtime.lastError;
          res(reply);
        });
      } catch (_) {
        res(undefined);
      }
    });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function summarize(items) {
    let cancelled = 0, failed = 0, kept = 0, skipped = 0, inflight = 0, pending = 0;
    for (const it of items) {
      if (it.keep) { kept++; continue; }
      if (it.status === 'done') cancelled++;
      else if (it.status === 'failed') failed++;
      else if (it.status === 'inflight') inflight++;
      else if (it.status === 'skipped') skipped++;
      else pending++;
    }
    return { cancelled, failed, kept, skipped, inflight, pending, total: items.length, totalToProcess: items.length - kept };
  }

  // "About 40 sec left": the average time per finished item so far, times the
  // items still to go. Before the first item finishes, use the pause setting
  // plus a typical page time.
  function timeLeftText(run, s, now = Date.now()) {
    const finished = s.cancelled + s.failed + s.skipped;
    const remaining = s.totalToProcess - finished;
    if (remaining <= 0) return '';
    let perItem;
    if (finished > 0 && run.startedAt && now > run.startedAt) {
      perItem = (now - run.startedAt) / finished;
    } else {
      const [lo, hi] = Array.isArray(run.jitterMs) ? run.jitterMs : [2000, 5000];
      perItem = (lo + hi) / 2 + DEFAULT_PER_ITEM_MS / 2;
      if (!Number.isFinite(perItem) || perItem <= 0) perItem = DEFAULT_PER_ITEM_MS;
    }
    const sec = Math.round((perItem * remaining) / 1000);
    if (sec < 10) return 'A few seconds left';
    if (sec < 60) return `About ${Math.round(sec / 5) * 5} sec left`;
    const min = Math.round(sec / 60);
    return `About ${min} min left`;
  }

  function list(items, cls, withError = false) {
    return `<ul class="sns-sum__list ${cls}">${items.map((i) => `
      <li><span class="sns-sum__name">${escapeHtml(i.title || 'Untitled')}</span>${withError && i.error ? `<span class="sns-sum__why">${escapeHtml(i.error)}</span>` : ''}</li>`).join('')}</ul>`;
  }

  function finishHtml(run, s) {
    const items = run.items || [];
    const cancelled = items.filter((i) => !i.keep && i.status === 'done');
    const kept = items.filter((i) => i.keep);
    const failed = items.filter((i) => !i.keep && i.status === 'failed');
    const skipped = items.filter((i) => !i.keep && (i.status === 'skipped' || i.status === 'pending'));
    const parts = [`${s.cancelled} cancelled`];
    if (s.kept) parts.push(`${s.kept} kept`);
    if (s.failed) parts.push(`${s.failed} failed`);
    if (skipped.length) parts.push(`${skipped.length} not done`);
    const section = (label, arr, cls, open, withError) => arr.length ? `
        <details class="sns-sum"${open ? ' open' : ''}>
          <summary>${label} (${arr.length})</summary>
          ${list(arr, cls, withError)}
        </details>` : '';
    return `
        <div class="sns-progress__head">
          <div class="sns-progress__dot ${s.failed ? 'sns-progress__dot--paused' : 'sns-progress__dot--done'}" aria-hidden="true"></div>
          <h2 class="sns-progress__label">${s.failed ? 'Finished, with problems' : 'Finished'}</h2>
        </div>
        <div class="sns-progress__title" role="status">${escapeHtml(parts.join(', '))}.</div>
        <div class="sns-progress__body">
          ${section('Needs attention', failed, 'sns-sum__list--fail', true, true)}
          ${section('Cancelled', cancelled, 'sns-sum__list--ok', !failed.length, false)}
          ${section('Kept', kept, 'sns-sum__list--keep', false, false)}
          ${section('Not done', skipped, 'sns-sum__list--skip', false, true)}
          <a class="sns-progress__link" id="sns-check-amazon" href="${SUBS_URL}" target="_blank" rel="noopener">Double-check on Amazon<span aria-hidden="true"> ↗</span><span class="sns-sr"> (opens in a new tab)</span></a>
        </div>
        ${noticeHtml()}
        <div class="sns-progress__controls">
          <button type="button" id="sns-rescan-after">Rescan</button>
          <button type="button" id="sns-dismiss" class="sns-primary">Done</button>
        </div>`;
  }

  function noticeHtml() {
    return notice ? `<div class="sns-progress__note sns-progress__note--warn" role="alert">${escapeHtml(notice)}</div>` : '';
  }

  function panelHtml(run, now) {
    const s = summarize(run.items || []);
    if (run.status === 'done') return finishHtml(run, s);

    const done = s.cancelled + s.failed + s.skipped;
    const pct = s.totalToProcess > 0 ? Math.min(100, Math.round((done / s.totalToProcess) * 100)) : 0;
    const current = run.items?.[run.currentIndex];
    const paused = run.status === 'paused';
    const position = Math.min(done + (s.inflight ? 1 : 0), s.totalToProcess) || Math.min(1, s.totalToProcess);
    const meta = [paused ? 'Paused' : timeLeftText(run, s, now), `${s.cancelled} cancelled`];
    if (s.kept) meta.push(`${s.kept} kept`);
    if (s.failed) meta.push(`${s.failed} failed`);
    let note = paused
      ? (run.pausedReason || 'Paused. Press Resume to continue.')
      : 'Keep this tab open. You can pause anytime.';
    if (current?.error) note = current.error;

    return `
        <div class="sns-progress__head">
          <div class="sns-progress__dot${paused ? ' sns-progress__dot--paused' : ''}" aria-hidden="true"></div>
          <h2 class="sns-progress__label">${paused ? 'Paused' : 'Cancelling'}</h2>
          <div class="sns-progress__count">${position} of ${s.totalToProcess}</div>
        </div>
        <div class="sns-progress__title" aria-live="polite">${escapeHtml(current?.title || 'Getting ready…')}</div>
        <div class="sns-progress__bar" role="progressbar" aria-label="Cancelled so far" aria-valuemin="0" aria-valuemax="${s.totalToProcess}" aria-valuenow="${done}">
          <div class="sns-progress__bar-fill" style="width:${pct}%"></div>
        </div>
        <div class="sns-progress__meta">${meta.filter(Boolean).map(escapeHtml).join(' · ')}</div>
        <div class="sns-progress__note${current?.error || run.pausedReason ? ' sns-progress__note--warn' : ''}">${escapeHtml(note)}</div>
        ${noticeHtml()}
        <div class="sns-progress__controls">
          ${paused
            ? '<button type="button" id="sns-resume" class="sns-primary">Resume</button>'
            : '<button type="button" id="sns-pause">Pause</button>'
          }
          <button type="button" id="sns-skip"${paused ? ' disabled title="Resume to skip the current item"' : ''}>Skip item</button>
          <button type="button" id="sns-stop" class="sns-danger">Stop</button>
        </div>`;
  }

  function render(run) {
    if (!run || (run.status !== 'running' && run.status !== 'paused' && run.status !== 'done')) {
      // Nothing for us to render. Clear ONLY our own root, never content_manager's.
      clearOwnRoot();
      return;
    }
    const panel = ensurePanel();
    const html = panelHtml(run);
    if (html !== lastHtml) {
      panel.innerHTML = html;
      lastHtml = html;
    }
  }

  // Several storage writes can land in the same frame; render once.
  function scheduleRender(run) {
    latestRun = run;
    if (renderQueued) return;
    renderQueued = true;
    nextFrame(() => {
      renderQueued = false;
      render(latestRun);
    });
  }

  async function send(type) {
    const reply = await msg(type);
    if (reply === undefined) {
      notice = 'The extension was updated or reloaded, so this page lost contact with it. Reload the page to continue.';
      render(latestRun);
    }
    return reply;
  }

  // One delegated listener on the persistent panel; survives content updates.
  function onClick(e) {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    switch (btn.id) {
      case 'sns-pause': send('sns:pause'); break;
      case 'sns-resume': send('sns:resume'); break;
      case 'sns-skip': send('sns:skipCurrent'); break;
      case 'sns-stop':
        if (confirm('Stop now? Items already cancelled stay cancelled. The rest are left as they are.')) send('sns:stop');
        break;
      case 'sns-dismiss': send('sns:reset'); break;
      case 'sns-rescan-after': location.href = SUBS_URL; break;
      default: break;
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.sns_run) return;
    scheduleRender(changes.sns_run.newValue);
  });

  // Draw immediately from saved state (no waiting for the page or the
  // background), then confirm with the background's view of the run.
  function restore() {
    try {
      const p = chrome.storage.local.get('sns_run');
      if (p && p.then) p.then((r) => { if (latestRun === undefined && r?.sns_run) { latestRun = r.sns_run; render(r.sns_run); } }).catch(() => {});
    } catch (_) { /* storage not reachable from here: fall back to the message */ }
    msg('sns:getState').then((run) => {
      if (run === undefined) return;
      latestRun = run;
      render(run);
    });
  }
  restore();

  // Keep "time left" current between storage writes (only touches the DOM
  // when the text changes).
  setInterval(() => {
    if (latestRun?.status === 'running') render(latestRun);
  }, 5000);

  window.SNSProgress = { timeLeftText, summarize };
})();
