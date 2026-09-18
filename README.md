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
| `kontakt.html` | Kontaktdaten + mailto-Formular |
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

## Lokal ansehen

Einfach die HTML-Dateien im Browser öffnen oder:

```bash
npx serve .
```

## Hinweis

Struktur und Layout sind an typische Immobilien-Makler-Websites der Bodenseeregion angelehnt; Texte, Farben, Marke und Inhalte sind **eigenständig** für Immobilien Eichmann.
