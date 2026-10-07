(function () {
  var MEASUREMENT_ID = 'G-QVRRBPYNVM';
  if (!MEASUREMENT_ID || MEASUREMENT_ID.indexOf('G-') !== 0) return;
  window.dataLayer = window.dataLayer || [];
  function gtag(){ dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', MEASUREMENT_ID);

  var ATTR_KEY = 'eichmann_attr_v1';
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  var PII_FIELDS = {
    name: 1, vorname: 1, email: 1, phone: 1, message: 1,
    strasse: 1, plz: 1, ort: 1, anrede: 1
  };

  function loadAttr() {
    try {
      var raw = window.sessionStorage.getItem(ATTR_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function hostOf(url) {
    try {
      return url ? new URL(url).hostname.replace(/^www\./, '') : '';
    } catch (e) {
      return '';
    }
  }

  function classifySource(attr) {
    var utm = (attr && attr.utm) || {};
    if (utm.utm_source) {
      var medium = String(utm.utm_medium || '').toLowerCase();
      var source = String(utm.utm_source).toLowerCase();
      if (medium === 'cpc' || medium === 'ppc' || medium === 'paid') return 'paid_' + source;
      if (source === 'chatgpt' || source.indexOf('openai') !== -1) return 'chatgpt';
      if (source.indexOf('mcp') !== -1) return 'mcp';
      return 'utm_' + source;
    }
    var ref = (attr && attr.referrer) || '';
    var host = hostOf(ref);
    if (!host) return 'direct';
    if (host.indexOf('google.') === 0 || host === 'google.com' || /\.google\./.test(host)) return 'google_organic';
    if (host.indexOf('bing.') === 0 || host === 'bing.com') return 'bing_organic';
    if (host.indexOf('chatgpt.') !== -1 || host.indexOf('openai.') !== -1) return 'chatgpt';
    if (host.indexOf('perplexity.') !== -1) return 'perplexity';
    return 'referral_' + host.slice(0, 80);
  }

  function anliegenCategory(value) {
    var v = String(value || '').toLowerCase();
    if (/allmannsdorf/.test(v)) return 'vormerkung_allmannsdorf';
    if (/expos[eé]/.test(v)) return 'expose';
    if (/widerruf/.test(v)) return 'widerruf';
    if (/tippgeber|empfehlung/.test(v)) return 'tippgeber';
    if (/verkauf/.test(v)) return 'verkauf';
    if (/vermittlung|kauf/.test(v)) return 'vermittlung_kauf';
    if (/bewertung/.test(v)) return 'bewertung';
    if (/projekt/.test(v)) return 'projektentwicklung';
    if (/allgemein/.test(v)) return 'allgemein';
    return value ? 'other' : 'none';
  }

  function projectFrom(form, anliegenValue) {
    if (/allmannsdorf/i.test(anliegenValue || '')) return 'allmannsdorf';
    try {
      if (/interesse=allmannsdorf/i.test(location.search || '')) return 'allmannsdorf';
      if (/allmannsdorf/i.test(location.pathname || '')) return 'allmannsdorf';
      var stored = loadAttr();
      if (stored && stored.landing && /allmannsdorf/i.test(stored.landing)) return 'allmannsdorf';
    } catch (e) {}
    if (form && form.classList && form.classList.contains('expose-form')) return 'expose';
    return 'none';
  }

  function formKind(form) {
    if (form && form.classList && form.classList.contains('expose-form')) return 'expose';
    return 'contact';
  }

  function formContext(form) {
    form = form || document.getElementById('contact-form');
    var anliegenEl = form ? form.querySelector('[name="anliegen"]') : null;
    var anliegenValue = anliegenEl && typeof anliegenEl.value === 'string' ? anliegenEl.value : '';
    var attr = loadAttr() || {};
    var utm = attr.utm || {};
    var params = {
      form: formKind(form),
      anliegen: anliegenCategory(anliegenValue),
      project: projectFrom(form, anliegenValue),
      page_path: location.pathname + location.search,
      landing: attr.landing || (location.pathname + location.search),
      referrer: attr.referrer || '',
      traffic_source: classifySource(attr)
    };
    UTM_KEYS.forEach(function (key) {
      if (utm[key]) params[key] = String(utm[key]).slice(0, 200);
    });
    if (!params.utm_source) {
      try {
        var query = new URLSearchParams(location.search || '');
        UTM_KEYS.forEach(function (key) {
          var value = query.get(key);
          if (value) params[key] = value.slice(0, 200);
        });
      } catch (e) {}
    }
    return params;
  }

  function trackingParams(extra) {
    var params = formContext(document.getElementById('contact-form'));
    Object.keys(extra || {}).forEach(function (key) {
      if (extra[key] !== undefined && extra[key] !== null && extra[key] !== '') params[key] = extra[key];
    });
    return params;
  }

  function trackEvent(name, extra) {
    if (typeof gtag !== 'function') return;
    gtag('event', name, trackingParams(extra));
  }

  window.eichmannTrack = trackEvent;

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

  /* Contact / Exposé funnel — event names only, no PII field values */
  var form = document.getElementById('contact-form');
  if (form) {
    var funnelStarted = false;
    var funnelSuccess = false;
    var touchedFields = {};

    trackEvent('form_view');

    function markStart() {
      if (funnelStarted) return;
      funnelStarted = true;
      trackEvent('form_start');
    }

    function fieldNameOf(el) {
      if (!el) return '';
      var name = el.getAttribute('name') || el.id || '';
      name = String(name).slice(0, 40);
      if (!name || name === 'botcheck') return '';
      return name;
    }

    form.addEventListener('focusin', function (e) {
      var name = fieldNameOf(e.target);
      if (!name) return;
      markStart();
      if (touchedFields[name]) return;
      touchedFields[name] = true;
      /* field name only — never values (esp. PII) */
      trackEvent('form_field_interact', { field: name, field_is_pii: PII_FIELDS[name] ? '1' : '0' });
    });

    /* Legacy Allmannsdorf conversion alias — fires on submit click; success is form_submit_success */
    form.addEventListener('submit', function () {
      var subject = form.querySelector('[name="anliegen"]');
      if (subject && /allmannsdorf/i.test(subject.value || '')) {
        trackEvent('vormerken_submit', { form: formKind(form), project: 'allmannsdorf' });
      }
    });

    window.addEventListener('pagehide', function () {
      if (funnelStarted && !funnelSuccess) {
        trackEvent('form_abandon');
      }
    });

    /* main.js sets this so abandon does not fire after a successful send */
    window.__eichmannFormFunnel = {
      markSuccess: function () { funnelSuccess = true; },
      markStarted: markStart
    };
  }

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(MEASUREMENT_ID);
  document.head.appendChild(s);
})();
