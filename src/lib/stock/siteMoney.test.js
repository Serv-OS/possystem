// src/lib/stock/siteMoney.test.js
//
// 5.12.57 (batch 1, money and currency): a US site (Mozz Pizza, USD) picked in the stock site picker
// while signed in at a UK site read in pounds, because only the ACTIVE venue sets the Back Office
// currency now. Three proofs:
//  1. the helper (siteMoney.js) gives the site's own currency: the signed in venue is the active
//     currency exactly as before, another site is its scope currency, else its config, else active;
//  2. the word rules handed a USD symbol say "$", and with no symbol say the active venue's (a UK
//     venue reads exactly as before, pence too);
//  3. THE GUARD: no file in the stock, purchasing and produce area carries a typed pound sign inside
//     a string, a template or JSX text. Comments may name the pound; a regex that READS a symbol
//     ([£$€]), a symbol table (GBP: '£') and costWords' pence rule (sym === '£') are allowed.
// Run: node --test src/lib/stock/siteMoney.test.js (npm test runs it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteCurrencyCode, siteCurrencyOf, siteSymbol, scopeCurrency, knownCode, moneyIn } from './siteMoney.js';
import { moneyWords, basketRules } from './purchasingRules.js';
import { budgetWords, splitCheck, needsApprovalPill, HEADERS_MULTI_OF } from './purchasingWords.js';
import { secondApprovalWords } from './countPlanRules.js';
import { costWords } from './recipeRules.js';
import { moneyText, spendText, siteValueText } from './supplierListRules.js';
import { wordsOf, weeklyEmail, symbolOfCurrency } from '../../../supabase/functions/_shared/stockNotifyRules.js';

// Synthetic ids only (the repo is public).
const UK = 'a2000000-0000-4000-8000-000000000001';
const US = 'a2000000-0000-4000-8000-000000000002';
const BARE = 'a2000000-0000-4000-8000-000000000003';
const SHUT = 'a2000000-0000-4000-8000-0000000000c1';
const scope = {
  homeSite: UK,
  sites: [{ id: UK, currency: 'GBP' }, { id: US, currency: 'usd' }, { id: BARE, currency: null }],
  closedSites: [{ id: SHUT, currency: 'EUR' }],
};
const withActive = (code, fn) => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const store = new Map(code ? [['rpos-active-currency', code]] : []);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) } });
  try { return fn(); } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage;
  }
};

// ── 1. the helper ────────────────────────────────────────────────────────────────────────────
test('siteCurrencyCode: the signed in venue is the active currency; a picked site is its own', () => {
  withActive('GBP', () => {
    assert.equal(siteCurrencyCode(UK, { scope }), 'GBP', 'the signed in venue');
    assert.equal(siteCurrencyCode(null, { scope }), 'GBP', 'no site named');
    assert.equal(siteCurrencyCode(US, { scope }), 'USD', 'a US site picked at a UK venue reads in dollars');
    assert.equal(siteCurrencyCode(SHUT, { scope }), 'EUR', 'a closed site too');
    assert.equal(siteCurrencyCode(BARE, { scope, configCurrency: 'USD' }), 'USD', 'no scope currency: its location config');
    assert.equal(siteCurrencyCode(BARE, { scope }), 'GBP', 'nothing known: the active currency');
    assert.equal(siteCurrencyCode('elsewhere', { scope: null, configCurrency: 'xyz' }), 'GBP', 'an unknown code is never used');
  });
  withActive('USD', () => {
    assert.equal(siteCurrencyCode(US, { scope: { ...scope, homeSite: US } }), 'USD', 'signed in at the US site');
    assert.equal(siteCurrencyCode(UK, { scope: { ...scope, homeSite: US } }), 'GBP', 'a UK site picked at a US venue reads in pounds');
    assert.equal(siteCurrencyCode(BARE, { scope }), 'USD', 'a missing currency is the active venue, never pounds by itself');
  });
  // the signed in venue always wins over its scope row, so a UK venue reads exactly as before
  withActive('GBP', () => assert.equal(siteCurrencyCode(UK, { scope: { ...scope, sites: [{ id: UK, currency: 'USD' }] } }), 'GBP'));
});

test('the small helpers: scope lookup, a siteById map, symbols and bound money', () => {
  assert.equal(knownCode(' usd '), 'USD');
  assert.equal(knownCode('CAD'), null);
  assert.equal(scopeCurrency(scope, US), 'USD');
  assert.equal(scopeCurrency({ siteById: new Map([[US, { id: US, currency: 'USD' }]]) }, US), 'USD');
  assert.equal(scopeCurrency(scope, 'nope'), null);
  withActive('GBP', () => {
    assert.equal(siteCurrencyOf(scope, US), 'USD');
    assert.equal(siteSymbol(US, { scope }), '$');
    assert.equal(siteSymbol(UK, { scope }), '£');
    const us = moneyIn('USD');
    assert.equal(us.money(12.5), '$12.50');
    assert.equal(us.signedMoney(-3), '-$3.00');
    assert.equal(us.moneyMinor(1234), '$12.34');
    assert.equal(us.currencySymbol(), '$');
    assert.equal(us.money(4, 'EUR'), '€4.00', 'a row in its own currency still wins');
    assert.equal(moneyIn(null).money(1), '£1.00', 'none: the active venue, exactly as money()');
  });
});

// ── 2. the word rules ────────────────────────────────────────────────────────────────────────
test('the purchasing and count words in dollars for a US site', () => {
  assert.equal(moneyWords(2140, '$'), '$2,140');
  const b = basketRules({ goods: 80, minOrder: 100, fee: 5, approvalLimit: 50, symbol: '$' });
  assert.deepEqual(b.words.map((w) => w.text), ['Minimum order $100: add $20 more', 'Delivery fee $5']);
  assert.equal(b.approval.text, 'Needs approval: over $50');
  assert.equal(budgetWords({ budget: 2600, spent: 2140, rule: 'fixed' }, 320, '$').right, '$2,140 spent + $320 basket of $2,600');
  assert.equal(splitCheck([{ amount: 10 }], 12, '$').words, 'The splits add up to $10, the invoice is $12.');
  assert.equal(needsApprovalPill(800, '$').text, 'Needs approval: over $800');
  assert.equal(HEADERS_MULTI_OF(1, '$').at(-1), 'Line $ (ex VAT)');
  assert.equal(secondApprovalWords(500, '$'), 'Waiting for a second approval. Over $500.');
  assert.equal(moneyText(1.38, 'USD'), '$1.38');
  assert.equal(siteValueText('approval_limit', 250, null, 'USD'), '$250.00');
  assert.equal(costWords(0.41, 'USD'), '$0.41', 'dollars never read as pence');
});

test('no symbol given: the active venue, so a UK venue reads exactly as before', () => {
  withActive('GBP', () => {
    assert.equal(moneyWords(150), '£150');
    assert.equal(basketRules({ goods: 10, approvalLimit: 5 }).approval.text, 'Needs approval: over £5');
    assert.equal(budgetWords({ budget: 100, spent: 10 }, 0).right, '£10 spent + £0 basket of £100');
    assert.equal(secondApprovalWords(500), 'Waiting for a second approval. Over £500.');
    assert.equal(HEADERS_MULTI_OF(null).at(-1), 'Line £ (ex VAT)');
    assert.equal(costWords(0.41, 'GBP'), '41p', 'pounds keep the pence rule');
    assert.equal(spendText([]), '£0');
  });
  withActive('USD', () => {
    assert.equal(moneyWords(150), '$150', 'a US venue with no symbol passed: dollars, never pounds');
    assert.equal(basketRules({ goods: 10, approvalLimit: 5 }).approval.text, 'Needs approval: over $5');
    assert.equal(budgetWords({ budget: 100, spent: 10 }, 0).right, '$10 spent + $0 basket of $100');
    assert.equal(secondApprovalWords(500), 'Waiting for a second approval. Over $500.');
    assert.equal(splitCheck([{ amount: 1 }], 3).words, 'The splits add up to $1, the invoice is $3.');
    assert.equal(moneyText(2), '$2.00', 'a supplier screen with no currency: the active one, not GBP');
    assert.equal(spendText([]), '$0');
  });
});

test('stock alerts and the weekly email: each row in its own currency', () => {
  assert.equal(symbolOfCurrency('USD'), '$');
  assert.equal(symbolOfCurrency(null), '£', 'no currency at all: the database rule coalesce(currency, GBP)');
  assert.match(wordsOf('approval_wait', { site_name: 'Provo', supplier_name: 'Sysco', amount: 950, currency: 'USD' }).body, /Sysco \$950\./);
  assert.match(wordsOf('approval_wait', { site_name: 'Provo', supplier_name: 'Sysco', amount: 950, currency_symbol: '$' }).body, /\$950/);
  const league = { rows: [{ location_id: 'A', site: 'North', currency: 'GBP', sales_net: 100 }, { location_id: 'B', site: 'Provo', currency: 'USD', sales_net: 200 }], totals: [] };
  const html = weeklyEmail({ payload: { week_start: '2026-10-12', week_end: '2026-10-18', currency_symbol: '£' }, league }).html;
  assert.match(html, /£100/, 'the UK row in pounds');
  assert.match(html, /\$200/, 'the US row in dollars, not the first site\'s symbol');
});

// ── 3. the guard ─────────────────────────────────────────────────────────────────────────────
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = path.resolve(SRC, '..');
const AREA = [
  'src/backoffice/sections/stock', 'src/backoffice/sections/purchasing', 'src/backoffice/sections/produce', 'src/lib/stock',
  'src/backoffice/sections/StockCounts.jsx', 'src/backoffice/sections/StockReports.jsx', 'src/backoffice/sections/StockTransfers.jsx',
  'src/backoffice/sections/Wastage.jsx', 'src/backoffice/sections/StockOverview.jsx', 'src/backoffice/sections/StockAreas.jsx',
  'src/backoffice/sections/OrderPad.jsx',
  'supabase/functions/_shared/purchasingRules.js', 'supabase/functions/_shared/stockNotifyRules.js',
];
const filesOf = (p) => {
  const abs = path.join(ROOT, p);
  if (fs.statSync(abs).isFile()) return [abs];
  return fs.readdirSync(abs, { recursive: true }).map((f) => path.join(abs, String(f)))
    .filter((f) => /\.(js|jsx)$/.test(f) && !/\.test\.js$/.test(f) && fs.statSync(f).isFile());
};
// The source with block comments, JSX comments and line comments blanked (a // inside a quote, such
// as a URL, is kept). Line numbers hold.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .split('\n').map((line) => {
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '\'' || c === '"' || c === '`') q = c;
      else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
    }
    return line;
  }).join('\n');
// What may carry a pound sign: a regex class that reads one, a symbol table, costWords' pence rule.
const ALLOWED = [/\[[^\]]*£[^\]]*\]/g, /GBP:\s*'£'/g, /sym === '£'/g];

test('guard: no typed pound sign in a string, a template or JSX text in the stock area', () => {
  const found = [];
  let files = 0;
  for (const p of AREA) {
    for (const f of filesOf(p)) {
      files++;
      stripComments(fs.readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        let rest = line;
        for (const re of ALLOWED) rest = rest.replace(re, '');
        if (rest.includes('£')) found.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
  }
  assert.ok(files > 150, `the whole area is read (${files} files)`);
  assert.deepEqual(found, [], 'build the symbol from the site currency (useSiteMoney, currencySymbol(code), moneyWords(n, symbol))');
});

test('guard: the guard itself catches a typed pound and lets comments and readers through', () => {
  const check = (src) => stripComments(src).split('\n').some((l) => { let r = l; for (const re of ALLOWED) r = r.replace(re, ''); return r.includes('£'); });
  assert.equal(check("const h = 'Line £ (ex VAT)';"), true);
  assert.equal(check('<b>1 Keg for £152</b>'), true);
  assert.equal(check('placeholder="£"'), true);
  assert.equal(check("// '£1,234' in a comment"), false);
  assert.equal(check("const t = v.replace(/[£$€,\\s]/g, '');"), false);
  assert.equal(check("const SYMBOLS = { GBP: '£', USD: '$' };"), false);
  assert.equal(check("fetch('https://x.test/a') // £"), false);
});
