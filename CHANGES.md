# Changes

## 2.1.2

Calmer, clearer UI, and three bug fixes. Scanning, cancellation, queue and storage logic are unchanged:
`scan.js`, `selectors.js`, `utils.js`, `content_cancel.js`, `state.js` and `bg.js` are untouched.
Permissions and match patterns are unchanged.

### Bug fixes
- **The finish summary was hidden behind the review sidebar.** When a run ended, the review panel came back and covered
  "Finished — N cancelled" and its buttons. Now a run owns the screen until you press **Done**: while the
  progress card or finish summary is showing, the review panel stays closed (`content_manager.js`, `RUN_OWNS_SCREEN`).
  After **Done**, the page is rescanned and the panel comes back as you left it. Reloading the page during that time
  keeps the summary instead of replacing it with a rescan.
- **The minimized pill was squashed and covered Rescan.** It sat inside a zero-width fixed root, so its text wrapped into a
  narrow bubble, and it overlapped the progress card. The pill is replaced by a launcher button that positions itself against
  the viewport and never wraps, and it is hidden whenever the progress card is shown.
- **Page CSS could restyle the extension's UI** (on Amazon the launcher rendered as a tall oval with its text on 4 lines).
  The UI was injected into the page's DOM with a page-level stylesheet, so Amazon's global rules (on `*`, `div`, `button`,
  inherited font sizes and line heights) applied to it. All injected UI (launcher, review panel, confirm dialog, progress card,
  finish summary) now lives in open shadow roots on two host elements (`ui/host.js`). Each host has inline
  `all: initial !important` plus fixed positioning, so nothing is inherited from the page and page rules that match the host
  itself lose. The stylesheet moved from `ui/panel.css` to `ui/styles.js` and is adopted into each shadow root synchronously,
  so the progress card is still fully styled from its first frame at `document_start`. The manifest no longer injects CSS
  into the page. The launcher is `width: max-content` and slightly slimmer (46 px tall).
- **"Rescan" on the finish summary did nothing.** It reloaded the page, but a finished run keeps the summary on screen, so
  the summary just came back. It now clears the finished run first, then reloads, and the page scans again.
- **A confirm dialog closed from another tab left its key handler behind.** When choices changed elsewhere, the dialog was
  removed but its `keydown` listener stayed, so every later Escape on the page moved focus to the panel footer. The dialog
  is now closed the same way in every case (also when a run takes over the screen).
- **Progress card accessibility.** Updates replace the card's markup, which dropped keyboard focus (Pause turns into
  Resume) and recreated the `aria-live` element, so changes weren't reliably announced. Focus now returns to the matching
  control, and a persistent status region announces the current item, pauses and the final result.
- **The progress card flickered on every item.** Each item is a full page load. The card was drawn 400 ms after the page was
  ready, with a fade/slide-in each time. `content_progress.js` now runs at `document_start` (its own content-script entry
  with the same match patterns), draws straight from `chrome.storage.local`, has no entrance animation, and only touches the
  DOM when the markup changes.

### Less intrusive, easier to follow
- **Starts as a small launcher** in the bottom-right corner ("8 subscriptions · Review") instead of a full-height sidebar.
  The panel opens as a compact floating card. Open/closed is remembered in `chrome.storage.local` (`sns_ui`).
- **"How it works"**: three steps shown the first time the panel opens (pick what to keep; review and confirm; it cancels
  the rest one at a time, at a human pace, and you can pause anytime). **Got it** hides it for good; **?** in the header
  reopens it.
- **Review panel**: one summary line ("8 subscriptions · 5 to cancel · 3 to keep"), a three-way filter
  (All / To cancel / To keep), search, **Cancel all** / **Keep all**, and each row says **Keep** or **Cancel** in words.
  Removed the Invert and Sort buttons and the "Next" filter and badges to cut noise (the list is sorted by next delivery).
- **Confirm step** states exactly what will happen: "Cancel 5 subscriptions, keep 3." / "You can pause anytime.", what
  the extension will do with the pause length from Settings, the items to cancel, the items to keep, and the optional reason.
  Focus moves into the dialog, Tab stays inside it, Escape closes it, and focus returns to the button that opened it.
- **Progress card**: current item, "3 of 5", time left ("About 40 sec left"), counts, "Keep this tab open. You can pause
  anytime.", and **Pause** / **Skip item** / **Stop**.
- **Finish summary**: "5 cancelled, 3 kept." with lists of cancelled, kept, failed (with the reason) and not-done items,
  a **Double-check on Amazon** link (opens the subscriptions page in a new tab), **Rescan** and **Done**.
- **Popup**: plain status lines ("Last run: 5 cancelled, 3 kept"), a "How it works" section, clearer button labels, and
  backup/restore grouped under **Backup & restore**.
- **Settings**: plain labels ("Reason given to Amazon", "Pause between items" with seconds explained), real `<label>`s.
- **Accessibility**: the launcher is a real button with `aria-expanded`; focus moves into the panel when it opens and back to
  the launcher when it closes; each row's accessible name includes its Keep/Cancel state; the progress bar is a
  `progressbar`; lighter text colours were darkened to at least 4.5:1, and the red to 5.2:1 with white text.

### Tests
15 new jsdom regression tests (54 total). The 39 existing tests pass unchanged, except that their harness now opens the
panel first (`openUi()`), because the panel now starts collapsed, and reads the UI through the shadow roots.
`tests/browser.test.cjs` loads the extension into Playwright's Chromium (new headless, or headful under a display) against a
mocked page with hostile global CSS and checks the launcher (one line, bottom-right), panel, confirm dialog, progress
card and finish summary sizes and positions during a real 2-item run. It is skipped with a message if Playwright isn't
installed (`SNS_REQUIRE_BROWSER=1` makes that a failure).
