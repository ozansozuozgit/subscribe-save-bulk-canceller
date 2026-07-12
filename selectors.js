// Single source of truth for the brittle bits — every Amazon-specific
// selector or button label lives here. When Amazon ships a redesign,
// fix it here and nowhere else.

(function () {
  if (window.__SNS_SELECTORS__) return;
  window.__SNS_SELECTORS__ = true;

  // ---------- Manager page: subscription tiles ----------
  // Each tile is the container for a single subscription row.
  const TILE_CONTAINERS = [
    // Modern auto-deliveries layout
    'div[data-subscription-id]',
    'li[data-subscription-id]',
    // Legacy subscribe-and-save manager
    'div.subscription-row',
    'div[id^="subscription-"]',
    // Defensive: any div that contains an edit link to /auto-deliveries/edit or /gp/subscribe-and-save/manager
    // (handled programmatically in scan.js, not here)
  ];

  // Within a tile, where to find the edit link / product info.
  const TILE_FIELDS = {
    editLinkCss: [
      'a[href*="auto-deliveries/edit"]',
      'a[href*="subscribe-and-save/manager/edit"]',
      'a[href*="subscription/edit"]',
    ],
    titleCss: [
      '[data-csa-c-content-id="subscription-title"]',
      'a[data-asin] span',
      'a[href*="/dp/"]',
      '.a-link-normal[href*="/dp/"]',
      'h2 a',
      'h3 a',
    ],
    imageCss: [
      'img[data-csa-c-content-id="subscription-image"]',
      'a[href*="/dp/"] img',
      'img.product-image',
      'img',
    ],
    nextDateLabels: [
      'next delivery',
      'next order',
      'arriving',
      'delivery date',
    ],
  };

  // ---------- Edit page: cancel button ----------
  // Tried in order. First match wins.
  const CANCEL_BUTTON = [
    { attr: 'data-csa-c-content-id', equals: 'cancel-subscription' },
    { css: 'a[href*="cancel"][href*="subscription"]' },
    { text: ['Cancel subscription', 'Cancel this subscription', 'Cancel auto-delivery', 'End subscription'], requireClickable: true },
    { css: 'button[class*="cancel"]' },
    { css: 'a[class*="cancel"]' },
  ];

  // After clicking cancel, a modal/page appears asking for reason.
  // We need a marker that confirms we're now in the reason step.
  const REASON_STEP_MARKER = [
    { attr: 'data-csa-c-content-id', equals: 'cancellation-reasons' },
    { text: ['Why are you cancelling', 'Why are you canceling', 'Tell us why', 'cancellation reason', 'reason for cancelling', 'reason for canceling'] },
    { css: 'input[type="radio"][name*="reason"]' },
    { css: 'form[action*="cancel"] input[type="radio"]' },
  ];

  // Canonical reason options (deduped — v1 had smart/straight quote duplicates).
  const REASON_OPTIONS = [
    "I don't want this item anymore",
    'Price is too high',
    'Found a better alternative',
    "I'm not using this product",
    'Other',
  ];

  // Reason radio in the DOM — match by label text using REASON_OPTIONS list.
  // Tags include input so radios themselves work; label so wrappers work.
  const REASON_RADIO_TAGS = ['input', 'label', 'span', 'div'];

  // ---------- Confirm button (final "yes, cancel my subscription") ----------
  const CONFIRM_BUTTON = [
    { attr: 'data-csa-c-content-id', equals: 'confirm-cancel' },
    { css: 'input[data-csa-c-slot-id="cancel-subs-modal"]' },
    { text: ['Cancel my subscription', 'Cancel subscription', 'Confirm cancellation', 'Yes, cancel subscription', 'Yes, cancel', 'Confirm', 'Submit'], requireClickable: true },
    { css: 'button[type="submit"][class*="cancel"]' },
  ];

  // ---------- Confirmation success page ----------
  const SUCCESS_MARKER = [
    { attr: 'data-csa-c-content-id', equals: 'cancellation-confirmation' },
    { css: '.a-alert-success' },
    { text: ['Cancellation confirmed', 'has been cancelled', 'has been canceled', 'subscription cancelled', 'subscription canceled', 'successfully cancelled', 'successfully canceled'], tags: ['h1', 'h2', 'h3', 'h4', 'span', 'div', 'p'] },
  ];

  // URL pattern that identifies a "we cancelled" landing page from Amazon.
  // Used to detect end of flow without a DOM marker.
  const SUCCESS_URL_RE = /(cancellation|cancelled|canceled|confirmed|success|thank)/i;

  // URL patterns identifying edit/detail pages we drive.
  // Includes the new AJAX subscription endpoint Amazon now uses on the
  // /auto-deliveries/subscriptionList layout (each tile's "Edit" button links
  // to .../auto-deliveries/ajax/subscription?subscriptionId=...).
  const EDIT_URL_RE = /(auto-deliveries\/edit|auto-deliveries\/ajax\/subscription|auto-deliveries\/cancelSubscription|subscribe-and-save\/manager\/edit|subscription\/edit)/i;

  // The dedicated cancel-confirm step (post-click). When we're here, we should
  // skip step 1 ("click Cancel subscription") entirely and go straight to
  // reason + confirm.
  const CANCEL_CONFIRM_URL_RE = /auto-deliveries\/cancelSubscription/i;

  // Manager pages.
  const MANAGER_URL_RE = /(auto-deliveries\/?(\?|$|subscriptionList)|subscribe-and-save\/manager\/viewsubscriptions)/i;

  window.SNSSelectors = {
    TILE_CONTAINERS,
    TILE_FIELDS,
    CANCEL_BUTTON,
    REASON_STEP_MARKER,
    REASON_OPTIONS,
    REASON_RADIO_TAGS,
    CONFIRM_BUTTON,
    SUCCESS_MARKER,
    SUCCESS_URL_RE,
    EDIT_URL_RE,
    CANCEL_CONFIRM_URL_RE,
    MANAGER_URL_RE,
  };
})();
