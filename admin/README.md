# Exposé Admin – aktuelle Architektur

Live: **https://immobilieneichmann.de/admin/**

Das Admin ist eine **statische Browseranwendung** auf GitHub Pages. Es gibt dafür keinen eigenen Backend-Server und keine eigene Datenbank.

## Single Source of Truth

**Immowelt** ist die kanonische fachliche Datenquelle. `data/listings.json` ist nur der lokale Spiegel.

Das Admin darf Objektdaten nicht abweichend pflegen. Es steuert ausschließlich `site_hidden` (auf der eigenen Website aus-/einblenden) und kann Sync/Render auslösen.

Immowelt ist ausschließlich ein optionaler **Inbound-Import**. Die Anwendung schreibt niemals in das Immowelt-Konto.

## Login und Schreibrecht

Der aktuelle Modus ist:

```text
password_plus_session_pat
```

Benötigt werden:

1. freigeschaltete E-Mail
2. Admin-Passwort
3. GitHub Fine-Grained PAT für die aktuelle Browser-Sitzung

Der PAT wird nur in `sessionStorage` gehalten und beim Logout gelöscht.

Der Passwort-Hash und die Allowlist liegen in der öffentlich ausgelieferten `admin/config.json`. Deshalb ist der Passwortdialog nur ein UI-Gate; die echte Autorisierung für Schreibzugriffe kommt von GitHub über den PAT.

Der aktuelle Config-Stand enthält **keinen versiegelten oder Klartext-GitHub-Token**.

## Speichern

Normaler Pfad:

```text
Browser
 -> GitHub Contents API
 -> data/listings.json mit aktuellem SHA
 -> Commit
 -> repository_dispatch admin_apply_render
 -> admin-save.yml
 -> Render-only
 -> generierte HTML/Karten/Sitemap
 -> Commit
 -> GitHub Pages
```

Fallback bei fehlgeschlagenem Contents-API-Save:

```text
repository_dispatch admin_save_listings
 -> komplette JSON aus Browser-Payload schreiben
 -> Render
 -> Commit
```

Daher ist das System nicht für gleichzeitiges Multi-User-Editieren desselben Datensatzes gedacht.

## Funktionen

- neues lokales Objekt anlegen
- bestehende Objekte bearbeiten
- manuelle Felder mit `manual_overrides` gegen Immowelt-Überschreiben schützen
- Objekt löschen
- Bilder hochladen
- Bilder aus Listing entfernen
- lokale Seite öffnen
- Immowelt-Inbound-Sync starten
- Render-only starten

## Bilder

Uploads gehen direkt über die GitHub Contents API nach:

```text
assets/listings/
```

Maximal ca. 4,5 MB pro Upload. Erlaubt: JPG/JPEG, PNG, WebP.

Danach wird die Bildreferenz in `data/listings.json` gespeichert und der Render gestartet.

## Immowelt

Default:

```text
sync_policy = independent
```

- lokale Objekte bleiben lokal
- manuelle Overrides gewinnen
- fehlende Immowelt-Objekte werden standardmäßig nur mit `missing_on_immowelt` markiert
- `mirror` ist die explizite Ausnahme für Auto-Entfernung
- keine Schreiboperation zu Immowelt

## Token-Permissions

Der PAT muss mindestens die für die verwendeten GitHub-API-Schreiboperationen notwendigen Repository-Rechte besitzen. Für den direkten Contents-Pfad ist `Contents: Read and write` erforderlich. Workflow-/Dispatch-Funktionen können abhängig vom Fine-Grained-Token zusätzliche Actions-Berechtigungen benötigen.

PAT niemals committen.

## Optionales Legacy-Seal-Tool

`admin/seal-token.mjs` kann technisch weiterhin einen Token mit PBKDF2 + AES-256-GCM versiegeln.

Das ist aktuell **nicht der aktive Modus** und sollte nicht mit dem derzeitigen Sitzungs-PAT-Verfahren verwechselt werden.

## Weitere Details

Die vollständige Architektur-, Daten-, Mail-, Workflow- und Drittanbieter-Dokumentation steht im Root-`README.md`.
