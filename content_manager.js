// Runs on the Subscribe & Save manager pages.
// Scans the page, renders the review panel (bottom-right), and on confirm
// kicks off the run via the background worker.

(function () {
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
    runStatus: 'idle',   // mirrors bg.js run.status to know when to hide
  };

  // ---------- Helpers ----------
  function msg(type, payload) {
    return new Promise((res) => chrome.runtime.sendMessage({ type, ...(payload || {}) }, res));
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
        <div class="sns-empty__msg">If this looks wrong, try reloading the page. The extension scans active Subscribe &amp; Save items.</div>
      </div>
    `;
  }

  function renderItemRow(item) {
    const kept = item.keep ? ' sns-item--kept' : '';
    const soon = item.shippingSoonest
      ? '<span class="sns-badge sns-badge--soonest">Next</span>'
      : item.shippingSoon
        ? '<span class="sns-badge">Next</span>'
        : '';
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
          <div class="sns-item__meta">${meta}</div>
        </div>
      </div>
    `;
  }

  function renderPanel() {
    const root = ensureRoot();
    if (state.runStatus === 'running' || state.runStatus === 'paused') {
      // Don't show review panel while a run is in flight; progress UI handles it.
      root.innerHTML = '';
      return;
    }
    if (state.minimized) {
      root.innerHTML = `
        <div class="sns-pill" id="sns-restore">
          <div class="sns-pill__dot"></div>
          <span><strong>${state.items.length}</strong> subscriptions · click to review</span>
        </div>`;
      document.getElementById('sns-restore').addEventListener('click', () => {
        state.minimized = false; renderPanel();
      });
      return;
    }
    if (!state.items.length) {
      root.innerHTML = `
        <div class="sns-card">
          ${renderHeader()}
          <div class="sns-scan-note" id="sns-scan-note" ${state.scanning ? '' : 'hidden'}>${escapeHtml(state.scanNote || 'Scanning subscriptions…')}</div>
          ${renderEmpty()}
        </div>`;
      bindHeader();
      return;
    }
    const c = counts();
    root.innerHTML = `
      <div class="sns-card" role="dialog" aria-label="Subscribe and Save bulk canceller">
        ${renderHeader()}
        <div class="sns-scan-note" id="sns-scan-note" ${state.scanning ? '' : 'hidden'}>${escapeHtml(state.scanNote || 'Scanning subscriptions…')}</div>
        <div class="sns-card__stats">
          <div class="sns-stat">
            <div class="sns-stat__value" id="sns-stat-total">${c.total}</div>
            <div class="sns-stat__label">Active</div>
          </div>
          <div class="sns-stat">
            <div class="sns-stat__value sns-stat__value--accent" id="sns-stat-cancel">${c.cancel}</div>
            <div class="sns-stat__label">Will cancel</div>
          </div>
          <div class="sns-stat">
            <div class="sns-stat__value sns-stat__value--keep" id="sns-stat-keep">${c.kept}</div>
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
      </div>
    `;
    bindHeader();
    bindToolbar();
    bindList();
    document.getElementById('sns-rescan').addEventListener('click', doScan);
    document.getElementById('sns-preview').addEventListener('click', openPreview);
    renderList(false);
    updateCounts();
  }

  // Rebuilds only the list contents; the surrounding card (header, stats,
  // toolbar, search input) stays in the DOM, so focus and listeners survive.
  function renderList(preserveScroll = true) {
    const list = document.getElementById('sns-list');
    if (!list) return;
    const prevScroll = preserveScroll ? list.scrollTop : 0;
    const visibleItems = sortItems(filteredItems());
    list.innerHTML = visibleItems.length
      ? visibleItems.map(renderItemRow).join('')
      : '<div class="sns-list-empty">No items match this filter.</div>';
    list.scrollTop = prevScroll;
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

  function renderHeader() {
    const n = state.items.length;
    let subtitle;
    if (state.runStatus === 'running' || state.runStatus === 'paused') {
      subtitle = 'A cancellation run is in progress.';
    } else if (n === 0) {
      subtitle = 'A review of your recurring orders.';
    } else if (n === 1) {
      subtitle = 'One recurring order, ready to review.';
    } else {
      subtitle = `${n} recurring orders, ready to review.`;
    }
    return `
      <div class="sns-card__header">
        <div class="sns-card__logo"></div>
        <div class="sns-card__title">Subscribe &amp; Save</div>
        <div class="sns-card__subtitle">${subtitle}</div>
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
  function setScanNote(note) {
    state.scanNote = note;
    const el = document.getElementById('sns-scan-note');
    if (!el) {
      renderPanel();
      return;
    }
    el.hidden = !state.scanning;
    el.textContent = note || 'Scanning subscriptions…';
  }

  async function pushKeepToBg() {
    const keepIds = state.items.filter((i) => i.keep).map((i) => i.id);
    await msg('sns:setKeep', { keepIds });
  }

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
      const txt = NORM(el.innerText || el.value || el.getAttribute('aria-label') || el.textContent);
      if (!txt || /disabled|unavailable/.test(txt)) continue;
      const ariaDisabled = el.getAttribute('aria-disabled') === 'true';
      const disabled = el.disabled || ariaDisabled || el.classList?.contains('a-disabled');
      if (disabled || !labels.some((label) => txt.includes(label))) continue;
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
      const more = findLoadMoreControl();
      if (!more) break;
      setScanNote(`Loading more subscriptions (${lastCount || 0} found)…`);
      realClick(more);
      const deadline = Date.now() + 5000;
      let next = best;
      while (Date.now() < deadline) {
        await sleep(350);
        next = mergeItems(best, scan());
        if (next.length > lastCount || !findLoadMoreControl()) break;
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
      setScanNote(`Checking page ${pages + 1}…`);
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
            We'll open each subscription's edit page, pick your reason, and confirm — one at a time.
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
      const reason = document.getElementById('sns-reason-select').value;
      const err = document.getElementById('sns-modal-error');
      if (err) err.hidden = true;
      await pushKeepToBg();
      const r = await msg('sns:startRun', { reason });
      if (!r?.ok) {
        if (err) {
          err.textContent = r?.error || 'Could not start cancellation.';
          err.hidden = false;
        }
        return;
      }
      close();
    });

    // ESC to close
    const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
  }

  // ---------- Scan & lifecycle ----------
  async function doScan() {
    state.scanning = true;
    state.scanNote = 'Loading every visible subscription…';
    renderPanel();
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
      }
      await sleep(STEP_MS);
    }
    state.items = enrichItems(bestItems.length ? bestItems : items);
    state.scanning = false;
    state.scanNote = '';
    await msg('sns:scanComplete', { items: state.items });
    renderPanel();
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

  // React to state changes (e.g., run finishes while we're on the manager page)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.sns_run) return;
    const next = changes.sns_run.newValue;
    if (!next) return;
    if (next.status !== state.runStatus) {
      state.runStatus = next.status;
      if (state.runStatus === 'idle' || state.runStatus === 'done' || state.runStatus === 'reviewing') {
        renderPanel();
      } else {
        // Hide while running — progress panel takes over
        const root = document.getElementById(ROOT_ID);
        if (root) root.innerHTML = '';
      }
    }
  });

  // ---------- escape helpers ----------
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  init();
})();
