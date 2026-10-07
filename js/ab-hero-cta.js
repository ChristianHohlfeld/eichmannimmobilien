/**
 * A/B/C Hero CTA label test — Round 1 (hero_cta_r1)
 * Dimension: Allmannsdorf Hero button label text only (same href/classes).
 * Variants: A „Allmannsdorf“ | B „Neubau ansehen“ | C „Vormerken“
 *
 * Sticky assignment: localStorage key ab_hero_cta_r1 (33/33/33 first visit).
 * Events (GA4 / dataLayer):
 *   ab_assign  { experiment, variant } — once per session
 *   cta_click  { experiment, variant, label, location: 'hero' } — on click
 * Landing correlation: href gets ?ab=hero_cta_r1_<VARIANT>
 *
 * How to read winners in GA4:
 *   Explore → Free form → Rows: custom event parameter "variant"
 *   Metrics: event count for ab_assign (traffic split) and cta_click (CTR)
 *   Filter event_name = cta_click AND experiment = hero_cta_r1
 *   Winner = highest cta_click / ab_assign; then harden that label and start round 2.
 * If GA4 not loaded yet, dataLayer still receives the same payloads for #60 funnel.
 */
(function () {
  var EXPERIMENT = 'hero_cta_r1';
  var STORAGE_KEY = 'ab_hero_cta_r1';
  var ASSIGN_SESSION_KEY = 'ab_hero_cta_r1_assigned';
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

  function track(name, params) {
    var payload = params || {};
    try {
      window.dataLayer = window.dataLayer || [];
      var flat = { event: name };
      Object.keys(payload).forEach(function (k) {
        flat[k] = payload[k];
      });
      window.dataLayer.push(flat);
    } catch (e) {}
    try {
      if (typeof window.gtag === 'function') {
        window.gtag('event', name, payload);
      }
    } catch (e) {}
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
      track('ab_assign', { experiment: EXPERIMENT, variant: variant });
      try {
        window.sessionStorage.setItem(ASSIGN_SESSION_KEY, variant);
      } catch (e) {}
    }

    el.addEventListener('click', function () {
      track('cta_click', {
        experiment: EXPERIMENT,
        variant: variant,
        label: label,
        location: 'hero'
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
})();
