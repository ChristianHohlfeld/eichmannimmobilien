# Immobilien Eichmann – technische Architektur und Betrieb

Statische Website für **Immobilien Eichmann / Helmut Eichmann** in Konstanz.

- Produktion: **https://immobilieneichmann.de/**
- Repository: `ChristianHohlfeld/eichmannimmobilien`
- Branch für Produktion: `main`
- Hosting: **GitHub Pages**
- Anwendungsserver: **keiner**
- eigene Datenbank: **keine**
- produktiver Node-/PHP-/Python-Prozess: **keiner**

Stand dieser Dokumentation: **20.09.2026**.

---

## 1. Architektur in einem Satz

Die öffentliche Website besteht ausschließlich aus statischen HTML-, CSS-, JavaScript-, JSON- und Bilddateien auf GitHub Pages. Alles, was dynamisch wirkt, läuft entweder **im Browser**, über **GitHub API / GitHub Actions** oder über klar benannte Drittanbieter wie **FormSubmit**, **Immowelt** und – nach Consent – **Google Analytics**.

```text
Besucher
  |
  v
GitHub Pages / immobilieneichmann.de
  |
  +--> HTML + CSS + Vanilla JavaScript
  |
  +--> Kontakt-/Exposé-Anfrage
  |      Browser -> FormSubmit -> info@immobilien-eichmann.com
  |
  +--> Analytics nur nach Consent
  |      Browser -> Google Analytics 4
  |
  +--> Externe Links
         -> Immowelt / Google Maps

Admin-Browser
  |
  +--> GitHub REST API mit Sitzungs-PAT
  |      -> data/listings.json
  |      -> assets/listings/*
  |
  +--> repository_dispatch / workflow_dispatch
         -> GitHub Actions
         -> Renderer
         -> generierte HTML-Seiten / Sitemap
         -> Commit auf main
         -> GitHub Pages Deployment

GitHub Actions Cron
  |
  +--> Playwright -> öffentliches Immowelt-Profil
         -> Merge in data/listings.json
         -> Bilder lokal spiegeln
         -> HTML / Sitemap neu rendern
```

Es gibt **keinen eigenen Server**, auf dem eine Webanwendung dauerhaft läuft. GitHub-Actions-Runner sind nur kurzlebige Build-/Automationsmaschinen und gehören nicht zum produktiven Request-Pfad eines normalen Seitenaufrufs.

---

## 2. Frontend-Stack

Die Website ist bewusst ohne Frontend-Framework gebaut.

| Ebene | Technik |
|---|---|
| Markup | HTML5 |
| Styling | eine eigene CSS-Codebasis in `css/styles.css` |
| Browserlogik | Vanilla JavaScript |
| Build-Bundler | keiner |
| React/Vue/Angular | keiner |
| jQuery | keiner |
| CSS-Framework | keines |
| Webfonts | keine externen Google Fonts; System-Font-Stacks |
| Bilder | JPG, WebP, PNG, SVG |
| SEO | statische Meta-Tags, Open Graph, Twitter Cards, JSON-LD, Sitemap |
| Deployment | GitHub Pages aus `main` |

Die Browserlogik liegt hauptsächlich in:

- `js/main.js` – Navigation, Kontakt-/Exposé-Formulare, Flyer, Gallery, Lightbox, URL-Prefills
- `js/cookie-consent.js` – Consent-Speicherung und kontrolliertes Laden von Analytics
- `js/analytics.js` – Google Analytics 4 / `gtag.js`, Measurement ID `G-QVRRBPYNVM`

Für Objektseiten unter `/objekt/` wird über `window.__eichmannJsBase` sichergestellt, dass die gemeinsamen JavaScript-Dateien mit dem korrekten relativen Pfad geladen werden.

---

## 3. Node-/Build-Stack

Node wird **nicht auf dem Produktionsserver** benötigt, weil es keinen Produktionsserver gibt. Node wird nur lokal und in GitHub Actions für Generierung, Scraping, Bildverarbeitung und Tests verwendet.

`package.json` verlangt Node **>= 20**.

Direkte Dependencies:

| Paket | Verwendung | aktuell aufgelöst |
|---|---|---|
| `playwright` | Browser-Automation: Immowelt-Import und Browser-Regressionsprüfungen | 1.63.0 |
| `sharp` | Bildkonvertierung, Größenanpassung, Social-Share-Bilder | 0.33.5 |

Wichtige Befehle:

```bash
npm ci

npm run sync-immowelt
npm run sync-immowelt:render

npm run test:legal
npm run test:expose-form
npm run test:layout
npm run test:logo
npm run test:share
npm run test:jsonld
npm test
```

Für Playwright lokal:

```bash
npx playwright install chromium
```

---

## 4. Hosting, Domain und Serverfrage

### Haben wir einen eigenen Server?

**Nein.**

Es gibt keinen eigenen VPS, keinen Apache/Nginx, keinen Express-Server, kein PHP-FPM, keinen Application Container und keine selbst betriebene Datenbank für diese Website.

### Wo liegt die Website?

Die Dateien liegen im GitHub-Repository und werden von **GitHub Pages** statisch ausgeliefert.

Die Datei:

```text
CNAME
```

enthält:

```text
immobilieneichmann.de
```

Damit ist die Custom Domain der GitHub-Pages-Site zugeordnet.

Die DNS-Konfiguration selbst liegt **außerhalb dieses Repositories** beim jeweiligen DNS-Provider. Das Repository enthält keine Zugangsdaten zum DNS-Provider.

### Was passiert bei einem normalen Seitenaufruf?

1. DNS löst `immobilieneichmann.de` auf GitHub Pages auf.
2. GitHub Pages liefert fertige statische Dateien aus.
3. Der Browser führt `cookie-consent.js` und `main.js` aus.
4. Es findet **kein Request an einen eigenen Backend-Server** statt.
5. Drittanbieter werden nur für die jeweils beschriebenen Funktionen aufgerufen.

---

## 5. Verzeichnisstruktur

```text
/
├── .github/workflows/       GitHub-Actions-Automation
├── admin/                   statisches Exposé-Admin
├── assets/
│   ├── flyer/               Flyerbilder
│   ├── listings/            lokal gespeicherte Objektbilder
│   ├── logo*                Marken-/Header-Assets
│   └── share-card*          Social-Preview-Bilder
├── css/styles.css           gesamtes Public Styling
├── data/listings.json       kanonische Objektdaten / Single Source of Truth
├── js/
│   ├── main.js
│   ├── cookie-consent.js
│   └── analytics.js
├── objekt/*.html            generierte Objekt-/Exposé-Seiten
├── partials/                generierte HTML-Fragmente
├── scripts/                 Generatoren, Importer und Tests
├── index.html               Startseite
├── kontakt.html             allgemeines Kontaktformular
├── impressum.html
├── datenschutz.html
├── widerrufsbelehrung.html
├── vertrag-widerrufen.html
├── sitemap.xml
├── robots.txt
├── llms.txt
├── CNAME
├── .nojekyll
├── package.json
└── package-lock.json
```

---

## 6. Single Source of Truth für Immobilien

Die kanonische Datenquelle der Website ist:

```text
data/listings.json
```

Nicht Immowelt und nicht die generierten HTML-Seiten.

Top-Level-Struktur:

```json
{
  "sot": "local",
  "source": "...",
  "immowelt_profile": "...",
  "scraped_at": "...",
  "listing_count": 13,
  "listings": []
}
```

Typische Felder eines Listings:

- `id`
- `slug`
- `local_url`
- `title`
- `price`
- `location`
- `rooms`
- `living_area`
- `plot_area`
- `type`
- `status`
- `short_description`
- `description`
- `facts`
- `expose_url`
- `main_image_url`
- `images`
- `floor_plans`
- `image_base`
- `gallery_bases`
- `floor_plan_bases`
- `source`
- `immowelt_id`
- `sync_policy`
- `missing_on_immowelt`
- optional `manual_overrides`

Die HTML-Seiten unter `objekt/`, die Karten auf Start-/Projektseite und die Objekt-URLs in `sitemap.xml` werden daraus erzeugt.

---

## 7. Immowelt-Import

Immowelt ist **nur eine externe Inbound-Quelle**.

Das Immowelt-Konto wird von dieser Codebasis **niemals beschrieben**.

Quelle:

```text
https://www.immowelt.de/profil/3b18336c6a2e401da38e9cc20268270d
```

Importer:

```text
scripts/sync-immowelt.mjs
```

Workflow:

```text
.github/workflows/sync-immowelt.yml
```

### Ablauf eines normalen Full-Syncs

1. GitHub Actions startet einen kurzlebigen Ubuntu-Runner.
2. Node 20 und Dependencies werden installiert.
3. Playwright Chromium öffnet das öffentliche Immowelt-Profil.
4. Öffentliche Objektinformationen werden gelesen.
5. Soweit möglich werden Detailseiten für Beschreibung, Bilder, Grundrisse und Fakten angereichert.
6. Neue Daten werden gegen `data/listings.json` gemerged.
7. Objektbilder werden heruntergeladen.
8. Sharp erzeugt lokale JPG-/WebP-Versionen.
9. JSON wird aktualisiert.
10. Karten, Exposé-Seiten und Sitemap werden neu gerendert.
11. Geänderte Dateien werden auf `main` committed.
12. GitHub Pages deployed den neuen Stand.

### Zeitplan

Der Workflow läuft regulär:

```text
0 */3 * * *
```

also alle drei Stunden nach UTC.

Zusätzlich kann er manuell gestartet werden.

Wenn `scripts/sync-immowelt.mjs` oder der Workflow selbst geändert wird, wird auf Push **nur aus dem vorhandenen kanonischen JSON gerendert**, damit Templateänderungen ohne erneuten Live-Scrape sofort auf alle Objektseiten kommen.

### DataDome / Bot-Schutz

Immowelt kann automatisierte Browser mit DataDome/Captcha blockieren.

Darum ist der Import bewusst als **Soft-Fail** gebaut:

- bei Scrape-Fehlern bleibt das zuletzt gültige JSON erhalten
- die öffentliche Site wird nicht leergeräumt
- kein Login und kein Captcha-Bypass
- das Immowelt-Konto wird nicht verändert

### Merge-Regeln

Standard:

```text
sync_policy = independent
```

Bedeutung:

- neue Immowelt-ID -> kann lokal ergänzt werden
- vorhandene Objekte -> nur nicht manuell geschützte Felder werden aktualisiert
- `manual_overrides[field] = true` schützt einen Wert vor Immowelt-Überschreiben
- `source: local` ist lokal autoritativ
- auf Immowelt verschwundene Objekte werden standardmäßig **nicht automatisch gelöscht**
- stattdessen `missing_on_immowelt: true`
- nur `sync_policy: mirror` erlaubt Auto-Entfernung eines verknüpften, dort verschwundenen Objekts

---

## 8. Bilder

Objektbilder liegen persistent im Git-Repository:

```text
assets/listings/
```

Der Importer erzeugt in der Regel:

- JPG für breite Kompatibilität
- WebP für kleinere Übertragung
- separate Gallery-Dateien
- separate Grundriss-Dateien

Sharp übernimmt die Konvertierung.

Nicht mehr referenzierte, vom System verwaltete Objektbilder werden beim Rendern/Sync als Orphans erkannt und aufgeräumt.

Admin-Uploads werden zuerst per GitHub Contents API als Datei committed und danach in `data/listings.json` referenziert. Das ist ein zweistufiger Vorgang, keine Datenbanktransaktion.

---

## 9. Exposé-Anfrageflow

### Referenz: bi-bodenseeimmo

Der öffentliche Exposé-Flow von:

```text
https://www.bi-bodenseeimmo.de/
```

wurde am 20.09.2026 gegen aktuelle Objektseiten geprüft.

Die sichtbaren Personen-/Adressfelder des Eichmann-Exposé-Flows entsprechen diesem Referenzflow:

1. **Anrede*** – Select
2. **Vorname***
3. **Name***
4. **Straße und Hausnummer***
5. **PLZ***
6. **Ort***
7. **Telefonnummer** – optional
8. **E-Mail-Adresse***

Auf Eichmann-Exposé-Seiten gibt es bewusst **kein zusätzliches Freitext-Nachrichtenfeld**.

Die bi-bodenseeimmo-Seite zeigt zusätzlich eine Datenschutz-Einwilligungscheckbox. Diese wird hier **bewusst nicht kopiert**: die Eichmann-Site verwendet für die notwendige Anfragebearbeitung einen Datenschutzhinweis mit Link statt einer zusätzlichen Pflicht-Einwilligung.

Generiert wird der Flow zentral in:

```text
scripts/sync-immowelt.mjs
```

Dadurch gelten Änderungen automatisch für alle erzeugten Objektseiten.

### Versteckte technische Felder

Zusätzlich zu den sichtbaren Feldern werden Objektkontext und Mail-Metadaten mitgegeben:

- `anliegen = Exposé-Anfrage`
- `objekt`
- `objekt_url`
- `_subject`
- `_template = table`
- `_captcha = false`
- ein clientseitiges Honeypot-Feld `botcheck`

### Validierung

`js/main.js`:

1. trimmt Benutzereingaben
2. nutzt die nativen HTML-`required`-/E-Mail-Regeln
3. prüft mit `form.checkValidity()`
4. zeigt Browserfehler via `reportValidity()`
5. blockiert den clientseitigen Honeypot
6. sendet erst dann

Damit ist eine komplett leere Exposé-Anfrage technisch nicht mehr möglich.

Regressionstest:

```bash
npm run test:expose-form
```

Der Test startet Chromium, lädt eine generierte Exposé-Seite, prüft **Feldsatz, Reihenfolge, Required-Status, Payload und Success-UI** und mockt nur den externen FormSubmit-Transport.

### Warum kein automatischer echter Mailtest in GitHub Actions?

FormSubmit akzeptiert reguläre Browser-AJAX-Requests, blockiert aber automatisierte Requests aus GitHub-hosted Runnern mit Anti-Bot-/Rate-Limit-Verhalten; bei den realen Cloud-Runner-Probes wurde HTTP 403 beobachtet.

Deshalb ist ein GitHub-Runner kein verlässlicher Test für tatsächliche Endkunden-Browserzustellung.

Der stabile CI-Test prüft unseren kompletten Browsercode bis zur externen Transportgrenze. Ein echter Zustellungstest muss bei Bedarf aus einem normalen Browser auf der Produktionsdomain durchgeführt und im Zielpostfach kontrolliert werden.

---

## 10. Allgemeines Kontaktformular

`kontakt.html` ist vom Exposé-Flow getrennt.

Pflichtfelder:

- Name
- E-Mail
- Nachricht

Optional:

- Telefon
- Betreff/Anliegen-Auswahl

Auch hier:

- Whitespace wird entfernt
- native Validierung läuft
- komplett leere Anfragen werden blockiert
- kein Datenschutz-Pflicht-Haken
- Datenschutzhinweis mit Link
- Hinweis: durch Absenden kommt kein Maklervertrag zustande

---

## 11. Wie E-Mails tatsächlich verschickt werden

Es gibt **keinen eigenen SMTP-Server** und keine Mailbibliothek im Repository.

Der produktive Browsercode verwendet:

```text
https://formsubmit.co/ajax/info@immobilien-eichmann.com
```

### Normaler JavaScript-Pfad

`js/main.js` ruft per `fetch()` auf:

```text
Browser
  -> HTTPS JSON POST
  -> FormSubmit
  -> E-Mail an info@immobilien-eichmann.com
```

Erwartete Antwort:

```json
{ "success": true }
```

Bei Erfolg:

- Erfolgsbox wird eingeblendet
- Formular wird zurückgesetzt

Bei Fehler:

- Fehlerbox wird eingeblendet
- Nutzer kann über den Mailto-Fallback sein lokales Mailprogramm öffnen

### Fallback ohne JavaScript

Die HTML-Formulare besitzen zusätzlich ein normales `action="https://formsubmit.co/..."` und `method="POST"`.

Wenn die JavaScript-Abfanglogik nicht läuft, kann der Browser damit weiterhin klassisch an FormSubmit posten.

### Aktivierung

FormSubmit verlangt bei einer neu verwendeten Empfängeradresse eine einmalige Bestätigung per E-Mail.

### Wo werden Anfrage-Daten gespeichert?

**Nicht in unserer eigenen Website und nicht in `data/listings.json`.**

Unsere Codebasis schreibt Kontakt-/Exposé-Anfragen:

- nicht ins GitHub-Repository
- nicht in Local Storage
- nicht in Session Storage
- nicht in eine eigene Datenbank

FormSubmit verarbeitet die Anfrage als externer Form-Backend-Anbieter und dokumentiert für sein Submission-Archiv eine Aufbewahrung von **30 Tagen**.

Danach existiert die Anfrage außerdem als E-Mail im Zielpostfach, abhängig von den dortigen Mailbox-/Retention-Einstellungen.

### Wo liegt das Zielpostfach?

Empfänger:

```text
info@immobilien-eichmann.com
```

Die konkrete Mailbox-/MX-Infrastruktur dieser Adresse wird **nicht in diesem Repository konfiguriert**. Sie gehört zum externen E-Mail-/DNS-Provider der Domain `immobilien-eichmann.com`.

Wichtig: Website-Domain und Mail-Domain sind verschieden:

```text
Website: immobilieneichmann.de
E-Mail:  immobilien-eichmann.com
```

GitHub Pages hostet die Website, **nicht das E-Mail-Postfach**.

---

## 12. Datenschutz- und Consent-Runtime

Consent-Code:

```text
js/cookie-consent.js
```

Browser-Key:

```text
eichmann_cookie_consent_v1
```

Gespeichert wird in `localStorage`:

```json
{
  "necessary": true,
  "analytics": false,
  "ts": 0
}
```

Es wird also nur die Consent-Entscheidung lokal im Browser gespeichert.

### Google Analytics

Analytics wird **nicht beim ersten Seitenaufruf automatisch geladen**.

Nur wenn der Nutzer „Alle akzeptieren“ wählt:

1. `cookie-consent.js` lädt `js/analytics.js`
2. `analytics.js` lädt Googles `gtag.js`
3. GA4 startet mit Measurement ID `G-QVRRBPYNVM`

Ohne Analytics-Consent wird `googletagmanager.com` von unserer Analytics-Logik nicht geladen.

### Google Fonts

Keine externen Google Fonts.

Die Website verwendet lokale/System-Font-Stacks. Dadurch entsteht beim normalen Rendern kein Fonts-Request an Google.

### Google Maps

Es gibt keinen automatisch geladenen Maps-Iframe.

Auf der Kontaktseite gibt es nur einen externen Link. Erst wenn der Nutzer ihn anklickt, wird Google Maps geöffnet.

---

## 13. Admin-System

URL:

```text
https://immobilieneichmann.de/admin/
```

Das Admin ist **selbst ebenfalls nur statisches HTML/CSS/JavaScript auf GitHub Pages**.

Es gibt keinen Admin-Backend-Server und keine Server-Session.

### Aktueller Login-Modus

`admin/config.json`:

```text
auth_mode = password_plus_session_pat
```

Login benötigt:

1. freigeschaltete E-Mail-Adresse
2. Admin-Passwort
3. GitHub Personal Access Token für diese Browser-Sitzung

Die E-Mail-Allowlist und der SHA-256-Hash des Admin-Passworts liegen im öffentlichen statischen Config-File.

Das bedeutet bewusst:

> Der Passwort-Check ist kein serverseitiger Sicherheitsperimeter.

Die eigentliche Schreibberechtigung erzwingt **GitHub über den PAT**.

### PAT

Der GitHub-PAT wird beim Login in:

```text
sessionStorage["ei_admin_github_pat"]
```

gespeichert.

Zusätzlich gibt es:

```text
sessionStorage["ei_admin_auth"]
```

für den UI-Loginzustand.

Beim Logout wird der PAT aus dem Session Storage entfernt.

Der aktuelle `admin/config.json` enthält **keinen Klartext-GitHub-Token und keinen versiegelten Token**.

`admin/seal-token.mjs` unterstützt weiterhin ein optionales/Legacy-Verfahren mit:

- PBKDF2 SHA-256
- 120.000 Iterationen
- AES-256-GCM

Dieses Verfahren ist aktuell **nicht der aktive Login-Pfad**.

### GitHub API

Der Browser spricht direkt mit:

```text
https://api.github.com/repos/ChristianHohlfeld/eichmannimmobilien
```

Der PAT wird als Bearer Token gesendet.

Es gibt keinen Proxy dazwischen.

---

## 14. Admin-Speicherflow

### Objekt bearbeiten

Primärer Pfad:

```text
Admin-Browser
  -> GET data/listings.json + SHA über GitHub Contents API
  -> Benutzer ändert Felder
  -> PUT data/listings.json mit bisherigem SHA
  -> GitHub Commit
  -> repository_dispatch admin_apply_render
  -> GitHub Action rendert
  -> Commit generierte Outputs
  -> GitHub Pages Deployment
```

Die Verwendung des aktuellen File-SHA ist eine einfache Form von Optimistic Concurrency: ein offensichtlich veralteter Stand kann von GitHub mit Konflikt abgewiesen werden.

### Fallback

Wenn der direkte Contents-API-Save fehlschlägt:

```text
repository_dispatch: admin_save_listings
```

Dann schreibt `admin-save.yml` die komplette vom Browser gesendete JSON-Datei und rendert anschließend.

Dieser Fallback ist funktional, aber **keine transaktionale Multi-User-Datenbank**. Gleichzeitiges Bearbeiten durch mehrere Admins sollte vermieden werden.

### Neues Objekt

Das Admin erzeugt:

- neue UUID
- stabilen Slug
- lokalen Datensatz
- `source: local`
- `sync_policy: independent`
- `manual_overrides` für manuell gepflegte Felder

Eine optionale Immowelt-URL/UUID kann als Inbound-Verknüpfung hinterlegt werden.

### Löschen

Löschen entfernt den Datensatz aus `data/listings.json`.

Der anschließende Render entfernt:

- die nicht mehr benötigte `objekt/{slug}.html`
- systemverwaltete orphaned Bilder, soweit sie nicht mehr referenziert sind
- die Objekt-URL aus der Sitemap

### Foto-Upload

1. Browser liest die Datei als Base64.
2. GitHub Contents API committed die Datei nach `assets/listings/`.
3. Das Listing bekommt die neue Bildreferenz.
4. `data/listings.json` wird committed.
5. Render läuft.

Maximale vom Admin akzeptierte Uploadgröße: ungefähr **4,5 MB**.

Erlaubte Dateitypen im aktuellen Adminpfad:

- JPG/JPEG
- PNG
- WebP

---

## 15. Manuelle Overrides

Wird ein Feld im Admin manuell verändert, schreibt das Admin:

```json
"manual_overrides": {
  "title": true,
  "price": true,
  "updated_at": "..."
}
```

Der Immowelt-Importer respektiert diese Locks.

Geschützte Feldgruppen umfassen unter anderem:

- Titel
- Preis
- Ort
- Zimmer
- Wohn-/Grundstücksfläche
- Typ
- Status
- Kurzbeschreibung
- Beschreibung
- Bilder/Gallery
- Grundrisse
- Fakten
- Hauptbild

So bleibt lokal gepflegter Inhalt autoritativ.

---

## 16. GitHub-Actions-Pipelines

### `sync-immowelt.yml`

Aufgabe:

- regelmäßiger öffentlicher Immowelt-Import
- manueller Sync
- Render-only
- Generatoränderungen auf Push neu ausrollen

Schreibziel:

- `data/listings.json`
- `assets/listings/`
- `partials/listings-grid.html`
- `index.html`
- `projekte.html`
- `objekt/`
- `sitemap.xml`

### `admin-save.yml`

Aufgabe:

- Admin-`repository_dispatch` empfangen
- JSON speichern oder nur rendern
- generierte Outputs committen
- optional Immowelt-Workflow anstoßen

Events:

- `admin_save_listings`
- `admin_apply_render`
- `admin_trigger_sync`

### `apply-legal-baseline.yml`

Wird ausgeführt, wenn die Legal-Baseline selbst geändert wird.

Ablauf:

1. Baseline anwenden
2. Legal-/Privacy-Regressionsprüfung
3. Dependencies installieren
4. Playwright installieren
5. Layout prüfen
6. Änderungen gegebenenfalls committen

### `layout-regression.yml`

Hard Gate für relevante Frontendänderungen.

Prüft:

- Legal-/Privacy-Baseline
- Exposé-Formular-Feldsatz und Payload
- Desktop-Layout
- Mobile-Layout
- Horizontal Overflow
- Header/Logo
- Flyer-Geometrie
- Kontaktformular kann leer nicht absenden

Screenshots werden als GitHub-Actions-Artefakt hochgeladen.

### `logo-consistency.yml`

Prüft Logo-Dateien, Versionierung und bekannte Fehlerbilder.

Der Logo-Test selbst läuft aktuell standardmäßig soft; die Header-Logo-Sicherheitsversion ist:

```text
assets/logo-header.svg?v=header-safe-v1
```

Der zusätzliche rechte SVG-Viewport verhindert, dass das letzte `N` im Header wieder abgeschnitten wird.

### `share-card.yml`

Auf jedem Push/PR:

```bash
npm run test:share
```

Prüft unter anderem:

- 1200 × 630
- JPEG
- Dateigröße
- korrekte OG-/Twitter-Referenzen
- keine Abweichung vom freigegebenen Plain-Bild

### `refresh-share-card.yml`

Nur bei Änderungen am Refresh-Script/Workflow.

Lädt das freigegebene Immobilienbild, erzeugt 1200 × 630 und schreibt:

- `share-card-source-plain-v2.jpg`
- `share-card-plain-v2.jpg`
- Legacy-Dateien

Es werden **kein Text und kein Logo-Overlay** hinzugefügt.

### GitHub Pages Deployment

Das Pages-Build-/Deploy ist ein GitHub-eigener Workflow und liegt deshalb nicht zwingend als eigene YAML-Datei in diesem Verzeichnis.

Jeder relevante Commit auf `main` wird anschließend über GitHub Pages veröffentlicht.

---

## 17. Tests

### Gesamtsuite

```bash
npm test
```

### Einzeltests

```bash
npm run test:share
npm run test:logo
npm run test:jsonld
npm run test:legal
npm run test:layout
npm run test:expose-form
```

### Legal-/Privacy-Test

`scripts/test-legal-baseline.mjs` prüft unter anderem:

- keine externen Google Fonts
- kein automatisch eingebettetes Google Maps
- keine ausgeschaltete native Formvalidierung
- keine Legal-Platzhalter
- keine unnötige Datenschutz-Pflichtcheckbox
- Impressumsbehörde vorhanden
- Datenschutz nennt reale eingesetzte Dienste
- Widerruf enthält 14-Tage-Regel und keine alte 30-Tage-Fassung
- generierte Objektseiten nutzen Consent-Gate
- Header-Logo-Sicherheitsversion bleibt erhalten

### Exposé-Flow-Test

`scripts/test-expose-form.mjs` prüft mit echtem Chromium unseren kompletten Browserflow, wobei nur der externe FormSubmit-Endpunkt kontrolliert gemockt wird.

Das verhindert, dass externe Anti-Bot-Systeme einen CI-Build zufällig rot machen.

---

## 18. Social Sharing

Root-Seiten verwenden:

```text
https://immobilieneichmann.de/assets/share-card-plain-v2.jpg
```

Maße:

```text
1200 × 630
```

Das Bild ist bewusst **plain**, ohne zusätzlichen Text und ohne zusätzliches Logo.

Generierte Objektseiten verwenden nach Möglichkeit das jeweilige Immobilienbild als Social Preview und fallen sonst auf die allgemeine Share-Card zurück.

---

## 19. SEO / strukturierte Daten

Vorhanden:

- `robots.txt`
- `sitemap.xml`
- Canonical URLs
- Open Graph
- Twitter Card Meta
- JSON-LD
- `llms.txt`

`robots.txt` erlaubt die öffentliche Site und disallowt `/admin/` für Crawler.

Wichtig: `robots.txt` ist **keine Zugriffskontrolle**.

---

## 20. Drittanbieter und externe Abhängigkeiten

| Dienst | Wann aufgerufen | Zweck | Welche Daten |
|---|---|---|---|
| GitHub Pages | jeder Seitenaufruf | statisches Hosting/CDN | normale HTTP-Verbindungsdaten |
| GitHub REST API | nur Admin-Nutzung | Listings/Bilder lesen und schreiben, Workflows dispatchen | Repo-Daten + PAT im Request |
| GitHub Actions | Cron, Push, Admin-Dispatch | Scrape, Render, Tests, Bildverarbeitung | Repo-/Build-Daten |
| FormSubmit | Kontakt-/Exposé-Submit | Form-Backend und E-Mail-Weiterleitung | vom Nutzer eingegebene Formulardaten |
| Immowelt | automatischer Import / externe Links | öffentliche Objektquelle | öffentliche Objektdaten |
| Google Analytics 4 | nur nach Analytics-Consent | Statistik | Analytics-/Browserdaten nach Google-Konfiguration |
| Google Maps | nur nach Nutzer-Klick | externe Kartenansicht | erst nach Öffnen von Google |
| npm Registry | nur Build/Install | Playwright/Sharp installieren | Build-Metadaten |

Nicht vorhanden:

- eigener Backend-Server
- eigene SQL-/NoSQL-Datenbank
- WordPress
- PHP
- serverseitiges Session-System
- eigenes SMTP
- externe Google Fonts
- automatisch eingebettetes Google Maps
- Schreibzugriff auf Immowelt

---

## 21. Welche Daten liegen wo?

| Daten | Speicherort |
|---|---|
| statische Website | GitHub Repository + GitHub Pages |
| Immobilien-Stammdaten | `data/listings.json` im Git-Repo |
| Objektbilder | `assets/listings/` im Git-Repo |
| generierte Exposés | `objekt/*.html` im Git-Repo |
| Kontakt-/Exposé-Eingaben | nicht im eigenen Repo; Transport über FormSubmit |
| FormSubmit Submission-Archiv | bei FormSubmit, laut deren Doku 30 Tage |
| zugestellte Anfragen | Ziel-Mailbox `info@immobilien-eichmann.com` |
| Analytics-Daten | Google Analytics, nur nach Consent |
| Consent-Auswahl | Browser-`localStorage` |
| Admin-PAT | Browser-`sessionStorage` |
| Admin-Passwort | nicht persistent im Browser; nur Hash liegt öffentlich in Config |
| Git-Historie | GitHub |
| CI-Logs/Artefakte | GitHub Actions |

---

## 22. Sicherheit und Grenzen

### Was schützt das Admin wirklich?

Nicht der HTML-Login allein.

Da das Admin vollständig statisch ist, kann jeder Besucher seinen JavaScript-Code lesen.

Der tatsächliche Schreibschutz ist GitHub:

- ohne gültigen PAT keine GitHub-Schreiboperation
- Token sollte minimal berechtigt sein
- Token nie committen
- bei Leak sofort bei GitHub widerrufen

### Gleichzeitige Bearbeitung

Es gibt keine transaktionale Datenbank und kein eigenes Locking-System.

Der normale Contents-API-Save nutzt den letzten bekannten SHA und erkennt dadurch viele Stale-Write-Situationen.

Der Fallback `admin_save_listings` kann jedoch die komplette JSON aus dem Browserzustand schreiben. Daher sollte das Admin nicht von mehreren Personen gleichzeitig am selben Objekt benutzt werden.

### Formulare

Die Browservalidierung verhindert normale leere Submits.

Da Client-Code grundsätzlich manipulierbar ist, ist das keine serverseitige Trust-Grenze. FormSubmit ist der externe Backend-Dienst und übernimmt den tatsächlichen Empfang.

---

## 23. Lokale Entwicklung

```bash
git clone <repo>
cd eichmannimmobilien
npm ci
npx playwright install chromium
```

Einfacher Static Server:

```bash
npx serve .
```

Danach zum Beispiel:

```text
http://localhost:3000/
http://localhost:3000/admin/
```

Nur rendern, ohne Immowelt live zu lesen:

```bash
node scripts/sync-immowelt.mjs --render-only
```

Live-Import:

```bash
node scripts/sync-immowelt.mjs
```

Seed aus anderer JSON:

```bash
node scripts/sync-immowelt.mjs --from-json /pfad/datei.json
```

---

## 24. Betrieb: typische Änderungen

### Objekttext ändern

Bevorzugt über `/admin/`.

Resultat:

```text
Admin -> GitHub JSON -> Render Action -> Commit -> Pages
```

### Neues Objekt von Immowelt übernehmen

Immowelt-Workflow manuell starten oder nächsten 3-Stunden-Lauf abwarten.

### Neues lokales Objekt

Im Admin „+ Neues Objekt“.

### Template aller Exposé-Seiten ändern

`scripts/sync-immowelt.mjs` ändern und pushen.

Der Push-Trigger rendert alle Objektseiten aus `data/listings.json` neu.

### Analytics ändern

`js/analytics.js` und gegebenenfalls `datenschutz.html` anpassen.

### Kontakttransport ändern

Mindestens prüfen/anpassen:

- `js/main.js`
- Formular-`action` in `kontakt.html`
- Exposé-Template in `scripts/sync-immowelt.mjs`
- `datenschutz.html`
- `scripts/test-expose-form.mjs`
- `scripts/test-legal-baseline.mjs`

### Logo ändern

Header verwendet die crop-sichere Datei `assets/logo-header.svg`.

Logoänderungen immer gemeinsam mit `scripts/test-logo-consistency.mjs` prüfen.

---

## 25. Wichtige externe Dokumentation

- GitHub Pages: https://docs.github.com/pages
- GitHub REST API: https://docs.github.com/rest
- GitHub Actions: https://docs.github.com/actions
- FormSubmit: https://formsubmit.co/documentation
- FormSubmit AJAX: https://formsubmit.co/ajax-documentation
- Immowelt: https://www.immowelt.de/
- Google Analytics: https://developers.google.com/analytics
- Playwright: https://playwright.dev/
- Sharp: https://sharp.pixelplumbing.com/

---

## 26. Entscheidende Architekturregeln

1. **`data/listings.json` ist die Single Source of Truth.**
2. **Immowelt ist nur Inbound und wird nie beschrieben.**
3. **Generierte HTML-Seiten nicht als Primärdaten behandeln.**
4. **Kein eigenes Backend erfinden, solange GitHub Pages + GitHub Actions ausreichend sind.**
5. **Keine Secrets in statische Dateien oder ins Repo.**
6. **Admin-PAT nur in der Browser-Sitzung.**
7. **FormSubmit ist externer Mailtransport; Anfragen gehören nicht ins Git-Repo.**
8. **Analytics niemals vor Consent laden.**
9. **Objekt-Templateänderungen immer zentral im Generator durchführen.**
10. **Nach Änderungen Tests und Pages-Deployment prüfen.**
