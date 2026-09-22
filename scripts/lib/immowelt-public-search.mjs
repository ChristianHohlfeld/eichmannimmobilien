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
  const serpRequests=[];
  const onRequest=(req)=>{
    if(!/serp-bff\/search/i.test(req.url()))return;
    serpRequests.push({method:req.method(),url:req.url(),postData:req.postData(),headers:req.headers()});
    console.log("IMMOWELT_SERP_REQUEST "+JSON.stringify(serpRequests[serpRequests.length-1]));
  };
  page.on("request",onRequest);
  const response=await page.goto(IMMO_PUBLIC_SEARCH,{waitUntil:"domcontentloaded",timeout:60000});
  if(!response||response.status()>=400)throw new Error(`Immowelt search HTTP ${response?.status()||"none"}`);
  await page.waitForTimeout(1800);
  const byId=new Map();
  const collect=async()=>{for(const x of await collectPage(page))if(x?.id)byId.set(x.id,x);};
  await collect();
  const page2=page.locator('button[aria-label="zu seite 2"],button').filter({hasText:/^\s*2\s*$/}).last();
  if((await page2.count().catch(()=>0))>0&&await page2.isVisible().catch(()=>false)){
    await page2.click({timeout:7000}).catch(()=>{});
    await page.waitForTimeout(1800);
    console.log("IMMOWELT_SERP_CAPTURED "+JSON.stringify(serpRequests));
    // Restore the canonical first page before deterministic fallback attempts.
    await page.goto(IMMO_PUBLIC_SEARCH,{waitUntil:"domcontentloaded",timeout:60000});
    await page.waitForTimeout(900);
  }
  // Direct server-side page URLs are safer than clicking Immowelt's SPA pagination:
  // the latter redirects to /classified-search, which can render empty on hosted runners.
  for(let n=2;n<=20;n++){
    const pageUrl=IMMO_PUBLIC_SEARCH+(IMMO_PUBLIC_SEARCH.includes("?")?"&":"?")+"page="+n;
    const resp=await page.goto(pageUrl,{waitUntil:"domcontentloaded",timeout:60000});
    if(!resp||resp.status()>=400){
      console.warn(`Immowelt search page ${n} HTTP ${resp?.status()||"none"}; stopping pagination.`);
      break;
    }
    await page.waitForTimeout(1600);
    const exposeCount=await page.locator('a[href*="/expose/"]').count().catch(()=>0);
    const bodyText=await page.locator("body").innerText().catch(()=>"");
    if(!exposeCount||!bodyText.trim()){
      console.warn(`Immowelt search page ${n} empty; stopping pagination.`);
      break;
    }
    const before=byId.size;
    await collect();
    console.log(`Immowelt search page ${n}: Eichmann ${before}->${byId.size}; exposeLinks=${exposeCount}; url=${page.url()}`);

    // The public result count is ~30/page; when a requested page resolves back to
    // the first/last result set, stop after detecting no new expose universe twice.
    const totalText=bodyText.match(/([\d.]+)\s+Immobilien kaufen/i);
    const total=totalText?Number(totalText[1].replace(/\./g,"")):null;
    if(total&&n>=Math.ceil(total/30)+1)break;
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
