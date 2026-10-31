// Shadow-DOM hosts for everything the extension draws on the page.
//
// v2.1.2: Amazon's global CSS (for example rules on *, div or button) used to
// reach the injected UI and squash the launcher into a wrapped bubble. Each UI
// now lives in an open shadow root on its own host element:
// - the page's selectors can't match anything inside the shadow root;
// - the host's inline `all: initial !important` stops inherited properties
//   (font-size, line-height, white-space…) from flowing in, and beats even
//   `!important` page rules that match the host itself;
// - the stylesheet (ui/styles.js) is applied synchronously, so the first frame
//   is already styled. This matters for content_progress.js, which draws at
//   document_start on every per-item page load.
// Loaded by several content-script entries; safe to load twice.

(function () {
  if (window.SNSHost) return;

  const HOST_STYLE = [
    'all: initial',
    'display: block',
    'position: fixed',
    'top: 0',
    'left: 0',
    'width: 0',
    'height: 0',
    'margin: 0',
    'padding: 0',
    'border: 0',
    'overflow: visible',
    'direction: ltr',
  ].map((d) => `${d} !important`).join('; ');

  let sheet = null; // one parsed stylesheet, shared by every shadow root

  function applyStyles(shadow) {
    const css = window.SNSStyles || '';
    if ('adoptedStyleSheets' in shadow && typeof CSSStyleSheet === 'function' &&
        typeof CSSStyleSheet.prototype.replaceSync === 'function') {
      try {
        if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(css); }
        shadow.adoptedStyleSheets = [sheet];
        return;
      } catch (_) { /* fall back to a <style> element */ }
    }
    const style = document.createElement('style');
    style.textContent = css;
    shadow.appendChild(style);
  }

  // Returns the shadow root of the host with this id, creating the host if
  // needed. Hosts are appended to <html>, outside the page's <body>.
  function attach(id, zIndex) {
    let host = document.getElementById(id);
    if (host && host.shadowRoot) return host.shadowRoot;
    if (host) host.remove(); // not ours (or left by an older version)
    host = document.createElement('sns-ui');
    host.id = id;
    host.setAttribute('style', `${HOST_STYLE}; z-index: ${zIndex} !important`);
    const shadow = host.attachShadow({ mode: 'open' });
    applyStyles(shadow);
    (document.documentElement || document).appendChild(host);
    return shadow;
  }

  window.SNSHost = { attach };
})();
