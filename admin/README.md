# Admin – Immobilien Eichmann

Live: **https://immobilieneichmann.de/admin/**

Für den Inhaber gebaut, nicht für Techniker: große Schrift, klare Sätze, wenige Knöpfe.

| Tab | Für wen | Inhalt |
|-----|---------|--------|
| **Start** | Inhaber, täglich | Ampel in Klartext („Alles in Ordnung“ / was zu tun ist), ein Knopf „Jetzt mit Immowelt abgleichen“, „So ändern Sie etwas“ in drei Schritten, die Angebote als Karten mit Bild, häufige Fragen. Hier kann nichts gelöscht oder verstellt werden. |
| **Eigene Angebote** | Inhaber, selten | Angebote, die nicht bei Immowelt stehen (`origin=eigen`): anlegen, ändern, verstecken, löschen. Seltene Felder liegen unter „Weitere Angaben“. |
| **Technik** | Betreuung | Eingeklappt: Details des Abgleichs, Immowelt-Zugang (Kundennummer + API-Schlüssel, nur Server), Wächter und Sichtprüfung, Sicherung. |

Regeln für Texte im Admin: keine Fachwörter (kein „Sync“, „API“, „Release“) außerhalb von „Technik“; jede Meldung sagt,
was los ist **und** was zu tun ist; im Zweifel „Sie müssen nichts tun“. Die Klartext-Ampel entsteht in
`easyStatusOf()` (`admin.js`) aus derselben Statusdatei wie die technische Zeile.

`/admin/eigen/` leitet nach `/admin/#eigen` um.

## Auth (kein GitHub-PAT)

```text
E-Mail (Allowlist) + Passwort
  → POST /admin/api/login
  → HttpOnly Secure SameSite=Strict Cookie
```

Alles zur Anmeldung liegt nur auf dem Server in `/var/lib/eichmann/secrets/admin-auth.json` (0600):

- `admin_emails` – wer sich anmelden darf. Die öffentlich abrufbare `admin/config.json` nennt niemanden und
  enthält keinen Hash; beim Start räumt der API-Prozess Altbestände dort weg.
- `users[adresse].password` – **eigenes Passwort je Person** (scrypt, gesalzen). Wer noch keines gesetzt hat,
  meldet sich mit dem bisherigen gemeinsamen Passwort an (`password_sha256`).
- Eine Anmeldung endet, sobald sich das Passwort **dieser Person** ändert; andere bleiben angemeldet.
- Unbekannte Adresse und falsches Passwort bekommen dieselbe Antwort.

### Passwort vergessen

```text
Anmeldeseite → „Passwort vergessen?“ → Adresse eingeben
  → POST /admin/api/password/forgot      antwortet immer gleich und sofort
  → im Hintergrund: Adresse zugelassen? Pause abgelaufen? → Link erzeugen → E-Mail an genau diese Adresse
E-Mail → https://immobilieneichmann.de/admin/#reset=<Schlüssel>
  → POST /admin/api/password/reset/check  (Link noch gültig?)
  → POST /admin/api/password/reset        neues Passwort für diese Person
```

- Der Link gilt 30 Minuten und einmal; gespeichert wird nur sein SHA-256. Ein neuer Link ersetzt den alten.
  Der Schlüssel steht hinter `#` und erreicht deshalb kein Server-Protokoll.
- **Schutz vor Fluten:** je Person und je Absender wachsende Pausen (1, 2, 4, 8 … Minuten, höchstens ein Tag;
  nach einem ruhigen Tag oder erfolgreicher Anmeldung von vorn), dazu höchstens 8 Mails pro Stunde insgesamt
  und ein unsichtbares Feld, das nur automatische Formular-Ausfüller füllen. Abgelehnte Versuche bekommen
  dieselbe freundliche Antwort – es geht nur keine Mail hinaus.
- **Mailversand:** über das **Formular-Gateway**, das schon die Kontakt- und Exposé-Anfragen der Website
  zustellt (`forms.digitalisierungsplanung.de` → Amazon SES). Auf diesem Server liegt dafür kein
  Mail-Passwort, sondern nur ein Signierschlüssel (`secrets/mail-gateway-key.pem`, 0600), der ihn nie verlässt.
  Die Admin-API schickt dem Gateway nur: welche Art (Passwort-Link oder Test), an wen, welcher Link –
  signiert. Das Gateway kennt die öffentliche Hälfte des Schlüssels, schreibt den Mailtext selbst und nimmt
  nur seine fest hinterlegten Empfänger und nur Links nach `https://immobilieneichmann.de/admin/` an.
  Eine Anmelde-Adresse, die dort nicht als Empfänger steht, bekommt deshalb keine Mail.
  Einrichten über **Immowelt ops (server)**: `mail-key` (Schlüssel einmal anlegen, zeigt die öffentliche
  Hälfte – kein Geheimnis; sie wird im Gateway hinterlegt), danach `mail-gateway-on` (fragt das Gateway, ob
  es diesen Server anerkennt, und schaltet nur dann ein). `mail-test` schickt eine Probe an jedes
  Anmelde-Postfach, `mail-status` zeigt den eingerichteten Weg. Ohne Einrichtung zeigt die Anmeldeseite
  stattdessen den Hinweis, sich bei der Betreuung zu melden.
  Ersatzweg ohne Gateway: Secret `EICHMANN_MAIL_URL` =
  `smtps://BENUTZER:PASSWORT@server:465/?from=absender@domain`, dann `mail-install`.
- **Notfall** (kein Mailzugang): `admin-password-set` setzt ein Passwort für alle; eigene Passwörter und
  offene Links entfallen dabei.

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
- **„Jetzt mit Immowelt abgleichen“** startet denselben Lauf sofort. Es gibt keinen Bestätigungsschritt im Admin mehr: Ein vollständig gelesener und geprüfter Stand wird direkt veröffentlicht; bei einem Fehler bleibt der letzte vollständige Stand online und die Meldung nennt den Grund. (Zwei bewusste Ausnahmen, beide in `docs/IMMOWELT-SYNC.md` beschrieben: die einmalige Identitätsfreigabe vor der ersten Übernahme aus der API und die zweite Bestätigung bei leerem Bestand oder großem Wegfall.)
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
