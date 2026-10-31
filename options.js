// Settings page — reads/writes the options object via bg.js.

const REASON_OPTIONS = [
  "I don't want this item anymore",
  'Price is too high',
  'Found a better alternative',
  "I'm not using this product",
  'Other',
];
// Shared with bg.js via state.js so "Restore defaults" matches a fresh install.
const { reason: DEFAULT_REASON, jitterMs: DEFAULT_JITTER } = globalThis.SNSState.DEFAULT_OPTIONS;
const DEFAULTS = { reason: DEFAULT_REASON, jitterMs: [...DEFAULT_JITTER] };

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

function populateReason(current) {
  const sel = document.getElementById('reason');
  sel.innerHTML = REASON_OPTIONS.map(
    (r) => `<option value="${r.replace(/"/g, '&quot;')}"${r === current ? ' selected' : ''}>${r}</option>`
  ).join('');
}

function flashSaved() {
  const el = document.getElementById('saved');
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1400);
}

async function load() {
  const opts = (await msg('sns:getOptions')) || DEFAULTS;
  populateReason(opts.reason);
  document.getElementById('jitter-min').value = opts.jitterMs[0];
  document.getElementById('jitter-max').value = opts.jitterMs[1];
}

async function save() {
  const reason = document.getElementById('reason').value;
  let min = parseInt(document.getElementById('jitter-min').value, 10);
  let max = parseInt(document.getElementById('jitter-max').value, 10);
  if (!Number.isFinite(min) || min < 500) min = 500;
  if (!Number.isFinite(max) || max < min) max = Math.max(min, 1500);
  document.getElementById('jitter-min').value = min;
  document.getElementById('jitter-max').value = max;
  await msg('sns:setOptions', { options: { reason, jitterMs: [min, max] } });
  flashSaved();
}

async function reset() {
  await msg('sns:setOptions', { options: { ...DEFAULTS } });
  await load();
  flashSaved();
}

document.getElementById('save').addEventListener('click', save);
document.getElementById('reset').addEventListener('click', reset);
load();
