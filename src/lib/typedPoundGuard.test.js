// node --test: 5.12.57 (batch 1, money and currency). A US venue (Mozz Pizza, USD) saw pound signs
// typed into price boxes, labels and confirm texts, and "US$1,234" where it should read "$1,234".
//
// 1. THE GUARD. No file below may carry a typed pound sign inside a string, a template or JSX text:
//    the symbol comes from the venue's currency (currencySymbol(), money(), or the site's own fmt
//    on a report showing another site). Comments may name the pound; a regex that READS a typed
//    symbol (/^[£$€]/) is allowed, it is never shown. *.test.js files are not checked.
// 2. The Owner app's money (surfaces/owner/style.js) and ownerStock's moneyWords format in the
//    currency's own locale: "$1,234" for USD, "£1,234" for GBP (exactly as before).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { money as ownerMoney } from '../surfaces/owner/style.js';
import { moneyWords, stockLine } from './ownerStock.js';
import { money } from './currency.js';
import { fmtSymbol } from '../backoffice/sections/reports/_fmtSymbol.js';

const POUND = '£';
const ROOT = new URL('../../', import.meta.url);
const read = (p) => fs.readFileSync(fileURLToPath(new URL(p, ROOT)), 'utf8');

// Every file in batch 1's typed pound area. A new screen that types a pound into one of these
// fails here; add a file to the list when its pounds are cleaned.
const FILES = [
  'src/backoffice/sections/MenuManager.jsx',
  'src/backoffice/sections/MenuVisualizer.jsx',
  'src/backoffice/sections/PerMenuPricingTiers.jsx',
  'src/backoffice/sections/msm/MsmChangePrices.jsx',
  'src/backoffice/sections/DiscountManager.jsx',
  'src/backoffice/sections/LoyaltyManager.jsx',
  'src/backoffice/sections/OnlineOrdering.jsx',
  'src/backoffice/sections/UberDirect.jsx',
  'src/backoffice/sections/TableBookings.jsx',
  'src/backoffice/sections/MenuAppearance.jsx',
  'src/backoffice/sections/CardPayments.jsx',
  'src/backoffice/sections/marketing/Promotions.jsx',
  'src/backoffice/sections/marketing/MarketingReports.jsx',
  'src/backoffice/sections/marketing/Segments.jsx',
  'src/backoffice/sections/reports/DailyTrading.jsx',
  'src/backoffice/sections/reports/Tips.jsx',
  'src/backoffice/sections/reports/Daypart.jsx',
  'src/backoffice/sections/reports/OrderTypes.jsx',
  'src/backoffice/sections/reports/_charts.jsx',
  'src/backoffice/sections/reports/_fmtSymbol.js',
  'src/backoffice/sections/reports/Shifts.jsx',
  'src/components/SplitModal.jsx',
  'src/components/DrawerCashModal.jsx',
  'src/components/CheckHistory.jsx',
  'src/components/DiscountModal.jsx',
  'src/lib/emailCompiler.js',
  'src/lib/ownerStock.js',
  'src/surfaces/owner/style.js',
  'supabase/functions/_shared/message-types.ts',
];

// The source with comments and regex literals blanked (newlines kept, so line numbers hold).
// Strings and templates are kept, JSX text is kept. A quote string ends at its line's end, so a
// stray apostrophe in JSX text ("Don't") cannot swallow more than its own line.
const REGEX_BEFORE = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^']);
function codeOnly(src) {
  let out = '';
  let i = 0;
  let last = '';   // the last character that was not white space, outside comments
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += blank(src.slice(i, stop)); i = stop; continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += blank(src.slice(i, stop)); i = stop; continue;
    }
    if (c === '/' && (last === '' || REGEX_BEFORE.has(last))) {
      let j = i + 1, inClass = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j++;
      }
      if (src[j] === '/') {
        j++;
        while (/[a-z]/i.test(src[j] || '')) j++;
        out += blank(src.slice(i, j)); i = j; last = '/'; continue;
      }
    }
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && (c === '`' || src[j] !== '\n')) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1; last = c; continue;
    }
    out += c;
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return out;
}

const poundLines = (src) => codeOnly(src).split('\n')
  .map((line, k) => (line.includes(POUND) ? k + 1 : 0)).filter(Boolean);

test('the guard reads code, not comments: a typed pound in a string, a template or JSX text is caught, in a comment or a regex it is not', () => {
  const sample = [
    `// a comment may say ${POUND}5`,
    `/* so may ${POUND}5 here */`,
    `const a = '${POUND}5';`,
    'const b = `' + POUND + '${n}`;',
    `const c = <span>${POUND}</span>;`,
    `const d = v.replace(/^[${POUND}$€]/, '');`,
    `{/* ${POUND} in a JSX comment */}`,
    `const e = <div>Don't</div>; const f = 'fine';`,
  ].join('\n');
  assert.deepEqual(poundLines(sample), [3, 4, 5]);
});

test('no typed pound sign in a string, template or JSX text in any batch 1 file (5.12.57)', () => {
  const found = [];
  for (const f of FILES) {
    assert.ok(!f.endsWith('.test.js'), `${f}: tests are not checked`);
    for (const line of poundLines(read(f))) found.push(`${f}:${line}`);
  }
  assert.deepEqual(found, [], `typed pound signs left (use currencySymbol(), money() or the site's fmt):\n${found.join('\n')}`);
});

test('the Owner app money: "$1,234" for USD, "£1,234" for GBP, as before', () => {
  assert.equal(ownerMoney(1234, 'USD'), '$1,234');
  assert.equal(ownerMoney(1234, 'GBP'), `${POUND}1,234`);
  assert.equal(ownerMoney(1234), `${POUND}1,234`, 'no currency is GBP, as before');
  assert.equal(ownerMoney(1234.5, 'USD', 2), '$1,234.50');
  assert.equal(ownerMoney(1234, 'EUR'), '€1,234');
  assert.doesNotMatch(ownerMoney(1234, 'USD'), /US\$/);
});

test('ownerStock: "$1,234" for USD, "£1,234" for GBP, and the Stock line follows the block currency', () => {
  assert.equal(moneyWords(1234, 'USD'), '$1,234');
  assert.equal(moneyWords(1234, 'GBP'), `${POUND}1,234`);
  assert.equal(moneyWords(1234), `${POUND}1,234`);
  const block = { value: 1234, gp_pct_actual: 70, gap_pct: 1, waste_pct: 1, rag: {}, last_full_count_words: 'Tue 13 Oct' };
  assert.equal(stockLine({ ...block, currency: 'USD' }, 'GBP').parts[0].text, 'Stock $1,234');
  assert.equal(stockLine(block, 'GBP').parts[0].text, `Stock ${POUND}1,234`);
});

test('report charts take the symbol from the fmt they are handed, so another site reads its own money', () => {
  assert.equal(fmtSymbol((n) => money(n || 0, 'USD')), '$');
  assert.equal(fmtSymbol((n) => money(n || 0, 'GBP')), POUND);
  assert.equal(fmtSymbol((n) => money(n || 0, 'EUR')), '€');
  // no fmt, or one with no symbol: the active venue's (GBP when nothing is set, as in node)
  assert.equal(fmtSymbol(undefined), POUND);
  assert.equal(fmtSymbol((n) => Number(n).toFixed(2)), POUND);
});
