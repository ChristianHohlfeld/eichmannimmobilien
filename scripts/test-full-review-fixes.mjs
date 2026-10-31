// Full-Review 10.10.2026: P1 EN-Flyer, P2 WA-Bubble mobil, P3 kein leeres <img src="">, P4 Mobil-Leiste auf allen Seiten.
import { readFileSync, readdirSync, existsSync } from "node:fs";
const fail = [];
const ok = (c, m) => { if (!c) fail.push(m); };
const pages = ["", "objekt", "en", "en/property"].flatMap((d) => readdirSync(d || ".").filter((f) => f.endsWith(".html")).map((f) => (d ? d + "/" : "") + f))
  .filter((f) => !/^(admin|mcp-static)/.test(f) && !/google[0-9a-f]+\.html|^BingSiteAuth/.test(f));
for (const f of pages) {
  const s = readFileSync(f, "utf8");
  if (/http-equiv="refresh"/i.test(s)) continue;
  ok(/<nav class="sticky-bar[^"]*"/.test(s), `${f}: Mobil-Leiste fehlt`);
  const bar = s.match(/<nav class="sticky-bar[\s\S]*?<\/nav>/)?.[0] || "";
  ok(/href="tel:\+491705225568"/.test(bar) && /wa\.me\/491705225568/.test(bar), `${f}: Leiste ohne Anrufen/WhatsApp`);
  ok(!/<img[^>]*\ssrc=""/.test(s), `${f}: leeres <img src="">`);
  ok(!/id="flyerModal"|href="#flyerModal"|data-open-flyer/.test(s), `${f}: Flyer-Pop-up-Rest (entfernt 31.10.2026)`);
}
// Flyer-Pop-up entfernt (31.10.2026): EN-Allmannsdorf ohne Flyer, Bild führt zum Inline-Formular
const en = readFileSync("en/allmannsdorf.html", "utf8");
ok(!/data-flyer-src=/.test(en) && /href="#register"/.test(en) && /id="register"/.test(en), "EN-Allmannsdorf: Flyer-Rest oder kein Link zum Formular");
ok(!existsSync("partials/flyer-modal-en.html") && !existsSync("partials/flyer-modal.html"), "Flyer-Partials noch vorhanden");
ok(!readFileSync("js/main.js", "utf8").includes(`'<img src="" alt="">'`), "main.js erzeugt noch <img src=\"\">");
const css = readFileSync("css/styles.css", "utf8");
ok(/full-review-p2[\s\S]*max-width: 768px[\s\S]*\.floating-wa, body\.cookie-banner-open \.floating-wa \{ display: none !important; \}/.test(css), "WA-Bubble mobil nicht ausgeblendet");
if (fail.length) { console.error("✗ full-review-fixes\n" + fail.join("\n")); process.exit(1); }
console.log(`✓ full-review-fixes: ${pages.length} Seiten (Leiste, kein leeres img, kein Flyer-Pop-up), EN ohne Flyer, WA-Bubble`);
