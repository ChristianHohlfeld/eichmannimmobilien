(function () {
  const toggle = document.querySelector(".menu-toggle");
  const nav = document.querySelector(".nav");
  const header = document.querySelector(".site-header");

  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      const open = nav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      if (header) header.classList.toggle("is-open", open);
    });

    nav.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        nav.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
        if (header) header.classList.remove("is-open");
      });
    });
  }

  const FORM_ENDPOINT = "https://formsubmit.co/ajax/chris.hohlfeld@gmail.com";
  const MAILTO_TO = "info@immobilieneichmann.de";

  function buildMailto(form) {
    const name = (form.querySelector('[name="name"]') || {}).value || "";
    const email = (form.querySelector('[name="email"]') || {}).value || "";
    const phone = (form.querySelector('[name="phone"]') || {}).value || "";
    const subject = (form.querySelector('[name="subject"]') || {}).value || "Anfrage";
    const message = (form.querySelector('[name="message"]') || {}).value || "";
    const body =
      "Name: " + name + "\n" +
      "E-Mail: " + email + "\n" +
      "Telefon: " + phone + "\n\n" +
      message;
    return (
      "mailto:" + MAILTO_TO +
      "?subject=" + encodeURIComponent(subject + " – Immobilien Eichmann") +
      "&body=" + encodeURIComponent(body)
    );
  }

  const form = document.getElementById("contact-form");
  if (form) {
    const success = document.getElementById("form-success");
    const error = document.getElementById("form-error");
    const submitBtn = document.getElementById("contact-submit");
    const mailtoBtn = document.getElementById("mailto-fallback");

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

      const honey = form.querySelector('[name="_honey"]');
      if (honey && honey.value) {
        show(success, true);
        return;
      }

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Wird gesendet …";
      }

      const subject = (form.querySelector('[name="subject"]') || {}).value || "Anfrage";
      const payload = {
        name: (form.querySelector('[name="name"]') || {}).value || "",
        email: (form.querySelector('[name="email"]') || {}).value || "",
        phone: (form.querySelector('[name="phone"]') || {}).value || "",
        subject: subject,
        message: (form.querySelector('[name="message"]') || {}).value || "",
        _subject: subject + " – Immobilien Eichmann (Webformular)",
        _template: "table",
        _captcha: "false",
        _replyto: (form.querySelector('[name="email"]') || {}).value || ""
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
          const msg = ((result.data && result.data.message) || "").toLowerCase();
          const successFlag = result.data && (result.data.success === "true" || result.data.success === true);
          // FormSubmit returns success:false with "needs Activation" until confirmed
          if (successFlag || (result.ok && msg.indexOf("activation") === -1 && msg.indexOf("make sure") === -1)) {
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

  const path = window.location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll(".nav a").forEach(function (a) {
    const href = a.getAttribute("href");
    if (href === path || (path === "" && href === "index.html")) {
      a.classList.add("active");
    }
  });
})();
