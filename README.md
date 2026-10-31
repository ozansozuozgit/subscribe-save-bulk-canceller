# Subscription Bulk Canceller

A Chrome extension for reviewing and bulk-cancelling your Amazon Subscribe & Save subscriptions. Amazon only lets you cancel one subscription at a time, with several confirmation screens for each. This extension turns that into one reviewed batch that you start and watch yourself, on your own account.

Not affiliated with, endorsed by, or sponsored by Amazon. Amazon and Subscribe & Save are trademarks of Amazon.com, Inc. or its affiliates.

## How it works

1. **Pick what to keep.** Open your Subscribe & Save page. A small launcher appears in the bottom-right corner; click it to open the list. Everything starts as **Keep**. Click an item to switch it to **Cancel**.
2. **Review and confirm.** The confirm step says exactly what will happen, for example "Cancel 5 subscriptions, keep 3. You can pause anytime.", and lists every item.
3. **It cancels the rest, one at a time.** At a human pace (a 2–5 second pause between items by default), using Amazon's own Edit and Cancel buttons. A small progress card shows the current item, "3 of 5" and the time left, with **Pause**, **Skip item** and **Stop**. When it finishes, the card lists what was cancelled, what was kept and anything that failed, with a link to Amazon's page to double-check.

The first time you open the panel it shows these three steps. Click **Got it** to hide them, or **?** in the panel header to see them again.

## What it does

- **Stays out of the way.** On the Subscribe & Save page it shows only a small launcher ("8 subscriptions · Review"). The panel opens when you click it, and the extension remembers whether you left it open or closed.
- **Scans** your Subscribe & Save manager page and lists every active subscription with its image, title, and next delivery date, including items behind "load more" buttons and on extra pages.
- **Review panel**: a compact card where each item says **Keep** or **Cancel** in words. Search, show all / to cancel / to keep, and set everything to Cancel or Keep at once.
- **Confirms before acting.** The confirm step lists what will be cancelled and what will be kept, and lets you pick an optional reason to give Amazon.
- **Cancels one at a time** with a short random pause between items, using Amazon's own cancellation flow (Edit dialog, reason, confirm). The progress card stays put while the page reloads for each item, and shows pause / skip / stop controls.
- **Clear finish summary.** Cancelled, kept and failed items are listed when the run ends. The review panel stays closed until you press **Done**, so nothing covers the summary.
- **Safe failure handling.** The batch pauses at the first unexpected response or navigation failure. Resume can reopen a closed cancellation tab. Unconfirmed attempts stay in the saved history, so check Amazon before retrying them.
- **Saved choices and history.** Keep/cancel decisions survive reloads, rescans, and browser restarts. Failed attempts stay selected for retry, and confirmed cancellations are never retried. New or ambiguous subscriptions default to Keep. You can back up and restore your choices from the popup.

Nothing leaves your browser: no external servers, analytics, or accounts. The extension only talks to `www.amazon.com`, using your existing session. See the privacy policy in the store listing.

## Loading, errors and recovery

- While it scans, the launcher says "Finding your subscriptions…" and the open panel shows placeholder rows and a live status: "Loading your subscriptions… (page 2, 8 found)", then "Loading product images…" and "Saving N subscriptions…". The list appears once, already marked with your saved keep/cancel choices.
- If the scan fails, or the page lost contact with the extension (for example because it was reloaded or updated), the panel says so and offers **Try again**. An empty result offers **Scan again**.
- **Cancel N now** shows a spinner and is disabled while the run starts. Your latest choices are saved before the run begins.
- Keep/cancel clicks are saved together after a short pause (150 ms), and immediately when you start a run or leave the page.
- If Chrome restarts the extension's background worker between two items (extension reloaded or updated mid-run, or a long pause setting), the run is set to **Paused** with a note, and **Resume** continues from the next item. An item already in progress is left alone; its tab still reports the result.
- The popup reads its saved state once, before drawing, and offers **Try again** if the background can't be reached.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Saves your choices, run progress, history and settings in `chrome.storage.local` (never synced or uploaded). |
| `notifications` | One local notification when a run finishes. |
| Host `https://www.amazon.com/*` | Lets the popup reuse an open Amazon tab and the background script move the run's tab to the next subscription. Chrome ignores paths in host permissions, so this is the narrowest form. |
| Content scripts | Run only on `/gp/subscribe-and-save/*` and `/auto-deliveries*` pages. The progress card loads at the start of the page (`document_start`) so it can be redrawn immediately on each item's page load. |

No `tabs`, `scripting`, remote code, or eval.

## Install

1. Download `sns-bulk-canceller.zip` from the [latest release](https://github.com/ozansozuozgit/subscribe-save-bulk-canceller/releases/latest) and unzip it.
2. Open `chrome://extensions` in Chrome (or any Chromium browser).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder.
5. Click the extension icon, then **Open my Subscribe & Save page**. Click the launcher in the bottom-right corner of that page to review your subscriptions.

To work on the code instead, clone this repo and load the repo folder the same way.

## Settings

The options page lets you set:

- **Default cancellation reason**: pre-selects the reason Amazon asks for on every cancellation.
- **Pacing**: the random delay range between cancellations. The default is 2,000–5,000 ms, defined once in `state.js` (`SNSState.DEFAULT_OPTIONS`) and used both by a fresh install and by **Restore defaults**. Existing installs keep whatever value they already saved until you click **Restore defaults**.

## Updating and checking

After changing these files, click **Reload** on this extension in `chrome://extensions`, then reload the subscriptions page. Don't remove and reinstall it: removing the extension deletes Chrome's extension storage. The first 2.1 scan preserves old choices and migrates legacy text IDs to Amazon subscription IDs. Identical subscriptions that can't be mapped safely show **Review needed** and stay kept.

The popup's **Backup & restore** section has **Download a backup**, which downloads a local JSON backup, including the original recovered selection. It contains product names and subscription IDs, so keep it private. **Restore choices** accepts that JSON and never starts cancellations automatically. Restored choices update the open review and survive rescanning, and an older backup can't undo a recorded cancellation.

Run `npm ci && npm test` for the scanner, persistence, settings, popup, rendering/loading-state and cancellation regression tests. Tests use synthetic subscription data and never contact Amazon. GitHub runs these tests and JavaScript syntax checks on every push and pull request.

## Packaging for the Chrome Web Store

Zip only the extension files: `manifest.json`, `*.js`, `*.html`, `ui/`, `icons/`, `LICENSE`. Leave out `tests/`, `node_modules/`, `package*.json`, `.github/`, `private/`, `CHANGES.md` and this README. From the repo root:

```sh
zip -X -r sns-bulk-canceller.zip LICENSE manifest.json *.js *.html icons ui
``` The manifest `description` must stay at 132 characters or fewer.

## Notes & disclaimers

- Amazon can change its page structure at any time, which may break scanning or cancellation until selectors are updated.
- The extension clicks through Amazon's own cancellation UI on your behalf, so review the confirmation list carefully before starting a run. Cancelled subscriptions may need to be re-created manually.
- Currently targets `www.amazon.com` (US) only. Other locales would need new `manifest.json` match patterns and possibly selector updates. PRs welcome.

## License

[MIT](LICENSE)
