// Renders the persistent floating progress panel while a run is active.
// Runs on the subscription pages so it survives the tab navigations of a run.
// State source: chrome.storage.local 'sns_run' (mirrors bg.js).
//
// Rendering: the .sns-progress element is created once and only its contents
// are replaced, and only when the rendered markup actually changes. Before,
// every storage write (several per cancelled item) rebuilt the whole panel,
// which replayed its entrance animation, so the panel flickered on every step.

(function () {
  if (window.__SNS_PROGRESS_BOOTED__) return;
  window.__SNS_PROGRESS_BOOTED__ = true;

  // Use a SEPARATE root from content_manager so we never stomp on each other's UI.
  // (Both scripts run on manager pages because the manifest patterns overlap.)
  const ROOT_ID = 'sns-progress-root';
  const OWNED_ATTR = 'data-sns-progress-owned';

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
      panelEl.className = 'sns-progress';
      panelEl.setAttribute('role', 'status');
      panelEl.setAttribute('aria-live', 'polite');
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

  function panelHtml(run) {
    const s = summarize(run.items || []);
    const done = s.cancelled + s.failed + s.skipped;
    const pct = s.totalToProcess > 0 ? Math.min(100, Math.round((done / s.totalToProcess) * 100)) : 0;
    const current = run.items?.[run.currentIndex];
    const noticeHtml = notice ? `<div class="sns-progress__summary sns-progress__notice" role="alert">${escapeHtml(notice)}</div>` : '';

    if (run.status === 'done') {
      return `
          <div class="sns-progress__head">
            <div class="sns-progress__dot sns-progress__dot--done"></div>
            <div class="sns-progress__label">Complete</div>
            <div class="sns-progress__count">${done}/${s.totalToProcess}</div>
          </div>
          <div class="sns-progress__title">Finished — ${s.cancelled} cancelled${s.failed ? `, ${s.failed} failed` : ''}.</div>
          <div class="sns-progress__bar"><div class="sns-progress__bar-fill" style="width:100%"></div></div>
          <div class="sns-progress__chips">
            ${s.cancelled ? `<span class="sns-chip sns-chip--ok">✓ ${s.cancelled} cancelled</span>` : ''}
            ${s.failed ? `<span class="sns-chip sns-chip--fail">! ${s.failed} failed</span>` : ''}
            ${s.kept ? `<span class="sns-chip sns-chip--keep">★ ${s.kept} kept</span>` : ''}
          </div>
          <div class="sns-progress__summary">
            ${s.failed ? `<strong>${s.failed} item${s.failed === 1 ? '' : 's'}</strong> need attention. Your selections are saved — rescan to retry.` : `Everything processed successfully.`}
          </div>
          ${noticeHtml}
          <div class="sns-progress__controls">
            <button id="sns-dismiss">Dismiss</button>
            <button id="sns-rescan-after">Rescan</button>
          </div>`;
    }

    const paused = run.status === 'paused';
    const dotClass = paused ? 'sns-progress__dot sns-progress__dot--paused' : 'sns-progress__dot';
    const label = paused ? 'Paused' : 'Cancelling';
    const idxLabel = run.currentIndex >= 0
      ? `${Math.min(done + (s.inflight ? 1 : 0), s.totalToProcess)}/${s.totalToProcess}`
      : `${done}/${s.totalToProcess}`;
    const stalled = paused && run.pausedReason ? `<div class="sns-progress__summary">${escapeHtml(run.pausedReason)}</div>` : '';

    return `
        <div class="sns-progress__head">
          <div class="${dotClass}"></div>
          <div class="sns-progress__label">${label}</div>
          <div class="sns-progress__count">${idxLabel}</div>
        </div>
        <div class="sns-progress__title">${escapeHtml(current?.title || 'Preparing…')}</div>
        ${current?.error ? `<div class="sns-progress__summary">${escapeHtml(current.error)}</div>` : ''}
        ${stalled}
        ${noticeHtml}
        <div class="sns-progress__bar">
          <div class="sns-progress__bar-fill" style="width:${pct}%"></div>
        </div>
        <div class="sns-progress__chips">
          ${s.cancelled ? `<span class="sns-chip sns-chip--ok">✓ ${s.cancelled}</span>` : ''}
          ${s.failed ? `<span class="sns-chip sns-chip--fail">! ${s.failed}</span>` : ''}
          ${s.kept ? `<span class="sns-chip sns-chip--keep">★ ${s.kept}</span>` : ''}
        </div>
        <div class="sns-progress__controls">
          ${paused
            ? `<button id="sns-resume">Resume</button>`
            : `<button id="sns-pause">Pause</button>`
          }
          <button id="sns-skip"${paused ? ' disabled title="Resume to skip the current item"' : ''}>Skip current</button>
          <button id="sns-stop" class="sns-danger">Stop</button>
        </div>`;
  }

  function render(run) {
    if (!run || (run.status !== 'running' && run.status !== 'paused' && run.status !== 'done')) {
      // Nothing for us to render. Clear ONLY our own root — never touch content_manager's.
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
        if (confirm('Stop the cancellation run? Items already cancelled stay cancelled.')) send('sns:stop');
        break;
      case 'sns-dismiss': send('sns:reset'); break;
      case 'sns-rescan-after': location.href = 'https://www.amazon.com/auto-deliveries/subscriptionList'; break;
      default: break;
    }
  }

  async function refresh() {
    const run = await msg('sns:getState');
    latestRun = run;
    render(run);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.sns_run) return;
    scheduleRender(changes.sns_run.newValue);
  });

  // Initial render shortly after content loads (give Amazon a moment first)
  setTimeout(refresh, 400);
})();
