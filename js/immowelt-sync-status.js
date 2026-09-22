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
  const staticUrl="data/immowelt-sync-status.json?ts="+Date.now();
  const runsUrl="https://api.github.com/repos/ChristianHohlfeld/eichmannimmobilien/actions/workflows/sync-immowelt.yml/runs?branch=main&per_page=1";
  Promise.allSettled([
    fetch(staticUrl,{cache:"no-store"}).then(r=>{if(!r.ok)throw new Error("status unavailable");return r.json();}),
    fetch(runsUrl,{cache:"no-store",headers:{Accept:"application/vnd.github+json"}}).then(r=>{if(!r.ok)throw new Error("run unavailable");return r.json();})
  ]).then(([sr,rr])=>{
    const status=sr.status==="fulfilled"?sr.value:{};
    const run=rr.status==="fulfilled"?rr.value?.workflow_runs?.[0]:null;
    const checked=run?.run_started_at||run?.created_at||null;
    const valid=status.last_valid_at||null;
    if(run?.status==="queued"||run?.status==="in_progress"){
      set(`Immowelt · Prüfung läuft · letzter gültiger Stand ${fmt(valid)}`,"checking");return;
    }
    if(run?.conclusion==="failure"||status.state==="rejected"){
      set(`Immowelt · Prüfung ${fmt(checked)} fehlgeschlagen · letzter gültiger Stand ${fmt(valid)} ⚠`,"rejected",status.reason||"Abruf verworfen; Last Known Good bleibt unverändert.");return;
    }
    if(run?.conclusion==="success"){
      set(`Immowelt · geprüft ${fmt(checked)} · letzter übernommener Stand ${fmt(valid)} · aktuell`,"current");return;
    }
    if(status.state==="current"){set(`Immowelt · letzter gültiger Stand ${fmt(valid)} · aktuell`,"current");return;}
    set(`Immowelt · letzter gültiger Stand ${fmt(valid)}`,"stale",status.reason||"");
  }).catch(()=>set("Immowelt · Datenstatus derzeit nicht abrufbar","unknown"));
})();
