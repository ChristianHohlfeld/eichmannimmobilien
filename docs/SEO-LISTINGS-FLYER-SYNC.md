# SEO sync: Listings + Flyer → generated pages

## Goal

Homepage **listings** and **flyer/projects** are the public source of truth for SEO pages.
No manual copy of exposé/project text. When a listing or flyer is removed, generated pages and sitemap entries disappear on the next publish.

## Sources of truth

| Kind | SoT | Publish entry |
|------|-----|----------------|
| Kaufangebote (Immowelt + Eigen) | SQLite (`origin=immowelt\|eigen`) → export `data/listings.json` | `publish-from-db` / `sync-immowelt --render-only` |
| Neubau-Flyer / Projekte | `data/projects.json` | same publish path via `scripts/lib/projects.mjs` |

Immowelt account stays **read-only**. DigiPlan `forms.*` is lead POST only (contact/expose), not listing SoT.

## Generated artifacts

**From listings (existing):**

- Cards: `index.html` / `projekte.html` (`IMMWELT-LISTINGS` markers)
- Exposés: `objekt/{slug}.html` with `schema.org/RealEstateListing`
- Sitemap objekt block; orphan HTML/images removed when not public
- `ai/listings.json` + MCP `search_listings` / `get_listing`

**From projects/flyer (this pipeline):**

- `ai/flyer-{slug}.json` (MCP `get_flyer`)
- Project page SEO + facts markers on `{slug}.html` (e.g. `allmannsdorf.html`)
  - JSON-LD: `RealEstateListing` + `ApartmentComplex` + `BreadcrumbList`
- Sitemap `PROJECT-SITEMAP` block
- Homepage `@graph` gains `ItemList` of public listings (keeps existing `LocalBusiness` / `RealEstateAgent`)
- Remove project (`active:false` or delete from `data/projects.json`) → flyer JSON + managed project page removed

## Always-current

1. Immowelt API key in admin (today: `awaiting_api_key` since 2026-09-20 — last good mirror stays online).
2. After Immowelt or Eigen change: publish (`publish-from-db` / admin publish).
3. After flyer edit: change **only** `data/projects.json`, then publish (do not hand-edit `ai/flyer-*.json` or project SEO markers).

## Out of scope / follow-ups

- Homepage flyer **modal HTML** still hand-maintained; SoT drives JSON + project page. Next: generate modal from `data/projects.json`.
- No per-unit SEO pages for Allmannsdorf until units exist as listings (flyer has aggregate 44 WE only — do not invent units).
- Default Immowelt `sync_policy` is not hard-delete; deactivation + orphan cleanup of non-public exposés already applies on render.

## Verify

```bash
node scripts/test-projects-publish.mjs
node scripts/sync-immowelt.mjs --render-only
node scripts/test-jsonld.mjs
node scripts/test-ai-index.mjs
```
