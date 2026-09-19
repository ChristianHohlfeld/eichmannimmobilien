(function () {
  var toggle = document.querySelector(".menu-toggle");
  var nav = document.querySelector(".nav");
  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "Menü schließen" : "Menü öffnen");
    });
  }
  var y = document.getElementById("y");
  if (y && !y.textContent) y.textContent = String(new Date().getFullYear());

  var modal = document.getElementById("flyerModal");
  var KEY = "eichmann_allmannsdorf_flyer_dismissed_v1";
  function openFlyer() {
    if (!modal) return;
    modal.hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeFlyer(remember) {
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = "";
    if (remember) {
      try { sessionStorage.setItem(KEY, "1"); } catch (e) {}
    }
  }
  document.querySelectorAll("[data-open-flyer]").forEach(function (el) {
    el.addEventListener("click", function (e) {
      e.preventDefault();
      openFlyer();
    });
  });
  document.querySelectorAll("[data-close-flyer]").forEach(function (el) {
    el.addEventListener("click", function () { closeFlyer(true); });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && modal && !modal.hidden) closeFlyer(true);
  });

  // Auto-show on homepage once per session
  var isHome = /(?:^|\/)(index\.html)?$/.test(location.pathname) || location.pathname.endsWith("/");
  if (isHome && modal) {
    var dismissed = false;
    try { dismissed = sessionStorage.getItem(KEY) === "1"; } catch (e) {}
    if (!dismissed) {
      setTimeout(openFlyer, 700);
    }
  }
  // Deep-link ?flyer=1 or hash
  if (modal && (location.search.indexOf("flyer=1") !== -1 || location.hash === "#allmannsdorf" || location.hash === "#vormerken-neubau")) {
    openFlyer();
  }
})();
