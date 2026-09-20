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

  /* Eigenes, getrenntes Customer-Forms-Gateway → Amazon SES → Helmut */
  var FORM_BASE = "https://forms.digitalisierungsplanung.de/v1/immobilieneichmann";
  var MAILTO_TO = "info@immobilien-eichmann.com";

  function valueOf(form, name) {
    var el = form.querySelector('[name="' + name + '"]');
    return el && typeof el.value === "string" ? el.value.trim() : "";
  }

  function buildMailto(form) {
    var isExpose = form.classList.contains("expose-form") || !!form.dataset.exposeTitle;
    var anliegen = valueOf(form, "anliegen") || (isExpose ? "Exposé-Anfrage" : "Anfrage");
    var lines = [];

    if (isExpose) {
      lines.push(
        "Anrede: " + valueOf(form, "anrede"),
        "Vorname: " + valueOf(form, "vorname"),
        "Name: " + valueOf(form, "name"),
        "Straße / Hausnummer: " + valueOf(form, "strasse"),
        "PLZ: " + valueOf(form, "plz"),
        "Ort: " + valueOf(form, "ort"),
        "Telefon: " + valueOf(form, "phone"),
        "E-Mail: " + valueOf(form, "email"),
        "",
        "Objekt: " + (valueOf(form, "objekt") || form.dataset.exposeTitle || ""),
        "Objekt-URL: " + valueOf(form, "objekt_url")
      );
    } else {
      lines.push(
        "Name: " + valueOf(form, "name"),
        "E-Mail: " + valueOf(form, "email"),
        "Telefon: " + valueOf(form, "phone"),
        "",
        valueOf(form, "message")
      );
    }

    return (
      "mailto:" + MAILTO_TO +
      "?subject=" + encodeURIComponent(anliegen + " – Immobilien Eichmann") +
      "&body=" + encodeURIComponent(lines.join("\n"))
    );
  }

  var form = document.getElementById("contact-form");
  if (form) {
    var success = document.getElementById("form-success");
    var error = document.getElementById("form-error");
    var submitBtn = document.getElementById("contact-submit");
    var submitLabel = submitBtn ? submitBtn.textContent : "";
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

      ["anrede", "vorname", "name", "strasse", "plz", "ort", "phone", "email", "message"].forEach(function (fieldName) {
        var field = form.querySelector('[name="' + fieldName + '"]');
        if (field && typeof field.value === "string") field.value = field.value.trim();
      });

      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      var bot = form.querySelector('[name="botcheck"]');
      if (bot && bot.checked) {
        return;
      }

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Wird gesendet …";
      }

      var isExpose = form.classList.contains("expose-form") || !!form.dataset.exposeTitle;
      var anliegen = valueOf(form, "anliegen") || (isExpose ? "Exposé-Anfrage" : "Anfrage");
      var payload = {
        email: valueOf(form, "email"),
        phone: valueOf(form, "phone"),
        anliegen: anliegen
      };

      if (isExpose) {
        payload.anrede = valueOf(form, "anrede");
        payload.vorname = valueOf(form, "vorname");
        payload.name = valueOf(form, "name");
        payload.strasse = valueOf(form, "strasse");
        payload.plz = valueOf(form, "plz");
        payload.ort = valueOf(form, "ort");
        payload.objekt = valueOf(form, "objekt") || form.dataset.exposeTitle || "";
        payload.objekt_url = valueOf(form, "objekt_url");
      } else {
        payload.name = valueOf(form, "name");
        payload.message = valueOf(form, "message");
      }

      var formEndpoint = FORM_BASE + (isExpose ? "/expose" : "/contact");

      fetch(formEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(payload)
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            return { ok: res.ok, data: data };
          });
        })
        .then(function (result) {
          if (result.ok && result.data && result.data.success === true) {
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
            submitBtn.textContent = submitLabel || "Senden";
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
  /* Flyer: nur Startseite (Root) einmalig beim Laden auto-öffnen; sonst nur via [data-open-flyer]. */
  (function () {
    if (!modal) return;
    var path = location.pathname || "/";
    var isHome = path === "/" || /(?:^|\/)index\.html$/i.test(path);
    if (!isHome) return;
    setTimeout(function () {
      if (!modal || !modal.hidden) return;
      openFlyer();
    }, 800);
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


  /* Exposé lightbox v2 — Close fixed am Viewport */
  (function exposeLightbox() {
    var roots = [];
    var g = document.getElementById("expose-gallery");
    if (g) roots.push(g);
    document.querySelectorAll(".expose-floorplan, .expose-floorplans").forEach(function (el) {
      roots.push(el);
    });
    if (!roots.length) return;

    var sources = [];
    roots.forEach(function (root) {
      root.querySelectorAll("img").forEach(function (img) {
        if (!img.getAttribute("src")) return;
        sources.push(img);
        img.setAttribute("tabindex", "0");
        img.setAttribute("role", "button");
        img.setAttribute("aria-label", "Bild vergrößern");
      });
    });
    if (!sources.length) return;

    var overlay = document.createElement("div");
    overlay.className = "lb-overlay";
    overlay.hidden = true;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Bildansicht");
    overlay.innerHTML =
      '<button type="button" class="lb-close" aria-label="Schließen">×</button>' +
      '<button type="button" class="lb-nav lb-prev" aria-label="Vorheriges Bild">‹</button>' +
      '<figure class="lb-dialog">' +
      '<img src="" alt="">' +
      '<figcaption class="lb-caption"></figcaption>' +
      "</figure>" +
      '<button type="button" class="lb-nav lb-next" aria-label="Nächstes Bild">›</button>';
    document.body.appendChild(overlay);

    var lbImg = overlay.querySelector(".lb-dialog img");
    var lbCap = overlay.querySelector(".lb-caption");
    var btnPrev = overlay.querySelector(".lb-prev");
    var btnNext = overlay.querySelector(".lb-next");
    var idx = 0;

    function syncNav() {
      var multi = sources.length > 1;
      btnPrev.hidden = !multi;
      btnNext.hidden = !multi;
    }

    function openAt(i) {
      idx = (i + sources.length) % sources.length;
      var srcImg = sources[idx];
      lbImg.src = srcImg.currentSrc || srcImg.src;
      lbImg.alt = srcImg.alt || "";
      lbCap.textContent =
        sources.length > 1
          ? lbImg.alt + " (" + (idx + 1) + " / " + sources.length + ")"
          : lbImg.alt || "";
      overlay.hidden = false;
      document.body.style.overflow = "hidden";
      syncNav();
      overlay.querySelector(".lb-close").focus();
    }

    function closeLb() {
      overlay.hidden = true;
      lbImg.removeAttribute("src");
      document.body.style.overflow = "";
    }

    sources.forEach(function (img, i) {
      img.addEventListener("click", function (e) {
        e.preventDefault();
        openAt(i);
      });
      img.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openAt(i);
        }
      });
    });

    overlay.querySelector(".lb-close").addEventListener("click", closeLb);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeLb();
    });
    btnPrev.addEventListener("click", function (e) {
      e.stopPropagation();
      openAt(idx - 1);
    });
    btnNext.addEventListener("click", function (e) {
      e.stopPropagation();
      openAt(idx + 1);
    });
    document.addEventListener("keydown", function (e) {
      if (overlay.hidden) return;
      if (e.key === "Escape") closeLb();
      if (e.key === "ArrowLeft") openAt(idx - 1);
      if (e.key === "ArrowRight") openAt(idx + 1);
    });
  })();

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

