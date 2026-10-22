// src/lib/stock/oneSiteIdentityBatches.test.js
//
// Multi site stock Drop 2 (v5.11.91, contract 3.1): a ONE SITE company keeps exactly today's Batches
// screen. produce/BatchesSite.jsx is main 3cde2fbd's src/backoffice/sections/Batches.jsx moved whole.
//
//  1. The text proof: undo the path and name edits on the text from its first import line and the
//     sha256 is main's.
//  2. The router: Loading while the scope loads, then today's screen for a one site company before
//     anything else; the Batch and prep grid on All sites or a group; today's screen inside the
//     site tools on one picked site.
//  3. The render proof: main's text (rebuilt by 1), the moved file and the router are each rendered
//     in node (JSX compiled with rolldown, the database and the store replaced by quiet stand ins)
//     and the HTML must be identical for a one site company.
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
const SITE = at('backoffice/sections/produce/BatchesSite.jsx');
const ROUTER = at('backoffice/sections/Batches.jsx');
// sha256 of main 3cde2fbd's Batches.jsx from its first import line (contract 0)
const PIN = 'f7241232f816a5f93253afeac00334fa366871d69c228f55d298ad5824de7f80';

const count = (text, part) => text.split(part).length - 1;
// The edits the move is allowed to make (contract 3.1 edits 2 and 3, plus the reportKit path the
// contract missed: the file sits one folder deeper, so './reports/reportKit' had to move too).
const EDITS = [
  { moved: 'export default function BatchesSite({ siteId = null } = {}) {', was: 'export default function Batches({ siteId = null } = {}) {', times: 1 },
  { moved: "from '../reports/reportKit'", was: "from './reports/reportKit'", times: 1 },
  { moved: "from '../../../", was: "from '../../", times: 9 },
];
const fromFirstImport = (text) => { const i = text.search(/^import /m); assert.ok(i >= 0, 'the file has an import line'); return text.slice(i); };

/** Main's Batches.jsx from its first import line, rebuilt from the moved file. */
function mainText(moved) {
  let body = fromFirstImport(moved);
  for (const e of EDITS) {
    assert.equal(count(body, e.moved), e.times, `${e.moved.slice(0, 70)} appears ${e.times} time(s)`);
    body = body.split(e.moved).join(e.was);
  }
  return body;
}

test('BatchesSite is main\'s Batches.jsx moved whole: undo the edits and the sha256 matches', () => {
  const moved = fs.readFileSync(SITE, 'utf8');
  const body = fromFirstImport(moved);
  assert.equal(count(body, "'../../../"), count(body, "from '../../../"), 'no other path changed');
  const sha = crypto.createHash('sha256').update(mainText(moved)).digest('hex');
  assert.equal(sha, PIN, 'everything after the first import line is main\'s text byte for byte');
});

test('the moved file imports nothing new and keeps every one site read, word and production call', () => {
  const moved = fs.readFileSync(SITE, 'utf8');
  const head = moved.slice(0, moved.search(/^import /m));
  assert.doesNotMatch(head, /[\u2013\u2014]/, 'the rewritten top comment has no long dash');
  const imports = [...moved.matchAll(/^(?:import [^;]*?from|\} from) '([^']+)';$/gm)].map((m) => m[1]);
  assert.equal(imports.length, 11, 'react, nine lib paths and reportKit');
  for (const p of imports) assert.ok(p === 'react' || p.startsWith('../../../') || p === '../reports/reportKit', p);
  for (const words of ['useState(siteId || getActiveLocationSync())', 'completePlannedBatch(completing.id, Number(actualIn), loc)', 'ensureTodaysPlannedBatches(loc)',
    'fetchBatches(loc, 300)', 'fetchUsageByWeekday(8, loc)']) {
    assert.ok(moved.includes(words), words);
  }
  assert.equal(count(moved, 'siteId || getActiveLocationSync()'), 4, 'all three reads and the completion start from the site');
  assert.doesNotMatch(moved.slice(head.length), /useStockScope|StockScope|stockApi|BatchHowGrid|BatchSiteTools|PrepList|Bought in|Made to order|Prep list/, 'no company screen pieces in the one site screen');
});

test('the router: Loading, then today\'s screen for a one site company, the grid on All sites, the site tools on one site', () => {
  const src = fs.readFileSync(ROUTER, 'utf8');
  assert.match(src, /export default function Batches\(\{ orgCtx = null, siteId = null \} = \{\}\) \{/);
  const body = src.slice(src.indexOf('export default function Batches('));
  const lines = body.split('\n').slice(1, 6).map((l) => l.trim());
  assert.deepEqual(lines, [
    'const sc = useStockScope();',
    "if (!sc.ready) return <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>;",
    'if (!sc.multi) return <BatchesSite siteId={siteId} />;',
    'if (!sc.oneSite) return <BatchHowGrid orgCtx={orgCtx} />;',
    'return <BatchSiteTools siteId={sc.oneSite.id} orgCtx={orgCtx}><BatchesSite key={sc.oneSite.id} siteId={sc.oneSite.id} /></BatchSiteTools>;',
  ], 'exactly the contract\'s router, nothing before the one site branch');
  assert.match(src, /import BatchesSite from '\.\/produce\/BatchesSite';/);
  assert.equal(count(body, 'return '), 4, 'four answers: loading, one site, the grid, the site tools');
  assert.doesNotMatch(src.slice(src.search(/^import /m)), /StockSiteGate|useState|useEffect/, 'no gate and no state: the scope decides');
  assert.doesNotMatch(src, /[\u2013\u2014]/, 'the router has no long dash');
  assert.doesNotMatch(src, /window\.confirm/);
});

// ── the render proof ──────────────────────────────────────────────────────────

const require = createRequire(import.meta.url);
let transformSync = null;
try { ({ transformSync } = require('rolldown/experimental')); } catch { transformSync = null; }

const HOME = 'site-home';
const STUBBED = ['store/index.js', 'lib/supabase.js', 'lib/saveHealth.js', 'lib/db.js', 'lib/xero.js', 'lib/cameraCapture.js'];
const STORE_STATE = `const STATE = { showToast: () => {}, locationConfig: null,
  menuItems: [{ id: 'm1', name: 'Test Burger', price: 9.5, category: 'Mains', archived: false }],
  taxRates: [{ id: 't1', name: 'VAT 20%', rate: 0.2, type: 'percent', active: true, isDefault: true }] };`;
const SPECIAL = {
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
  'stub:how-grid': "export default function BatchHowGrid(p) { return globalThis.__h('batch-how-grid', { 'data-props': JSON.stringify(p) }); }",
  'stub:site-tools': "export default function BatchSiteTools(p) { return globalThis.__h('batch-site-tools', { 'data-site': p.siteId }, p.children); }",
  'stub:scope-one': 'export const useStockScope = () => ({ ready: true, multi: false, oneSite: { id: "site-home" } });',
  'stub:scope-loading': 'export const useStockScope = () => ({ ready: false, multi: false, oneSite: null });',
  'stub:scope-multi': 'export const useStockScope = () => ({ ready: true, multi: true, oneSite: null });',
  'stub:scope-multi-site': 'export const useStockScope = () => ({ ready: true, multi: true, oneSite: { id: "site-two", name: "Second Site" } });',
};
const VIRTUAL = new Map();
const MAIN_URL = at('backoffice/sections/__main_Batches.jsx').href;

const inSrc = (url) => typeof url === 'string' && url.startsWith(SRC.href);
const isFile = (u) => { try { return fs.statSync(fileURLToPath(u)).isFile(); } catch { return false; } };
const compile = (url, text) => {
  const t = text.replace(/import\.meta\.env/g, '({})');
  if (!url.split('?')[0].endsWith('.jsx')) return t;
  const out = transformSync(fileURLToPath(url.split('?')[0]), t, { jsx: { runtime: 'automatic' } });
  if (out.errors?.length) throw new Error(`${url}: ${out.errors.map((e) => e.message).join('; ')}`);
  return out.code;
};

if (transformSync) {
  registerHooks({
    resolve(specifier, context, next) {
      if (MARKERS[specifier] || VIRTUAL.has(specifier)) return { url: specifier, shortCircuit: true };
      const parent = context.parentURL;
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && (inSrc(parent) || VIRTUAL.has(parent))) {
        const variant = parent.includes('?scope=') ? parent.slice(parent.indexOf('?scope=') + 7) : null;
        const base = new URL(specifier, parent.split('?')[0]);
        const rel = base.href.slice(SRC.href.length);
        if (variant && rel === 'backoffice/StockScope') return { url: `stub:scope-${variant}`, shortCircuit: true };
        if (rel === 'backoffice/sections/produce/BatchHowGrid') return { url: 'stub:how-grid', shortCircuit: true };
        if (rel === 'backoffice/sections/produce/BatchSiteTools') return { url: 'stub:site-tools', shortCircuit: true };
        for (const ext of ['', '.js', '.jsx', '/index.js', '/index.jsx']) {
          const u = new URL(base.href + ext);
          if (isFile(u)) return { url: u.href, shortCircuit: true };
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

test('rendered: the moved screen, and the router for a one site company, give main\'s HTML exactly', { skip: transformSync ? false : 'rolldown is not installed here, so the JSX cannot be compiled (the sha256 proof above still holds)' }, async () => {
  globalThis.__h = createElement;
  VIRTUAL.set(MAIN_URL, mainText(fs.readFileSync(SITE, 'utf8')));
  const Main = (await import(MAIN_URL)).default;
  const Site = (await import(SITE.href)).default;
  const today = html(Main, {});
  assert.match(today, /Batches/, 'today\'s screen rendered');
  assert.doesNotMatch(today, /All sites|Bought in|Made to order|Prep list|Print labels|Batch and prep/, 'no multi site words on today\'s screen');

  assert.equal(html(Site, {}), today, 'the moved file, no siteId');
  assert.equal(html(Site, { siteId: HOME }), today, 'the moved file given the signed in venue (what the router passes a one site company)');

  const RouterOne = (await import(`${ROUTER.href}?scope=one`)).default;
  assert.equal(html(RouterOne, { orgCtx: null, siteId: HOME }), today, 'the router hands a one site company today\'s screen, nothing around it');
  assert.equal(html(RouterOne, { orgCtx: null, siteId: null }), today);
  assert.equal(html(RouterOne, { orgCtx: { userName: 'Test Person' }, siteId: HOME }), today, 'orgCtx changes nothing for a one site company');

  const RouterLoading = (await import(`${ROUTER.href}?scope=loading`)).default;
  assert.equal(html(RouterLoading, { orgCtx: null }), '<div style="padding:16px;color:var(--t3);font-size:13px">Loading…</div>');

  const RouterMulti = (await import(`${ROUTER.href}?scope=multi`)).default;
  const grid = html(RouterMulti, { orgCtx: { userName: 'Test Person' }, siteId: null });
  assert.match(grid, /^<batch-how-grid /, 'All sites or a group: the Batch and prep grid');
  assert.match(grid, /Test Person/, 'with the login handed down');

  const RouterSite = (await import(`${ROUTER.href}?scope=multi-site`)).default;
  const one = html(RouterSite, { orgCtx: null, siteId: 'site-two' });
  assert.match(one, /^<batch-site-tools data-site="site-two">/, 'one site picked: the site tools around today\'s screen, on that site');
  assert.equal(one.slice('<batch-site-tools data-site="site-two">'.length, -'</batch-site-tools>'.length), today, 'today\'s screen inside, byte for byte');
});

test('rendered: with no scope provider (a screen alone) the router still shows today\'s screen', { skip: transformSync ? false : 'rolldown is not installed here' }, async (t) => {
  if (!isFile(at('backoffice/StockScope.jsx'))) { t.skip('StockScope.jsx is not in this tree yet'); return; }
  globalThis.__h = createElement;
  VIRTUAL.set(MAIN_URL, mainText(fs.readFileSync(SITE, 'utf8')));
  let Router;
  try { Router = (await import(ROUTER.href)).default; } catch (e) { t.skip(`the real StockScope did not load in node: ${e.message}`); return; }
  const Main = (await import(MAIN_URL)).default;
  assert.equal(html(Router, { orgCtx: null, siteId: null }), html(Main, {}));
});
