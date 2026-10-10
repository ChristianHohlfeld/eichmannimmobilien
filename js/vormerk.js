/**
 * Inline "Vormerken" forms (form[data-vormerk-form]): Name + Telefon, optional E-Mail.
 * POST → Forms API /contact (anliegen "Vormerkung Neubau Allmannsdorf", lang).
 * Events (consent-gated via window.eichmannTrack; nothing without Analytics consent):
 *   form_view / form_start (form=vormerken, location)
 *   on confirmed server success only: vormerken_submit + form_submit_success + exactly one generate_lead
 *   on failure: form_submit_error
 */
(function () {
  var FORM_URL = "https://forms.digitalisierungsplanung.de/v1/immobilieneichmann/contact";
  var LANG = (document.documentElement.getAttribute("lang") || "de").slice(0, 2).toLowerCase();

  function track(name, params) {
    try {
      if (typeof window.eichmannTrack === "function") { window.eichmannTrack(name, params || {}); return; }
      window.__eichmannTrackQueue = window.__eichmannTrackQueue || [];
      window.__eichmannTrackQueue.push({ name: name, params: params || {} });
    } catch (e) {}
  }
  function val(form, name) {
    var el = form.querySelector('[name="' + name + '"]');
    return el && typeof el.value === "string" ? el.value.trim() : "";
  }

  function init(form) {
    var location = form.getAttribute("data-form-location") || "inline";
    var base = { form: "vormerken", project: "allmannsdorf", location: location, lang: LANG };
    var ok = form.querySelector(".vormerk-success");
    var err = form.querySelector(".vormerk-error");
    var btn = form.querySelector('button[type="submit"]');
    var label = btn ? btn.textContent : "";
    var started = false;
    var viewed = false;

    function seen() {
      if (viewed) return;
      viewed = true;
      track("form_view", base);
    }
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { if (en.isIntersecting) { seen(); io.disconnect(); } });
      });
      io.observe(form);
    }

    form.addEventListener("focusin", function () {
      if (started) return;
      started = true;
      track("form_start", base);
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (ok) ok.hidden = true;
      if (err) err.hidden = true;
      ["name", "phone", "email"].forEach(function (n) {
        var el = form.querySelector('[name="' + n + '"]');
        if (el) el.value = el.value.trim();
      });
      if (!form.checkValidity()) {
        form.reportValidity();
        track("form_submit_attempt", { form: "vormerken", location: location, outcome: "validation_failed" });
        return;
      }
      var bot = form.querySelector('[name="botcheck"]');
      if (bot && bot.checked) return;
      track("form_submit_attempt", { form: "vormerken", location: location, outcome: "send" });

      var payload = {
        name: val(form, "name"),
        phone: val(form, "phone"),
        email: val(form, "email"),
        anliegen: val(form, "anliegen") || "Vormerkung Neubau Allmannsdorf",
        lang: val(form, "lang") || LANG,
        message: ""
      };
      try {
        if (typeof window.__eichmannAttributionFields === "function") {
          var attr = window.__eichmannAttributionFields();
          Object.keys(attr).forEach(function (k) { payload[k] = attr[k]; });
        }
      } catch (x) {}
      payload.page = payload.page || (location + " " + window.location.pathname).slice(0, 300);

      if (btn) { btn.disabled = true; btn.textContent = LANG === "en" ? "Sending …" : "Wird gesendet …"; }

      fetch(FORM_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload)
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
        })
        .then(function (r) {
          if (r.ok && r.data && r.data.success === true) {
            var key = r.data.requestId || String(Date.now());
            if (form.__eichmannLeadKey === key) return;
            form.__eichmannLeadKey = key;
            track("vormerken_submit", base);
            track("form_submit_success", base);
            track("generate_lead", {
              form_id: form.id || "vormerk",
              form_type: "vormerken",
              project: "allmannsdorf",
              location: location,
              lang: LANG,
              transport_type: "beacon"
            });
            form.reset();
            form.classList.add("is-sent");
            if (ok) ok.hidden = false;
          } else {
            if (err) err.hidden = false;
            track("form_submit_error", { form: "vormerken", location: location, error_type: "server", http_status: r.status || 0 });
          }
        })
        .catch(function () {
          if (err) err.hidden = false;
          track("form_submit_error", { form: "vormerken", location: location, error_type: "network" });
        })
        .finally(function () {
          if (btn) { btn.disabled = false; btn.textContent = label; }
        });
    });
  }

  /* "Vormerken"-Links (#vormerk…, #vormerken): Formular in den Blick holen und Namensfeld fokussieren,
     damit der Klick auch dann sichtbar etwas tut, wenn das Formular schon im Viewport steht. */
  function focusTarget(e) {
    var link = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (!link) return;
    var id = (link.getAttribute("href") || "").slice(1);
    if (!id) return;
    var target = document.getElementById(id);
    if (!target) return;
    var form = target.matches && target.matches("form[data-vormerk-form]") ? target : target.querySelector && target.querySelector("form[data-vormerk-form]");
    if (!form) return;
    var field = form.querySelector('[name="name"]');
    if (!field) return;
    e.preventDefault();
    try { form.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (err) { form.scrollIntoView(); }
    setTimeout(function () {
      try { field.focus({ preventScroll: true }); } catch (err) { field.focus(); }
    }, 350);
    if (history && history.replaceState) { try { history.replaceState(null, "", "#" + id); } catch (err) {} }
  }

  function boot() {
    document.querySelectorAll("form[data-vormerk-form]").forEach(init);
    document.addEventListener("click", focusTarget);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
