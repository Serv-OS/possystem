/**
 * siteIdWiring.test.js: every stock screen works on the site it is handed (v5.11.89, multi site
 * stock Drop 1, map 3.4 and 9.2). Run: npm test.
 *
 * 1. The wiring. Each screen takes `{ siteId = null }`, starts from `siteId || getActiveLocationSync()`,
 *    and EVERY call it makes to a lib/stock function that takes a location passes one. The lib
 *    functions fall back to the signed in venue when handed nothing, so a missing argument would
 *    read or write at the wrong site with the picker on another one (Batches' completePlannedBatch
 *    and Stock reports' fetchBatches did exactly that on v5.11.84). The test reads the lib files to
 *    learn which argument is the location, so a new function or call is checked too.
 *
 * 2. One site companies see today's screens. Node cannot draw JSX here, so the proof is the text:
 *    each screen's Drop 1 edits are listed below with the v5.11.84 text they replaced; putting the
 *    old text back must give main's file byte for byte (sha256), and every edit listed is one that
 *    does nothing for a one site company (siteId is the signed in venue, multi is false, locked is
 *    false, nothing is paused): `x || getActiveLocationSync()` with x the same venue, a `disabled`
 *    that is false (React draws no attribute), a `...(locked ? {} : {})` that adds no style, a
 *    `{cond && <...>}` that draws nothing, the store's own slices from useSiteStockContext.
 *
 * 3. The same, drawn. Main's text (rebuilt by 2) and today's file are compiled here and rendered for
 *    a one site company the way Back Office renders it (StockScopeProvider, StockSiteGate, the
 *    signed in venue): the HTML is main's, byte for byte. The picker, the banner and the gate draw
 *    nothing new for a one site company.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../..');
const readAbs = (p) => fs.readFileSync(p, 'utf8');
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

// ── a tiny scanner: balanced brackets, top level commas ─────────────────────────────────────────
function balanced(src, open) {
  // src[open] is '('; returns the index of the matching ')'
  let depth = 0;
  let q = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '\'' || c === '"' || c === '`') { q = c; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function splitTop(s) {
  const out = [];
  let depth = 0, q = null, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === '\\') { cur += s[++i] || ''; continue; } if (c === q) q = null; continue; }
    if (c === '\'' || c === '"' || c === '`') { q = c; cur += c; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    if (c === ')' || c === '}' || c === ']') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** name -> index of its `locationId` parameter, for every exported function of a lib file. */
function locationParams(file) {
  const src = stripComments(readAbs(file));
  const out = new Map();
  const re = /export\s+(?:const\s+(\w+)\s*=\s*async\s*\(|(?:async\s+)?function\s+(\w+)\s*\()/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1] || m[2];
    const open = m.index + m[0].length - 1;
    const close = balanced(src, open);
    if (close < 0) continue;
    const params = splitTop(src.slice(open + 1, close));
    const idx = params.findIndex((p) => /^locationId\b/.test(p));
    if (idx >= 0) out.set(name, idx);
  }
  return out;
}

const SCREENS = [
  'backoffice/sections/StockCounts.jsx', 'backoffice/sections/StockTransfers.jsx', 'backoffice/sections/StockAreas.jsx',
  'backoffice/sections/Wastage.jsx', 'backoffice/sections/StockReports.jsx', 'backoffice/sections/OrderPad.jsx',
  'backoffice/sections/PurchaseOrders.jsx', 'backoffice/sections/Invoices.jsx', 'backoffice/sections/PriceChanges.jsx',
  'backoffice/sections/Recipes.jsx', 'backoffice/sections/Batches.jsx', 'components/PosWasteModal.jsx',
];

/** Every call a screen makes to a lib/stock function that takes a location: [{ fn, args, idx, line }]. */
function stockCalls(rel) {
  const file = path.join(SRC, rel);
  const raw = readAbs(file);
  const src = stripComments(raw);
  const calls = [];
  const imp = /import\s*\{([^}]*)\}\s*from\s*'([^']*lib\/stock\/[^']+)'/g;
  let m;
  while ((m = imp.exec(src))) {
    let lib = path.resolve(path.dirname(file), m[2]);
    if (!lib.endsWith('.js')) lib += '.js';
    if (!fs.existsSync(lib)) continue;
    const params = locationParams(lib);
    for (const spec of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
      const [orig, local = orig] = spec.split(/\s+as\s+/).map((x) => x.trim());
      if (!params.has(orig)) continue;
      const idx = params.get(orig);
      const call = new RegExp(`(^|[^.\\w])${local}\\(`, 'g');
      let c;
      while ((c = call.exec(src))) {
        const open = c.index + c[0].length - 1;
        if (src.slice(Math.max(0, c.index - 12), c.index + 1).includes('import')) continue;
        const close = balanced(src, open);
        const args = splitTop(src.slice(open + 1, close));
        const line = src.slice(0, open).split('\n').length;
        calls.push({ fn: orig, args, idx, line });
      }
    }
  }
  return calls;
}

test('every stock screen passes the site to every lib/stock call that takes a location', () => {
  let checked = 0;
  for (const rel of SCREENS) {
    const calls = stockCalls(rel);
    assert.ok(calls.length > 0, `${rel}: found its stock calls`);
    for (const c of calls) {
      const arg = c.args[c.idx];
      assert.ok(arg !== undefined && arg !== '' && !/^(null|undefined)$/.test(arg),
        `${rel}:${c.line} ${c.fn}(${c.args.join(', ')}) passes no location (argument ${c.idx + 1})`);
      checked += 1;
    }
  }
  assert.ok(checked > 80, `${checked} calls checked`);
});

test('the scanner catches what v5.11.84 got wrong (it would fail main)', () => {
  // the two calls the map names (8.2 item 5): Batches completed at the signed in venue, and Stock
  // reports' Production tab read the signed in venue's batches
  const lib = locationParams(path.join(SRC, 'lib/stock/production.js'));
  assert.equal(lib.get('completePlannedBatch'), 2);
  assert.equal(lib.get('fetchBatches'), 0);
  assert.equal(lib.get('ensureTodaysPlannedBatches'), 0);
  assert.equal(lib.get('produceBatch'), 1);
  assert.equal(lib.get('previewBatch'), 3);
  const old = splitTop("completing.id, Number(actualIn)");
  assert.equal(old[2], undefined, 'completePlannedBatch(completing.id, Number(actualIn)) has no location');
  assert.equal(splitTop('null, 500')[0], 'null');
  const batches = stockCalls('backoffice/sections/Batches.jsx');
  assert.ok(batches.some((c) => c.fn === 'completePlannedBatch' && c.args[2] === 'loc'));
  const reports = stockCalls('backoffice/sections/StockReports.jsx');
  assert.ok(reports.some((c) => c.fn === 'fetchBatches' && c.args[0] === 'locId || null'));
});

test('each screen takes { siteId = null } and starts from it', () => {
  const starts = {
    'backoffice/sections/StockCounts.jsx': /export default function StockCounts\(\{ orgCtx = null, siteId = null \}\)/,
    'backoffice/sections/StockTransfers.jsx': /export default function StockTransfers\(\{ orgCtx = null, siteId = null \}\)/,
    'backoffice/sections/StockAreas.jsx': /export default function StockAreas\(\{ orgCtx = null, siteId = null \}\)/,
    'backoffice/sections/Wastage.jsx': /export default function Wastage\(\{ siteId = null \} = \{\}\)/,
    'backoffice/sections/StockReports.jsx': /export default function StockReports\(\{ siteId = null \} = \{\}\)/,
    'backoffice/sections/OrderPad.jsx': /export default function OrderPad\(\{ siteId = null \} = \{\}\)/,
    'backoffice/sections/PurchaseOrders.jsx': /export default function PurchaseOrders\(\{ siteId = null \} = \{\}\)/,
    'backoffice/sections/Invoices.jsx': /export default function Invoices\(\{ siteId = null \} = \{\}\)/,
    'backoffice/sections/PriceChanges.jsx': /export default function PriceChanges\(\{ siteId = null \} = \{\}\)/,
    'backoffice/sections/Recipes.jsx': /export default function Recipes\(\{ siteId = null \} = \{\}\)/,
    'backoffice/sections/Batches.jsx': /export default function Batches\(\{ siteId = null \} = \{\}\)/,
  };
  for (const [rel, sig] of Object.entries(starts)) {
    const src = readAbs(path.join(SRC, rel));
    assert.match(src, sig, rel);
    assert.ok(src.includes('useState(siteId || getActiveLocationSync())'), `${rel}: starts from the site`);
    assert.doesNotMatch(src, /useState\(getActiveLocationSync\(\)\)/, `${rel}: no start from the signed in venue alone`);
  }
  const batches = readAbs(path.join(SRC, 'backoffice/sections/Batches.jsx'));
  assert.equal((batches.match(/siteId \|\| getActiveLocationSync\(\)/g) || []).length, 4, 'all three reads and the completion');
  assert.doesNotMatch(batches, /const loc = getActiveLocationSync\(\)/);
  const waste = readAbs(path.join(SRC, 'components/PosWasteModal.jsx'));
  assert.match(waste, /const loc = locationId \|\| getActiveLocationSync\(\) \|\| null;/, 'the site first; the till passes its own venue');
  assert.match(readAbs(path.join(SRC, 'backoffice/sections/Wastage.jsx')), /<PosWasteModal open=\{showProductWaste\}[^\n]*locationId=\{locId\}/);
});

test('the store slice rule: another site\'s menu and tax rates are its own, never the store\'s', () => {
  for (const rel of ['backoffice/sections/Invoices.jsx', 'backoffice/sections/PurchaseOrders.jsx', 'backoffice/sections/Recipes.jsx', 'backoffice/sections/StockReports.jsx', 'components/PosWasteModal.jsx']) {
    const src = stripComments(readAbs(path.join(SRC, rel)));
    assert.match(src, /useSiteStockContext\((siteId|loc)\)/, rel);
    assert.doesNotMatch(src, /useStore\(s => s\.(taxRates|menuItems)\)/, `${rel}: no store slice read directly`);
  }
  const ctx = readAbs(path.join(SRC, 'lib/stock/siteContext.js'));
  assert.match(ctx, /const foreign = isForeignSite\(siteId, getActiveLocationSync\(\)\);/);
  assert.match(ctx, /if \(!foreign\) return \{ menuItems: storeMenu \|\| \[\], taxRates: storeRates \|\| \[\], loading: false, error: null, foreign: false \};/, 'the signed in venue: the store, as today, no read');
  assert.match(ctx, /from\('tax_rates'\)\.select\(TAX_COLS\)\.eq\('location_id', id\)\.order\('id'\)\.limit\(1000\)/);
  assert.match(ctx, /from\('menu_items'\)[\s\S]{0,120}\.eq\('location_id', id\)\.eq\('archived', false\)\.order\('id'\)/);
});

// ── 2. one site companies: the screens are main's text once the inert Drop 1 edits are undone ────
// [file, sha256 of main f1a8f397, [[now, main, times]]]
const LOC = 'useState(siteId || getActiveLocationSync())';
const LOC_MAIN = 'useState(getActiveLocationSync())';
const IDENTITY = [
  ['backoffice/sections/StockTransfers.jsx', [
    ['// v5.11.89 (multi site stock Drop 1): siteId is the picker\'s site (the signed in venue for a one site company).\nexport default function StockTransfers({ orgCtx = null, siteId = null }) {', 'export default function StockTransfers({ orgCtx = null }) {'],
    [LOC, LOC_MAIN],
  ]],
  ['backoffice/sections/StockAreas.jsx', [
    ['// v5.11.89 (multi site stock Drop 1): siteId is the picker\'s site (the signed in venue for a one site company).\nexport default function StockAreas({ orgCtx = null, siteId = null }) {', 'export default function StockAreas({ orgCtx = null }) {'],
    [LOC, LOC_MAIN],
  ]],
  ['backoffice/sections/PriceChanges.jsx', [
    ['// v5.11.89 (multi site stock Drop 1): siteId is the picker\'s site (the signed in venue for a one site company).\nexport default function PriceChanges({ siteId = null } = {}) {', 'export default function PriceChanges() {'],
    [LOC, LOC_MAIN],
  ]],
  ['backoffice/sections/Wastage.jsx', [
    ['// v5.11.89 (multi site stock Drop 1): siteId is the picker\'s site (the signed in venue for a one site company).\nexport default function Wastage({ siteId = null } = {}) {', 'export default function Wastage() {'],
    [LOC, LOC_MAIN],
    // the modal resolved the signed in venue itself; it is handed the same venue now
    [' locationId={locId} showToast={showToast} />', ' showToast={showToast} />'],
  ]],
  ['backoffice/sections/StockCounts.jsx', [
    ['import StockItemPicker from \'../../components/StockItemPicker\';\nimport { useStockScope } from \'../StockScope\';', 'import StockItemPicker from \'../../components/StockItemPicker\';'],
    ['// v5.11.89 (multi site stock Drop 1): siteId is the picker\'s site (always the signed in venue for a\n// one site company); "Start a count" on Stock items opens the new count panel once (takeOpenNew).\nexport default function StockCounts({ orgCtx = null, siteId = null }) {', 'export default function StockCounts({ orgCtx = null }) {'],
    ['  const { takeOpenNew } = useStockScope();\n', ''],
    [LOC, LOC_MAIN],
    // takeOpenNew answers false unless Stock items' "Start a count" asked (never in a one site company)
    ['\n  // "Start a count" from Stock items: the new count panel opens once, on this site.\n  // eslint-disable-next-line react-hooks/exhaustive-deps\n  useEffect(() => { if (takeOpenNew(\'stock-counts\')) setTimeout(() => setStarting(true), 0); }, []);', ''],
  ]],
  ['backoffice/sections/Invoices.jsx', [
    ['\nimport { useSiteStockContext } from \'../../lib/stock/siteContext\';', ''],
    ['// v5.11.89 (multi site stock Drop 1): siteId is the picker\'s site (the signed in venue for a one site\n// company). Another site\'s invoice is worked out on THAT site\'s tax rates (siteContext.js), never the\n// signed in venue\'s: their ids never match and every line would post at 0% VAT.\nexport default function Invoices({ siteId = null } = {}) {', 'export default function Invoices() {'],
    ['  const { taxRates } = useSiteStockContext(siteId);', '  const taxRates = useStore(s => s.taxRates) || [];'],
    [LOC, LOC_MAIN],
    // scanInvoice resolved the signed in venue when handed nothing: the same venue
    ['await scanInvoice(b64, f.type, locId);', 'await scanInvoice(b64, f.type);'],
  ]],
  ['backoffice/sections/PurchaseOrders.jsx', [
    ['\nimport { useSiteStockContext } from \'../../lib/stock/siteContext\';', ''],
    ['// v5.11.89 (multi site stock Drop 1): siteId is the picker\'s site (the signed in venue for a one site\n// company). Another site\'s order is worked out on THAT site\'s tax rates (siteContext.js).\nexport default function PurchaseOrders({ siteId = null } = {}) {', 'export default function PurchaseOrders() {'],
    ['  const { taxRates } = useSiteStockContext(siteId);', '  const taxRates = useStore(s => s.taxRates) || [];'],
    [LOC, LOC_MAIN],
  ]],
  ['backoffice/sections/StockReports.jsx', [
    ['import { getActiveLocationSync, getLocationId } from \'../../lib/supabase\';', 'import { useStore } from \'../../store\';\nimport { getActiveLocationSync, getLocationId } from \'../../lib/supabase\';'],
    ['\nimport { useSiteStockContext } from \'../../lib/stock/siteContext\';', ''],
    ['// v5.11.89 (multi site stock Drop 1): siteId is the picker\'s site (the signed in venue for a one site\n// company). Another site\'s menu and tax rates are that site\'s own (siteContext.js), never the store\'s.\nexport default function StockReports({ siteId = null } = {}) {\n  const { menuItems, taxRates } = useSiteStockContext(siteId);',
      'export default function StockReports() {\n  const menuItems = useStore(s => s.menuItems) || [];\n  const taxRates = useStore(s => s.taxRates) || [];'],
    [LOC, LOC_MAIN],
    [' locId={locId}/>}', '/>}'],
    ['function ProductionReport({ itemName, venueTz, locId = null }) {', 'function ProductionReport({ itemName, venueTz }) {'],
    // the signed in venue is what fetchBatches(null) resolved to
    ['  // v5.11.89: the batches of the screen\'s site (it read the signed in venue whatever the picker said)\n  useEffect(() => {\n    fetchBatches(locId || null, 500).then(({ data }) => setBatches(data || []));\n  }, [locId]);',
      '  useEffect(() => {\n    fetchBatches(null, 500).then(({ data }) => setBatches(data || []));\n  }, []);'],
  ]],
  ['backoffice/sections/Batches.jsx', [
    ['// v5.11.89 (multi site stock Drop 1): siteId is the picker\'s site (always the signed in venue for a one\n// site company). All three reads and every production call name it, so a batch completed with the\n// picker on another site is found and posted THERE (completePlannedBatch read the signed in venue).\nexport default function Batches({ siteId = null } = {}) {', 'export default function Batches() {'],
    ['const loc = siteId || getActiveLocationSync() || await getLocationId().catch(() => null);\n    if (!loc) return;', 'const loc = getActiveLocationSync() || await getLocationId().catch(() => null);\n    if (!loc) return;'],
    ['  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps\n  useEffect(() => { loadQueue(); }, []);', '  // eslint-disable-next-line react-hooks/set-state-in-effect\n  useEffect(() => { loadQueue(); }, []);'],
    // completePlannedBatch resolved the signed in venue when handed nothing: the same venue
    ['    const loc = siteId || getActiveLocationSync() || await getLocationId().catch(() => null);\n    const { error } = await completePlannedBatch(completing.id, Number(actualIn), loc);', '    const { error } = await completePlannedBatch(completing.id, Number(actualIn));'],
    ['      const loc = siteId || getActiveLocationSync() || await getLocationId().catch(() => null);\n      if (!loc || isMock || !supabase) return;', '      const loc = getActiveLocationSync() || await getLocationId().catch(() => null);\n      if (!loc || isMock || !supabase) return;'],
    ['      setNeeded(out);\n    })();\n  }, [siteId]);', '      setNeeded(out);\n    })();\n  }, []);'],
    [LOC, LOC_MAIN],
  ]],
  ['backoffice/sections/OrderPad.jsx', [
    ['\nimport { useStockScope } from \'../StockScope\';\nimport { stockApi } from \'../../lib/stock/stockApi\';\nimport { pausedMap, pauseWords, pausedLineWords } from \'../../lib/stock/pauseRules\';', ''],
    ['// v5.11.89 (multi site stock Drop 1, map 4.3): nothing is paused until the read says so.\nconst NO_PAUSES = new Map();\n\n// v5.11.89: siteId is the picker\'s site (always the signed in venue for a one site company). In a\n// multi site company the pad reads which items are paused at that site today (stock_paused_items):\n// a paused line is grey with its words, never suggested, and Create orders refuses it. One site\n// companies make no extra call and see exactly today\'s pad.\nexport default function OrderPad({ siteId = null } = {}) {', 'export default function OrderPad() {'],
    ['  const { multi, siteName } = useStockScope();\n', ''],
    [LOC, LOC_MAIN],
    ['  const [paused, setPaused] = useState(NO_PAUSES);         // site item id -> { everywhere, until }\n  const [pauseUnknown, setPauseUnknown] = useState(false); // the read failed: orders wait\n', ''],
    // multi is false: no call, paused stays empty
    ['    // v5.11.89 (Drop 1): what is paused at this site today. Multi site companies only (a database\n    // before Drop 1 has no pause, so nothing is paused); a failed read holds the orders back.\n    if (multi && loc) {\n      const pr = await stockApi.pausedItems(loc);\n      setPaused(pr.error ? NO_PAUSES : pausedMap(pr.data?.rows));\n      setPauseUnknown(!!pr.error && !pr.needsUpdate);\n    }\n', ''],
    ['  }, [locId, showToast, multi]);', '  }, [locId, showToast]);'],
    // nothing paused: suggestPacks runs for every line, exactly as before
    ['    // v5.11.89 (Drop 1): an item paused here today is never suggested: nothing is worked out for it.\n    const pz = paused.get(it.id) || null;\n    const sug = pz\n      ? { needBase: 0, suggestedPacks: 0, covered: false, effCover: (Number(coverDays) || 0) + (Number(safetyDays) || 0), hasShape: false }\n      : suggestPacks(', '    const sug = suggestPacks('],
    [', covered: sug.covered, paused: pz };', ', covered: sug.covered };'],
    [', supById, venueTz, paused]);', ', supById, venueTz]);'],
    ['    // v5.11.89 (Drop 1): a line of an item paused here today is refused, naming it.\n    const pausedLines = Object.values(basket).flat().filter(({ r }) => r.paused);\n    if (pausedLines.length) { showToast?.(pausedLines.map(({ r }) => pausedLineWords(r.it.name, r.paused, siteName(locId))).join(\' \'), \'error\'); return; }\n    if (pauseUnknown) { showToast?.(\'Could not check which items are paused here. Reload to try again.\', \'error\'); return; }\n', ''],
    // r.paused is null on every row: the same style, no words, the input enabled
    ['style={r.paused ? { color: \'var(--t4)\' } : { color: \'var(--t1)\' }}', 'style={{ color: \'var(--t1)\' }}'],
    ['{r.paused && <div style={{ fontSize: 11, fontWeight: 600, color: \'var(--amber, #F5A623)\', marginTop: 3 }}>{pauseWords({ siteName: siteName(locId), everywhere: r.paused.everywhere, until: r.paused.until })}</div>}', ''],
    [' disabled={!!r.paused} placeholder="0"', ' placeholder="0"'],
  ]],
  ['backoffice/sections/Recipes.jsx', [
    ['\nimport { useSiteStockContext } from \'../../lib/stock/siteContext\';\nimport { useStockScope } from \'../StockScope\';\nimport LockLine from \'./stock/LockLine\';', ''],
    ['function UnitSelect({ value, onChange, width = 110, disabled = false }) {', 'function UnitSelect({ value, onChange, width = 110 }) {'],
    [' disabled={disabled} style={{ ...field, width, ...(disabled ? { opacity: 0.55 } : {}) }}>', ' style={{ ...field, width }}>'],
    ['// v5.11.89 (multi site stock Drop 1): siteId is the picker\'s site (always the signed in venue for a one\n// site company, which sees exactly today\'s screen). Another site\'s menu and tax rates are its own\n// (siteContext.js), so a recipe is linked to a product that sells THERE. In a multi site company a\n// login without company rights in Produce sees the recipe read only under the lock line: the\n// database refuses those saves from Drop 1 (map 5.1), so no control looks editable.\nexport default function Recipes({ siteId = null } = {}) {', 'export default function Recipes() {'],
    ['  const { menuItems, taxRates } = useSiteStockContext(siteId);\n  const sc = useStockScope();\n  const locked = sc.multi && !sc.canEditCompany(\'produce\');', '  const menuItems = useStore(s => s.menuItems) || [];\n  const taxRates = useStore(s => s.taxRates) || [];'],
    [LOC, LOC_MAIN],
    // locked is false in a one site company: every guard, attribute and style below is inert
    ['    if (locked) return;\n', ''],
    ['if (!draft?.id || locked) return;', 'if (!draft?.id) return;'],
    ['\n        {locked && <div style={{ marginBottom: 14 }}><LockLine entity={draft?.id ? \'recipe\' : null} id={draft?.id || null} recordName={draft?.name || \'\'} /></div>}', ''],
    [' onPick={addLine} disabled={locked} />', ' onPick={addLine} />'],
    [' disabled={locked}', '', 14],
    [', ...(locked ? { opacity: 0.55, cursor: \'default\' } : {})', '', 4],
    ['style={locked ? { ...field, opacity: 0.55 } : field}', 'style={field}', 5],
    [', ...(locked ? { opacity: 0.55 } : {})', '', 3],
    ['disabled={saving || locked}', 'disabled={saving}'],
    ['function AppliesTo({ value, onChange, disabled = false }) {', 'function AppliesTo({ value, onChange }) {'],
    ['onClick={() => { if (!disabled) setOpen(o => !o); }} disabled={disabled} title=', 'onClick={() => setOpen(o => !o)} title='],
    ['function IngredientPicker({ items, onPick, disabled = false }) {', 'function IngredientPicker({ items, onPick }) {'],
    [' disabled={disabled} style={disabled ? { ...field, opacity: 0.55 } : field} />', ' style={field} />'],
  ]],
  ['components/PosWasteModal.jsx', [
    ['\nimport { useSiteStockContext } from \'../lib/stock/siteContext\';', ''],
    ['import { getActiveLocationSync } from \'../lib/supabase\';', 'import { useStore } from \'../store\';\nimport { getActiveLocationSync } from \'../lib/supabase\';'],
    ['// v5.11.89 (multi site stock Drop 1, map 4.18): the site comes first (Back Office Wastage passes the\n// picker\'s site); the till passes its own paired venue, which is also what it resolved before, so\n// nothing changes at the till. A site that is not the signed in venue lists ITS products\n// (siteContext.js), never the store\'s.\n', ''],
    ['  const loc = locationId || getActiveLocationSync() || null;\n  const { menuItems } = useSiteStockContext(loc);', '  const menuItems = useStore(s => s.menuItems) || [];\n  const loc = getActiveLocationSync() || locationId || null;'],
  ]],
];
// sha256 of each file on main (f1a8f397, v5.11.84), the text a one site company runs today.
const MAIN_SHA = {
  'backoffice/sections/StockTransfers.jsx': 'dfacd4310789ca9e2f5f01a5c1ba94e24428f0ab1e394ed275a5089f001bf970',
  'backoffice/sections/StockAreas.jsx': 'f533a7cdf429dc85d9345664d64195724554993c9f1fa79d9653be946329d5c8',
  'backoffice/sections/PriceChanges.jsx': '0f135b551349bb385ae13ec7d3d6ba293ef33810bfa7dc7b3618f19e328bb7e5',
  'backoffice/sections/Wastage.jsx': '33e365b386c8dc5203f683c68cecd20f0761a283758fcc2bda7a8117263ae42d',
  'backoffice/sections/StockCounts.jsx': '44a539c1f9993b6cdf9143ab0b433c0ccbdeec750333125efc922004a96b7ed9',
  'backoffice/sections/Invoices.jsx': 'f18b04a253ad2845fcc2a94e061b12a9b30fda49f32e14824278313ef6a2513f',
  'backoffice/sections/PurchaseOrders.jsx': '5f5aaa8b6610886b3889e4c3e1dfaa9143fca50a3a7da645afaef61739dda6e7',
  'backoffice/sections/StockReports.jsx': '4d5ee256d24e938fa084a879d5f2252fd30b8865f58517f25088c331ea9010fc',
  'backoffice/sections/Batches.jsx': '570b260356a6b6023294116207d11f85cc3514e3b45e9f93425c33825f2731fb',
  'backoffice/sections/OrderPad.jsx': '80255c600c51dde811b5bd2581cff78ad09219ca4d6c2c392203850601c3f9d3',
  'backoffice/sections/Recipes.jsx': '79c0e3ee3e44b1caef5301c204380ecf1a2c1d6436a0a55cbc7b2f37d3cb88cf',
  // v5.11.90: the drainer release changed this modal for every company (dish waste always goes
  // through stock_record_waste, no browser fallback), so the pin is that text, not 5.11.84's.
  'components/PosWasteModal.jsx': '208284d512d5ffe746511c9de13fee17b0524cf6620d6de942cbec7f29eb5e5f',
};

test('one site companies: every edited screen is main\'s text once its inert Drop 1 edits are undone (sha256)', () => {
  for (const [rel, edits] of IDENTITY) {
    let text = readAbs(path.join(SRC, rel));
    for (const [now, main, times = 1] of edits) {
      const n = text.split(now).length - 1;
      assert.equal(n, times, `${rel}: "${now.slice(0, 70)}" is there ${times} time(s), found ${n}`);
      text = text.split(now).join(main);
    }
    assert.equal(sha(text), MAIN_SHA[rel], `${rel}: with the Drop 1 edits undone the file is main's, byte for byte`);
  }
});

// ── 3. the render proof: today's screen and the Drop 1 screen draw the same HTML ─────────────────
// Each screen's main text (rebuilt above, tied to main by its sha256) and today's file are compiled
// here (rolldown, as oneSiteIdentity.test.js does) with the database, the store and the venue clock
// replaced by quiet stand ins, and rendered for a one site company exactly as Back Office renders
// it: inside StockScopeProvider with a one site scope, through StockSiteGate, handed the signed in
// venue. The first render must be main's HTML byte for byte. Effects do not run here; the text proof
// above covers what they do.
import { createRequire, registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const nodeRequire = createRequire(import.meta.url);
let transformSync = null;
try { ({ transformSync } = nodeRequire('rolldown/experimental')); } catch { transformSync = null; }

const SRC_URL = new URL('../../', import.meta.url);
const HOME = 'site-home';
// the store's own slices for the signed in venue (synthetic: the repo is public)
const STORE_STATE = `const STATE = { showToast: () => {}, locationConfig: null,
  menuItems: [{ id: 'm1', name: 'Test Burger', price: 9.5, category: 'Mains', archived: false }],
  taxRates: [{ id: 't1', name: 'VAT 20%', rate: 0.2, type: 'percent', active: true, isDefault: true }] };`;
const STUBBED_RENDER = ['store/index.js', 'lib/supabase.js', 'lib/saveHealth.js', 'lib/db.js', 'lib/xero.js', 'lib/cameraCapture.js'];
const SPECIAL_RENDER = {
  getActiveLocationSync: `() => '${HOME}'`,
  getLocationId: `async () => '${HOME}'`,
  getResolvedLocationIdSync: `() => '${HOME}'`,
  isBackOfficeMode: '() => true',
  isMock: 'false',
  supabase: 'null',
  staffSupabase: 'null',
  platformSupabase: 'null',
  LOCATION_ID: "'loc-demo'",
  useStore: '(sel) => (typeof sel === "function" ? sel(STATE) : STATE)',
};
const exportNamesOf = (text) => {
  const names = new Set();
  for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop().trim(); if (n) names.add(n); }
  return [...names];
};
const stubOf = (file) => `${STORE_STATE}\n${exportNamesOf(readAbs(file)).map((n) => `export const ${n} = ${SPECIAL_RENDER[n] || '(...a) => Promise.resolve({ data: [], error: null })'};`).join('\n')}\nexport default {};\n`;
const MAIN_TEXT = new Map();   // virtual url -> main's text
const inSrcUrl = (u) => typeof u === 'string' && u.startsWith(SRC_URL.href);
const isFileUrl = (u) => { try { return fs.statSync(fileURLToPath(u)).isFile(); } catch { return false; } };
const compileJsx = (url, text) => {
  const t = text.replace(/import\.meta\.env/g, '({})');
  if (!url.split('?')[0].endsWith('.jsx')) return t;
  const out = transformSync(fileURLToPath(url.split('?')[0]), t, { jsx: { runtime: 'automatic' } });
  if (out.errors?.length) throw new Error(`${url}: ${out.errors.map((e) => e.message).join('; ')}`);
  return out.code;
};
if (transformSync) {
  registerHooks({
    resolve(specifier, context, next) {
      const parent = context.parentURL;
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && (inSrcUrl(parent) || MAIN_TEXT.has(parent))) {
        const base = new URL(specifier, parent.split('?')[0]);
        for (const ext of ['', '.js', '.jsx', '/index.js', '/index.jsx']) {
          const u = new URL(base.href + ext);
          if (isFileUrl(u)) return { url: u.href, shortCircuit: true };
        }
      }
      if (MAIN_TEXT.has(specifier)) return { url: specifier, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (MAIN_TEXT.has(url)) return { format: 'module', source: compileJsx(url, MAIN_TEXT.get(url)), shortCircuit: true };
      if (inSrcUrl(url)) {
        const file = fileURLToPath(url.split('?')[0]);
        const rel = url.split('?')[0].slice(SRC_URL.href.length);
        if (STUBBED_RENDER.includes(rel)) return { format: 'module', source: stubOf(file), shortCircuit: true };
        if (/\.(jsx|js)$/.test(file)) return { format: 'module', source: compileJsx(url, readAbs(file)), shortCircuit: true };
      }
      return next(url, context);
    },
  });
}

/** main's text of a screen: today's file with its listed Drop 1 edits undone (the sha256 above pins it). */
function mainTextOf(rel) {
  let text = readAbs(path.join(SRC, rel));
  for (const [now, main] of IDENTITY.find(([r]) => r === rel)[1]) text = text.split(now).join(main);
  assert.equal(sha(text), MAIN_SHA[rel], `${rel}: main's text`);
  return text;
}

const RENDERED = [
  // [file, the props Back Office (or the till) passes on main]
  ['backoffice/sections/StockCounts.jsx', { orgCtx: null }],
  ['backoffice/sections/StockTransfers.jsx', { orgCtx: null }],
  ['backoffice/sections/StockAreas.jsx', { orgCtx: null }],
  ['backoffice/sections/Wastage.jsx', {}],
  ['backoffice/sections/StockReports.jsx', {}],
  ['backoffice/sections/OrderPad.jsx', {}],
  ['backoffice/sections/PurchaseOrders.jsx', {}],
  ['backoffice/sections/Invoices.jsx', {}],
  ['backoffice/sections/PriceChanges.jsx', {}],
  ['backoffice/sections/Recipes.jsx', {}],
  ['backoffice/sections/Batches.jsx', {}],
];

test('rendered: a one site company gets main\'s HTML on every edited screen, through the provider and the gate', { skip: transformSync ? false : 'rolldown is not installed here, so the JSX cannot be compiled (the sha256 proof above still holds)' }, async () => {
  const { StockScopeProvider, StockSiteGate } = await import(new URL('backoffice/StockScope.jsx', SRC_URL).href);
  const { oneSiteScope } = await import(new URL('lib/stock/siteScope.js', SRC_URL).href);
  const html = (el) => renderToStaticMarkup(el);
  const noop = () => {};
  const read = { ...oneSiteScope(HOME, { failed: false }), orgId: 'org-one', sites: [{ id: HOME, name: 'Test Site', status: 'active', currency: 'GBP', kind: 'restaurant' }] };
  const scopes = {
    'read from the database': read,
    'failed to read (today\'s screens)': oneSiteScope(HOME),
    'read, owner of the one site company': { ...read, level: 'all' },
  };
  const access = { role: 'manager', sections: ['inventory', 'produce', 'purchasing'] };
  let screens = 0;
  for (const [rel, props] of RENDERED) {
    const mainUrl = new URL(rel.replace(/([^/]+)\.jsx$/, '__main_$1.jsx'), SRC_URL).href;
    MAIN_TEXT.set(mainUrl, mainTextOf(rel));
    const Main = (await import(mainUrl)).default;
    const Now = (await import(new URL(rel, SRC_URL).href)).default;
    const today = html(createElement(Main, props));
    assert.ok(today.length > 40, `${rel}: today's screen drew something`);
    assert.doesNotMatch(today, /All sites|Your site only|This screen works one site at a time|Set by head office/, `${rel}: no multi site words today`);
    // a screen alone (no provider), as before and with the signed in venue
    assert.equal(html(createElement(Now, props)), today, `${rel}: alone`);
    assert.equal(html(createElement(Now, { ...props, siteId: HOME })), today, `${rel}: alone, handed the signed in venue`);
    for (const [what, scope] of Object.entries(scopes)) {
      const value = { scope, choice: null, setChoice: noop, access, userId: 'user-1', go: noop, reload: noop };
      const shell = createElement(StockScopeProvider, { value },
        createElement(StockSiteGate, { oneSiteId: HOME }, (id) => createElement(Now, { ...props, siteId: id })));
      assert.equal(html(shell), today, `${rel}: as Back Office renders it, scope ${what}`);
    }
    screens += 1;
  }
  assert.equal(screens, 11);
  // the harness draws the live code: a multi site login without company rights in Produce sees the
  // Recipes lock line, which today's screen never had
  const multi = { ...read, multi: true, level: 'sites', editors: ['Test Owner'], sites: [read.sites[0], { id: 'site-two', name: 'Second Site', status: 'active' }] };
  const Recipes = (await import(new URL('backoffice/sections/Recipes.jsx', SRC_URL).href)).default;
  const locked = html(createElement(StockScopeProvider, { value: { scope: multi, choice: { kind: 'site', id: HOME }, setChoice: noop, access, userId: 'user-1', go: noop, reload: noop } },
    createElement(StockSiteGate, { oneSiteId: HOME }, (id) => createElement(Recipes, { siteId: id }))));
  assert.match(locked, /Set by head office\. Ask Test Owner to change it\./);
});

test('rendered: the till\'s waste modal and Back Office Wastage\'s draw main\'s HTML for the signed in venue', { skip: transformSync ? false : 'rolldown is not installed here' }, async () => {
  const rel = 'components/PosWasteModal.jsx';
  const mainUrl = new URL('components/__main_PosWasteModal.jsx', SRC_URL).href;
  MAIN_TEXT.set(mainUrl, mainTextOf(rel));
  const Main = (await import(mainUrl)).default;
  const Now = (await import(new URL(rel, SRC_URL).href)).default;
  for (const props of [
    { open: true, onClose: () => {}, locationId: HOME, showToast: () => {} },   // the till passes its own venue
    { open: true, onClose: () => {}, locationId: null, showToast: () => {} },
    { open: false, onClose: () => {}, locationId: HOME, showToast: () => {} },
  ]) {
    const today = renderToStaticMarkup(createElement(Main, props));
    assert.equal(renderToStaticMarkup(createElement(Now, props)), today, JSON.stringify({ open: props.open, locationId: props.locationId }));
  }
});

test('rendered: the shell pieces draw nothing new for a one site company', { skip: transformSync ? false : 'rolldown is not installed here' }, async () => {
  const { StockScopeProvider, StockSiteGate } = await import(new URL('backoffice/StockScope.jsx', SRC_URL).href);
  const { oneSiteScope } = await import(new URL('lib/stock/siteScope.js', SRC_URL).href);
  const Picker = (await import(new URL('backoffice/components/StockSitePicker.jsx', SRC_URL).href)).default;
  const Banner = (await import(new URL('backoffice/sections/stock/NewSiteBanner.jsx', SRC_URL).href)).default;
  const noop = () => {};
  const wrap = (scope, child) => renderToStaticMarkup(createElement(StockScopeProvider, { value: { scope, choice: null, setChoice: noop, access: { role: 'owner', sections: null }, userId: 'user-1', go: noop, reload: noop } }, child));
  const one = { ...oneSiteScope(HOME, { failed: false }), orgId: 'org-one', level: 'all', multiSince: null };
  for (const scope of [null, oneSiteScope(HOME), one]) {
    assert.equal(wrap(scope, createElement(Picker)), '', 'no picker');
    assert.equal(wrap(scope, createElement(Banner)), '', 'no banner');
  }
  assert.equal(renderToStaticMarkup(createElement(Picker)), '', 'no provider: no picker');
  // the gate: the screen itself for a one site company; the loading line while the scope loads
  const screen = (id) => createElement('main', { 'data-site': id }, 'today');
  assert.equal(wrap(one, createElement(StockSiteGate, { oneSiteId: HOME }, screen)), `<main data-site="${HOME}">today</main>`);
  assert.equal(wrap(oneSiteScope(HOME), createElement(StockSiteGate, { oneSiteId: HOME }, screen)), `<main data-site="${HOME}">today</main>`);
  assert.equal(wrap(null, createElement(StockSiteGate, { oneSiteId: HOME }, screen)), '<div style="padding:26px;color:var(--t3)">Loading…</div>');
  // a multi site company on All sites: PickASite, never the screen
  const multi = { ...one, multi: true, multiSince: '2026-10-01T00:00:00Z', sites: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }] };
  const all = wrap(multi, createElement(StockSiteGate, { oneSiteId: null }, screen));
  assert.match(all, /This screen works one site at a time\./);
  assert.match(all, />Alpha</); assert.match(all, />Beta</);
  assert.doesNotMatch(all, /data-site/);
  const picker = wrap(multi, createElement(Picker));
  assert.match(picker, /All sites \(2\)/);
  assert.match(picker, /<optgroup label="Sites">/);
});

// ── 4. the scope read and the site context, run (they import the browser client, so they load here) ──
test('fetchStockSiteScope: one call; a missing function, an error, junk or no answer in time is the one site scope', { skip: transformSync ? false : 'rolldown is not installed here' }, async () => {
  const { fetchStockSiteScope } = await import(new URL('lib/stock/siteScopeLoad.js', SRC_URL).href);
  const { oneSiteScope } = await import(new URL('lib/stock/siteScope.js', SRC_URL).href);
  const warn = console.warn; console.warn = () => {};
  try {
    const calls = [];
    const answer = (res) => ({ rpc: (fn, args) => { calls.push([fn, args]); return typeof res === 'function' ? res() : Promise.resolve(res); } });
    const good = { org_id: 'org-1', home_site: HOME, open_count: 2, multi_since: null, multi: true, level: 'sites_full', sections: ['inventory'],
      sites: [{ id: HOME, name: 'Test Site', status: 'active' }, { id: 'site-two', name: 'Second Site', status: 'active' }], closed_sites: [], groups: [], kitchens: [], editors: ['Test Owner'] };
    const s = await fetchStockSiteScope(HOME, { client: answer({ data: good, error: null }) });
    assert.deepEqual(calls, [['stock_site_scope', { p_location_id: HOME }]], 'one call, the signed in venue');
    assert.equal(s.multi, true); assert.equal(s.failed, false); assert.equal(s.level, 'sites_full'); assert.equal(s.orgId, 'org-1');
    assert.deepEqual(s.sites.map((x) => x.id), [HOME, 'site-two']);
    const today = oneSiteScope(HOME);
    for (const [what, client] of [
      ['missing function', answer({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.stock_site_scope' } })],
      ['refused', answer({ data: null, error: { code: '42501', message: 'Not allowed' } })],
      ['throws', answer(() => { throw new Error('offline'); })],
      ['rejects', answer(() => Promise.reject(new Error('offline')))],
      ['junk', answer({ data: 'nope', error: null })],
      ['no sites', answer({ data: { multi: true, sites: [] }, error: null })],
    ]) {
      const r = await fetchStockSiteScope(HOME, { client });
      assert.deepEqual(r, today, `${what}: the one site scope, today's screens`);
    }
    const late = await fetchStockSiteScope(HOME, { client: answer(() => new Promise(() => {})), timeoutMs: 20 });
    assert.deepEqual(late, today, 'no answer within the limit: today\'s screens');
    assert.deepEqual(await fetchStockSiteScope(null, { client: answer({ data: good }) }), oneSiteScope(null), 'no venue: nothing to read');
    assert.deepEqual(await fetchStockSiteScope(HOME, { client: {} }), today, 'no client');
  } finally { console.warn = warn; }
});

test('siteContext: only a site that is not the signed in venue is read; the signed in venue keeps the store', { skip: transformSync ? false : 'rolldown is not installed here' }, async () => {
  const { isForeignSite, fetchSiteStockContext } = await import(new URL('lib/stock/siteContext.js', SRC_URL).href);
  assert.equal(isForeignSite('site-two', HOME), true);
  assert.equal(isForeignSite(HOME, HOME), false);
  assert.equal(isForeignSite(null, HOME), false, 'no site named: the store');
  assert.equal(isForeignSite('site-two', null), false, 'no signed in venue known: the store, as today');
  const none = await fetchSiteStockContext(null);
  assert.deepEqual([none.menuItems, none.taxRates], [[], []]);
  assert.ok(none.error, 'no site: says so');
});
