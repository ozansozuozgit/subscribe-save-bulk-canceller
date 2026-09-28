// Cancel only the assigned subscription in the assigned tab, once per attempt.
(function () {
  if (window.__SNS_CANCEL_BOOTED__) return;
  window.__SNS_CANCEL_BOOTED__ = true;
  const { waitFor, visible, realClick, NORM } = window.SNSUtils;
  const S = window.SNSSelectors;
  const msg = (type, payload = {}) => new Promise(resolve =>
    chrome.runtime.sendMessage({ type, ...payload }, resolve));

  function cancellationForm(item) {
    return [...document.querySelectorAll('form')].find(form => {
      try {
        const url = new URL(form.action, location.href);
        const sid = url.searchParams.get('subscriptionId') || form.querySelector('[name="subscriptionId"]')?.value;
        return url.origin === location.origin && /cancelSubscriptionAction/i.test(url.pathname) && sid === item.subscriptionId && visible(form);
      } catch (_) { return false; }
    });
  }

  function successVisible() {
    const phrases = /(?:subscription (?:has been |was |is now )?(?:cancelled|canceled)|(?:cancelled|canceled) your subscription|cancellation confirmed)/i;
    return [...document.querySelectorAll('h1,h2,h3,h4,p,.a-alert-content,[data-csa-c-content-id="cancellation-confirmation"]')]
      .some(el => !el.closest('#sns-root,#sns-modal,#sns-progress-root') && visible(el) && phrases.test(el.textContent));
  }

  function selectReason(form, requested) {
    if (!requested) return;
    const aliases = {
      "i don't want this item anymore": 'i no longer use this product',
      "i'm not using this product": 'i no longer use this product',
      'price is too high': 'this product is too expensive',
      'found a better alternative': 'i want a different flavor/brand/scent',
    };
    const wanted = aliases[NORM(requested)] || NORM(requested);
    const select = form.querySelector('select[name*="cancellation"],select[name*="reason"],select[id*="reason"]');
    if (select) {
      const option = [...select.options].find(option => NORM(option.textContent) === wanted);
      // Reason is optional: never silently pick an unrelated answer.
      if (!option) return;
      select.value = option.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  async function openForm(item, identity) {
    const findTile = () => [...document.querySelectorAll('[data-edit-url]')].find(tile => {
      const url = new URL(tile.getAttribute('data-edit-url'), location.origin);
      return url.origin === location.origin && url.searchParams.get('subscriptionId') === item.subscriptionId && visible(tile);
    });
    await waitFor(() => document.querySelector('[data-edit-url]'), { timeout: 12000 });
    let tile = findTile();
    for (let page = 0; !tile && page < 20; page++) {
      const sentinel = document.querySelector('#endOfGridDesktop[data-next-url],#endOfGridMobile[data-next-url]');
      if (!sentinel?.getAttribute('data-next-url')) break;
      const count = document.querySelectorAll('[data-edit-url]').length;
      sentinel.scrollIntoView({ block: 'center' });
      await waitFor(() => findTile() || document.querySelectorAll('[data-edit-url]').length > count, { timeout: 10000 });
      tile = findTile();
    }
    if (!tile) throw new Error('This subscription was not found in the active list. Check whether it was already cancelled.');
    if (!(await msg('sns:authorizeStep', identity))?.ok) return null;
    const edit = tile.querySelector('[data-edit-link]');
    if (!edit) throw new Error('The subscription Edit control is missing.');
    realClick(edit);
    const cancelLink = await waitFor(() => [...document.querySelectorAll('[role="dialog"] a[href]')].find(link => {
      const url = new URL(link.href, location.origin);
      return visible(link) && url.origin === location.origin && url.pathname === '/auto-deliveries/cancelSubscription' && url.searchParams.get('subscriptionId') === item.subscriptionId;
    }), { timeout: 12000 });
    if (!cancelLink) throw new Error('Cancel subscription was not found in the selected item’s dialog.');
    if (!(await msg('sns:authorizeStep', identity))?.ok) return null;
    realClick(cancelLink);
    return await waitFor(() => cancellationForm(item), { timeout: 12000 });
  }

  async function maybeRun() {
    const run = await msg('sns:getState');
    const item = run?.items?.[run.currentIndex];
    if (run?.status !== 'running' || item?.status !== 'inflight') return;
    const identity = { itemId: item.id, runId: run.runId, attempt: item.attempts };
    if (!(await msg('sns:authorizeStep', identity))?.ok) return;
    const fail = error => msg('sns:itemFailed', { ...identity, error });
    if (item.phase === 'confirming' && location.pathname.startsWith('/auto-deliveries/')) {
      const confirmed = await waitFor(successVisible, { timeout: 12000, interval: 150 });
      if (confirmed) await msg('sns:itemDone', identity);
      else await fail('Amazon did not show a cancellation confirmation after navigation. Check this item before retrying.');
      return;
    }
    if (!S.MANAGER_URL_RE.test(location.href)) return;
    try {
      const form = await openForm(item, identity);
      if (!form && !(await msg('sns:authorizeStep', identity))?.ok) return;
      if (!form) { await fail('Could not verify the cancellation form for this subscription. Selection saved.'); return; }
      selectReason(form, run.reason);
      const button = form.querySelector('input[data-csa-c-slot-id="cancel-subs-modal"],button[type="submit"],input[type="submit"]');
      if (!button || button.disabled || !visible(button)) { await fail('Cancellation confirmation button is unavailable.'); return; }
      if (!(await msg('sns:confirming', identity))?.ok) return;
      realClick(button);
      const success = await waitFor(successVisible, { timeout: 12000, interval: 150 });
      if (success) await msg('sns:itemDone', identity);
      else await fail('Amazon did not show a cancellation confirmation. Check this item before retrying.');
    } catch (error) {
      await fail(String(error?.message || error));
    }
  }
  setTimeout(maybeRun, 400);
})();
