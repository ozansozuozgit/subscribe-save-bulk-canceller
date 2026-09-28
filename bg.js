import './state.js';
const { reconcile, remember, targetUrl } = globalThis.SNSState;
const SAVED_KEY = 'sns_saved';
const HISTORY_KEY = 'sns_history';

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
  const r = await chrome.storage.local.get([KEY, SAVED_KEY]);
  const run = r[KEY] || { ...EMPTY_RUN };
  if (!r[SAVED_KEY]) {
    // Preserve the original failed run before any migration or rescan.
    await chrome.storage.local.set({ [SAVED_KEY]: run.items || [], sns_legacy_backup: run });
  }
  return run;
}

async function setRun(run) {
  const stored = await chrome.storage.local.get(SAVED_KEY);
  await chrome.storage.local.set({ [KEY]: run, [SAVED_KEY]: remember(stored[SAVED_KEY] || [], run.items || []) });
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

async function navigateRun(run) {
  try {
    const url = urlForItem(run.items[run.currentIndex]);
    if (!url) throw new Error('The subscription identity could not be verified.');
    const tabId = await navigateTo(run.tabId, url);
    if (tabId !== run.tabId) await patchRun({ tabId });
    return { ok: true };
  } catch (error) {
    const message = `Could not open the subscription page. Your choices are saved; resume to try again. ${error?.message || error}`;
    const items = run.items.map((item, index) => index === run.currentIndex ? { ...item, error: message } : item);
    await setRun({ ...run, items, status: 'paused' });
    return { ok: false, error: message };
  }
}

// Validate the captured identity, then use the manager's native Edit and
// cancellation dialogs, including the visible confirmation.
function urlForItem(it) {
  return targetUrl(it);
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
  setTimeout(() => {
    messages = messages.then(async () => {
      const fresh = await getRun();
      if (fresh.status !== 'running' || fresh.currentIndex !== run.currentIndex || fresh.runId !== run.runId) return;
      if (fresh.items[nextIdx]?.status !== 'pending') return;
      const updated = { ...fresh, currentIndex: nextIdx };
      updated.items = fresh.items.map((it, i) =>
        i === nextIdx ? { ...it, status: 'inflight', attempts: (it.attempts || 0) + 1 } : it
      );
      await setRun(updated);
      await navigateRun(updated);
    }).catch(error => console.error('SNS BG: queue error', error));
  }, delay);
}

async function finishRun(run) {
  const summary = summarize(run.items);
  const finished = { ...run, status: 'done', finishedAt: Date.now() };
  await setRun(finished);
  await archiveRun(finished);
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

async function archiveRun(run) {
  if (!run.items?.length) return;
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const history = stored[HISTORY_KEY] || [];
  const id = run.runId || `legacy-${run.startedAt || 0}`;
  const without = history.filter(entry => entry.id !== id);
  await chrome.storage.local.set({ [HISTORY_KEY]: [...without, { id, savedAt: Date.now(), ...run }] });
}

function isCurrent(run, msg, sender, allowPaused = false) {
  const item = run.items?.[run.currentIndex];
  return (run.status === 'running' || (allowPaused && run.status === 'paused')) && item?.status === 'inflight' &&
    sender?.tab?.id === run.tabId && msg.itemId === item.id &&
    msg.runId === run.runId && msg.attempt === item.attempts;
}

// Serialize message writes so rapid toggles and late tab reports cannot race.
let messages = Promise.resolve();
// ---------- Message handlers ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  messages = messages.then(async () => {
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
        const cur = await getRun();
        if (cur.status === 'running' || cur.status === 'paused') {
          sendResponse({ ok: false, error: 'A cancellation run is already active.' });
          return;
        }
        await archiveRun(cur);
        const opts = await getOptions();
        const stored = await chrome.storage.local.get(SAVED_KEY);
        const items = reconcile(msg.items || [], stored[SAVED_KEY] || cur.items);
        const run = {
          ...EMPTY_RUN,
          status: 'reviewing',
          items,
          reason: cur.reason ?? opts.reason,
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
        if (['running', 'paused'].includes(cur.status)) { sendResponse({ ok: false }); return; }
        const keepSet = new Set(msg.keepIds || []);
        const items = cur.items.map((it) => ({ ...it, keep: it.status === 'done' || keepSet.has(it.id), needsReview: keepSet.has(it.id) && it.needsReview }));
        await setRun({ ...cur, items });
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'sns:startRun') {
        const cur = await getRun();
        if (['running', 'paused'].includes(cur.status)) { sendResponse({ ok: false, error: 'A run is already active.' }); return; }
        await archiveRun(cur);
        const opts = await getOptions();
        const items = cur.items.map((it) => {
          if (it.status === 'done') return it;
          if (it.keep) return it;
          // No edit link captured (common on the new subscriptionList layout) —
          // we cannot drive a cancel without it. Mark up front so the user sees it
          // in the Needs Attention list instead of silently navigating to "null".
          if (!urlForItem(it)) {
            return { ...it, status: 'failed', attempts: 0, error: 'No subscription ID detected — cancel manually from Amazon.' };
          }
          return { ...it, status: 'pending', phase: undefined, error: undefined };
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
              ? `No verified cancellation links were found. Your selections are saved; rescan the subscriptions page.`
              : 'Nothing to cancel.',
          });
          return;
        }
        const run = {
          ...cur,
          status: 'running',
          runId: crypto.randomUUID(),
          items,
          currentIndex: firstIdx,
          // Honor an explicitly-empty reason as "no preference — skip reason step"
          reason: Object.prototype.hasOwnProperty.call(msg, 'reason') ? (msg.reason || '') : (opts.reason || cur.reason || ''),
          jitterMs: opts.jitterMs,
          startedAt: Date.now(),
          finishedAt: 0,
          tabId: sender?.tab?.id || cur.tabId || null,
        };
        run.items[firstIdx] = { ...run.items[firstIdx], status: 'inflight', attempts: (run.items[firstIdx].attempts || 0) + 1 };
        await setRun(run);
        await archiveRun(run);
        const navigation = await navigateRun(run);
        sendResponse({ ...navigation, run: await getRun() });
        return;
      }

      if (msg?.type === 'sns:itemDone') {
        const cur = await getRun();
        if (!isCurrent(cur, msg, sender, true)) {
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
        if (!isCurrent(cur, msg, sender, true)) {
          sendResponse({ ok: false });
          return;
        }
        const idx = cur.currentIndex;
        const items = cur.items.map((it, i) =>
          i === idx ? { ...it, status: 'failed', finishedAt: Date.now(), error: msg.error || 'Unknown error' } : it
        );
        // Stop at the first unexpected Amazon response instead of repeating a
        // broken form flow across the rest of the user's queue.
        await setRun({ ...cur, items, status: 'paused' });
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'sns:authorizeStep') {
        const cur = await getRun();
        sendResponse({ ok: isCurrent(cur, msg, sender) });
        return;
      }

      if (msg?.type === 'sns:confirming') {
        const cur = await getRun();
        if (!isCurrent(cur, msg, sender)) { sendResponse({ ok: false }); return; }
        const items = cur.items.map((item, index) => index === cur.currentIndex ? { ...item, phase: 'confirming' } : item);
        await setRun({ ...cur, items });
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'sns:export') {
        await getRun();
        sendResponse(await chrome.storage.local.get([KEY, SAVED_KEY, HISTORY_KEY, 'sns_legacy_backup', 'sns_import_backup']));
        return;
      }

      if (msg?.type === 'sns:getSaved') {
        await getRun();
        const stored = await chrome.storage.local.get(SAVED_KEY);
        sendResponse(stored[SAVED_KEY] || []);
        return;
      }

      if (msg?.type === 'sns:import') {
        const cur = await getRun();
        if (['running', 'paused'].includes(cur.status)) throw new Error('Stop the active run before importing.');
        const data = msg.data;
        const source = data?.sns_saved || data?.sns_run?.items || data?.items;
        if (!Array.isArray(source) || source.length > 5000 || source.some(item =>
          !item || typeof item.id !== 'string' || typeof item.keep !== 'boolean' || typeof item.title !== 'string'
        )) throw new Error('Choose a valid saved choices export.');
        // Imports restore decisions, never start a cancellation run.
        const items = source.map(item => ({
          id: item.id, subscriptionId: item.subscriptionId || null,
          title: item.title, image: item.image || null, nextDate: item.nextDate || null,
          keep: item.keep, status: ['done', 'failed', 'skipped'].includes(item.status) ? item.status : 'pending',
          attempts: Number(item.attempts) || 0,
          finishedAt: Number(item.finishedAt) || undefined,
          verification: typeof item.verification === 'string' ? item.verification : undefined,
        }));
        await archiveRun(cur);
        const stored = await chrome.storage.local.get([SAVED_KEY, 'sns_import_backup']);
        // An older backup must never turn a confirmed cancellation into a retry.
        const confirmed = (stored[SAVED_KEY] || []).filter(item => item.status === 'done');
        const saved = remember(remember(stored[SAVED_KEY] || [], items), confirmed);
        await chrome.storage.local.set({
          [SAVED_KEY]: saved,
          sns_import_backup: stored.sns_import_backup || data,
        });
        // Keep the open review and saved ledger aligned, so reset/rescan cannot
        // overwrite the imported decisions with the previous review's choices.
        await setRun({ ...cur, status: 'reviewing', currentIndex: -1, items: reconcile(cur.items || [], saved) });
        sendResponse({ ok: true, count: items.length });
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
        const interrupted = cur.items[cur.currentIndex]?.status === 'inflight';
        const idx = interrupted ? cur.currentIndex : nextPendingIndex(cur.items, Math.max(0, cur.currentIndex));
        if (idx === -1) {
          await finishRun(cur);
          sendResponse({ ok: true });
          return;
        }
        const items = cur.items.map((it, i) =>
          i === idx ? { ...it, status: 'inflight', error: undefined, attempts: (it.attempts || 0) + 1 } : it
        );
        const run = { ...cur, status: 'running', items, currentIndex: idx };
        await setRun(run);
        sendResponse(await navigateRun(run));
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
        await finishRun(cur);
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'sns:reset') {
        const cur = await getRun();
        if (['running', 'paused'].includes(cur.status)) { sendResponse({ ok: false }); return; }
        await archiveRun(cur);
        await setRun({ ...cur, status: 'reviewing', currentIndex: -1 });
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: 'Unknown message' });
    } catch (err) {
      console.error('SNS BG: handler error', err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  });
  return true; // async
});

// On install: seed defaults
chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get([KEY, OPTS_KEY]);
  if (!cur[KEY]) await chrome.storage.local.set({ [KEY]: { ...EMPTY_RUN } });
  if (!cur[OPTS_KEY]) await chrome.storage.local.set({ [OPTS_KEY]: { ...DEFAULT_OPTIONS } });
});
