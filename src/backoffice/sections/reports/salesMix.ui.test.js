/**
 * salesMix.ui.test.js: the Sales mix report's wiring, read as source text (there is no React
 * harness in the repo). Pins what the build spec of 8 Oct 2026 asked for:
 *   1. The catalogue row sits right after Business summary, in the Sales reports.
 *   2. The report is flagged multi site and item level (7 day cap across sites).
 *   3. Another site's categories are read WITH accounting_group (else every other site is Other sales).
 *   4. The shell mounts the report with prevChecks, compare and range, and hands Business summary
 *      the onOpenReport prop its "Open Sales mix" link needs.
 *   5. Business summary mounts the strip in both views; the Z report mounts the groups block.
 *   6. The setup panel writes through store.updateCategory with the camel key and { opened }.
 *   7. Plain words: no long dashes, no "N/A", no percent maths in the report's JSX.
 * Run: `npm test`, or `node --test src/backoffice/sections/reports/salesMix.ui.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPORT_SITE_MODE, ITEM_LEVEL_REPORTS, siteModeFor, itemCapLine } from '../../../lib/reportScope.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(HERE, p), 'utf8');

// Catalog.jsx is JSX (node cannot load it), so the catalogue is read as text: the Sales reports
// block runs from its id to the Staff reports id, one report row per line.
test('catalogue: Sales mix is the row right after Business summary in the Sales reports', () => {
  const cat = read('./Catalog.jsx');
  const start = cat.indexOf("id: 'sales', label: 'Sales reports'");
  const end = cat.indexOf("id: 'staff'");
  assert.ok(start > 0 && end > start, 'the Sales reports block is there');
  const rows = cat.slice(start, end).split('\n').filter((l) => /^\s*\{ id:'/.test(l));
  const ids = rows.map((l) => /id:'([^']+)'/.exec(l)[1]);
  assert.equal(ids.indexOf('sales_mix'), ids.indexOf('summary') + 1, ids.join(','));
  const row = rows.find((l) => l.includes("id:'sales_mix'"));
  assert.match(row, /label:'Sales mix'/);
  assert.match(row, /desc:'Food, drinks and other: each sales group with its share, by day and by service period'/);
  assert.doesNotMatch(row, /section:/, 'an in shell report, not a link to another part');
  // REPORT_INDEX is built from CATEGORIES, so the row being in this block puts it under 'sales'
  assert.match(cat, /export const REPORT_INDEX = \(\(\) => \{\s*const idx = \{\};\s*CATEGORIES\.forEach/);
});

test('scope: sales_mix is multi site and item level, so several sites are capped at 7 days', () => {
  assert.equal(REPORT_SITE_MODE.sales_mix, 'multi');
  assert.equal(siteModeFor('sales_mix'), 'multi');
  assert.ok(ITEM_LEVEL_REPORTS.has('sales_mix'));
  const two = [{ id: 'a' }, { id: 'b' }];
  assert.equal(itemCapLine('sales_mix', two, { fromDay: '2026-10-01', toDay: '2026-10-07' }), null);
  assert.match(itemCapLine('sales_mix', two, { fromDay: '2026-10-01', toDay: '2026-10-08' }), /up to 7 days/);
  assert.equal(itemCapLine('sales_mix', [{ id: 'a' }], { fromDay: '2026-09-01', toDay: '2026-10-08' }), null);
});

test('another site\'s categories are read with accounting_group', () => {
  const src = read('../../../lib/reportSites.js');
  const m = /categories:\s*'([^']+)'/.exec(src);
  assert.ok(m, 'cols.categories is there');
  assert.ok(m[1].split(/,\s*/).includes('accounting_group'), m[1]);
});

test('the shell mounts the report and hands Business summary the Open Sales mix prop', () => {
  const src = read('../BOReports.jsx');
  assert.match(src, /import SalesMix\s+from '\.\/reports\/SalesMix';/);
  const mount = src.split('\n').find((l) => l.includes("view === 'sales_mix'"));
  assert.ok(mount, 'a mount line');
  for (const prop of ['checks={filtered}', 'prevChecks={filteredPrev}', 'compare={shownCompare}', 'range={trendRange}', 'locationConfig={locationConfig}', '{...siteProps}']) {
    assert.ok(mount.includes(prop), `mount carries ${prop}`);
  }
  const summary = src.split('\n').find((l) => l.includes("view === 'summary'"));
  assert.ok(summary.includes('onOpenReport={openReport}'), 'Business summary gets onOpenReport');
});

test('Business summary mounts the strip in both views; the Z report mounts the groups block', () => {
  const ss = read('./SalesSummary.jsx');
  assert.match(ss, /import SalesMixStrip from '\.\/SalesMixStrip';/);
  assert.match(ss, /function SalesSummaryOne\(\{ checks, prevChecks, fmt, fmtN, locationConfig, compare, sites, scope, onOpenReport \}\)/);
  const strips = ss.split('\n').filter((l) => l.includes('<SalesMixStrip'));
  assert.equal(strips.length, 2);
  assert.ok(strips[0].includes('checks={checks}') && strips[0].includes("onOpenReport('sales_mix')"), 'one site strip');
  assert.ok(strips[1].includes('block={b}') && strips[1].includes('fromSums={fromSums}'), 'split view strip');
  // the strip sits between the four tiles and the By service period card
  assert.ok(ss.indexOf('<SalesMixStrip checks') < ss.indexOf('servicePeriods && servicePeriods.rows.length > 0'));

  const z = read('./ZReport.jsx');
  assert.match(z, /import ZReportGroups from '\.\/ZReportGroups';/);
  assert.match(z, /export default function ZReport\(\{ checks, periodLabelText, rangeFrom, rangeTo, timeZone, fmt, fmtN, scope \}\)/);
  const slip = z.split('\n').filter((l) => l.includes('<ZReportGroups'));
  assert.equal(slip.length, 1);
  assert.ok(slip[0].includes('siteId={scope?.homeId}'));
  assert.ok(z.indexOf('<span>Net sales</span>') < z.indexOf('<ZReportGroups'), 'after the Net sales row');
  assert.ok(z.indexOf('<ZReportGroups') < z.indexOf('{/* Tax */}'), 'before the tax block');
});

test('the Z report block redefines ROW, DIV and BOLD and prints SALES BY GROUP; the strip has the sums note', () => {
  const z = read('./ZReportGroups.jsx');
  assert.match(z, /const ROW = \{ display:'flex', justifyContent:'space-between', padding:'3px 0', fontSize:11, lineHeight:1\.5 \};/);
  assert.match(z, /const DIV = \{ borderTop:'1px dashed currentColor', margin:'8px 0' \};/);
  assert.match(z, /const BOLD = \{ fontWeight:700 \};/);
  assert.ok(z.includes('SALES BY GROUP'));
  assert.ok(z.includes('before check discounts and refunds'));
  const strip = read('./SalesMixStrip.jsx');
  assert.ok(strip.includes('SUMS_NOTE'));
  assert.ok(strip.includes('fromSums'));
  assert.ok(strip.includes('Open Sales mix ›'));
});

test('the setup panel writes through store.updateCategory with the camel key and the opened row, then markBOChange', () => {
  const src = read('./SalesMixSetup.jsx');
  assert.match(src, /updateCategory\(ch\.id, \{ accountingGroup: ch\.text \}, \{ opened: storeRow \}\)/);
  assert.ok(src.includes('markBOChange'));
  assert.ok(src.includes('SETUP_OPTIONS'), 'the dropdown options come from salesMix.js (Other sales writes the text Other)');
  assert.ok(src.includes('className="modal-back"'));
  assert.ok(src.includes('Set up sales groups'));
  assert.ok(src.includes('Set at this site. Other sites set their own groups.'));
});

test('the report draws from salesMix.js and never works out a percent in its JSX', () => {
  const src = read('./SalesMix.jsx');
  assert.ok(src.includes('BASIS_NOTE'));
  assert.ok(src.includes("from '../../../../supabase/functions/_shared/salesMix.js'"));
  assert.doesNotMatch(src, /\/ 100\b/, 'no percent maths in the report');
  assert.doesNotMatch(src, /\* 100\b/, 'no percent maths in the report');
  assert.ok(src.includes('<SalesMixSetup'));
  assert.ok(src.includes('sessionStorage'), 'the auto opened panel is remembered for the session');
  for (const words of ['Set up groups', 'Export groups', 'Export by category', 'Show categories', 'Hide categories', 'By service period', 'By time of day', 'Item sales by site', 'Share by site']) {
    assert.ok(src.includes(words), words);
  }
});

test('plain words: no long dashes and no N/A in the new files', () => {
  for (const f of ['./SalesMix.jsx', './SalesMixChart.jsx', './SalesMixSetup.jsx', './SalesMixStrip.jsx', './ZReportGroups.jsx', '../../../lib/salesMixView.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /—|–/, `${f} has a long dash`);
    assert.doesNotMatch(src, /\bN\/A\b/, `${f} says N/A`);
  }
});
