// New kiosk design text (lib/i18n.js k2.* keys): English filled in, every other language
// fully translated with the same {markers}, no dashes as punctuation, and every key the
// screens use exists.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, tf, tn, englishKeys, languageKeys, LANGUAGES } from './i18n.js';
import { KIOSK_LANGUAGE_PICKER, KIOSK_START_LANGUAGE } from './kioskFlow.js';

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

// v5.8.81: the language pill is on, so every language must have every line. A key that fell
// back to English would give a customer a half translated screen.
const OTHER_LANGUAGES = LANGUAGES.map(L => L.code).filter(c => c !== 'en');
const markers = (s) => (String(s).match(/\{[A-Za-z0-9]+\}/g) || []).sort();
const ownKeys = (lang) => languageKeys(lang);
const ownText = (lang, k) => (languageKeys(lang, k).includes(k) ? t(k, lang) : undefined);

test('the language pill is on and all five languages are offered', () => {
  assert.equal(KIOSK_LANGUAGE_PICKER, true);
  assert.equal(KIOSK_START_LANGUAGE, 'en');
  assert.deepEqual(OTHER_LANGUAGES, ['es', 'fr', 'de', 'it', 'pt']);
});

test('every k2 key is translated in every language, with the same {markers}', () => {
  const problems = [];
  for (const lang of OTHER_LANGUAGES) {
    for (const k of englishKeys('k2.')) {
      const own = ownText(lang, k);
      if (typeof own !== 'string' || !own.trim()) { problems.push(`${lang} ${k}: missing`); continue; }
      if (markers(own).join() !== markers(t(k, 'en')).join()) problems.push(`${lang} ${k}: markers ${markers(own)} vs ${markers(t(k, 'en'))}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('no language has a k2 key that English does not', () => {
  const english = new Set(englishKeys('k2.'));
  for (const lang of OTHER_LANGUAGES) {
    const extra = ownKeys(lang).filter(k => k.startsWith('k2.') && !english.has(k));
    assert.deepEqual(extra, [], lang);
  }
});

test('all caps labels stay all caps in every language', () => {
  for (const k of englishKeys('k2.')) {
    const en = t(k, 'en');
    if (!/[A-Z]/.test(en) || en !== en.toUpperCase()) continue;
    for (const lang of OTHER_LANGUAGES) {
      const v = t(k, lang);
      assert.equal(v, v.toUpperCase(), `${lang} ${k}: ${v}`);
    }
  }
});

test('translated lines fill values and plurals', () => {
  assert.equal(tf('k2.menu.table', { table: '12' }, 'es'), 'Mesa 12');
  assert.equal(tn('k2.items', 1, {}, 'it'), '1 articolo');
  assert.equal(tn('k2.items', 3, {}, 'it'), '3 articoli');
  assert.equal(tn('k2.items', 3, {}, 'pt'), '3 artigos');
  for (const lang of OTHER_LANGUAGES) {
    assert.ok(!tf('k2.card.reference', { ref: 'AB12' }, lang).includes('{'), lang);
    assert.notEqual(t('k2.attract.tap', lang), t('k2.attract.tap', 'en'), lang);
  }
});

test('no k2 text uses a dash as punctuation, in any language', () => {
  for (const L of LANGUAGES) {
    for (const k of englishKeys('k2.')) {
      const v = t(k, L.code);
      assert.ok(!/[—–]/.test(v), `${L.code} ${k} has an em or en dash: ${v}`);
      assert.ok(!/\s-\s/.test(v), `${L.code} ${k} has a spaced hyphen: ${v}`);
    }
  }
});

test('each new customer starts in English (KioskV2Root resets on every new session)', () => {
  const src = fs.readFileSync(path.join(here, '../surfaces/kiosk/KioskV2Root.jsx'), 'utf8');
  assert.match(src, /setLang\(KIOSK_START_LANGUAGE\)/);
  assert.match(src, /\}, \[sessionKey\]\);/);
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
