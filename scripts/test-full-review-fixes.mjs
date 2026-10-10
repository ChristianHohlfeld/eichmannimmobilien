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
  if (/href="#flyerModal"/.test(s)) ok(/id="flyerModal"/.test(s), `${f}: #flyerModal verlinkt, aber kein Modal`);
}
const en = readFileSync("en/allmannsdorf.html", "utf8");
ok(/data-flyer-src="\/partials\/flyer-modal-en\.html\?v=/.test(en), "EN-Allmannsdorf lädt nicht den EN-Flyer");
ok(existsSync("partials/flyer-modal-en.html"), "partials/flyer-modal-en.html fehlt");
const p = readFileSync("partials/flyer-modal-en.html", "utf8");
ok(/name="lang" value="en"/.test(p) && /NEW-BUILD/.test(p) && !/Vormerken|Schließen|Anrufen/.test(p), "EN-Flyer nicht englisch");
ok(!/permit|construction start|building application|approval|countdown/i.test(p), "EN-Flyer verletzt harte Regeln");
ok(!readFileSync("js/main.js", "utf8").includes(`'<img src="" alt="">'`), "main.js erzeugt noch <img src=\"\">");
const css = readFileSync("css/styles.css", "utf8");
ok(/full-review-p2[\s\S]*max-width: 768px[\s\S]*\.floating-wa, body\.cookie-banner-open \.floating-wa \{ display: none !important; \}/.test(css), "WA-Bubble mobil nicht ausgeblendet");
if (fail.length) { console.error("✗ full-review-fixes\n" + fail.join("\n")); process.exit(1); }
console.log(`✓ full-review-fixes: ${pages.length} Seiten (Leiste, kein leeres img, Flyer-Anker), EN-Flyer, WA-Bubble`);
