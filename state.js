// Pure reconciliation logic shared by the service worker and regression tests.
(function () {
  const norm = value => String(value || '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  const imageKey = value => String(value || '').split('/images/I/')[1]?.split('._')[0] || '';
  const sameProduct = (a, b) => {
    const image = imageKey(a.image);
    return norm(a.nextDate) === norm(b.nextDate) && (
      (image && image === imageKey(b.image)) ||
      (norm(a.title) && !/^next delivery|^untitled/.test(norm(a.title)) && norm(a.title) === norm(b.title))
    );
  };

  function reconcile(scanned, saved) {
    const unique = [...new Map(scanned.map(item => [item.subscriptionId || item.id, item])).values()];
    return unique.map(item => {
      let previous = saved.find(old => old.id === item.id);
      let needsReview = false;
      if (!previous) {
        // Only migrate legacy text hashes when the product/date maps to one
        // subscription. ASIN alone cannot distinguish repeat subscriptions.
        const legacy = saved.filter(old => !old.subscriptionId && sameProduct(item, old));
        const matches = unique.filter(other => sameProduct(item, other));
        if (legacy.length && matches.length === 1 && legacy.every(old => old.keep === legacy[0].keep)) {
          previous = legacy[0];
        } else if (legacy.length) {
          needsReview = true;
        }
      }
      return {
        ...item,
        keep: previous ? previous.keep || previous.status === 'done' : true,
        status: previous?.status === 'inflight' ? 'pending' : previous?.status || 'pending',
        attempts: previous?.attempts || 0,
        error: previous?.error,
        finishedAt: previous?.finishedAt,
        verification: previous?.verification,
        needsReview: previous?.needsReview || needsReview,
      };
    });
  }

  function remember(saved, items) {
    const byId = new Map(saved.map(item => [item.id, item]));
    for (const item of items) byId.set(item.id, { ...item });
    return [...byId.values()];
  }

  function targetUrl(item) {
    try {
      const url = new URL(item.cancelUrl || item.editUrl);
      if (url.origin !== 'https://www.amazon.com') return null;
      if (!/^\/auto-deliveries\/(cancelSubscription|edit|subscriptions\/edit)|^\/gp\/subscribe-and-save\/manager\/edit/.test(url.pathname)) return null;
      if (!item.subscriptionId || url.searchParams.get('subscriptionId') !== item.subscriptionId) return null;
      // Drive Amazon's native manager dialog so the selected item and its
      // cancellation confirmation remain in the same observable UI flow.
      return 'https://www.amazon.com/auto-deliveries/subscriptionList';
    } catch (_) { return null; }
  }

  globalThis.SNSState = { reconcile, remember, targetUrl };
})();
