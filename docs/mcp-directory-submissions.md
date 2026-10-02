# MCP Directory Submissions — Priority & Status

**Live endpoint:** https://immobilieneichmann.de/mcp  
**On-site CTAs:** https://immobilieneichmann.de/mcp.html  
**Official registry:** `de.immobilieneichmann/listings` @ 1.0.0 — **LIVE**  
Search: https://registry.modelcontextprotocol.io/v0.1/servers?search=de.immobilieneichmann

## Priority (2026-10-02)

1. **On-site CTAs** (ship first — conversion while reviews pend) — `mcp.html` + `llms.txt` / `agents.txt`
2. **ChatGPT Plugins Directory** — remote MCP ZIP + portal
3. **Claude** — custom connector deep-link (no Team required) → then Directory at https://claude.ai/directory/manage
4. **Official MCP Registry** — **DONE**
5. **Smithery** — https://smithery.ai/new
6. **Glama / MCP.so** — claim / submit when logged in
7. ~~PulseMCP~~ — skip (submissions paused; auto-ingest later)
8. ~~Gemini web~~ — skip (US-only)

---

## 0. On-site CTAs — SHIP

| Client | Action |
|--------|--------|
| Claude | https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Immobilien%20Eichmann&connectorUrl=https%3A%2F%2Fimmobilieneichmann.de%2Fmcp |
| ChatGPT | Developer Mode / Apps → paste `https://immobilieneichmann.de/mcp` |
| Cursor / VS Code | `{"mcpServers":{"immobilien-eichmann":{"url":"https://immobilieneichmann.de/mcp"}}}` |

Page: `/mcp.html` · Privacy: `/datenschutz.html` §7 MCP

## 1. ChatGPT Plugins Directory

- Docs: https://developers.openai.com/plugins/deploy/submission  
- Package in repo: `chatgpt-plugin/` (ZIP for portal upload)  
- Prep notes: `docs/chatgpt-plugin-submission.md`  
- Domain verify path: `/.well-known/openai-apps-challenge` (token from portal; see `.well-known/openai-apps-challenge.README.md`)  
- **Blockers:** Chris OpenAI login + **non-EU-residency** project + identity verification; demo video URL; portal Upload

| Field | Value |
|-------|--------|
| Name | Immobilien Eichmann |
| MCP URL | https://immobilieneichmann.de/mcp |
| Privacy | https://immobilieneichmann.de/datenschutz.html |
| Support | https://immobilieneichmann.de/kontakt.html |
| Terms | https://immobilieneichmann.de/mcp.html#nutzung |
| Company / website | https://immobilieneichmann.de/ |
| Countries | DE (+ AT, CH, US, GB as listed in package) |
| Auth | None |

## 2. Claude

- **Custom connector (works without Team):** deep-link above / `mcp.html`
- **Directory:** https://claude.ai/directory/manage — try with paid Claude; if gated, report

## 3. Official MCP Registry — DONE

Published 2026-10-02 via HTTP domain verify (`/.well-known/mcp-registry-auth`).

## 4. Smithery — needs Chris login

**Click:** https://smithery.ai/new  
Paste: `https://immobilieneichmann.de/mcp` · Name: `eichmann/listings`

```bash
npx -y @smithery/cli mcp publish "https://immobilieneichmann.de/mcp" -n eichmann/listings
```

## 5. MCP.so — needs GitHub login in browser

Draft: name Immobilien Eichmann – Angebote · endpoint `https://immobilieneichmann.de/mcp` · repo ChristianHohlfeld/eichmannimmobilien

## 6. Glama — claim / add

**Click:** https://glama.ai/mcp/servers · `glama.json` in repo

## Private key (HTTP registry auth)

Ed25519 private key used for publish is **not** in git. Chris should store a copy in a password manager; public proof at `https://immobilieneichmann.de/.well-known/mcp-registry-auth`.
2026-10-02T08:37:31+02:00
