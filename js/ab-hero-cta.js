/**
 * A/B/C Hero CTA label test — Round 1 (hero_cta_r1)
 * Dimension: Allmannsdorf Hero button label text only (same href/classes).
 * Variants: A „Allmannsdorf“ | B „Neubau ansehen“ | C „Vormerken“
 * SEO: static HTML stays A; the label swap happens only in the browser.
 *
 * Sticky assignment: localStorage key ab_hero_cta_r1 (33/33/33 first visit).
 * Events (GA4, only with Analytics consent — same path as flyer_open):
 *   ab_assign  { experiment, variant, ab_variant } — once per session, sent as soon as
 *              analytics.js (consent) is ready; queued until then, never sent without consent
 *   cta_click  { experiment, variant, ab_variant, label, location: 'hero' } — on click
 *              (no navigation delay; gtag.js flushes on pagehide via keepalive)
 * analytics.js additionally attaches ab_variant (e.g. hero_cta_r1_B) to every event, incl.
 * flyer_open / vormerken_submit / form_submit_success → real leads per variant.
 * Landing correlation: href gets ?ab=hero_cta_r1_<VARIANT>
 *
 * How to read winners in GA4 (custom dimensions variant / experiment / ab_variant registered):
 *   Explore → Free form → Rows: "variant" (or "ab_variant"), Values: Event count
 *   Filter experiment = hero_cta_r1; compare cta_click / ab_assign per variant,
 *   and form_submit_success / vormerken_submit per ab_variant.
 */
(function () {
  var EXPERIMENT = 'hero_cta_r1';
  var STORAGE_KEY = 'ab_hero_cta_r1';
  var ASSIGN_SESSION_KEY = 'ab_hero_cta_r1_assign_sent';
  var VARIANTS = {
    A: 'Allmannsdorf',
    B: 'Neubau ansehen',
    C: 'Vormerken'
  };
  var KEYS = ['A', 'B', 'C'];

  function pickVariant() {
    try {
      var stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored && VARIANTS[stored]) return stored;
    } catch (e) {}
    var idx = Math.floor(Math.random() * KEYS.length);
    var chosen = KEYS[idx];
    try {
      window.localStorage.setItem(STORAGE_KEY, chosen);
    } catch (e) {}
    return chosen;
  }

  /* Consent-aware: window.eichmannTrack exists only after analytics.js was loaded
     (cookie-consent.js loads it only with Analytics consent). Until then events wait in
     window.__eichmannTrackQueue, which analytics.js drains once on load. No consent → no send. */
  function analyticsReady() {
    return typeof window.eichmannTrack === 'function';
  }

  function track(name, params, onSent) {
    if (analyticsReady()) {
      window.eichmannTrack(name, params);
      if (onSent) onSent();
      return;
    }
    window.__eichmannTrackQueue = window.__eichmannTrackQueue || [];
    window.__eichmannTrackQueue.push({ name: name, params: params, onSent: onSent });
    watchQueue();
  }

  /* Fallback drain (e.g. a cached older analytics.js without queue support): check once per
     second while something is queued; stops when drained or after 30 min. */
  var watching = false;
  function watchQueue() {
    if (watching) return;
    watching = true;
    var started = Date.now();
    var timer = setInterval(function () {
      var q = window.__eichmannTrackQueue || [];
      if (!q.length || Date.now() - started > 30 * 60 * 1000) {
        clearInterval(timer);
        watching = false;
        return;
      }
      if (!analyticsReady()) return;
      window.__eichmannTrackQueue = [];
      q.forEach(function (item) {
        window.eichmannTrack(item.name, item.params);
        if (typeof item.onSent === 'function') {
          try { item.onSent(); } catch (e) {}
        }
      });
    }, 1000);
  }

  function withAbParam(href, variant) {
    try {
      var base = window.location.href;
      var url = new URL(href, base);
      url.searchParams.set('ab', EXPERIMENT + '_' + variant);
      // Prefer relative path + search + hash so we don't force absolute host
      var path = url.pathname.split('/').pop() || href.split('?')[0].split('#')[0];
      var out = path + url.search + url.hash;
      return out;
    } catch (e) {
      var sep = href.indexOf('?') >= 0 ? '&' : '?';
      return href + sep + 'ab=' + encodeURIComponent(EXPERIMENT + '_' + variant);
    }
  }

  function apply() {
    var el = document.querySelector('[data-ab-hero-cta]');
    if (!el) return;

    var variant = pickVariant();
    var label = VARIANTS[variant];
    var abVariant = EXPERIMENT + '_' + variant;

    el.textContent = label;
    el.setAttribute('data-ab-variant', variant);
    el.setAttribute('data-ab-experiment', EXPERIMENT);
    el.setAttribute('href', withAbParam(el.getAttribute('href') || 'allmannsdorf.html', variant));

    var already;
    try {
      already = window.sessionStorage.getItem(ASSIGN_SESSION_KEY);
    } catch (e) {
      already = null;
    }
    if (!already) {
      track('ab_assign', { experiment: EXPERIMENT, variant: variant, ab_variant: abVariant }, function () {
        try {
          window.sessionStorage.setItem(ASSIGN_SESSION_KEY, variant);
        } catch (e) {}
      });
    }

    el.addEventListener('click', function () {
      /* No navigation delay: gtag.js flushes its batch on pagehide via fetch(keepalive) */
      track('cta_click', {
        experiment: EXPERIMENT,
        variant: variant,
        ab_variant: abVariant,
        label: label,
        location: 'hero',
        transport_type: 'beacon'
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
})();
