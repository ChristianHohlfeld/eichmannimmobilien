# Exposé Admin

Einfaches Admin für Helmut: Exposés anlegen, bearbeiten, löschen, Texte/Fotos nachpflegen, optional Immowelt importieren.

**Live:** [https://immobilieneichmann.de/admin/](https://immobilieneichmann.de/admin/)  
(alternativ GitHub-Pages-URL `/admin/`)

## Single Source of Truth (SoT)

**SoT = unsere Exposés** in `data/listings.json` + dieses Admin.

| Rolle | Bedeutung |
|-------|-----------|
| `data/listings.json` + Admin | **maßgeblich** – Insert / Update / Delete |
| Immowelt | **optionaler Inbound-Import** (nur lesen) |
| Immowelt-Konto | wird **niemals** beschrieben |

Nach jedem Speichern/Löschen/Anlegen läuft automatisch **Render-only** (`objekt/*.html`, Karten, Sitemap) über `admin-save.yml` bzw. `sync-immowelt.yml` mit `force_from_json=true`.

## Für Helmut

1. `/admin/` öffnen  
2. Freigeschaltete E-Mail + Passwort eingeben (von Chris)  
3. Objekte anlegen / bearbeiten / löschen, Fotos, optional Immowelt-Import  

Kein GitHub-Token, kein Extra-Setup auf dem Rechner.

## Was das Admin kann

| Funktion | Wirkung |
|----------|---------|
| + Neues Objekt | Lokaler SoT-Eintrag (eigene id/slug); optional Immowelt-URL/UUID nur zum Vorfüllen |
| Bearbeiten / Speichern | Schreibt `data/listings.json`, setzt `manual_overrides`, **Auto-Render** |
| Löschen | Entfernt aus JSON; Render löscht `objekt/{slug}.html` und orphan Assets |
| Fotos | Upload nach `assets/listings/`, Eintrag in Liste |
| Immowelt-Import | Liest Profil, **merged inbound**; fehlende IDs → `missing_on_immowelt` (kein Auto-Delete) |
| Nur rendern | Erzeugt HTML/Karten/Sitemap neu aus SoT-JSON |

## Immowelt-Sync-Policy

- Neue Immowelt-IDs → Insert-Kandidaten  
- Bestehende → unlocked Felder mergen; `manual_overrides` und `source: local` sind autoritativ  
- Auf Immowelt verschwunden → **kein** Löschen lokal (Flag `missing_on_immowelt: true`)  
- Ausnahme nur bei `sync_policy: "mirror"` **und** gesetzter `immowelt_id`  
- Default: `sync_policy: "independent"` – Unabhängigkeit von Immowelt  

## Absolute Regel: Immowelt

Das Immowelt-Konto wird **niemals** bearbeitet – weder Texte noch Fotos noch Status dort.  
Sync = Import/Lesen in diese Website. Sonst nichts.

## Sicherheit (bewusst einfach)

- Passwort-Gate (SHA-256 in `admin/config.json`) – hält Zufallsbesucher draußen, kein Bank-Niveau.
- Schreib-Token liegt **versiegelt** (AES-GCM, aus Passwort abgeleitet) in `config.json`, Klartext nur nach Login im `sessionStorage`.
- Klartext-Passwort und Roh-Token **nie** committen.
- `robots.txt` und `noindex` für `/admin/`.

## Passwort / Token rotieren (nur coder/Chris, nicht Helmut)

```bash
# Neues Passwort wählen, Hash + Versiegelung neu erzeugen:
node admin/seal-token.mjs --password 'NEUES-PASSWORT'
# Optional Repo-Secret für Action-Fallback aktualisieren:
gh secret set ADMIN_DISPATCH_TOKEN --body "$(gh auth token)"
```

Siehe Skript `admin/seal-token.mjs`.

## Lokal testen

```bash
# beliebiger Static Server im Repo-Root
npx serve -p 5500
# → http://localhost:5500/admin/
```

## Workflows

- `sync-immowelt.yml` – Cron + manueller Immowelt-Import / Render-only  
- `admin-save.yml` – Admin Apply: speichert JSON (optional) + **render-only** + Commit aller Outputs (`GITHUB_TOKEN`)
