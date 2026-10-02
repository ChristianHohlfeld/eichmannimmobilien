# AI Angebots-Index & MCP-Discovery

## Regel

Was auf der Live-Seite steht, zählt. Der Index ist **kein** zweites manuelles Angebot — er wird beim Publish aus derselben Listing-Liste erzeugt wie HTML-Grid, Exposé-Seiten und Sitemap.

Filter (öffentlich mit Detailseite):

- `active !== false`
- `site_hidden !== true`
- `detail_page !== false`

## Live-URLs

| Pfad | Zweck |
|------|--------|
| `/ai/listings.json` | Schlanker AI-Index (`search_listings` / `get_listing`) |
| `/data/listings.json` | Voll-Export (Render-Spiegel, `"sot": "sqlite"`) |
| `/llms.txt` | Einstieg: NAP Helmut, Index-Links, Objekt-URLs |
| `/agents.txt` | Kurz: Lesen der Angebote erlaubt, Admin verboten |
| `/.well-known/mcp.json` | Statische MCP-Discovery (Ressourcen + Tool-Konzept) |
| `/.well-known/mcp/catalog.json` | Catalog → Server-Card |
| `/ai/server-card.json` | Server-Card ohne Live-HTTP-Remote |

Hosting: **DigitalOcean Droplet** `eichmann-web` (nicht GitHub Pages). Statische Dateien reichen für Discovery.

## Aktualität

`publishListingsDocument` → `renderIntoPages` schreibt AI-Artefakte mit.

Manuell / CI ohne Full-Sync:

```bash
npm run ai:index
npm run test:ai-index
```

## Tools (Konzept)

1. **search_listings** — `GET /ai/listings.json`, `listings[]` filtern  
2. **get_listing** — per `slug`/`id`; Detail unter `url` (HTML)

Kein Streamable-HTTP-MCP auf dem Static-Host. Optional später: kleiner MCP-Server auf DigitalOcean, der genau diese JSON-URLs liest (`mcp-static/README.md`).

## Schema.org

Objektseiten haben bereits `RealEstateListing` JSON-LD (vom Sync-Renderer). Kein Extra-Schritt nötig.
