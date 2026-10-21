// Multi site stock Drop 1: a ONE SITE company sees exactly today's Stock items screen (Rule 2; Wing
// Fest Birmingham is the check).
//
//  1. The text proof (contract 3.2): stock/items/StockItemsSplit.jsx is today's StockItems.jsx
//     (main f1a8f397) moved whole. Undo the three allowed edits on the text from its first import
//     line and the sha256 is main's.
//  2. The render proof: today's file (rebuilt from the moved one by undoing the edits, which the
//     hash ties to main byte for byte), the moved file and the new router are each rendered in node
//     (the JSX compiled here with rolldown, the database and the store replaced by quiet stand ins)
//     and the HTML must be identical for a one site company: no picker, no Sites column, no new
//     words.
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
const SPLIT = at('backoffice/sections/stock/items/StockItemsSplit.jsx');
const ROUTER = at('backoffice/sections/StockItems.jsx');
const PIN = 'fb015f29d5043ff7851f24a7a89309cc19719859a84ed4aef9303ffcb48f85cd';

const EDIT_PATH = ["from '../../../../", "from '../../"];
const EDIT_SIG = ['export default function StockItemsSplit({ orgCtx = null, siteId = null })', 'export default function StockItems({ orgCtx = null })'];
const EDIT_LOC = ['useState(siteId || getActiveLocationSync())', 'useState(getActiveLocationSync())'];
const count = (text, part) => text.split(part).length - 1;

/** Today's StockItems.jsx from its first import line, rebuilt from the moved file. */
function mainText(moved) {
  const body = moved.slice(moved.search(/^import /m));
  return body.split(EDIT_PATH[0]).join(EDIT_PATH[1]).replace(EDIT_SIG[0], EDIT_SIG[1]).replace(EDIT_LOC[0], EDIT_LOC[1]);
}

test('StockItemsSplit is main\'s StockItems.jsx moved whole: undo the three edits and the sha256 matches', () => {
  const moved = fs.readFileSync(SPLIT, 'utf8');
  const body = moved.slice(moved.search(/^import /m));
  assert.equal(count(body, EDIT_SIG[0]), 1, 'edit 3: the name and the siteId prop, once');
  assert.equal(count(body, EDIT_LOC[0]), 1, 'edit 4: start from siteId, once');
  assert.equal(count(body, EDIT_PATH[0]), 15, 'edit 2: the 15 import paths, one folder deeper');
  assert.equal(count(body, "'../../../../"), count(body, EDIT_PATH[0]), 'no other path changed');
  const sha = crypto.createHash('sha256').update(mainText(moved)).digest('hex');
  assert.equal(sha, PIN, 'everything after the first import line is main\'s text byte for byte');
});

test('the moved file imports nothing new: no picker, no stock API, no company screens', () => {
  const moved = fs.readFileSync(SPLIT, 'utf8');
  const head = moved.slice(0, moved.search(/^import /m));
  assert.doesNotMatch(head, /[\u2013\u2014]/, 'the rewritten top comment has no long dash');
  const imports = [...moved.matchAll(/^(?:import [^;]*?from|\} from) '([^']+)';$/gm)].map((m) => m[1]);
  assert.equal(imports.length, 16);
  for (const p of imports) assert.ok(p === 'react' || p.startsWith('../../../../'), p);
  assert.doesNotMatch(moved.slice(head.length), /StockScope|stockApi|itemListRules|siteScope|CompanyItemList|ItemPage/);
});

test('the router: Loading while the scope loads, then today\'s screen for a one site company before anything else', () => {
  const src = fs.readFileSync(ROUTER, 'utf8');
  assert.match(src, /export default function StockItems\(\{ orgCtx = null, siteId = null \}\) \{/);
  const body = src.slice(src.indexOf('export default function StockItems('));
  const lines = body.split('\n').slice(1, 5).map((l) => l.trim());
  assert.deepEqual(lines, [
    'const sc = useStockScope();',
    'const [open, setOpen] = useState(null); // { itemId, tab, siteId }',
    "if (!sc.ready) return <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>;",
    'if (!sc.multi) return <StockItemsSplit orgCtx={orgCtx} siteId={siteId} />;',
  ], 'no other hook or render runs before the one site branch');
  assert.match(src, /if \(open\) return <ItemPage itemId=\{open\.itemId\} startTab=\{open\.tab \|\| 'sites'\} focusSiteId=\{open\.siteId \|\| null\} orgCtx=\{orgCtx\} onBack=\{\(\) => setOpen\(null\)\} onOpenItem=\{\(itemId, opts = \{\}\) => setOpen\(\{ itemId, \.\.\.opts \}\)\} \/>;/);
  assert.match(src, /return <CompanyItemList orgCtx=\{orgCtx\} onOpen=\{\(itemId, opts = \{\}\) => setOpen\(\{ itemId, \.\.\.opts \}\)\} \/>;/);
  assert.match(src, /import StockItemsSplit from '\.\/stock\/items\/StockItemsSplit';/);
});

// ── the render proof ──────────────────────────────────────────────────────────

const require = createRequire(import.meta.url);
let transformSync = null;
try { ({ transformSync } = require('rolldown/experimental')); } catch { transformSync = null; }

// The modules that talk to the database, the store or the clock are replaced: every export a quiet
// stand in, so nothing is fetched and the first render is the same every time.
const STUBBED = ['store/index.js', 'lib/supabase.js', 'lib/locationTime.js', 'lib/saveHealth.js', 'lib/stock/data.js', 'lib/stock/counts.js', 'lib/stock/areas.js', 'lib/stock/recipes.js'];
const SPECIAL = {
  getActiveLocationSync: "() => 'site-home'",
  getLocationId: "async () => 'site-home'",
  useStore: '(sel) => (typeof sel === "function" ? sel(STATE) : STATE)',
};
function exportNames(text) {
  const names = new Set();
  for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop().trim(); if (n) names.add(n); }
  return [...names];
}
function stubSource(path) {
  const names = exportNames(fs.readFileSync(path, 'utf8'));
  const body = names.map((n) => `export const ${n} = ${SPECIAL[n] || '(...a) => Promise.resolve({ data: [], error: null })'};`).join('\n');
  return `const STATE = { showToast: () => {}, taxRates: [], menuItems: [], locationConfig: null };\n${body}\n`;
}
const MARKERS = {
  'stub:company-list': "export default function CompanyItemList(p) { return globalThis.__h('company-list', { 'data-props': JSON.stringify(p) }); }",
  'stub:item-page': "export default function ItemPage(p) { return globalThis.__h('item-page', { 'data-props': JSON.stringify(p) }); }",
  'stub:scope-one': 'export const useStockScope = () => ({ ready: true, multi: false });',
  'stub:scope-loading': 'export const useStockScope = () => ({ ready: false, multi: false });',
  'stub:scope-multi': 'export const useStockScope = () => ({ ready: true, multi: true });',
};
const VIRTUAL = new Map();
const MAIN_URL = at('backoffice/sections/__main_StockItems.jsx').href;

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
        if (rel === 'backoffice/sections/stock/items/CompanyItemList') return { url: 'stub:company-list', shortCircuit: true };
        if (rel === 'backoffice/sections/stock/items/ItemPage') return { url: 'stub:item-page', shortCircuit: true };
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
  VIRTUAL.set(MAIN_URL, mainText(fs.readFileSync(SPLIT, 'utf8')));
  const Main = (await import(MAIN_URL)).default;
  const Split = (await import(SPLIT.href)).default;
  const today = html(Main, { orgCtx: null });
  assert.match(today, /Search stock items/, 'today\'s screen rendered (the list and its search box)');
  assert.match(today, /Select a stock item, or press \+ to add one\./);
  assert.doesNotMatch(today, /Sites|All sites|company list|Stock control/, 'no multi site words on today\'s screen');

  assert.equal(html(Split, { orgCtx: null }), today, 'the moved file, no siteId');
  assert.equal(html(Split, { orgCtx: null, siteId: 'site-home' }), today, 'the moved file given the signed in venue (what Back Office passes a one site company)');
  assert.equal(html(Split, { orgCtx: { userName: 'Test Person' } }), html(Main, { orgCtx: { userName: 'Test Person' } }));

  const RouterOne = (await import(`${ROUTER.href}?scope=one`)).default;
  assert.equal(html(RouterOne, { orgCtx: null, siteId: 'site-home' }), today, 'the router hands a one site company today\'s screen, nothing around it');
  assert.equal(html(RouterOne, { orgCtx: null, siteId: null }), today);

  const RouterLoading = (await import(`${ROUTER.href}?scope=loading`)).default;
  assert.equal(html(RouterLoading, { orgCtx: null }), '<div style="padding:16px;color:var(--t3);font-size:13px">Loading…</div>');

  const RouterMulti = (await import(`${ROUTER.href}?scope=multi`)).default;
  const multi = html(RouterMulti, { orgCtx: null, siteId: null });
  assert.match(multi, /^<company-list /, 'a multi site company gets the company list instead');
  assert.doesNotMatch(multi, /Search stock items/);
});

test('rendered: with no scope provider (a screen alone) the router still shows today\'s screen', { skip: transformSync ? false : 'rolldown is not installed here' }, async (t) => {
  if (!isFile(at('backoffice/StockScope.jsx'))) { t.skip('StockScope.jsx is not in this tree yet'); return; }
  globalThis.__h = createElement;
  VIRTUAL.set(MAIN_URL, mainText(fs.readFileSync(SPLIT, 'utf8')));
  let Router;
  try { Router = (await import(ROUTER.href)).default; } catch (e) { t.skip(`the real StockScope did not load in node: ${e.message}`); return; }
  const Main = (await import(MAIN_URL)).default;
  assert.equal(html(Router, { orgCtx: null, siteId: null }), html(Main, { orgCtx: null }));
});
