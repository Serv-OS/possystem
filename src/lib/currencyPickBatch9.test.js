// src/lib/currencyPickBatch9.test.js: a new site's currency is picked, never a GBP guess (batch 9, Peter 4 Nov 2026).
//
// Add location (admin portal and Back Office) starts on a blank "Pick a currency" box and refuses the
// save with "Pick the currency for this site." until one is picked, like the time zone since 5.12.57.
// Location settings starts blank until the row loads; a row with no currency stays blank and its save
// is refused with the same words. Once the currency is picked the time zone default follows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultTimezoneFor } from './timezones.js';

const root = new URL('../../', import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

const REFUSAL = 'Pick the currency for this site.';
const ADD = ['src/admin/CompanyAdminApp.jsx', 'src/backoffice/sections/CompanyAdmin.jsx'];
const SETTINGS = 'src/backoffice/sections/LocationSettings.jsx';
const THREE = [...ADD, SETTINGS];

test('no GBP default is left for the site currency in the three screens', () => {
  for (const f of THREE) {
    const src = code(read(f));
    assert.doesNotMatch(src, /locCurrency\s*\|\|\s*'GBP'/, `${f}: the form never falls back to GBP`);
    assert.doesNotMatch(src, /currency\s*\|\|\s*'GBP'/, `${f}: no site currency falls back to GBP`);
    assert.doesNotMatch(src, /useState\('GBP'\)/, `${f}: no state starts on GBP`);
  }
});

test('every screen refuses the save until the currency is picked, with the same words', () => {
  for (const f of THREE) assert.ok(read(f).includes(REFUSAL), `${f} says "${REFUSAL}"`);
  for (const f of ADD) {
    const src = read(f);
    const create = src.slice(src.indexOf('const createLocation = async'));
    const cur = create.indexOf(REFUSAL);
    const tz = create.indexOf('Pick the time zone. US sites span several zones.');
    assert.ok(cur > 0, `${f}: the currency refusal sits in createLocation`);
    assert.ok(tz > cur, `${f}: the time zone refusal is kept, after the currency one`);
    assert.match(create, /currency: form\.locCurrency,/, `${f}: the row gets the picked currency as is`);
  }
  const ls = read(SETTINGS);
  const save = ls.slice(ls.indexOf('const save = async'), ls.indexOf('setSaving(true)'));
  assert.match(save, /if \(!currency\) \{\s*setError\('Pick the currency for this site\.'\);\s*return;/);
});

test('the currency box starts blank with "Pick a currency" first', () => {
  for (const f of ADD) {
    const src = read(f);
    assert.match(src, /value=\{form\.locCurrency\s*\|\|\s*''\}/, `${f}: nothing preselected`);
    assert.match(src, /\{!form\.locCurrency && <option value="">Pick a currency<\/option>\}/, `${f}: blank option first`);
  }
  const ls = read(SETTINGS);
  assert.match(ls, /const \[currency, setCurrency\]\s*=\s*useState\(''\)/, 'blank until the row loads');
  assert.match(ls, /setCurrency\(row\.currency \|\| ''\)/, 'a row with no currency shows blank');
  assert.match(ls, /\{!currency && <option value="">Pick a currency<\/option>\}/);
});

test('the time zone default still follows the picked currency, and waits for one', () => {
  assert.equal(defaultTimezoneFor('USD'), '', 'US sites span several zones');
  assert.equal(defaultTimezoneFor('GBP'), 'Europe/London');
  assert.equal(defaultTimezoneFor('EUR'), 'Europe/Dublin');
  for (const f of ADD) {
    const src = read(f);
    assert.match(src, /const locTzDefault = form\.locCurrency \? defaultTimezoneFor\(form\.locCurrency\) : '';/, `${f}: no time zone until a currency is picked`);
    assert.doesNotMatch(code(src), /defaultTimezoneFor\(form\.locCurrency\)(?! : '')/, `${f}: every use goes through locTzDefault`);
  }
});

test('no long dashes in the new words', () => {
  const long = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
  assert.doesNotMatch(read('src/lib/currencyPickBatch9.test.js'), long);
  for (const f of THREE) {
    const lines = read(f).split('\n').filter((l) => l.includes(REFUSAL) || l.includes('Pick a currency') || l.includes('locTzDefault') || l.includes('batch 9') || l.includes('Batch 9'));
    assert.ok(lines.length > 0, `${f} has the new lines`);
    for (const l of lines) assert.doesNotMatch(l, long, `${f}: ${l.trim()}`);
  }
});
