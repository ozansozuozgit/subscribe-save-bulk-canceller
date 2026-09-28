// Toolbar popup logic — shows current run status, top-line stats, and any failed items.

const SUBS_URL = 'https://www.amazon.com/auto-deliveries/subscriptionList';

function msg(type, payload) {
  return new Promise((res) => chrome.runtime.sendMessage({ type, ...(payload || {}) }, res));
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

function render(run) {
  const status = run?.status || 'idle';
  const items = run?.items || [];
  const s = summarize(items);

  const statusLabels = {
    idle: 'Idle — open your subscriptions page to scan',
    reviewing: items.length
      ? `${items.length} subscription${items.length === 1 ? '' : 's'} ready to review`
      : 'No subscriptions detected',
    previewing: 'Reviewing items to cancel',
    running: `Cancelling — ${s.cancelled + s.failed + s.skipped}/${items.length - s.kept} done`,
    paused: `Paused — ${s.cancelled + s.failed + s.skipped}/${items.length - s.kept} done`,
    done: items.length
      ? `Last run: ${s.cancelled} cancelled${s.failed ? `, ${s.failed} failed` : ''}`
      : 'Idle',
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
  if (status === 'running' || status === 'paused') {
    openBtn.textContent = 'View live progress';
  } else if (status === 'reviewing' && items.length) {
    openBtn.textContent = 'Back to review panel';
  } else if (status === 'done') {
    openBtn.textContent = 'Open subscriptions page';
  } else {
    openBtn.textContent = 'Open subscriptions page';
  }

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
          <a class="fail-link" href="${escapeHtml(i.cancelUrl || i.editUrl || SUBS_URL)}" target="_blank" rel="noopener">Open</a>
        </div>`
      )
      .join('');
  } else {
    failSection.hidden = true;
  }
}

async function init() {
  const run = await msg('sns:getState');
  render(run);
  renderSaved(await msg('sns:getSaved'));

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
        ? `${result.count} saved choices restored. Rescan to apply them.` : result?.error || 'Restore failed.';
    } catch (_) { document.getElementById('import-result').textContent = 'Paste valid saved choices JSON.'; }
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
  setText('saved-status', `Saved history: ${confirmed} cancelled · ${pending} remaining to check or cancel.`);
}

init();
