#!/usr/bin/env node
import assert from "node:assert/strict";
import { validateIncomingSnapshot, validateNoDestructiveOverwrite } from "./lib/listing-safety.mjs";

const uuid=(n)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
function listing(n,extra={}){
  const id=uuid(n);
  return {
    id,immowelt_id:id,expose_url:`https://www.immowelt.de/expose/${id}`,
    title:`Wohnung ${n}`,price:`${200000+n*1000} €`,location:"Konstanz (78467)",
    rooms:"3 Zimmer",living_area:"80 m²",
    description:"Solide Objektbeschreibung mit ausreichend Inhalt für einen sicheren Vergleich des gleichen Angebots. ".repeat(3),
    images:["a","b","c"],facts:{Baujahr:"2020"},active:true,...extra
  };
}
const previous={listings:Array.from({length:10},(_,i)=>listing(i+1))};
const plausible=Array.from({length:11},(_,i)=>listing(i+1));
const a=validateIncomingSnapshot(plausible,previous);
assert.equal(a.count,11);
assert(a.overlap_ratio>=0.9);
assert.throws(()=>validateIncomingSnapshot([],previous),/empty listing set/);
assert.throws(()=>validateIncomingSnapshot(plausible.slice(0,3),previous),/implausible count/);
assert.throws(
  ()=>validateIncomingSnapshot([...previous.listings,listing(99,{price:null,living_area:null,plot_area:null})],previous),
  /lacks safe core fields/
);
const emptyField=previous.listings.map(x=>({...x}));
emptyField[0]={...emptyField[0],price:null};
assert.throws(()=>validateNoDestructiveOverwrite(emptyField,previous),/would-be-empty/);
const jump=previous.listings.map(x=>({...x}));
jump[0]={...jump[0],price:"9.999.999 €"};
assert.throws(()=>validateNoDestructiveOverwrite(jump,previous),/implausible/);
assert.equal(validateNoDestructiveOverwrite(previous.listings.map(x=>({...x})),previous).checked,10);
console.log("Immowelt safety contract: fail-closed LKG rules OK.");
