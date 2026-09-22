export const IMMO_PUBLIC_SEARCH="https://www.immowelt.de/suche/kaufen/immobilien/baden-wurttemberg/konstanz-78462/ad08de6010";

async function collectPage(page){
  return page.evaluate(()=>{
    const out=[],seen=new Set(),provider=/Immobilien\s+Eichmann/i;
    for(const a of document.querySelectorAll('a[href*="/expose/"]')){
      const href=a.href||a.getAttribute("href")||"";
      const m=href.match(/\/expose\/([a-f0-9-]{36})/i);
      if(!m||seen.has(m[1].toLowerCase()))continue;
      let node=a,card=null;
      for(let d=0;d<12&&node;d++,node=node.parentElement){
        const text=String(node.innerText||node.textContent||"").replace(/\s+/g," ").trim();
        if(provider.test(text)&&/€/.test(text)&&text.length<8000){card=node;break;}
      }
      if(!card)continue;
      const id=m[1].toLowerCase();seen.add(id);
      const text=String(card.innerText||card.textContent||"").replace(/\s+/g," ").trim();
      const lines=String(card.innerText||"").split("\n").map(x=>x.trim()).filter(Boolean);
      const price=text.match(/(\d{1,3}(?:\.\d{3})*(?:,\d+)?\s*€)/)?.[1]||null;
      const rooms=text.match(/(\d+(?:,\d+)?\s*Zimmer)/i)?.[1]||null;
      const areas=[...text.matchAll(/(\d+(?:[.,]\d+)?\s*m²)(?:\s*(Grundstück))?/gi)];
      const living=areas.find(x=>!x[2])?.[1]||null;
      const plot=areas.find(x=>x[2])?.[1]||null;
      const title=lines.find(x=>x.length>=5&&!provider.test(x)&&/Wohnung|Haus|Penthouse|Maisonette|Grundstück|Zimmer|Neubau|KfW/i.test(x))
        ||lines.find(x=>x.length>=8&&!provider.test(x))||"Immobilie";
      const location=text.match(/([^|]{2,80}\(\d{5}\))/)?.[1]?.trim()||null;
      const ref=(text.match(/Referenz(?:nummer|nr\.?)?[\s:#-]*([A-Z0-9][A-Z0-9._/-]{0,31})/i)?.[1]||title.match(/\b([AB]\d{1,3})\b/i)?.[1]||"").toUpperCase()||null;
      out.push({id,title,price,location,rooms,living_area:living,plot_area:plot,status:"Kauf",reference_number:ref,expose_url:`https://www.immowelt.de/expose/${id}`,main_image_url:card.querySelector("img")?.src||null});
    }
    return out;
  });
}

export async function scrapeEichmannFromImmoweltSearch(page){
  const response=await page.goto(IMMO_PUBLIC_SEARCH,{waitUntil:"domcontentloaded",timeout:60000});
  if(!response||response.status()>=400)throw new Error(`Immowelt search HTTP ${response?.status()||"none"}`);
  await page.waitForTimeout(1800);
  const byId=new Map();
  const collect=async()=>{for(const x of await collectPage(page))if(x?.id)byId.set(x.id,x);};
  await collect();
  let noGrowth=0;
  for(let n=2;n<=20;n++){
    const before=byId.size;
    const beforeUrl=page.url();

    let control=page.locator(
      'a[aria-label*="Näch"],button[aria-label*="Näch"],a[aria-label*="Weiter"],button[aria-label*="Weiter"],a[rel="next"]'
    ).first();
    let usable=(await control.count().catch(()=>0))>0 && await control.isVisible().catch(()=>false);
    if(!usable){
      control=page.locator("a,button").filter({hasText:/^\s*(?:Nächste|Weiter|Next|>)\s*$/i}).first();
      usable=(await control.count().catch(()=>0))>0 && await control.isVisible().catch(()=>false);
    }
    if(!usable){
      control=page.locator("a,button").filter({hasText:new RegExp(`^\\s*${n}\\s*$`)}).first();
      usable=(await control.count().catch(()=>0))>0 && await control.isVisible().catch(()=>false);
    }

    if(usable){
      await control.click({timeout:7000}).catch(()=>{});
      await page.waitForTimeout(1100);
    }else{
      await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
      await page.waitForTimeout(1200);
    }

    await collect();
    const grew=byId.size>before;
    const moved=page.url()!==beforeUrl;
    console.log(`Immowelt search traversal ${n}: Eichmann ${before}->${byId.size}; urlChanged=${moved}; control=${usable}`);
    noGrowth=grew?0:noGrowth+1;
    if(noGrowth>=2&&!moved&&!usable)break;
  }
  const listings=[...byId.values()];
  if(!listings.length){
    const diag=await page.evaluate(()=>({
      exposeLinks:document.querySelectorAll('a[href*="/expose/"]').length,
      providerMentions:(String(document.body?.innerText||"").match(/Immobilien\s+Eichmann/gi)||[]).length,
      controls:[...document.querySelectorAll("a,button")].map(el=>({
        text:String(el.innerText||el.textContent||"").trim().slice(0,80),
        aria:el.getAttribute("aria-label"),
        rel:el.getAttribute("rel"),
        href:el.getAttribute("href")
      })).filter(x=>/näch|weiter|next|^\d{1,2}$|pagination|seite/i.test([x.text,x.aria,x.rel,x.href].filter(Boolean).join(" "))).slice(-80),
      textSample:String(document.body?.innerText||"").slice(0,1200)
    }));
    throw new Error(`Immowelt search returned no Immobilien Eichmann offers; diagnostic ${JSON.stringify(diag)}`);
  }
  return {source:IMMO_PUBLIC_SEARCH,discovery:"official_immowelt_search",scraped_at:new Date().toISOString(),listings};
}
