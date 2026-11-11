# Immowelt-Fixtures

`list-real-shape.xml` und `expose-real-shape.inner.xml` bilden die **Struktur** der echten API-Antworten vom
11.11.2026 nach (Elementnamen, Attribute, Kennungen `id` / 32-stellige `guid` / `onlineID`, `item@id` mit
`<title>`/`<description>`, drei Bildvarianten je `<image>`, `extensions`, `GeoData`).
Die **Texte, Bild-Adressen und die Straße sind erfunden** – echte Inseratsinhalte gehören nicht ins öffentliche Repo.

`test-support/immowelt/builder.mjs` erzeugt daraus beliebige Varianten (mehrere Seiten, fehlende Seite, Duplikate, Exposé-Fehler,
Kauf→Miete, Preis auf Anfrage, geänderte/umsortierte Bilder, leerer Bestand) und einen Ersatz für `fetch`.
