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
| `generate_lead` | Nur nach bestätigtem Erfolg (gleiche Stelle wie `form_submit_success`) | + `form_id`, `form_type` (`contact` \| `expose`), `ab_variant` |
| `click_phone` | Klick auf jeden `tel:`-Link | + `location` (`sticky` \| `nav` \| `hero` \| `flyer` \| `footer` \| `content`), `phone_target`, `ab_variant` |
| `click_whatsapp` | Klick auf jeden `wa.me`-Link | + `location` (schwebender WhatsApp-Knopf = `sticky`) |

Zusätzlich: `flyer_open`. `click_call` wurde am 2026-10-09 durch `click_phone` ersetzt.

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
   - `generate_lead` (Haupt-Conversion, GA4-Standard-Lead-Event)
   - `click_phone`, `click_whatsapp`
   - `form_submit_success` (gleichwertig zu `generate_lead`, nicht beide doppelt zählen)
   - optional `vormerken_submit` (Allmannsdorf)
   - optional `form_start` / `form_abandon` für Funnel-Analysen (kein Muss als Key Event)
5. Funnel-Exploration: **Explore** → **Funnel exploration** mit Schritten  
   `form_view` → `form_start` → `form_submit_attempt` → `form_submit_success`  
   Breakdown-Dimension: `traffic_source` oder `utm_source` / `project`

## Datenschutz

- Events nur nach Opt-in (Analytics-Consent)
- Keine Partial-Leads / keine Speicherung abgebrochener Formulare an Helmut
- Forms POST unverändert an `forms.digitalisierungsplanung.de`

## Update 2026-10-10 (claude-plan-v1)
- Hero-A/B-Test `hero_cta_r1` beendet: kein `ab_assign`/`cta_click`, kein `ab_variant` mehr. Statischer Hero ist die einzige Version.
- Lead-KPI = `generate_lead` (genau 1× pro bestätigter Übermittlung). `vormerken_submit`/`form_submit_success` bleiben Hilfs-Signale, nicht als Conversion zählen.
- `click_phone` hat `device_hint` (mobile/desktop, Viewport ≤768px) → in GA4 nur `device_hint=mobile` als Anruf-Signal werten.
- Sticky-Leiste nur mobil (Anrufen + WhatsApp, `location=sticky`); Desktop: keine Leiste.
