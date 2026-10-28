// v5.11.108: pins that the kiosk USES the keyboard helper (lib/kioskKeyboard.js) on every box a
// customer types in, that the item sheet lifts above the keyboard, and the viewport meta is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('the item sheet sits on top of the keyboard and the notes box comes into view', () => {
  const src = read('../surfaces/kiosk/KioskItemSheet.jsx');
  assert.match(src, /import \{ useKioskKeyboardLift, kioskRevealOnFocus \} from '\.\.\/\.\.\/lib\/kioskKeyboard\.js';/);
  assert.match(src, /const keyboardLift = useKioskKeyboardLift\(shellRef\);/);
  assert.match(src, /<div ref=\{shellRef\}[^>]*style=\{\{ position: 'absolute', inset: 0, bottom: keyboardLift,/);
  const note = src.slice(src.indexOf('id="k2-item-note"'), src.indexOf('/>', src.indexOf('id="k2-item-note"')));
  assert.match(note, /onFocus=\{kioskRevealOnFocus\}/);
  // The footer (quantity and Add) stays outside the scroller, so it rides up with the sheet.
  assert.ok(src.indexOf('{/* Footer */}') > src.indexOf('id="k2-item-note"'));
});

test('every box a customer types in on the kiosk brings itself into view', () => {
  const app = read('../surfaces/KioskApp.jsx');
  assert.match(app, /import \{ kioskRevealOnFocus \} from '\.\.\/lib\/kioskKeyboard\.js';/);
  const inputs = [...app.matchAll(/<input\b[\s\S]*?\/>/g)].map((m) => m[0]);
  assert.equal(inputs.length, 7);
  for (const i of inputs) assert.match(i, /onFocus=\{kioskRevealOnFocus\}/, i.slice(0, 120));
  const code = read('../surfaces/kiosk/KioskCodeCard.jsx');
  assert.match(code, /onFocus=\{kioskRevealOnFocus\}/);
});

test('the kiosk asks Android to shrink the page for the keyboard', () => {
  const surface = read('../surfaces/KioskSurface.jsx');
  assert.match(surface, /useEffect\(\(\) => \{ ensureKioskViewportMeta\(\); \}, \[\]\);/);
  const helper = read('./kioskKeyboard.js');
  // Review fix: the canvas bottom comes from the unzoomed parent and style.zoom, never the canvas's own rect.
  assert.match(helper, /parentTop: canvas\.parentElement\.getBoundingClientRect\(\)\.top,/);
  assert.match(helper, /zoom: parseFloat\(canvas\.style\.zoom\) \|\| 1,/);
  assert.doesNotMatch(helper, /canvas\.getBoundingClientRect\(\)/);
  assert.match(helper, /vv\?\.addEventListener\('resize', measure\);/);
  assert.match(helper, /vv\?\.addEventListener\('scroll', measure\);/);
  assert.match(helper, /vv\?\.removeEventListener\('resize', measure\);/);
  assert.match(helper, /vv\?\.removeEventListener\('scroll', measure\);/);
});
