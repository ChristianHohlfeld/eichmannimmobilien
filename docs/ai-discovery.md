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
| `/mcp` | Live Streamable-HTTP MCP (`search_listings`, `get_listing`) |
| `/mcp.html` | **CTAs:** Claude deep-link, ChatGPT paste, Cursor/VS Code mcp.json |
| `/ai/listings.json` | Schlanker AI-Index |
| `/data/listings.json` | Voll-Export (Render-Spiegel) |
| `/llms.txt` | Einstieg: NAP, Index, **Connect-Anleitung** |
| `/agents.txt` | Kurz: Lesen erlaubt, Admin verboten |
| `/.well-known/mcp.json` | Statische MCP-Discovery |
| `/.well-known/mcp/catalog.json` | Catalog → Server-Card |
| `/ai/server-card.json` | Server-Card |

Hosting: **DigitalOcean Droplet** `eichmann-web`.

## Connect (copy)

- Claude: https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Immobilien%20Eichmann&connectorUrl=https%3A%2F%2Fimmobilieneichmann.de%2Fmcp
- ChatGPT Developer Mode: paste `https://immobilieneichmann.de/mcp`
- Cursor/VS Code: `{"mcpServers":{"immobilien-eichmann":{"url":"https://immobilieneichmann.de/mcp"}}}`

## Aktualität

`publishListingsDocument` → `renderIntoPages` schreibt AI-Artefakte mit.

```bash
npm run ai:index
npm run test:ai-index
npm run test:mcp
```

## Schema.org

Objektseiten haben `RealEstateListing` JSON-LD (Sync-Renderer).
