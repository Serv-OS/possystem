/**
 * hqSlice4Wiring.test.js: the Scorecard's dayparts fall back to today's forecast, and Safe and
 * banking and Targets read money in the picked site's own currency.
 * Run: `node --test src/backoffice/sections/headoffice/hqSlice4Wiring.test.js`.
 * Reads the source files as text (no React).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('data layer: fetchSiteDays answers today, service periods, forecast hours and currency per site, softly', () => {
  const data = read('src/lib/hq/data.js');
  assert.match(data, /export async function fetchSiteDays\(locationIds\)/);
  assert.match(data, /const clocks = await fetchVenueClocks\(ids\);/);
  assert.match(data, /out\[id\] = \{ today: clocks\[id\]\?\.today \|\| null, shifts: Array\.isArray\(cfg\?\.shifts\) \? cfg\.shifts : \[\], hours: \[\], currency: cfg\?\.currency \|\| null \};/);
  assert.match(data, /from\('stock_forecast_hours'\)\.select\('location_id, business_day, hour, amount'\)\.in\('location_id', ids\)\.in\('business_day', days\)/);
  assert.match(data, /The dayparts show the whole day\./, 'a failed hours read is words, not a blank tile');
});

test('Scorecard: today\'s logged day wins, else the forecast parts, else the last logged day', () => {
  const sc = read('src/backoffice/sections/headoffice/HqScorecard.jsx');
  assert.match(sc, /import \{ forecastParts, WHOLE_DAY_KEY \} from '\.\.\/\.\.\/\.\.\/lib\/hq\/systemDay\.js';/);
  assert.match(sc, /fetchSiteDays\(ids\),\n\s+\]\)\.then\(\(\[snap, daily, ratings, projects, targets, cash, ops, siteDays\]\)/);
  assert.match(sc, /const loggedToday = !!\(row\.typedOn && sd\?\.today && row\.typedOn === sd\.today && row\.parts\.length\);/);
  assert.match(sc, /const fp = forecastParts\(snapVenue\?\.today\?\.forecast, sd\?\.hours, sd\?\.shifts\);/);
  assert.match(sc, /if \(fp\.length\) \{ row\.parts = fp; row\.partsFrom = 'forecast'; row\.partsOn = sd\?\.today \|\| null; \}/);
  assert.match(sc, /export function partsWords\(r\)/);
  assert.match(sc, /Forecast, whole day: no hours saved against it, or no service periods/);
  assert.match(sc, /No forecast for today and no projection logged/);
  assert.match(sc, /siteDays: state\.siteDays, currencyOf: hq\.currencyOf/);
});

test('Head office context: each site\'s own currency, and Safe and Targets read it', () => {
  const ho = read('src/backoffice/sections/HeadOffice.jsx');
  assert.match(ho, /export function buildHqCtx\(orgCtx, locations, siteCurrencies = \{\}\)/);
  assert.match(ho, /currencyOf: \(id\) => \(siteCurrencies && siteCurrencies\[id\]\) \|\| currency,/);
  assert.match(ho, /fetchSiteDays\(siteIds\.split\(','\)\)/);
  const safe = read('src/backoffice/sections/headoffice/HqSafe.jsx');
  assert.match(safe, /const currency = \(typeof hq\.currencyOf === 'function' && hq\.currencyOf\(siteId\)\) \|\| hq\.currency;/);
  const targets = read('src/backoffice/sections/headoffice/HqTargets.jsx');
  assert.match(targets, /const currency = \(siteId && typeof hq\.currencyOf === 'function' && hq\.currencyOf\(siteId\)\) \|\| hq\.currency;/);
  assert.match(targets, /read as that number in each site's own currency/);
});

test('no long dashes in the slice 4 words', () => {
  const dash = new RegExp('[\\u2013\\u2014]');
  for (const f of ['src/backoffice/sections/headoffice/hqSlice4Wiring.test.js', 'src/backoffice/sections/HeadOffice.jsx']) assert.ok(!dash.test(read(f)), f);
  const sd = read('src/lib/hq/systemDay.js');
  const a = sd.indexOf('export function forecastParts'); const b = sd.indexOf('const LEGACY');
  assert.ok(a > 0 && b > a && !dash.test(sd.slice(a, b)));
  const data = read('src/lib/hq/data.js');
  const c = data.indexOf('export async function fetchSiteDays'); const d = data.indexOf("/** The business date of an instant");
  assert.ok(c > 0 && d > c && !dash.test(data.slice(c, d)));
});
