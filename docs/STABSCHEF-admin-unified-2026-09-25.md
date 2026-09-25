# Stabschef-Notiz: Unified Admin (2026-09-25)

## Was geändert wurde

- **Eine** Admin-URL: https://immobilieneichmann.de/admin/
  - Tab **Immowelt**: Status + Ein-/Ausblenden auf der Website
  - Tab **Eigen-Inserate**: anlegen / bearbeiten / löschen
- Speichern braucht **nur** Admin-E-Mail + Passwort — **kein GitHub-Token** mehr.
- Speichern läuft über eine kleine API auf dem Droplet (`/admin/api/` → localhost Node),
  schreibt in SQLite und publiziert die statische Site sofort.
- `/admin/eigen/` leitet nach `/admin/#eigen` um.
- Workflow `admin-eigen-save.yml` (PAT → repository_dispatch → SSH) ist entfernt.

## Wie speichern jetzt funktioniert

1. Login im Browser → Session-Cookie (HttpOnly).
2. Eigen speichern / Immowelt ausblenden → `POST /admin/api/…`
3. API prüft Cookie, aktualisiert `/var/lib/eichmann/listings.db`, führt Publish aus.
4. Öffentliche Seiten unter `/objekt/` und `data/listings.json` sind aktualisiert.

## Was Helmut / Ops wissen muss

- Login: freigeschaltete E-Mail + bisheriges Admin-Passwort.
- Kein PAT anlegen, kein Token-Feld mehr im Login.
- Immowelt-Konto bleibt unberührt (nur Lesen/Spiegel).
- Immowelt-Import (API-Sync) weiterhin über GitHub-Workflow; im Admin nur Sichtbarkeit.

## Smoke-Test

1. https://immobilieneichmann.de/admin/ → Login ohne Token-Feld.
2. Tab Eigen → + Neu → Speichern → erscheint in Liste, „nur bei uns“ auf der Site.
3. Tab Immowelt → Ausblenden → Objekt verschwindet von der öffentlichen Liste.
4. `/admin/eigen/` → Redirect auf `/admin/#eigen`.
