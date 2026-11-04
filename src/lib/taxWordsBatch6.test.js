// taxWordsBatch6.test.js: US basics, batch 6, tax (5.12.57). Run: node --test.
//
//   1. the tax word per currency (one helper: supabase/functions/_shared/taxWords.js, which
//      ownerBasis.taxWord and lib/taxWords.js read), UK words exactly as before
//   2. a new legacy rate at a US venue starts exclusive (added on top), at a UK one inclusive
//   3. the US seed needs a typed rate (0 to 20) and never seeds a fixed New York 8.875%; each
//      country sees only its own seed
//   4. the Tax summary counts tax profiles as tax set up (a profiles only venue is not blank)
//   5. the report lines and the multi site menu words at a US venue say tax, at a UK one VAT
//   6. a guard: no VAT or HMRC in the words of the batch 6 files without the helper or a UK gate

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Back Office's active venue is read from localStorage (lib/currency.js). A stub lets a test
// put the screen on a US venue and back; with nothing set it is a UK venue, as in the browser.
let activeCurrency = null;
globalThis.localStorage = { getItem: () => activeCurrency, setItem: () => {}, removeItem: () => {} };
const onVenue = (code, fn) => { const was = activeCurrency; activeCurrency = code; try { return fn(); } finally { activeCurrency = was; } };

const { taxWords, taxWord, taxText, mixedTaxWords } = await import('../../supabase/functions/_shared/taxWords.js');
const { activeTaxWords, activeTaxText } = await import('./taxWords.js');
const ownerBasis = await import('./ownerBasis.js');
const { usSeedRates, newRateDefaults, UK_DEFAULT_RATES } = await import('./tax.js');
const taxLib = await import('./tax.js');
const { taxIsSetUp, buildSiteMenu, taxAnalysisOf } = await import('./reportSiteMenu.js');
const { noVatLine, flaggedLines, loyaltyVatLine, LOYALTY_VAT_LINE, LOYALTY_VAT_XERO_LINE, loyaltyVatXeroLine } = await import('../../supabase/functions/_shared/saleVat.js');
const { vatMissingLine } = await import('./salesStats.js');
const { colWord, fieldWord, keptValueWords, sizeVatWords, COL_WORDS } = await import('./msm/msmWords.js');
const { vatExample, vatCell } = await import('./msm/msmOrderTypes.js');
const { lockWord } = await import('./msm/msmLock.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const DASH = /[\u2013\u2014]/;

// ── 1. the tax word ──────────────────────────────────────────────────────────
test('the tax word per currency: VAT at GBP and EUR (and no currency), tax at USD; HMRC only in the UK', () => {
  assert.equal(taxWord('GBP'), 'VAT');
  assert.equal(taxWord('EUR'), 'VAT');
  assert.equal(taxWord(null), 'VAT');
  assert.equal(taxWord('USD'), 'tax');
  assert.equal(taxWord('usd'), 'tax');
  assert.equal(taxWord({ currency: 'USD' }), 'tax');
  assert.equal(taxWord({ country: 'US', currency: 'GBP' }), 'tax', 'a country field wins over the currency');
  const uk = taxWords('GBP'), us = taxWords('USD'), ie = taxWords('EUR');
  assert.deepEqual([uk.tax, uk.Tax, uk.sales, uk.exTax, uk.incTax, uk.us, uk.uk], ['VAT', 'VAT', 'VAT', 'ex VAT', 'inc VAT', false, true]);
  assert.deepEqual([us.tax, us.Tax, us.sales, us.Sales, us.exTax, us.incTax, us.us, us.uk], ['tax', 'Tax', 'sales tax', 'Sales tax', 'before tax', 'with tax', true, false]);
  assert.deepEqual([ie.tax, ie.us, ie.uk], ['VAT', false, false], 'Ireland says VAT but is not HMRC');
  // ownerBasis.taxWord (the Owner app, Sales summary and the stock words read it) is the same helper.
  for (const c of ['GBP', 'USD', 'EUR', null, '']) assert.equal(ownerBasis.taxWord(c), taxWord(c));
  // A screen of one venue uses the venue's word; a screen that mixes countries says tax.
  assert.equal(mixedTaxWords(['GBP', 'GBP']).tax, 'VAT');
  assert.equal(mixedTaxWords(['GBP', 'EUR']).tax, 'VAT');
  assert.equal(mixedTaxWords(['GBP', 'USD']).tax, 'tax');
  assert.equal(mixedTaxWords(['USD']).tax, 'tax');
  // The active venue follows the Back Office's currency.
  assert.equal(activeTaxWords().tax, 'VAT');
  onVenue('USD', () => assert.equal(activeTaxWords().tax, 'tax'));
});

test('taxText leaves UK and Irish words byte for byte and says tax at a US venue', () => {
  const lines = ['VAT by order type', 'Group VAT', 'No VAT rate', 'Net sales (ex-VAT)', 'Tax & VAT', 'Takings (inc VAT)', 'Code VAT20', "Same as the product's VAT"];
  for (const l of lines) { assert.equal(taxText(l, 'GBP'), l); assert.equal(taxText(l, 'EUR'), l); assert.equal(activeTaxText(l), l); }
  assert.deepEqual(lines.map((l) => taxText(l, 'USD')), ['Tax by order type', 'Group tax', 'No tax rate', 'Net sales (before tax)', 'Tax', 'Takings (with tax)', 'Code VAT20', "Same as the product's tax"]);
  assert.equal(taxText(undefined, 'USD'), undefined, 'a missing label stays missing');
});

// ── 2. a new rate ────────────────────────────────────────────────────────────
test('a new legacy rate at a US venue defaults exclusive (added on top); at a UK venue inclusive as before', () => {
  assert.equal(newRateDefaults('US').type, 'exclusive');
  assert.equal(newRateDefaults('UK').type, 'inclusive');
  assert.equal(newRateDefaults('IE').type, 'inclusive');
  assert.deepEqual(newRateDefaults('UK'), { name:'', code:'', rate:'', type:'inclusive', applies_to:['all'], is_default:false, active:true }, 'the UK starting values are the old EMPTY');
  const src = read('src/backoffice/sections/TaxManager.jsx');
  assert.match(src, /useState\(\{ \.\.\.newRateDefaults\(tw\.country\), \.\.\.rate \}\)/);
  assert.doesNotMatch(src, /const EMPTY = /, 'no fixed inclusive starting values left');
  // The "(UK VAT)" label is only on a UK venue's option.
  assert.match(src, /\{tw\.us \? 'Inclusive: tax is in the price' : 'Inclusive — tax is in the price \(UK VAT\)'\}/);
  assert.match(src, /\{tw\.us \? 'Inclusive: already inside the price' : 'Inclusive: already inside the price \(UK VAT\)'\}/);
});

// ── 3. the seeds ─────────────────────────────────────────────────────────────
test('the US seed needs a typed rate from 0 to 20 and never seeds a fixed 8.875%', () => {
  for (const bad of [undefined, null, '', '  ', 'abc', -1, '20.5', 21, '25%']) {
    const r = usSeedRates(bad);
    assert.equal(r.ok, false, `refused: ${JSON.stringify(bad)}`);
    assert.ok(r.error && !DASH.test(r.error));
  }
  const provo = usSeedRates('7.45');
  assert.equal(provo.ok, true);
  assert.equal(provo.rates[0].rate, 0.0745);
  assert.equal(provo.rates[0].type, 'exclusive');
  assert.equal(provo.rates[0].is_default, true);
  assert.equal(provo.rates[0].name, 'Sales tax', 'named Sales tax unless the owner names it');
  assert.equal(usSeedRates('7.45', 'Provo sales tax').rates[0].name, 'Provo sales tax');
  assert.equal(usSeedRates('7.45%').rates[0].rate, 0.0745);
  assert.equal(usSeedRates(0).ok, true, '0 is a rate (a tax free state)');
  assert.equal(usSeedRates(20).ok, true);
  assert.ok(provo.rates.every((r) => r.type === 'exclusive'));
  // No fixed US rate is left anywhere it could be seeded from.
  assert.equal(taxLib.US_DEFAULT_RATES, undefined, 'the fixed New York seed is gone');
  for (const f of ['src/lib/tax.js', 'src/backoffice/sections/TaxManager.jsx']) assert.doesNotMatch(read(f), /0\.08875|US_DEFAULT_RATES/, f);
  // The UK seed is untouched.
  assert.deepEqual(UK_DEFAULT_RATES.map((r) => [r.code, r.rate, r.type]), [['VAT20', 0.2, 'inclusive'], ['VAT5', 0.05, 'inclusive'], ['ZERO', 0, 'inclusive']]);
});

test('each country is offered only its own seed, and the no rates warnings point at the right one', () => {
  const tm = read('src/backoffice/sections/TaxManager.jsx');
  assert.match(tm, /\{tw\.uk && !rates\.length && !loading && !loadFailed && \(\s*<button onClick=\{\(\) => seedRates\(UK_DEFAULT_RATES\)\}/, 'Seed UK rates only at a UK venue');
  assert.match(tm, /\{tw\.us && \(\s*<div[^]*?US Sales Tax \(Exclusive\)[^]*?<button onClick=\{seedUs\} disabled=\{seeding \|\| usRate === ''\}/, 'Seed US rates only at a US venue, and only with a rate typed');
  assert.match(tm, /const r = usSeedRates\(usRate, usName\);\n\s*if \(!r\.ok\) \{ setUsSeedError\(r\.error\); return; \}/);
  assert.match(tm, /'This venue has no tax rates, so its sales record no VAT\. Press Seed UK rates \(Standard 20% becomes the default\), then check Menu, Items for products with no rate\.'/, 'UK words unchanged');
  assert.match(tm, /type the rate under US Sales Tax and press Seed US rates/);
  const mm = read('src/backoffice/sections/MenuManager.jsx');
  assert.match(mm, /\{ukVenue \? 'press Seed UK rates' : tw\.us \? 'set up tax profiles, or type the rate under US Sales Tax and press Seed US rates' : 'add its rates'\}/);
  assert.match(mm, /tw\.us \? 'sales tax until you type the rate under US Sales Tax and press Seed US rates in Tax' : 'VAT until you press Seed UK rates in Tax & VAT'/);
});

// ── 4. the Tax summary counts tax profiles ──────────────────────────────────
test('the Tax summary counts tax profiles as tax set up, so a profiles only venue is not blank', () => {
  assert.equal(taxIsSetUp({}), false);
  assert.equal(taxIsSetUp({ taxRates: [{ id: 'r1' }] }), true);
  assert.equal(taxIsSetUp({ taxProfiles: [{ id: 'p1', active: true }] }), true, 'a profile with no legacy rate');
  assert.equal(taxIsSetUp({ taxProfiles: [{ id: 'p1', active: false }] }), false, 'a switched off profile is not set up');
  assert.equal(taxIsSetUp({ defaultProfileId: 'p1' }), true);
  // The signed in site hands the engine context (the store's): a real profile counts, a legacy mirror does not.
  assert.equal(taxIsSetUp({ taxCtx: { profilesById: { 'legacy:r1': {} } } }), false);
  assert.equal(taxIsSetUp({ taxCtx: { profilesById: { 'legacy:r1': {}, 'b7c1': {} } } }), true);
  assert.equal(taxIsSetUp({ taxCtx: { profilesById: {}, venueDefaultProfileId: 'b7c1' } }), true);
  // Another site's menu read with profiles only: hasRates true (was taxRates.length > 0, false).
  const menu = buildSiteMenu({ id: 'mozz', taxRates: [], taxProfiles: [{ id: 'p1', active: true, lines: [] }], defaultProfileId: 'p1' });
  assert.equal(menu.hasRates, true);
  assert.equal(buildSiteMenu({ id: 'empty' }).hasRates, false);
  // With tax set up a sale with no tax recorded is named, in the venue's word.
  const checks = [{ id: 'c1', ref: 'R1', status: 'closed', total: 10, subtotal: 10, taxAmount: null, items: [{ price: 10, qty: 1 }] }];
  const a = taxAnalysisOf(checks, () => ({ totalTax: 0, subtotal: 10, breakdown: [], source: 'rates' }), { hasRates: true });
  assert.equal(a.ledger.noVatCount, 1);
  assert.equal(noVatLine(a.ledger, 'USD'), '1 sale has no tax recorded: R1');
  // The screen reads it through taxIsSetUp, for the signed in site and another site alike.
  const tax = read('src/backoffice/sections/reports/Tax.jsx');
  assert.match(tax, /const hasRates = other\.other \? !!other\.menu\?\.hasRates : taxIsSetUp\(\{ taxRates, taxProfiles: store\.taxProfiles, defaultProfileId: store\.venueDefaultTaxProfileId, taxCtx \}\);/);
  assert.match(tax, /if \(!hasRates && !\(other\.other/);
  assert.match(tax, /<VatNotes [^>]*hasRates=\{hasRates\}/);
  assert.doesNotMatch(tax, /taxRates\.length === 0|taxRates\.length > 0/);
});

// ── 5. the words at each venue ───────────────────────────────────────────────
test('the report lines: UK words exactly as before, tax at a US venue', () => {
  const ledger = { noVatCount: 2, noVat: [{ ref: 'QR-4OGI7' }, { ref: 'R12' }], flagged: [{ ref: 'R4', words: 'VAT filled in when the sale was saved' }] };
  assert.equal(noVatLine(ledger), '2 sales have no VAT recorded: QR-4OGI7, R12');
  assert.equal(noVatLine(ledger, 'GBP'), '2 sales have no VAT recorded: QR-4OGI7, R12');
  assert.equal(noVatLine(ledger, 'USD'), '2 sales have no tax recorded: QR-4OGI7, R12');
  assert.deepEqual(flaggedLines(ledger), ['R4: VAT filled in when the sale was saved']);
  assert.deepEqual(flaggedLines(ledger, 'USD'), ['R4: Tax filled in when the sale was saved']);
  assert.equal(LOYALTY_VAT_LINE, "Includes VAT on loyalty rewards (the till's rule).");
  assert.equal(loyaltyVatLine('GBP'), LOYALTY_VAT_LINE);
  assert.equal(loyaltyVatLine('USD'), "Includes tax on loyalty rewards (the till's rule).");
  assert.equal(LOYALTY_VAT_XERO_LINE, "VAT on loyalty rewards: the Back Office Tax summary includes it (the till's rule); this invoice takes it off on the Loyalty rewards line. One rule follows once the accountant decides.");
  assert.ok(!/VAT/.test(loyaltyVatXeroLine('USD')));
  const stats = { vatMissing: [{ ref: 'QR-4OGI7' }] };
  assert.equal(vatMissingLine(stats), '1 sale has no VAT recorded: QR-4OGI7');
  assert.equal(vatMissingLine(stats, 'USD'), '1 sale has no tax recorded: QR-4OGI7');
});

test('the multi site menu words: UK words unchanged, no VAT at a US venue', () => {
  const uk = [colWord('tax_rate_id'), colWord('tax_overrides'), fieldWord('tax_by_type'), fieldWord('tax_rate_name'), lockWord('tax_rate_id'), keptValueWords('tax_rate_id', null), sizeVatWords({ product: 'Latte' })];
  assert.deepEqual(uk, ['VAT rate', 'VAT by order type', 'VAT by order type', 'VAT', 'VAT', 'no VAT rate', 'This size uses its VAT for every order type, as Latte does. To set VAT by order type, set it on Latte: its sizes follow it.']);
  onVenue('USD', () => {
    const us = [colWord('tax_rate_id'), colWord('tax_overrides'), fieldWord('tax_by_type'), lockWord('tax_rate_id'), keptValueWords('tax_rate_id', null), sizeVatWords({ product: 'Latte' }),
      vatExample({ product: { name: 'Latte' }, rates: [], siteName: 'Provo' }).words, vatExample({ product: { name: 'Latte' }, rates: null, siteName: 'Provo' }).words,
      vatCell({ tax_rate_percent: null }, null, null, 'takeaway').words];
    for (const w of us) assert.doesNotMatch(w, /\bVAT\b/, w);
    assert.equal(colWord('tax_rate_id'), 'tax rate', 'a column name inside a sentence stays lower case');
    assert.equal(fieldWord('tax_by_type'), 'tax by order type');
    assert.equal(lockWord('tax_overrides'), 'tax by order type');
    assert.equal(taxText('VAT rate', 'USD', { mid: true }), 'tax rate');
    assert.equal(taxText('VAT rate', 'GBP', { mid: true }), 'VAT rate');
    assert.equal(vatExample({ product: { name: 'Latte' }, rates: [], siteName: 'Provo' }).words, 'Provo has no tax rates set up. Add them in Settings, Tax.');
    // The constants stay what the tests pin; only the reading changes.
    assert.equal(COL_WORDS.tax_rate_id, 'VAT rate');
  });
});

// ── 6. the guard ─────────────────────────────────────────────────────────────
// Every line in the batch 6 files whose WORDS hold VAT or HMRC must go through the tax word helper or
// sit behind an explicit UK gate. How it is detected:
//   1. comments are removed first (// to the end of a line, and /* ... */ blocks, JSX ones too, over
//      any number of lines), so a comment may say VAT freely; a // inside a web address is kept;
//   2. a line is a hit when what is left holds VAT as a word (VAT, VAT20; not an identifier such as
//      LOYALTY_VAT_LINE or noVatLine) or HMRC;
//   3. a hit passes when the line, or one of the 2 lines above it, holds a gate: tw. or tw (the venue's
//      words), tt( / taxText / activeTaxText (UK words read through the helper), taxWord / taxWords /
//      activeTaxWords / mixedTaxWords, addedOn (the Xero screens' own added on tax flag), ukVenue,
//      activeCountry() (a UK or US branch), or an explicit marker comment on one of those lines:
//      "uk only: <why>" (a UK constant, such as the UK seed) or "taxText: <reader>" (a UK constant
//      every reader takes through taxText).
// A new hard coded 'VAT' in a screen of these files fails here until it is routed or gated.
const GUARDED = [
  'src/backoffice/sections/TaxManager.jsx', 'src/lib/tax.js', 'src/backoffice/sections/reports/Tax.jsx',
  'src/backoffice/sections/reports/DailyTrading.jsx', 'src/backoffice/sections/reports/ZReport.jsx',
  'src/backoffice/sections/reports/SalesSummary.jsx', 'src/lib/salesStats.js', 'supabase/functions/_shared/saleVat.js',
  'src/backoffice/sections/EODClose.jsx', 'src/lib/shiftReport.js', 'src/backoffice/sections/reports/DailyTrend.jsx',
  'src/backoffice/sections/reports/LocationCompare.jsx', 'src/backoffice/sections/reports/Catalog.jsx', 'src/lib/reportSiteMenu.js',
  'src/surfaces/manager/ManagerHome.jsx', 'src/surfaces/manager/ManagerReports.jsx', 'src/surfaces/manager/ManagerKitchen.jsx',
  'src/backoffice/sections/MenuManager.jsx',
  'src/backoffice/sections/msm/MsmGrid.jsx', 'src/backoffice/sections/msm/MsmProductSheet.jsx', 'src/backoffice/sections/msm/MsmGroupSheet.jsx',
  'src/backoffice/sections/msm/MsmDetails.jsx', 'src/backoffice/sections/msm/MsmPublish.jsx', 'src/backoffice/sections/msm/MsmSites.jsx',
  'src/lib/msm/msmOrderTypes.js', 'src/lib/msm/msmRisk.js', 'src/lib/msm/msmSummary.js', 'src/lib/msm/msmWords.js',
  'src/lib/msm/msmDriftView.js', 'src/lib/msm/msmLock.js', 'src/lib/msm/msmPublishView.js',
  'src/lib/boSections.js', 'src/backoffice/BackOfficeApp.jsx',
  'src/backoffice/sections/XeroIntegration.jsx', 'src/backoffice/sections/xero/PostingsHistory.jsx', 'src/backoffice/sections/xero/xeroUi.js',
  'src/backoffice/sections/xero/SiteSetup.jsx', 'src/backoffice/sections/ReceiptBranding.jsx', 'src/backoffice/sections/DeviceProfiles.jsx',
  'src/lib/taxWords.js',
];
// supabase/functions/_shared/taxWords.js is the helper itself (it holds the UK words), so it is not guarded.
const WORD = /\bVAT(?![A-Z_])|HMRC/;
const GATE = /\btw\b|\btt\(|taxWord|taxText|activeTaxWords|mixedTaxWords|\baddedOn|\bukVenue\b|activeCountry\(\)/;
const MARK = /uk only:|taxText:/;

/** The source with its comments removed, line for line (the line numbers stay the same). */
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const raw of src.split('\n')) {
    let line = '';
    let i = 0;
    while (i < raw.length) {
      if (inBlock) { const j = raw.indexOf('*/', i); if (j < 0) i = raw.length; else { inBlock = false; i = j + 2; } continue; }
      const rest = raw.slice(i);
      const block = rest.indexOf('/*');
      const lm = rest.search(/(^|[\s;,(){}[\]])\/\//);
      const lineAt = lm < 0 ? -1 : lm + (rest.slice(lm).startsWith('//') ? 0 : 1);
      if (block >= 0 && (lineAt < 0 || block < lineAt)) { line += rest.slice(0, block); inBlock = true; i += block + 2; continue; }
      if (lineAt >= 0) { line += rest.slice(0, lineAt); break; }
      line += rest; break;
    }
    out.push(line);
  }
  return out;
}

function ungated(file) {
  const src = read(file);
  const raw = src.split('\n');
  const lines = stripComments(src);
  const hits = [];
  lines.forEach((l, n) => {
    if (!WORD.test(l)) return;
    const near = [n, n - 1, n - 2].filter((k) => k >= 0);
    if (near.some((k) => GATE.test(lines[k]))) return;
    if (near.some((k) => MARK.test(raw[k]))) return;
    hits.push(`${file}:${n + 1}: ${l.trim().slice(0, 120)}`);
  });
  return hits;
}

test('the guard finds a hard coded VAT, and passes one behind the helper or a gate', () => {
  const tmp = (s) => { const lines = stripComments(s); return lines.some((l, n) => WORD.test(l) && ![n, n - 1, n - 2].filter((k) => k >= 0).some((k) => GATE.test(lines[k]))); };
  assert.equal(tmp("const label = 'VAT due';"), true);
  assert.equal(tmp("const label = `${tw.Tax} due`;"), false);
  assert.equal(tmp("const label = tw.us ? 'Tax due' : 'VAT due';"), false);
  assert.equal(tmp('// VAT is HMRC relevant\nconst x = 1;'), false, 'a comment is not words');
  assert.equal(tmp('/* VAT\n HMRC */ const x = 1;'), false);
  assert.equal(tmp("const n = LOYALTY_VAT_LINE + noVatLine();"), false, 'an identifier is not a word');
  assert.equal(tmp("const u = 'https://example.com/VAT';"), true, 'a web address is not a comment');
});

test('GUARD: no VAT or HMRC in the words of the batch 6 files without the tax word helper or a UK gate', () => {
  const hits = GUARDED.flatMap(ungated);
  assert.deepEqual(hits, [], `ungated tax words:\n${hits.join('\n')}`);
});

test('nothing this batch wrote uses an em or en dash in the US words', () => {
  onVenue('USD', () => {
    for (const w of [usSeedRates('').error, usSeedRates('99').error, noVatLine({ noVatCount: 1, noVat: [{ ref: 'A' }] }, 'USD'), loyaltyVatLine('USD'), loyaltyVatXeroLine('USD'), taxText('Net sales (ex-VAT)', 'USD')]) {
      assert.doesNotMatch(w, DASH, w);
    }
  });
  // The helper files (this test file quotes UK words that hold a dash, so it is not read here).
  const helper = read('supabase/functions/_shared/taxWords.js') + read('src/lib/taxWords.js');
  assert.doesNotMatch(helper, DASH);
});
