(() => {
  const nodes=[...document.querySelectorAll("[data-immowelt-sync-status]")];
  if(!nodes.length)return;
  const fmt=(iso)=>{
    if(!iso)return "unbekannt";
    const d=new Date(iso);if(Number.isNaN(d.getTime()))return "unbekannt";
    return new Intl.DateTimeFormat("de-DE",{timeZone:"Europe/Berlin",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}).format(d).replace(",","");
  };
  const safeTitle=(reason,state)=>{
    const raw=String(reason||"").trim();
    if(!raw)return state==="rejected"
      ?"Abruf fehlgeschlagen – technisches Problem, wird behoben"
      :"Immowelt-Status";
    if(/playwright|browsertype|ms-playwright|chromium|executable|npx playwright|\/root\/|node_modules|Error:|at Object\.|\.mjs:\d+/i.test(raw)||raw.includes("\n")){
      return "Abruf fehlgeschlagen – technisches Problem, wird behoben";
    }
    if(raw.length>180)return raw.slice(0,177)+"…";
    return raw;
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
        set(`Immowelt · offizielle API-Freischaltung ausstehend · letzter gültiger Stand ${fmt(valid)} ⚠`,"stale",safeTitle(status.reason,"awaiting_api_key"));
        return;
      }
      if(status.state==="rejected"){
        set(`Immowelt · neuer API-Abruf verworfen · letzter gültiger Stand ${fmt(valid)} ⚠`,"rejected",safeTitle(status.reason,"rejected"));
        return;
      }
      set(`Immowelt · letzter gültiger Stand ${fmt(valid)}`,"stale",safeTitle(status.reason,"open"));
    })
    .catch(()=>set("Immowelt · Datenstatus derzeit nicht abrufbar","unknown"));
})();
