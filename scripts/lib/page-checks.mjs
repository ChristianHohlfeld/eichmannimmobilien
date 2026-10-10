/* Claude R4 Code 3: Zusatzprüfungen je ausgelieferter HTML-Seite (Titel/Description-Länge, H1, Anruf-Knopf mit Nummer,
   Objektseiten: Formular-Anker, Sprung-Knopf, Datenstand, Provision; kein „Live“-Echtzeit-Anspruch). */
const text = (html, re) => (html.match(re)?.[1] ?? "").replace(/&amp;/g, "&").trim();

export function checkPage(html, where) {
  const out = [];
  const bad = (rule, message) => out.push({ where, rule, hit: "", message });
  const title = text(html, /<title>([\s\S]*?)<\/title>/i);
  const desc = text(html, /<meta\s+name="description"\s+content="([^"]*)"/i);
  if (!title) bad("title", "Titel fehlt");
  else if (title.length > 60) bad("title", `Titel hat ${title.length} Zeichen (max. 60)`);
  if (!desc) bad("description", "Description fehlt");
  else if (desc.length > 160) bad("description", `Description hat ${desc.length} Zeichen (max. 160)`);
  if (/&amp;(amp|nbsp|quot|lt|gt);/.test(html)) bad("entity", "Doppelt kodiertes Zeichen");
  if ((html.match(/<h1[\s>]/gi) ?? []).length !== 1) bad("h1", "Genau eine H1 erwartet");
  if (!/href="tel:\+491705225568"/.test(html)) bad("call", "Kein Anruf-Link");
  for (const m of html.matchAll(/<a[^>]*class="[^"]*\bbtn-call\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
    if (!/\d{3,4}\s?\d{3}\s?\d{4}/.test(m[1].replace(/<[^>]+>/g, ""))) { bad("call", "Anruf-Knopf ohne ausgeschriebene Nummer"); break; }
  }
  if (where.startsWith("objekt/")) {
    if (!/id="anfragen"/.test(html)) bad("expose", "Formular-Anker fehlt");
    if (!/href="#anfragen"/.test(html)) bad("expose", "Kein Sprung-Knopf zum Formular");
    if (!/Stand:\s*\d{2}\.\d{2}\.\d{4}/.test(html)) bad("stand", "Datenstand fehlt");
    if (!/Käuferprovision:\s*(provisionsfrei|provisionspflichtig|auf Anfrage|\d)/.test(html)) bad("provision", "Provision ohne Angabe");
  }
  if (/\bLive[- ](MCP|Kaufangebote|Stand|ai\/)/.test(html)) bad("live", "„Live“ behauptet Echtzeit");
  return out;
}
