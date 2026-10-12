import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
const code = main.slice(main.indexOf('  /* Flyer modal */'), main.indexOf('  /* Prefill bei'));
function visit(storage, pathname = '/', blocked = false) {
  const listeners = {}, modalListeners = {};
  const dialog = { hasAttribute: () => true, focus() {} };
  const modal = { hidden: true, querySelector: () => dialog, addEventListener: (k, v) => { modalListeners[k] = v; } };
  const document = {
    readyState: 'complete', activeElement: null,
    body: { style: {}, classList: { add() {}, remove() {} } },
    getElementById: id => id === 'flyerModal' ? modal : null,
    querySelectorAll: () => [{ addEventListener: (k, v) => { listeners.manual = v; } }],
    addEventListener: (k, v) => { listeners[k] = v; }
  };
  vm.runInNewContext(code, { document, window: {}, location: { pathname }, Promise,
    localStorage: { getItem(k) { if (blocked) throw Error(); return storage[k]; }, setItem(k, v) { if (blocked) throw Error(); storage[k] = v; } }
  });
  return { modal, close: () => listeners.keydown({ key: 'Escape' }), manual: () => listeners.manual({ preventDefault() {} }) };
}
test('first visit opens; close persists across visits; manual reopen works', async () => {
  const storage = {};
  const first = visit(storage); await Promise.resolve();
  assert.equal(first.modal.hidden, false);
  assert.equal(storage.eichmann_flyer_closed_v1, undefined);
  first.close(); assert.equal(storage.eichmann_flyer_closed_v1, '1');
  const second = visit(storage); await Promise.resolve();
  assert.equal(second.modal.hidden, true);
  second.manual(); assert.equal(second.modal.hidden, false);
});
test('English homepage auto-opens; inner pages do not; blocked storage does not crash', async () => {
  const en = visit({}, '/en/'), inner = visit({}, '/kontakt.html'), blocked = visit({}, '/', true);
  await Promise.resolve();
  assert.equal(en.modal.hidden, false); assert.equal(inner.modal.hidden, true);
  assert.equal(blocked.modal.hidden, false); assert.doesNotThrow(() => blocked.close());
});
