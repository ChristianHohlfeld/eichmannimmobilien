# Admin – Immobilien Eichmann

Live: **https://immobilieneichmann.de/admin/**

Ein einziges Admin mit Tabs:

| Tab | Zweck |
|-----|--------|
| **Immowelt** | Spiegel/Status + Website-Sichtbarkeit (`site_hidden`). Kein Schreiben ins Immowelt-Konto. |
| **Eigen-Inserate** | Volles CRUD für `origin=eigen` in SQLite. |

`/admin/eigen/` leitet nach `/admin/#eigen` um.

## Auth (kein GitHub-PAT)

```text
E-Mail (Allowlist) + Passwort
  → POST /admin/api/login
  → HttpOnly Secure SameSite=Strict Cookie
```

Passwort-Hash und E-Mail-Allowlist liegen in `admin/config.json` (wie bisher).
Die **echte** Autorisierung für Schreibzugriffe prüft der Droplet-API-Prozess
gegen denselben Hash und stellt die Session-Cookie aus.

`auth_mode`: `password_session`

## Speichern

```text
Browser
  → POST /admin/api/eigen | /visibility | /publish
  → nginx → 127.0.0.1:3847 (systemd: eichmann-admin-api)
  → SQLite /var/lib/eichmann/listings.db
  → publish-from-db → statische HTML/JSON unter /var/www/…
```

Kein `repository_dispatch`, kein PAT in `sessionStorage`/`localStorage`.

## API (localhost only)

| Methode | Pfad | Aktion |
|---------|------|--------|
| POST | `/admin/api/login` | Session-Cookie |
| POST | `/admin/api/logout` | Cookie löschen |
| GET | `/admin/api/me` | Session prüfen |
| GET | `/admin/api/listings?origin=` | `immowelt` \| `eigen` \| `all` |
| GET | `/admin/api/status` | Counts + Immowelt-Sync-Status |
| POST | `/admin/api/eigen` | Eigen upsert + publish |
| POST | `/admin/api/eigen/delete` | Eigen delete + publish |
| POST | `/admin/api/visibility` | `site_hidden` + publish |
| POST | `/admin/api/publish` | Nur publish-from-db |
| GET | `/admin/api/health` | Liveness |

## Entfernt

- `.github/workflows/admin-eigen-save.yml` (repository_dispatch + SSH upsert)
- Sitzungs-PAT / GitHub Contents API als Speichern-Pfad für Admin-CRUD
- Standalone Eigen-UI unter `/admin/eigen/` (nur Redirect)

Immowelt-Import bleibt der geplante GitHub-Workflow `sync-immowelt.yml` (read-only).

## Betrieb

- Unit: `eichmann-admin-api.service`
- Install: `deploy/install-admin-api.sh` (wird vom Deploy-to-Droplet-Workflow ausgeführt)
- Secret: `/var/lib/eichmann/admin-session.secret` (auto-generiert, nicht im Repo)
