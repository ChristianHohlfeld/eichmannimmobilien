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

  /* A/B test hero_cta_r1 ended 2026-10-10: no ab_variant is attached any more
     (trackingParams only adds it when non-empty). */
  function abVariant() {
    return '';
  }

  function trackingParams(extra) {
    var params = formContext(document.getElementById('contact-form'));
    var ab = abVariant();
    if (ab) params.ab_variant = ab;
    if (!params.page_lang) params.page_lang = (document.documentElement.getAttribute('lang') || 'de').slice(0, 2).toLowerCase();
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

  /* Drain events queued before consent/analytics was ready (e.g. ab_assign from ab-hero-cta.js) */
  var pending = window.__eichmannTrackQueue || [];
  window.__eichmannTrackQueue = [];
  pending.forEach(function (item) {
    if (!item || !item.name) return;
    /* ended A/B test: ignore events queued by a cached old ab-hero-cta.js */
    if (item.name === 'ab_assign' || item.name === 'cta_click') return;
    trackEvent(item.name, item.params);
    if (typeof item.onSent === 'function') {
      try { item.onSent(); } catch (e) {}
    }
  });

  function linkLocation(link) {
    var dl = link.getAttribute('data-location');
    if (dl && /^[a-z_]{2,32}$/.test(dl)) return dl; /* Claude R4 #28: hero_number, header_number, expose_jump, sticky_bewertung */
    if (link.closest('.sticky-bar, .flyer-sticky-ctas, .floating-wa-region') || link.classList.contains('floating-wa')) return 'sticky';
    if (link.closest('.nav')) return 'nav';
    if (link.closest('.hero')) return 'hero';
    if (link.closest('.flyer')) return 'flyer';
    if (link.closest('.site-footer')) return 'footer';
    return 'content';
  }

  /* Click-to-call / WhatsApp: delegated (covers every tel:/wa.me link on all pages).
     Beacon transport so the hit survives the app switch / navigation. */
  document.addEventListener('click', function (e) {
    var link = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!link) return;
    var href = link.getAttribute('href') || '';
    if (link.hasAttribute('data-lang-switch')) {
      trackEvent('lang_switch', {
        from: (document.documentElement.getAttribute('lang') || 'de').slice(0, 2).toLowerCase(),
        to: link.getAttribute('data-lang-switch'),
        location: link.closest('.site-footer') ? 'footer' : (link.closest('.nav') ? 'header' : 'content'),
        transport_type: 'beacon'
      });
      return;
    }
    if (link.getAttribute('data-location') === 'expose_jump' || link.getAttribute('data-location') === 'sticky_bewertung') {
      trackEvent('cta_click', { location: link.getAttribute('data-location'), label: (link.textContent || '').trim().slice(0, 40), transport_type: 'beacon' });
      return;
    }
    if (/^tel:/i.test(href)) {
      var mobile = false;
      try { mobile = window.matchMedia('(max-width: 768px)').matches; } catch (err) {}
      trackEvent('click_phone', {
        location: linkLocation(link),
        device_hint: mobile ? 'mobile' : 'desktop',
        phone_target: href.replace(/^tel:/i, '').replace(/[^\d+]/g, '').slice(0, 20),
        transport_type: 'beacon'
      });
    } else if (href.indexOf('wa.me/') !== -1) {
      trackEvent('click_whatsapp', {
        location: linkLocation(link),
        transport_type: 'beacon'
      });
    }
  }, true);

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
        trackEvent('vormerken_submit', { form: formKind(form), project: 'allmannsdorf', lang: (document.documentElement.getAttribute('lang') || 'de').slice(0, 2) });
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
