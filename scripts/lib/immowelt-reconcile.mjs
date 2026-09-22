export function immoweltListingId(item){
  const raw=String(item?.immowelt_id||item?.id||item?.expose_url||"");
  const m=raw.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  return m?m[1].toLowerCase():"";
}

export async function reconcileMissingImmoweltOffers(currentListings,previousData,probe){
  const current=new Set((currentListings||[]).map(immoweltListingId).filter(Boolean));
  const confirmedInactiveIds=[];
  for(const prev of previousData?.listings||[]){
    if(!prev||prev.active===false)continue;
    const id=immoweltListingId(prev);
    if(!id||current.has(id))continue;
    const result=await probe(id);
    if(result?.state==="inactive"){confirmedInactiveIds.push(id);continue;}
    if(result?.state==="active")throw new Error(`Immowelt snapshot rejected: discovery omitted still-active offer ${id}`);
    throw new Error(`Immowelt snapshot rejected: missing offer ${id} could not be confirmed inactive (${result?.reason||"unknown"})`);
  }
  return confirmedInactiveIds;
}
