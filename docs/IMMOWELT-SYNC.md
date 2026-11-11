# Immowelt → Website: harter Einweg-Abgleich

Runbook für den Betrieb von immobilieneichmann.de. Erstfassung 11.11.2026, geschrieben **vor** dem Rollout:
Es wurde nichts ausgerollt, kein Schlüssel auf den Server gebracht, kein Screenshot erstellt und keine
Nachricht versendet. Was bisher nur gegen Fixtures geprüft ist, steht in [9.5](#95-was-bisher-nicht-real-geprüft-ist).

**Stand nach dem Rollout am 11.11.2026:** Die Website zeigt den Immowelt-Bestand, die Timer laufen, der äußere
Wächter ist an (aus: Variable `IMMOWELT_WATCHDOG_ENABLED=false`). Abweichend von der Erstfassung unten gilt:
- Die Umstellung des Servers legt vorab selbst einen DigitalOcean-Snapshot an (`layout = install`).
- Alle Angebote haben Adressen aus Immowelt (`objekt/<objektart>-<ort>-<stadtteil>-<online-id>.html`); die früheren
  Adressen leiten weiter (`immowelt-sync.mjs reslug`, einmalig ausgeführt).
- Dem Inserat beigefügte Dokumente (API-Element `attachments`) werden übernommen und als „Dokumente“ verlinkt.
- Auf `projekte.html` stehen die Sunside-Wohnungen nur noch einmal (Raster); oben verweist eine Zeile auf das Projekt.
- „Preis auf Anfrage“ ergibt sich nur aus dem Hauptpreis; Daten zurückgezogener Angebote stehen in keiner Datei des Release.

**Grundsatz:** Immowelt ist die einzige Quelle aller Angebotsdaten. Die Website zeigt genau das, was die
Immowelt-API vollständig liefert – nichts wird lokal korrigiert, ergänzt, umbenannt oder zurückgehalten.
Geändert wird ausschließlich auf Immowelt.

Inhalt: [1 Kurzfassung](#1-kurzfassung-und-garantien) · [2 Architektur](#2-architektur) ·
[3 Was übernommen wird](#3-was-übernommen-wird--und-was-nicht) · [4 API-Schlüssel](#4-api-schlüssel) ·
[5 Rollout](#5-rollout) · [6 Betrieb](#6-betrieb) · [7 Alarm](#7-alarm) · [8 Rollback](#8-rollback) ·
[9 Prüfplan](#9-prüfplan) · [10 Offene Entscheidungen](#10-offene-entscheidungen-und-bekannte-grenzen)

---

## 1. Kurzfassung und Garantien

- **Quelle:** die offizielle Immowelt-API (SOAP, nur lesend). Immowelt ist die einzige Quelle für Immowelt-Inserate.
- **Wer arbeitet:** der Droplet `eichmann-web`. Ein systemd-Timer startet alle 30 Minuten (`:07` und `:37`,
  bis zu 2 Minuten Streuung) `node scripts/immowelt-sync.mjs run`.
- **Was ein Lauf tut:** Bestand vollständig lesen, jedes Exposé und jedes Bild holen, auf Vollständigkeit prüfen,
  alle Immowelt-Zeilen in SQLite ersetzen, die komplette Website als neues Release bauen, das Release gegen die
  Daten prüfen und mit einem einzigen Symlink-Wechsel live schalten.
- **Bei jedem Fehler:** Datenbank und Website bleiben exakt auf dem letzten vollständigen Stand, der Lauf endet
  mit Fehlercode, die Statusdatei nennt den Grund, zwei Wächter melden es.
- **GitHub Actions** überträgt nur noch Code auf den Server, testet und überwacht von außen. Über das Repository
  fließen keine Inseratsdaten mehr auf die Website.
- **Eigene Inserate** (`origin = eigen`) fasst der Abgleich nicht an; sie stehen unverändert in jedem Release.
- **Der Heimserver „mag“** kommt nirgends vor – nicht als Runner, nicht als Proxy.

| Garantie | Wodurch |
|---|---|
| Einweg | Der Code enthält genau zwei API-Aufrufe (`GetListCustomerProjects`, `GetEstateExposeByEstateGuid`) und Bild-Abrufe. Es gibt keinen schreibenden Aufruf. |
| Hart überschreiben | Jedes Angebot ersetzt seine Zeile vollständig. Sichtbarkeit wird erzwungen (`active=1`, `site_hidden=0`, Detailseite an). Lokale Titel-, Text- und Adresskorrekturen gelten für API-Angebote nicht; die Sichtbarkeit lässt sich im Admin nicht mehr ändern (HTTP 409). |
| Eigene Inserate bleiben | Geschrieben wird ausschließlich `origin = immowelt`; die Transaktion bricht ab, wenn sich eine eigene Zeile verändert hätte. |
| Fail-closed, letzter guter Stand | Alles vor dem Umschalten arbeitet auf Kopien. Scheitert ein Schritt, wird nichts Öffentliches berührt. |
| Nie Teilpublikation | Ein fehlendes Exposé, ein nicht ladbares Bild oder eine fehlende Listenseite lässt den ganzen Lauf scheitern. Datenbank: eine Transaktion. Website: ein `rename`. |
| Gültiger Leerbestand | Meldet die API vollständig „keine Angebote“, wird das nach einer zweiten identischen Antwort veröffentlicht ([6.4](#64-bestätigung-bei-leerbestand-und-massenwegfall)). |
| Gelöschtes verschwindet | Was nicht mehr im vollständigen Bestand steht, verliert im selben Release Seite (DE/EN), Karte, Sitemap-Eintrag und Eintrag im AI-Index/MCP. |
| Historie | Jeder gesehene Stand, jede Änderung je Angebot, jeder Lauf, die Rohantworten der API, alle Originalbilder; dazu eine Datenbank-Sicherung vor jeder Veröffentlichung ([2.4](#24-layout-auf-dem-server)). |
| Nie still | Jeder Lauf schreibt die Statusdatei – auch ohne Änderung, auch bei Fehler. Dass gar kein Lauf stattfindet, erkennen die Wächter am Alter ([7](#7-alarm)). |
| Schlüssel bleibt geheim | Auf dem Server liegt er in genau einer Datei (0600), in GitHub als Actions-Secret; ein Test prüft, dass er in keinem Log, Status, Archiv oder Release steht. |

---

## 2. Architektur

### 2.1 Entscheidungen

| Frage | Entscheidung | Begründung |
|---|---|---|
| Scheduler | systemd-Timer auf dem Droplet, `OnCalendar=*:07,37`, `Persistent=true` | Datenbank, Bilder und Webserver liegen dort; nur dort kann ein Lauf lesen, bauen und atomar umschalten. GitHub garantiert für geplante Workflows keine pünktliche Ausführung, und der Schlüssel müsste bei jedem Lauf durch einen Runner. `Persistent` holt verpasste Läufe nach einem Neustart sofort nach. |
| Autorität | Immowelt-API, vollständig gelesen (`TotalCount` bestätigt) | „An/aus“ ist nur als Vollständigkeitsaussage beweisbar: Ein Angebot ist online, wenn es im vollständigen Bestand steht. Jede lokale Korrektur wäre eine zweite Quelle. |
| Publikationsort | Droplet; komplette Releases unter `/var/lib/eichmann/releases/<id>/`, das Webroot ist ein Symlink | Ein Schreiber, eine Sperre. Besucher sehen den alten oder den neuen Stand, nie einen halb geschriebenen. Zurückschalten ist derselbe eine Schritt. |
| Rolle von GitHub Actions | Code-Deploy, Tests, externer Wächter, Bedienung per Knopf | Ein zweites, unabhängiges System muss merken, wenn das erste steht – das kann der Server nicht über sich selbst sagen. |
| Datenhaltung | SQLite auf dem Droplet (`/var/lib/eichmann/listings.db`) | `data/listings.json` und die gerenderten Seiten im Repository sind Entwicklungs-Fixtures (Stand 20.09.2026). Sie werden nie veröffentlicht: Ein Release entsteht ausschließlich aus der Datenbank. |
| Öffentliches Repository | enthält Code, Vorlagen und Fixtures mit erfundenen Texten | Keine Schlüssel, keine echten Inseratstexte. Den Schlüssel verwenden nur von Hand gestartete Workflows; Zugriff auf den Server haben nur Läufe auf `main`. |

### 2.2 Ein Lauf

```
Timer (:07 / :37)  →  node scripts/immowelt-sync.mjs run --trigger timer

 1  Sperre            eine Sperre für alles, was die Website schreibt; belegt → Lauf endet ohne Wirkung
 2  Angehalten?       ja → Zustand „held“, Ende
 3  Nachholen         wurde der letzte Lauf zwischen Datenbank und Umschalten unterbrochen → Umschalten abschließen
 4  Schlüssel         /var/lib/eichmann/secrets/immowelt-api.json; fehlt → „awaiting_api_key“
 5  Bestand lesen     GetListCustomerProjects (GeoID 108), alle Seiten, bis TotalCount erreicht ist
 6  Exposés lesen     GetEstateExposeByEstateGuid für JEDES Angebot
 7  Normalisieren     ein Datensatz je Angebot: Kennungen, Kauf/Miete, Preis, Fakten, Texte, Bilder
 8  Prüfen            vollständig und widerspruchsfrei? sonst Abbruch
 9  Bilder            jedes Bild laden, als Bild prüfen, umrechnen; eines fehlt → Abbruch
10  Vergleichen       gleicher Fingerabdruck wie veröffentlicht → nur Status schreiben (ggf. Datum fortschreiben)
11  Bestätigung       Leerbestand oder Massenwegfall → erst nach identischer zweiter Antwort
12  Kandidat          Kopie der Datenbank, Snapshot darauf anwenden
13  Release bauen     komplette Website aus der Kandidaten-Datenbank nach releases/<id>.staging
14  Release prüfen    Seiten ↔ Daten: Kennungen, Überschrift, Preiszeile, Abschnitte wörtlich, Fakten,
                      Bilder in Reihenfolge, Karten, Zähler, Sitemap, EN-Seiten, AI-Index, Bilddateien vorhanden
15  Live-Datenbank    Sicherung, dann derselbe Snapshot in EINER Transaktion
16  Umschalten        releases/current → <id> (ein rename); Probe über den Webserver, sonst sofort zurück
17  Status            Statusdatei, Laufprotokoll, optionale Alarm-Senken; danach Aufräumen
```

Schritte 5–14 ändern nichts, was die Website gerade zeigt; neue Bilddateien kommen unter neuen Namen hinzu. Zeitlimits: 30 s je API-Aufruf, bis zu 3 Wiederholungen mit
wachsender Pause bei Zeitüberschreitung, Netzfehler, HTTP 5xx/429 oder abgeschnittener Antwort; **keine**
Wiederholung bei abgelehntem Schlüssel. Bewegt sich die Liste während des Lesens (Duplikat, leere Seite,
geänderter `TotalCount`), wird sie komplett neu gelesen, höchstens dreimal. Ein Timer-Lauf ist auf 15 Minuten begrenzt.

Deploys, das Speichern eigener Inserate im Admin und jeder Rollback gehen durch dieselbe Sperre und denselben
Weg „Release bauen → prüfen → umschalten“. Es gibt keinen zweiten Schreiber.

### 2.3 DE, EN, SEO, MCP

Ein Release enthält alles aus einem Guss: Objektseiten deutsch (`objekt/`) und englisch (`en/property/`),
Übersichten, Themenseiten, `sitemap.xml`, strukturierte Daten, `ai/listings.json`, `llms.txt`. Der MCP-Dienst liest
`ai/listings.json` aus dem Webroot (Zwischenspeicher 15 Sekunden) und folgt damit jedem Umschalten.
Die Release-Prüfung verlangt, dass die Mengen übereinstimmen: genau die veröffentlichten Angebote, in jeder dieser Ausgaben.

### 2.4 Layout auf dem Server

| Pfad | Inhalt |
|---|---|
| `/var/www/immobilieneichmann.de` | Symlink → `/var/lib/eichmann/releases/current` → `<release-id>/` (nginx bleibt unverändert) |
| `/var/lib/eichmann/app/` | Code, Vorlagen, Assets (vom Deploy), `node_modules` |
| `/var/lib/eichmann/listings.db` | SQLite: `listings` (Immowelt + eigene), `immowelt_snapshots` (jeder gesehene Stand), `listing_history` (jede Änderung, vorher/nachher), `immowelt_runs` (Läufe), `listing_aliases`, `meta` |
| `/var/lib/eichmann/releases/` | `<id>/` komplette Website, `<id>.json` Manifest, `current` Symlink, `state.json` Verlauf; behalten werden das aktuelle, das vorherige und die 6 neuesten; gescheiterte Builds 3 Tage als `<id>.failed` |
| `/var/lib/eichmann/media/` | `eigen/` Uploads eigener Inserate; `immowelt/<aa>/<sha256>-g.jpg` (Galerie), `…-fp.jpg` (Grundriss), `…-g-og.jpg` (Vorschaubild), jeweils auch als `.webp` – der Dateiname entsteht aus dem Bildinhalt; das Verzeichnis ist in jedes Release verlinkt |
| `/var/lib/eichmann/immowelt/snapshots/<fp>/` | Rohantworten der API (Listen, Exposés) und normalisierter Stand, gzip |
| `/var/lib/eichmann/immowelt/originals/<sha256>` | Originalbilder (nicht öffentlich, werden nicht gelöscht) |
| `/var/lib/eichmann/immowelt/db-backups/` | `listings-before-<lauf>.db` vor jeder Veröffentlichung, die letzten 14 |
| `/var/lib/eichmann/immowelt/identity-plan.json` | Plan der einmaligen Zuordnung ([5](#5-rollout), Schritt 8) |
| `/var/lib/eichmann/status/immowelt-sync-status.json` | Status; öffentlich als `/data/immowelt-sync-status.json` |
| `/var/lib/eichmann/secrets/` | `immowelt-api.json` (Schlüssel, 0600), optional `alarm.json`, Admin-Anmeldung; Verzeichnis 0700 |
| `/var/lib/eichmann/sync.env` | Einstellungen ohne Geheimnisse ([6.6](#66-einstellungen)) |
| `/var/lib/eichmann/locks/` | die Sperre |
| `/var/lib/eichmann/snapshots/` | App-Sicherungen alle 12 Stunden, 14 Stände (Datenbank, `media/eigen`, Admin-Einstellungen) |
| `/var/www/immobilieneichmann.de.pre-release-<zeit>` | das bisherige Webroot-Verzeichnis nach der einmaligen Umstellung, bis es von Hand entfernt wird |

Öffentliche Kontrolldateien eines Releases: `/ai/build.json` (`release_id`, `immowelt_fingerprint`, `data_as_of`,
`immowelt_rule_hits`, Commit) und `/ai/immowelt-snapshot.json` (was aus der API veröffentlicht ist, je Angebot mit
Kennungen, Preis, Fakten, Abschnitts-Hashes, Bildliste).

---

## 3. Was übernommen wird – und was nicht

### 3.1 Feld für Feld

| Inhalt | Quelle in der API | Auf der Website |
|---|---|---|
| An / aus | Angebot steht in der vollständigen Liste (`TotalCount` bestätigt) | In der Liste = online. Nicht in der Liste = offline; der Datensatz bleibt als zurückgezogen in der Datenbank. Wieder an = dieselbe URL wie vorher. |
| Nur Homepage | Die Liste (`IncludeIwObj=true`) enthält auch Angebote, die Immowelt nur für die eigene Homepage freigibt („Projekt extern“, auf immowelt.de nicht öffentlich); dieselbe Liste mit `IncludeIwObj=false` nennt genau diese | Vorläufig ausgeblendet (Chris, 11.11.2026): Miete Königsbau und DG-Wohnung standen vor dem API-Umbau nicht auf der Website; bis Helmut bestätigt, dass sie gewollt sind, erscheinen solche Angebote nicht. Freigeben: `IMMOWELT_INCLUDE_HOMEPAGE_ONLY=true` in `sync.env` (oder Vorgabe in `config.mjs`). Ist die zweite Liste nicht lesbar oder widersprüchlich, schlägt der Lauf fehl. |
| Einzelabruf | Angebote, die auf immowelt.de online sind, aber in keiner API-Liste stehen (in Immowelts Daten fehlt die Orts-ID, alle Listen suchen über den Ort): ihre GUID steht in `data/sot/immowelt-extra-guids.json` | Bei jedem Lauf per `GetListByEstateGuids` + Exposé geholt; Inhalte ausschließlich aus der API, in der Datei steht nur die Kennung. Gehört das Angebot nicht zum Eichmann-Profil, ist die Antwort widersprüchlich oder nicht lesbar: Lauf schlägt fehl, letzter Stand bleibt. Bei Immowelt gelöscht (Liste und Exposé melden es beide): offline. Wieder in der normalen Liste: Eintrag wirkungslos. Grenze: Ein NEUES Angebot ohne Orts-ID erscheint nicht von selbst – es muss hier eingetragen werden, bis Immowelt die Orts-ID setzt. |
| Reihenfolge der Angebote | Reihenfolge der Liste (Sortierung `createdatedesc`) | Karten in dieser Reihenfolge, eigene Inserate davor |
| Kennungen | `EstateProperty@id`, `@guid` (32 Hex-Zeichen), `@onlineID`; Liste und Exposé müssen übereinstimmen | intern und in `/ai/immowelt-snapshot.json`; die Objektseite trägt `data-online-id` |
| Kauf / Miete | `Category@saleRentID` (Liste) und `estate@salestype` (Exposé): 1 = Kauf, 2 = Miete. Widerspruch oder unbekannter Wert = Fehler, keine Annahme | Faktzeile „Vermarktung“, Preiszeile, Zähltext („n Angebote (x Kauf, y Miete)“); sobald ein Mietangebot dabei ist, heißt die Überschrift „Aktuelle Angebote“ statt „Aktuelle Kaufangebote“. Mietangebote stehen nicht auf den Kauf-Themenseiten und zeigen keine Käuferprovision |
| Preis | `Price@Complete`; Bezeichnung aus dem Preis-Item des Exposés | Kauf „330.000 €“, Miete „1.200 € Warmmiete“ |
| Preis auf Anfrage | Betrag 0/leer oder Text „auf Anfrage“ | „Preis auf Anfrage“. Ein in der API hinterlegter Betrag erscheint nirgends – nicht auf der Seite, nicht in strukturierten Daten, nicht im AI-Index |
| Überschrift | Item `Description` des Exposés | H1, Karte, Seitentitel – Wortlaut unverändert |
| Wohnfläche, Zimmer, Grundstück | `LivingArea@value`, `Rooms`, `LandArea@value` | Eckdaten und Karte, mit der Genauigkeit der API (z. B. 46,54 m²) |
| Fakten | jedes `<item>` mit kurzem Wert, in Immowelt-Reihenfolge, Bezeichnung = `<title>` des Items; unbekannte Items genauso | Faktentabelle. Ein auf Immowelt geleertes Feld verschwindet, es wird nichts aus früheren Ständen ergänzt |
| Texte | `Info1` (Objektbeschreibung), `Info2` (Sonstiges), `Info3` (Lagebeschreibung), `Ausstattung` mit Untergruppen, jedes weitere Item mit Absätzen oder längerem Text | je ein Abschnitt mit der Überschrift von Immowelt; Absätze, Zeilenumbrüche, Listen, Fett bleiben; erlaubt sind nur `p, br, strong, em, ul, ol, li, a` |
| Bilder | `images/image` in gelieferter Reihenfolge; `source`, `source_thumbnail`, `source_XXL` sind Varianten **eines** Bildes | Galerie in dieser Reihenfolge; erstes Foto = Titel- und Vorschaubild; byte-gleiche Bilder einmal |
| Grundrisse | nur wenn das Bild in der API als Grundriss gekennzeichnet ist | eigener Abschnitt „Grundriss“, unbeschnitten; ohne Kennzeichnung bleibt der Grundriss an seiner Position in der Galerie |
| Lage | `LocationZip`, `LocationCity`, Stadtteil falls geliefert | „Stadtteil, Ort (PLZ)“; die Straße nur mit `IMMOWELT_ADDRESS_MODE=street` |
| Provision | Item mit „Provision“/„Courtage“ in der Bezeichnung | Faktzeile und Zeile unter dem Preis; fehlt das Item bei einem Kaufangebot, steht dort „Käuferprovision: auf Anfrage“ |
| Einstellungen des Inserats | `extensions/*@visible` (z. B. `environmentmap`) | werden erfasst, archiviert und lösen bei Änderung ein neues Release aus; sie haben keine eigene Darstellung, weil die Website keine Karten- oder Zusatzmodule hat |
| Koordinaten | `GeoData` | werden nicht übernommen und nicht veröffentlicht |
| Unbekannte Elemente | alles außerhalb der bekannten Struktur | Hinweis `contract_drift` in der Statusdatei |

### 3.2 Was die API nicht liefert oder nicht eindeutig macht

- **Bildgröße.** Die API liefert höchstens 640 Pixel breite Varianten. Die Galerie der Website arbeitet mit
  800 × 600 (mittiger Ausschnitt, wie bisher) und rechnet aus 640 Pixeln hoch; die bisher gespeicherten Bildadressen
  verweisen auf 1920 Pixel breite Vorlagen. Mit `IMMOWELT_IMAGE_SIZE=1920x0` wird je Bild eine größere Variante angefragt; liefert
  der Bildserver sie nicht, wird ohne Fehler die 640er genommen. Diese Adressvariante ist nicht dokumentiert.
- **Grundriss-Kennzeichnung.** In der am 11.11.2026 beobachteten Struktur trägt `<image>` nur die drei
  Bildadressen. Ohne Kennzeichnung kann ein Grundriss nicht von einem Foto unterschieden werden: Er erscheint
  vollständig und an seiner Position in der Galerie, aber nicht als eigener Abschnitt.
- **Adress-Sichtbarkeit.** Ob Immowelt die Straße öffentlich zeigt, ist in der API nicht als Feld erkennbar.
  Deshalb ist „nur PLZ/Ort“ der Standard.
- **Geltungsbereich.** Die Liste verlangt eine GeoID; ohne sie antwortet die API mit `UnknownLocation`. Gelesen
  wird GeoID 108. Ein Angebot außerhalb dieses Gebiets käme nicht in der Liste vor und gälte als nicht vorhanden.
- **Stadtteil** steht nur da, wenn Immowelt ihn liefert; er wird nicht aus Titel oder Text erraten.
- **Nur aktive Angebote.** Entwürfe, deaktivierte und archivierte Inserate, Statistiken und Anfragen liefert die API nicht.
- **Reserviert/verkauft** ist kein eigenes Feld. Steht es in Überschrift oder Text, erscheint es wörtlich.
- **Exposé-PDF, Videos, Rundgänge, Bildunterschriften** kommen in der beobachteten Struktur nicht vor.
- **Kein Signal bei Änderungen.** Die API wird abgefragt. Eine Änderung ist nach dem nächsten Lauf sichtbar
  (bis 30 Minuten); ein unter gleicher Adresse ausgetauschtes Bild spätestens nach 24 Stunden.

Folgen der 1:1-Übernahme: Überschriften und Tippfehler erscheinen so, wie sie auf Immowelt stehen; die bisherigen
lokalen Titel („Wohnung A5 · 3 Zimmer · Neubau Sunside Living“) entfallen. Treffer der Wording-Regeln in
Immowelt-Texten blockieren nichts mehr, sie werden gezählt (`immowelt_rule_hits` in `/ai/build.json`) und im
Build-Protokoll genannt. Korrigiert wird auf Immowelt.

### 3.3 Was lokal bleibt, weil es nicht aus der API kommen kann

| Inhalt | Wo gepflegt |
|---|---|
| Eigene Inserate | Admin (`origin = eigen`), Bilder unter `media/eigen/` |
| Projektseite Allmannsdorf, Flyer | `data/projects.json`, `data/sot/` |
| Zuordnung von Inseraten zur Seite „Sunside Living“ | `data/sot/listing-groups.json`, über Online-IDs. Die Zuordnung ändert keinen Inseratsinhalt. Eine neue Einheit erscheint sofort in der Angebotsliste, auf der Projektseite erst nach Eintrag ihrer Online-ID. |
| Themen-, Stadtteil-, Ratgeber-, Leistungs- und Rechtsseiten, Formulare | HTML im Repository |
| Englische Objektseiten | werden aus denselben Daten erzeugt (Eckdaten, Preis, Bilder); die Beschreibung verweist auf die deutsche Seite |

### 3.4 URLs

- Der Slug eines Angebots wird beim ersten Erscheinen vergeben (`<objektart>-<stadtteil oder ort>-<online-id>`)
  und danach nie geändert – auch nicht bei neuer Überschrift, neuem Preis oder nach aus/an.
- Ein Alt-Angebot behält seine heutige URL, wenn es einem API-Angebot **belegt** zugeordnet ist ([5](#5-rollout), Schritt 8).
- Zurückgezogene Angebote antworten mit 404. Weiterleitungen werden nicht erzeugt; die nginx-Regeln bleiben unverändert.

---

## 4. API-Schlüssel

**Ausgangslage:** Der Schlüssel liegt als Actions-Secret `IMMOWELT_API_KEY` im Repository. Auf dem Droplet liegt er noch nicht.

**Weg auf den Server:** Workflow **„Immowelt API key → server“** (Actions → Run workflow, Branch `main`,
Eingabe `confirm` = `INSTALL`).

1. Der Runner verbindet sich mit dem Deploy-Schlüssel per SSH.
2. Der Schlüssel wird über **STDIN** an `node scripts/immowelt-secret-install.mjs` gereicht – nicht als Argument,
   nicht als Umgebungsvariable auf dem Server.
3. Das Skript schreibt `/var/lib/eichmann/secrets/immowelt-api.json` (0600, Verzeichnis 0700, erst temporäre Datei,
   dann `rename`) und meldet nur `has_key: true` und das Datum. Es gibt kein Zeichen des Schlüssels aus – auch nicht
   maskiert, auch nicht seine Länge –, denn das Protokoll eines öffentlichen Repositorys ist öffentlich.
4. Ein lesender Probelauf auf dem Server (`immowelt-sync.mjs probe`) beweist, dass die API **vom Droplet aus**
   erreichbar ist und den Schlüssel annimmt. Ausgegeben werden Anzahl, öffentliche Kennungen und Feldnamen.

**Ausweichweg:** Admin → Karte „Immowelt-Zugang“. Das Formular verlangt zusätzlich die Kundennummer und
speichert in dieselbe Datei. Die Kundennummer gehört in keinen Workflow und in kein Protokoll; die API braucht sie nicht.

| Name | Enthält | Wo verwendet |
|---|---|---|
| `IMMOWELT_API_KEY` | den Schlüssel **selbst** | nur in GitHub Actions: Transport im Schlüssel-Workflow, lesende Probe, Bestandsbericht mit `api: true`. Auf dem Server wird diese Variable **nicht** gesetzt. |
| `IMMOWELT_SECRETS_FILE`, `EICHMANN_IMMOWELT_SECRETS_FILE` | einen **Dateipfad** | überschreibt den Ort der Schlüsseldatei (Tests, lokale Läufe). Standard: `/var/lib/eichmann/secrets/immowelt-api.json` |

Die Datei hat die Felder `kundennummer`, `api_key`, `updated_at`. Die API authentifiziert allein mit dem Schlüssel;
die Kundennummer ist nur eine Anzeige im Admin und darf leer sein.

**Wechsel des Schlüssels:** Secret in GitHub ersetzen, Workflow erneut ausführen. Ein abgelehnter Schlüssel zeigt
sich als Zustand `failed` mit `immowelt_access_denied`; die Website bleibt auf dem letzten Stand.

**Nie:** den Schlüssel in einen Chat, ein Issue, eine Workflow-Eingabe (Eingaben sind im Lauf sichtbar), einen
Commit, `sync.env`, ein Terminal mit Befehlsverlauf oder einen Screenshot bringen; nie eine der Pfadvariablen mit
dem Schlüssel belegen.

---

## 5. Rollout

Bis einschließlich Schritt 8 ändert sich **kein Inhalt** der Website. Die Inhalte wechseln in Schritt 9.
Ohne SSH geht alles über Workflows, außer wo „Server“ dabeisteht.

| # | Schritt | Wie | Erwartetes Ergebnis |
|---|---|---|---|
| 0 | Voraussetzungen | Actions-Secrets `EICHMANN_DEPLOY_KEY`, `EICHMANN_DEPLOY_HOST`, `EICHMANN_DEPLOY_USER`, `IMMOWELT_API_KEY` vorhanden, dazu neu `EICHMANN_KNOWN_HOSTS` (Host-Schlüssel des Servers); Variable `IMMOWELT_WATCHDOG_ENABLED` nicht gesetzt | – |
| 1 | Code nach `main` bringen | Patch anwenden, pushen | Der Lauf „Deploy to Droplet“ endet **absichtlich rot in der Vorprüfung** („Einmalige Umstellung steht aus“) – **bevor** er den Server berührt. Server und Website sind unverändert; die neuen Workflows stehen bereit |
| 2 | **Vorher-Aufnahme, kompletter Seitenbestand** | Workflow „Immowelt verify live“: `label` = `before`, `api` = an | Artefakt `immowelt-verify-before-<Run-ID>`; die **Run-ID notieren** (steht in der Zusammenfassung des Laufs) |
| 3 | Infrastruktur sichern | DigitalOcean-Konsole: Snapshot des Droplets. Admin → „Sicherung“ → „Sicherung erstellen“ | beide Sicherungen mit heutigem Datum vorhanden |
| 4 | Server umstellen (Layout) | Workflow „Deploy to Droplet“ → Run workflow, `layout` = `install` | Lauf grün; Protokoll enthält „Release-Layout aktiv: …“; `/ai/build.json` enthält `release_id`; Website zeigt dieselben Angebote wie vorher; beide Timer sind **aus** |
| 5 | Schlüssel installieren | Workflow „Immowelt API key → server“, `confirm` = `INSTALL` | Rechte `700` / `600`; Probe meldet `"ok": true` und die Angebotszahl |
| 6 | Einstellungen festlegen | Server: `/var/lib/eichmann/sync.env` ([6.6](#66-einstellungen)) | nur nötig, wenn vom Standard abgewichen wird (z. B. Bildgröße) |
| 7 | Probe von zweiter Stelle | Workflow „Immowelt API probe (read-only)“ | gleiche Anzahl und Kennungen wie in Schritt 5 |
| 8 | Zuordnung ansehen | Workflow „Immowelt ops (server)“, Aktion `identity-plan` | Tabelle aller Alt-Datensätze mit Entscheidung und Beleg, Liste der neuen Angebote, Warnung zu Angeboten, die offline gehen, **Plan-Hash**. Es wird nichts veröffentlicht |
| 9 | **Freigeben = umstellen** | Aktion `identity-apply`, `plan_hash` = Hash aus Schritt 8 | „Ergebnis: published“; Website zeigt den Immowelt-Bestand (und eigene Inserate, falls vorhanden) |
| 10 | **Nachher-Aufnahme und Sichtprüfung** | Workflow „Immowelt verify live“: `label` = `after`, `api` = an, `before_run_id` = Run-ID aus Schritt 2 | Datenvergleich ohne Abweichungen (Lauf grün); Artefakt mit `verify/review/index.html`: je Seite **Vorher · Nachher · Immowelt** ([9.2](#92-sichtprüfung-vorher--nachher--immowelt)) |
| 11 | Timer einschalten | Aktion `timers-enable` | beide Timer in der Liste; nach dem nächsten Lauf Zustand `current` |
| 12 | Externen Wächter einschalten | Repository → Settings → Secrets and variables → Actions → Variables: `IMMOWELT_WATCHDOG_ENABLED` = `true`; Workflow „Immowelt sync watchdog“ einmal von Hand starten | Lauf grün. Ab jetzt meldet GitHub fehlgeschlagene Wächter-Läufe |
| 13 | Aufräumen | Server, nach einigen Tagen: das Verzeichnis `/var/www/immobilieneichmann.de.pre-release-<zeit>` entfernen | – |

**Zu Schritt 1 und 4.** Solange der Server das alte Layout hat, prüft jeder Deploy zuerst nur lesend, ob das
Webroot schon ein Symlink ist, und bricht sonst ab, ohne etwas zu übertragen. Die Umstellung beginnt erst mit
`layout` = `install` – also bewusst, nach Aufnahme und Sicherung. Dann überträgt der Deploy den Code nach
`/var/lib/eichmann/app`, ergänzt das Datenbankschema (nur neue Spalten und Tabellen), installiert die Dienste und
ruft `deploy/install-release-layout.sh`: App-Sicherung anlegen, Dauerhaftes kopieren, das erste Release **aus der
unveränderten Datenbank** bauen und prüfen, dann tauschen Verzeichnis und Symlink in einem Schritt die Plätze.
Weicht die Zahl der Objektseiten vom bisherigen Webroot ab, bricht das Skript ab, ohne umzuschalten; nach Klärung
auf dem Server bewusst mit `ALLOW_COUNT_CHANGE=1 bash deploy/install-release-layout.sh` wiederholen. Liefert der
Webserver das Release danach nicht aus, nimmt das Skript die Umstellung selbst zurück. Ab dann deployt jeder Push
normal. Die Workflows `sync-immowelt.yml`, `data-age.yml` und `admin-save.yml` gibt es nicht mehr.

**Zwischen Schritt 4 und 9** kann nichts versehentlich veröffentlicht werden: Ohne Schlüssel endet jeder Lauf mit
`awaiting_api_key`, mit Schlüssel und ohne Freigabe mit `migration_required` (Exit 3). In dieser Zeit ist der Status
erwartungsgemäß rot – deshalb werden Timer und Wächter erst danach eingeschaltet.

**Zu Schritt 8 – die einmalige Zuordnung.** Sie entscheidet nur eines: welches Angebot seine **bisherige
Adresse** behält. Die Inhalte kommen in jedem Fall vollständig aus Immowelt. Die alten Datensätze tragen die
Kennung der öffentlichen Immowelt-Seite, die API eine andere. Zugeordnet wird nur über Kennungen, nie über Titel
oder Preis:

| Beleg | Gewicht | Bedeutung |
|---|---|---|
| `guid_equal` | entscheidend | alte Kennung ohne Bindestriche = API-GUID |
| `online_id_manual` | entscheidend | jemand hat nachgesehen und es in `data/sot/immowelt-identity-map.json` eingetragen |
| `media_asset_overlap` | stützend | beide Seiten verweisen auf dieselben hochgeladenen Bilder (mindestens zwei, mindestens die Hälfte des kleineren Bildsatzes, eindeutig in beide Richtungen) – zählt nur, wo kein entscheidender Beleg vorliegt |

Entscheidung `match`: Der Datensatz behält seine URL und bekommt den Inhalt aus der API. `retire`: Der
Alt-Datensatz geht offline; steht das Angebot im Immowelt-Bestand, erscheint es unter „Neu“ mit neuer URL.
Teilen sich mehrere Einheiten eines Projekts dieselben Bilder, belegt die Überschneidung nichts: Der Plan führt
solche Alt-Datensätze als `retire` mit dem Hinweis `media_asset_overlap_ambiguous` und nennt die Kandidaten – das
blockiert nicht. `ambiguous` (Freigabe verweigert) entsteht nur bei **widersprüchlichen** Einträgen, z. B. zwei
Alt-Datensätze für dieselbe Online-ID.

Vor der Freigabe prüfen:

1. **Dreifamilienhaus (1.250.000 €) und 2½-Zimmer-Penthouse (380.000 €, 75 m²)** stehen heute auf der Website,
   aber unter keiner Kennung im API-Bestand. Sie gehen mit der Freigabe offline – Immowelt ist die Quelle. Vorher
   kurz klären: Sind sie auf Immowelt noch aktiv? Wenn ja, liefert die API sie nicht (anderes Gebiet →
   `IMMOWELT_GEO_IDS`, anderes Konto) – dann **nicht** freigeben, sondern erst das klären.
2. **Alte Adressen behalten (optional, für Suchmaschinen und gesetzte Links).** Der Plan auf dem Server zeigt,
   welche Alt-Angebote schon belegt zugeordnet sind. Für die übrigen genügt je ein Eintrag in
   `data/sot/immowelt-identity-map.json`; die Änderung kommt per Deploy auf den Server, danach Schritt 8 wiederholen.
   Vorschlag nach Augenschein (Titel/Preis vom 20.09. gegen den API-Bestand vom 11.11.) – **jede Zeile vor dem
   Eintragen auf Immowelt nachsehen**, das System selbst ordnet so nie zu:

   | Bisherige Adresse (`objekt/…`) | `legacy_id` | vermutlich Online-ID |
   |---|---|---|
   | `penthouse-konigsbau-c6b1d820` (bisher Kauf 199.000 €) | `c6b1d820-4e82-416d-95ad-22472a129955` | `2ql2c52` (jetzt Miete 1.200 €) |
   | `wohnung-wollmatingen-e7e58fe2` (330.000 €) | `e7e58fe2-a93f-44f2-bc73-dabd3c7208b3` | `2k57b5v` |
   | `wohnung-petershausen-86a7d4f6` (735.000 €) | `86a7d4f6-0118-45fa-addc-ef5fe9edf21d` | `2ewd75c` |
   | `maisonette-furstenberg-bb241b38` (A3) | `bb241b38-d292-4047-98fd-4352b841bc5a` | `2geq25e` |
   | `maisonette-furstenberg-ff414db8` (A2) | `ff414db8-7e3d-4a01-99f8-029fe15a4d55` | `2ggn25e` |
   | `maisonette-wollmatingen-484fee8a` (A12) | `484fee8a-e3f0-4f06-8d26-d740c290b320` | `2f42h56` |
   | `maisonette-wollmatingen-4ac199b6` (A9) | `4ac199b6-606e-470b-bb7e-d8646d47ea80` | `2fayg56` |
   | `wohnung-wollmatingen-4fed09f2` (A5) | `4fed09f2-bcef-4e96-ba56-810037b569c0` | `2fsjg56` |
   | `wohnung-wollmatingen-7bff84e7` (B9) | – | `2zbf747` – automatisch (`guid_equal`) |

   ```json
   { "legacy_id": "e7e58fe2-a93f-44f2-bc73-dabd3c7208b3", "online_id": "2k57b5v",
     "verified_by": "…", "verified_at": "JJJJ-MM-TT", "note": "auf Immowelt nachgesehen" }
   ```

   Ohne Einträge funktioniert die Umstellung genauso: Die Angebote erscheinen dann unter neuen Adressen
   (`<objektart>-<ort>-<online-id>.html`), die alten liefern 404.
3. Der Plan-Hash gilt für genau diese Zuordnung. Ändert sich der Bestand so, dass eine andere Zuordnung entsteht,
   wird die Freigabe mit `identity_plan_stale` abgelehnt und Schritt 8 ist zu wiederholen. Text- oder Preisänderungen
   auf Immowelt zwischen Plan und Freigabe machen den Plan nicht ungültig.

---

## 6. Betrieb

### 6.1 Befehle auf dem Server

Alle im Verzeichnis `/var/lib/eichmann/app`.

| Befehl | Wirkung |
|---|---|
| `node scripts/immowelt-sync.mjs run [--trigger manual] [--wait <s>]` | ein vollständiger Lauf. Exit 0 = Website zeigt den aktuellen Stand (oder unverändert, Bestätigung läuft, Sperre belegt, angehalten); 1 = fehlgeschlagen; 3 = Zuordnung muss freigegeben werden |
| `… run --dry-run [--no-media]` | liest und prüft, zeigt die Änderung, schreibt weder Datenbank noch Status noch Website. Mit `--no-media` wird auch kein Bild geladen. Vor der Freigabe der Zuordnung zeigt er den Plan (Exit 3) |
| `… status` | Statusdatei mit Bewertung; Exit 1 bei veraltet oder nicht in Ordnung |
| `… probe` | lesende Vertragsprüfung der API, gibt nur Struktur und öffentliche Kennungen aus |
| `… identity-plan` · `… identity-apply --plan-hash <hash>` | einmalige Zuordnung ansehen · freigeben. `identity-plan` veröffentlicht nie; ist keine Zuordnung mehr offen, startet es keinen Lauf |
| `… hold --reason "…"` · `… resume` | anhalten · fortsetzen ([6.7](#67-anhalten-und-fortsetzen)) |
| `… rollback [--backup <datei>]` | Immowelt-Zeilen auf eine Sicherung zurück ([8](#8-rollback)) |
| `… history [--limit 20]` | letzte Läufe mit Ergebnis, Anzahl, Fehlercode, Release |
| `node scripts/release.mjs list` | Releases; `→` aktuell, `←` vorheriges |
| `node scripts/release.mjs build [--reason manual]` | Release aus der Datenbank bauen, prüfen, umschalten – ohne Immowelt-Abruf |
| `node scripts/release.mjs rollback [<release-id>]` | auf das vorherige oder genannte Release zurück und anhalten |
| `node scripts/release.mjs gc` | alte Releases und nicht mehr verwendete Bildvarianten entfernen |
| `node scripts/watchdog-check.mjs --local` | Wächter auf dem Server (läuft per Timer) |
| `node scripts/watchdog-check.mjs --url https://immobilieneichmann.de [--stale-minutes <n>] [--no-pages]` | Wächter von außen |
| `node scripts/immowelt-secret-install.mjs --status` | ob ein Schlüssel hinterlegt ist (ja/nein, Datum – nichts vom Schlüssel) |
| `bash deploy/install-immowelt-sync.sh --enable` bzw. `--disable` | Dienste installieren, Timer ein oder aus |

Protokolle: `journalctl -u eichmann-immowelt-sync` und `journalctl -u eichmann-sync-watchdog`.
Im Admin startet der Knopf „Immowelt Sync“ denselben Lauf wie der Timer.

### 6.2 Workflow „Immowelt ops (server)“

| Aktion | Entspricht |
|---|---|
| `status` | `immowelt-sync.mjs status`, Timerliste, fehlgeschlagene Dienste |
| `identity-plan` · `identity-apply` (+ `plan_hash`) | wie oben |
| `run` | `run --trigger manual --wait 300` |
| `history` · `releases` | `history --limit 40` · `release.mjs list` |
| `hold` (+ `reason`) | `hold --reason "<Grund>"` |
| `resume` | `resume`, danach sofort ein Lauf |
| `rollback-data` · `rollback-release` | `immowelt-sync.mjs rollback` · `release.mjs rollback` |
| `timers-enable` · `timers-disable` | `install-immowelt-sync.sh --enable` · `--disable` |

Nur auf dem Server möglich: Trockenlauf, Rollback auf eine bestimmte Sicherung oder ein bestimmtes Release,
Ändern von `sync.env` und `alarm.json`.

### 6.3 Statusmodell

Die Statusdatei (`eichmann.immowelt-sync-status/v2`) wird nach **jedem** Lauf ersetzt.

| Zustand | Bedeutung | Exit | Website | Was tun |
|---|---|---|---|---|
| `current` | Bestand vollständig gelesen; die Website zeigt genau das (Ergebnis `published`, `unchanged`, `date_roll` oder – nach einem zurückgenommenen Release – `republished`) | 0 | aktuell | nichts |
| `pending_confirmation` | Leerbestand oder Massenwegfall gesehen; wartet auf die identische zweite Antwort | 0 | letzter Stand | abwarten |
| `failed` | Lauf gescheitert; `error.code` und `error.message` nennen den Grund | 1 | letzter Stand | Grund beheben; der nächste Lauf versucht es von selbst wieder |
| `awaiting_api_key` | kein Schlüssel auf dem Server | 1 | letzter Stand | Schlüssel-Workflow |
| `migration_required` | einmalige Zuordnung nicht freigegeben | 3 | letzter Stand | Plan prüfen und freigeben |
| `held` | angehalten | 0 | eingefroren | Ursache klären, `resume` |
| *veraltet* | `last_success_at` älter als `stale_after_minutes` | – | – | wird nicht geschrieben, sondern von jedem Leser berechnet: Ein Lauf, der nicht stattfindet, kann nichts melden |

Felder: `last_attempt_at`, `last_success_at` (letztes vollständiges Lesen, auch ohne Änderung), `last_change_at`,
`consecutive_failures`, `published` (`release_id`, `fingerprint`, `count`, `public_total`, `detail_total`, `data_as_of`), `pending`,
`last_change`, `warnings`, `error`, `run_id`, `trigger`.

Häufige Fehlercodes: `immowelt_access_denied` (Schlüssel abgelehnt) · `immowelt_timeout`, `immowelt_network`,
`immowelt_http_error`, `immowelt_throttled` (Transport) · `immowelt_list_status` (z. B. `UnknownLocation`),
`immowelt_list_no_totalcount`, `immowelt_list_missing_page`, `immowelt_list_unstable` (Liste unvollständig) ·
`immowelt_truncated`, `immowelt_invalid_xml` · `immowelt_expose_status`, `immowelt_expose_empty`,
`immowelt_identity_mismatch`, `immowelt_owner_mismatch`, `immowelt_unknown_sales_type` (Exposé) ·
`snapshot_count_mismatch`, `listing_price`, `media_count` (Prüfung) · `media_download`, `media_invalid`,
`media_host` (Bilder) · `release_build_failed`, `release_verify_failed`, `release_smoke_failed` (Release) ·
`identity_plan_stale`, `identity_conflict` · `layout_missing`.

Hinweise ohne Fehler (`warnings`): `no_images`, `no_text`, `duplicate_images`, `contract_drift`.

### 6.4 Bestätigung bei Leerbestand und Massenwegfall

Meldet die API vollständig **keine** Angebote, oder fehlen mindestens 3 und zugleich mindestens die Hälfte der
veröffentlichten Angebote, wird nicht sofort veröffentlicht. Der Stand wird gemerkt; kommt frühestens 20 Minuten
später **dieselbe** Antwort noch einmal, wird sie ohne weiteres Zutun veröffentlicht – in der Praxis beim nächsten
Lauf. Eine andere Antwort beginnt die Bestätigung neu. So ist ein leerer Bestand ohne Menschen beweisbar, und eine
einzelne falsche Antwort leert die Seite nicht. Die Schwellen sind einstellbar ([6.6](#66-einstellungen)).

Ein leerer Bestand zeigt „Aktuell sind keine Angebote veröffentlicht“ und weiterhin die eigenen Inserate.
Einzelne Wegfälle unterhalb der Schwelle werden sofort übernommen.

### 6.5 Datum „Stand der Angebote“

Das Datum ist der Tag (Europe/Berlin) des letzten vollständigen, geprüften Lesens. Hat sich nichts geändert, baut
der erste Lauf eines neuen Tages ein Release nur für das Datum (`date_roll`). Scheitert der Abgleich, bleibt das
Datum stehen: Die Seite behauptet nie einen frischeren Stand, als sie hat.

### 6.6 Einstellungen

`/var/lib/eichmann/sync.env`, Format `NAME=wert`, keine Geheimnisse. Die Datei gilt für **alle** Einstiegspunkte –
Timer, Ops-Workflow, Admin-Knopf, Deploy –, weil die Konfiguration sie selbst liest. Eine gesetzte
Umgebungsvariable hat Vorrang.

| Name | Standard | Wirkung |
|---|---|---|
| `IMMOWELT_ADDRESS_MODE` | `locality` | `street` zeigt die Straße so, wie die API sie liefert |
| `IMMOWELT_IMAGE_SIZE` | leer | z. B. `1920x0`: größere Bildvariante anfragen, mit Rückfall je Bild |
| `IMMOWELT_GEO_IDS` | `108` | kommagetrennt; ein Angebot unter mehreren GeoIDs zählt einmal |
| `IMMOWELT_STALE_AFTER_MINUTES` | `120` | ab wann der Stand als veraltet gilt |
| `IMMOWELT_CONFIRM_MIN_MINUTES` · `IMMOWELT_CONFIRM_MIN_REMOVED` | `20` · `3` | Bestätigungsfenster und Schwelle aus 6.4 |
| `IMMOWELT_IMAGE_REVALIDATE_HOURS` | `24` | wie oft ein vorhandenes Bild beim Bildserver gegengeprüft wird |
| `EICHMANN_SMOKE_URL` | `http://127.0.0.1/ai/build.json` | Probe nach dem Umschalten; leer = aus |
| `EICHMANN_KEEP_RELEASES` · `EICHMANN_KEEP_DB_BACKUPS` | `6` · `14` | Aufbewahrung |

Adressmodus, Bildgröße und GeoIDs ändern den veröffentlichten Inhalt: Der nächste Lauf erkennt die Abweichung
und veröffentlicht ein neues Release. Ob die größere Bildvariante geliefert wurde, sagt das Laufprotokoll
(„Bildgröße 1920x0: n Bild(er) in dieser Größe geliefert, m nicht verfügbar“) und je Bild
`/var/lib/eichmann/immowelt/media-index.json` (`source_url`).

### 6.7 Anhalten und Fortsetzen

`hold` heißt: **Es wird nichts automatisch veröffentlicht.** Läufe enden mit Ergebnis `held` und Exit 0 – nichts
wird abgerufen, übernommen oder umgeschaltet, auch keine unterbrochene Umschaltung nachgeholt. Speichern im Admin
legt die Änderung in der Datenbank ab und meldet, dass sie erst nach der Freigabe erscheint. Bewusste Handlungen
veröffentlichen weiterhin: ein Deploy, `release.mjs build`, das Zurückspielen einer App-Sicherung.

Die Statusdatei steht auf `held`, und beide Wächter melden das als Alarm – ein angehaltener Abgleich soll nicht
unbemerkt bleiben. `resume` hebt den Halt auf; der nächste `run` veröffentlicht wieder den aktuellen Immowelt-Stand
(auch wenn die Website inzwischen auf einem älteren Release stand: Ergebnis `republished`).

---

## 7. Alarm

Vier Ebenen, weil keine allein reicht: Der Abgleich kann nicht melden, dass er nicht läuft, und der Server kann
nicht melden, dass er aus ist.

| Ebene | Wo | Wird rot, wenn | Wer es erfährt |
|---|---|---|---|
| 1 Statusdatei | `/data/immowelt-sync-status.json`, Admin | Zustand ist nicht `current` oder `pending_confirmation` | wer nachsieht; Ops-Aktion `status` |
| 2 Dienst | `systemctl --failed` | Lauf endet mit Exit ≠ 0 (`failed`, `awaiting_api_key`, `migration_required`) | sichtbar auf dem Server und in der Ops-Aktion `status` |
| 3 Wächter auf dem Server | Timer alle 15 Minuten (`:02 :17 :32 :47`) | Statusdatei fehlt oder ist unlesbar, letzter Erfolg älter als die Grenze, Zustand nicht in Ordnung (auch `held`) | der Dienst schlägt fehl; konfigurierte Senken werden benachrichtigt |
| 4 Wächter von außen | Workflow „Immowelt sync watchdog“, `:11` und `:41` | wie Ebene 3, **und**: Status nicht abrufbar; die Website liefert ein anderes Release, einen anderen Fingerabdruck, eine andere Angebotszahl oder einen anderen Datenstand, als der Abgleich meldet; eine Objektseite antwortet nicht mit 200 | GitHub meldet den fehlgeschlagenen Lauf |

- **Grenze für „veraltet“:** 120 Minuten, also vier ausgefallene Läufe; einstellbar mit
  `IMMOWELT_STALE_AFTER_MINUTES`, für den äußeren Wächter zusätzlich mit `--stale-minutes`.
- **Einschalten:** Ebene 1 und 2 bestehen immer. Ebene 3 läuft mit den Timern. Ebene 4 läuft erst, wenn die
  Repository-Variable `IMMOWELT_WATCHDOG_ENABLED` auf `true` steht; ohne sie wird der geplante Lauf übersprungen.
  Das Einspielen des Codes verschickt also nichts.
- **Benachrichtigung:** Es werden **jetzt keine Mails oder Chat-Nachrichten gesendet.** Ebene 4 nutzt
  ausschließlich die Benachrichtigung von GitHub über fehlgeschlagene Workflows, sobald die Variable gesetzt ist.
  Bei geplanten Workflows geht sie an die Person, die den Zeitplan zuletzt geändert hat, und nur, wenn deren
  Einstellungen Benachrichtigungen für Actions zulassen.
  GitHub kann geplante Läufe verzögern; ein Schritt im Workflow verhindert, dass der Zeitplan nach 60 Tagen ohne
  Aktivität im Repository pausiert wird.
- **Sofortiger Alarm, optional:** `/var/lib/eichmann/secrets/alarm.json` (nur auf dem Server, 0600). Fehlt die Datei
  oder steht `enabled` nicht auf `true`, wird nichts gesendet.

  ```json
  { "enabled": true, "healthcheck_url": "https://hc-ping.com/<uuid>", "webhook_url": "https://example.org/hook" }
  ```

  `healthcheck_url` wird nach jedem guten Lauf aufgerufen und mit `/fail` nach jedem schlechten; ein Dienst dieser
  Art schlägt auch dann an, wenn die Aufrufe ausbleiben. `webhook_url` erhält bei jedem Zustandswechsel und bei
  jedem Fehler ein kurzes JSON (Zustand, Zeitpunkte, Fehler, veröffentlichter Stand). Eine nicht erreichbare Senke
  lässt den Abgleich nie scheitern.

---

## 8. Rollback

| Lage | Mittel | Befehl | Wirkung | Wieder freigeben |
|---|---|---|---|---|
| (a) Das neueste Release ist fehlerhaft dargestellt | Release zurück | `node scripts/release.mjs rollback` (Ops: `rollback-release`) | Website zeigt sofort das vorherige Release; es wird angehalten; die Datenbank bleibt unverändert | Ursache beheben – ein Deploy baut ein neues Release –, dann `resume` |
| (b) Der übernommene Immowelt-Stand soll zurück | Daten zurück | `node scripts/immowelt-sync.mjs rollback` (Ops: `rollback-data`) | nur die Immowelt-Zeilen und ihre Merker gehen auf die Sicherung vor der letzten Veröffentlichung zurück, ein Release wird gebaut, es wird angehalten; eigene Inserate bleiben unberührt | auf Immowelt korrigieren, dann `resume` |
| (c) Die Layout-Umstellung soll zurück, bevor Inhalte umgestellt wurden | Verzeichnis zurück | Server: Timer aus, dann `rm /var/www/immobilieneichmann.de && mv /var/www/immobilieneichmann.de.pre-release-<zeit> /var/www/immobilieneichmann.de` | Webroot ist wieder das alte Verzeichnis | Danach bricht jeder Deploy in der Vorprüfung ab, bis erneut mit `layout` = `install` umgestellt oder der Merge-Commit zurückgenommen wird. Ohne Layout verweigert der Abgleich die Arbeit (`layout_missing`) |
| (d) Mehr als Immowelt ist betroffen | App-Sicherung | Admin → „Sicherung“ → zurückspielen (Bestätigung `RESTAURIEREN`), oder Server: `node scripts/snapshot-cli.mjs restore <id> --confirm=RESTAURIEREN` | Datenbank komplett (auch eigene Inserate), `media/eigen`, Admin-Einstellungen; danach wird ein Release gebaut | der nächste Lauf holt den aktuellen Immowelt-Stand. Stammt die Sicherung von vor der Umstellung, steht wieder `migration_required` an |
| (e) Der Server selbst ist beschädigt | DigitalOcean-Snapshot | DigitalOcean-Konsole | der ganze Droplet auf den Zeitpunkt des Snapshots; alles danach ist verloren | letztes Mittel |

Wichtig zu (a) und (b): Ein Rollback ist ein Zustand für die Dauer einer Störung, kein Dauerzustand. Die Quelle
bleibt Immowelt; nach `resume` übernimmt der nächste Lauf wieder hart, was dort steht.

Für (b) auf einen bestimmten Stand: `--backup /var/lib/eichmann/immowelt/db-backups/listings-before-<lauf>.db`.
Für (a) auf ein bestimmtes Release: die Kennung aus `release.mjs list`.

Nach der inhaltlichen Umstellung (Schritt 9) führt der Weg zurück zum alten System über (d) mit einer Sicherung
von vor Schritt 9, das Zurücknehmen des Merge-Commits und (c).

---

## 9. Prüfplan

### 9.1 Automatische Tests

`node --test test/*.test.mjs` bzw. Workflow „Immowelt pipeline tests“ (bei jedem Pull Request und bei
Code-Änderungen auf `main`). Kein Netzwerkzugriff: Die API und der Bildserver sind durch Fixtures ersetzt, deren **Struktur** den Antworten vom
11.11.2026 entspricht; Texte, Bildadressen und Straße sind erfunden.

| Fall | Test |
|---|---|
| GeoID wird gesendet, Reihenfolge wie im WSDL | „Envelope: GeoID wird gesendet, Reihenfolge wie im WSDL, Schlüssel escaped“ |
| 32-stellige GUID statt 36 Zeichen | „Liste (echte Struktur): 32-stellige GUID ohne Bindestriche wird akzeptiert“ |
| `UnknownLocation`, fehlender `TotalCount` | „Liste: UnknownLocation, fehlender TotalCount und ungültige Kennung sind Fehler, kein leerer Bestand“ |
| Exposé: Überschrift, Fakten, Abschnitte; 16 Bilder sind 16, nicht 48 | „Exposé (echte Struktur): item@id → Titel/Fakten/Abschnitte, Bildvarianten zählen einmal“ |
| Adressmodus, fremdes Angebot | „Exposé: Adressmodus street übernimmt die Straße, falscher Eigentümer und fremde GUID schlagen fehl“ |
| Mehrere Seiten, fehlende Seite, Duplikat, Zählfehler | vier Tests „Paging: …“ |
| Gültiger Leerbestand | „Leerer Bestand ist gültig, wenn die API ihn vollständig meldet“; „Leerer Bestand ist gültig – nach Bestätigung zeigt die Seite nur noch eigene Inserate“ |
| Zeitüberschreitung, 5xx, abgelehnter Schlüssel | „Transport: Timeout/5xx werden wiederholt, Zugriff verweigert nicht; Schlüssel nie in Fehlermeldungen“ |
| Die zehn Angebote: Kennungen, Kauf/Miete, auf Anfrage | „Snapshot der zehn Angebote: Kennungen, Kauf/Miete/auf Anfrage, Bildanzahl, Reihenfolge“ |
| Preis auf Anfrage verrät keinen Betrag | „Preis auf Anfrage: hinterlegter Betrag der API wird nie veröffentlicht“ |
| Kurze oder leere Texte, keine Bilder sind gültig | „Gate: Miete, kurze/leere Texte, keine Bilder und Leerbestand sind gültig; Zählfehler nicht“ |
| Jede Art von Änderung wird erkannt | „Änderungserkennung: Text, Kauf→Miete, Bildtausch, Bildreihenfolge, Angebotsreihenfolge“ |
| Kennungswechsel, keine Zuordnung über Titel/Preis | „Identität: Website-UUID ≠ API-GUID; Zuordnung nur über Kennungen, nie über Titel/Preis“ |
| Einheiten eines Projekts teilen Bilder; widersprüchliche Einträge | „Identität: Kennungs-Beleg schlägt Bildüberschneidung; geteilte Projektbilder belegen nichts und blockieren nicht“ |
| Vor der Freigabe wird nichts veröffentlicht; falscher Plan | „Vor der Identitätsmigration wird nichts veröffentlicht (Exit 3, Status rot)“; „Ein Plan, der nicht zum Bestand passt, wird abgelehnt“ |
| Umstellung | „Cutover: freigegebener Plan → alle zehn API-Angebote live, Alt-Angebote ohne Beleg offline“ |
| Inhalte 1:1, keine lokalen Overrides | „Inhalte 1:1: Miete, Preis auf Anfrage, Grundrisse, Reihenfolge, keine lokalen Overrides“ |
| Eigene Inserate | „Eigene Inserate bleiben unberührt und sichtbar“ |
| Kein Lauf ohne Statuseintrag; Datum | „Wiederholung ohne Änderung: kein neues Release, Status wird trotzdem fortgeschrieben“; „Tageswechsel: Datenstand rückt vor, auch wenn sich nichts geändert hat“ |
| Änderungen auf Immowelt | „Änderungen auf Immowelt: gekürzt, geleert, Kauf→Miete, Bild getauscht/entfernt/umsortiert, Angebote umsortiert“ |
| Aus und wieder an, stabile URL | „Angebot aus → Seite weg; Angebot wieder an → gleiche URL“ |
| Fehler → letzter guter Stand, Status rot | „Exposé eines Angebots nicht lieferbar → nichts wird veröffentlicht“; „Liste unvollständig (Seite fehlt) → …“; „Neues Bild nicht abrufbar → keine Teilpublikation“; „API lehnt den Schlüssel ab → …“; „Kaputtes XML (abgeschnittene Antwort) → Fehler statt weniger Angebote“ |
| Erholung nach Fehlern | „Nach den Fehlläufen: nächster guter Lauf ist wieder 'current'“ |
| Massenwegfall | „Großer Wegfall wird erst nach identischer zweiter Antwort mit Abstand veröffentlicht“ |
| Gleichzeitige Läufe | „Parallelität: zweiter Lauf während einer Veröffentlichung endet als 'busy' ohne Wirkung“; „Sperre: exklusiv, vererbbar an Kindprozesse, wird freigegeben“ |
| Absturz mitten im Umschalten | „Abbruch zwischen Datenbank und Umschalten: nächster Lauf holt das Umschalten nach“ |
| Fehlerhaftes Release | „Build-Fehler im Release: Datenbank und Website bleiben unverändert“ |
| Deploy und Admin | „Deploy/Admin: Release aus der Datenbank neu bauen ändert keine Immowelt-Daten“ |
| Daten-Rollback | „Rollback: Immowelt-Zeilen aus der Sicherung, neues Release, Abgleich angehalten bis 'resume'“ |
| Release-Rollback, Anhalten | „Release-Rollback: Seite zurück und angehalten; Admin-Speichern wartet, Deploy veröffentlicht, 'resume' holt den aktuellen Stand“ |
| Einstellungen gelten überall, kein Schlüssel aus der Einstellungsdatei | „Einstellungen: sync.env gilt für jeden Einstiegspunkt, Umgebung hat Vorrang, kein Schlüssel aus der Datei“ |
| Kompletter Seitenbestand, Sichtprüfungsseite | „Seitenbestand: Sitemap ∪ alle intern verlinkten Seiten – deutsch, englisch, Angebots- und Rechtsseiten“; „Sichtprüfung: je Seite drei Bilder – Vorher (dt-1) · Nachher (dt) · Immowelt (dt)“; „API-Referenz: zeigt, was Immowelt liefert – Art, Preis, Fakten, Texte, Bilder in Reihenfolge“ |
| Schlüssel | „Schlüssel steht in keinem Log, Status, Archiv oder Release“ |
| Aufbewahrung, Statusbewertung | „Aufbewahrung: alte Releases werden begrenzt, Historie und Rohdaten bleiben“; „Status-Bewertung: veraltet, fehlgeschlagen, altes Format“ |
| Parser | „XML: abgeschnittene oder kaputte Dokumente schlagen fehl statt repariert zu werden“; „HTML: nur erlaubtes Markup, Wortlaut unverändert“ |

### 9.2 Sichtprüfung: Vorher · Nachher · Immowelt

Aufgenommen wird der **komplette Seitenbestand**, nicht eine Auswahl: jede Adresse der Sitemap und jede intern
verlinkte Seite – Startseite, Übersichten, Themen-, Stadtteil-, Ratgeber- und Rechtsseiten, deutsch und englisch,
und jede Objektseite (im Repository-Stand 56 Seiten). Immer dieselben zwei Ansichten, immer die ganze Seite:
**Desktop 1440 × 900** und **Mobil 390 × 844** (doppelte Pixeldichte). Animationen und Cookie-Hinweis sind
ausgeblendet, Bilder werden vollständig geladen; sehr lange Seiten werden in aufeinanderfolgenden Teilen gespeichert.
Zu jedem Satz gehört `manifest.json` mit Zeitpunkt, Release-Kennung und Prüfsumme jeder Aufnahme.

| Aufnahme | Wann | Womit | Inhalt |
|---|---|---|---|
| **Vorher (dt‑1)** | **vor** dem Sync – Rollout-Schritt 2, bevor irgendetwas am Server geändert wird | Workflow „Immowelt verify live“, `label` = `before` | kompletter Seitenbestand der Live-Website |
| **Nachher (dt)** | nach der Veröffentlichung – Schritt 10 | derselbe Workflow, `label` = `after`, `before_run_id` = Run-ID der Vorher-Aufnahme | kompletter Seitenbestand, jetzt aus Immowelt |
| **Immowelt (dt)** – API-Referenz | im selben Lauf wie „Nachher“, mit `api` = an | automatisch | jedes Angebot so, wie die Immowelt-API es in diesem Moment liefert: Art, Preis, Fakten, alle Texte, alle Bilder in Reihenfolge – neutrale Darstellung, nicht das Website-Layout |
| **Immowelt (dt)** – öffentliche Seite | direkt nach „Nachher“, auf dem eigenen Rechner | `node scripts/verify/capture-screens.mjs --label immowelt --headed` | `https://www.immowelt.de/expose/<online-id>` für jedes Angebot |

Der Workflow baut daraus die **Sichtprüfungsseite** `verify/review/index.html` (im Artefakt
`immowelt-verify-after-<Run-ID>`, 90 Tage): je Seite drei Bilder nebeneinander –

```
Vorher (dt‑1)        Nachher (dt)        Immowelt (dt)
```

zuerst die Immowelt-Angebote in Immowelt-Reihenfolge (mit Online-ID, Kauf/Miete, Preis, Fläche, Bildzahlen und dem
Ergebnis des Datenvergleichs), dann entfallene Seiten, dann alle übrigen Seiten (dort ist die dritte Spalte leer:
kein Immowelt-Gegenstück). Umschalter für Desktop/Mobil, „nur Angebote“, „Unverändertes ausblenden“. Markierungen:
pixelgleich · HTML gleich · geändert · neu · entfällt. Gepaart wird über die Adresse: Ein Angebot, dessen Adresse
gewechselt hat, erscheint als „entfällt“ und „neu“ – genau das ist mit der URL geschehen.

**Die öffentlichen Immowelt-Seiten** lassen sich nicht aus GitHub Actions oder vom Server aufnehmen: Immowelt
beantwortet Rechenzentrums-Adressen mit 403, und es wird nichts umgangen. Deshalb zeigt die dritte Spalte zunächst
die API-Referenz. Für die echten Seiten auf dem eigenen Rechner (nicht auf dem Heimserver):

```bash
npm ci && npx playwright install chromium
# Artefakt des after-Laufs nach test-results/ entpacken (enthält before, after, immowelt-api), dann:
node scripts/verify/capture-screens.mjs --label immowelt --headed
node scripts/verify/build-review.mjs          # → test-results/verify/review/index.html
```

`--headed` öffnet ein normales Browserfenster und wartet: Cookie-Hinweis oder Sicherheitsabfrage beantwortest du
selbst, das Skript nicht. Eine Seite, die verweigert wird, steht in der Sichtprüfung als „nicht aufgenommen“; dann
bleibt dort die API-Referenz. Alles lässt sich auch komplett lokal fahren (`--label before`, später `--label after`).

Worauf achten:

| Seite | Vorher | Nachher | Worauf achten |
|---|---|---|---|
| `/` | Stand 20.09. | Immowelt-Bestand | Zähltext („… Angebote (… Kauf, … Miete) in und um Konstanz“), Reihenfolge, Preiszeilen, Datum „Stand“ |
| `/projekte.html` | wie oben | wie oben | Zähler, Überschrift „Aktuelle Angebote“ |
| Königsbau | `objekt/penthouse-konigsbau-c6b1d820.html`: Kauf 199.000 € | Angebot `2ql2c52`: Miete 1.200 € (neue URL, wenn nicht zugeordnet) | Vermarktungsart, Preiszeile ohne Käuferprovision, ganze Textabschnitte, Galerie |
| B9 | `objekt/wohnung-wollmatingen-7bff84e7.html`: 695.000 €, 92,66 m² | **dieselbe URL**, Angebot `2zbf747`: Preis auf Anfrage, 93,22 m² | kein Betrag sichtbar, Fläche, Abschnitte, Galerie |
| Neue DG-Wohnung | nicht vorhanden | Angebot `2gwzk5x` | Seite vollständig: Überschrift, Fakten, alle Abschnitte, Galerie |
| Dreifamilienhaus, 2½-Zimmer-Penthouse | vorhanden | „entfällt“ | so gewollt, weil nicht im Immowelt-Bestand ([5](#5-rollout), Schritt 8) |
| alle übrigen Seiten | | | sollten „pixelgleich“ oder „HTML gleich“ sein, außer wo sie Angebote, Zähler oder das Datum zeigen |

Eine Aufnahme zeigt das Erscheinungsbild. Anzahl und Reihenfolge **aller** Galeriebilder und den vollständigen
Wortlaut belegt zusätzlich der Datenvergleich (9.3), der die Seiten ausliest; die API-Referenz zeigt alle Bilder
nummeriert in Immowelt-Reihenfolge.

### 9.3 Vergleichstabelle der Angebote

`scripts/verify/inventory-report.mjs` vergleicht je Angebot drei Stände: **A** frisch aus der API (nur mit `--api`,
lesend), **B** was das Release als veröffentlicht angibt (`/ai/immowelt-snapshot.json`), **C** was die Objektseite
tatsächlich zeigt. Verglichen werden Position, Objekt-ID, GUID, Kauf/Miete, Preis und „auf Anfrage“, Überschrift,
Zimmer, Fläche, jede Faktzeile, jeder Textabschnitt (Prüfsumme des Markups), Bilder und Grundrisse nach Anzahl
**und** Reihenfolge, die Preiszeile der Seite. Zusätzlich gemeldet: in der API, aber nicht veröffentlicht;
veröffentlicht, aber nicht mehr in der API; Immowelt-Angebote auf der Website ohne API-Kennung.

Spalten: `#`, Online-ID, Objekt-ID, GUID, Art, Preis, m², Zi., Fotos (API/Seite), Grundrisse, Textabschnitte mit
Zeichenzahl, Fakten, online, gleich. Jede Abweichung steht einzeln darunter; der Exit-Code ist dann 1 –
„ungefähr gleich“ gibt es nicht.

Soll-Werte aus dem API-Test vom 11.11.2026. Die Spalte „heute“ dient nur der Orientierung beim Ansehen; das
System ordnet nie über Preis oder Fläche zu. Bild- und Grundrisszahlen, Abschnittslängen und Faktzeilen trägt
der Bericht ein.

| # | Online-ID | Art | Preis | Fläche | Zi. | Heute auf der Website (Stand 20.09.2026) |
|---|---|---|---|---|---|---|
| 1 | `2ql2c52` | Miete | 1.200 € | 26 m² | 1 | Königsbau, als Kauf für 199.000 € |
| 2 | `2k57b5v` | Kauf | 330.000 € | 67 m² | 3 | 3-Zimmer-Wohnung Wollmatingen, 330.000 € |
| 3 | `2gwzk5x` | Kauf | 826.925 € | 106,7 m² | 3 | – (neu) |
| 4 | `2geq25e` (A3) | Kauf | 361.500 € | 46,54 m² | 2 | A3, 361.500 €, 46,5 m² |
| 5 | `2ggn25e` (A2) | Kauf | 363.700 € | 47,04 m² | 2 | A2, 363.700 €, 47 m² |
| 6 | `2f42h56` (A12) | Kauf | 738.100 € | 102,34 m² | 4 | A12, 738.100 €, 102,3 m² |
| 7 | `2fayg56` (A9) | Kauf | 696.200 € | 95,49 m² | 4 | A9, 696.200 €, 95,5 m² |
| 8 | `2fsjg56` (A5) | Kauf | 641.200 € | 89,54 m² | 3 | A5, 641.200 €, 89,5 m² |
| 9 | `2ewd75c` | Kauf | 735.000 € | 95,7 m² | 4 | Petershausen, 735.000 €, 95,7 m² |
| 10 | `2zbf747` (B9) | Kauf | auf Anfrage | 93,22 m² | 4 | B9, 695.000 €, 92,66 m² |
| – | nicht im Bestand | | | | | Dreifamilienhaus, 1.250.000 € |
| – | nicht im Bestand | | | | | 2½-Zimmer-Penthouse, 380.000 €, 75 m² |

### 9.4 Abnahme

1. Workflow „Immowelt verify live“ mit `after` und `api` = an ist grün: **keine** Abweichung zwischen API,
   veröffentlichtem Stand und Seiten.
2. Angebotszahl im Bericht = `TotalCount` der Probe.
3. `/ai/build.json` nennt dasselbe Release wie die Statusdatei; Zustand `current`.
4. Sichtprüfungsseite durchgesehen (Vorher · Nachher · Immowelt): Jede Änderung ist eine, die Immowelt so zeigt.
5. Eigene Inserate vorher wie nachher vorhanden.
6. Nach dem ersten Timer-Lauf: `last_success_at` rückt vor, Wächter grün.
7. Gegenprobe: Eine Änderung auf Immowelt – von Helmut ohnehin vorgenommen, nicht eigens für den Test – ist nach
   spätestens einem Lauf auf der Website; an Immowelt-Inhalten wird für die Abnahme nichts verändert.

### 9.5 Was bisher nicht real geprüft ist

- Die Tests liefen in einer Sandbox gegen Fixtures in der Struktur der echten Antworten – nicht gegen den Server
  und nicht gegen die echte API. Der erste echte Lauf ist die Probe in Schritt 5.
- Die Bildverarbeitung mit `sharp` und die Aufnahmen mit Playwright laufen erst in CI und auf dem Server; in der
  Sandbox waren beide nicht installiert.
- `deploy/install-release-layout.sh`, die systemd-Dienste und die Workflows mit SSH sind durchgesehen, aber noch
  nie ausgeführt worden.
- Ob der Bildserver größere Varianten liefert, ob echte Grundrisse gekennzeichnet sind und ob die Bild-Kennungen
  der alten Datensätze zu denen der API passen (Beleg `media_asset_overlap`), zeigt erst der echte Bestand.
- Ob Immowelt seine öffentlichen Seiten einem von Playwright gesteuerten Browser auf dem eigenen Rechner zeigt, ist
  offen. Wenn nicht, bleibt in der Sichtprüfung die API-Referenz; eigene Bildschirmfotos lassen sich einfach als
  `test-results/verify/screens/immowelt/desktop/<online-id>.png` (bzw. `mobile/…`) ablegen und erscheinen dann in
  der dritten Spalte.

---

## 10. Offene Entscheidungen und bekannte Grenzen

**Zu entscheiden**

1. **Dreifamilienhaus und 2½-Zimmer-Penthouse:** auf Immowelt noch aktiv? Davon hängt ab, ob Schritt 9
   freigegeben werden darf ([5](#5-rollout), Schritt 8).
2. **Alte URLs erhalten (optional):** je Alt-Angebot ein nachgesehener Eintrag, sonst neue Adresse – Vorschlag in
   [5](#5-rollout), Schritt 8.
3. **Adresse:** nur PLZ/Ort (Standard) oder Straße.
4. **Bildgröße:** `IMMOWELT_IMAGE_SIZE` vor der Umstellung im Trockenlauf prüfen; ohne größere Variante können
   die Galerien sichtbar weicher wirken als heute.
5. **Wording-Regeln:** Treffer in Immowelt-Texten werden nur gemeldet. Soll ein Treffer verschwinden, muss der
   Text auf Immowelt geändert werden.
6. **Sunside-Zuordnung:** neue Einheiten in `data/sot/listing-groups.json` nachtragen.
7. **Alarmweg:** GitHub-Benachrichtigung allein oder zusätzlich eine Senke.
8. **Gebiet:** bleibt es bei GeoID 108?

**Bekannte Grenzen**

- **Server-Echtheit bei SSH:** Vor Schritt 5 das Secret `EICHMANN_KNOWN_HOSTS` anlegen (Ausgabe von
  `ssh-keyscan <host>`, einmal mit dem Schlüssel auf dem Server verglichen). Ohne es vertrauen die Workflows dem
  Server beim ersten Kontakt und warnen.
- **Eigene Inserate und Wording-Regeln:** Ein eigenes Inserat mit einem nicht zulässigen Begriff lässt den Build
  scheitern – auch für Immowelt-Änderungen, bis der Text korrigiert ist (Status rot, letzter Stand bleibt).
- **Benachrichtigung des äußeren Wächters:** nach dem Einschalten einmal prüfen, dass die GitHub-Mail wirklich
  ankommt (z. B. kurz `hold`), sonst zusätzlich `alarm.json` einrichten.
- Während eines Deploys kann ein gleichzeitig startender Lauf an halb übertragenen Dateien scheitern; er meldet
  das als Fehler und der nächste Lauf holt es nach.

- Sichtbar wird eine Änderung beim nächsten Lauf, nicht sofort; bei Massenwegfall einen Lauf später.
- Bilder stammen aus höchstens 640 Pixel breiten Vorlagen, solange keine größere Variante geliefert wird;
  Galeriebilder sind mittig auf 800 × 600 zugeschnitten.
- Grundrisse ohne Kennzeichnung der API stehen in der Galerie, nicht in einem eigenen Abschnitt.
- Zurückgezogene Angebote liefern 404; es entstehen keine Weiterleitungen.
- Bilder zurückgezogener Angebote sind nirgends mehr verlinkt und stehen nicht mehr im Release (`assets/listings/…`).
  Die Immowelt-Bilddateien unter `media/immowelt/` bleiben über ihre nicht erratbare Adresse abrufbar, solange ein
  aufbewahrtes Release sie noch verwendet (Standard: die letzten 6 Releases, also wenige Tage), danach werden sie
  gelöscht. Die Originale liegen nur im nicht öffentlichen Archiv.
- **Eigene Inserate** sind kein Teil des Abgleichs. Gibt es keine, zeigt die Website ausschließlich Immowelt.
- Der feste Navigationstext „Aktuelle Kaufangebote“ bleibt, auch wenn ein Mietangebot dabei ist; Überschrift und
  Zähltext passen sich an.
- Englische Objektseiten enthalten keine übersetzten Beschreibungstexte.
- Fehlt bei einem Kaufangebot die Provisionsangabe, steht „Käuferprovision: auf Anfrage“.
- Einstellungen des Inserats (`extensions`) werden gespeichert, aber nicht dargestellt.
- Der äußere Wächter hängt an der Pünktlichkeit von GitHub; die Wächter auf dem Server hängen am Server.
  Erst beide zusammen decken alle Ausfälle ab.
