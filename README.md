# Subscribe & Save — Bulk Canceller

A Chrome extension for reviewing and bulk-cancelling Amazon Subscribe & Save subscriptions. Amazon only lets you cancel one subscription at a time, through several confirmation screens each; this extension turns that into a single reviewed batch.

## What it does

- **Scans** your Subscribe & Save manager page and lists every active subscription with its image, title, and next delivery date — including items behind "load more" buttons and extra pages.
- **Review panel** slides in on the right: search, filter (all / cancel / keep / next delivery), sort, and toggle each item to keep or cancel. Bulk actions: cancel all, keep all, invert.
- **Confirms before acting** — a summary modal shows exactly what will be cancelled and lets you pick an optional cancellation reason.
- **Cancels one at a time** with human-like pacing, driving Amazon's own cancellation flow (edit page → reason → confirm). A floating progress panel shows live status with pause / skip / stop controls.
- **Safe failure handling** — items that fail to cancel are left untouched and listed in the popup so you can finish them manually.

Nothing leaves your browser: no external servers, no analytics, no accounts. The extension talks only to `amazon.com` using your existing session.

## Install (unpacked)

1. Download or clone this repo.
2. Open `chrome://extensions` in Chrome (or any Chromium browser).
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.
5. Click the extension icon, then **Open subscriptions page** — the review panel appears on your Subscribe & Save manager page.

## Settings

The options page lets you set:

- **Default cancellation reason** — pre-selects the reason Amazon asks for on every cancellation.
- **Pacing** — the random delay range between cancellations (default 2,000–5,000 ms).

## Notes & disclaimers

- Not affiliated with or endorsed by Amazon. Amazon can change its page structure at any time, which may break scanning or cancellation until selectors are updated.
- The extension clicks through Amazon's own cancellation UI on your behalf — review the confirmation list carefully before starting a run. Cancelled subscriptions may need to be re-created manually.
- Currently targets `www.amazon.com` (US). Other locales would need `manifest.json` host patterns and possibly selector updates — PRs welcome.

## License

[MIT](LICENSE)
