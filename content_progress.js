// Renders the persistent floating progress panel while a run is active.
// Lives on every amazon.com page so it survives the tab navigations.
// State source: chrome.storage.local 'sns_run' (mirrors bg.js).

(function () {
  if (window.__SNS_PROGRESS_BOOTED__) return;
  window.__SNS_PROGRESS_BOOTED__ = true;

  // Use a SEPARATE root from content_manager so we never stomp on each other's UI.
  // (Both scripts run on manager pages because the manifest patterns overlap.)
  const ROOT_ID = 'sns-progress-root';
  const OWNED_ATTR = 'data-sns-progress-owned';

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

  function clearOwnRoot() {
    const root = document.getElementById(ROOT_ID);
    if (root) root.innerHTML = '';
  }

  function msg(type, payload) {
    return new Promise((res) => chrome.runtime.sendMessage({ type, ...(payload || {}) }, res));
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

  function render(run) {
    if (!run || (run.status !== 'running' && run.status !== 'paused' && run.status !== 'done')) {
      // Nothing for us to render. Clear ONLY our own root — never touch content_manager's.
      clearOwnRoot();
      return;
    }
    const root = ensureRoot();

    const s = summarize(run.items || []);
    const done = s.cancelled + s.failed + s.skipped;
    const pct = s.totalToProcess > 0 ? Math.min(100, Math.round((done / s.totalToProcess) * 100)) : 0;
    const current = run.items?.[run.currentIndex];

    if (run.status === 'done') {
      root.innerHTML = `
        <div class="sns-progress" role="status" aria-live="polite">
          <div class="sns-progress__head">
            <div class="sns-progress__dot sns-progress__dot--done"></div>
            <div class="sns-progress__label">Complete</div>
            <div class="sns-progress__count">${done}/${s.totalToProcess}</div>
          </div>
          <div class="sns-progress__title">All done — ${s.cancelled} cancelled${s.failed ? `, ${s.failed} failed` : ''}.</div>
          <div class="sns-progress__bar"><div class="sns-progress__bar-fill" style="width:100%"></div></div>
          <div class="sns-progress__chips">
            ${s.cancelled ? `<span class="sns-chip sns-chip--ok">✓ ${s.cancelled} cancelled</span>` : ''}
            ${s.failed ? `<span class="sns-chip sns-chip--fail">! ${s.failed} failed</span>` : ''}
            ${s.kept ? `<span class="sns-chip sns-chip--keep">★ ${s.kept} kept</span>` : ''}
          </div>
          <div class="sns-progress__summary">
            ${s.failed ? `<strong>${s.failed} item${s.failed === 1 ? '' : 's'}</strong> need manual attention — open the popup to see them.` : `Everything processed successfully.`}
          </div>
          <div class="sns-progress__controls">
            <button id="sns-dismiss">Dismiss</button>
            <button id="sns-rescan-after">Rescan</button>
          </div>
        </div>
      `;
      document.getElementById('sns-dismiss').addEventListener('click', async () => {
        await msg('sns:reset');
      });
      document.getElementById('sns-rescan-after').addEventListener('click', () => {
        location.href = 'https://www.amazon.com/auto-deliveries/subscriptionList';
      });
      return;
    }

    const paused = run.status === 'paused';
    const dotClass = paused ? 'sns-progress__dot sns-progress__dot--paused' : 'sns-progress__dot';
    const label = paused ? 'Paused' : 'Cancelling';
    const idxLabel = run.currentIndex >= 0
      ? `${Math.min(done + (s.inflight ? 1 : 0), s.totalToProcess)}/${s.totalToProcess}`
      : `${done}/${s.totalToProcess}`;

    root.innerHTML = `
      <div class="sns-progress" role="status" aria-live="polite">
        <div class="sns-progress__head">
          <div class="${dotClass}"></div>
          <div class="sns-progress__label">${label}</div>
          <div class="sns-progress__count">${idxLabel}</div>
        </div>
        <div class="sns-progress__title">${escapeHtml(current?.title || 'Preparing…')}</div>
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
          <button id="sns-skip">Skip current</button>
          <button id="sns-stop" class="sns-danger">Stop</button>
        </div>
      </div>
    `;

    const pauseBtn = document.getElementById('sns-pause');
    if (pauseBtn) pauseBtn.addEventListener('click', () => msg('sns:pause'));
    const resumeBtn = document.getElementById('sns-resume');
    if (resumeBtn) resumeBtn.addEventListener('click', () => msg('sns:resume'));
    document.getElementById('sns-skip').addEventListener('click', () => msg('sns:skipCurrent'));
    document.getElementById('sns-stop').addEventListener('click', () => {
      if (confirm('Stop the cancellation run? Items already cancelled stay cancelled.')) {
        msg('sns:stop');
      }
    });
  }

  async function refresh() {
    const run = await msg('sns:getState');
    render(run);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.sns_run) return;
    render(changes.sns_run.newValue);
  });

  // Initial render shortly after content loads (give Amazon a moment first)
  setTimeout(refresh, 400);
})();
