# Immobilien Eichmann

Statische Website für **Immobilien Eichmann** (Verkauf, Vermittlung, Projektentwicklung) in Konstanz / Bodenseeregion.

## Live-URL (GitHub Pages)

- GitHub Pages: https://christianhohlfeld.github.io/eichmannimmobilien/
- Custom Domain: **immobilieneichmann.de**

Die Site liegt im Root von `main` und wird über GitHub Pages ausgeliefert. Die Datei `CNAME` enthält `immobilieneichmann.de`.

## Seiten

| Datei | Inhalt |
|-------|--------|
| `index.html` | Startseite (Hero, Leistungen, Projekte, CTA) |
| `leistungen.html` | Verkauf, Vermittlung, Projektentwicklung |
| `projekte.html` | Platzhalter-Projektkarten (Neubau / Region Konstanz) |
| `kontakt.html` | Kontaktdaten + Web3Forms-Formular (Fallback mailto) |
| `impressum.html` | Impressum (Einzelunternehmen Helmut Eichmann) |
| `datenschutz.html` | Datenschutzerklärung |

## DomainFactory DNS – was Chris eintragen muss

GitHub Pages für User-/Org-Seiten mit Custom Domain erwartet in der Regel **A-Records** für die Apex-Domain und einen **CNAME** für `www`. Die aktuellen GitHub-Pages-IPs (Stand Dokumentation GitHub):

### immobilieneichmann.de (Apex / Root)

| Typ | Host / Name | Wert / Ziel | TTL |
|-----|-------------|-------------|-----|
| A | `@` (oder leer / Domain selbst) | `185.199.108.153` | 600 oder Default |
| A | `@` | `185.199.109.153` | 600 oder Default |
| A | `@` | `185.199.110.153` | 600 oder Default |
| A | `@` | `185.199.111.153` | 600 oder Default |
| CNAME | `www` | `christianhohlfeld.github.io.` | 600 oder Default |

Optional IPv6 (AAAA), falls DomainFactory das anbietet:

| Typ | Host | Wert |
|-----|------|------|
| AAAA | `@` | `2606:50c0:8000::153` |
| AAAA | `@` | `2606:50c0:8001::153` |
| AAAA | `@` | `2606:50c0:8002::153` |
| AAAA | `@` | `2606:50c0:8003::153` |

Danach in den GitHub-Repo-Settings unter **Pages → Custom domain** ggf. `immobilieneichmann.de` prüfen. Die Datei `CNAME` im Repo setzt die primäre Domain auf `immobilieneichmann.de`. DNS-Propagation kann bis zu einigen Stunden dauern. HTTPS wird von GitHub nach erfolgreicher Domain-Verifizierung automatisch bereitgestellt („Enforce HTTPS“ aktivieren).



## Kontaktformular & E-Mail

- **Formular:** sendet via [Web3Forms](https://web3forms.com) (AJAX an `https://api.web3forms.com/submit`) an `chris.hohlfeld@gmail.com`. Access Key ist im Formular/JS hinterlegt (öffentlich vorgesehen). Free-Plan: 250 Submissions/Monat.
- **Öffentliche Adresse auf der Site:** `info@immobilien-eichmann.com` (mailto-Fallback bleibt).
- **Aktueller DNS-Stand (nicht DomainFactory-NS):** NS = GoDaddy `ns19/ns20.domaincontrol.com`, MX = GoDaddy SecureServer (`smtp.secureserver.net` / `mailstore1.secureserver.net`). Kein SPF / DKIM / DMARC gesetzt.
- **Pages nicht anfassen:** Apex-A/AAAA (GitHub Pages) und `www` CNAME auf `christianhohlfeld.github.io` beibehalten.

### Empfohlene Mail-DNS-Einträge (bei aktuellem DNS-Provider / GoDaddy DNS)

Nur ergänzen, **ohne** Pages-A/AAAA/`www` zu ändern:

| Typ | Host | Wert | Zweck |
|-----|------|------|--------|
| TXT | `@` | `v=spf1 include:secureserver.net ~all` | SPF für GoDaddy-Mail |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:chris.hohlfeld@gmail.com` | DMARC monitor |
| TXT | (DKIM-Selektor von GoDaddy/Titan) | *(Wert aus dem Mail-Panel)* | DKIM, sobald Postfach aktiv |

Zusätzlich: Postfach oder **Weiterleitung** `info@immobilien-eichmann.com` → `chris.hohlfeld@gmail.com` im GoDaddy-/DomainFactory-Mailpanel anlegen, sonst kommen Mails an info@ ggf. nicht an.

Wenn später **DomainFactory Professional E-Mail (Titan)** genutzt wird: MX auf Titan umstellen und SPF auf Titan-Include ändern – wiederum ohne Pages-Records anzufassen. Exakte Titan-MX/SPF aus dem DF-Kundenmenü übernehmen.

## Immowelt-Angebote (Single Source of Truth)

Aktuelle Kaufangebote auf der Website kommen aus dem Immowelt-Profil und werden automatisch synchronisiert.

- **Quelle:** [Immowelt-Profil Immobilien Eichmann](https://www.immowelt.de/profil/3b18336c6a2e401da38e9cc20268270d)
- **Canonical JSON:** `data/listings.json` (Schlüssel = Exposé-UUID)
- **Bilder:** `assets/listings/{nn}-{uuid8}.jpg` + `.webp`
- **HTML:** Karten in `index.html` und `projekte.html` zwischen den Markern `IMMWELT-LISTINGS` / `IMMWELT-COUNT` (Fragment auch unter `partials/listings-grid.html`)
- **Workflow:** `.github/workflows/sync-immowelt.yml` (`Sync Immowelt Listings`)
  - alle 3 Stunden per Cron (`0 */3 * * *` UTC) + manuell unter **Actions → Sync Immowelt Listings → Run workflow**
  - bei erfolgreichem Diff: Commit auf `main` → GitHub Pages aktualisiert sich

### Manuell aktualisieren

Lokal (Node 18+):

```bash
npm install
npx playwright install chromium   # nur für Live-Scrape
node scripts/sync-immowelt.mjs                # Live-Scrape + Bilder + HTML
node scripts/sync-immowelt.mjs --render-only  # nur HTML aus data/listings.json
node scripts/sync-immowelt.mjs --from-json /pfad/zu/listings.json
```

Oder in GitHub: **Actions → Sync Immowelt Listings → Run workflow**.

Optional: Workflow-Input *Skip scrape / render only* setzt `--render-only`.

### Soft-Fail & Bot-Schutz

Immowelt nutzt oft **DataDome** / Bot-Schutz. Schlägt der Scrape fehl, bleibt die zuletzt gültige `data/listings.json` unverändert (Exit 0) – die Site zeigt weiter die letzten guten Angebote. Kein leeres Grid durch einen fehlgeschlagenen Lauf.

Einschränkungen:

- Kein Login / kein Umgehen von Captchas – nur öffentliches Profil.
- Neue Objekte erscheinen nach dem nächsten erfolgreichen Sync (Cron oder manuell).
- Entfernte Immowelt-Exposés verschwinden beim Sync (inkl. verwaister Bilder).
- Keine Duplikate: Deduplizierung nach Exposé-UUID.

## Lokal ansehen

Einfach die HTML-Dateien im Browser öffnen oder:

```bash
npx serve .
```

## Hinweis

Struktur und Layout sind an typische Immobilien-Makler-Websites der Bodenseeregion angelehnt; Texte, Farben, Marke und Inhalte sind **eigenständig** für Immobilien Eichmann.
