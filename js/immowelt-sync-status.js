(() => {
  const nodes=[...document.querySelectorAll("[data-immowelt-sync-status]")];
  if(!nodes.length)return;
  const fmt=(iso)=>{
    if(!iso)return "unbekannt";
    const d=new Date(iso);if(Number.isNaN(d.getTime()))return "unbekannt";
    return new Intl.DateTimeFormat("de-DE",{timeZone:"Europe/Berlin",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}).format(d).replace(",","");
  };
  const set=(text,state="unknown",title="")=>{
    for(const node of nodes){node.textContent=text;node.dataset.state=state;if(title)node.title=title;else node.removeAttribute("title");}
  };
  fetch("data/immowelt-sync-status.json?ts="+Date.now(),{cache:"no-store"})
    .then(r=>{if(!r.ok)throw new Error("status unavailable");return r.json();})
    .then(status=>{
      const valid=status.last_valid_at||null;
      if(status.state==="current"){
        set(`Immowelt · letzter übernommener API-Stand ${fmt(valid)} · aktuell`,"current");
        return;
      }
      if(status.state==="awaiting_api_key"){
        set(`Immowelt · offizielle API-Freischaltung ausstehend · letzter gültiger Stand ${fmt(valid)} ⚠`,"stale",status.reason||"");
        return;
      }
      if(status.state==="rejected"){
        set(`Immowelt · neuer API-Abruf verworfen · letzter gültiger Stand ${fmt(valid)} ⚠`,"rejected",status.reason||"Abruf verworfen; Last Known Good bleibt unverändert.");
        return;
      }
      set(`Immowelt · letzter gültiger Stand ${fmt(valid)}`,"stale",status.reason||"");
    })
    .catch(()=>set("Immowelt · Datenstatus derzeit nicht abrufbar","unknown"));
})();
