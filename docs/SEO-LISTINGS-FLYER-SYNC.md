# SEO sync: Listings + Flyer → generated pages

## Goal

Homepage **listings** and **flyer/projects** are the public source of truth for SEO pages.
No manual copy of exposé/project text. When a listing or flyer is removed, generated pages and sitemap entries disappear on the next publish.

## Sources of truth

| Kind | SoT | Publish entry |
|------|-----|----------------|
| Angebote von Immowelt (Kauf + Miete) | **Immowelt** (official API, hard one-way takeover, no local overrides) → SQLite on the droplet (`origin=immowelt`) | every Immowelt sync run that changed something (`scripts/immowelt-sync.mjs run`, systemd timer on the droplet) |
| Eigene Inserate | SQLite on the droplet (`origin=eigen`), maintained in the admin | admin save / `publish-from-db` |
| Neubau-Flyer / Projekte | `data/projects.json` | same publish path via `scripts/lib/projects.mjs` |

On the droplet every publish (sync run, admin save, deploy via `node scripts/release.mjs build`) builds **one complete, verified release** from the database and switches to it atomically; listings, sitemap, `ai/` index and the EN pages therefore always change together. `data/listings.json` and the rendered pages in the repository are development fixtures (local/CI render: `sync-immowelt --render-only`), not a source. Details: `docs/IMMOWELT-SYNC.md`.

Immowelt account stays **read-only**. DigiPlan `forms.*` is lead POST only (contact/expose), not listing SoT.

## Generated artifacts

**From listings (existing):**

- Cards: `index.html` / `projekte.html` (`IMMWELT-LISTINGS` markers)
- Exposés: `objekt/{slug}.html` with `schema.org/RealEstateListing`
- Sitemap objekt block; orphan HTML/images removed when not public
- `ai/listings.json` + MCP `search_listings` / `get_listing`
- `ai/immowelt-snapshot.json`: what the live build publishes from Immowelt per offer (ids, Kauf/Miete, price, fact rows, hash of every text section, pictures in order) – the basis for the watchdog and the comparison report
- URLs stay stable: an offer keeps its slug for good (frozen); a new offer gets `<type>-<district|city>-<online-id>`; an offer that is no longer in the complete Immowelt inventory loses its page and sitemap entry with the next release

**From projects/flyer (this pipeline):**

- `ai/flyer-{slug}.json` (MCP `get_flyer`)
- Project page SEO + facts markers on `{slug}.html` (e.g. `allmannsdorf.html`)
  - JSON-LD: `RealEstateListing` + `ApartmentComplex` + `BreadcrumbList`
- Sitemap `PROJECT-SITEMAP` block
- Homepage `@graph` gains `ItemList` of public listings (keeps existing `LocalBusiness` / `RealEstateAgent`)
- Remove project (`active:false` or delete from `data/projects.json`) → flyer JSON + managed project page removed

## Always-current

1. Immowelt: nothing to do by hand. The timer on the droplet (`eichmann-immowelt-sync.timer`, minute :07 and :37) reads the complete inventory from the official API and publishes changes itself; the API key lives only on the server (`/var/lib/eichmann/secrets/immowelt-api.json`). On any error the last complete state stays online, the run fails and `data/immowelt-sync-status.json` says why (server watchdog + `immowelt-watchdog.yml`).
2. After an Eigen change: admin save publishes (a release from the database); `publish-from-db` does the same by hand.
3. After flyer edit: change **only** `data/projects.json`, then publish (do not hand-edit `ai/flyer-*.json` or project SEO markers).

## Out of scope / follow-ups

- Homepage flyer **modal HTML** still hand-maintained; SoT drives JSON + project page. Next: generate modal from `data/projects.json`.
- No per-unit SEO pages for Allmannsdorf until units exist as listings (flyer has aggregate 44 WE only — do not invent units).
- Immowelt offers are never hard-deleted from the database: an offer missing from the complete inventory is retired (history kept) and is no longer public; its exposé and sitemap entry are gone with the next release. No redirect is generated for a retired offer URL.

## Verify

```bash
node scripts/test-projects-publish.mjs
node scripts/sync-immowelt.mjs --render-only
node scripts/test-jsonld.mjs
node scripts/test-ai-index.mjs
```
