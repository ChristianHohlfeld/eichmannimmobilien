# Exposé Admin

Einfaches Admin für Helmut: Exposés sehen, Texte/Fotos nachpflegen, Immowelt-Sync anstoßen.

**Live:** [https://immobilieneichmann.de/admin/](https://immobilieneichmann.de/admin/)  
(alternativ GitHub Pages-URL `/admin/`)

## Für Helmut

1. `/admin/` öffnen  
2. Passwort eingeben (von Chris)  
3. Fertig – Objekte bearbeiten, Fotos, Sync-Buttons  

Kein GitHub-Token, kein Extra-Setup auf dem Rechner.

## Was das Admin kann

| Funktion | Wirkung |
|----------|---------|
| Liste / Bearbeiten | Titel, Kurztext, Beschreibung, Preis, Zimmer, Fläche, Ort, Status |
| Speichern | Schreibt `data/listings.json` (GitHub), setzt `manual_overrides` |
| Fotos | Upload nach `assets/listings/`, Eintrag in Liste; Entfernen nur aus JSON |
| Sync Immowelt | Startet Workflow **Voll-Sync** (Profil **nur lesen/importieren**) |
| Nur rendern | Erzeugt `objekt/*.html` & Karten neu aus JSON |

## Absolute Regel: Immowelt

Das Immowelt-Konto wird **niemals** bearbeitet – weder Texte noch Fotos noch Status dort.  
Sync = Import/Lesen in diese Website. Sonst nichts.

## `manual_overrides`

Felder, die Helmut speichert, werden markiert. `scripts/sync-immowelt.mjs` überschreibt diese Felder beim nächsten Immowelt-Import **nicht**.

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
- `admin-save.yml` – Fallback: speichert JSON via `repository_dispatch` mit `GITHUB_TOKEN`

## Phase 2 (nicht gebaut)

Neue Objekte ohne Immowelt manuell anlegen.
