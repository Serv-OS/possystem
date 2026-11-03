// src/lib/regionFollowsVenue.test.js (5.12.57, Peter on Mozz Woodbine, 3 Nov 2026): a US site showed
// pounds, +44 phones, a National Insurance box and the built in sample positions. These pin the fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('the currency is set only by the venue being worked on, on a cache hit too, and on every switch', () => {
  const lt = read('src/lib/locationTime.js');
  const calls = lt.split('\n').filter((l) => /setActiveCurrency\(/.test(l) && !/^\s*(\/\/|\*)/.test(l) && !/^import/.test(l));
  assert.equal(calls.length, 2, 'only adoptCurrency and adoptVenueRegion set it');
  assert.match(lt, /return adoptCurrency\(_locationConfigCache\.get\(locationId\), locationId, explicitLocationId\);/, 'a cache hit sets it too');
  assert.match(lt, /return adoptCurrency\(cfg, locationId, explicitLocationId\);/);
  assert.match(lt, /if \(!active \|\| typeof active === 'object'\) return true;/, 'a kiosk or link page with no saved venue works as before');
  assert.match(lt, /addEventListener\('rpos-location-changed'/, 'a Back Office location switch sets the new venue');
});

test('Workforce draws only after the site region is set, and offers only the site positions', () => {
  const wf = read('src/backoffice/sections/Workforce.jsx');
  assert.match(wf, /adoptVenueRegion\(locationId\)/);
  assert.match(wf, /\{\(!locationId \|\| regionFor === locationId\) && <>/);
  assert.match(wf, /const rolesMap = roles\.map \|\| \{\};/, 'no fallback to the built in sample positions');
  assert.doesNotMatch(wf, /roles\.map : ROLES/);
  assert.match(wf, /const valid = f\.name\.trim\(\)\.length > 1 && !!f\.role && !!roles\[f\.role\];/, 'a real position is needed');
  assert.match(wf, /No positions yet\. Add one in Workforce, Positions first\./);
  assert.match(wf, /Their position was removed: pick one/);
  assert.doesNotMatch(wf, /\|\| 'server'/, 'never a made up server position');
});

test('guard: no pound sign typed into Workforce or staff app words (money comes from the venue)', () => {
  const dirs = ['src/backoffice/sections/workforce', 'src/staff'];
  const files = ['src/backoffice/sections/Workforce.jsx'];
  for (const d of dirs) for (const f of readdirSync(new URL(`../../${d}/`, import.meta.url))) {
    const p = `${d}/${f}`;
    if (statSync(new URL(`../../${p}`, import.meta.url)).isFile() && /\.(jsx?|tsx?)$/.test(f) && !/\.test\./.test(f) && f !== 'seed.js') files.push(p);
  }
  const bad = [];
  for (const p of files) read(p).split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (/^\s*\*/.test(line)) return;
    if (/['"`>][^'"`<]*£/.test(code)) bad.push(`${p}:${i + 1}`);
  });
  assert.deepEqual(bad, [], 'use the venue money (venueMoney, pack.currencySymbol), never a typed pound sign');
});
