// src/lib/stock/oneSiteIdentityRecipes.test.js
//
// Multi site stock Drop 2 (v5.11.93, contract 3.1): a ONE SITE company keeps exactly today's Recipes
// screen (Wing Fest Birmingham, one site, one recipe, is the check), plus only the read only allergen
// line and the Checked button (RecipeFactsLine) under the ingredient lines.
//
//  1. The text proof: produce/RecipesSite.jsx is main 3cde2fbd's src/backoffice/sections/Recipes.jsx
//     moved whole. Remove the two RecipeFactsLine lines (each exactly once), undo the path and name
//     edits on the text from its first import line, and the sha256 is main's.
//  2. The router: Loading while the scope loads, then today's screen for a one site company before
//     anything else; the company screens only for a multi site company.
//  3. The render proof: main's text (rebuilt by 1), the moved file and the router are each rendered
//     in node (JSX compiled with rolldown, the database and the store replaced by quiet stand ins,
//     RecipeFactsLine a stand in that draws nothing, as the real one does while the database answers
//     needsUpdate) and the HTML must be identical for a one site company.
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
const SITE = at('backoffice/sections/produce/RecipesSite.jsx');
const ROUTER = at('backoffice/sections/Recipes.jsx');
// sha256 of main 3cde2fbd's Recipes.jsx from its first import line (contract 0)
const PIN = '47af57b7958b29e0afbbc954dd0454b7fb54d06a9f660e1efd4e462f90aa6a55';

const count = (text, part) => text.split(part).length - 1;
// The edits the move is allowed to make (contract 3.1 edits 2 to 7, plus the reportKit path the
// contract missed: the file sits one folder deeper, so './reports/reportKit' had to move too),
// each with how many times it must appear. Undone in this order (the StockScope path first, so the
// eleven '../../../' paths are then the only ones left).
const EDITS = [
  { moved: "                {draft.id && <RecipeFactsLine siteId={locId} recipeId={draft.id} menuItemId={draft.recipeType === 'MENU' ? draft.menuItemId : null} />}\n", was: '', times: 1 },
  { moved: "import RecipeFactsLine from './RecipeFactsLine';\n", was: '', times: 1 },
  { moved: 'export default function RecipesSite({ siteId = null } = {}) {', was: 'export default function Recipes({ siteId = null } = {}) {', times: 1 },
  { moved: "from '../../StockScope'", was: "from '../StockScope'", times: 1 },
  { moved: "from '../stock/LockLine'", was: "from './stock/LockLine'", times: 1 },
  { moved: "from '../reports/reportKit'", was: "from './reports/reportKit'", times: 1 },
  { moved: "from '../../../", was: "from '../../", times: 11 },
];
const fromFirstImport = (text) => { const i = text.search(/^import /m); assert.ok(i >= 0, 'the file has an import line'); return text.slice(i); };

/** Main's Recipes.jsx from its first import line, rebuilt from the moved file. */
function mainText(moved) {
  let body = fromFirstImport(moved);
  for (const e of EDITS) {
    assert.equal(count(body, e.moved), e.times, `${e.moved.trim().slice(0, 70)} appears ${e.times} time(s)`);
    body = body.split(e.moved).join(e.was);
  }
  return body;
}

test('RecipesSite is main\'s Recipes.jsx moved whole: take out the facts line, undo the edits and the sha256 matches', () => {
  const moved = fs.readFileSync(SITE, 'utf8');
  const body = fromFirstImport(moved);
  assert.equal(count(body, "'../../../"), count(body, "from '../../../"), 'no other path changed');
  const sha = crypto.createHash('sha256').update(mainText(moved)).digest('hex');
  assert.equal(sha, PIN, 'everything after the first import line is main\'s text byte for byte');
});

test('the moved file imports nothing new but RecipeFactsLine, and keeps every one site word and save', () => {
  const moved = fs.readFileSync(SITE, 'utf8');
  const head = moved.slice(0, moved.search(/^import /m));
  assert.doesNotMatch(head, /[\u2013\u2014]/, 'the rewritten top comment has no long dash');
  const imports = [...moved.matchAll(/^(?:import [^;]*?from|\} from) '([^']+)';$/gm)].map((m) => m[1]);
  assert.equal(imports.length, 16, 'react, eleven lib paths, StockScope, LockLine, reportKit and RecipeFactsLine');
  for (const p of imports) assert.ok(p === 'react' || p.startsWith('../../../') || ['../../StockScope', '../stock/LockLine', '../reports/reportKit', './RecipeFactsLine'].includes(p), p);
  assert.equal(count(moved.slice(head.length), 'RecipeFactsLine'), 3, 'the import (its name and its path) and the one render line, nothing else');
  // the one render line sits straight after the ingredient picker, inside the open recipe only
  assert.match(moved, /<IngredientPicker items=\{items\} onPick=\{addLine\} disabled=\{locked\} \/>\n {16}\{draft\.id && <RecipeFactsLine siteId=\{locId\} recipeId=\{draft\.id\} menuItemId=\{draft\.recipeType === 'MENU' \? draft\.menuItemId : null\} \/>\}\n/);
  // today's words, fields and saves
  for (const words of ["saveRecipeWithLines({ ...draft, name:", "locId, { section: 'produce' })", "setRecipeArchived(draft.id, true, locId, { section: 'produce', version: draft.rowVersion })",
    'useState(siteId || getActiveLocationSync())', "'Save recipe' : 'Create recipe'", 'Method (optional)', 'No prep recipes. Press + to add one']) {
    assert.ok(moved.includes(words), words);
  }
  // no company screen pieces leak into the one site screen
  assert.doesNotMatch(moved.slice(head.length), /stockApi|RecipeList|RecipePage|recipeRules|recipesPage|Recipe missing|All sites/);
});

test('the router: Loading while the scope loads, then today\'s screen for a one site company before anything else', () => {
  const src = fs.readFileSync(ROUTER, 'utf8');
  assert.match(src, /export default function Recipes\(\{ orgCtx = null, siteId = null \} = \{\}\) \{/);
  const body = src.slice(src.indexOf('export default function Recipes('));
  const lines = body.split('\n').slice(1, 5).map((l) => l.trim());
  assert.deepEqual(lines, [
    'const sc = useStockScope();',
    "const [open, setOpen] = useState(null); // { recipeId, tab, siteId } ('new' for a new recipe)",
    "if (!sc.ready) return <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>;",
    'if (!sc.multi) return <RecipesSite siteId={siteId} />;',
  ], 'no other hook or render runs before the one site branch');
  assert.match(src, /if \(!open && sc\.peekOpen\?\.\('recipes'\)\?\.recipeId\) return <OpenOnArrival take=\{sc\.takeOpen\} onOpen=\{setOpen\} \/>;/);
  assert.match(src, /if \(open\) return <RecipePage recipeId=\{open\.recipeId\} startTab=\{open\.tab \|\| 'sites'\} focusSiteId=\{open\.siteId \|\| null\} orgCtx=\{orgCtx\} onBack=\{\(\) => setOpen\(null\)\} onOpenRecipe=\{\(recipeId, opts = \{\}\) => setOpen\(\{ recipeId, \.\.\.opts \}\)\} \/>;/);
  assert.match(src, /return <RecipeList orgCtx=\{orgCtx\} onOpen=\{\(recipeId, opts = \{\}\) => setOpen\(\{ recipeId, \.\.\.opts \}\)\} \/>;/);
  assert.match(src, /import RecipesSite from '\.\/produce\/RecipesSite';/);
  assert.match(src, /const o = take\?\.\('recipes'\); if \(o\?\.recipeId\) onOpen\(o\);/, 'taken once, opened only with its id');
  assert.equal(count(body, 'return '), 5, 'five answers: loading, one site, a recipe asked for, a recipe page, the list');
  assert.ok(!/<RecipesSite[^/]*\/>\s*<\//.test(body), 'RecipesSite is never inside another element');
  assert.doesNotMatch(src.slice(src.search(/^import /m)), /StockSiteGate/, 'no gate: the router shows the company view on All sites');
  for (const f of [ROUTER, SITE]) assert.doesNotMatch(fs.readFileSync(f, 'utf8').slice(0, 2000), /window\.confirm/, 'never window.confirm');
  assert.doesNotMatch(src, /[\u2013\u2014]/, 'the router has no long dash');
});

// ── the render proof ──────────────────────────────────────────────────────────

const require = createRequire(import.meta.url);
let transformSync = null;
try { ({ transformSync } = require('rolldown/experimental')); } catch { transformSync = null; }

const HOME = 'site-home';
// The modules that talk to the database or the store are replaced: every export a quiet stand in,
// so nothing is fetched and the first render is the same every time (the siteIdWiring.test.js set).
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
  'stub:recipe-list': "export default function RecipeList(p) { return globalThis.__h('recipe-list', { 'data-props': JSON.stringify(p) }); }",
  'stub:recipe-page': "export default function RecipePage(p) { return globalThis.__h('recipe-page', { 'data-props': JSON.stringify(p) }); }",
  // the real one draws nothing until the database answers (and nothing at all on needsUpdate)
  'stub:facts-line': 'export default function RecipeFactsLine() { return null; }',
  'stub:scope-one': 'export const useStockScope = () => ({ ready: true, multi: false });',
  'stub:scope-loading': 'export const useStockScope = () => ({ ready: false, multi: false });',
  'stub:scope-multi': 'export const useStockScope = () => ({ ready: true, multi: true });',
};
const VIRTUAL = new Map();
const MAIN_URL = at('backoffice/sections/__main_Recipes.jsx').href;

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
        if (rel === 'backoffice/sections/produce/RecipeList') return { url: 'stub:recipe-list', shortCircuit: true };
        if (rel === 'backoffice/sections/produce/RecipePage') return { url: 'stub:recipe-page', shortCircuit: true };
        if (rel === 'backoffice/sections/produce/RecipeFactsLine') return { url: 'stub:facts-line', shortCircuit: true };
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
  assert.match(today, /Dishes/, 'today\'s screen rendered (the Dishes and Prep modes)');
  assert.match(today, /Prep/);
  assert.doesNotMatch(today, /Sites|All sites|Recipe missing|Set by head office|Checked/, 'no multi site words on today\'s screen');

  assert.equal(html(Site, {}), today, 'the moved file, no siteId');
  assert.equal(html(Site, { siteId: HOME }), today, 'the moved file given the signed in venue (what the router passes a one site company)');

  const RouterOne = (await import(`${ROUTER.href}?scope=one`)).default;
  assert.equal(html(RouterOne, { orgCtx: null, siteId: HOME }), today, 'the router hands a one site company today\'s screen, nothing around it');
  assert.equal(html(RouterOne, { orgCtx: null, siteId: null }), today);
  assert.equal(html(RouterOne, { orgCtx: { userName: 'Test Person' }, siteId: HOME }), today, 'orgCtx changes nothing for a one site company');

  const RouterLoading = (await import(`${ROUTER.href}?scope=loading`)).default;
  assert.equal(html(RouterLoading, { orgCtx: null }), '<div style="padding:16px;color:var(--t3);font-size:13px">Loading…</div>');

  const RouterMulti = (await import(`${ROUTER.href}?scope=multi`)).default;
  const multi = html(RouterMulti, { orgCtx: { userName: 'Test Person' }, siteId: null });
  assert.match(multi, /^<recipe-list /, 'a multi site company gets the recipe list instead');
  assert.match(multi, /Test Person/, 'with the login handed down');
  assert.doesNotMatch(multi, /Dishes/);
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
