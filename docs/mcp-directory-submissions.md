# MCP Directory Submissions — Status & Click Drafts

**Live endpoint:** https://immobilieneichmann.de/mcp  
**Official registry:** `de.immobilieneichmann/listings` @ 1.0.0 — **LIVE**  
Search: https://registry.modelcontextprotocol.io/v0.1/servers?search=de.immobilieneichmann

## 1. Official MCP Registry — DONE

Published 2026-10-02 via HTTP domain verify (`/.well-known/mcp-registry-auth`).

## 2. Smithery — needs Chris login

Blocked without Smithery account / browser OAuth.

**Click:** https://smithery.ai/new  
Paste URL: `https://immobilieneichmann.de/mcp`  
Suggested name: `eichmann/listings`

CLI (after login or with `SMITHERY_API_KEY`):

```bash
npx -y @smithery/cli mcp publish "https://immobilieneichmann.de/mcp" -n eichmann/listings
```

## 3. PulseMCP — paused (auto-ingest later)

Submit form: https://www.pulsemcp.com/submit  
Status as of 2026-10-02: **submissions temporarily paused**. They say publish to Official Registry (done) and they will pick it up automatically when reopened.

## 4. MCP.so — needs GitHub login in browser

**Click:** https://mcp.so (Add / Submit server)  
Draft:

| Field | Value |
|-------|--------|
| Type | server / remote |
| Name | Immobilien Eichmann – Angebote |
| GitHub | https://github.com/ChristianHohlfeld/eichmannimmobilien |
| Endpoint | https://immobilieneichmann.de/mcp |
| Config | `{"mcpServers":{"immobilien-eichmann":{"url":"https://immobilieneichmann.de/mcp"}}}` |
| Description | Live Streamable-HTTP MCP für Kaufangebote von Immobilien Eichmann in Konstanz. Tools: search_listings, get_listing. Quelle = ai/listings.json. |
| Tags | immobilien, konstanz, real-estate, germany, listings |

## 5. Glama — needs browser / claim

**Click:** https://glama.ai/mcp/servers (Add MCP Server / Connector)  
Also: claim after official-registry ingest. Repo has `glama.json`.

| Field | Value |
|-------|--------|
| Display name | Immobilien Eichmann Listings |
| GitHub | https://github.com/ChristianHohlfeld/eichmannimmobilien |
| Connector URL | https://immobilieneichmann.de/mcp |
| Transport | streamable-http |
| Description | Live MCP for Kaufangebote in Konstanz. Tools search_listings + get_listing. |

## Private key (HTTP registry auth)

Ed25519 private key used for publish is **not** in git. Kept on agent box at `/workspace/secrets/mcp-registry-key.pem` during this session. Chris should store a copy in a password manager for further publishes; public proof stays at `https://immobilieneichmann.de/.well-known/mcp-registry-auth`.
