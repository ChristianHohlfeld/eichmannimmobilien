// Kanonische Projektseite "Sunside Living" (Konstanz-Wollmatingen).
// Inhalt ausschliesslich aus den öffentlichen Listings (Immowelt-SoT): Titel, Preis, Zimmer, Fläche.
// Keine Aussagen zu Bauantrag/Baubeginn/Genehmigung, keine Countdowns.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const SUNSIDE_PAGE = "sunside-living-wollmatingen.html";
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (p) => Number(String(p || "").replace(/[^\d,]/g, "").replace(",", ".")) || null;
const de = (n) => n.toLocaleString("de-DE") + " €";

export function sunsideUnits(listings, isPublic) {
  return (listings || [])
    .filter((l) => /sunside/i.test(l.title || "") && l.local_url && (!isPublic || isPublic(l)))
    .sort((a, b) => String(a.reference_number || "").localeCompare(String(b.reference_number || ""), "de", { numeric: true }));
}

export async function publishSunsidePage({ siteRoot, origin, listings, isPublic, dryRun }) {
  const units = sunsideUnits(listings, isPublic);
  if (!units.length) return null;
  const url = `${origin}/${SUNSIDE_PAGE}`;
  const prices = units.map((u) => num(u.price)).filter(Boolean);
  const min = Math.min(...prices);
  const title = "Sunside Living Wollmatingen Konstanz | Immobilien Eichmann";
  const desc = `Sunside Living Konstanz-Wollmatingen: ${units.length} Neubau-Eigentumswohnungen ab ${de(min)}, KfW 55. Vertrieb direkt über Immobilien Eichmann, +49 170 522 5568.`;
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "ApartmentComplex", "@id": `${url}#projekt`, name: "Sunside Living", url,
        description: "Neubau-Eigentumswohnungen (KfW 55) in Konstanz-Wollmatingen, Vertrieb durch Immobilien Eichmann.",
        address: { "@type": "PostalAddress", addressLocality: "Konstanz-Wollmatingen", postalCode: "78467", addressRegion: "Baden-Württemberg", addressCountry: "DE" },
        containsPlace: units.map((u) => ({ "@type": "Apartment", name: u.title, url: `${origin}/${u.local_url}`, numberOfRooms: num(u.rooms) || undefined,
          floorSize: num(u.living_area) ? { "@type": "QuantitativeValue", value: num(u.living_area), unitCode: "MTK" } : undefined })),
      },
      {
        "@type": "OfferCatalog", name: "Sunside Living – verfügbare Wohnungen", url,
        itemListElement: units.map((u) => ({ "@type": "Offer", name: u.title, url: `${origin}/${u.local_url}`, price: num(u.price), priceCurrency: "EUR",
          availability: "https://schema.org/InStock", businessFunction: "http://purl.org/goodrelations/v1#Sell",
          offeredBy: { "@id": `${origin}/#organization` }, seller: { "@type": "RealEstateAgent", name: "Immobilien Eichmann", url: `${origin}/`, telephone: "+491705225568", email: "info@immobilien-eichmann.com",
            address: { "@type": "PostalAddress", streetAddress: "Jacob-Burckhardt-Str. 40", postalCode: "78464", addressLocality: "Konstanz", addressCountry: "DE" } } })),
      },
      { "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: `${origin}/` },
        { "@type": "ListItem", position: 2, name: "Projekte", item: `${origin}/projekte.html` },
        { "@type": "ListItem", position: 3, name: "Sunside Living Wollmatingen", item: url } ] },
    ],
  };
  const tpl = await readFile(path.join(siteRoot, "projekte.html"), "utf8");
  let head = tpl.slice(0, tpl.indexOf("<main>"));
  const foot = tpl.slice(tpl.indexOf("</main>"));
  head = head
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*/, `$1${esc(desc)}`)
    .replace(/(<link rel="canonical" href=")[^"]*/, `$1${url}`)
    .replace(/(<meta property="og:url" content=")[^"]*/, `$1${url}`)
    .replace(/(<meta (?:property="og:title"|name="twitter:title") content=")[^"]*/g, `$1${esc(title)}`)
    .replace(/(<meta (?:property="og:description"|name="twitter:description") content=")[^"]*/g, `$1${esc(desc)}`)
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, `<script type="application/ld+json">\n${JSON.stringify(ld, null, 2).replace(/</g, "\\u003c")}\n  </script>`)
    .replace(' class="active"', "");
  const rows = units.map((u) => `          <tr><td><a href="${esc(u.local_url)}">${esc(u.reference_number || u.title)}</a></td><td>${esc(u.rooms)}</td><td>${esc(u.living_area)}</td><td><strong>${esc(u.price)}</strong></td></tr>`).join("\n");
  const main = `<main>
    <section class="page-hero"><div class="container"><h1>Sunside Living – Neubau-Eigentumswohnungen in Konstanz-Wollmatingen</h1><p>Eigentumswohnung kaufen in Konstanz: ${units.length} verfügbare Wohnungen ab ${de(min)} · Vertrieb direkt über Immobilien Eichmann</p></div></section>
    <section class="section"><div class="container">
      <p><strong>Sunside Living</strong> ist ein Neubauprojekt mit Eigentumswohnungen (KfW 55, Energieeffizienzklasse A+) im Konstanzer Stadtteil Wollmatingen. Ansprechpartner für Beratung, Exposé und Besichtigung ist <strong>Immobilien Eichmann</strong> – Ihr Immobilienmakler in Konstanz, Helmut Eichmann, Jacob-Burckhardt-Str. 40, 78464 Konstanz.</p>
      <h2>Verfügbare Wohnungen und Kaufpreise</h2>
      <div class="table-wrap" style="overflow-x:auto"><table class="facts-table" style="width:100%;border-collapse:collapse">
        <thead><tr><th style="text-align:left">Wohnung</th><th style="text-align:left">Zimmer</th><th style="text-align:left">Wohnfläche</th><th style="text-align:left">Kaufpreis</th></tr></thead>
        <tbody>
${rows}
        </tbody></table></div>
      <p>Preise und Verfügbarkeit gemäß aktuellem Angebotsstand. Jede Wohnung hat ein eigenes Exposé mit Grundriss und Bildern.</p>
      <h2>Kontakt zu Sunside Living</h2>
      <p>Telefon <a href="tel:+491705225568">+49 170 522 5568</a> · E-Mail <a href="mailto:info@immobilien-eichmann.com">info@immobilien-eichmann.com</a></p>
      <p><a class="btn btn-primary" href="kontakt.html">Anfrage zu Sunside Living</a> <a class="btn" href="projekte.html">Alle Projekte &amp; Angebote</a></p>
      <p>Mehr: <a href="wollmatingen.html">Immobilien in Wollmatingen</a> · <a href="wohnung-kaufen-konstanz.html">Wohnung kaufen in Konstanz</a> · <a href="immobilienmakler-konstanz.html">Immobilienmakler Konstanz</a></p>
    </div></section>
  `;
  if (!dryRun) await writeFile(path.join(siteRoot, SUNSIDE_PAGE), head + main + foot, "utf8");
  console.log(`Updated ${SUNSIDE_PAGE} (${units.length} Einheiten)`);
  return { loc: `/${SUNSIDE_PAGE}`, priority: "0.9", changefreq: "weekly", images: [] };
}
