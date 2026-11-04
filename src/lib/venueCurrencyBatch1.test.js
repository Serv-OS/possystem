// src/lib/venueCurrencyBatch1.test.js (5.12.57, US basics batch 1): the Manager app, forecasts, Workforce
// settings, gift cards, catering and the AI assistant take the venue's own currency, never a GBP default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { giftCode, giftChargeCurrency, companyGiftCurrency } from '../../supabase/functions/_shared/giftCurrency.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('gift cards: charged in the selling venue currency, else the config, else gbp', () => {
  assert.equal(giftChargeCurrency({ venueCurrency: 'USD', configCurrency: 'gbp' }), 'usd', 'the venue wins over the GBP column default');
  assert.equal(giftChargeCurrency({ venueCurrency: 'GBP', configCurrency: 'gbp' }), 'gbp', 'a UK venue as before');
  assert.equal(giftChargeCurrency({ venueCurrency: null, configCurrency: 'eur' }), 'eur');
  assert.equal(giftChargeCurrency({}), 'gbp');
  assert.equal(giftCode(' Usd '), 'usd');
  assert.equal(giftCode('pounds'), null);
});

test('gift cards: a company starts in the one currency its venues use', () => {
  assert.equal(companyGiftCurrency(['USD', 'usd', 'USD']), 'usd');
  assert.equal(companyGiftCurrency(['GBP']), 'gbp');
  assert.equal(companyGiftCurrency(['GBP', 'USD']), null, 'mixed: the column default stands, each sale charges its own venue');
  assert.equal(companyGiftCurrency([]), null);
});

test('wiring: no GBP default where the venue currency is known', () => {
  const ms = read('supabase/functions/manager-snapshot/index.ts');
  assert.match(ms, /select\('timezone, name, is_demo, currency'\)/);
  assert.match(ms, /const currency = String\(locRow\?\.currency \|\| vs\?\.currency \|\| 'GBP'\)\.toUpperCase\(\);/);
  const tr = read('supabase/functions/trading-report/index.ts');
  assert.match(tr, /const currency = String\(curRow\?\.currency \|\| vs\?\.currency \|\| 'GBP'\)\.toUpperCase\(\);/);
  const wf = read('src/staff/wfData.js');
  assert.match(wf, /currency: getActiveCurrencyCode\(\), labour_target_pct:/, 'Workforce settings save the venue currency');
  assert.doesNotMatch(wf, /currency: 'GBP'|patch\.currency \|\| 'GBP'|r\.currency \|\| 'GBP'/);
  const gc = read('supabase/functions/gift-checkout-session/index.ts');
  assert.doesNotMatch(gc, /config\.currency \|\| 'gbp'/);
  assert.match(gc, /currency: chargeCurrency,/);
  assert.match(read('supabase/functions/gift-config/index.ts'), /companyGiftCurrency\(/);
  const gcards = read('src/backoffice/sections/GiftCards.jsx');
  assert.doesNotMatch(gcards, /<option value="gbp">/, 'no currency picker that starts on GBP');
  assert.match(read('src/surfaces/catering/CateringSurface.jsx'), /const cur = String\(location\.currency \|\| cfg\?\.currency \|\| 'gbp'\)\.toLowerCase\(\);/);
  const cs = read('src/backoffice/sections/CateringSettings.jsx');
  assert.doesNotMatch(cs, /currency: 'gbp'|r\.currency \|\| 'gbp'|<option value="gbp">/);
  assert.doesNotMatch(read('supabase/functions/catering-release/index.ts'), /currency: 'GBP'/);
});

test('AI assistant: the venue currency travels with every call and replaces the pound sign in the prompts', () => {
  assert.match(read('src/lib/aiRequest.js'), /buildAiRequest\(\{ currency: getActiveCurrencyCode\(\), \.\.\.\(body \|\| \{\}\) \}/);
  const ai = read('api/ai.js');
  assert.match(ai, /\.split\('\\u00A3'\)\.join\(sym\)/);
  assert.doesNotMatch(ai, /description: '[^']*GBP/);
  assert.doesNotMatch(read('src/lib/aiTools.js'), /'£0\.00'/);
});
