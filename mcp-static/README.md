# Optional: MCP über statische JSON-URLs

Auf dem Live-Host gibt es **keinen** MCP Streamable-HTTP-Endpoint (Static auf DigitalOcean).

Discovery:

- https://immobilieneichmann.de/.well-known/mcp.json
- https://immobilieneichmann.de/ai/listings.json

Ein späterer gehosteter MCP (z. B. DigitalOcean App) braucht nur:

1. Resource `listings` → fetch `ai/listings.json`
2. Tools `search_listings` / `get_listing` → Filter über denselben Feed

Keine zweite Datenquelle anbinden — immer die Live-JSON der Website.
