## Listings SoT (SQLite)

- **Source of truth:** SQLite on the droplet at `/var/lib/eichmann/listings.db` (not in git, not in the web root). For Immowelt offers it holds the last complete, validated state read from **Immowelt** (the only source for them).
- **Origins:** `immowelt` (inbound sync only) and `eigen` (own listings via unified `/admin/#eigen`).
- Immowelt sync = **hard one-way takeover** via the official Immowelt SOAP API: every `origin=immowelt` row is overwritten completely (on/off, texts, prices, pictures, order), **no local overrides**; it **upserts/retires only `origin=immowelt`** and never touches `origin=eigen`.
- Sync runs **on the droplet**: `eichmann-immowelt-sync.timer` (minute :07 and :37) → `node scripts/immowelt-sync.mjs run` (`npm run sync-immowelt` calls the same). `scripts/sync-immowelt.mjs` is only the renderer now (`--render-only`, `--export-only`).
- Immowelt profile/account is **read-only** (no writes).
- `data/listings.json` and the rendered pages in this repository are **development fixtures** (export format, `"sot": "sqlite"`), not a source; an existing server database is never refilled from them (only a brand-new server without a database is seeded once).
- Publish: only as a complete, verified **release** under `/var/lib/eichmann/releases/<id>` with an atomic symlink switch (web root `/var/www/immobilieneichmann.de` → `releases/current`). `node scripts/publish-from-db.mjs`, admin saves and deploys (`node scripts/release.mjs build --reason deploy`) all build such a release from the DB; nothing renders into the served tree. (Local development / CI have no release layout; there the same code renders in place.)
- API key: `/var/lib/eichmann/secrets/immowelt-api.json` (mode 600, droplet only) – installed via the workflow “Immowelt API key → server” (Actions secret `IMMOWELT_API_KEY` → STDIN) or the admin form; never in the repository.
- Status: `data/immowelt-sync-status.json` (schema `eichmann.immowelt-sync-status/v2`), watched on the server (`eichmann-sync-watchdog.timer`) and externally (`immowelt-watchdog.yml`, switched on with the repository variable `IMMOWELT_WATCHDOG_ENABLED`).
- **Everything about the sync (architecture, key, rollout, rollback, alarm, verification): `docs/IMMOWELT-SYNC.md`.**
- **Admin:** https://immobilieneichmann.de/admin/ — Immowelt status/key + Eigen CRUD (Immowelt offers can no longer be hidden locally: `/visibility` answers 409 for `origin=immowelt`). Auth = email + password → HttpOnly cookie via `/admin/api/` (localhost Node). **No GitHub PAT.**
- Badge for eigen listings: **„nur bei uns“**.
- Node on droplet: **20.x** + `better-sqlite3`. App tooling: `/var/lib/eichmann/app`. Admin API unit: `eichmann-admin-api.service`.
- Stabschef note: `docs/STABSCHEF-admin-unified-2026-09-25.md`


# Immobilien Eichmann – technische Architektur und Betrieb

Statische Website für **Immobilien Eichmann / Helmut Eichmann** in Konstanz.

- Produktion: **https://immobilieneichmann.de/**
- Repository: `ChristianHohlfeld/eichmannimmobilien`
- Branch für Produktion: `main`
- Hosting: **DigitalOcean-Droplet `eichmann-web` mit nginx** (nicht GitHub Pages)
- Formular-Backend: **eigener, getrennter Gateway-Dienst auf dem bestehenden VPS**
- Datenbank: **SQLite für Angebote auf dem Droplet** (`/var/lib/eichmann/listings.db`); für Formulare keine
- produktiver Node-Prozess für Formulare: **`dp-forms.service` auf `forms.digitalisierungsplanung.de`**

Stand dieser Dokumentation: **20.09.2026**; Hosting, Immowelt-Abgleich, Bilder, Workflows und Betrieb aktualisiert am **11.11.2026**. Der Immowelt-Abgleich ist vollständig in `docs/IMMOWELT-SYNC.md` beschrieben.

---

## 1. Architektur in einem Satz

Die öffentliche Website selbst besteht aus statischen HTML-, CSS-, JavaScript-, JSON- und Bilddateien, die nginx auf dem Droplet `eichmann-web` ausliefert. Kontakt- und Exposé-Anfragen gehen an einen **eigenen, technisch getrennten Formular-Gateway-Dienst** unter `forms.digitalisierungsplanung.de`; weitere dynamische Abläufe laufen im Browser, über die Admin-API und den Immowelt-Abgleich auf dem Droplet oder über klar benannte Dienste wie Immowelt, Amazon SES und – nach Consent – Google Analytics.

```text
Besucher
  |
  v
nginx auf eichmann-web / immobilieneichmann.de
  |      Webroot -> /var/lib/eichmann/releases/current (vollständiges, geprüftes Release)
  |
  +--> HTML + CSS + Vanilla JavaScript
  |
  +--> Kontakt-/Exposé-Anfrage
  |      Browser -> forms.digitalisierungsplanung.de -> Amazon SES -> info@immobilien-eichmann.com
  |
  +--> Analytics nur nach Consent
  |      Browser -> Google Analytics 4
  |
  +--> Externe Links
         -> Immowelt / Google Maps

Admin-Browser
  |
  +--> /admin/api/ (nginx -> 127.0.0.1:3847, Session-Cookie, kein GitHub-PAT)
         -> SQLite /var/lib/eichmann/listings.db (eigene Inserate)
         -> neues Release bauen, prüfen, atomar umschalten

systemd-Timer auf dem Droplet (Minute :07 und :37)
  |
  +--> offizielle Immowelt-API (SOAP, nur lesend)
         -> vollständigen Bestand + jedes Exposé lesen und prüfen
         -> Bilder nach media/immowelt (inhaltsadressiert, nicht in Git)
         -> SQLite: Immowelt-Angebote hart überschreiben, eigene bleiben
         -> neues Release bauen, prüfen, atomar umschalten
         -> bei Fehler: letzter vollständiger Stand bleibt online, Status + Alarm

GitHub Actions
  |
  +--> Deploy: Code/Vorlagen -> /var/lib/eichmann/app, Release-Build auf dem Server
  +--> Tests, externer Wächter (Statusdatei), Betriebsbefehle per SSH
```

Die Website-Dateien selbst werden weiterhin rein statisch ausgeliefert (nginx, kein Application Server im Seitenaufruf). Auf dem Droplet laufen daneben nur die Admin-API, der öffentliche MCP-Dienst und der Immowelt-Abgleich. Für Formulare existiert bewusst ein kleiner separater Node-Dienst auf dem vorhandenen `digitalisierungsplanung.de`-VPS. Er hat eigene Runtime/Env, keine gemeinsame Produkt-DB oder Session und speichert keine Formularinhalte in einer eigenen Datenbank. GitHub-Actions-Runner bleiben kurzlebige Build-/Automationsmaschinen; sie veröffentlichen keine Angebotsdaten (Immowelt lesen sie nur für die manuell startbare, rein lesende Vertragsprüfung und den Vergleichsbericht).

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
| Deployment | `deploy-droplet.yml`: Code und Vorlagen aus `main` auf den Droplet, dort Release-Build aus der Datenbank und atomare Umschaltung |

Die Browserlogik liegt hauptsächlich in:

- `js/main.js` – Navigation, Kontakt-/Exposé-Formulare, Flyer, Gallery, Lightbox, URL-Prefills
- `js/cookie-consent.js` – Consent-Speicherung und kontrolliertes Laden von Analytics
- `js/analytics.js` – Google Analytics 4 / `gtag.js`, Measurement ID `G-QVRRBPYNVM`

Für Objektseiten unter `/objekt/` wird über `window.__eichmannJsBase` sichergestellt, dass die gemeinsamen JavaScript-Dateien mit dem korrekten relativen Pfad geladen werden.

---

## 3. Node-/Build-Stack

Dieses Repository benötigt Node lokal, in GitHub Actions und auf dem Droplet für Generierung, den Immowelt-Abgleich, Bildverarbeitung und Tests. Der separate Formular-Gateway läuft serverseitig als Node-Dienst im Repository `ChristianHohlfeld/digitalisierungsplanung.de`; er ist nicht Teil des Deployments dieses Repositories.

`package.json` verlangt Node **>= 20**.

Direkte Dependencies:

| Paket | Verwendung | aktuell aufgelöst |
|---|---|---|
| `better-sqlite3` | SQLite: Angebote, Abgleichs-Historie, Release-Bezug | 11.10.0 |
| `playwright` | Browser-Regressionsprüfungen und Vorher/Nachher-Screenshots (kein Immowelt-Import mehr) | 1.63.0 |
| `sharp` | Bildkonvertierung, Größenanpassung, Social-Share-Bilder | 0.33.5 |

Wichtige Befehle:

```bash
npm ci

npm run sync-immowelt:render   # nur rendern (lokal/CI aus data/listings.json bzw. lokaler SQLite)
npm run build                  # kompletter Build mit Regel- und Ausgabeprüfung
npm run sync-immowelt          # = node scripts/immowelt-sync.mjs run: Immowelt-API lesen und veröffentlichen
                               #   (für den Droplet gedacht: braucht API-Schlüssel und Release-Layout)
npm run immowelt:status        # Status + Bewertung (Exit 1 bei veraltet/fehlgeschlagen)
npm run immowelt:probe         # rein lesende Prüfung der API-Antwortstruktur
npm run release -- list        # Releases auf dem Server (build | list | rollback | gc)

npm run test:immowelt          # API-Parser + Ende-zu-Ende-Pipeline gegen Fixtures
npm run verify:screens -- --label before   # Vorher/Nachher-Screenshots (Desktop + Mobil)
npm run verify:inventory       # Vergleichstabelle veröffentlichter Stand ↔ gerenderte Seiten (optional ↔ API)

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

**Ja – zwei getrennte: einen für die Website, einen für Formulare.**

Die Website liegt auf dem DigitalOcean-Droplet `eichmann-web` (`46.101.163.236`, nginx; siehe `deploy/nginx/`). Kontakt- und Exposé-POSTs gehen an den vorhandenen VPS unter `forms.digitalisierungsplanung.de`. Dort terminiert Nginx TLS und routet ausschließlich die Formularpfade an `dp-forms.service` auf Loopback-Port `8791`. Es gibt weiterhin keine eigene Formular-Datenbank.

### Wo liegt die Website?

nginx liefert statisch aus `/var/www/immobilieneichmann.de` aus. Dieser Pfad ist (nach der einmaligen Umstellung durch `deploy/install-release-layout.sh`) ein Symlink auf `/var/lib/eichmann/releases/current`, also auf das zuletzt vollständig gebaute und geprüfte Release:

```text
/var/www/immobilieneichmann.de -> /var/lib/eichmann/releases/current -> <release-id>/
/var/lib/eichmann/app/           Code und Vorlagen (Ziel des Deploys)
/var/lib/eichmann/listings.db    SQLite: Angebote (immowelt | eigen), Historie
/var/lib/eichmann/media/         Bilder (immowelt/ inhaltsadressiert, eigen/ Admin-Uploads) – in jedes Release verlinkt
/var/lib/eichmann/secrets/       Schlüssel (700/600), nie im Repo
```

Veröffentlicht wird ausschließlich durch den atomaren Wechsel dieses Symlinks – nie durch Schreiben in den ausgelieferten Baum. **GitHub Pages wird nicht verwendet**; `.nojekyll` im Repository ist ein Überbleibsel ohne Funktion.

Die DNS-Konfiguration selbst liegt **außerhalb dieses Repositories** beim jeweiligen DNS-Provider. Das Repository enthält keine Zugangsdaten zum DNS-Provider.

### Was passiert bei einem normalen Seitenaufruf?

1. DNS löst `immobilieneichmann.de` auf den Droplet `eichmann-web` auf.
2. nginx liefert fertige statische Dateien aus dem aktuellen Release aus.
3. Der Browser führt `cookie-consent.js` und `main.js` aus.
4. Nur beim Absenden eines Kontakt-/Exposé-Formulars wird `forms.digitalisierungsplanung.de` aufgerufen.
5. Drittanbieter werden nur für die jeweils beschriebenen Funktionen aufgerufen.

---

## 5. Verzeichnisstruktur

```text
/
├── .github/workflows/       GitHub-Actions-Automation
├── admin/                   statisches Exposé-Admin
├── assets/
│   ├── flyer/               Flyerbilder
│   ├── listings/            Objektbilder der Entwicklungs-Fixtures (Immowelt-Bilder liegen auf dem Server unter media/immowelt/)
│   ├── logo*                Marken-/Header-Assets
│   └── share-card*          Social-Preview-Bilder
├── css/styles.css           gesamtes Public Styling
├── data/listings.json       Entwicklungs-Fixture im Exportformat der SQLite – keine Quelle
├── data/sot/                redaktionelle Quelle für alles, was nicht aus Immowelt kommt: Kontakt, Seiten-Meta, Projekte, Wording-Regeln, Objektgruppen
├── deploy/                  systemd-Units, Installationsskripte, nginx-Stand
├── docs/IMMOWELT-SYNC.md    Immowelt-Abgleich: Architektur, Betrieb, Rollback, Prüfplan
├── js/
│   ├── main.js
│   ├── cookie-consent.js
│   └── analytics.js
├── objekt/*.html            generierte Objekt-/Exposé-Seiten
├── partials/                generierte HTML-Fragmente
├── scripts/                 Renderer, Immowelt-Abgleich (immowelt-sync.mjs, lib/immowelt/), Release-Bau und Tests
├── test/, test-support/     node:test-Suiten und Fixtures (u. a. Immowelt-Pipeline)
├── index.html               Startseite
├── kontakt.html             allgemeines Kontaktformular
├── impressum.html
├── datenschutz.html
├── widerrufsbelehrung.html
├── vertrag-widerrufen.html
├── sitemap.xml
├── robots.txt
├── llms.txt
├── .nojekyll                Überbleibsel aus der GitHub-Pages-Zeit, ohne Funktion
├── package.json
└── package-lock.json
```

---

## 6. Single Source of Truth für Immobilien

Die fachliche Single Source of Truth für alle Immowelt-Angebote ist **Immowelt**. Helmut pflegt dort an/aus, Kauf/Miete/Preis auf Anfrage, Titel, Preis, Texte, Fakten, Bilder, Grundrisse und deren Reihenfolge. Die Website übernimmt das vollständig und einseitig (harte Einweg-Übernahme über die offizielle API). **Lokale Abweichungen gibt es für Immowelt-Angebote nicht mehr** – keine Titel-/Text-Overrides und kein lokales Ausblenden (`site_hidden`); wer etwas ändern will, ändert es auf Immowelt. Eigene Inserate (`origin=eigen`) werden im Admin gepflegt und vom Abgleich nie angefasst.

Technisch liegt der zuletzt vollständig gelesene und geprüfte Stand in der SQLite-Datenbank auf dem Droplet (`/var/lib/eichmann/listings.db`); daraus wird jedes Release gebaut. `data/listings.json` im Repository ist nur noch eine **Entwicklungs-Fixture** im Exportformat dieser Datenbank (lokales Rendern, CI). Eine vorhandene Server-Datenbank wird nie daraus befüllt (einzige Ausnahme: die Erstanlage der Datenbank auf einem ganz neuen Server); im Release wird die Datei aus der Datenbank neu erzeugt (nginx liefert sie nicht aus).

Top-Level-Struktur:

```json
{
  "sot": "sqlite",
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
- `active` – steuert, ob ein Objekt öffentlich erscheint; `false` behält es intern, veröffentlicht es aber nicht
- `detail_page` – `false` erlaubt einen öffentlichen Kontakt-Teaser ohne erfundene Exposé-Inhalte; nur `true` erzeugt Detailseite und Sitemap-Eintrag
- optional `manual_overrides` (nur noch in Altdaten; für Immowelt-Angebote ohne Wirkung)

Angebote aus der offiziellen API (`immowelt_api: true`) tragen zusätzlich unter anderem `immowelt_guid`, `immowelt_estate_id`, `immowelt_online_id`, `marketing` (`kauf` | `miete`), `price_eur`, `price_on_request`, `sections`, `fact_rows`, `media` und `content_hash`. Für sie gilt immer `sync_policy: mirror`: ein Angebot, das im vollständigen Immowelt-Bestand fehlt, wird stillgelegt (`active: false`, `missing_on_immowelt: true`) und nicht weiter öffentlich gezeigt; die Historie bleibt in der Datenbank.

Die HTML-Seiten unter `objekt/`, die Karten auf Start-/Projektseite und die Objekt-URLs in `sitemap.xml` werden daraus erzeugt.

---

## 7. Immowelt-Import

Immowelt ist **die einzige Quelle für Immowelt-Angebote** und wird ausschließlich gelesen.

Das Immowelt-Konto wird von dieser Codebasis **niemals beschrieben**.

Die vollständige Beschreibung (Architektur, Schlüssel, Rollout, Rollback, Alarm, Prüfplan, Grenzen der API) steht in **`docs/IMMOWELT-SYNC.md`**. Hier nur die Kurzfassung.

Quelle (offizielle Immowelt-SOAP-API, kein Scraping des öffentlichen Profils, keine Captcha-Umgehung):

```text
https://api.immowelt.de/WebServices/EstateService.asmx   GetListCustomerProjects      (vollständige Angebotsliste)
https://api.immowelt.de/WebServices/EstateExpose.asmx    GetEstateExposeByEstateGuid  (Exposé je Angebot)
```

Abgleich und Renderer:

```text
scripts/immowelt-sync.mjs        der eine Befehl, den der Server ausführt (run | status | probe | identity-plan | …)
scripts/lib/immowelt/            API-Abruf, Normalisierung, Prüfung, Bilder, Datenbank, Status, Sperre
scripts/lib/release.mjs          Release bauen, prüfen, atomar umschalten
scripts/sync-immowelt.mjs        nur noch der Renderer (--render-only, --export-only)
```

Der frühere Playwright-Scraper, die Mirror-Prüfung und der Actions-Workflow `sync-immowelt.yml` sind entfernt; die Flags `--from-json`, `--force-scrape`, `--enrich-only` und `--skip-enrich` gibt es nicht mehr (der Aufruf endet mit einem Hinweis).

### Ablauf eines Laufs

1. Sperre holen (genau ein Schreiber der öffentlichen Seite), API-Schlüssel aus `/var/lib/eichmann/secrets/immowelt-api.json` lesen.
2. Den **vollständigen** Bestand und **jedes** Exposé lesen; die Anzahl muss zur von Immowelt gemeldeten Gesamtzahl passen.
3. Normalisieren und prüfen (IDs, Kauf/Miete, Preis, Bilder); alle Bilder laden und aufbereiten.
4. Unverändert: nur den Status fortschreiben (beim ersten Lauf eines Tages zusätzlich ein Release mit dem neuen Datenstand). Geändert: Kandidaten-Datenbank → vollständiges Release bauen → prüfen.
5. Erst dann die Live-Datenbank in einer Transaktion aktualisieren und das Release mit einem atomaren Symlink-Wechsel live schalten.
6. Statusdatei schreiben (`data/immowelt-sync-status.json`, Schema `eichmann.immowelt-sync-status/v2`).

### Zeitplan

Der Abgleich läuft **auf dem Droplet**, nicht in GitHub Actions:

```text
eichmann-immowelt-sync.timer   OnCalendar=*:07,37   (alle 30 Minuten, verpasste Läufe werden nachgeholt)
eichmann-sync-watchdog.timer   OnCalendar=*:02,17,32,47   (Wächter: lief der Abgleich, ist er aktuell?)
```

Zusätzlich lässt er sich jederzeit starten: im Admin über „Immowelt Sync“ (derselbe Lauf, ohne Bestätigungsschritt), über den Workflow „Immowelt ops (server)“ (Aktion `run`) oder auf dem Server mit `node scripts/immowelt-sync.mjs run`. Von außen prüft der Workflow `immowelt-watchdog.yml` alle 30 Minuten Status und Seite, sobald die Repository-Variable `IMMOWELT_WATCHDOG_ENABLED` auf `true` steht.

Template- und Codeänderungen brauchen keinen Abgleich: Jeder Deploy baut auf dem Server ein neues Release aus der Datenbank (`node scripts/release.mjs build --reason deploy`).

### Fehlerverhalten (fail-closed)

- Jeder Fehler vor der Umschaltung (API nicht erreichbar, Schlüssel ungültig, unvollständige oder widersprüchliche Antwort, fehlendes Exposé oder Bild, fehlgeschlagene Release-Prüfung) lässt Datenbank, Bilder und öffentliche Seite **unverändert** – der letzte vollständige Stand bleibt online.
- Der Lauf endet dann mit Fehlercode, die systemd-Unit schlägt fehl und die Statusdatei nennt den Grund; die Wächter melden das.
- Nie eine Teilveröffentlichung, nie eine geleerte Seite wegen eines Fehlers.
- Ein leerer Bestand oder ein großer Wegfall (mindestens 3 Angebote und mindestens die Hälfte) wird erst veröffentlicht, wenn eine zweite, identische Antwort frühestens 20 Minuten später vorliegt.
- kein Login-Scraping und kein Captcha-Bypass; das Immowelt-Konto wird nicht verändert

### Übernahme-Regeln

- Jedes Angebot aus dem Bestand **ersetzt** seinen Datensatz vollständig: an/aus, Kauf/Miete/Preis auf Anfrage, Texte, Fakten, Bilder, Grundrisse und Reihenfolge – nichts wird mit lokalen Werten gemischt.
- Sichtbarkeit entscheidet allein Immowelt (`active` und `site_hidden` werden gesetzt, nicht übernommen); `manual_overrides` und lokale Textkorrekturen wirken auf Immowelt-Angebote nicht mehr.
- Was nicht (mehr) im vollständigen Bestand ist, wird stillgelegt und nicht weiter öffentlich gezeigt – nicht gelöscht; die Historie bleibt in der Datenbank.
- Ein Datensatz behält nur seine ID, seine URL (Slug eingefroren) und sein Anlagedatum.
- `origin=eigen` wird vom Abgleich weder gelesen noch verändert.
- Vor der ersten Veröffentlichung aus der API ordnet eine einmalige, ausdrücklich freizugebende Identitätsmigration die Alt-Datensätze den API-Angeboten zu (`identity-plan` → `identity-apply`).

---

## 8. Bilder

Objektbilder liegen **auf dem Droplet, nicht im Git-Repository**, und zwar außerhalb der Releases (in jedes Release verlinkt):

```text
/var/lib/eichmann/media/immowelt/<aa>/<sha256>-g.jpg|.webp      Galeriebild
                                              -fp.jpg|.webp     Grundriss (unbeschnitten)
                                              -g-og.jpg|.webp   Social-Preview (nur erstes Bild)
/var/lib/eichmann/media/eigen/<inserat-id>/<nn>.jpg|.webp       Admin-Uploads eigener Inserate
/var/lib/eichmann/immowelt/originals/<sha256>                   Originale von Immowelt (Archiv, nicht öffentlich)
```

Immowelt-Bilder sind **inhaltsadressiert**: Der Dateiname ergibt sich aus den Bytes des Bildes. Ein auf Immowelt ersetztes Bild bekommt deshalb immer eine neue URL, dasselbe Bild wird nur einmal gespeichert, und neue Dateien berühren nie, was die Live-Seite gerade zeigt. Anzahl und Reihenfolge von Bildern und Grundrissen kommen 1:1 aus der API. Fehlt auch nur ein Bild, schlägt der ganze Lauf fehl – eine halb gefüllte Galerie wird nie veröffentlicht.

Sharp erzeugt je Bild:

- JPG für breite Kompatibilität
- WebP für kleinere Übertragung

Nicht mehr referenzierte Aufbereitungen werden erst entfernt, wenn kein aufbewahrtes Release sie mehr verwendet (läuft nach jeder Veröffentlichung durch den Abgleich mit; manuell: `node scripts/release.mjs gc`).

`assets/listings/` im Repository enthält nur noch die Bilder der Entwicklungs-Fixtures aus der Scraper-Zeit (Dateinamen `NN-<id>…`); sie sind keine Quelle für Immowelt-Bilder mehr.

Admin-Uploads für eigene Inserate gehen über `/admin/api/eigen/images` direkt auf den Droplet (`media/eigen/`), nicht über GitHub.

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
- ein Honeypot-Feld `botcheck`

Mail-Betreff und Empfänger werden serverseitig festgelegt; der Browser darf sie nicht frei bestimmen.

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

Der Test startet Chromium, lädt eine generierte Exposé-Seite, prüft **Feldsatz, Reihenfolge, Required-Status, Payload und Success-UI** und mockt ausschließlich die Netzwerkgrenze zum eigenen Formular-Gateway.

### Serverseitige Trust-Grenze

Zusätzlich zur Browservalidierung validiert der Gateway die Pflichtfelder nochmals serverseitig. Er erzwingt Tenant, erlaubte Origins, feste Empfänger, feste Exposé-URL-Domain, Requestgrößen und Rate-Limits. Erfolg wird erst gemeldet, nachdem Amazon SES den Versand angenommen hat.

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

Produktiver Pfad:

```text
Browser auf immobilieneichmann.de
  -> HTTPS JSON POST
  -> https://forms.digitalisierungsplanung.de/v1/immobilieneichmann/{contact|expose}
  -> Nginx
  -> dp-forms.service (127.0.0.1:8791)
  -> Amazon SES
  -> info@immobilien-eichmann.com
```

Der Gateway ist vom Hauptprodukt `digitalisierungsplanung.de` getrennt: eigener systemd-Dienst, eigener Linux-User, eigene Environment-Datei, eigener Loopback-Port, keine gemeinsame Account-Datenbank und keine Produktsession.

Bei Erfolg antwortet er mit:

```json
{ "success": true, "requestId": "…" }
```

Bei Fehler zeigt die Website die bestehende Fehlerbox und den Mailto-Fallback. Die HTML-Formulare besitzen zusätzlich ein normales `action` auf denselben Gateway und `method="POST"` als einfachen No-JavaScript-Fallback.

### Speicherung und Logs

Kontakt-/Exposé-Eingaben werden nicht in dieses GitHub-Repository, Local Storage, Session Storage oder eine eigene Formular-Datenbank geschrieben. Der Gateway verarbeitet sie im Arbeitsspeicher für Validierung und Mailversand. Seine technischen Logs enthalten Request-ID, Tenant, Flow, Status und Dauer, aber keine Formularinhalte oder Kontaktdaten. Danach liegt die Anfrage als E-Mail im Zielpostfach `info@immobilien-eichmann.com`, abhängig von dessen Aufbewahrungseinstellungen.

Der Droplet `eichmann-web` hostet die Website, **nicht das E-Mail-Postfach**. Der Versand erfolgt über Amazon SES; die konkrete Mailbox-/MX-Infrastruktur von `immobilien-eichmann.com` wird weiterhin nicht in diesem Repository konfiguriert.
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

Unified UI (tabs: Immowelt | Eigen-Inserate). `/admin/eigen/` redirects to `/admin/#eigen`.

Details: `admin/README.md` and `docs/STABSCHEF-admin-unified-2026-09-25.md`.

### Login-Modus

`admin/config.json`:

```text
auth_mode = password_session
```

Login benötigt:

1. freigeschaltete E-Mail-Adresse
2. Admin-Passwort

**Kein GitHub-PAT.** Der Browser ruft `POST /admin/api/login` auf; nginx proxyt auf `127.0.0.1:3847`.
Die API prüft Allowlist + `password_sha256` und setzt ein HttpOnly Secure SameSite=Strict Cookie.

### Speichern

```text
Browser → /admin/api/{eigen|visibility|publish}
       → eichmann-admin-api (systemd)
       → SQLite SoT → vollständiges Release bauen + prüfen → atomar umschalten
```

Gespeichert wird nie in den ausgelieferten Baum: Jede Admin-Veröffentlichung baut unter derselben Sperre wie der Immowelt-Abgleich ein Release aus der Datenbank.

`/visibility` gilt nur noch für eigene Inserate; für Immowelt-Angebote antwortet die API mit **409**, weil an/aus ausschließlich auf Immowelt gesteuert wird.

Immowelt-Konto bleibt read-only. Der Immowelt-Abgleich läuft als systemd-Timer auf dem Droplet (`eichmann-immowelt-sync.timer`); „Immowelt Sync“ im Admin startet denselben Lauf sofort und ohne Bestätigungsschritt. Der API-Schlüssel wird im Immowelt-Tab oder über den Workflow „Immowelt API key → server“ hinterlegt und liegt nur auf dem Server. Details: `docs/IMMOWELT-SYNC.md`.

### Entfernt (2026-09-25)

- Sitzungs-PAT / `sessionStorage` Token
- `admin-eigen-save.yml` (`repository_dispatch` → SSH upsert)
- Standalone Eigen-UI (nur Redirect)

---

## 14. Admin-Speicherflow (Legacy / GitHub Contents — entfernt)

> **Entfernt.** Der frühere Weg über Sitzungs-PAT, GitHub Contents API und den Workflow `admin-save.yml` („Admin Apply“: `admin_save_listings`, `admin_apply_render`, `admin_trigger_sync`) existiert nicht mehr; der Workflow wurde am 11.11.2026 gelöscht. Gespeichert wird ausschließlich über `/admin/api/` auf dem Droplet (Abschnitt 13, `admin/README.md`).

Was heute gilt:

- **Eigene Inserate** anlegen, ändern, löschen und Fotos hochladen: `/admin/api/eigen`, `/admin/api/eigen/delete`, `/admin/api/eigen/images` → SQLite und `media/eigen/` auf dem Droplet → neues Release.
- Das Löschen eines eigenen Inserats entfernt mit dem nächsten Release dessen `objekt/{slug}.html`, den Sitemap-Eintrag und die hochgeladenen Bilder.
- **Immowelt-Angebote** werden im Admin weder bearbeitet noch ausgeblendet oder gelöscht; sie kommen vollständig von Immowelt (Abschnitt 7).
- `data/listings.json` und `assets/listings/` im Repository werden vom Admin nicht mehr geschrieben.

---

## 15. Manuelle Overrides (entfallen)

Für Immowelt-Angebote gibt es **keine lokalen Overrides** mehr. Das frühere `manual_overrides`-Verfahren (Feldsperren gegen das Überschreiben durch den Importer) ist entfallen: Die harte Einweg-Übernahme ersetzt jeden Immowelt-Datensatz vollständig – Titel, Preis, Ort, Zimmer, Flächen, Typ, Status, Texte, Bilder, Grundrisse und Fakten. Auch die redaktionelle Schicht unter `data/sot/` (Titel-/Textkorrekturen, Ausblenden) wird auf Angebote aus der API nicht angewendet.

Wer an einem Immowelt-Angebot etwas ändern will, ändert es **auf Immowelt**; der nächste Lauf übernimmt es. Treffer der Wording-Regeln in Immowelt-Texten werden beim Build gemeldet (`IMMOWELT_RULE_HITS`), aber nicht lokal korrigiert.

Lokal autoritativ sind nur eigene Inserate (`origin=eigen`) und die Inhalte, die die API nicht liefert (Projektseiten, Flyer, Seitentexte unter `data/sot/`).

---

## 16. GitHub-Actions-Pipelines

Der Immowelt-Abgleich selbst läuft **nicht** in GitHub Actions, sondern als systemd-Timer auf dem Droplet (Abschnitt 7). Die Workflows `sync-immowelt.yml` („Immowelt Official API“, täglicher Cron), `data-age.yml` und `admin-save.yml` („Admin Apply“) sind entfernt. Actions übernimmt Deploy, Tests, den externen Wächter und Betriebsbefehle:

### `deploy-droplet.yml`

Bei Push auf `main` (Seiten, Assets, Skripte, `data/sot/`, …) oder manuell:

- App-Stand (Code, Vorlagen, Assets) per rsync nach `/var/lib/eichmann/app` – **nie in den Webroot**
- `npm ci` nur bei geänderter Lock-Datei, Datenbank-Migration, Dienste installieren (Admin-API, MCP, Immowelt-Timer)
- beim ersten Mal einmalig das Release-Layout einrichten (`deploy/install-release-layout.sh`), danach `node scripts/release.mjs build --reason deploy`: Release aus der Server-Datenbank bauen, prüfen, atomar umschalten
- schlägt Build oder Prüfung fehl, bleibt das bisherige Release online und der Lauf ist rot
- manueller Start mit der Eingabe `timers` (`keep` | `enable` | `disable`) für die Immowelt-Timer

Es wandern keine Angebotsdaten vom Repository auf die Website.

### `immowelt-pipeline-tests.yml`

Ersetzt `sync-immowelt.yml`. Ohne Netzabhängigkeit und ohne Aussage über Aktualität: testet Parser, Vollständigkeitsprüfung, Identitätszuordnung und die komplette Pipeline (Abruf → SQLite → Release → Umschaltung, Fehlerfälle, Rollback) gegen Fixtures in der Form der echten API; dazu Build, Legal-Baseline und „eigene Inserate überleben jeden Abgleich“.

### `immowelt-watchdog.yml`

Ersetzt `data-age.yml`. Liest alle 30 Minuten (Cron `11,41 * * * *`) den öffentlichen Status der Live-Seite und wird rot, wenn der letzte vollständige Abgleich zu alt ist, der letzte Lauf fehlschlug, auf die Identitätsfreigabe wartet oder angehalten ist, oder wenn die Seite nicht das Release, die Angebotszahl oder den Datenstand ausliefert, die der Status nennt. Aktiv erst mit der Repository-Variable `IMMOWELT_WATCHDOG_ENABLED=true`; manuelle Läufe funktionieren immer.

### `immowelt-provision-key.yml` („Immowelt API key → server“)

Manuell, mit Bestätigung `INSTALL`: bringt das Actions-Secret `IMMOWELT_API_KEY` per SSH über STDIN nach `/var/lib/eichmann/secrets/immowelt-api.json` (600) und prüft den Schlüssel dort rein lesend. Der Wert erscheint nie als Argument, als Umgebungsvariable auf dem Server oder im Log.

### `immowelt-ops.yml` („Immowelt ops (server)“)

Manuell: Betriebsbefehle auf dem Server per SSH – `status`, `identity-plan`, `identity-apply`, `run`, `history`, `releases`, `hold`, `resume`, `rollback-data`, `rollback-release`, `timers-enable`, `timers-disable`.

### `immowelt-verify-live.yml`

Manuell: ganzseitige Screenshots aller Seiten mit Immowelt-Inhalten (Desktop 1440×900, Mobil 390×844) mit dem Label `before`, `after` oder `check` sowie die Vergleichstabelle API ↔ veröffentlichter Stand ↔ gerenderte Seiten; Ergebnisse als Artefakte (90 Tage).

### `immowelt-live-probe.yml`

Manuell: rein lesende Prüfung der API-Antwortstruktur von einem zweiten Standort (Zähler, öffentliche IDs, Feldnamen; keine Datenbank, keine Bilder, keine Veröffentlichung).

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

### Kein GitHub-Pages-Deployment

Veröffentlicht wird nicht über GitHub Pages, sondern über `deploy-droplet.yml` (oben) und die Releases auf dem Droplet. Die gerenderten Seiten, die `layout-regression.yml` nach `main` zurückschreibt, sind Entwicklungs-Fixtures; sie gelangen nicht als Angebotsdaten auf die Website.

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
npm run test:immowelt
```

### Immowelt-Pipeline-Test

`test/immowelt-api.test.mjs` und `test/immowelt-pipeline.test.mjs` prüfen den Abgleich ohne Netz gegen Fixtures in der Form der echten API: Parser und Vollständigkeitsprüfung, Identitätszuordnung, harte Übernahme, Fehlerfälle (Seite und Datenbank bleiben unverändert), atomare Umschaltung und Rollback.

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

`scripts/test-expose-form.mjs` prüft mit echtem Chromium unseren kompletten Browserflow und mockt kontrolliert nur die Netzwerkgrenze zum eigenen Formular-Gateway. Feldsatz, Validierung, Payload und Success-UI bleiben dadurch deterministisch testbar.

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
| DigitalOcean (Droplet `eichmann-web`) | jeder Seitenaufruf | Hosting der statischen Website (nginx), Admin-API, Immowelt-Abgleich | normale HTTP-Verbindungsdaten |
| GitHub Actions | Push, Zeitplan (nur Wächter), manueller Start | Deploy auf den Droplet, Tests, externer Wächter, Betriebsbefehle per SSH | Repo-/Build-Daten |
| eigenes Formular-Gateway (`forms.digitalisierungsplanung.de`) | Kontakt-/Exposé-Submit | serverseitige Validierung und Mail-Übergabe | vom Nutzer eingegebene Formulardaten |
| Amazon SES | nach erfolgreicher Gateway-Validierung | transaktionaler E-Mail-Versand | Formulardaten im Mailinhalt + Empfänger/Reply-To |
| Immowelt (offizielle API) | alle 30 Minuten vom Droplet; externe Links | einzige Quelle der Immowelt-Angebote, nur lesend | Angebotsdaten und Bilder des eigenen Kontos; API-Schlüssel im Request |
| Google Analytics 4 | nur nach Analytics-Consent | Statistik | Analytics-/Browserdaten nach Google-Konfiguration |
| Google Maps | nur nach Nutzer-Klick | externe Kartenansicht | erst nach Öffnen von Google |
| npm Registry | nur Build/Install | Playwright/Sharp/better-sqlite3 installieren | Build-Metadaten |

Nicht vorhanden:

- eigener Datenbank-Server (die Angebote liegen in einer SQLite-Datei auf dem Droplet)
- GitHub Pages
- WordPress
- PHP
- serverseitiges Session-System für Besucher (nur das Admin hat eine Session)
- eigenes SMTP
- externe Google Fonts
- automatisch eingebettetes Google Maps
- Schreibzugriff auf Immowelt

---

## 21. Welche Daten liegen wo?

| Daten | Speicherort |
|---|---|
| statische Website | Vorlagen und Code im GitHub-Repository; ausgeliefert wird das aktuelle Release auf dem Droplet (`/var/lib/eichmann/releases/<id>`) |
| Immobilien-Stammdaten | SQLite auf dem Droplet (`/var/lib/eichmann/listings.db`); Immowelt-Angebote stammen aus der Immowelt-API. `data/listings.json` im Git-Repo ist nur Entwicklungs-Fixture |
| Objektbilder | `/var/lib/eichmann/media/` auf dem Droplet (`immowelt/`, `eigen/`); `assets/listings/` im Git-Repo ist nur Fixture |
| generierte Exposés | im jeweiligen Release auf dem Droplet; `objekt/*.html` im Git-Repo ist nur Fixture |
| Immowelt-API-Schlüssel | `/var/lib/eichmann/secrets/immowelt-api.json` (600) auf dem Droplet, zusätzlich als Actions-Secret `IMMOWELT_API_KEY`; nie im Repo, in Logs oder Screenshots |
| Abgleichs-Status und -Historie | Status öffentlich unter `data/immowelt-sync-status.json` (ohne Geheimnisse); Läufe, Stände und Historie in der SQLite; Rohantworten und DB-Sicherungen unter `/var/lib/eichmann/immowelt/` |
| Kontakt-/Exposé-Eingaben | nicht im Repo/Browser-Speicher; flüchtige Verarbeitung im eigenen Formular-Gateway, danach E-Mail-Versand über Amazon SES |
| Formular-Gateway-Logs | nur technische Metadaten ohne Formularinhalte/Kontaktdaten |
| zugestellte Anfragen | Ziel-Mailbox `info@immobilien-eichmann.com` |
| Analytics-Daten | Google Analytics, nur nach Consent |
| Consent-Auswahl | Browser-`localStorage` |
| Admin-Sitzung | HttpOnly-Cookie im Browser; Session-Secret auf dem Droplet (`/var/lib/eichmann/admin-session.secret`). Kein GitHub-PAT |
| Admin-Passwort | nicht persistent im Browser; nur Hash liegt öffentlich in Config |
| Git-Historie | GitHub |
| CI-Logs/Artefakte | GitHub Actions |

---

## 22. Sicherheit und Grenzen

### Was schützt das Admin wirklich?

Nicht der HTML-Login allein.

Da das Admin vollständig statisch ist, kann jeder Besucher seinen JavaScript-Code lesen.

Der tatsächliche Schreibschutz ist die Admin-API auf dem Droplet (Abschnitt 13):

- sie lauscht nur auf `127.0.0.1` hinter nginx und prüft bei jedem Schreibzugriff die Session (E-Mail-Allowlist + Passwort)
- es gibt keinen GitHub-PAT und keinen Schreibweg über GitHub mehr
- Immowelt-Angebote lassen sich über das Admin nicht verändern oder ausblenden (409)

### Gleichzeitige Bearbeitung und Veröffentlichung

Die Angebote liegen in SQLite; Änderungen laufen in Transaktionen. Für die öffentliche Seite gibt es genau **einen Schreiber gleichzeitig**: Immowelt-Abgleich, Admin-Veröffentlichung, Deploy und Rollback holen dieselbe Sperre und schalten jeweils ein vollständiges, geprüftes Release atomar um. Besucher sehen dadurch immer den alten oder den neuen Stand, nie eine Mischung.

Das Admin selbst ist weiterhin nicht für gleichzeitiges Bearbeiten desselben eigenen Inserats durch mehrere Personen ausgelegt.

### Formulare

Die Browservalidierung verhindert normale leere Submits.

Da Client-Code grundsätzlich manipulierbar ist, validiert `dp-forms.service` dieselben Pflichtfelder serverseitig. Der Gateway erzwingt feste Tenant-/Origin-/Empfängerregeln, Body- und Rate-Limits und akzeptiert für Exposés nur Objekt-URLs der Eichmann-Domain.

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

Lokal wird aus `data/listings.json` (Entwicklungs-Fixture) bzw. einer lokalen SQLite (`var/listings.db`) gerendert, direkt in den Arbeitsbaum.

Immowelt-Abgleich: läuft produktiv nur auf dem Droplet (`node scripts/immowelt-sync.mjs run`, braucht API-Schlüssel und Release-Layout). Lokal sinnvoll ist die rein lesende Prüfung der API-Antwort – keine Datenbank, keine Bilder, keine Veröffentlichung:

```bash
node scripts/immowelt-sync.mjs probe
```

Der Schlüssel kommt dabei aus der Datei, deren **Pfad** in `IMMOWELT_SECRETS_FILE` steht, oder als **Wert** aus der Umgebungsvariable `IMMOWELT_API_KEY` – nie ins Repository, nie in Logs oder Screenshots.

Die Pipeline ohne Netz und ohne Schlüssel gegen Fixtures testen:

```bash
npm run test:immowelt
```

Lokale SQLite aus einer JSON-Datei befüllen (ersetzt das frühere `--from-json`):

```bash
node scripts/db-migrate.mjs --bootstrap --json /pfad/datei.json
```

---

## 24. Betrieb: typische Änderungen

### Objekttext ändern

**Immowelt-Angebot:** auf Immowelt ändern. Der nächste Lauf (alle 30 Minuten) übernimmt Text, Preis, Bilder und Status vollständig; lokal lässt sich daran nichts ändern.

**Eigenes Inserat:** über `/admin/`.

Resultat:

```text
Admin -> /admin/api -> SQLite -> vollständiges Release -> atomare Umschaltung
```

### Neues Objekt von Immowelt übernehmen

Nichts zu tun: Der Timer auf dem Droplet übernimmt es beim nächsten Lauf (Minute :07 und :37). Sofort geht es mit „Immowelt Sync“ im Admin oder über den Workflow „Immowelt ops (server)“ mit der Aktion `run`.

### Immowelt-Angebot offline nehmen

Auf Immowelt deaktivieren oder löschen. Der nächste Lauf nimmt es von der Website; ein lokales Ausblenden gibt es nicht mehr.

### Abgleich prüfen, anhalten, zurückrollen

`npm run immowelt:status` auf dem Server oder Workflow „Immowelt ops (server)“ (`status`, `hold`, `resume`, `rollback-data`, `rollback-release`). Ablauf und Entscheidungshilfen: `docs/IMMOWELT-SYNC.md`.

### Neues lokales Objekt

Im Admin „+ Neues Objekt“.

### Template aller Exposé-Seiten ändern

`scripts/sync-immowelt.mjs` ändern und pushen.

Der Deploy baut daraufhin auf dem Server ein neues Release aus der Datenbank – mit allen Objektseiten – und schaltet es nach bestandener Prüfung atomar um. Im Repository rendert `layout-regression.yml` nur die Fixture-Seiten aus `data/listings.json` neu.

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

- GitHub REST API: https://docs.github.com/rest
- GitHub Actions: https://docs.github.com/actions
- Amazon SES: https://docs.aws.amazon.com/ses/
- Immowelt: https://www.immowelt.de/
- Google Analytics: https://developers.google.com/analytics
- Playwright: https://playwright.dev/
- Sharp: https://sharp.pixelplumbing.com/

---

## 26. Entscheidende Architekturregeln

1. **Immowelt ist die einzige Quelle für Immowelt-Angebote; die SQLite auf dem Droplet hält den letzten vollständig geprüften Stand plus die eigenen Inserate. `data/listings.json` im Repository ist nur Entwicklungs-Fixture.**
2. **Immowelt ist nur Inbound und wird nie beschrieben.**
3. **Generierte HTML-Seiten nicht als Primärdaten behandeln.**
4. **Öffentliche Website statisch halten; serverseitige Logik nur im getrennten `dp-forms`-Gateway sowie in Admin-API und Immowelt-Abgleich auf dem Droplet – nie im Seitenaufruf.**
5. **Keine Secrets in statische Dateien oder ins Repo.**
6. **Kein GitHub-PAT im Admin; Schreibzugriffe nur über die Session der Admin-API.**
7. **Formularanfragen laufen ausschließlich über den eigenen Gateway und Amazon SES; sie gehören nicht ins Git-Repo.**
8. **Analytics niemals vor Consent laden.**
9. **Objekt-Templateänderungen immer zentral im Generator durchführen.**
10. **Nach Änderungen Tests und den Deploy-Lauf (`deploy-droplet.yml`) prüfen; veröffentlicht wird nur als vollständiges, geprüftes Release.**
11. **Keine lokalen Overrides für Immowelt-Angebote. Bei Fehlern bleibt der letzte vollständige Stand online, der Lauf wird rot und der Status meldet es – die Seite wird nie geleert und nie teilweise veröffentlicht.**


### Objektstandort statt Objektadresse

Exakte Objektadressen werden öffentlich standardmäßig nicht ausgegeben. Für Immowelt-Angebote übernimmt die Website aus den strukturierten Adressfeldern der API nur PLZ und Ort (`IMMOWELT_ADDRESS_MODE=locality`, Standard); mit `street` würde die Straße so übernommen, wie die API sie liefert. Texte aus Immowelt werden dagegen unverändert übernommen – steht dort eine Adresse im Fließtext, erscheint sie auch auf der Website und muss auf Immowelt geändert werden. Für eigene Inserate gilt die bisherige Reduktion auf Stadtteil/Ort weiter. Die Geschäftsadresse von Immobilien Eichmann in Footer/Impressum bleibt davon unberührt.
