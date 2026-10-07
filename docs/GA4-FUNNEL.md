# GA4 Kontakt-Funnel (immobilieneichmann.de)

Messung nur nach Analytics-Consent (`cookie-consent.js` → `analytics.js`).
Keine Kontaktdaten (Name, E-Mail, Telefon, Nachricht) in Events — nur Feldnamen, Kategorien und Attribution.

## Events

| Event | Wann | Wichtige Parameter |
|---|---|---|
| `form_view` | Kontakt-/Exposé-Formular sichtbar | `form`, `anliegen`, `project`, `page_path`, `landing`, `referrer`, `traffic_source`, UTMs |
| `form_start` | Erste Interaktion mit einem Feld | wie oben |
| `form_field_interact` | Erstes Fokus/Change je Feld | + `field` (nur Name), `field_is_pii` |
| `form_submit_attempt` | Absenden geklickt | + `outcome` = `send` \| `validation_failed` |
| `form_submit_success` | Forms-API `success: true` | |
| `form_submit_error` | Validierung / Server / Netzwerk | + `error_type`, ggf. `http_status` |
| `form_abandon` | `pagehide` nach Start ohne Success | |
| `vormerken_submit` | Submit mit Anliegen Allmannsdorf (Alias) | `project=allmannsdorf` |

Zusätzlich unverändert: `click_call`, `click_whatsapp`, `flyer_open`.

### Parameter (kein PII)

- `form`: `contact` \| `expose`
- `anliegen`: Kategorie-Slug (`vormerkung_allmannsdorf`, `verkauf`, …)
- `project`: `allmannsdorf` \| `expose` \| `none`
- `page_path`, `landing`, `referrer` aus First-Touch `sessionStorage` (`eichmann_attr_v1`)
- `traffic_source`: abgeleitet (`google_organic`, `direct`, `utm_*`, `chatgpt`, `mcp`, `referral_<host>`, …)
- `utm_source` / `utm_medium` / `utm_campaign` / `utm_content` / `utm_term` wenn vorhanden

## Key Events in der GA4-UI markieren

1. [GA4](https://analytics.google.com/) → Property **Immobilien Eichmann** (`G-QVRRBPYNVM`)
2. **Admin** → **Data display** → **Events** (bzw. *Ereignisse*)
3. Nach Deploy 24–48 h warten, bis die Custom-Events erscheinen
4. Als **Key event** (früher Conversion) markieren:
   - `form_submit_success` (Haupt-Conversion)
   - optional `vormerken_submit` (Allmannsdorf)
   - optional `form_start` / `form_abandon` für Funnel-Analysen (kein Muss als Key Event)
5. Funnel-Exploration: **Explore** → **Funnel exploration** mit Schritten  
   `form_view` → `form_start` → `form_submit_attempt` → `form_submit_success`  
   Breakdown-Dimension: `traffic_source` oder `utm_source` / `project`

## Datenschutz

- Events nur nach Opt-in (Analytics-Consent)
- Keine Partial-Leads / keine Speicherung abgebrochener Formulare an Helmut
- Forms POST unverändert an `forms.digitalisierungsplanung.de`
