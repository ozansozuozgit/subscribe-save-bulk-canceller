// Runs on Amazon's Subscribe & Save manager pages.
// Scans the page, renders the review panel (bottom-right), and on confirm
// kicks off the run via the background worker.

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
    minimized: false,
    sortBy: 'nextDate',  // default | nextDate | title
    filterBy: 'all',     // all | cancel | keep | soon
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
      if (state.filterBy === 'soon' && !item.shippingSoon) return false;
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

  // ---------- DOM ----------
  const ROOT_ID = 'sns-root';

  function ensureRoot() {
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      document.documentElement.appendChild(root);
    }
    return root;
  }

  function svg(name) {
    const ICONS = {
      check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
      minimize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
      close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>',
      box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9 4-9-4 9-4 9 4z"/><path d="M3 8v9l9 4 9-4V8"/></svg>',
    };
    return ICONS[name] || '';
  }

  function renderEmpty() {
    return `
      <div class="sns-empty">
        <div class="sns-empty__icon">${svg('box')}</div>
        <div class="sns-empty__title">No subscriptions found</div>
        <div class="sns-empty__msg">If this looks wrong, scan again or reload the page. The extension scans active Subscribe &amp; Save items.</div>
        <button class="sns-btn sns-btn--ghost sns-empty__action" id="sns-retry">Scan again</button>
      </div>
    `;
  }

  function renderError() {
    return `
      <div class="sns-empty sns-empty--error" role="alert">
        <div class="sns-empty__icon">${svg('close')}</div>
        <div class="sns-empty__title">Couldn&rsquo;t load your subscriptions</div>
        <div class="sns-empty__msg" id="sns-error-msg"></div>
        <button class="sns-btn sns-btn--ghost sns-empty__action" id="sns-retry">Try again</button>
      </div>
    `;
  }

  // Placeholder rows with the same height as real rows, so the card doesn't
  // jump when the list arrives.
  function renderSkeleton() {
    const row = `
      <div class="sns-skeleton__row">
        <div class="sns-skeleton__box"></div>
        <div class="sns-skeleton__thumb"></div>
        <div class="sns-skeleton__lines"><div></div><div></div></div>
      </div>`;
    return `<div class="sns-skeleton" aria-hidden="true">${row.repeat(6)}</div>`;
  }

  function renderItemRow(item) {
    const kept = item.keep ? ' sns-item--kept' : '';
    const soon = item.shippingSoonest
      ? '<span class="sns-badge sns-badge--soonest">Next</span>'
      : item.shippingSoon
        ? '<span class="sns-badge">Next</span>'
        : '';
    const warning = item.needsReview ? '<span>Review needed: matching subscriptions</span>' : '';
    const meta = item.nextDate ? `<span>Next: ${escapeHtml(item.nextDate)}</span>${soon}` : `<span>Active subscription</span>`;
    const img = item.image
      ? `<img src="${escapeAttr(item.image)}" alt="" loading="lazy"/>`
      : `<div class="sns-item__thumb--placeholder">${svg('box')}</div>`;
    return `
      <div class="sns-item${kept}" data-id="${escapeAttr(item.id)}" role="button" tabindex="0" aria-pressed="${!item.keep}">
        <div class="sns-checkbox" aria-hidden="true">${svg('check')}</div>
        <div class="sns-item__thumb">${img}</div>
        <div class="sns-item__body">
          <div class="sns-item__title">${escapeHtml(item.title || 'Untitled')}</div>
          <div class="sns-item__meta">${meta}${warning}</div>
        </div>
      </div>
    `;
  }

  // ---------- Rendering ----------
  // The panel is mounted once per "mode" and patched in place afterwards.
  // Previously every state change rebuilt the whole card with innerHTML, which
  // replayed the card's slide-in animation and re-created every thumbnail
  // (the startup flicker). Now:
  //   - the .sns-card element is created once and survives mode changes,
  //   - its body is rebuilt only when the mode changes (loading → list …),
  //   - counts, notes and labels are patched in place,
  //   - list rows are keyed by id and reused (see renderList).
  let mountedMode = null;

  function panelMode() {
    if (state.runStatus === 'running' || state.runStatus === 'paused') return 'hidden';
    if (state.minimized) return 'minimized';
    if (state.items.length) return 'list';
    if (state.scanning) return 'loading';
    if (state.error) return 'error';
    return 'empty';
  }

  function ensureCard(root) {
    let card = root.firstElementChild;
    if (!card || !card.classList.contains('sns-card')) {
      root.innerHTML = '<div class="sns-card" role="dialog" aria-label="Subscription Bulk Canceller"></div>';
      card = root.firstElementChild;
    }
    return card;
  }

  function mount(root, mode) {
    rowCache.clear();
    if (mode === 'hidden') { root.replaceChildren(); return; }
    if (mode === 'minimized') {
      root.innerHTML = `
        <div class="sns-pill" id="sns-restore" role="button" tabindex="0">
          <div class="sns-pill__dot"></div>
          <span><strong id="sns-pill-count"></strong> subscriptions · click to review</span>
        </div>`;
      const restore = () => { state.minimized = false; renderPanel(); };
      const pill = document.getElementById('sns-restore');
      pill.addEventListener('click', restore);
      pill.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); restore(); } });
      return;
    }
    const card = ensureCard(root);
    const note = '<div class="sns-scan-note" id="sns-scan-note" role="status" aria-live="polite" hidden><span class="sns-spinner" aria-hidden="true"></span><span id="sns-scan-note-text"></span></div>';
    if (mode === 'loading') {
      card.innerHTML = `${renderHeader()}${note}${renderSkeleton()}`;
    } else if (mode === 'empty') {
      card.innerHTML = `${renderHeader()}${note}${renderEmpty()}`;
    } else if (mode === 'error') {
      card.innerHTML = `${renderHeader()}${note}${renderError()}`;
    } else {
      card.innerHTML = `
        ${renderHeader()}
        ${note}
        <div class="sns-card__stats">
          <div class="sns-stat">
            <div class="sns-stat__value" id="sns-stat-total"></div>
            <div class="sns-stat__label">Active</div>
          </div>
          <div class="sns-stat">
            <div class="sns-stat__value sns-stat__value--accent" id="sns-stat-cancel"></div>
            <div class="sns-stat__label">Will cancel</div>
          </div>
          <div class="sns-stat">
            <div class="sns-stat__value sns-stat__value--keep" id="sns-stat-keep"></div>
            <div class="sns-stat__label">Keep</div>
          </div>
        </div>
        <div class="sns-card__toolbar">
          <button id="sns-select-all">Cancel all</button>
          <button id="sns-keep-all">Keep all</button>
          <button id="sns-invert">Invert</button>
          <button id="sns-sort">Sort: ${sortLabel()}</button>
        </div>
        <div class="sns-card__filters">
          ${renderFilterButton('all', filterLabel('all'))}
          ${renderFilterButton('cancel', filterLabel('cancel'))}
          ${renderFilterButton('keep', filterLabel('keep'))}
          ${renderFilterButton('soon', filterLabel('soon'))}
          <input id="sns-search" type="search" value="${escapeAttr(state.query)}" placeholder="Filter products" aria-label="Filter products">
        </div>
        <div class="sns-card__list" id="sns-list"></div>
        <div class="sns-card__footer">
          <button class="sns-btn sns-btn--ghost" id="sns-rescan">Rescan</button>
          <button class="sns-btn sns-btn--primary" id="sns-preview" disabled></button>
        </div>
      `;
      bindToolbar();
      bindList();
      document.getElementById('sns-rescan').addEventListener('click', doScan);
      document.getElementById('sns-preview').addEventListener('click', openPreview);
    }
    bindHeader();
    document.getElementById('sns-retry')?.addEventListener('click', doScan);
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
    if (mode === 'minimized') {
      document.getElementById('sns-pill-count').textContent = String(state.items.length);
      return;
    }
    const card = root.firstElementChild;
    card.setAttribute('aria-busy', String(!!state.scanning));
    const subtitle = card.querySelector('.sns-card__subtitle');
    if (subtitle) subtitle.textContent = subtitleText();
    const noteEl = document.getElementById('sns-scan-note');
    if (noteEl) {
      // In list mode a failed rescan is reported in the same strip, above the
      // previous (still valid) list.
      const showError = !state.scanning && !!state.error && mode === 'list';
      noteEl.hidden = !state.scanning && !showError;
      noteEl.classList.toggle('sns-scan-note--error', showError);
      document.getElementById('sns-scan-note-text').textContent = showError
        ? state.error
        : state.scanNote || 'Loading your subscriptions…';
    }
    const rescan = document.getElementById('sns-rescan');
    if (rescan) {
      rescan.disabled = !!state.scanning;
      rescan.textContent = state.scanning ? 'Scanning…' : 'Rescan';
    }
    if (mode === 'error') document.getElementById('sns-error-msg').textContent = state.error || '';
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

  function rowFor(item) {
    const sig = JSON.stringify([item.title, item.image, item.nextDate, item.shippingSoon, item.shippingSoonest, item.needsReview]);
    let hit = rowCache.get(item.id);
    if (!hit || hit.sig !== sig) {
      const t = document.createElement('template');
      t.innerHTML = renderItemRow(item).trim();
      hit = { sig, el: t.content.firstElementChild };
      rowCache.set(item.id, hit);
    }
    hit.el.classList.toggle('sns-item--kept', !!item.keep);
    hit.el.setAttribute('aria-pressed', String(!item.keep));
    return hit.el;
  }

  function renderList(preserveScroll = true) {
    const list = document.getElementById('sns-list');
    if (!list) return;
    const visibleItems = sortItems(filteredItems());
    let next;
    if (visibleItems.length) {
      next = visibleItems.map(rowFor);
    } else {
      if (!emptyFilterEl) {
        emptyFilterEl = document.createElement('div');
        emptyFilterEl.className = 'sns-list-empty';
        emptyFilterEl.textContent = 'No items match this filter.';
      }
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
    const soonCount = state.items.filter((i) => i.shippingSoon).length;
    return {
      all: `All ${c.total}`,
      cancel: `Cancel ${c.cancel}`,
      keep: `Keep ${c.kept}`,
      soon: `Next ${soonCount}`,
    }[name] || name;
  }

  // Refreshes every count-derived bit of the shell in place.
  function updateCounts() {
    const c = counts();
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(value);
    };
    set('sns-stat-total', c.total);
    set('sns-stat-cancel', c.cancel);
    set('sns-stat-keep', c.kept);
    document.querySelectorAll('.sns-filter').forEach((btn) => {
      btn.textContent = filterLabel(btn.getAttribute('data-filter'));
    });
    const preview = document.getElementById('sns-preview');
    if (preview) {
      preview.disabled = !c.cancel;
      preview.innerHTML = c.cancel ? `Review &amp; cancel ${c.cancel}` : 'Nothing selected';
    }
  }

  function sortLabel() {
    return state.sortBy === 'title' ? 'A–Z' : state.sortBy === 'nextDate' ? 'Next delivery' : 'Default';
  }

  function renderFilterButton(name, label) {
    const active = state.filterBy === name ? ' sns-filter--active' : '';
    return `<button class="sns-filter${active}" data-filter="${name}">${escapeHtml(label)}</button>`;
  }

  function subtitleText() {
    const n = state.items.length;
    if (state.runStatus === 'running' || state.runStatus === 'paused') return 'A cancellation run is in progress.';
    if (state.scanning && n === 0) return 'Reading your subscriptions page…';
    if (n === 0) return state.error ? 'Something went wrong.' : 'A review of your recurring orders.';
    if (n === 1) return 'One recurring order, ready to review.';
    return `${n} subscriptions · choices saved in this browser.`;
  }

  function renderHeader() {
    return `
      <div class="sns-card__header">
        <div class="sns-card__logo"></div>
        <div class="sns-card__title">Subscription Bulk Canceller</div>
        <div class="sns-card__subtitle">${escapeHtml(subtitleText())}</div>
        <button class="sns-iconbtn" id="sns-minimize" title="Minimize" aria-label="Minimize">${svg('minimize')}</button>
      </div>`;
  }

  function bindHeader() {
    const btn = document.getElementById('sns-minimize');
    if (btn) btn.addEventListener('click', () => { state.minimized = true; renderPanel(); });
  }

  function bindToolbar() {
    const setAll = (keep) => {
      state.items = state.items.map((i) => ({ ...i, keep }));
      pushKeepToBg();
      renderList(true);
      updateCounts();
    };
    document.getElementById('sns-select-all').addEventListener('click', () => setAll(false));
    document.getElementById('sns-keep-all').addEventListener('click', () => setAll(true));
    document.getElementById('sns-invert').addEventListener('click', () => {
      state.items = state.items.map((i) => ({ ...i, keep: !i.keep }));
      pushKeepToBg();
      renderList(true);
      updateCounts();
    });
    document.getElementById('sns-sort').addEventListener('click', (e) => {
      const order = ['default', 'title', 'nextDate'];
      const next = order[(order.indexOf(state.sortBy) + 1) % order.length];
      state.sortBy = next;
      e.currentTarget.textContent = `Sort: ${sortLabel()}`;
      renderList(false);
    });
    document.querySelectorAll('.sns-filter').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.filterBy = btn.getAttribute('data-filter') || 'all';
        document.querySelectorAll('.sns-filter').forEach((b) => {
          b.classList.toggle('sns-filter--active', b === btn);
        });
        renderList(false);
      });
    });
    const search = document.getElementById('sns-search');
    search.addEventListener('input', () => {
      state.query = search.value;
      renderList(false);
    });
  }

  function bindList() {
    const list = document.getElementById('sns-list');
    if (!list) return;
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.sns-item');
      if (!row) return;
      const id = row.getAttribute('data-id');
      toggleKeep(id);
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
    const row = document.querySelector(`#sns-list .sns-item[data-id="${cssEscape(id)}"]`);
    if (row && item && stillVisible) {
      // Flip just this row — the list keeps its scroll position and focus.
      row.classList.toggle('sns-item--kept', item.keep);
      row.setAttribute('aria-pressed', String(!item.keep));
    } else {
      // The active filter now hides (or reveals) this item — rebuild the list.
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
  function openPreview() {
    const c = counts();
    if (!c.cancel) return;
    const willCancel = state.items.filter((i) => !i.keep);
    const modalEl = document.createElement('div');
    modalEl.className = 'sns-modal-root';
    modalEl.id = 'sns-modal';
    modalEl.innerHTML = `
      <div class="sns-modal-backdrop"></div>
      <div class="sns-modal" role="dialog" aria-modal="true" aria-label="Confirm cancellation">
        <div class="sns-modal__header">
          <div class="sns-modal__title">Cancel ${c.cancel} subscription${c.cancel === 1 ? '' : 's'}?</div>
          <div class="sns-modal__lede">
            We'll open each subscription's Edit dialog, pick your reason, and confirm — one at a time.
            <strong> ${c.kept} item${c.kept === 1 ? '' : 's'} will be kept untouched.</strong>
          </div>
        </div>
        <div class="sns-modal__body">
          <div class="sns-modal__section-label">Cancelling (${c.cancel})</div>
          <div class="sns-modal__list">
            ${willCancel
              .map(
                (i) => `
              <div class="sns-modal__list-item">
                ${i.image ? `<img src="${escapeAttr(i.image)}" alt=""/>` : `<div></div>`}
                <div class="sns-modal__list-item-title">${escapeHtml(i.title || 'Untitled')}</div>
              </div>`
              )
              .join('')}
          </div>
          <div class="sns-field">
            <label class="sns-field__label" for="sns-reason-select">Cancellation reason (optional)</label>
            <select class="sns-select" id="sns-reason-select">
              <option value="">Don&rsquo;t pick a reason &mdash; let Amazon proceed</option>
              ${REASON_OPTIONS.map((r) => `<option value="${escapeAttr(r)}">${escapeHtml(r)}</option>`).join('')}
            </select>
          </div>
          <div class="sns-modal__error" id="sns-modal-error" hidden></div>
        </div>
        <div class="sns-modal__footer">
          <button class="sns-btn sns-btn--ghost" id="sns-cancel-modal">Back</button>
          <button class="sns-btn sns-btn--danger" id="sns-confirm-run">Cancel ${c.cancel} now</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(modalEl);

    const close = () => modalEl.remove();
    modalEl.querySelector('.sns-modal-backdrop').addEventListener('click', close);
    document.getElementById('sns-cancel-modal').addEventListener('click', close);
    document.getElementById('sns-confirm-run').addEventListener('click', async () => {
      const confirmBtn = document.getElementById('sns-confirm-run');
      if (confirmBtn.disabled) return;
      confirmBtn.disabled = true; // a second click must not queue a second start request
      const idleLabel = confirmBtn.innerHTML;
      confirmBtn.innerHTML = '<span class="sns-spinner sns-spinner--light" aria-hidden="true"></span>Starting…';
      confirmBtn.setAttribute('aria-busy', 'true');
      const reason = document.getElementById('sns-reason-select').value;
      const err = document.getElementById('sns-modal-error');
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
      close();
    });

    msg('sns:getState').then(run => {
      const select = document.getElementById('sns-reason-select');
      if (select) select.value = run?.reason || '';
    });

    // ESC to close
    const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
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
    const run = await msg('sns:getState');
    state.runStatus = run?.status || 'idle';
    if (state.runStatus === 'running' || state.runStatus === 'paused') {
      // Don't double up — content_progress.js will show the progress panel
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
    if (area !== 'local' || !changes.sns_run) return;
    const next = changes.sns_run.newValue;
    if (!next) return;
    state.runStatus = next.status;
    if (['running', 'paused'].includes(next.status)) {
      renderPanel(); // hides the card; the progress panel takes over
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
      document.getElementById('sns-modal')?.remove(); // choices changed elsewhere; the preview is stale
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
