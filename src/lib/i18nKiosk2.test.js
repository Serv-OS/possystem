// New kiosk design text (lib/i18n.js k2.* keys): English filled in, other languages fall
// back to English, no dashes as punctuation, and every key the screens use exists.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, tf, tn, englishKeys, LANGUAGES } from './i18n.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('every k2 key has non empty English text', () => {
  const keys = englishKeys('k2.');
  assert.ok(keys.length > 0);
  for (const k of keys) {
    const v = t(k, 'en');
    assert.equal(typeof v, 'string', k);
    assert.ok(v.trim().length > 0, k);
    assert.notEqual(v, k, k);
  }
});

test('other languages fall back to the English text', () => {
  for (const k of englishKeys('k2.')) {
    for (const L of LANGUAGES) assert.equal(t(k, L.code), t(k, 'en'), `${k} in ${L.code}`);
  }
});

test('no k2 text uses a dash as punctuation', () => {
  for (const k of englishKeys('k2.')) {
    const v = t(k, 'en');
    assert.ok(!/[—–]/.test(v), `${k} has an em or en dash: ${v}`);
    assert.ok(!/\s-\s/.test(v), `${k} has a spaced hyphen: ${v}`);
  }
});

test('tf fills values and keeps unknown markers visible', () => {
  assert.equal(tf('k2.menu.table', { table: 'B5' }), 'Table B5');
  assert.equal(tf('k2.attract.wait', { n: 12 }), 'About 12 min wait');
  assert.equal(tf('k2.menu.table', {}), 'Table {table}');
  assert.equal(tf('k2.menu.table'), 'Table {table}');
  assert.equal(tf('k2.menu.table', { table: 0 }), 'Table 0');
  assert.equal(tf('no.such.key', { a: 1 }), 'no.such.key');
});

test('tn picks one or other and fills n', () => {
  assert.equal(tn('k2.items', 1), '1 item');
  assert.equal(tn('k2.items', 0), '0 items');
  assert.equal(tn('k2.items', 3), '3 items');
  assert.equal(tn('k2.itemsInOrder', 1), '1 item in your order');
  assert.equal(tn('k2.itemsInOrder', 4), '4 items in your order');
});

function listFiles(dir, test) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, test));
    else if (test(entry.name)) out.push(full);
  }
  return out;
}

test('every k2 key named in the kiosk screens and kiosk rules exists', () => {
  const files = [
    ...listFiles(path.join(here, '../surfaces/kiosk'), n => n.endsWith('.jsx')),
    ...listFiles(here, n => /^kiosk.*\.js$/.test(n) && !n.endsWith('.test.js')),
  ];
  assert.ok(files.length > 0);
  const english = new Set(englishKeys('k2.'));
  const missing = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/['"`](k2\.[A-Za-z0-9_.]+)['"`]/g)) {
      const key = m[1];
      if (key.endsWith('.')) continue;   // a prefix, not a key
      const ok = english.has(key) || (english.has(`${key}.one`) && english.has(`${key}.other`));
      if (!ok) missing.push(`${path.relative(here, f)}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});
