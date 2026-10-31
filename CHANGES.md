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
10 new regression tests (49 total). The 39 existing tests pass unchanged, except that their harness now opens the
panel first (`openUi()`), because the panel now starts collapsed.
