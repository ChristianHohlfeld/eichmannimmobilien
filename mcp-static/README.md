# MCP – Immobilien Eichmann

Live **Streamable-HTTP** MCP on the droplet (alongside static nginx):

- Endpoint: `https://immobilieneichmann.de/mcp`
- Tools: `search_listings`, `get_listing`
- Source: Live `/ai/listings.json` (same publish pipeline as the website — no second list)
- Process: `eichmann-mcp.service` → `127.0.0.1:3848`, nginx `/mcp`

## Local smoke

```bash
EICHMANN_SITE_ROOT=$PWD EICHMANN_MCP_PORT=3848 npm run mcp
# other terminal:
npm run test:mcp
```

## Registry / directories

See `docs/mcp-registry-publish.md`.
