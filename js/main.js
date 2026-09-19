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

  /* FormSubmit → info@immobilien-eichmann.com */
  var FORM_ENDPOINT = "https://formsubmit.co/ajax/info@immobilien-eichmann.com";
  var MAILTO_TO = "info@immobilien-eichmann.com";

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
        name: (form.querySelector('[name="name"]') || {}).value || "",
        email: (form.querySelector('[name="email"]') || {}).value || "",
        phone: (form.querySelector('[name="phone"]') || {}).value || "",
        anliegen: anliegen,
        message: (form.querySelector('[name="message"]') || {}).value || "",
        _subject: anliegen + " – Immobilien Eichmann (Webformular)",
        _template: "table",
        _captcha: "false"
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
          /* FormSubmit: success true, or first-time activation message */
          if (result.ok && result.data && (result.data.success === "true" || result.data.success === true)) {
            show(success, true);
            form.reset();
          } else if (result.ok && result.data && /Activ/i.test(JSON.stringify(result.data))) {
            show(success, true);
            if (success) success.textContent = "Bitte einmal die Bestätigung in info@immobilien-eichmann.com öffnen (erster Formularversand), danach kommen Anfragen direkt an.";
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
    document.body.classList.add("flyer-open");
    var cookie = document.getElementById("cookie-banner");
    if (cookie && !cookie.hidden) {
      cookie.dataset.flyerHidden = "1";
      cookie.hidden = true;
    }
  }
  function closeFlyer() {
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = "";
    document.body.classList.remove("flyer-open");
    var cookie = document.getElementById("cookie-banner");
    if (cookie && cookie.dataset.flyerHidden === "1") {
      delete cookie.dataset.flyerHidden;
      cookie.hidden = false;
    }
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
  /* Flyer: Startseite auto-open on every load (wie BI page_load delay), manuell weiter über [data-open-flyer]. */
  (function () {
    if (!modal) return;
    var file = (location.pathname || "").split("/").pop() || "";
    var isHome = file === "" || file === "index.html";
    if (!isHome) return;
    setTimeout(function () {
      if (!modal || !modal.hidden) return;
      openFlyer();
    }, 2000);
  })();

  
  /* Prefill bei ?interesse=widerruf */
  if (form && location.search.indexOf("interesse=widerruf") !== -1) {
    var selW = form.querySelector('[name="anliegen"]');
    if (selW) {
      var wantW = "Widerruf";
      var foundW = false;
      for (var wi = 0; wi < selW.options.length; wi++) {
        if (selW.options[wi].value === wantW) { selW.selectedIndex = wi; foundW = true; break; }
      }
      if (!foundW) {
        var optW = document.createElement("option");
        optW.value = wantW; optW.textContent = wantW; optW.selected = true; selW.appendChild(optW);
      }
    }
    var msgW = form.querySelector('[name="message"]');
    if (msgW && !msgW.value) {
      msgW.placeholder = "Hiermit widerrufe ich den Vertrag vom … über …";
    }
  }

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


  /* Exposé gallery thumbs */
  var gallery = document.getElementById("expose-gallery");
  if (gallery) {
    var items = gallery.querySelectorAll(".expose-gallery-item");
    var thumbs = gallery.querySelectorAll("[data-thumb-index]");
    function showSlide(idx) {
      items.forEach(function (el, i) {
        if (items.length > 1) el.style.display = i === idx ? "block" : "none";
        el.classList.toggle("is-active", i === idx);
      });
      thumbs.forEach(function (btn) {
        var i = Number(btn.getAttribute("data-thumb-index"));
        btn.classList.toggle("is-active", i === idx);
      });
    }
    if (items.length > 1) showSlide(0);
    thumbs.forEach(function (btn) {
      btn.addEventListener("click", function () {
        showSlide(Number(btn.getAttribute("data-thumb-index")) || 0);
      });
    });
  }

  /* Prefill Kontakt from ?objekt=slug */
  if (form) {
    var paramsObj = new URLSearchParams(location.search);
    var objektSlug = paramsObj.get("objekt");
    if (objektSlug) {
      var selObj = form.querySelector('[name="anliegen"]');
      if (selObj) {
        var wantObj = "Exposé-Anfrage";
        var foundObj = false;
        for (var k = 0; k < selObj.options.length; k++) {
          if (selObj.options[k].value === wantObj) {
            selObj.selectedIndex = k;
            foundObj = true;
            break;
          }
        }
        if (!foundObj) {
          var optObj = document.createElement("option");
          optObj.value = wantObj;
          optObj.textContent = wantObj;
          optObj.selected = true;
          selObj.appendChild(optObj);
        }
      }
      var msgObj = form.querySelector('[name="message"]');
      if (msgObj && !msgObj.value) {
        msgObj.value =
          "Guten Tag,\n" +
          "ich interessiere mich für das Objekt " + decodeURIComponent(objektSlug) + ".\n" +
          "Bitte senden Sie mir das Exposé / weitere Informationen.\n\n" +
          "Mit freundlichen Grüßen";
      }
      var targetObj = document.getElementById("contact-form");
      if (targetObj) {
        setTimeout(function () {
          targetObj.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 50);
      }
    }
  }
})();

