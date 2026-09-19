(function () {
  var KEY = "eichmann_cookie_consent_v1";
  var ANALYTICS_SRC = (window.__eichmannJsBase || "js/") + "analytics.js";

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function write(choice) {
    var payload = {
      necessary: true,
      analytics: !!choice.analytics,
      ts: Date.now()
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(payload));
    } catch (e) {}
    return payload;
  }

  function loadAnalytics() {
    if (window.__eichmannAnalyticsLoaded) return;
    window.__eichmannAnalyticsLoaded = true;
    var s = document.createElement("script");
    s.src = ANALYTICS_SRC;
    s.defer = true;
    document.head.appendChild(s);
  }

  function apply(consent) {
    if (consent && consent.analytics) loadAnalytics();
  }

  function hideBanner() {
    var el = document.getElementById("cookie-banner");
    if (el) el.hidden = true;
  }

  function showBanner() {
    var el = document.getElementById("cookie-banner");
    if (el) el.hidden = false;
  }

  function ensureBanner() {
    if (document.getElementById("cookie-banner")) return;
    var bar = document.createElement("div");
    bar.id = "cookie-banner";
    bar.className = "cookie-banner";
    bar.setAttribute("role", "dialog");
    bar.setAttribute("aria-labelledby", "cookie-banner-title");
    bar.setAttribute("aria-describedby", "cookie-banner-desc");
    bar.innerHTML =
      '<div class="cookie-banner-inner">' +
      '<div class="cookie-banner-copy">' +
      '<p id="cookie-banner-title" class="cookie-banner-title">Cookies &amp; Datenschutz</p>' +
      '<p id="cookie-banner-desc" class="cookie-banner-desc">Notwendige Cookies brauchen wir für die Website. Statistik (Google Analytics) nur mit Ihrer Einwilligung. Details in der <a href="datenschutz.html">Datenschutzerklärung</a>.</p>' +
      "</div>" +
      '<div class="cookie-banner-actions">' +
      '<button type="button" class="btn btn-outline btn-sm" data-cookie="necessary">Nur notwendige</button>' +
      '<button type="button" class="btn btn-accent btn-sm" data-cookie="all">Alle akzeptieren</button>' +
      "</div>" +
      "</div>";
    document.body.appendChild(bar);

    bar.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-cookie]");
      if (!btn) return;
      var mode = btn.getAttribute("data-cookie");
      var consent = write({ analytics: mode === "all" });
      hideBanner();
      apply(consent);
    });
  }

  function openSettings() {
    ensureBanner();
    showBanner();
  }

  document.addEventListener("DOMContentLoaded", function () {
    ensureBanner();
    var existing = read();
    if (existing) {
      hideBanner();
      apply(existing);
    } else {
      showBanner();
    }

    document.querySelectorAll("[data-open-cookie-settings]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.preventDefault();
        openSettings();
      });
    });
  });

  window.eichmannCookieConsent = { open: openSettings, read: read };
})();
