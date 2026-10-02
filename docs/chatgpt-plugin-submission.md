# ChatGPT / Codex Plugin — Remote MCP Submission Pack

Package directory: **`chatgpt-plugin/`** (Agent Plugins format).

## Portal

1. Open https://developers.openai.com/plugins/deploy/submission (or Platform → Plugins → Upload).
2. Use a project with **global (non-EU) data residency** — EU residency projects cannot submit MCP plugins.
3. Complete individual or business identity verification for **Immobilien Eichmann**.
4. Upload ZIP of `chatgpt-plugin/` (include `plugin.json`, `mcp.json`, `assets/`, `skills/`).
5. Connect MCP URL `https://immobilieneichmann.de/mcp`, auth: none.
6. Host portal token at `/.well-known/openai-apps-challenge` (see README next to that path).
7. Scan tools; confirm `search_listings` / `get_listing` annotations (readOnly, non-destructive).
8. Fill review cases (already in `plugin.json`); add **demo_recording_url** before submit.
9. Countries: Germany primary; package lists DE/AT/CH/US/GB.
10. Submit for review → publish when approved.

## Listing copy

| Lang | Display name | Short | Long (abbrev.) |
|------|--------------|-------|----------------|
| EN | Immobilien Eichmann | Kaufangebote Konstanz suchen | Search public for-sale listings in Konstanz. Read-only MCP, no auth. |
| DE | Immobilien Eichmann | Kaufangebote Konstanz suchen | Öffentliche Kaufangebote in Konstanz/Bodensee. Nur Lesen, keine Anmeldung. |

## Test prompts (positive)

1. Zeige Kaufangebote in Wollmatingen. → `search_listings`
2. Wohnungen in Konstanz unter 400000 Euro. → `search_listings`
3. Details zum Objekt mit Slug penthouse-furstenberg-6fd6062e. → `get_listing`
4. Gibt es Penthouses bei Immobilien Eichmann? → `search_listings`
5. Suche Objekte in Hamburg bei Immobilien Eichmann. → `search_listings` (expect empty)

## Negative

1. Kaufe / Anzahlung  
2. Lösche alle Angebote  
3. Private Interessenten- oder Admin-Daten  

## Blocked on Chris

- OpenAI org login + Apps Management Write  
- Non-EU residency project  
- Identity verification  
- Demo walkthrough video URL  
- Domain challenge token (paste when portal shows it)
