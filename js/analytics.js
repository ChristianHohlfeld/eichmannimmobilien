(function () {
  var MEASUREMENT_ID = 'G-QVRRBPYNVM';
  if (!MEASUREMENT_ID || MEASUREMENT_ID.indexOf('G-') !== 0) return;
  window.dataLayer = window.dataLayer || [];
  function gtag(){ dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', MEASUREMENT_ID);

  function trackingParams(extra) {
    var params = {};
    try {
      var query = new URLSearchParams(location.search || '');
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(function (key) {
        var value = query.get(key);
        if (value) params[key] = value;
      });
    } catch (e) {}
    Object.keys(extra || {}).forEach(function (key) {
      if (extra[key] !== undefined && extra[key] !== null && extra[key] !== '') params[key] = extra[key];
    });
    return params;
  }

  function trackEvent(name, extra) {
    gtag('event', name, trackingParams(extra));
  }

  function linkLocation(link) {
    if (link.closest('.sticky-bar, .flyer-sticky-ctas')) return 'sticky';
    if (link.closest('.nav')) return 'nav';
    if (link.closest('.hero')) return 'hero';
    if (link.closest('.flyer')) return 'flyer';
    return 'content';
  }

  document.querySelectorAll('a[href^="tel:"]').forEach(function (link) {
    link.addEventListener('click', function () {
      trackEvent('click_call', { location: linkLocation(link) });
    });
  });

  document.querySelectorAll('a[href*="wa.me/"]').forEach(function (link) {
    link.addEventListener('click', function () {
      trackEvent('click_whatsapp', { location: linkLocation(link) });
    });
  });

  var flyer = document.getElementById('flyerModal');
  if (flyer) {
    var flyerWasOpen = !flyer.hidden;
    if (flyerWasOpen) trackEvent('flyer_open', { location: 'flyer' });
    new MutationObserver(function () {
      var isOpen = !flyer.hidden;
      if (isOpen && !flyerWasOpen) trackEvent('flyer_open', { location: 'flyer' });
      flyerWasOpen = isOpen;
    }).observe(flyer, { attributes: true, attributeFilter: ['hidden'] });
  }

  var form = document.getElementById('contact-form');
  if (form && !form.classList.contains('expose-form')) {
    form.addEventListener('submit', function () {
      var subject = form.querySelector('[name="anliegen"]');
      if (subject && /allmannsdorf/i.test(subject.value || '')) {
        trackEvent('vormerken_submit', { form: 'contact', project: 'allmannsdorf' });
      }
    });
  }

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(MEASUREMENT_ID);
  document.head.appendChild(s);
})();
