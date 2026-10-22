// src/lib/stock/oneSiteIdentityPurchasing.test.js
//
// Multi site stock Drop 3 (v5.11.96, contract 3.2): a ONE SITE company keeps exactly today's
// Purchasing screens. Four proofs, each against the sha256 of main's file from its first import line
// (contract section 0):
//
//  1. OrderPad.jsx: every multi site line carries the marker comment `// d3 multi`. Remove those
//     lines, put back the changed lines through RESTORE ([newText, oldText], the PR shows each one:
//     the import line, the two delivery rule lines, and at most 6 more) and the sha256 is main's.
//     The one behaviour change for every company is the delivery rule (an order after the cut off is
//     dated for the next delivery); the render below shows nothing else changed.
//  2. purchasing/PurchaseOrdersSite.jsx is main's PurchaseOrders.jsx moved whole: undo the paths, the
//     name, the delivery rule lines and the kitchen order refusal, and the sha256 is main's.
//  3. purchasing/InvoicesSite.jsx and 4. purchasing/PriceChangesSite.jsx: moved whole (paths, name).
//  Then the routers (Loading, then today's screen for a one site company before anything else) and
//  the render proof: main's texts (rebuilt here) and the new files render the same HTML for a one site
//  company (JSX compiled with rolldown, the database and the store replaced by quiet stand ins).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const SRC = new URL('../../', import.meta.url);
const at = (p) => new URL(p, SRC);
const read = (u) => fs.readFileSync(u, 'utf8');
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const count = (text, part) => text.split(part).length - 1;
const fromFirstImport = (text) => { const i = text.search(/^import /m); assert.ok(i >= 0, 'the file has an import line'); return text.slice(i); };

const PAD = at('backoffice/sections/OrderPad.jsx');
const PO_SITE = at('backoffice/sections/purchasing/PurchaseOrdersSite.jsx');
const INV_SITE = at('backoffice/sections/purchasing/InvoicesSite.jsx');
const PC_SITE = at('backoffice/sections/purchasing/PriceChangesSite.jsx');
const PO_ROUTER = at('backoffice/sections/PurchaseOrders.jsx');
const INV_ROUTER = at('backoffice/sections/Invoices.jsx');
const PC_ROUTER = at('backoffice/sections/PriceChanges.jsx');
const PIN = {
  pad: 'd4d5573525e8feac1068245f1be18365e7810c9269c4ce5ed2bdf00426b15559',
  po: 'bd6e0a75e18971b5bb69ce12473e6fde813558cff7dfcf94c29a077caa7cdf2b',
  inv: '74ed21e70f929752d366ab71bece7af706cb4387e2e0986b80776a0333ed1782',
  pc: '6c7310a6184daaf69f06a9667675fe56f1c7f63662e726308b7ec9f34616ce2d',
};

// ── 1. OrderPad ───────────────────────────────────────────────────────────────────────────────────
const MARK = '// d3 multi';
// [newText, oldText]: every changed line of OrderPad.jsx outside the marked lines.
const RESTORE = [
  // the three the contract names: the import line and the two delivery rule lines
  ["import { coverFromRules, nextDelivery, rulesFromDeliveryDays, daysAfter, normDeliveryDays, packContent, packContentInBase, suggestPacks, createOrdersToast, DAY_LABEL } from '../../lib/stock/purchasingRules';",
    "import { coverDaysFromSchedule, nextDeliveryYmd, normDeliveryDays, packContent, packContentInBase, suggestPacks, createOrdersToast, DAY_LABEL } from '../../lib/stock/purchasingRules';"],
  ['    const sched = sp ? coverFromRules({ rules: rulesFromDeliveryDays(supById[sp.supplierId]?.deliveryDays, supById[sp.supplierId]?.cutoffTime), nowVenue: buildScheduleCtx(venueTz), ...multiRules(sp.supplierId) }) : null;',
    '    const sched = sp ? coverDaysFromSchedule(supById[sp.supplierId]?.deliveryDays, todayDow) : null;'],
  ['    Object.keys(basket).forEach(sid => { expectedDateBySupplier[sid] = nextDelivery({ rules: rulesFromDeliveryDays(supById[sid]?.deliveryDays, supById[sid]?.cutoffTime), nowVenue: buildScheduleCtx(venueTz) })?.deliveryYmd || daysAfter(todayYmd, 1)[0]; });',
    '    Object.keys(basket).forEach(sid => { expectedDateBySupplier[sid] = nextDeliveryYmd(supById[sid]?.deliveryDays, todayYmd); });'],
  // the more (at most 6): each only adds a multi site branch that answers today's value on one site
  ['function OrderPadScreen({ siteId = null } = {}) {', 'export default function OrderPad({ siteId = null } = {}) {'],
  ['      : suggestPacks({ onHand, onOrder: oo, avgDaily, profile: prof, todayDow, coverDays, safetyDays, par, perPack: sp ? perPack : null, ...multiSug(it, sp) });',
    '      : suggestPacks({ onHand, onOrder: oo, avgDaily, profile: prof, todayDow, coverDays, safetyDays, par, perPack: sp ? perPack : null });'],
  ['  }); }, [items, usage, weekday, pars, onOrder, days, safetyDays, supplierOverride, supById, venueTz, paused, multiRules, multiSug]);',
    '  }); }, [items, usage, weekday, pars, onOrder, days, safetyDays, supplierOverride, supById, venueTz, paused]);'],
  ["          title={multi ? `Order pad · ${siteName(locId)}` : 'Order pad'}", '          title="Order pad"'],
];

function padMainText(text) {
  const lines = fromFirstImport(text).split('\n').filter((l) => !l.includes(MARK));
  let body = lines.join('\n');
  for (const [now, was] of RESTORE) {
    assert.equal(count(body, `${now}\n`), 1, `the changed line appears once: ${now.slice(0, 80)}`);
    body = body.replace(`${now}\n`, `${was}\n`);
  }
  return body;
}

test('OrderPad: take out the d3 multi lines, put back the RESTORE lines, and the sha256 is main\'s', () => {
  assert.ok(RESTORE.length <= 3 + 6, 'the import line, the two rule lines and at most 6 more');
  assert.equal(sha(padMainText(read(PAD))), PIN.pad);
});

test('OrderPad: every multi site piece is marked; the one site words and calls are today\'s', () => {
  const src = read(PAD);
  const body = fromFirstImport(src);
  const marked = body.split('\n').filter((l) => l.includes(MARK));
  assert.ok(marked.length > 40, 'the multi site pieces are there, each line marked');
  for (const l of marked) assert.doesNotMatch(l, /[\u2013\u2014]/, `no long dash in a new line: ${l.slice(0, 60)}`);
  // nothing unmarked calls a multi only thing
  const unmarked = body.split('\n').filter((l) => !l.includes(MARK)).join('\n');
  for (const name of ['orderPadContext', 'submitOrder', 'OrderPadWhichSite', 'BudgetBar', 'BasketRulesLine', 'SavedListsMenu', 'OrderManySites', 'padScale', 'sendMulti', 'HEADERS_MULTI_OF']) {
    assert.ok(!unmarked.includes(name), `${name} is only on marked lines`);
  }
  // the one site path never calls the database's submit or the order pad context
  assert.match(src, /if \(multi\) return sendMulti\(\); \/\/ d3 multi/);
  assert.match(src, /const multiRules = useCallback\(\(sid\) => \{ const sup = multi \? padSupplierOf\(ctx, sid\) : null;/, 'one site: no rows, so the two columns decide');
  assert.match(src, /const multiSug = useCallback\(\(it, sp\) => \{ if \(!multi \|\| !sp\) return \{\};/, 'one site: suggestPacks gets nothing new');
  assert.match(src, /if \(sc\.multi && !siteId\) return \(<>/, 'only a multi site company sees Which site');
  assert.match(src, /return <OrderPadScreen key=\{siteId \|\| 'home'\} siteId=\{siteId\} \/>; \/\/ d3 multi/);
  assert.doesNotMatch(src, /\bnextDeliveryYmd\(|\bcoverDaysFromSchedule\(/, 'no old rule call');
  assert.doesNotMatch(src, /window\.confirm/);
});

// ── 2 to 4. the moved files ────────────────────────────────────────────────────────────────────────
// Undo the path edits of a file moved one folder deeper (contract 3.2 edit 2).
function undoPaths(text) {
  return text.replace(/from '([^']+)'/g, (m, p) => {
    if (p.startsWith('../../../')) return `from '../../${p.slice('../../../'.length)}'`;
    if (p === '../../StockScope') return "from '../StockScope'";
    if (p.startsWith('../') && !p.startsWith('../../')) return `from './${p.slice(3)}'`;
    return m;
  });
}
function undo(text, edits) {
  let body = fromFirstImport(text);
  for (const e of edits) {
    assert.equal(count(body, e.moved), e.times ?? 1, `${e.moved.trim().slice(0, 80)} appears ${e.times ?? 1} time(s)`);
    body = body.split(e.moved).join(e.was);
  }
  return undoPaths(body);
}
const PO_EDITS = [
  { moved: "    if (await supplierIsInternal(draft.supplierId)) { showToast?.(KITCHEN_RECEIVE_WORDS, 'error'); return; } // Drop 3: a kitchen order is received in Transfers\n", was: '' },
  { moved: ', fnErrorText, supplierIsInternal, KITCHEN_RECEIVE_WORDS } from', was: ', fnErrorText } from' },
  { moved: "import { nextDelivery, rulesFromDeliveryDays } from '../../../lib/stock/purchasingRules';", was: "import { nextDeliveryYmd } from '../../../lib/stock/purchasingRules';" },
  { moved: '(supplierId ? nextDelivery({ rules: rulesFromDeliveryDays(supById[supplierId]?.deliveryDays, supById[supplierId]?.cutoffTime), nowVenue: buildScheduleCtx(venueTz) })?.deliveryYmd || \'\' : \'\')',
    was: '(supplierId ? nextDeliveryYmd(supById[supplierId]?.deliveryDays, buildScheduleCtx(venueTz).ymd) || \'\' : \'\')' },
  { moved: 'export default function PurchaseOrdersSite(', was: 'export default function PurchaseOrders(' },
];
const INV_EDITS = [{ moved: 'export default function InvoicesSite(', was: 'export default function Invoices(' }];
const PC_EDITS = [
  { moved: 'export default function PriceChangesSite(', was: 'export default function PriceChanges(' },
  // Multi site stock Drop 4a (v5.11.98, contract 2.4): "See the report" on the Cost per unit screen renders
  // nothing for a one site company (canOpenReports is false there): undone here, so the text is main's again
  { moved: "import { PageHeader, Tag } from '../reports/reportKit';\n// v5.11.92 (multi site stock Drop 4a, contract 2.4): \"See the report\" opens Reports > Stock and GP > Price paid and price changes.\nimport { useStockScope } from '../../StockScope';\n",
    was: "import { PageHeader, Tag } from '../reports/reportKit';\n" },
  { moved: '  const { openReport, canOpenReports } = useStockScope();\n', was: '' },
  { moved: 'delivery and invoice.">\n        {canOpenReports && locId && (\n          <button type="button" onClick={() => openReport({ report: \'stock_prices\', sites: { kind: \'sites\', ids: [locId] }, period: \'last-week\' })}\n            style={{ background: \'transparent\', border: \'none\', padding: 0, color: \'var(--acc)\', fontSize: 13, fontWeight: 700, cursor: \'pointer\', fontFamily: \'inherit\' }}>See the report</button>\n        )}\n      </PageHeader>',
    was: 'delivery and invoice." />' },
];

test('PurchaseOrdersSite is main\'s PurchaseOrders.jsx moved whole: undo the five edits and the sha256 is main\'s', () => {
  assert.equal(sha(undo(read(PO_SITE), PO_EDITS)), PIN.po);
});
test('InvoicesSite is main\'s Invoices.jsx moved whole', () => { assert.equal(sha(undo(read(INV_SITE), INV_EDITS)), PIN.inv); });
test('PriceChangesSite is main\'s PriceChanges.jsx moved whole', () => { assert.equal(sha(undo(read(PC_SITE), PC_EDITS)), PIN.pc); });

test('the moved files change no other path, and their new top comments have no long dash', () => {
  for (const f of [PO_SITE, INV_SITE, PC_SITE]) {
    const t = read(f);
    const head = t.slice(0, t.search(/^import /m));
    assert.doesNotMatch(head, /[\u2013\u2014]/, `${f.pathname} comment`);
    for (const m of fromFirstImport(t).matchAll(/from '([^']+)'/g)) {
      const p = m[1];
      assert.ok(p === 'react' || p.startsWith('../../../') || p === '../../StockScope' || /^\.\.\/[A-Za-z]/.test(p), `${f.pathname}: ${p}`);
    }
  }
});

test('the three routers: Loading, then today\'s screen for a one site company before anything else', () => {
  for (const [u, name, site, company] of [[PO_ROUTER, 'PurchaseOrders', 'PurchaseOrdersSite', 'OrdersCompany'], [INV_ROUTER, 'Invoices', 'InvoicesSite', 'InvoicesCompany'], [PC_ROUTER, 'PriceChanges', 'PriceChangesSite', 'PriceChangesCompany']]) {
    const src = read(u);
    const body = src.slice(src.indexOf(`export default function ${name}(`));
    assert.deepEqual(body.split('\n').slice(0, 6).map((l) => l.trim()), [
      `export default function ${name}({ orgCtx = null, siteId = null } = {}) {`,
      'const sc = useStockScope();',
      "if (!sc.ready) return <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>;",
      `if (!sc.multi) return <${site} siteId={siteId} />;`,
      `return <${company} orgCtx={orgCtx} />;`,
      '}',
    ], `${name} is exactly the contract's router`);
    assert.match(src, new RegExp(`import ${site} from '\\./purchasing/${site}';`));
    assert.doesNotMatch(src, /[\u2013\u2014]|nextDeliveryYmd|coverDaysFromSchedule/);
  }
});

// ── the render proof ────────────────────────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
let transformSync = null;
try { ({ transformSync } = require('rolldown/experimental')); } catch { transformSync = null; }

const HOME = 'site-home';
const STUBBED = ['store/index.js', 'lib/supabase.js', 'lib/saveHealth.js', 'lib/db.js', 'lib/xero.js', 'lib/cameraCapture.js'];
const STORE_STATE = `const STATE = { showToast: () => {}, locationConfig: null, menuItems: [],
  taxRates: [{ id: 't1', name: 'VAT 20%', rate: 0.2, type: 'percent', active: true, isDefault: true }] };`;
const SPECIAL = {
  getActiveLocationSync: `() => '${HOME}'`, getLocationId: `async () => '${HOME}'`, getResolvedLocationIdSync: `() => '${HOME}'`,
  isBackOfficeMode: '() => true', isMock: 'false', supabase: 'null', staffSupabase: 'null', platformSupabase: 'null', LOCATION_ID: "'loc-demo'",
  useStore: '(sel) => (typeof sel === "function" ? sel(STATE) : STATE)',
};
function exportNames(text) {
  const names = new Set();
  for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop().trim(); if (n) names.add(n); }
  return [...names];
}
function stubSource(path) {
  const body = exportNames(fs.readFileSync(path, 'utf8')).map((n) => `export const ${n} = ${SPECIAL[n] || '(...a) => Promise.resolve({ data: [], error: null })'};`).join('\n');
  return `${STORE_STATE}\n${body}\nexport default {};\n`;
}
const MARKERS = {
  'stub:scope-one': "export const useStockScope = () => ({ ready: true, multi: false, siteName: () => '', sites: [], canEditCompany: () => false, setChoice: () => {} }); export const StockSiteGate = ({ children }) => children(null);",
  'stub:scope-loading': 'export const useStockScope = () => ({ ready: false, multi: false });',
  'stub:scope-multi': "export const useStockScope = () => ({ ready: true, multi: true, siteName: () => 'Site A', sites: [{ id: 'a', name: 'Site A' }, { id: 'k', name: 'Kitchen', kind: 'central_kitchen' }], canEditCompany: () => true, setChoice: () => {} });",
  'stub:company': "export default function Company(p) { return globalThis.__h('company-screen', { 'data-props': JSON.stringify(p) }); }",
};
const VIRTUAL = new Map();
const MAIN_URLS = {
  pad: at('backoffice/sections/__main_OrderPad.jsx').href,
  po: at('backoffice/sections/__main_PurchaseOrders.jsx').href,
  inv: at('backoffice/sections/__main_Invoices.jsx').href,
  pc: at('backoffice/sections/__main_PriceChanges.jsx').href,
};
const inSrc = (url) => typeof url === 'string' && url.startsWith(SRC.href);
const isFile = (u) => { try { return fs.statSync(fileURLToPath(u)).isFile(); } catch { return false; } };
const compile = (url, text) => {
  const t = text.replace(/import\.meta\.env/g, '({})');
  const clean = url.split('?')[0];
  if (!clean.endsWith('.jsx')) return t;
  const out = transformSync(fileURLToPath(clean), t, { jsx: { runtime: 'automatic' } });
  if (out.errors?.length) throw new Error(`${url}: ${out.errors.map((e) => e.message).join('; ')}`);
  return out.code;
};
if (transformSync) {
  registerHooks({
    resolve(specifier, context, next) {
      if (MARKERS[specifier] || VIRTUAL.has(specifier)) return { url: specifier, shortCircuit: true };
      const parent = context.parentURL;
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && (inSrc(parent) || VIRTUAL.has(parent))) {
        const variant = parent.includes('?scope=') ? parent.slice(parent.indexOf('?scope=') + 7) : 'one';
        const base = new URL(specifier, parent.split('?')[0]);
        const rel = base.href.slice(SRC.href.length);
        if (rel === 'backoffice/StockScope') return { url: `stub:scope-${variant}`, shortCircuit: true };
        if (/^backoffice\/sections\/purchasing\/(OrdersCompany|InvoicesCompany|PriceChangesCompany)$/.test(rel)) return { url: 'stub:company', shortCircuit: true };
        for (const ext of ['', '.js', '.jsx', '/index.js', '/index.jsx']) {
          const u = new URL(base.href + ext);
          if (isFile(u)) return { url: variant !== 'one' && u.href.endsWith('.jsx') ? `${u.href}?scope=${variant}` : u.href, shortCircuit: true };
        }
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (MARKERS[url]) return { format: 'module', source: MARKERS[url], shortCircuit: true };
      if (VIRTUAL.has(url)) return { format: 'module', source: compile(url, VIRTUAL.get(url)), shortCircuit: true };
      if (inSrc(url)) {
        const path = fileURLToPath(url.split('?')[0]);
        const rel = url.split('?')[0].slice(SRC.href.length);
        if (STUBBED.includes(rel)) return { format: 'module', source: stubSource(path), shortCircuit: true };
        if (path.endsWith('.jsx') || path.endsWith('.js')) return { format: 'module', source: compile(url, fs.readFileSync(path, 'utf8')), shortCircuit: true };
      }
      return next(url, context);
    },
  });
}
const html = (Comp, props) => renderToStaticMarkup(createElement(Comp, props));
// The committed snapshot of today's first render of the Order pad (synthetic venue, before any data).
const PAD_SNAPSHOT = '<div style="padding:26px;color:var(--t3)">Loading…</div>';

test('rendered: the Order pad, the moved screens and the routers give main\'s HTML for a one site company', { skip: transformSync ? false : 'rolldown is not installed here (the sha256 proofs above still hold)' }, async () => {
  globalThis.__h = createElement;
  VIRTUAL.set(MAIN_URLS.pad, padMainText(read(PAD)));
  VIRTUAL.set(MAIN_URLS.po, undo(read(PO_SITE), PO_EDITS));
  VIRTUAL.set(MAIN_URLS.inv, undo(read(INV_SITE), INV_EDITS));
  VIRTUAL.set(MAIN_URLS.pc, undo(read(PC_SITE), PC_EDITS));
  const MainPad = (await import(MAIN_URLS.pad)).default;
  const Pad = (await import(PAD.href)).default;
  const today = html(MainPad, {});
  assert.equal(today, PAD_SNAPSHOT, 'main\'s first render is the committed snapshot');
  assert.equal(html(Pad, {}), today, 'the new Order pad, no site');
  assert.equal(html(Pad, { siteId: HOME, orgCtx: { userName: 'Test Person' } }), html(MainPad, { siteId: HOME }), 'the new Order pad given the venue');
  for (const [key, siteUrl, routerUrl] of [['po', PO_SITE, PO_ROUTER], ['inv', INV_SITE, INV_ROUTER], ['pc', PC_SITE, PC_ROUTER]]) {
    const Main = (await import(MAIN_URLS[key])).default;
    const Site = (await import(siteUrl.href)).default;
    const Router = (await import(routerUrl.href)).default;
    const want = html(Main, { siteId: HOME });
    assert.equal(html(Site, { siteId: HOME }), want, `${key}: the moved file`);
    assert.equal(html(Router, { orgCtx: null, siteId: HOME }), want, `${key}: the router for a one site company`);
    assert.equal(html(Router, { orgCtx: { userName: 'Test Person' }, siteId: HOME }), want, `${key}: orgCtx changes nothing`);
    const Loading = (await import(`${routerUrl.href}?scope=loading`)).default;
    assert.equal(html(Loading, {}), '<div style="padding:16px;color:var(--t3);font-size:13px">Loading…</div>');
    const Multi = (await import(`${routerUrl.href}?scope=multi`)).default;
    assert.match(html(Multi, { orgCtx: { userName: 'Test Person' } }), /^<company-screen /, `${key}: a multi site company gets the company screen`);
  }
  const PadMulti = (await import(`${PAD.href}?scope=multi`)).default;
  const which = html(PadMulti, { siteId: null, orgCtx: null });
  assert.match(which, /Which site\?/, 'a multi site company on All sites gets the Which site card');
  assert.match(which, /Site A/);
  assert.doesNotMatch(which, /Kitchen/, 'kitchens are left out');
  assert.match(which, /Order for many sites/);
});

// Every new multi site Purchasing screen draws its first frame (before any answer) without throwing.
test('rendered: each new multi site Purchasing screen draws its first frame', { skip: transformSync ? false : 'rolldown is not installed here' }, async () => {
  globalThis.__h = createElement;
  MARKERS['stub:scope-wide'] = "export const useStockScope = () => ({ ready: true, multi: true, isAll: true, orgId: 'org-1', scopeSites: [], groups: [], oneSite: null, sites: [{ id: 'a', name: 'Site A' }, { id: 'b', name: 'Site B' }], siteName: (id) => ({ a: 'Site A', b: 'Site B' })[id] || '', canEditCompany: () => true, setChoice: () => {}, go: () => {}, peekOpen: () => null, takeOpen: () => null });";
  const dir = 'backoffice/sections/purchasing/';
  const order = { id: 'po1', location_id: 'a', site_name: 'Site A', supplier_name: 'Fresh Co', reference: 'PO-1', status: 'SENT', subtotal: 100, delivery_fee: 10, approval: { status: 'waiting', step: 2, can_decide: true, raised_by_name: 'Sam' } };
  const screens = [
    ['DueToOrder.jsx', {}, /Due to order/], ['Forecast.jsx', { siteId: 'a' }, /Forecast/], ['OrdersCompany.jsx', {}, /Orders/],
    ['StockDeliveries.jsx', {}, /Deliveries/], ['InvoicesCompany.jsx', {}, /Invoices/], ['Credits.jsx', {}, /Credits/],
    ['PriceChangesCompany.jsx', {}, /Price changes/], ['Budgets.jsx', {}, /Budgets/], ['OrderManySites.jsx', { onClose: () => {} }, /Order for many sites/],
    ['OrderPadWhichSite.jsx', { sites: [{ id: 'a', name: 'Site A' }], onPick: () => {}, onMany: () => {} }, /Which site\?/],
    ['BudgetBar.jsx', { budget: { budget: 2600, spent: 2140, rule: 'fixed' }, basketTotal: 320 }, /£2,140 spent \+ £320 basket of £2,600/],
    ['BasketRulesLine.jsx', { rules: { words: [{ tone: 'amber', text: 'Minimum order £150: add £22 more' }], approval: { text: 'No approval limit at this site' } } }, /Minimum order £150/],
    ['SavedListsMenu.jsx', { lists: [] }, /Saved lists/],
    ['OrderPadHeaderLine.jsx', { next: { deliveryYmd: '2026-10-22', orderByYmd: '2026-10-21', orderByHm: '14:00', minutesLeft: 200 } }, /Next delivery <b>Thu 22 Oct<\/b> · order by <b>Wed 14:00<\/b> \(in 3 h 20 m\)/],
    ['ForecastDayModal.jsx', { day: '2026-10-22', suggested: 1200 }, /Forecast for Thu 22 Oct/],
    ['InvoiceSplit.jsx', { invoice: { id: 'i1', location_id: 'a', total: 100, invoice_number: '12' } }, /Split by site/],
    ['CreditRequestModal.jsx', {}, /New credit request/], ['CreditNoteModal.jsx', { request: { id: 'r1', location_id: 'a', amount: 20 } }, /Add credit note/],
    ['ReceivePanel.jsx', { po: { po_id: 'po1', location_id: 'a', reference: 'PO-1', supplier_name: 'Fresh Co', site_name: 'Site A' } }, /Receive PO-1/],
    ['OrderDetailPane.jsx', { order }, /Send anyway/],
  ];
  for (const [file, props, want] of screens) {
    const C = (await import(`${at(dir + file).href}?scope=wide`)).default;
    assert.match(html(C, props), want, file);
  }
  const extra = [
    ['backoffice/sections/stock/suppliers/StandingOrdersPanel.jsx', { detail: { supplier: { id: 's1', name: 'Fresh Co' }, sites: [] } }, /Standing orders/],
    ['backoffice/sections/stock/suppliers/DeliveryExceptionsPanel.jsx', { orgId: 'org-1', supplier: { id: 's1', name: 'Fresh Co' } }, /Exceptions and holidays/],
    ['backoffice/sections/stock/items/ParByWeekdayPopover.jsx', { item: { name: 'Milk' }, site: { siteId: 'a', name: 'Site A' } }, /Par by day: Milk/],
  ];
  for (const [file, props, want] of extra) {
    const C = (await import(`${at(file).href}?scope=wide`)).default;
    assert.match(html(C, props), want, file);
  }
});
