#!/usr/bin/env node
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFile(path.join(ROOT, p), "utf8");
const write = (p, s) => writeFile(path.join(ROOT, p), s, "utf8");

async function htmlFiles() {
  const out = [];
  async function walk(dir) {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      if ([".git","node_modules","test-results"].includes(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile() && full.endsWith(".html")) out.push(full);
    }
  }
  await walk(ROOT);
  return out;
}

function stripGoogleFonts(s) {
  return s
    .replace(/\s*<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com"\s*\/?>\s*/g, "\n")
    .replace(/\s*<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin\s*\/?>\s*/g, "\n")
    .replace(/\s*<link href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]+" rel="stylesheet"\s*\/?>\s*/g, "\n");
}

function replaceDataConsent(s, prefix) {
  const notice = '<p class="form-note legal-request-note">Informationen zur Verarbeitung Ihrer Angaben finden Sie in der <a href="' + prefix + 'datenschutz.html">Datenschutzerklärung</a>. Durch das Absenden kommt kein Maklervertrag zustande.</p>';
  return s.replace(
    /<div class="form-group form-consent">\s*<label class="consent-label"[^>]*>\s*<input[^>]*name="datenschutz"[\s\S]*?<\/label>\s*<\/div>/g,
    notice
  );
}

function removePrivacyAck(s) {
  const start = '<div class="form-group form-consent privacy-ack">';
  while (s.includes(start)) {
    const a = s.indexOf(start);
    const b = s.indexOf("</div>", a);
    if (b < 0) break;
    s = s.slice(0, a) + s.slice(b + 6);
  }
  return s;
}

function useSafeHeaderLogo(s) {
  return s.replace(
    /(<img class="logo-svg" src=")((?:\.\.\/)?assets\/)logo\.(?:png|svg)\?v=[^"]+(")/g,
    '$1$2logo-header.svg?v=header-safe-v1$3'
  );
}

function replaceLegalCard(s, inner) {
  const marker = '<div class="legal-content content-card">';
  const start = s.indexOf(marker);
  if (start < 0) throw new Error("legal card start missing");
  const endMarker = '        </div>\n      </div>\n    </section>';
  const end = s.indexOf(endMarker, start);
  if (end < 0) throw new Error("legal card end missing");
  return s.slice(0, start) + marker + "\n" + inner + "\n" + s.slice(end);
}

for (const full of await htmlFiles()) {
  const rel = path.relative(ROOT, full).replaceAll("\\", "/");
  let s = await readFile(full, "utf8");
  s = stripGoogleFonts(s);
  s = s.replace(/\snovalidate(?=[\s>])/g, "");
  s = s.replaceAll("Einwilligung oder Maklervertrag in Textform zurücknehmen", "Maklervertrag in Textform widerrufen");
  const prefix = rel.startsWith("objekt/") ? "../" : "";
  s = replaceDataConsent(s, prefix);
  s = removePrivacyAck(s);
  s = s.replaceAll(
    'Mit dem Absenden werden Ihre Angaben zur Bearbeitung der Anfrage verarbeitet. Hinweise finden Sie in der <a href="' + prefix + 'datenschutz.html">Datenschutzerklärung</a>. Die Anfrage ist unverbindlich; durch das Absenden kommt kein Maklervertrag zustande.',
    'Informationen zur Verarbeitung Ihrer Angaben finden Sie in der <a href="' + prefix + 'datenschutz.html">Datenschutzerklärung</a>. Durch das Absenden kommt kein Maklervertrag zustande.'
  );
  s = useSafeHeaderLogo(s);
  s = s.replace(/js\/main\.js\?v=[^"]+/g, "js/main.js?v=form-guard-v2");
  await writeFile(full, s, "utf8");
}

{
  let s = await read("kontakt.html");
  const formBlurbStart = '<p class="form-note">Ihre Anfrage wird per Formular-Dienst (FormSubmit)';
  if (s.includes(formBlurbStart)) {
    const a = s.indexOf(formBlurbStart);
    const b = s.indexOf("</p>", a);
    if (b >= 0) s = s.slice(0, a) + s.slice(b + 4);
  }
  const mapNote = '<p class="form-note">Google Maps wird nicht automatisch geladen. Erst beim Öffnen des folgenden Links wird eine Verbindung zu Google hergestellt.</p>';
  s = s.replace(mapNote, "");
  const mapEmbedStart = '<div class="map-embed">';
  if (s.includes(mapEmbedStart)) {
    const a = s.indexOf(mapEmbedStart);
    const b = s.indexOf("</div>", a);
    if (b >= 0) s = s.slice(0, a) + s.slice(b + 6);
  }
  await write("kontakt.html", s);
}

{
  let s = await read("impressum.html");
  const inner = `      <h2>Diensteanbieter</h2>
      <p>Immobilien Eichmann<br>Helmut Eichmann<br>Einzelunternehmen<br>Jacob-Burckhardt-Str. 40<br>78464 Konstanz<br>Deutschland</p>

      <h2>Kontakt</h2>
      <p>Mobil: <a href="tel:+491705225568">0170 5225568</a><br>
      Telefon: <a href="tel:+4975319228848">07531 9228848</a><br>
      E-Mail: <a href="mailto:info@immobilien-eichmann.com">info@immobilien-eichmann.com</a><br>
      Internet: <a href="https://immobilieneichmann.de">immobilieneichmann.de</a></p>

      <h2>Berufsrechtliche Angaben</h2>
      <p>Tätigkeit als Immobilienmakler gemäß § 34c Abs. 1 Satz 1 Nr. 1 Gewerbeordnung (GewO).</p>
      <p>Zuständige Erlaubnis- und Aufsichtsbehörde:<br>
      Industrie- und Handelskammer Hochrhein-Bodensee<br>
      Reichenaustraße 21<br>
      78467 Konstanz<br>
      <a href="https://www.ihk.de/konstanz/" target="_blank" rel="noopener noreferrer">ihk.de/konstanz</a></p>

      <h2>Verantwortlich für Inhalte</h2>
      <p>Helmut Eichmann<br>Jacob-Burckhardt-Str. 40<br>78464 Konstanz</p>

      <h2>Urheberrecht</h2>
      <p>Die auf dieser Website veröffentlichten Inhalte, Bilder und sonstigen Werke unterliegen den jeweils anwendbaren urheberrechtlichen Bestimmungen. Eine Nutzung außerhalb der gesetzlichen Schranken bedarf der Zustimmung des jeweiligen Rechteinhabers.</p>`;
  s = replaceLegalCard(s, inner);
  await write("impressum.html", s);
}

{
  let s = await read("datenschutz.html");
  const inner = `      <h2>1. Verantwortlicher</h2>
      <p>Immobilien Eichmann<br>Helmut Eichmann<br>Einzelunternehmen<br>Jacob-Burckhardt-Str. 40<br>78464 Konstanz<br>
      Mobil: <a href="tel:+491705225568">0170 5225568</a><br>
      Telefon: <a href="tel:+4975319228848">07531 9228848</a><br>
      E-Mail: <a href="mailto:info@immobilien-eichmann.com">info@immobilien-eichmann.com</a></p>

      <h2>2. Bereitstellung der Website / GitHub Pages</h2>
      <p>Diese Website wird über GitHub Pages bereitgestellt. Beim Abruf verarbeitet der Hosting-Anbieter technisch erforderliche Verbindungsdaten, insbesondere IP-Adresse, Zeitpunkt und angeforderte Datei, um die Website auszuliefern und die Sicherheit des Dienstes zu gewährleisten. Rechtsgrundlage für unsere Nutzung des Hostings ist Art. 6 Abs. 1 lit. f DSGVO.</p>

      <h2>3. Kontakt, Anfragen und FormSubmit</h2>
      <p>Wenn Sie uns per Telefon oder E-Mail kontaktieren, verarbeiten wir die von Ihnen mitgeteilten Daten zur Bearbeitung Ihrer Anfrage. Bei objektbezogenen oder sonstigen geschäftlichen Anfragen erfolgt dies regelmäßig auf Grundlage von Art. 6 Abs. 1 lit. b DSGVO; im Übrigen auf Grundlage von Art. 6 Abs. 1 lit. f DSGVO.</p>
      <p>Das Kontakt- und Exposé-Formular nutzt <strong>FormSubmit</strong> (formsubmit.co). Beim Absenden werden die von Ihnen eingegebenen Formulardaten an diesen Dienst übertragen und anschließend per E-Mail an uns weitergeleitet. Wenn Sie diese Übermittlung nicht wünschen, können Sie uns stattdessen direkt per E-Mail oder Telefon kontaktieren.</p>
      <p>Anfragedaten speichern wir nur so lange, wie dies für die Bearbeitung und eine mögliche vorvertragliche oder vertragliche Abwicklung erforderlich ist. Gesetzliche Aufbewahrungspflichten bleiben unberührt.</p>

      <h2>4. Datenschutzauswahl und Google Analytics</h2>
      <p>Ihre Auswahl im Cookie-Hinweis wird im Local Storage Ihres Browsers gespeichert, damit die Website Ihre Entscheidung bei späteren Aufrufen berücksichtigen kann. Diese Speicherung dient ausschließlich der Verwaltung Ihrer Datenschutzeinstellung.</p>
      <p>Google Analytics 4 wird ausschließlich geladen, wenn Sie zuvor „Alle akzeptieren“ wählen. Anbieter ist Google Ireland Limited. Die Verarbeitung erfolgt auf Grundlage Ihrer Einwilligung gemäß Art. 6 Abs. 1 lit. a DSGVO; soweit Informationen auf Ihrem Endgerät gespeichert oder ausgelesen werden, gilt zusätzlich § 25 Abs. 1 TDDDG. Ohne Einwilligung wird Google Analytics nicht geladen. Ihre Auswahl können Sie jederzeit über „Cookie-Einstellungen“ im Footer ändern. Weitere Informationen: <a href="https://policies.google.com/privacy?hl=de" target="_blank" rel="noopener noreferrer">Datenschutzerklärung von Google</a>.</p>

      <h2>5. Schriftarten und Google Maps</h2>
      <p>Die Website lädt keine Google Fonts von Google-Servern. Es werden auf Ihrem Gerät verfügbare Systemschriftarten verwendet.</p>
      <p>Google Maps wird nicht automatisch in die Website eingebettet. Auf der Kontaktseite befindet sich lediglich ein externer Link. Erst wenn Sie diesen Link öffnen, verlassen Sie unsere Website und es gelten die Datenschutzbestimmungen von Google.</p>

      <h2>6. Externe Links</h2>
      <p>Die Website enthält Links zu externen Angeboten, insbesondere zu Immowelt und Google Maps. Beim bloßen Besuch unserer Website werden über solche Links keine Daten an den jeweiligen Anbieter übertragen. Erst beim Anklicken wird dessen Website aufgerufen.</p>

      <h2>7. Ihre Rechte</h2>
      <p>Sie haben nach Maßgabe der gesetzlichen Voraussetzungen insbesondere Rechte auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Datenübertragbarkeit und Widerspruch. Eine erteilte Einwilligung können Sie jederzeit mit Wirkung für die Zukunft widerrufen.</p>
      <p>Sie haben außerdem das Recht, sich bei einer Datenschutz-Aufsichtsbehörde zu beschweren. Für Baden-Württemberg: Der Landesbeauftragte für den Datenschutz und die Informationsfreiheit Baden-Württemberg, Heilbronner Straße 35, 70191 Stuttgart, <a href="https://www.baden-wuerttemberg.datenschutz.de/" target="_blank" rel="noopener noreferrer">baden-wuerttemberg.datenschutz.de</a>.</p>

      <h2>8. Stand</h2>
      <p>Stand: September 2026.</p>`;
  s = replaceLegalCard(s, inner);
  await write("datenschutz.html", s);
}

{
  let s = await read("widerrufsbelehrung.html");
  const main = `<main>
    <section class="page-hero">
      <div class="container page-hero-inner">
        <span class="eyebrow">Verbraucherrechte</span>
        <h1>Widerrufsbelehrung</h1>
        <p class="lead">Für Verbraucherverträge über Maklerdienstleistungen, wenn ein gesetzliches Widerrufsrecht besteht.</p>
      </div>
    </section>
    <section class="section">
      <div class="container narrow">
        <div class="content-card prose">
          <h2 style="margin-top:0">Widerrufsrecht</h2>
          <p>Sie haben das Recht, binnen vierzehn Tagen ohne Angabe von Gründen einen im Fernabsatz oder außerhalb von Geschäftsräumen geschlossenen Verbrauchervertrag über Maklerdienstleistungen zu widerrufen, soweit Ihnen gesetzlich ein Widerrufsrecht zusteht.</p>
          <p>Die Widerrufsfrist beträgt vierzehn Tage ab dem Tag des Vertragsabschlusses.</p>
          <p>Um Ihr Widerrufsrecht auszuüben, müssen Sie uns mittels einer eindeutigen Erklärung, zum Beispiel per Brief oder E-Mail, über Ihren Entschluss informieren:</p>
          <p><strong>Immobilien Eichmann</strong><br>Helmut Eichmann<br>Jacob-Burckhardt-Str. 40<br>78464 Konstanz<br>E-Mail: <a href="mailto:info@immobilien-eichmann.com">info@immobilien-eichmann.com</a><br>Telefon: <a href="tel:+491705225568">0170 5225568</a></p>
          <p>Zur Wahrung der Widerrufsfrist reicht es aus, dass Sie die Mitteilung über die Ausübung des Widerrufsrechts vor Ablauf der Frist absenden. Ein Muster finden Sie unter <a href="vertrag-widerrufen.html">Vertrag widerrufen</a>; seine Verwendung ist nicht vorgeschrieben.</p>
          <h3>Folgen des Widerrufs</h3>
          <p>Wenn Sie den Vertrag widerrufen, erstatten wir Ihnen alle Zahlungen, die wir von Ihnen aufgrund dieses Vertrags erhalten haben, unverzüglich und spätestens binnen vierzehn Tagen ab dem Tag, an dem Ihre Widerrufserklärung bei uns eingegangen ist. Für die Rückzahlung verwenden wir grundsätzlich dasselbe Zahlungsmittel, das Sie bei der ursprünglichen Transaktion eingesetzt haben, sofern nicht ausdrücklich etwas anderes vereinbart wurde.</p>
          <p>Haben Sie verlangt, dass die Dienstleistung bereits während der Widerrufsfrist beginnen soll, kann für die bis zum Widerruf bereits erbrachten Leistungen ein angemessener, anteiliger Betrag zu zahlen sein.</p>
          <h3>Erlöschen des Widerrufsrechts bei vollständiger Dienstleistung</h3>
          <p>Bei einem kostenpflichtigen Dienstleistungsvertrag kann das Widerrufsrecht mit vollständiger Vertragserfüllung erlöschen, wenn Sie vor Beginn der Leistung ausdrücklich zugestimmt haben, dass wir vor Ablauf der Widerrufsfrist mit der Leistung beginnen, und Sie Ihre Kenntnis davon bestätigt haben, dass Ihr Widerrufsrecht bei vollständiger Vertragserfüllung erlischt.</p>
        </div>
      </div>
    </section>
    <section class="section" style="padding-top:0">
      <div class="container narrow">
        <div class="content-card" style="text-align:center">
          <h2 style="margin-top:0;color:var(--ink)">Widerruf erklären</h2>
          <p style="color:var(--slate)">Ein Widerruf ist insbesondere per E-Mail oder Brief möglich. Eine Begründung ist nicht erforderlich.</p>
          <a class="btn btn-accent" href="vertrag-widerrufen.html">Muster &amp; Kontaktdaten</a>
        </div>
      </div>
    </section>
  </main>`;
  s = s.replace(/<main[\s\S]*?<\/main>/, main).replace("</main>footer class=", "</main>\n  <footer class=");
  await write("widerrufsbelehrung.html", s);
}

{
  let s = await read("vertrag-widerrufen.html");
  const main = `<main>
    <section class="page-hero">
      <div class="container page-hero-inner">
        <span class="eyebrow">Verbraucherrechte</span>
        <h1>Vertrag widerrufen</h1>
        <p class="lead">Widerruf eines bereits geschlossenen Maklervertrags per E-Mail oder Brief.</p>
      </div>
    </section>
    <section class="section">
      <div class="container narrow">
        <div class="content-card prose">
          <h2>Widerruf erklären</h2>
          <p>Für den Widerruf genügt eine eindeutige Erklärung. Eine Begründung ist nicht erforderlich. Sie können uns insbesondere per E-Mail oder Brief informieren.</p>
          <p><strong>Immobilien Eichmann</strong><br>Helmut Eichmann<br>Jacob-Burckhardt-Str. 40<br>78464 Konstanz<br>E-Mail: <a href="mailto:info@immobilien-eichmann.com">info@immobilien-eichmann.com</a></p>
          <h3>Muster-Widerrufsformular</h3>
          <p>Wenn Sie den Vertrag widerrufen wollen, können Sie folgenden Text verwenden:</p>
          <blockquote>Hiermit widerrufe ich den von mir abgeschlossenen Vertrag über die Erbringung der Maklerdienstleistung.<br><br>Name und Anschrift:<br>Betroffener Vertrag / Objekt:<br>Datum des Vertragsabschlusses:<br>Datum:</blockquote>
          <div class="hero-actions">
            <a class="btn btn-accent" href="mailto:info@immobilien-eichmann.com?subject=Widerruf%20Maklervertrag%20%E2%80%93%20Immobilien%20Eichmann&amp;body=Hiermit%20widerrufe%20ich%20den%20von%20mir%20abgeschlossenen%20Vertrag%20%C3%BCber%20die%20Erbringung%20der%20Maklerdienstleistung.%0A%0AName%3A%0AAnschrift%3A%0ABetroffener%20Vertrag%20%2F%20Objekt%3A%0AVertragsdatum%3A%0A%0ADatum%3A">Widerruf per E-Mail vorbereiten</a>
            <a class="btn btn-outline" href="widerrufsbelehrung.html">Widerrufsbelehrung lesen</a>
          </div>
        </div>
      </div>
    </section>
  </main>`;
  s = s.replace(/<main[\s\S]*?<\/main>/, main);
  s = s.replace("Widerruf eines Maklervertrags oder einer Einwilligung in Textform an Immobilien Eichmann, Konstanz.", "Widerruf eines Maklervertrags in Textform an Immobilien Eichmann, Konstanz.");
  await write("vertrag-widerrufen.html", s);
}

{
  let s = await read("css/styles.css");
  s = s.replace('--font-display: "Source Serif 4", "Georgia", "Times New Roman", serif;', '--font-display: Georgia, "Times New Roman", serif;');
  s = s.replace('--font-script: "Caveat", "Segoe Print", "Comic Sans MS", cursive;', '--font-script: "Segoe Print", "Bradley Hand", cursive;');
  s = s.replace('--font-body: "DM Sans", Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;', '--font-body: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;');
  await write("css/styles.css", s);
}

{
  let s = await read("js/main.js");
  const oldGuard = `      var bot = form.querySelector('[name="botcheck"]');
      if (bot && bot.checked) {
        show(success, true);
        return;
      }

      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      if (submitBtn) {`;
  const newGuard = `      ["name", "email", "message"].forEach(function (fieldName) {
        var field = form.querySelector('[name="' + fieldName + '"]');
        if (field && typeof field.value === "string") field.value = field.value.trim();
      });

      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      var bot = form.querySelector('[name="botcheck"]');
      if (bot && bot.checked) {
        return;
      }

      if (submitBtn) {`;
  s = s.replace(oldGuard, newGuard);
  await write("js/main.js", s);
}

{
  let s = await read("js/cookie-consent.js");
  s = s.replace("Notwendige Cookies brauchen wir für die Website. Statistik (Google Analytics) nur mit Ihrer Einwilligung.", "Technisch notwendige Speicherung verwenden wir nur für Ihre Datenschutzauswahl. Statistik (Google Analytics) nur mit Ihrer Einwilligung.");
  await write("js/cookie-consent.js", s);
}

{
  let s = await read("scripts/sync-immowelt.mjs");
  s = stripGoogleFonts(s);
  const privacyAckStart = '<div class="form-group form-consent privacy-ack">';
  while (s.includes(privacyAckStart)) {
    const a = s.indexOf(privacyAckStart);
    const b = s.indexOf("</div>", a);
    if (b < 0) break;
    s = s.slice(0, a) + s.slice(b + 6);
  }
  const exposeBlurbStart = '<p class="form-note">Wir senden Ihnen gerne weitere Unterlagen.';
  if (s.includes(exposeBlurbStart)) {
    const a = s.indexOf(exposeBlurbStart);
    const b = s.indexOf("</p>", a);
    if (b >= 0) s = s.slice(0, a) + s.slice(b + 4);
  }
  s = s.replace(/\snovalidate(?=[\s>])/g, "");
  s = s.replaceAll("Einwilligung oder Maklervertrag in Textform zurücknehmen", "Maklervertrag in Textform widerrufen");
  s = s.replace(
    /<div class="form-group form-consent">\s*<label class="consent-label"[^>]*>\s*<input[^>]*name="datenschutz"[\s\S]*?<\/label>\s*<\/div>/g,
    '<p class="form-note legal-request-note">Informationen zur Verarbeitung Ihrer Angaben finden Sie in der <a href="${p}datenschutz.html">Datenschutzerklärung</a>. Durch das Absenden kommt kein Maklervertrag zustande.</p>'
  );
  s = s.replace(/<img class="logo-svg" src="${p}assets\/logo\.(?:png|svg)\?v=[^"]+"/g, '<img class="logo-svg" src="${p}assets/logo-header.svg?v=header-safe-v1"');
  s = s.replace(/js\/main\.js\?v=[^"]+/g, 'js/main.js?v=form-guard-v2');
  s = s.replace(
    '  <script src="${p}js/analytics.js" defer></script>\n  <script src="${p}js/main.js?v=flyer-root-v1" defer></script>',
    '  <script>window.__eichmannJsBase="${p}js/";</script>\n  <script src="${p}js/cookie-consent.js?v=abs-datenschutz-v2" defer></script>\n  <script src="${p}js/main.js?v=form-guard-v2" defer></script>'
  );
  await write("scripts/sync-immowelt.mjs", s);
}

console.log("Applied minimal legal/privacy baseline.");
