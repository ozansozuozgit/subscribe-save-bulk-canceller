// Shared DOM utilities. Loaded into every content script.
// Designed to be idempotent: re-loading this file is safe.

(function () {
  if (window.__SNS_UTILS__) return;
  window.__SNS_UTILS__ = true;

  const NORM = (s) =>
    (s || '')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
    return true;
  }

  function byText(root, text, tags = ['a', 'button', 'span', 'div', 'input', 'label']) {
    const target = NORM(text);
    if (!target) return [];
    const out = [];
    for (const tag of tags) {
      root.querySelectorAll(tag).forEach((el) => {
        const v = NORM(el.innerText || el.value || el.textContent);
        if (v && v.includes(target)) out.push(el);
      });
    }
    return out;
  }

  const uniq = (arr) => [...new Set(arr)];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

  // Wait until predicate() returns truthy or timeout elapses.
  // Uses MutationObserver + polling fallback. Returns whatever predicate returned, or null.
  function waitFor(predicate, { timeout = 8000, interval = 200, root = document.body } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearInterval(poller);
        clearTimeout(timer);
        resolve(val);
      };
      const tryPred = () => {
        try {
          const val = predicate();
          if (val) finish(val);
        } catch (_) {}
      };
      const observer = new MutationObserver(tryPred);
      try {
        observer.observe(root || document.body, { childList: true, subtree: true, attributes: true });
      } catch (_) {}
      const poller = setInterval(tryPred, interval);
      const timer = setTimeout(() => finish(null), timeout);
      tryPred();
    });
  }

  // Click an element with both click() and a synthetic MouseEvent — Amazon ignores some bare .click() calls.
  function realClick(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ behavior: 'instant', block: 'center' });
    } catch (_) {
      try { el.scrollIntoView(); } catch (_) {}
    }
    try {
      el.click();
    } catch (_) {}
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    } catch (_) {}
    return true;
  }

  function isClickable(el) {
    if (!el) return false;
    if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'LABEL') return true;
    if (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button' || el.type === 'radio')) return true;
    if (el.onclick) return true;
    if (el.getAttribute('role') === 'button') return true;
    if (el.classList && (el.classList.contains('a-button') || el.classList.contains('a-button-input'))) return true;
    if (el.closest && el.closest('button, a, [role="button"], .a-button')) return true;
    return false;
  }

  // Resolve one of several selector descriptors to a visible element. Returns first hit.
  // Descriptors:
  //   { css: 'selector' }
  //   { css: 'selector', within: parentEl }
  //   { attr: 'data-x', equals: 'foo' }
  //   { text: ['Cancel subscription', 'End subscription'], tags?: [...], requireClickable?: bool }
  function resolve(descriptor, root = document) {
    if (!descriptor) return null;
    if (descriptor.css) {
      const scope = descriptor.within || root;
      const nodes = scope.querySelectorAll(descriptor.css);
      for (const n of nodes) if (visible(n)) return n;
      return null;
    }
    if (descriptor.attr) {
      const sel = descriptor.equals
        ? `[${descriptor.attr}="${descriptor.equals}"]`
        : `[${descriptor.attr}]`;
      const nodes = root.querySelectorAll(sel);
      for (const n of nodes) if (visible(n)) return n;
      return null;
    }
    if (descriptor.text) {
      const labels = Array.isArray(descriptor.text) ? descriptor.text : [descriptor.text];
      for (const label of labels) {
        const candidates = byText(root, label, descriptor.tags || ['button', 'a', 'input', 'span', 'label']);
        const filtered = candidates.filter((el) => visible(el) && (!descriptor.requireClickable || isClickable(el)));
        if (filtered.length) return filtered[0];
      }
      return null;
    }
    return null;
  }

  // Try a list of descriptors in order, click the first match. Returns the element or null.
  function resolveAndClick(descriptors, root = document) {
    for (const d of descriptors || []) {
      const el = resolve(d, root);
      if (el) {
        realClick(el);
        return el;
      }
    }
    return null;
  }

  // Watch for a descriptor to become visible, then return it.
  function waitForDescriptor(descriptors, { timeout = 8000 } = {}) {
    const list = Array.isArray(descriptors) ? descriptors : [descriptors];
    return waitFor(() => {
      for (const d of list) {
        const el = resolve(d);
        if (el) return el;
      }
      return null;
    }, { timeout });
  }

  async function clickByAnyText(labels, exact = false, timeout = 8000) {
    const start = performance.now();
    while (performance.now() - start < timeout) {
      for (const label of labels) {
        const target = NORM(label);
        const candidates = byText(document, label, ['button', 'a', 'input', 'span', 'div', 'label']);
        const hit = candidates.find((el) => {
          if (!visible(el)) return false;
          if (!isClickable(el)) return false;
          const v = NORM(el.innerText || el.value || el.textContent);
          return exact ? v === target : v.includes(target);
        });
        if (hit) {
          realClick(hit);
          return true;
        }
      }
      await sleep(300);
    }
    return false;
  }

  // Hash a string -> short stable id (for fallback when ASIN is missing).
  function shortHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h << 5) - h + str.charCodeAt(i);
      h |= 0;
    }
    return `h${(h >>> 0).toString(36)}`;
  }

  window.SNSUtils = {
    NORM,
    visible,
    byText,
    uniq,
    sleep,
    rand,
    waitFor,
    waitForDescriptor,
    realClick,
    isClickable,
    resolve,
    resolveAndClick,
    clickByAnyText,
    shortHash,
  };
})();
