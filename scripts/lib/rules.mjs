// Wording rules from data/sot/wording.json, used on the source texts and on the built output.
const PLACEHOLDER = /\{\{[^}]+\}\}/g;

export function compileRules(wording) {
  return {
    rules: wording.rules.map((r) => ({ ...r, re: new RegExp(r.pattern, "giu") })),
    numberWords: new RegExp(`(?<![\\p{L}])(${wording.number_words})(?![\\p{L}])`, "giu"),
    allowedNumbers: new Set(Object.keys(wording.allowed_numbers ?? {})),
  };
}

function waived(rule, hit, waivers, today) {
  return (waivers ?? []).some(
    (w) => w.rule === rule.id && hit.toLowerCase().includes(w.match.toLowerCase()) && w.until >= today
  );
}

/** Wording rules on any text. `where` is only used for the message. */
export function checkWording(text, compiled, { where, waivers = [], today = new Date().toISOString().slice(0, 10), skip = [] } = {}) {
  const out = [];
  for (const rule of compiled.rules) {
    if (skip.includes(rule.id)) continue;
    for (const m of String(text).matchAll(rule.re)) {
      if (waived(rule, m[0], waivers, today)) continue;
      out.push({ where, rule: rule.id, hit: m[0], message: rule.message });
    }
  }
  return out;
}

/** Source texts we write ourselves: no digits and no number words outside placeholders. */
export function checkNoRawNumbers(template, compiled, { where }) {
  const bare = String(template).replace(PLACEHOLDER, "");
  const out = [];
  for (const m of bare.matchAll(/\d[\d.,]*/g))
    out.push({ where, rule: "number_without_evidence", hit: m[0], message: "Zahl im Text. Als Fakt mit Beleg anlegen und per {{fact.…}} einsetzen." });
  for (const m of bare.matchAll(compiled.numberWords))
    out.push({ where, rule: "number_without_evidence", hit: m[0], message: "Zahlwort im Text. Als Fakt mit Beleg anlegen." });
  return out;
}

const digits = (s) => s.replace(/\D/g, "");

/** Every number a page may show: facts, listing fields, contact data, explicit allowlist. */
export function allowedNumberSet(sot, compiled) {
  const set = new Set(compiled.allowedNumbers);
  const add = (v) => { if (v != null && digits(String(v))) set.add(digits(String(v))); };
  for (const p of sot.projects) for (const f of Object.values(p.facts)) [f.value, f.min, f.max].forEach(add);
  const c = sot.contact;
  for (const ph of [c.phone_mobile, c.phone_landline]) {
    add(ph.e164); ph.display.split(/\s+/).forEach(add);
    add("0" + ph.e164.slice(3));                       // national spelling 0170…
  }
  add(c.address.postal_code); (c.address.street.match(/\d+/g) ?? []).forEach(add);
  add(sot.activeListings.length);
  return set;
}

/** Built page text: every number must come from the allowed set. */
export function checkNumbersInOutput(text, allowed, { where }) {
  const out = [];
  for (const m of String(text).matchAll(/\d[\d.,]*\d|\d/g)) {
    const d = digits(m[0]);
    if (!allowed.has(d)) out.push({ where, rule: "number_without_evidence", hit: m[0], message: "Zahl ohne Beleg in der Ausgabe." });
  }
  return out;
}
