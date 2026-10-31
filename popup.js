// Toolbar popup logic — shows current run status, top-line stats, and any failed items.

const SUBS_URL = 'https://www.amazon.com/auto-deliveries/subscriptionList';
let howTouched = false; // the user opened or closed "How it works" themselves

// Resolves undefined (never throws) if the background can't be reached.
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

function summarize(items) {
  let cancelled = 0, failed = 0, kept = 0, skipped = 0, pending = 0;
  for (const it of items) {
    if (it.keep) { kept++; continue; }
    if (it.status === 'done') cancelled++;
    else if (it.status === 'failed') failed++;
    else if (it.status === 'skipped') skipped++;
    else pending++;
  }
  return { cancelled, failed, kept, skipped, pending, total: items.length };
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Only link to Amazon pages; anything else falls back to the subscriptions list.
function safeAmazonUrl(url) {
  try {
    const u = new URL(url);
    return u.origin === 'https://www.amazon.com' ? u.href : SUBS_URL;
  } catch (_) { return SUBS_URL; }
}

function render(run) {
  const status = run?.status || 'idle';
  const items = run?.items || [];
  const s = summarize(items);

  const toProcess = items.length - s.kept;
  const finished = s.cancelled + s.failed + s.skipped;
  const statusLabels = {
    idle: 'Open your Subscribe & Save page to get started.',
    reviewing: items.length
      ? `${items.length} subscription${items.length === 1 ? '' : 's'} ready to review`
      : 'No subscriptions found yet. Open your Subscribe & Save page.',
    previewing: 'Reviewing items to cancel',
    running: `Cancelling ${Math.min(finished + 1, toProcess)} of ${toProcess}…`,
    paused: `Paused after ${finished} of ${toProcess}. Resume from the page.`,
    done: items.length
      ? `Last run: ${s.cancelled} cancelled${s.kept ? `, ${s.kept} kept` : ''}${s.failed ? `, ${s.failed} failed` : ''}`
      : 'Open your Subscribe & Save page to get started.',
  };

  document.getElementById('status-dot').className = `status-dot ${status}`;
  setText('status-text', statusLabels[status] || status);

  // Stats visible whenever we have items.
  // "To cancel" = items selected to cancel right now (not kept, not already done).
  const stats = document.getElementById('stats');
  if (items.length) {
    stats.hidden = false;
    const toCancel = items.filter((i) => !i.keep && i.status !== 'done' && i.status !== 'failed' && i.status !== 'skipped').length;
    setText('stat-active', toCancel);
    setText('stat-cancelled', s.cancelled);
    setText('stat-failed', s.failed);
  } else {
    stats.hidden = true;
  }

  // Open button morphs by context
  const openBtn = document.getElementById('btn-open');
  if (status === 'running' || status === 'paused') openBtn.textContent = 'Show progress';
  else if (status === 'reviewing' && items.length) openBtn.textContent = 'Back to my list';
  else openBtn.textContent = 'Open my Subscribe & Save page';

  // "How it works" starts open until the user has a list to work with.
  const how = document.getElementById('how');
  if (how && !howTouched) how.open = !(items.length && status !== 'idle');

  // Rescan button only after a run
  const rescanBtn = document.getElementById('btn-rescan');
  rescanBtn.hidden = !(status === 'done' || status === 'reviewing');

  // Failures
  const failed = items.filter((i) => i.status === 'failed');
  const failSection = document.getElementById('fail-section');
  if (failed.length) {
    failSection.hidden = false;
    setText('fail-count', failed.length);
    const list = document.getElementById('failures');
    list.innerHTML = failed
      .map(
        (i) => `
        <div class="fail-row">
          <span class="fail-icon">!</span>
          <span class="fail-title" title="${escapeHtml(i.error || '')}">${escapeHtml(i.title || 'Untitled')}</span>
          <a class="fail-link" href="${escapeHtml(safeAmazonUrl(i.cancelUrl || i.editUrl))}" target="_blank" rel="noopener" aria-label="Open ${escapeHtml(i.title || 'subscription')} on Amazon">Open</a>
        </div>`
      )
      .join('');
  } else {
    failSection.hidden = true;
  }
}

// Reads run state and saved choices together, then renders once, so the
// popup doesn't grow in two steps while it opens.
async function loadState() {
  document.body.setAttribute('aria-busy', 'true');
  document.getElementById('status-dot').className = 'status-dot loading';
  setText('status-text', 'Reading saved choices…');
  document.getElementById('btn-retry').hidden = true;
  const [run, saved] = await Promise.all([msg('sns:getState'), msg('sns:getSaved')]);
  document.body.setAttribute('aria-busy', 'false');
  if (!run) {
    document.getElementById('status-dot').className = 'status-dot error';
    setText('status-text', "Couldn't read the extension's saved state.");
    document.getElementById('btn-retry').hidden = false;
    return;
  }
  render(run);
  renderSaved(saved);
}

async function init() {
  document.getElementById('btn-retry').addEventListener('click', loadState);
  document.querySelector('#how summary')?.addEventListener('click', () => { howTouched = true; });
  await loadState();

  document.getElementById('btn-open').addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ url: 'https://www.amazon.com/*', currentWindow: true });
    const target = SUBS_URL;
    if (tabs.length) {
      await chrome.tabs.update(tabs[0].id, { url: target, active: true });
    } else {
      await chrome.tabs.create({ url: target });
    }
    window.close();
  });

  document.getElementById('btn-rescan').addEventListener('click', async () => {
    await msg('sns:reset');
    // Reuse the current Amazon tab if there is one; otherwise open a new one.
    const tabs = await chrome.tabs.query({ url: 'https://www.amazon.com/*', currentWindow: true });
    if (tabs.length) {
      await chrome.tabs.update(tabs[0].id, { url: SUBS_URL, active: true });
    } else {
      await chrome.tabs.create({ url: SUBS_URL });
    }
    window.close();
  });

  document.getElementById('btn-import').addEventListener('click', async () => {
    try {
      const data = JSON.parse(document.getElementById('import-data').value);
      const result = await msg('sns:import', { data });
      document.getElementById('import-result').textContent = result?.ok
        ? `${result.count} choices restored. Rescan the page to see them.` : result?.error || 'Restore failed.';
    } catch (_) { document.getElementById('import-result').textContent = 'That doesn’t look like a backup file. Paste the whole file.'; }
  });

  document.getElementById('btn-export').addEventListener('click', async () => {
    const data = await msg('sns:export');
    const url = URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...data }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `subscribe-save-history-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  document.getElementById('options-link').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.sns_run) render(changes.sns_run.newValue);
  if (area === 'local' && changes.sns_saved) renderSaved(changes.sns_saved.newValue);
});

function renderSaved(items) {
  const identified = (Array.isArray(items) ? items : []).filter(item => item.subscriptionId);
  const confirmed = identified.filter(item => item.status === 'done').length;
  const pending = identified.filter(item => !item.keep && item.status !== 'done').length;
  setText('saved-status', identified.length ? `Saved in this browser: ${confirmed} cancelled so far, ${pending} still selected to cancel.` : '');
}

init();
