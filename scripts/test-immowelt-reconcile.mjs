#!/usr/bin/env node
import assert from "node:assert/strict";
import {reconcileMissingImmoweltOffers} from "./lib/immowelt-reconcile.mjs";

const uuid=(n)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const previous={listings:[1,2,3].map(n=>({id:uuid(n),immowelt_id:uuid(n),active:true}))};
const current=[1,2].map(n=>({id:uuid(n),immowelt_id:uuid(n)}));

const inactive=await reconcileMissingImmoweltOffers(current,previous,async id=>({state:id===uuid(3)?"inactive":"active"}));
assert.deepEqual(inactive,[uuid(3)]);

await assert.rejects(
  reconcileMissingImmoweltOffers(current,previous,async()=>({state:"active"})),
  /omitted still-active/
);
await assert.rejects(
  reconcileMissingImmoweltOffers(current,previous,async()=>({state:"unknown",reason:"blocked"})),
  /could not be confirmed inactive/
);

const previousWithOldInactive={listings:[...previous.listings,{id:uuid(4),immowelt_id:uuid(4),active:false}]};
let calls=0;
await reconcileMissingImmoweltOffers(current,previousWithOldInactive,async()=>{calls++;return {state:"inactive"};});
assert.equal(calls,1,"already inactive historical offers must not be probed");

console.log("Immowelt missing-offer reconciliation: fail-closed OK.");
