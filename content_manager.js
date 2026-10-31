// Runs on Amazon's Subscribe & Save manager pages.
// Scans the page, shows a small launcher (bottom-right) that opens the review
// panel, and on confirm kicks off the run via the background worker.

(function () {
  if (!window.SNSSelectors.MANAGER_URL_RE.test(location.href)) return;
  if (window.__SNS_MANAGER_BOOTED__) return;
  window.__SNS_MANAGER_BOOTED__ = true;

  const { sleep, realClick, NORM } = window.SNSUtils;
  const { REASON_OPTIONS } = window.SNSSelectors;
  const { scan } = window.SNSScan;

  // ---------- Local state ----------
  let state = {
    items: [],           // [{id, title, image, nextDate, editUrl, keep, status}]
    howOpen: false,      // "How it works" reopened from the "?" button
    sortBy: 'nextDate',  // default | nextDate | title
    filterBy: 'all',     // all | cancel | keep
    query: '',
    scanning: false,
    scanNote: '',
    error: null,         // message shown in the error state (scan failed / extension unreachable)
    runStatus: 'idle',   // mirrors bg.js run.status to know when to hide
  };

  // ---------- Helpers ----------
  // Never throws: after the extension is reloaded or updated, this page's
  // content script is orphaned and sendMessage throws "Extension context
  // invalidated". Callers treat `undefined` as "couldn't reach the extension".
  function msg(type, payload) {
    return new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ type, ...(payload || {}) }, (reply) => {
          void chrome.runtime.lastError; // read it so Chrome doesn't log "Unchecked runtime.lastError"
          res(reply);
        });
      } catch (_) {
        res(undefined);
      }
    });
  }

  function extensionReloaded() {
    try { return !chrome.runtime?.id; } catch (_) { return true; }
  }

  function unreachableMessage() {
    return extensionReloaded()
      ? 'The extension was updated or reloaded. Reload this page to continue.'
      : 'Could not reach the extension. Try again.';
  }

  function counts() {
    const total = state.items.length;
    const kept = state.items.filter((i) => i.keep).length;
    const cancel = total - kept;
    return { total, kept, cancel };
  }

  function sortItems(items) {
    const copy = items.slice();
    if (state.sortBy === 'title') {
      copy.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    } else if (state.sortBy === 'nextDate') {
      copy.sort((a, b) => {
        const da = a.nextTs || parseDeliveryDate(a.nextDate) || Infinity;
        const db = b.nextTs || parseDeliveryDate(b.nextDate) || Infinity;
        return da - db;
      });
    }
    return copy;
  }

  function filteredItems() {
    const query = NORM(state.query);
    return state.items.filter((item) => {
      if (state.filterBy === 'cancel' && item.keep) return false;
      if (state.filterBy === 'keep' && !item.keep) return false;
      if (!query) return true;
      return NORM(`${item.title || ''} ${item.nextDate || ''}`).includes(query);
    });
  }

  function parseDeliveryDate(raw) {
    if (!raw) return null;
    const cleaned = String(raw)
      .replace(/next\s+(delivery|order)\s*(by|on)?/ig, '')
      .replace(/arriving|delivery date|by/ig, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return null;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (/today/i.test(cleaned)) return today;
    if (/tomorrow/i.test(cleaned)) return today + 86400000;

    const monthDate = cleaned.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:,\s*(\d{4}))?/i);
    if (monthDate) {
      const year = Number(monthDate[3] || now.getFullYear());
      let ts = Date.parse(`${monthDate[1]} ${monthDate[2]}, ${year}`);
      if (Number.isFinite(ts) && !monthDate[3] && ts < today - 2592000000) {
        ts = Date.parse(`${monthDate[1]} ${monthDate[2]}, ${year + 1}`);
      }
      return Number.isFinite(ts) ? ts : null;
    }
    const parsed = Date.parse(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function enrichItems(items) {
    const enriched = items.map((item) => ({
      ...item,
      nextTs: parseDeliveryDate(item.nextDate),
      shippingSoon: false,
      shippingSoonest: false,
    }));
    const dated = enriched.filter((item) => item.nextTs).sort((a, b) => a.nextTs - b.nextTs);
    const soonestTs = dated[0]?.nextTs || null;
    return enriched.map((item) => ({
      ...item,
      shippingSoonest: !!soonestTs && item.nextTs === soonestTs,
      shippingSoon: !!soonestTs && item.nextTs === soonestTs,
    }));
  }


  // ---------- UI preferences (remembered in chrome.storage.local) ----------
  // v2.1.2: the panel starts as a small launcher. Whether it is open, and
  // whether the "How it works" explainer has been seen, is remembered.
  const UI_KEY = 'sns_ui';
  const ui = { panelOpen: false, howSeen: false };

  async function loadUi() {
    try {
      const stored = await chrome.storage.local.get(UI_KEY);
      Object.assign(ui, stored?.[UI_KEY] || {});
    } catch (_) { /* storage unavailable: keep the defaults */ }
  }

  function saveUi(patch) {
    Object.assign(ui, patch);
    try {
      const p = chrome.storage.local.set({ [UI_KEY]: { ...ui } });
      if (p && p.catch) p.catch(() => {});
    } catch (_) {}
  }

  // A run (and its finish summary) owns the screen: the progress card is shown
  // and the review panel steps aside, so the two never overlap.
  const RUN_OWNS_SCREEN = ['running', 'paused', 'done'];

  // ---------- DOM ----------
  // Everything is drawn inside the shadow root of the #sns-root host
  // (ui/host.js), so Amazon's CSS can't restyle it. Look elements up with
  // byId() / shadow.querySelector(), never document.*.
  const ROOT_ID = 'sns-root';
  let shadow = null;
  let appRoot = null;

  function byId(id) {
    return shadow ? shadow.getElementById(id) : null;
  }

  function ensureRoot() {
    if (!appRoot || !appRoot.isConnected) {
      shadow = window.SNSHost.attach(ROOT_ID, 2147483646);
      appRoot = shadow.querySelector('.sns-app');
      if (!appRoot) {
        appRoot = document.createElement('div');
        appRoot.className = 'sns-ui sns-app';
        shadow.appendChild(appRoot);
      }
      mountedMode = null; // a new (or re-attached) host must be mounted again
    }
    return appRoot;
  }

  function svg(name) {
    const ICONS = {
      close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>',
      box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9 4-9-4 9-4 9 4z"/><path d="M3 8v9l9 4 9-4V8"/></svg>',
      list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 5.5 8.5 8 6"/><line x1="11" y1="7" x2="20" y2="7"/><polyline points="4 13 5.5 14.5 8 12"/><line x1="11" y1="13" x2="20" y2="13"/><line x1="4" y1="19" x2="8" y2="19"/><line x1="11" y1="19" x2="20" y2="19"/></svg>',
      up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 15 12 9 18 15"/></svg>',
    };
    return ICONS[name] || '';
  }

  function renderEmpty() {
    return `
      <div class="sns-empty">
        <div class="sns-empty__icon">${svg('box')}</div>
        <div class="sns-empty__title">No subscriptions found</div>
        <div class="sns-empty__msg">This page shows no active Subscribe &amp; Save items. If that looks wrong, reload the page or scan again.</div>
        <button class="sns-btn sns-btn--ghost sns-empty__action" id="sns-retry">Scan again</button>
      </div>`;
  }

  function renderError() {
    return `
      <div class="sns-empty sns-empty--error" role="alert">
        <div class="sns-empty__icon">${svg('close')}</div>
        <div class="sns-empty__title">Couldn&rsquo;t load your subscriptions</div>
        <div class="sns-empty__msg" id="sns-error-msg"></div>
        <button class="sns-btn sns-btn--ghost sns-empty__action" id="sns-retry">Try again</button>
      </div>`;
  }

  // Placeholder rows with the same height as real rows, so the card doesn't
  // jump when the list arrives.
  function renderSkeleton() {
    const row = `
      <div class="sns-skeleton__row">
        <div class="sns-skeleton__thumb"></div>
        <div class="sns-skeleton__lines"><div></div><div></div></div>
      </div>`;
    return `<div class="sns-skeleton" aria-hidden="true">${row.repeat(5)}</div>`;
  }

  function renderHow() {
    return `
      <div class="sns-how" id="sns-how" hidden>
        <div class="sns-how__title">How it works</div>
        <ol class="sns-how__steps">
          <li><strong>Pick what to keep.</strong> Everything starts as <em>Keep</em>. Click an item to switch it to <em>Cancel</em>.</li>
          <li><strong>Review and confirm.</strong> You see exactly what will be cancelled before anything happens.</li>
          <li><strong>It cancels the rest, one at a time.</strong> At a human pace, using Amazon&rsquo;s own Cancel button. You can pause anytime.</li>
        </ol>
        <button class="sns-btn sns-btn--ghost sns-btn--sm" id="sns-how-done" type="button">Got it</button>
      </div>`;
  }

  function renderItemRow(item) {
    const warning = item.needsReview ? '<span class="sns-warn">Check this one: it matches another subscription</span>' : '';
    const meta = item.nextDate ? `<span>Next delivery: ${escapeHtml(item.nextDate)}</span>` : '<span>Active subscription</span>';
    const img = item.image
      ? `<img src="${escapeAttr(item.image)}" alt="" loading="lazy"/>`
      : `<div class="sns-item__thumb--placeholder">${svg('box')}</div>`;
    // The visible chip ("Keep" / "Cancel") is part of the row's accessible name;
    // aria-pressed="true" means "marked to cancel".
    return `
      <div class="sns-item" data-id="${escapeAttr(item.id)}" role="button" tabindex="0" aria-pressed="false">
        <div class="sns-item__thumb">${img}</div>
        <div class="sns-item__body">
          <div class="sns-item__title">${escapeHtml(item.title || 'Untitled')}</div>
          <div class="sns-item__meta">${meta}${warning}</div>
        </div>
        <span class="sns-choice"><span class="sns-choice__keep">Keep</span><span class="sns-choice__cancel">Cancel</span></span>
      </div>`;
  }

  // ---------- Rendering ----------
  // The panel is mounted once per "mode" and patched in place afterwards, so
  // the card's entrance animation and thumbnails are never replayed.
  let mountedMode = null;

  function panelMode() {
    if (RUN_OWNS_SCREEN.includes(state.runStatus)) return 'hidden';
    if (!ui.panelOpen) return 'launcher';
    if (state.items.length) return 'list';
    if (state.scanning) return 'loading';
    if (state.error) return 'error';
    return 'empty';
  }

  function ensureCard(root) {
    let card = root.firstElementChild;
    if (!card || !card.classList.contains('sns-card')) {
      root.innerHTML = '<section class="sns-card" id="sns-panel" role="region" aria-labelledby="sns-panel-title"></section>';
      card = root.firstElementChild;
    }
    return card;
  }

  function mount(root, mode) {
    rowCache.clear();
    if (mode === 'hidden') { closeModal?.({ restoreFocus: false }); root.replaceChildren(); return; }
    if (mode === 'launcher') {
      root.innerHTML = `
        <button type="button" class="sns-launcher" id="sns-launcher" aria-expanded="false" aria-controls="sns-panel">
          <span class="sns-launcher__icon" aria-hidden="true">${svg('list')}</span>
          <span class="sns-launcher__body">
            <span class="sns-launcher__name">Subscription Bulk Canceller</span>
            <span class="sns-launcher__text" id="sns-launcher-text"></span>
          </span>
          <span class="sns-launcher__chev" aria-hidden="true">${svg('up')}</span>
        </button>`;
      byId('sns-launcher').addEventListener('click', () => setOpen(true));
      return;
    }
    const card = ensureCard(root);
    const note = '<div class="sns-scan-note" id="sns-scan-note" role="status" aria-live="polite" hidden><span class="sns-spinner" aria-hidden="true"></span><span id="sns-scan-note-text"></span></div>';
    const top = `${renderHeader(mode)}${renderHow()}${note}`;
    if (mode === 'loading') {
      card.innerHTML = `${top}${renderSkeleton()}`;
    } else if (mode === 'empty') {
      card.innerHTML = `${top}${renderEmpty()}`;
    } else if (mode === 'error') {
      card.innerHTML = `${top}${renderError()}`;
    } else {
      card.innerHTML = `
        ${top}
        <div class="sns-card__controls">
          <div class="sns-seg" role="group" aria-label="Show">
            ${renderFilterButton('all')}
            ${renderFilterButton('cancel')}
            ${renderFilterButton('keep')}
          </div>
          <div class="sns-card__row">
            <input id="sns-search" type="search" value="${escapeAttr(state.query)}" placeholder="Find a product" aria-label="Find a product">
            <button type="button" class="sns-chipbtn" id="sns-select-all">Cancel all</button>
            <button type="button" class="sns-chipbtn" id="sns-keep-all">Keep all</button>
          </div>
        </div>
        <div class="sns-card__list" id="sns-list" aria-label="Your subscriptions"></div>
        <div class="sns-card__footer">
          <button type="button" class="sns-btn sns-btn--ghost" id="sns-rescan">Rescan</button>
          <button type="button" class="sns-btn sns-btn--primary" id="sns-preview" disabled></button>
        </div>`;
      bindToolbar();
      bindList();
      byId('sns-rescan').addEventListener('click', doScan);
      byId('sns-preview').addEventListener('click', openPreview);
    }
    bindHeader();
    byId('sns-retry')?.addEventListener('click', doScan);
  }

  function setOpen(open) {
    saveUi({ panelOpen: open });
    renderPanel();
    const target = open ? byId('sns-panel-title') : byId('sns-launcher');
    try { target?.focus({ preventScroll: true }); } catch (_) { target?.focus(); }
  }

  function updateLauncher() {
    const text = byId('sns-launcher-text');
    if (!text) return;
    const n = state.items.length;
    let label;
    if (state.scanning && !n) label = 'Finding your subscriptions…';
    else if (n) label = `${n} subscription${n === 1 ? '' : 's'} · Review`;
    else if (state.error) label = 'Couldn’t load · Open to retry';
    else label = 'No subscriptions found';
    if (text.textContent !== label) text.textContent = label;
  }

  // Idempotent: safe to call on every state change.
  function renderPanel() {
    const root = ensureRoot();
    const mode = panelMode();
    if (mode !== mountedMode) {
      mount(root, mode);
      mountedMode = mode;
    }
    if (mode === 'hidden') return;
    if (mode === 'launcher') { updateLauncher(); return; }
    const card = root.firstElementChild;
    card.setAttribute('aria-busy', String(!!state.scanning));
    if (mode !== 'list') {
      const subtitle = card.querySelector('.sns-card__subtitle');
      if (subtitle) subtitle.textContent = subtitleText();
    }
    const showHow = !ui.howSeen || !!state.howOpen;
    const how = byId('sns-how');
    if (how) how.hidden = !showHow;
    byId('sns-help')?.setAttribute('aria-expanded', String(showHow));
    const noteEl = byId('sns-scan-note');
    if (noteEl) {
      // In list mode a failed rescan is reported in the same strip, above the
      // previous (still valid) list.
      const showError = !state.scanning && !!state.error && mode === 'list';
      noteEl.hidden = !state.scanning && !showError;
      noteEl.classList.toggle('sns-scan-note--error', showError);
      byId('sns-scan-note-text').textContent = showError
        ? state.error
        : state.scanNote || 'Loading your subscriptions…';
    }
    const rescan = byId('sns-rescan');
    if (rescan) {
      rescan.disabled = !!state.scanning;
      rescan.textContent = state.scanning ? 'Scanning…' : 'Rescan';
    }
    if (mode === 'error') byId('sns-error-msg').textContent = state.error || '';
    if (mode === 'list') {
      renderList(true);
      updateCounts();
    }
  }

  // Keyed list rendering: each row element is built once per item and reused,
  // so thumbnails never reload when the list is filtered, sorted, or updated.
  // Keep/cancel state is applied to the reused row in place.
  const rowCache = new Map(); // id -> { sig, el }
  let emptyFilterEl = null;

  function applyChoice(el, item) {
    el.classList.toggle('sns-item--kept', !!item.keep);
    el.setAttribute('aria-pressed', String(!item.keep));
  }

  function rowFor(item) {
    const sig = JSON.stringify([item.title, item.image, item.nextDate, item.needsReview]);
    let hit = rowCache.get(item.id);
    if (!hit || hit.sig !== sig) {
      const t = document.createElement('template');
      t.innerHTML = renderItemRow(item).trim();
      hit = { sig, el: t.content.firstElementChild };
      rowCache.set(item.id, hit);
    }
    applyChoice(hit.el, item);
    return hit.el;
  }

  function renderList(preserveScroll = true) {
    const list = byId('sns-list');
    if (!list) return;
    const visibleItems = sortItems(filteredItems());
    let next;
    if (visibleItems.length) {
      next = visibleItems.map(rowFor);
    } else {
      if (!emptyFilterEl) {
        emptyFilterEl = document.createElement('div');
        emptyFilterEl.className = 'sns-list-empty';
      }
      emptyFilterEl.textContent = state.query ? 'No products match your search.' : 'Nothing here yet.';
      next = [emptyFilterEl];
    }
    const current = [...list.children];
    if (current.length !== next.length || current.some((el, i) => el !== next[i])) {
      const prevScroll = list.scrollTop;
      list.replaceChildren(...next);
      list.scrollTop = preserveScroll ? prevScroll : 0;
    } else if (!preserveScroll) {
      list.scrollTop = 0;
    }
    const ids = new Set(state.items.map((i) => i.id));
    for (const id of rowCache.keys()) if (!ids.has(id)) rowCache.delete(id);
  }

  function filterLabel(name) {
    const c = counts();
    return { all: `All ${c.total}`, cancel: `To cancel ${c.cancel}`, keep: `To keep ${c.kept}` }[name] || name;
  }

  // Refreshes every count-derived bit of the shell in place.
  function updateCounts() {
    const c = counts();
    const set = (id, value) => {
      const el = byId(id);
      if (el && el.textContent !== String(value)) el.textContent = String(value);
    };
    set('sns-stat-total', c.total);
    set('sns-stat-total-label', c.total === 1 ? 'subscription' : 'subscriptions');
    set('sns-stat-cancel', c.cancel);
    set('sns-stat-keep', c.kept);
    shadow.querySelectorAll('.sns-filter').forEach((btn) => {
      const label = filterLabel(btn.getAttribute('data-filter'));
      if (btn.textContent !== label) btn.textContent = label;
    });
    const preview = byId('sns-preview');
    if (preview) {
      preview.disabled = !c.cancel;
      preview.textContent = c.cancel ? `Review & cancel ${c.cancel}` : 'Choose items to cancel';
    }
  }

  function renderFilterButton(name) {
    const active = state.filterBy === name;
    return `<button type="button" class="sns-filter${active ? ' sns-filter--active' : ''}" data-filter="${name}" aria-pressed="${active}">${escapeHtml(filterLabel(name))}</button>`;
  }

  function subtitleText() {
    if (state.scanning && state.items.length === 0) return 'Reading your subscriptions page…';
    if (state.error) return 'Something went wrong.';
    return 'No active subscriptions on this page.';
  }

  function renderHeader(mode) {
    const subtitle = mode === 'list'
      ? `<span id="sns-stat-total"></span> <span id="sns-stat-total-label">subscriptions</span> · <strong class="sns-num--cancel" id="sns-stat-cancel"></strong> to cancel · <strong class="sns-num--keep" id="sns-stat-keep"></strong> to keep`
      : escapeHtml(subtitleText());
    return `
      <div class="sns-card__header">
        <div class="sns-card__heading">
          <h2 class="sns-card__title" id="sns-panel-title" tabindex="-1">Subscription Bulk Canceller</h2>
          <div class="sns-card__subtitle">${subtitle}</div>
        </div>
        <button type="button" class="sns-iconbtn" id="sns-help" title="How it works" aria-label="How it works" aria-controls="sns-how" aria-expanded="false">?</button>
        <button type="button" class="sns-iconbtn" id="sns-minimize" title="Close panel" aria-label="Close panel">${svg('close')}</button>
      </div>`;
  }

  function bindHeader() {
    byId('sns-minimize')?.addEventListener('click', () => setOpen(false));
    byId('sns-help')?.addEventListener('click', () => {
      const showing = !ui.howSeen || state.howOpen;
      if (showing) { saveUi({ howSeen: true }); state.howOpen = false; } else state.howOpen = true;
      renderPanel();
    });
    byId('sns-how-done')?.addEventListener('click', () => {
      saveUi({ howSeen: true });
      state.howOpen = false;
      renderPanel();
      byId('sns-help')?.focus();
    });
  }

  function bindToolbar() {
    const setAll = (keep) => {
      state.items = state.items.map((i) => ({ ...i, keep }));
      pushKeepToBg();
      renderList(true);
      updateCounts();
    };
    byId('sns-select-all').addEventListener('click', () => setAll(false));
    byId('sns-keep-all').addEventListener('click', () => setAll(true));
    shadow.querySelectorAll('.sns-filter').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.filterBy = btn.getAttribute('data-filter') || 'all';
        shadow.querySelectorAll('.sns-filter').forEach((b) => {
          b.classList.toggle('sns-filter--active', b === btn);
          b.setAttribute('aria-pressed', String(b === btn));
        });
        renderList(false);
      });
    });
    const search = byId('sns-search');
    search.addEventListener('input', () => {
      state.query = search.value;
      renderList(false);
    });
  }

  function bindList() {
    const list = byId('sns-list');
    if (!list) return;
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.sns-item');
      if (!row) return;
      toggleKeep(row.getAttribute('data-id'));
    });
    list.addEventListener('keydown', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      const row = e.target.closest('.sns-item');
      if (!row) return;
      e.preventDefault();
      toggleKeep(row.getAttribute('data-id'));
    });
  }

  function toggleKeep(id) {
    state.items = state.items.map((i) => (i.id === id ? { ...i, keep: !i.keep } : i));
    pushKeepToBg();
    const item = state.items.find((i) => i.id === id);
    const stillVisible = filteredItems().some((i) => i.id === id);
    const row = shadow.querySelector(`#sns-list .sns-item[data-id="${cssEscape(id)}"]`);
    if (row && item && stillVisible) {
      // Flip just this row: the list keeps its scroll position and focus.
      applyChoice(row, item);
    } else {
      // The active filter now hides (or reveals) this item, so rebuild the list.
      renderList(true);
    }
    updateCounts();
  }

  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
  }

  // Updates the scan-status strip without rebuilding the panel.
  // Updates the scan-status strip in place (no rebuild).
  function setScanNote(note) {
    state.scanNote = note;
    renderPanel();
  }

  // Keep/cancel choices are written to the background (and so to storage)
  // at most once per 150 ms burst of clicks. `flushKeep()` sends immediately;
  // it runs before a cancellation run starts and when the page is hidden.
  const KEEP_DEBOUNCE_MS = 150;
  let keepTimer = null;
  let keepInFlight = 0;

  function keepWritePending() {
    return keepTimer !== null || keepInFlight > 0;
  }

  async function flushKeep() {
    clearTimeout(keepTimer);
    keepTimer = null;
    const keepIds = state.items.filter((i) => i.keep).map((i) => i.id);
    keepInFlight++;
    try {
      await msg('sns:setKeep', { keepIds });
    } finally {
      keepInFlight--;
    }
  }

  function pushKeepToBg() {
    clearTimeout(keepTimer);
    keepTimer = setTimeout(flushKeep, KEEP_DEBOUNCE_MS);
  }

  window.addEventListener('pagehide', () => { if (keepTimer !== null) flushKeep(); });

  function mergeItems(...groups) {
    const byKey = new Map();
    for (const group of groups) {
      for (const item of group || []) {
        const key = item.subscriptionId || item.id || item.asin || `${item.title}|${item.nextDate}`;
        const prev = byKey.get(key);
        if (!prev) {
          byKey.set(key, item);
          continue;
        }
        byKey.set(key, {
          ...prev,
          ...item,
          title: prev.title && prev.title !== 'Untitled subscription' ? prev.title : item.title,
          image: prev.image || item.image,
          nextDate: prev.nextDate || item.nextDate,
          editUrl: prev.editUrl || item.editUrl,
          cancelUrl: prev.cancelUrl || item.cancelUrl,
          keep: prev.keep ?? item.keep,
        });
      }
    }
    return [...byKey.values()];
  }

  function findLoadMoreControl() {
    const labels = [
      'show more',
      'load more',
      'view more',
      'see more',
      'more subscriptions',
      'more deliveries',
    ];
    const candidates = [
      ...document.querySelectorAll(
        '.subscription-pagination-trigger, button, a, [role="button"], input[type="button"], input[type="submit"], .a-button, .a-button-inner, .a-button-text'
      ),
    ];
    for (const el of candidates) {
      if (el.closest('#sns-root,#sns-modal,#sns-progress-root') || !window.SNSUtils.visible(el)) continue;
      const txt = NORM(el.innerText || el.value || el.getAttribute('aria-label') || el.textContent);
      if (!txt || /disabled|unavailable/.test(txt)) continue;
      const ariaDisabled = el.getAttribute('aria-disabled') === 'true';
      const disabled = el.disabled || ariaDisabled || el.classList?.contains('a-disabled');
      if (disabled || !(labels.includes(txt) || /^(show|load|view|see) more (subscriptions|deliveries)(?: \(?\d+\)?)?$/.test(txt))) continue;
      if (el.classList?.contains('subscription-pagination-trigger')) return el;
      const shell = el.closest('.a-button');
      const native = el.closest('button, a, [role="button"], input[type="button"], input[type="submit"]');
      return shell?.querySelector('.a-button-input, button, a, input[type="button"], input[type="submit"], .a-button-text') || native || shell || el;
    }
    return null;
  }

  async function expandCurrentPage() {
    let best = scan();
    let lastCount = best.length;
    const originalScrollY = window.scrollY;
    for (let pass = 0; pass < 8; pass++) {
      const sentinel = document.querySelector('#endOfGridDesktop[data-next-url], #endOfGridMobile[data-next-url]');
      const more = findLoadMoreControl();
      if (!more && !sentinel?.getAttribute('data-next-url')) break;
      setScanNote(`Loading your subscriptions… (${lastCount || 0} found)`);
      if (sentinel?.getAttribute('data-next-url')) sentinel.scrollIntoView({ block: 'center' });
      else realClick(more);
      const deadline = Date.now() + 5000;
      let next = best;
      while (Date.now() < deadline) {
        await sleep(350);
        next = mergeItems(best, scan());
        if (next.length > lastCount) break;
      }
      best = next;
      if (best.length <= lastCount) break;
      lastCount = best.length;
    }
    window.scrollTo({ top: originalScrollY, behavior: 'instant' });
    return best;
  }

  function nextPageUrl(root = document, seen = new Set()) {
    const anchors = [...root.querySelectorAll('a[href]')];
    const hit = anchors.find((a) => {
      const txt = NORM(a.innerText || a.getAttribute('aria-label') || a.textContent);
      const rel = NORM(a.getAttribute('rel') || '');
      const disabled = a.getAttribute('aria-disabled') === 'true' || a.classList?.contains('a-disabled');
      if (disabled) return false;
      if (rel !== 'next' && !txt.includes('next')) return false;
      try {
        const url = new URL(a.getAttribute('href'), location.href);
        return url.origin === location.origin && /auto-deliveries|subscribe-and-save/.test(url.href) && !seen.has(url.href);
      } catch (_) {
        return false;
      }
    });
    if (!hit) return null;
    try { return new URL(hit.getAttribute('href'), location.href).href; } catch (_) { return null; }
  }

  async function scanAdditionalPages(seedItems) {
    const seenPages = new Set([location.href]);
    let url = nextPageUrl(document, seenPages);
    let items = seedItems;
    let pages = 0;
    while (url && pages < 8) {
      pages += 1;
      seenPages.add(url);
      setScanNote(`Loading your subscriptions… (page ${pages + 1}, ${items.length} found)`);
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) break;
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        items = mergeItems(items, scan(doc));
        url = nextPageUrl(doc, seenPages);
      } catch (err) {
        console.warn('SNS manager: additional page scan failed', err);
        break;
      }
    }
    return items;
  }

  // ---------- Preview modal ----------
  let closeModal = null; // closes the open confirm dialog, if any

  function seconds(ms) {
    const s = Math.round((Number(ms) || 0) / 100) / 10;
    return String(s).replace(/\.0$/, '');
  }

  function openPreview() {
    const c = counts();
    if (!c.cancel) return;
    const willCancel = state.items.filter((i) => !i.keep);
    const willKeep = state.items.filter((i) => i.keep);
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const title = c.kept
      ? `Cancel ${plural(c.cancel, 'subscription')}, keep ${c.kept}.`
      : `Cancel ${plural(c.cancel, 'subscription')}.`;
    const listItem = (i) => `
      <li class="sns-modal__list-item">
        ${i.image ? `<img src="${escapeAttr(i.image)}" alt=""/>` : '<span class="sns-modal__noimg"></span>'}
        <span class="sns-modal__list-item-title">${escapeHtml(i.title || 'Untitled')}</span>
      </li>`;
    closeModal?.({ restoreFocus: false });
    const opener = shadow.activeElement;
    const modalEl = document.createElement('div');
    modalEl.className = 'sns-ui sns-modal-root';
    modalEl.id = 'sns-modal';
    modalEl.innerHTML = `
      <div class="sns-modal-backdrop"></div>
      <div class="sns-modal" role="dialog" aria-modal="true" aria-labelledby="sns-modal-title" aria-describedby="sns-modal-lede" tabindex="-1">
        <div class="sns-modal__header">
          <h2 class="sns-modal__title" id="sns-modal-title">${escapeHtml(title)}</h2>
          <p class="sns-modal__lede" id="sns-modal-lede">You can pause anytime.</p>
        </div>
        <div class="sns-modal__body">
          <p class="sns-modal__how"><strong>What happens next:</strong> for each item, the extension opens its Edit dialog on this page and confirms Amazon&rsquo;s own cancellation, one at a time, with a <span id="sns-pace">short</span> pause in between. Keep this tab open until it finishes.</p>
          <div>
            <div class="sns-modal__section-label">Will be cancelled (${c.cancel})</div>
            <ul class="sns-modal__list">${willCancel.map(listItem).join('')}</ul>
          </div>
          ${willKeep.length ? `
          <details class="sns-modal__kept">
            <summary>Will be kept (${willKeep.length})</summary>
            <ul class="sns-modal__list sns-modal__list--keep">${willKeep.map(listItem).join('')}</ul>
          </details>` : ''}
          <div class="sns-field">
            <label class="sns-field__label" for="sns-reason-select">Reason given to Amazon (optional)</label>
            <select class="sns-select" id="sns-reason-select">
              <option value="">No reason (skip this question)</option>
              ${REASON_OPTIONS.map((r) => `<option value="${escapeAttr(r)}">${escapeHtml(r)}</option>`).join('')}
            </select>
          </div>
          <div class="sns-modal__error" id="sns-modal-error" role="alert" hidden></div>
        </div>
        <div class="sns-modal__footer">
          <button type="button" class="sns-btn sns-btn--ghost" id="sns-cancel-modal">Go back</button>
          <button type="button" class="sns-btn sns-btn--danger" id="sns-confirm-run">Cancel ${c.cancel} now</button>
        </div>
      </div>
    `;
    shadow.appendChild(modalEl);
    const dialog = modalEl.querySelector('.sns-modal');

    const onKey = (e) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'Tab') return;
      // Keep keyboard focus inside the dialog while it is open. Focus inside
      // our shadow root shows up as shadow.activeElement, not document's.
      const focusable = [...dialog.querySelectorAll('button:not([disabled]), select, summary, [tabindex="0"]')];
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      const active = shadow.activeElement;
      if (e.shiftKey && (active === first || active === dialog || !modalEl.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !modalEl.contains(active))) { e.preventDefault(); first.focus(); }
    };
    // Also used when the dialog goes stale (choices changed in another tab, or
    // a run took over the screen), so its key listener never outlives it.
    const close = ({ restoreFocus = true } = {}) => {
      if (closeModal !== close) return;
      closeModal = null;
      modalEl.remove();
      document.removeEventListener('keydown', onKey, true);
      if (!restoreFocus) return;
      const back = byId('sns-preview') || opener;
      try { back?.focus?.({ preventScroll: true }); } catch (_) {}
    };
    closeModal = close;
    document.addEventListener('keydown', onKey, true);
    modalEl.querySelector('.sns-modal-backdrop').addEventListener('click', () => close());
    byId('sns-cancel-modal').addEventListener('click', () => close());
    byId('sns-confirm-run').addEventListener('click', async () => {
      const confirmBtn = byId('sns-confirm-run');
      if (confirmBtn.disabled) return;
      confirmBtn.disabled = true; // a second click must not queue a second start request
      const idleLabel = confirmBtn.innerHTML;
      confirmBtn.innerHTML = '<span class="sns-spinner sns-spinner--light" aria-hidden="true"></span>Starting…';
      confirmBtn.setAttribute('aria-busy', 'true');
      const reason = byId('sns-reason-select').value;
      const err = byId('sns-modal-error');
      if (err) err.hidden = true;
      await flushKeep();
      const r = await msg('sns:startRun', { reason });
      if (!r?.ok) {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = idleLabel;
        confirmBtn.removeAttribute('aria-busy');
        if (err) {
          err.textContent = r?.error || (r === undefined ? unreachableMessage() : 'Could not start cancellation.');
          err.hidden = false;
        }
        return;
      }
      close({ restoreFocus: false }); // the progress card takes over the screen
    });
    try { dialog.focus({ preventScroll: true }); } catch (_) {}

    msg('sns:getState').then((run) => {
      const select = byId('sns-reason-select');
      if (select) select.value = run?.reason || '';
    });
    msg('sns:getOptions').then((opts) => {
      const pace = byId('sns-pace');
      const [lo, hi] = Array.isArray(opts?.jitterMs) ? opts.jitterMs : [];
      if (pace && lo && hi) pace.textContent = `${seconds(lo)}–${seconds(hi)} second`;
    });
  }

  // ---------- Scan & lifecycle ----------
  async function doScan() {
    if (state.scanning || ['running', 'paused'].includes(state.runStatus)) return;
    state.scanning = true;
    state.error = null;
    state.scanNote = 'Loading your subscriptions…';
    renderPanel();
    try {
      const expanded = await expandCurrentPage();
      const pageItems = await scanAdditionalPages(expanded);
      // Amazon's React hydration + lazy-loaded images mean the first scan often
      // finds tiles but with placeholder image src=""/data:. Keep retrying until
      // we have items AND most of them have real product images, with a long
      // upper bound so direct page-refresh (no popup nav) eventually settles.
      let items = [];
      let bestItems = pageItems || [];
      const MAX_ATTEMPTS = 14;     // ~14 * 600ms = 8.4s max
      const STEP_MS = 600;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        items = mergeItems(bestItems, scan());
        if (items.length) {
          const withImg = items.filter((i) => i.image).length;
          // Remember the most-complete scan we've seen so far.
          const prevWithImg = bestItems.filter((i) => i.image).length;
          if (items.length > bestItems.length || withImg > prevWithImg) {
            bestItems = items;
          }
          // We're done as soon as every visible item has a real image.
          if (withImg === items.length) break;
          setScanNote(`Loading product images… (${items.length} found)`);
        }
        await sleep(STEP_MS);
      }
      const scanned = enrichItems(bestItems.length ? bestItems : items);
      setScanNote(`Saving ${scanned.length} subscription${scanned.length === 1 ? '' : 's'}…`);
      // Stay in the scanning state until the background has merged saved
      // choices, so the list appears once, with the right keep/cancel marks.
      const result = await msg('sns:scanComplete', { items: scanned });
      if (result?.run) {
        state.items = enrichItems(result.run.items.filter(item => item.status !== 'done'));
        state.runStatus = result.run.status;
      } else if (result === undefined) {
        state.error = unreachableMessage();
      } else {
        state.error = result.error || 'The scan could not be saved.';
      }
    } catch (error) {
      console.warn('SNS manager: scan failed', error);
      state.error = `Scan failed: ${error?.message || error}`;
    } finally {
      state.scanning = false;
      state.scanNote = '';
      renderPanel();
    }
  }

  async function init() {
    const [, run] = await Promise.all([loadUi(), msg('sns:getState')]);
    state.runStatus = run?.status || 'idle';
    if (RUN_OWNS_SCREEN.includes(state.runStatus)) {
      // A run is active, or its finish summary is still showing: the progress
      // card (content_progress.js) owns the screen until it is dismissed.
      renderPanel();
      return;
    }
    await doScan();
  }

  function sameChoices(a, b) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => item.id === b[i].id && !!item.keep === !!b[i].keep &&
      item.status === b[i].status && !!item.needsReview === !!b[i].needsReview);
  }

  // React to state changes (e.g., run finishes, or choices restored from the popup).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.sns_ui?.newValue) {
      // Open/closed and explainer state follow the user across tabs.
      Object.assign(ui, changes.sns_ui.newValue);
      renderPanel();
    }
    if (!changes.sns_run) return;
    const next = changes.sns_run.newValue;
    if (!next) return;
    const prev = state.runStatus;
    state.runStatus = next.status;
    if (RUN_OWNS_SCREEN.includes(next.status)) {
      renderPanel(); // the panel steps aside; the progress card takes over
      return;
    }
    if (prev === 'done') {
      // The finish summary was dismissed: show what is left on this page.
      doScan();
      return;
    }
    // A scan in progress will render the merged result itself.
    if (state.scanning) return;
    let items = enrichItems((next.items || []).filter(item => item.status !== 'done'));
    if (keepWritePending()) {
      // Our own newer choices haven't been written yet; this is an older echo.
      // Keep showing the local choices, which is what storage will hold next.
      const local = new Map(state.items.map((i) => [i.id, i.keep]));
      items = items.map((i) => (local.has(i.id) ? { ...i, keep: local.get(i.id) } : i));
    }
    if (!sameChoices(items, state.items)) {
      state.items = items;
      closeModal?.({ restoreFocus: false }); // choices changed elsewhere; the preview is stale
    }
    renderPanel();
  });

  // ---------- escape helpers ----------
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  init();
})();
