// The injected UI stylesheet, loaded into each shadow root by ui/host.js.
// Kept in a script (not a .css file) so it is applied synchronously, with no
// unstyled flash and no web_accessible_resources.
(function () {
  if (window.SNSStyles) return;
  window.SNSStyles = `
/* ============================================================
   Subscription Bulk Canceller: injected UI (v2.1.2)
   Calm and compact: white surfaces, one accent (red) reserved for
   "will cancel" and destructive actions, 4/8/12/16 px spacing.

   This stylesheet lives inside the shadow roots created by ui/host.js,
   so the page's CSS can't reach our elements and ours can't leak out.
   Inherited properties are cut off at the host (all: initial), and
   .sns-ui sets every inherited text property explicitly.
   ============================================================ */

*, *::before, *::after { box-sizing: border-box; }

.sns-ui {
  --surface: #ffffff;
  --surface-2: #f6f7f8;
  --surface-3: #eceef1;
  --border: #e2e5e9;
  --border-strong: #c9ced5;
  --text: #191c20;
  --text-2: #4f5761;   /* 7.4:1 on white */
  --text-3: #66707b;   /* 5.0:1 on white, the lightest text colour used */
  --red: #c4382a;      /* 5.2:1 with white text */
  --red-deep: #a32c20;
  --red-soft: #fcefed;
  --red-border: #f0c9c3;
  --amber: #8a5d00;
  --amber-soft: #fdf3dd;
  --green: #1b7342;
  --green-soft: #e8f4ed;
  --focus: #2563eb;
  --radius: 12px;
  --shadow-lg: 0 18px 48px -12px rgba(16, 20, 28, 0.28), 0 4px 12px -4px rgba(16, 20, 28, 0.10);
  --shadow-md: 0 8px 24px -8px rgba(16, 20, 28, 0.25), 0 2px 6px -2px rgba(16, 20, 28, 0.10);

  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, sans-serif;
  font-size: 14px;
  font-weight: 400;
  font-style: normal;
  line-height: 1.45;
  color: var(--text);
  text-align: left;
  text-indent: 0;
  text-transform: none;
  letter-spacing: normal;
  word-spacing: normal;
  white-space: normal;
  direction: ltr;
  visibility: visible;
  cursor: auto;
  -webkit-font-smoothing: antialiased;
}

/* Reset UA styles. :where() keeps specificity at zero. */
:where(button, input, select, label, span, div, p, h1, h2, h3, ul, ol, li, strong, em, a, details, summary, section) {
  font: inherit;
  color: inherit;
  letter-spacing: 0;
  margin: 0;
  padding: 0;
  text-transform: none;
  text-shadow: none;
  list-style: none;
}
:where(strong) { font-weight: 600; }
:where(em) { font-style: normal; font-weight: 600; }
:where(button) {
  cursor: pointer;
  background: transparent;
  border: 0;
}

:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.sns-card__title:focus, .sns-modal:focus { outline: none; }

.sns-sr {
  position: absolute !important;
  width: 1px; height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* ============================================================
   Launcher: the default, collapsed state
   Fixed to the viewport and sized by its own content, so neither the
   host nor the page can squash it into a wrapped bubble.
   ============================================================ */
.sns-launcher {
  position: fixed;
  right: 16px;
  bottom: 16px;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  width: max-content;
  max-width: none;
  height: auto;
  margin: 0;
  padding: 6px 12px 6px 6px;
  white-space: nowrap;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  box-shadow: var(--shadow-md);
  text-align: left;
  transition: box-shadow 160ms, border-color 160ms;
}
.sns-launcher:hover { border-color: var(--border-strong); box-shadow: var(--shadow-lg); }
.sns-launcher__icon {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--red);
  color: #ffffff;
}
.sns-launcher__icon svg { width: 17px; height: 17px; }
.sns-launcher__body { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.sns-launcher__name { font-size: 11.5px; font-weight: 600; color: var(--text-3); }
.sns-launcher__text {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
}
.sns-launcher__chev { color: var(--text-3); display: grid; place-items: center; }
.sns-launcher__chev svg { width: 16px; height: 16px; }

/* ============================================================
   Review panel: a floating card the user opens
   ============================================================ */
.sns-card {
  position: fixed;
  right: 16px;
  bottom: 16px;
  width: 380px;
  max-width: calc(100vw - 32px);
  height: min(640px, calc(100vh - 32px));
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  animation: sns-rise 180ms cubic-bezier(0.2, 0.7, 0.2, 1) both;
}
@keyframes sns-rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.sns-card__header {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 14px 12px 12px 16px;
  border-bottom: 1px solid var(--border);
}
.sns-card__heading { flex: 1; min-width: 0; }
.sns-card__title { font-size: 15px; font-weight: 700; line-height: 1.3; }
.sns-card__subtitle {
  margin-top: 2px;
  font-size: 13px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.sns-num--cancel { color: var(--red); font-weight: 700; }
.sns-num--keep { color: var(--green); font-weight: 700; }

.sns-iconbtn {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 8px;
  color: var(--text-2);
  font-size: 14px;
  font-weight: 700;
  transition: background 140ms, color 140ms;
}
.sns-iconbtn:hover { background: var(--surface-3); color: var(--text); }
.sns-iconbtn svg { width: 16px; height: 16px; }
.sns-iconbtn[aria-expanded="true"] { background: var(--surface-3); color: var(--text); }

/* How it works */
.sns-how {
  margin: 12px 16px 0;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--surface-2);
  border: 1px solid var(--border);
}
.sns-how[hidden] { display: none; }
.sns-how__title { font-size: 12px; font-weight: 700; color: var(--text-2); margin-bottom: 8px; }
.sns-how__steps { counter-reset: sns-step; display: grid; gap: 8px; }
.sns-how__steps li {
  counter-increment: sns-step;
  position: relative;
  padding-left: 28px;
  font-size: 13px;
  line-height: 1.45;
  color: var(--text-2);
}
.sns-how__steps li strong { color: var(--text); }
.sns-how__steps li::before {
  content: counter(sns-step);
  position: absolute;
  left: 0;
  top: 0;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--text);
  color: #ffffff;
  font-size: 11.5px;
  font-weight: 700;
  display: grid;
  place-items: center;
}
.sns-how .sns-btn { margin-top: 10px; }

/* Controls: filter + search + bulk */
.sns-card__controls {
  display: grid;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.sns-seg {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  padding: 3px;
  border-radius: 9px;
  background: var(--surface-3);
}
.sns-filter {
  min-width: 0;
  padding: 5px 6px;
  border-radius: 7px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}
.sns-filter:hover { color: var(--text); }
.sns-filter--active,
.sns-filter--active:hover {
  background: var(--surface);
  color: var(--text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(16, 20, 28, 0.12);
}
.sns-card__row { display: flex; gap: 6px; align-items: center; }
#sns-search {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
  outline: none;
}
#sns-search::placeholder { color: var(--text-3); }
#sns-search:focus { border-color: var(--focus); box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14); }
.sns-chipbtn {
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-2);
  white-space: nowrap;
}
.sns-chipbtn:hover { color: var(--text); border-color: var(--border-strong); background: var(--surface-2); }

/* Scan status strip */
.sns-scan-note {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--amber-soft);
  color: var(--amber);
  font-size: 12.5px;
  font-weight: 500;
}
.sns-scan-note[hidden] { display: none; }
.sns-scan-note--error { background: var(--red-soft); color: var(--red-deep); }
.sns-scan-note--error .sns-spinner { display: none; }

/* List */
.sns-card__list {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--border-strong) transparent;
}

.sns-item {
  display: grid;
  grid-template-columns: 40px 1fr auto;
  gap: 12px;
  align-items: center;
  padding: 10px 16px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  transition: background 120ms;
}
.sns-item:last-child { border-bottom: 0; }
.sns-item:hover { background: var(--surface-2); }
.sns-item:focus-visible { outline-offset: -2px; }
.sns-item:not(.sns-item--kept) { background: var(--red-soft); }
.sns-item:not(.sns-item--kept):hover { background: #f9e3e0; }

.sns-item__thumb {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  background: #ffffff;
  border: 1px solid var(--border);
  overflow: hidden;
  display: grid;
  place-items: center;
}
.sns-item__thumb img { width: 100%; height: 100%; object-fit: contain; }
.sns-item__thumb--placeholder { color: var(--text-3); width: 18px; height: 18px; }
.sns-item__body { min-width: 0; }
.sns-item__title {
  font-size: 13.5px;
  font-weight: 500;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.sns-item__meta {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-2);
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
}
.sns-warn { color: var(--amber); font-weight: 600; }

/* The row's choice, in words */
.sns-choice {
  min-width: 62px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  text-align: center;
  border: 1px solid var(--border-strong);
  color: var(--text-2);
  background: var(--surface);
}
.sns-item:not(.sns-item--kept) .sns-choice { background: var(--red); border-color: var(--red); color: #ffffff; }
.sns-choice__cancel { display: none; }
.sns-item:not(.sns-item--kept) .sns-choice__keep { display: none; }
.sns-item:not(.sns-item--kept) .sns-choice__cancel { display: inline; }

.sns-list-empty { padding: 24px 16px; color: var(--text-2); font-size: 13px; }

/* Footer */
.sns-card__footer {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}

.sns-btn {
  height: 38px;
  padding: 0 14px;
  border-radius: 9px;
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap;
  border: 1px solid transparent;
  transition: background 140ms, color 140ms, border-color 140ms;
}
.sns-btn--sm { height: 30px; padding: 0 12px; font-size: 12.5px; }
.sns-btn--ghost { color: var(--text-2); border-color: var(--border); background: var(--surface); font-weight: 500; }
.sns-btn--ghost:hover { color: var(--text); border-color: var(--border-strong); background: var(--surface-2); }
.sns-btn--primary { flex: 1; background: var(--red); color: #ffffff; }
.sns-btn--primary:hover { background: var(--red-deep); }
.sns-btn--primary:disabled { background: var(--surface-3); color: var(--text-3); }
.sns-btn--danger { background: var(--red); color: #ffffff; }
.sns-btn--danger:hover { background: var(--red-deep); }
.sns-btn:disabled { cursor: not-allowed; }
.sns-btn--ghost:disabled, .sns-btn--danger:disabled { opacity: 0.6; }

/* Empty / error */
.sns-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
}
.sns-empty__icon {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  margin-bottom: 12px;
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--text-3);
}
.sns-empty__icon svg { width: 20px; height: 20px; }
.sns-empty__title { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
.sns-empty__msg { font-size: 13px; color: var(--text-2); max-width: 34ch; }
.sns-empty__action { margin-top: 12px; }
.sns-empty--error .sns-empty__icon { background: var(--red-soft); color: var(--red); }

/* Loading */
.sns-spinner {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  display: inline-block;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  vertical-align: -2px;
  animation: sns-spin 700ms linear infinite;
}
.sns-spinner--light { color: #ffffff; margin-right: 8px; }
@keyframes sns-spin { to { transform: rotate(360deg); } }

.sns-skeleton { flex: 1; overflow: hidden; }
.sns-skeleton__row {
  display: grid;
  grid-template-columns: 40px 1fr;
  gap: 12px;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
}
.sns-skeleton__thumb, .sns-skeleton__lines > div {
  background: linear-gradient(90deg, var(--surface-3) 0%, var(--surface-2) 50%, var(--surface-3) 100%);
  background-size: 200% 100%;
  animation: sns-shimmer 1.3s ease-in-out infinite;
}
.sns-skeleton__thumb { width: 40px; height: 40px; border-radius: 8px; }
.sns-skeleton__lines > div { height: 10px; width: 70%; border-radius: 5px; }
.sns-skeleton__lines > div + div { margin-top: 8px; width: 35%; }
@keyframes sns-shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }

/* ============================================================
   Confirm dialog
   ============================================================ */
.sns-modal-root {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: grid;
  place-items: center;
}
.sns-modal-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(15, 18, 24, 0.45);
  animation: sns-fade 160ms ease-out;
}
@keyframes sns-fade { from { opacity: 0; } to { opacity: 1; } }
.sns-modal {
  position: relative;
  width: min(520px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
  animation: sns-rise 180ms cubic-bezier(0.2, 0.7, 0.2, 1);
}
.sns-modal__header { padding: 20px 20px 12px; }
.sns-modal__title { font-size: 19px; font-weight: 700; line-height: 1.3; }
.sns-modal__lede { margin-top: 4px; font-size: 14px; color: var(--text-2); }
.sns-modal__body {
  display: grid;
  gap: 14px;
  padding: 0 20px 16px;
  overflow-y: auto;
}
.sns-modal__how {
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--surface-2);
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-2);
}
.sns-modal__how strong { color: var(--text); }
.sns-modal__section-label { font-size: 12.5px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
.sns-modal__list {
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
}
.sns-modal__list-item {
  display: grid;
  grid-template-columns: 28px 1fr;
  gap: 10px;
  align-items: center;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
}
.sns-modal__list-item:last-child { border-bottom: 0; }
.sns-modal__list-item img, .sns-modal__noimg {
  width: 28px; height: 28px;
  object-fit: contain;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #ffffff;
}
.sns-modal__list-item-title { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sns-modal__kept summary { cursor: pointer; font-size: 12.5px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; list-style: revert; }
.sns-modal__list--keep { max-height: 140px; }
.sns-field__label { display: block; font-size: 12.5px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
.sns-select {
  appearance: none;
  width: 100%;
  height: 38px;
  padding: 0 34px 0 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2366707b' d='M2 4l4 4 4-4z'/%3E%3C/svg%3E") no-repeat right 12px center;
  font-size: 13.5px;
  color: var(--text);
}
.sns-select:focus { outline: none; border-color: var(--focus); box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14); }
.sns-modal__error {
  padding: 10px 12px;
  border-radius: 9px;
  border: 1px solid var(--red-border);
  background: var(--red-soft);
  color: var(--red-deep);
  font-size: 13px;
}
.sns-modal__error[hidden] { display: none; }
.sns-modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--border);
}

/* ============================================================
   Progress card and finish summary
   No entrance animation: the card is restored from saved state on
   every per-item page load and must look continuous.
   ============================================================ */
.sns-progress {
  position: fixed;
  right: 16px;
  bottom: 16px;
  width: 340px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}
.sns-progress__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px 2px;
}
.sns-progress__dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--red);
  animation: sns-pulse 1.6s ease-in-out infinite;
}
.sns-progress__dot--paused { background: var(--amber); animation: none; }
.sns-progress__dot--done { background: var(--green); animation: none; }
@keyframes sns-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.sns-progress__label { flex: 1; font-size: 13px; font-weight: 600; color: var(--text-2); }
.sns-progress__count { font-size: 13px; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
.sns-progress__title {
  padding: 2px 16px 10px;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.sns-progress__bar { height: 6px; margin: 0 16px; border-radius: 3px; background: var(--surface-3); overflow: hidden; position: relative; }
.sns-progress__bar-fill { position: absolute; inset: 0 auto 0 0; background: var(--red); border-radius: 3px; transition: width 300ms ease-out; }
.sns-progress__meta { padding: 8px 16px 0; font-size: 12.5px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.sns-progress__note { padding: 4px 16px 0; font-size: 12.5px; color: var(--text-3); }
.sns-progress__note--warn { color: var(--amber); font-weight: 500; }
.sns-progress__body { display: grid; gap: 6px; padding: 0 16px; overflow-y: auto; min-height: 0; }
.sns-progress__link { display: inline-block; margin-top: 4px; font-size: 13px; font-weight: 600; color: var(--focus); text-decoration: underline; text-underline-offset: 2px; }
.sns-progress__controls {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
.sns-progress__controls button {
  flex: 1;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  color: var(--text-2);
  background: var(--surface);
}
.sns-progress__controls button:hover { color: var(--text); border-color: var(--border-strong); background: var(--surface-2); }
.sns-progress__controls button.sns-danger { color: var(--red-deep); border-color: var(--red-border); }
.sns-progress__controls button.sns-danger:hover { background: var(--red-soft); }
.sns-progress__controls button.sns-primary { background: var(--text); border-color: var(--text); color: #ffffff; font-weight: 600; }
.sns-progress__controls button:disabled { opacity: 0.5; cursor: not-allowed; }

.sns-sum summary { cursor: pointer; padding: 4px 0; font-size: 13px; font-weight: 600; color: var(--text); list-style: revert; }
.sns-sum__list { max-height: 120px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 4px; }
.sns-sum__list li { padding: 6px 10px; border-bottom: 1px solid var(--border); font-size: 12.5px; }
.sns-sum__list li:last-child { border-bottom: 0; }
.sns-sum__name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sns-sum__why { display: block; color: var(--red-deep); font-size: 12px; margin-top: 2px; }
.sns-sum__list--ok li { box-shadow: inset 3px 0 0 var(--green); }
.sns-sum__list--fail li { box-shadow: inset 3px 0 0 var(--red); background: var(--red-soft); }
.sns-sum__list--keep li { box-shadow: inset 3px 0 0 var(--border-strong); }
.sns-sum__list--skip li { box-shadow: inset 3px 0 0 var(--amber); }

@media (prefers-reduced-motion: reduce) {
  .sns-card, .sns-modal, .sns-modal-backdrop { animation: none; }
  .sns-skeleton__thumb, .sns-skeleton__lines > div, .sns-progress__dot { animation: none; }
  .sns-progress__bar-fill { transition: none; }
  .sns-spinner { animation-duration: 1.6s; }
}
`;
})();
