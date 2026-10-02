# MCP Registry & Directory Publishing

Live endpoint (after deploy): **https://immobilieneichmann.de/mcp**

Note: registry `description` must be ≤100 characters.

Canonical `server.json` (domain namespace): repo root `server.json` → `de.immobilieneichmann/listings`  
GitHub-namespace fallback: `mcp/server.github-namespace.json`

## 1. Official MCP Registry (`registry.modelcontextprotocol.io`)

### Preferred: HTTP domain verify (no DNS change)

1. Generate Ed25519 keypair (once; private key **never** commit):

```bash
openssl genpkey -algorithm Ed25519 -out mcp-registry-key.pem
PUBLIC_KEY="$(openssl pkey -in mcp-registry-key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "v=MCPv1; k=ed25519; p=${PUBLIC_KEY}" > .well-known/mcp-registry-auth
```

2. Commit/deploy only `.well-known/mcp-registry-auth` (public). Keep `mcp-registry-key.pem` local or in a password manager.
3. After live: `curl -fsS https://immobilieneichmann.de/.well-known/mcp-registry-auth`
4. Publish:

```bash
PRIVATE_KEY="$(openssl pkey -in mcp-registry-key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"
npx -y @modelcontextprotocol/publisher login http --domain immobilieneichmann.de --private-key "$PRIVATE_KEY"
npx -y @modelcontextprotocol/publisher publish ./server.json
```

### Alternative: GitHub OAuth (interactive)

```bash
npx -y @modelcontextprotocol/publisher login github
npx -y @modelcontextprotocol/publisher publish ./mcp/server.github-namespace.json
```

Namespace becomes `io.github.ChristianHohlfeld/immobilien-eichmann-listings`.

### Alternative: DNS TXT at apex

```text
immobilieneichmann.de. IN TXT "v=MCPv1; k=ed25519; p=<PUBLIC_KEY>"
```

Then `mcp-publisher login dns --domain immobilieneichmann.de --private-key …`

**Blocked until:** HTTP auth file live + private key available, **or** Chris completes GitHub device login, **or** DNS TXT is set at domain apex.

## 2. Smithery (`smithery.ai`)

1. Open https://smithery.ai/new
2. Enter `https://immobilieneichmann.de/mcp`
3. Name suggestion: `@eichmann/listings` or `immobilien-eichmann-listings`
4. Or CLI (needs Smithery account/API key):

```bash
npx -y @smithery/cli mcp publish "https://immobilieneichmann.de/mcp" -n eichmann/listings
```

## 3. PulseMCP + MCP.so + Glama

| Directory | URL | Action |
|-----------|-----|--------|
| PulseMCP | https://www.pulsemcp.com/submit | Paste GitHub repo + endpoint; often auto-ingests official registry |
| MCP.so | https://mcp.so | Sign in with GitHub → Add server (repo URL + remote `https://immobilieneichmann.de/mcp`) |
| Glama | https://glama.ai/mcp/servers | Add MCP Server / Connector with endpoint; `glama.json` in repo helps indexing |

### Draft listing text (copy/paste)

- **Name:** Immobilien Eichmann – Angebote  
- **Endpoint:** https://immobilieneichmann.de/mcp  
- **GitHub:** https://github.com/ChristianHohlfeld/eichmannimmobilien  
- **Tools:** `search_listings`, `get_listing`  
- **Description:** Live Streamable-HTTP MCP für Kaufangebote von Immobilien Eichmann in Konstanz/Bodensee. Daten = dieselbe `ai/listings.json` wie die Website.  
- **Tags:** immobilien, konstanz, real-estate, germany, listings  
