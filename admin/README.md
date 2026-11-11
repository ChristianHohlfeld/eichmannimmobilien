# Admin – Immobilien Eichmann

Live: **https://immobilieneichmann.de/admin/**

Ein einziges Admin mit Tabs:

| Tab | Zweck |
|-----|--------|
| **Immowelt** | Zugang (Kundennummer + API-Schlüssel, nur Server), Status des Abgleichs und „Immowelt Sync“. Immowelt-Angebote werden hier nur angezeigt: an/aus, Texte, Preise und Bilder kommen vollständig von Immowelt (harte Einweg-Übernahme), ein lokales Ausblenden (`site_hidden`) gibt es für sie nicht mehr. Kein Schreiben ins Immowelt-Konto. |
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
  → vollständiges Release aus der Datenbank bauen und prüfen
  → atomar umschalten (/var/www/… → /var/lib/eichmann/releases/current)
```

Es wird nie in den ausgelieferten Baum geschrieben. Die Veröffentlichung läuft unter derselben Sperre wie der Immowelt-Abgleich; läuft gerade ein Abgleich, wartet das Speichern (bis zu drei Minuten) darauf.

Kein `repository_dispatch`, kein PAT in `sessionStorage`/`localStorage`.

## Immowelt

- **Einzige Quelle** für Immowelt-Angebote ist Immowelt (offizielle API). Der Abgleich läuft auf dem Droplet als systemd-Timer (`eichmann-immowelt-sync.timer`, Minute :07 und :37) mit `node scripts/immowelt-sync.mjs run`.
- **„Immowelt Sync“** startet denselben Lauf sofort. Es gibt keinen Bestätigungsschritt im Admin mehr: Ein vollständig gelesener und geprüfter Stand wird direkt veröffentlicht; bei einem Fehler bleibt der letzte vollständige Stand online und die Meldung nennt den Grund. (Zwei bewusste Ausnahmen, beide in `docs/IMMOWELT-SYNC.md` beschrieben: die einmalige Identitätsfreigabe vor der ersten Übernahme aus der API und die zweite Bestätigung bei leerem Bestand oder großem Wegfall.)
- **Sichtbarkeit:** `/admin/api/visibility` antwortet für `origin=immowelt` mit **409** – ein- und ausgeschaltet wird auf Immowelt.
- **Zugang:** Der API-Schlüssel liegt nur auf dem Server in `/var/lib/eichmann/secrets/immowelt-api.json` (600). Er kommt über dieses Formular oder über den Workflow „Immowelt API key → server“ (Actions-Secret `IMMOWELT_API_KEY` → STDIN) dorthin; die API gibt ihn nie vollständig zurück.
- **Status:** `data/immowelt-sync-status.json` (Schema `eichmann.immowelt-sync-status/v2`).
- Alles Weitere (Umstellung, Rollback, Alarm, Prüfplan): `docs/IMMOWELT-SYNC.md`.

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
| POST | `/admin/api/visibility` | `site_hidden` + publish – nur eigene Inserate; `origin=immowelt` → 409 |
| POST | `/admin/api/publish` | Nur veröffentlichen (Release aus der Datenbank) |
| POST | `/admin/api/immowelt/sync` | Immowelt-Abgleich sofort starten (derselbe Lauf wie der Timer) |
| GET, PUT | `/admin/api/immowelt/credentials` | Zugangs-Status (Schlüssel maskiert) lesen / Zugang speichern |
| GET | `/admin/api/health` | Liveness |

## Entfernt

- `.github/workflows/admin-eigen-save.yml` (repository_dispatch + SSH upsert)
- Sitzungs-PAT / GitHub Contents API als Speichern-Pfad für Admin-CRUD
- Standalone Eigen-UI unter `/admin/eigen/` (nur Redirect)

- GitHub-Workflows `sync-immowelt.yml`, `data-age.yml` und `admin-save.yml` (11.11.2026): Der Immowelt-Abgleich läuft auf dem Droplet (siehe „Immowelt“ oben), nicht mehr in GitHub Actions.
- Lokales Ausblenden von Immowelt-Angeboten und der Bestätigungsschritt nach „Immowelt Sync“.

## Betrieb

- Unit: `eichmann-admin-api.service`
- Install: `deploy/install-admin-api.sh` (wird vom Deploy-to-Droplet-Workflow ausgeführt)
- Secret: `/var/lib/eichmann/admin-session.secret` (auto-generiert, nicht im Repo)
