import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
// 31.10.2026: Flyer-Pop-up dauerhaft entfernt (Chris) – nichts darf es wieder öffnen.
test('main.js has no flyer modal logic (no auto-open, no opener)', () => {
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.ok(!/flyerModal|data-open-flyer|eichmann_flyer_closed|openFlyer|flyer-open/.test(main));
});
test('no page contains the flyer container or an opener; partials gone', () => {
  const pages = ['', 'objekt', 'en', 'en/property'].flatMap((d) => readdirSync(new URL(`../${d}`, import.meta.url)).filter((f) => f.endsWith('.html')).map((f) => (d ? d + '/' : '') + f));
  for (const f of pages) {
    const h = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(!/id="flyerModal"|data-open-flyer|href="#flyerModal"|partials\/flyer-modal/.test(h), f);
  }
  assert.ok(!existsSync(new URL('../partials/flyer-modal.html', import.meta.url)));
  assert.ok(!existsSync(new URL('../partials/flyer-modal-en.html', import.meta.url)));
});
test('former flyer links lead to the inline Vormerk forms', () => {
  const r = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  assert.match(r('index.html'), /href="allmannsdorf\.html#vormerken"/);
  assert.match(r('allmannsdorf.html'), /id="vormerken"[\s\S]*id="vormerk-projekt"/);
  assert.match(r('allmannsdorf.html'), /<a class="btn btn-accent" href="#vormerken">Jetzt vormerken<\/a>/);
  assert.match(r('en/allmannsdorf.html'), /<a href="#register" aria-label=/);
  assert.match(r('kontakt.html'), /href="kontakt\.html\?interesse=allmannsdorf#contact-form">Neubau vormerken<\/a>/);
});
