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

  const form = document.getElementById("contact-form");
  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
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

      const mailto =
        "mailto:info@immobilieneichmann.de" +
        "?subject=" + encodeURIComponent(subject + " – Immobilien Eichmann") +
        "&body=" + encodeURIComponent(body);

      const success = document.getElementById("form-success");
      if (success) success.classList.add("visible");

      window.location.href = mailto;
    });
  }

  // Mark active nav link
  const path = window.location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll(".nav a").forEach(function (a) {
    const href = a.getAttribute("href");
    if (href === path || (path === "" && href === "index.html")) {
      a.classList.add("active");
    }
  });
})();
