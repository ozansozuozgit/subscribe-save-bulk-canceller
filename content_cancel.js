// Drives the cancel flow on a Subscribe & Save edit page.
// Only acts when bg.js reports status === 'running' and we're on the expected URL.
// Each cancellation is a small state machine:
//   1. Click "Cancel subscription" button
//   2. Wait for reason step marker → pick a reason radio
//   3. Click confirm button
//   4. Wait for success marker (DOM or URL) → report itemDone
// Any step that times out reports itemFailed and lets bg.js advance the queue.

(function () {
  if (window.__SNS_CANCEL_BOOTED__) return;
  window.__SNS_CANCEL_BOOTED__ = true;

  const {
    sleep, waitFor, waitForDescriptor, resolve, resolveAndClick,
    byText, visible, realClick, isClickable, NORM,
  } = window.SNSUtils;
  const S = window.SNSSelectors;

  const PER_STEP_TIMEOUT_MS = 6000;
  const SUCCESS_TIMEOUT_MS = 8000;
  const ERROR_TEXTS = [
    'there was a problem loading this action',
    'there was an error processing your request',
  ];

  function hasAmazonError() {
    const body = NORM(document.body.innerText || '');
    return ERROR_TEXTS.some((t) => body.includes(t));
  }

  async function getState() {
    return new Promise((res) => chrome.runtime.sendMessage({ type: 'sns:getState' }, res));
  }
  function report(type, payload = {}) {
    try { chrome.runtime.sendMessage({ type, ...payload }); } catch (_) {}
  }

  function isEditPage() {
    return S.EDIT_URL_RE.test(location.href);
  }
  function isSuccessPage() {
    if (S.SUCCESS_URL_RE.test(location.href)) return true;
    return !!resolve(S.SUCCESS_MARKER[0]) || S.SUCCESS_MARKER.some((d) => !!resolve(d));
  }

  async function selectReason(reasonText) {
    // The new /cancelSubscription page uses a <select> dropdown; the legacy
    // edit flow uses radio inputs. Try the <select> path first, then radios.
    if (await selectReasonInDropdown(reasonText)) return true;
    return await selectReasonInRadios(reasonText);
  }

  async function selectReasonInDropdown(reasonText) {
    const selects = [...document.querySelectorAll('select')].filter(visible);
    for (const sel of selects) {
      // Skip <select>s that don't look like a reason picker.
      const idName = ((sel.id || '') + ' ' + (sel.name || '')).toLowerCase();
      const labelText = NORM([
        sel.getAttribute('aria-label') || '',
        document.querySelector(`label[for="${sel.id}"]`)?.textContent || '',
      ].join(' '));
      const looksLikeReason =
        /reason|cancel/.test(idName) ||
        labelText.includes('reason') ||
        labelText.includes('cancelling') ||
        labelText.includes('canceling');
      if (!looksLikeReason) continue;

      const opts = [...sel.options];
      const wanted = NORM(reasonText);
      const candidates = [wanted, ...S.REASON_OPTIONS.map(NORM)];
      let match = null;
      for (const cand of candidates) {
        if (!cand) continue;
        match = opts.find((o) => NORM(o.text).includes(cand));
        if (match) break;
      }
      // Last resort — pick the first non-empty option.
      if (!match) match = opts.find((o) => o.value && NORM(o.text));
      if (!match) continue;
      sel.value = match.value;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(120);
      return true;
    }
    return false;
  }

  async function selectReasonInRadios(reasonText) {
    const wanted = NORM(reasonText);
    const fallbackList = [reasonText, ...S.REASON_OPTIONS];
    for (const candidate of fallbackList) {
      const hits = byText(document, candidate, S.REASON_RADIO_TAGS);
      const ordered = hits
        .filter((el) => visible(el))
        .map((el) => {
          if (el.tagName === 'INPUT' && el.type === 'radio') return el;
          if (el.tagName === 'LABEL') {
            const id = el.htmlFor;
            const radio = id ? document.getElementById(id) : el.querySelector('input[type=radio]');
            return radio || el;
          }
          const parentLabel = el.closest('label');
          if (parentLabel) {
            const id = parentLabel.htmlFor;
            const radio = id ? document.getElementById(id) : parentLabel.querySelector('input[type=radio]');
            return radio || parentLabel;
          }
          const ancestor = el.closest('div,li,tr,fieldset') || el.parentElement;
          if (ancestor) {
            const radio = ancestor.querySelector('input[type=radio]');
            if (radio) return radio;
          }
          return el;
        });
      if (ordered.length) {
        realClick(ordered[0]);
        await sleep(150);
        return true;
      }
    }
    const anyRadio = [...document.querySelectorAll('input[type=radio]')].find(visible);
    if (anyRadio) {
      realClick(anyRadio);
      await sleep(150);
      return true;
    }
    return false;
  }

  function findConfirmButton() {
    for (const d of S.CONFIRM_BUTTON) {
      const el = resolve(d);
      if (el && isClickable(el)) return el;
    }
    return null;
  }

  async function runCancelFlow(run) {
    const idx = run.currentIndex;
    const item = run.items[idx];
    const startUrl = location.href;
    console.log(`[SNS Cancel] item ${idx + 1}/${run.items.length} on ${location.pathname}`);

    if (isSuccessPage()) {
      report('sns:itemDone');
      return;
    }

    // Page-aware: if we're already on the dedicated cancel-confirm page, skip
    // straight to the reason + confirm step.
    const onCancelConfirmPage = S.CANCEL_CONFIRM_URL_RE.test(location.href);

    if (!onCancelConfirmPage) {
      // Step A — detail page: click the "Cancel subscription" link.
      await sleep(150);
      let cancelEl = await waitFor(() => {
        for (const d of S.CANCEL_BUTTON) {
          const el = resolve(d);
          if (el && isClickable(el)) return el;
        }
        return null;
      }, { timeout: PER_STEP_TIMEOUT_MS, interval: 100 });
      if (!cancelEl) {
        report('sns:itemFailed', { error: 'Cancel link not found on detail page' });
        return;
      }
      realClick(cancelEl);

      // Two outcomes: either the URL changes to /cancelSubscription, or a
      // confirm form appears inline. Whichever happens first wins.
      const transitioned = await waitFor(
        () => S.CANCEL_CONFIRM_URL_RE.test(location.href) || findConfirmButton() || hasAmazonError(),
        { timeout: PER_STEP_TIMEOUT_MS, interval: 120 }
      );
      if (!transitioned) {
        report('sns:itemFailed', { error: 'Cancel click did not lead anywhere' });
        return;
      }
      if (hasAmazonError()) {
        // One quick retry.
        await sleep(700);
        cancelEl = resolveAndClick(S.CANCEL_BUTTON);
        await waitFor(
          () => S.CANCEL_CONFIRM_URL_RE.test(location.href) || findConfirmButton(),
          { timeout: PER_STEP_TIMEOUT_MS, interval: 120 }
        );
      }
    }

    // Step B — confirm page: optionally pick a reason, then click confirm.
    // The new layout marks reason as Optional, so skipping is always fine.
    const wantReason = typeof run.reason === 'string' && run.reason.trim().length > 0;
    if (wantReason) {
      // Give the form a brief moment to mount.
      await waitFor(
        () => document.querySelector('select, input[type="radio"]'),
        { timeout: 2000, interval: 100 }
      );
      await selectReason(run.reason);
    }

    const confirmEl = await waitFor(findConfirmButton, { timeout: PER_STEP_TIMEOUT_MS, interval: 100 });
    if (!confirmEl) {
      report('sns:itemFailed', { error: 'Confirm button not found on cancel page' });
      return;
    }
    realClick(confirmEl);

    // Some flows surface a secondary confirm dialog right after.
    await sleep(350);
    const secondary = findConfirmButton();
    if (secondary && secondary !== confirmEl) realClick(secondary);

    // Step C — wait for success: URL change away from edit/cancel URLs, or
    // an in-DOM success marker.
    const ok = await waitFor(() => {
      if (isSuccessPage()) return true;
      if (location.href !== startUrl && !S.EDIT_URL_RE.test(location.href)) return true;
      return false;
    }, { timeout: SUCCESS_TIMEOUT_MS, interval: 150 });
    if (!ok) {
      report('sns:itemFailed', { error: 'Success confirmation never appeared' });
      return;
    }
    report('sns:itemDone');
  }

  async function maybeRun() {
    const run = await getState();
    if (!run || run.status !== 'running') return;
    if (run.currentIndex < 0 || !run.items[run.currentIndex]) return;

    // Confirmation landings (after a navigation triggered by Amazon itself) — just report done
    if (isSuccessPage() && !isEditPage()) {
      console.log('[SNS Cancel] success landing detected on', location.href);
      await sleep(600);
      report('sns:itemDone');
      return;
    }

    // Only drive the flow on edit pages
    if (!isEditPage()) return;

    try {
      await runCancelFlow(run);
    } catch (err) {
      console.error('[SNS Cancel] uncaught', err);
      report('sns:itemFailed', { error: String(err?.message || err) });
    }
  }

  // Re-evaluate shortly after document_idle. The AJAX subscription pages we
  // drive are mostly server-rendered, so this can be tight without races.
  setTimeout(maybeRun, 400);
})();
