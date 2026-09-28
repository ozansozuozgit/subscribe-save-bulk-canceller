// Scrape the Subscribe & Save manager page into an array of subscription items.
// Each item: { id, title, image, nextDate, editUrl }
// Strategy: find every edit link first, then walk UP to the nearest tile container
// and harvest title/image/date from siblings. More robust than guessing tiles.

(function () {
  if (window.__SNS_SCAN__) return;
  window.__SNS_SCAN__ = true;

  const { visible, byText, shortHash, NORM } = window.SNSUtils;
  const { TILE_CONTAINERS, TILE_FIELDS } = window.SNSSelectors;

  function isLiveRoot(root) {
    return root === document || root === document.body || root === document.documentElement;
  }

  function isVisible(el, root = document) {
    if (!el) return false;
    if (!isLiveRoot(root)) {
      const hidden = el.closest?.('[hidden], [aria-hidden="true"]');
      if (hidden) return false;
      const style = (el.getAttribute?.('style') || '').toLowerCase();
      return !/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0/.test(style);
    }
    return visible(el);
  }

  function textOf(el) {
    return (el?.innerText || el?.textContent || '').trim();
  }

  function findEditAnchors(root = document) {
    const anchors = new Set();
    for (const css of TILE_FIELDS.editLinkCss) {
      root.querySelectorAll(css).forEach((a) => {
        if ((a.href || a.getAttribute('href')) && isVisible(a, root)) anchors.add(a);
      });
    }
    return [...anchors];
  }

  // Fallback for the new /auto-deliveries/subscriptionList layout, where each
  // tile's "Edit" control is a button (not an <a> with an edit URL). The
  // dependable anchor is the "Next delivery by ..." label on every real
  // subscription card. We have to be careful: ad copy and credit-card upsells
  // also say "Next delivery" — so we additionally require the tile to contain
  // the frequency pattern ("every N day/week/month/year") that only real
  // subscriptions have.
  const FREQ_RE = /every\s+\d+\s*(day|days|week|weeks|month|months|year|years)/i;

  function findTilesByMarker(root = document) {
    const tiles = new Set();
    const searchRoot = root.body || root;
    const markers = byText(
      searchRoot,
      'next delivery',
      ['span', 'div', 'p', 'b', 'strong', 'h2', 'h3', 'h4']
    );
    for (const m of markers) {
      if (!isVisible(m, root)) continue;
      const tile = climbToTile(m, root);
      if (tile) tiles.add(tile);
    }
    return [...tiles];
  }

  // Walk up from a "Next delivery by" marker to the smallest ancestor that
  // also contains a frequency line ("every N days/weeks/months/years") and
  // a product image. Frequency is the discriminator that excludes credit-card
  // promos and other "Next delivery" copy on the page.
  // We stop and back off once we cross into multi-tile territory.
  function climbToTile(start, root = document) {
    let p = start;
    let depth = 0;
    const body = root.body || document.body;
    while (p && p !== body && depth < 16) {
      const txt = textOf(p);
      const hasImg = !!p.querySelector('img');
      const hasFreq = FREQ_RE.test(txt);
      const markerCount = countMarkers(p, 'next delivery');
      if (markerCount > 1) return null; // crossed into a section wrapping multiple tiles
      if (hasImg && hasFreq) return p;
      p = p.parentElement;
      depth++;
    }
    return null;
  }

  function countMarkers(root, phrase) {
    const target = NORM(phrase);
    if (!target) return 0;
    let n = 0;
    const doc = root.ownerDocument || document;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
      const v = NORM(walker.currentNode.nodeValue);
      if (v && v.includes(target)) {
        n++;
        if (n > 1) return n;
      }
    }
    return n;
  }

  function findEditUrlInTile(tile) {
    const raw = tile.getAttribute('data-edit-url') || tile.querySelector('[data-edit-url]')?.getAttribute('data-edit-url');
    if (raw) {
      try {
        const url = new URL(raw, location.origin);
        if (url.origin === location.origin && /\/auto-deliveries\//.test(url.pathname)) return url.href;
      } catch (_) {}
    }
    // Prefer a real <a> with an edit-ish href
    for (const css of TILE_FIELDS.editLinkCss) {
      const a = tile.querySelector(css);
      if (a && a.href) return a.href;
    }
    // Any anchor that mentions "edit" in its href or visible text
    const anchors = tile.querySelectorAll('a[href]');
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const txt = NORM(a.innerText || a.textContent);
      if (/edit/i.test(href) || txt === 'edit') {
        try { return new URL(href, location.origin).toString(); } catch (_) {}
      }
    }
    return null;
  }

  // Walk up from an element until we find a tile-shaped container.
  function findTileContainer(el, root = document) {
    let p = el;
    let depth = 0;
    const body = root.body || document.body;
    // Prefer explicit data attributes
    while (p && p !== body && depth < 12) {
      if (p.dataset && (p.dataset.subscriptionId || p.dataset.asin)) return p;
      for (const css of TILE_CONTAINERS) {
        if (p.matches && p.matches(css)) return p;
      }
      p = p.parentElement;
      depth++;
    }
    // Fallback: walk up until container is "wide enough" (a card, not just the link's row)
    p = el;
    depth = 0;
    while (p && p !== body && depth < 8) {
      const r = p.getBoundingClientRect();
      if (r.width > 300 && r.height > 80) return p;
      p = p.parentElement;
      depth++;
    }
    return el.parentElement || el;
  }

  function extractSubscriptionId(url) {
    if (!url) return null;
    try {
      const u = new URL(url, location.origin);
      const sid = u.searchParams.get('subscriptionId') || u.searchParams.get('subscription_id');
      if (sid) return sid;
    } catch (_) {}
    // Also accept matches embedded in the path or anywhere as SNST0_… style.
    const m = String(url).match(/(SNST\w+_[A-F0-9]+|SUB-\w+)/i);
    return m ? m[1] : null;
  }

  function buildCancelUrl(subscriptionId) {
    if (!subscriptionId) return null;
    const params = new URLSearchParams({
      subscriptionId,
      clientName: 'mydHub',
      enableMydExperience: '1',
    });
    return `https://www.amazon.com/auto-deliveries/cancelSubscription?${params.toString()}`;
  }

  function extractAsin(tile, editUrl) {
    if (tile?.dataset?.asin) return tile.dataset.asin;
    // From any /dp/XXXXXXXXXX/ pattern in any anchor inside the tile
    const a = tile.querySelector('a[href*="/dp/"]');
    if (a) {
      const m = a.getAttribute('href').match(/\/dp\/([A-Z0-9]{10})/i);
      if (m) return m[1];
    }
    // From edit URL query
    try {
      const u = new URL(editUrl, location.origin);
      const asin = u.searchParams.get('subAsin') || u.searchParams.get('asin') || u.searchParams.get('ASIN');
      if (asin) return asin;
    } catch (_) {}
    return null;
  }

  function extractTitle(tile) {
    const fullTitle = tile.querySelector('.a-truncate-full');
    if (textOf(fullTitle)) return textOf(fullTitle);
    const productImage = tile.querySelector('img[alt]:not([role="presentation"])');
    if (productImage?.alt?.trim()) return productImage.alt.trim();
    for (const css of TILE_FIELDS.titleCss) {
      const el = tile.querySelector(css);
      if (el && isVisible(el, tile.ownerDocument || document)) {
        const text = textOf(el);
        if (text && text.length > 2 && text.length < 400) return text;
      }
    }
    // Fallback: longest visible text in the tile under 200 chars
    const candidates = [];
    tile.querySelectorAll('a, span, h2, h3, h4').forEach((el) => {
      if (!isVisible(el, tile.ownerDocument || document)) return;
      const t = textOf(el);
      if (t.length > 10 && t.length < 200 && !/^(edit|cancel|skip|change|details)$/i.test(t)) {
        candidates.push(t);
      }
    });
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0] || 'Untitled subscription';
  }

  function extractImage(tile) {
    // Walk every img in the tile, prefer the largest properly-loaded one and
    // skip Amazon's 1×1 lazy-load placeholders (data: URIs or unloaded imgs).
    const candidates = [];
    tile.querySelectorAll('img').forEach((img) => {
      if (!isVisible(img, tile.ownerDocument || document)) return;
      const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
      if (!src || !/^https?:/i.test(src)) return; // skip data: placeholders
      // Skip tiny tracking pixels (1×1) and the gif spacer Amazon uses pre-load.
      if (img.complete && img.naturalWidth > 0 && img.naturalWidth < 24) return;
      const rect = img.getBoundingClientRect();
      const area = rect.width * rect.height;
      candidates.push({ src, area });
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.area - a.area);
    return candidates[0].src;
  }

  function extractDateCandidate(text) {
    const src = String(text || '').replace(/\s+/g, ' ').trim();
    if (!src) return null;
    const relative = src.match(/\b(today|tomorrow)\b/i);
    if (relative) return relative[1];
    const monthDate = src.match(/\b(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)?,?\s*(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:,\s*\d{4})?/i);
    if (monthDate) return monthDate[0].replace(/^,\s*/, '').trim();
    const numeric = src.match(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/);
    return numeric ? numeric[0] : null;
  }

  function extractNextDate(tile) {
    const allText = textOf(tile);
    const nextIdx = allText.toLowerCase().indexOf('next delivery');
    if (nextIdx >= 0) {
      const slice = allText.slice(Math.max(0, nextIdx), nextIdx + 220);
      const date = extractDateCandidate(slice);
      if (date) return date;
    }

    // Look for short text near labels like "Next delivery" or "Arriving"
    for (const label of TILE_FIELDS.nextDateLabels) {
      const hits = byText(tile, label, ['span', 'div', 'p', 'b', 'strong']);
      for (const hit of hits) {
        if (!isVisible(hit, tile.ownerDocument || document)) continue;
        // Try sibling / parent for the actual date value
        const candidates = [
          hit.nextElementSibling,
          hit.parentElement?.querySelector('span:not(:first-child)'),
          hit.parentElement,
        ].filter(Boolean);
        for (const c of candidates) {
          const t = textOf(c).replace(label, '').replace(/[:\-]/g, '').trim();
          const date = extractDateCandidate(t);
          if (date) return date;
        }
      }
    }
    const fallbackDate = extractDateCandidate(allText);
    if (fallbackDate) return fallbackDate;
    return null;
  }

  function scan(root = document) {
    // Current Amazon cards expose the actual subscription identity here.
    // Never hash hydrated/truncated text when a stable ID is available.
    const modern = [...root.querySelectorAll('[data-edit-url]')].filter(tile =>
      isVisible(tile, root) && !tile.closest('#sns-root, #sns-modal, #sns-progress-root')
    );
    if (modern.length) {
      const items = new Map();
      for (const tile of modern) {
        const editUrl = findEditUrlInTile(tile);
        const subscriptionId = extractSubscriptionId(editUrl);
        if (!subscriptionId || !tile.querySelector('img')) continue;
        items.set(subscriptionId, {
          id: subscriptionId, subscriptionId, editUrl,
          cancelUrl: buildCancelUrl(subscriptionId),
          asin: extractAsin(tile, editUrl),
          title: extractTitle(tile), image: extractImage(tile),
          nextDate: extractNextDate(tile),
        });
      }
      if (items.size) return [...items.values()];
    }
    const anchors = findEditAnchors(root);
    const seenKey = new Set();
    const seenTile = new Set();
    const items = [];

    // Pass 1 — legacy manager: tiles discovered via an explicit edit anchor.
    for (const a of anchors) {
      let editUrl;
      try {
        editUrl = new URL(a.getAttribute('href'), location.origin).toString();
      } catch (_) {
        continue;
      }
      const dupKey = editUrl.split('?')[0] + '|' + (new URL(editUrl, location.origin).searchParams.get('subscriptionId') || '');
      if (seenKey.has(dupKey)) continue;
      seenKey.add(dupKey);

      const tile = findTileContainer(a, root);
      seenTile.add(tile);
      const asin = extractAsin(tile, editUrl);
      const subscriptionId = extractSubscriptionId(editUrl);
      items.push({
        id: subscriptionId || asin || shortHash(editUrl),
        asin: asin || null,
        subscriptionId,
        title: extractTitle(tile),
        image: extractImage(tile),
        nextDate: extractNextDate(tile),
        editUrl,
        cancelUrl: buildCancelUrl(subscriptionId),
      });
    }

    // Pass 2 — new subscriptionList layout: tiles discovered via "Next delivery by".
    for (const tile of findTilesByMarker(root)) {
      if (tile.closest('#sns-root, #sns-modal, #sns-progress-root')) continue;
      if (seenTile.has(tile)) continue;
      seenTile.add(tile);
      const editUrl = findEditUrlInTile(tile);
      const asin = extractAsin(tile, editUrl || '');
      const subscriptionId = extractSubscriptionId(editUrl || '');
      const id = subscriptionId || asin || shortHash(textOf(tile).slice(0, 200));
      const dupKey = (editUrl || id);
      if (seenKey.has(dupKey)) continue;
      seenKey.add(dupKey);
      items.push({
        subscriptionId,
        cancelUrl: buildCancelUrl(subscriptionId),
        id,
        asin: asin || null,
        title: extractTitle(tile),
        image: extractImage(tile),
        nextDate: extractNextDate(tile),
        editUrl: editUrl || null,
      });
    }

    return items;
  }

  window.SNSScan = { scan };
})();
