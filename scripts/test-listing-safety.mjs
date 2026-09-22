#!/usr/bin/env node
import assert from "node:assert/strict";
import { validateIncomingSnapshot, stabilizeListingsAgainstPrevious } from "./lib/listing-safety.mjs";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function listing(n, extra = {}) {
  const id = uuid(n);
  return {
    id,
    immowelt_id: id,
    expose_url: `https://www.immowelt.de/expose/${id}`,
    title: `Wohnung ${n}`,
    price: `${200000 + n * 1000} €`,
    location: "Konstanz",
    rooms: "3 Zimmer",
    living_area: "80 m²",
    description: "Solide Objektbeschreibung mit ausreichend Inhalt für einen sicheren Vergleich des gleichen Angebots.",
    active: true,
    ...extra,
  };
}

const previous = {
  listings: Array.from({ length: 10 }, (_, i) => listing(i + 1)),
};

const incoming = Array.from({ length: 11 }, (_, i) => listing(i + 1));
const assessment = validateIncomingSnapshot(incoming, previous);
assert.equal(assessment.count, 11);
assert.ok(assessment.overlap_ratio >= 0.9);

assert.throws(
  () => validateIncomingSnapshot([], previous),
  /empty listing set/
);

assert.throws(
  () => validateIncomingSnapshot(incoming.slice(0, 3), previous),
  /implausible count/
);

const suspicious = incoming.map((item) => ({ ...item }));
suspicious[0].price = "9.999.999 €";
suspicious[0].living_area = "4 m²";
suspicious[0].description = "zu kurz";
const stabilized = stabilizeListingsAgainstPrevious(suspicious, previous);
assert.equal(stabilized.listings[0].price, previous.listings[0].price);
assert.equal(stabilized.listings[0].living_area, previous.listings[0].living_area);
assert.equal(stabilized.listings[0].description, previous.listings[0].description);
assert.ok(stabilized.warnings.length >= 3);

console.log("Immowelt LKG safety OK: plausible snapshots pass; empty/partial/outlier data is rejected or preserved.");
