/**
 * Smoke: analytics funnel source contains required events and never sends PII field values.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const analytics = fs.readFileSync(path.join(root, 'js/analytics.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'js/main.js'), 'utf8');

const requiredEvents = [
  'form_view',
  'form_start',
  'form_field_interact',
  'form_submit_attempt',
  'form_submit_success',
  'form_submit_error',
  'form_abandon',
  'vormerken_submit',
  'generate_lead',
  'click_phone',
  'click_whatsapp'
];

const missing = requiredEvents.filter((name) => {
  const inAnalytics = analytics.includes(`'${name}'`) || analytics.includes(`"${name}"`);
  const inMain = main.includes(`"${name}"`) || main.includes(`'${name}'`);
  return !(inAnalytics || inMain);
});
if (missing.length) {
  console.error('Missing funnel events:', missing.join(', '));
  process.exit(1);
}

if (!analytics.includes('eichmann_attr_v1')) {
  console.error('analytics.js must read eichmann_attr_v1 attribution');
  process.exit(1);
}
if (!analytics.includes('window.eichmannTrack')) {
  console.error('analytics.js must expose window.eichmannTrack');
  process.exit(1);
}
if (!main.includes('eichmannTrack')) {
  console.error('main.js must call eichmannTrack via trackForm');
  process.exit(1);
}

// Ensure we never gtag field values from PII inputs
const forbidden = [
  /gtag\([^)]*email[^)]*value/i,
  /trackEvent\([^)]*valueOf\(form,\s*"email"/i,
  /trackForm\([^)]*payload\.email/i,
  /trackEvent\([^)]*\.value\)/
];
for (const re of forbidden) {
  if (re.test(analytics) || re.test(main)) {
    console.error('Possible PII value leak matching', re);
    process.exit(1);
  }
}

if (!analytics.includes('field_is_pii') || !analytics.includes("field: name")) {
  console.error('form_field_interact must send field name only');
  process.exit(1);
}

console.log('GA4 funnel smoke OK:', requiredEvents.join(', '));
