(function () {
  var toggle = document.querySelector(".menu-toggle");
  var nav = document.querySelector(".nav");
  var header = document.querySelector(".site-header");

  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "Menü schließen" : "Menü öffnen");
      if (header) header.classList.toggle("is-open", open);
    });
    nav.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        nav.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-label", "Menü öffnen");
        if (header) header.classList.remove("is-open");
      });
    });
  }

  var y = document.getElementById("y");
  if (y) y.textContent = String(new Date().getFullYear());

  /* Web3Forms contact */
  var FORM_ENDPOINT = "https://api.web3forms.com/submit";
  var ACCESS_KEY = "49d8f579-9384-4d87-b570-67c6e835f4da";
  var MAILTO_TO = "info@immobilieneichmann.de";

  function buildMailto(form) {
    var name = (form.querySelector('[name="name"]') || {}).value || "";
    var email = (form.querySelector('[name="email"]') || {}).value || "";
    var phone = (form.querySelector('[name="phone"]') || {}).value || "";
    var anliegen = (form.querySelector('[name="anliegen"]') || {}).value || "Anfrage";
    var message = (form.querySelector('[name="message"]') || {}).value || "";
    var body =
      "Name: " + name + "\n" +
      "E-Mail: " + email + "\n" +
      "Telefon: " + phone + "\n\n" +
      message;
    return (
      "mailto:" + MAILTO_TO +
      "?subject=" + encodeURIComponent(anliegen + " – Immobilien Eichmann") +
      "&body=" + encodeURIComponent(body)
    );
  }

  var form = document.getElementById("contact-form");
  if (form) {
    var success = document.getElementById("form-success");
    var error = document.getElementById("form-error");
    var submitBtn = document.getElementById("contact-submit");
    var mailtoBtn = document.getElementById("mailto-fallback");

    function show(el, on) {
      if (!el) return;
      if (on) {
        el.hidden = false;
        el.classList.add("visible");
      } else {
        el.hidden = true;
        el.classList.remove("visible");
      }
    }

    if (mailtoBtn) {
      mailtoBtn.addEventListener("click", function () {
        window.location.href = buildMailto(form);
      });
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      show(success, false);
      show(error, false);

      var bot = form.querySelector('[name="botcheck"]');
      if (bot && bot.checked) {
        show(success, true);
        return;
      }

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Wird gesendet …";
      }

      var anliegen = (form.querySelector('[name="anliegen"]') || {}).value || "Anfrage";
      var payload = {
        access_key: ACCESS_KEY,
        name: (form.querySelector('[name="name"]') || {}).value || "",
        email: (form.querySelector('[name="email"]') || {}).value || "",
        phone: (form.querySelector('[name="phone"]') || {}).value || "",
        anliegen: anliegen,
        message: (form.querySelector('[name="message"]') || {}).value || "",
        subject: anliegen + " – Immobilien Eichmann (Webformular)",
        from_name: "Immobilien Eichmann Webseite"
      };

      fetch(FORM_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(payload)
      })
        .then(function (res) {
          return res.json().then(function (data) {
            return { ok: res.ok, data: data };
          });
        })
        .then(function (result) {
          if (result.data && result.data.success === true) {
            show(success, true);
            form.reset();
          } else {
            show(error, true);
          }
        })
        .catch(function () {
          show(error, true);
        })
        .finally(function () {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = "Nachricht senden";
          }
        });
    });
  }

  /* Flyer modal */
  var modal = document.getElementById("flyerModal");
  function openFlyer() {
    if (!modal) return;
    modal.hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeFlyer() {
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = "";
  }
  document.querySelectorAll("[data-open-flyer]").forEach(function (el) {
    el.addEventListener("click", function (e) {
      e.preventDefault();
      openFlyer();
    });
  });
  document.querySelectorAll("[data-close-flyer]").forEach(function (el) {
    el.addEventListener("click", function () { closeFlyer(); });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && modal && !modal.hidden) closeFlyer();
  });
  /* Flyer: never auto-open. Only [data-open-flyer]. */

  
  /* Prefill Anliegen + Fokus Formular bei ?interesse=allmannsdorf */
  if (form && location.search.indexOf("interesse=allmannsdorf") !== -1) {
    var sel = form.querySelector('[name="anliegen"]');
    if (sel) {
      var want = "Vormerkung Neubau Allmannsdorf";
      var found = false;
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === want) {
          sel.selectedIndex = i;
          found = true;
          break;
        }
      }
      if (!found) {
        var opt = document.createElement("option");
        opt.value = want;
        opt.textContent = want;
        opt.selected = true;
        sel.appendChild(opt);
      }
    }
    var msg = form.querySelector('[name="message"]');
    if (msg && !msg.value) {
      msg.placeholder = "Ich möchte für den Neubau Konstanz-Allmannsdorf (ImmoNr 2800) vorgemerkt werden …";
    }
    /* Scroll zum Formular, nicht nur zur Adresskarte */
    var target = document.getElementById("contact-form") || document.getElementById("bewertung");
    if (target && location.hash !== "#contact-form") {
      /* keep hash if already contact-form; otherwise soft-scroll after paint */
      setTimeout(function () {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    }
  }
})();
