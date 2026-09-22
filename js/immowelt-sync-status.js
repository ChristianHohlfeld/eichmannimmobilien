(() => {
  const nodes = [...document.querySelectorAll("[data-immowelt-sync-status]")];
  if (!nodes.length) return;

  const format = (iso) => {
    if (!iso) return "unbekannt";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "unbekannt";
    return new Intl.DateTimeFormat("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date).replace(",", "");
  };

  const set = (text, state = "unknown", title = "") => {
    for (const node of nodes) {
      node.textContent = text;
      node.dataset.state = state;
      if (title) node.title = title;
      else node.removeAttribute("title");
    }
  };

  fetch("data/immowelt-sync-status.json?ts=" + Date.now(), { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error("status unavailable");
      return response.json();
    })
    .then((status) => {
      if (status.state === "current") {
        set(
          `Immowelt · Daten ${format(status.last_valid_at)} · geprüft · aktuell`,
          "current"
        );
        return;
      }
      if (status.state === "rejected") {
        set(
          `Immowelt · letzter gültiger Stand ${format(status.last_valid_at)} · neuer Abruf verworfen ⚠`,
          "rejected",
          status.reason || "Neuer Immowelt-Abruf wurde aus Sicherheitsgründen nicht übernommen."
        );
        return;
      }
      set(
        `Immowelt · letzter gültiger Stand ${format(status.last_valid_at)}`,
        "stale",
        status.reason || ""
      );
    })
    .catch(() => {
      set("Immowelt · Datenstatus derzeit nicht abrufbar", "unknown");
    });
})();
