// layoutWiring.test.js: source pins for how the Manager layout is wired into the screens.
//
// layout.test.js proves the layout function. This file reads the screens as text and keeps
// the two promises a picture cannot keep on its own:
//   - NO RE MOUNT ON RESIZE: the layout value feeds style values, one icon size and two
//     words. It never chooses a component, an element, a key or a conditional render.
//   - ONE SOURCE OF WIDTH: only useLayout.js looks at the viewport. No screen sniffs the
//     device or measures the window for itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const count = (text, piece) => text.split(piece).length - 1;

const surface = read('../ManagerSurface.jsx');
const hook = read('./useLayout.js');
const layout = read('./layout.js');
const ops = read('../OperationsSurface.jsx');
const opsDocs = read('../ops/OpsDocsForms.jsx');
const css = read('../../styles/globals.css');

// Every file that renders inside the Manager Shell.
const SCREENS = {
  'ManagerSurface.jsx': surface,
  'manager/ui.jsx': read('./ui.jsx'),
  'manager/ManagerHome.jsx': read('./ManagerHome.jsx'),
  'manager/ManagerReports.jsx': read('./ManagerReports.jsx'),
  'manager/ManagerTeam.jsx': read('./ManagerTeam.jsx'),
  'manager/ManagerKitchen.jsx': read('./ManagerKitchen.jsx'),
  'manager/ManagerOps.jsx': read('./ManagerOps.jsx'),
  'OperationsSurface.jsx': ops,
  'ops/OpsDocsForms.jsx': opsDocs,
};

test('one viewport subscription, at the top, and the default is the phone layout', () => {
  assert.equal(count(surface, 'useViewportLayout('), 1, 'ManagerSurface subscribes exactly once');
  assert.match(surface, /export default function ManagerSurface\(\) \{\s*const layout = useViewportLayout\(\);\s*return <LayoutContext\.Provider value=\{layout\}><ManagerApp \/><\/LayoutContext\.Provider>;/);
  assert.match(hook, /createContext\(PHONE\)/, 'a host with no provider lays out as a phone');
  // ManagerApp holds stage, operator, tab and the snapshot: it must not read the layout.
  const app = surface.slice(surface.indexOf('function ManagerApp('), surface.indexOf('export default function ManagerSurface('));
  assert.ok(app.length > 0);
  assert.doesNotMatch(app, /useLayout\(|useViewportLayout\(/);
  // The Ops views read the context, they never subscribe for themselves.
  assert.equal(count(ops, 'useViewportLayout('), 0);
  assert.equal(count(opsDocs, 'useViewportLayout('), 0);
});

test('the Shell keeps one element order at every width: children, tab bar, toast', () => {
  const shell = surface.slice(surface.indexOf('function Shell('), surface.indexOf('function RefreshButton('));
  assert.ok(shell.length > 0);
  assert.equal(count(shell, '{children}'), 1);
  const kids = shell.indexOf('{children}');
  const bar = shell.indexOf('<TabBar');
  const toast = shell.indexOf('<ManagerToast');
  assert.ok(kids > 0 && kids < bar && bar < toast, 'children, then <TabBar, then <ManagerToast');
  assert.equal(count(surface, '<TabBar'), 1, 'the rail and the bottom pill are the same TabBar');
});

test('the two device words are text swaps inside the same sentences', () => {
  assert.match(surface, /Pair this \{L\.deviceWord\}</);
  assert.match(surface, /link this \{L\.deviceWord\} to your venue/);
});

// The ways a later edit could let the layout decide WHAT renders. Kept as a function so the
// test below can prove it on sample lines as well as on the real screens.
const esc = (n) => n.replace(/[$]/g, '\\$');
function remountFaults(text) {
  const faults = [];
  // L.x ? <A/> : <B/>, L.x && <A/>, with a comparison in between (L.panes === 2 && <A/>) or
  // a null branch first (L.phone ? null : <A/>).
  if (/\bL\.[\w.]+[^;\n{}]{0,40}?(\?|&&)\s*(null\s*:\s*)?\(?\s*</.test(text)) faults.push('the layout picks what renders');
  // An early return or a branch on the layout.
  if (/\bif\s*\(\s*!?\s*\(?\s*L\./.test(text)) faults.push('a branch on the layout');
  // A key built from the layout would re mount the element when the band changes.
  if (/\bkey=\{[^}]*\b(L\.|layout\b)/.test(text)) faults.push('a key from the layout');
  // Screens read the context. Only useLayout.js calls the layout function.
  if (/\blayoutFor\(|\bbandFor\(/.test(text)) faults.push('calls the layout function itself');
  // The same through any name declared from the layout (Team "two", Home "split").
  const names = new Set();
  for (const m of text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*[^;\n]*\bL\./g)) names.add(m[1]);
  for (const n of names) {
    const v = esc(n);
    if (new RegExp(`(^|[^\\w.$])!?${v}\\s*(\\?|&&)\\s*(null\\s*:\\s*)?\\(?\\s*<`).test(text)) faults.push(`"${n}" (from the layout) picks what renders`);
    if (new RegExp(`\\bif\\s*\\(\\s*!?\\s*\\(?\\s*${v}\\b`).test(text)) faults.push(`a branch on "${n}" (from the layout)`);
    if (new RegExp(`<${v}[\\s/>]`).test(text)) faults.push(`"${n}" (from the layout) is used as a component`);
    if (new RegExp(`\\bkey=\\{[^}]*\\b${v}\\b`).test(text)) faults.push(`a key from "${n}" (from the layout)`);
  }
  return faults;
}

test('no re mount: the layout never chooses a component, an element or a key', () => {
  for (const [name, text] of Object.entries(SCREENS)) {
    assert.deepEqual(remountFaults(text), [], name);
  }
});

test('the no re mount guard catches the likely mistakes and allows style only uses', () => {
  const bad = [
    '{L.phone ? <A/> : <B/>}',
    '{!L.phone && <Rail/>}',
    '{L.panes && (<A/>)}',
    '{L.panes === 2 && <Side/>}',
    '{L.band === "wide" ? <A/> : <B/>}',
    '{L.phone ? null : <Rail/>}',
    '{L.statCols > 2 && (<X/>)}',
    'const wide = L.panes === 2; return wide ? <A/> : <B/>;',
    'const wide = L.panes === 2;\n  return <div>{wide && <A/>}</div>;',
    'const wide = L.panes === 2;\n  if (!wide) return null;',
    'const C = L.phone ? PhoneNav : RailNav;\n  return <C />;',
    'const band = L.band;\n  return <div key={band} />;',
    'if (L.panes === 2) return <A/>;',
    '<div key={L.band} />',
    'const x = layoutFor(800);',
  ];
  for (const line of bad) assert.notDeepEqual(remountFaults(line), [], line);
  const good = [
    '<div style={two ? L.s.page2 : undefined}>',
    'const two = L.panes === 2 && flags.team_approvals;\n  <div style={{ gap: 8, ...(two ? null : L.s.rows) }}>',
    "<div style={{ gap: 10, ...(split ? L.s.homeBento : L.phone ? null : { gridTemplateColumns: cols(L.statCols) }) }}>",
    '<Icon name={t.icon} size={L.navIcon} />',
    '<div data-mgr-layout={L.phone ? undefined : L.band}>',
    'Pair this {L.deviceWord}</div>',
    "<button style={{ flex: 1, ...L.s.decideBtn }}>{busy ? <Spinner /> : 'Save'}</button>",
  ];
  for (const line of good) assert.deepEqual(remountFaults(line), [], line);
});

test('one source of width: no screen measures the window or sniffs the device', () => {
  for (const [name, text] of Object.entries(SCREENS)) {
    for (const word of ['userAgent', 'matchMedia(', 'innerWidth', 'RposIOS']) {
      assert.ok(!text.includes(word), `${name} must not read ${word}`);
    }
  }
  assert.ok(!layout.includes('innerWidth') && !layout.includes('matchMedia('), 'layout.js stays pure');
  assert.equal(count(hook, 'innerWidth'), 1, 'useLayout.js is the one place the width is read');
});

test('scope: the stand alone Ops tablet and every other surface are untouched', () => {
  // The Manager app renders OpsContent with chrome off; the retired stand alone chrome
  // keeps its own 480 column.
  assert.ok(ops.includes('if (!chrome) return body;'));
  assert.ok(ops.includes("maxWidth: 480, margin: '0 auto', padding: '0 14px 28px'"));
  // The 44 point touch rule exists only under the attribute the Manager Shell sets from 660 wide.
  assert.ok(css.includes('[data-mgr-layout] button'));
  assert.match(surface, /data-mgr-layout=\{L\.phone \? undefined : L\.band\}/);
});

test('new files carry no long dashes', () => {
  for (const [name, text] of Object.entries({ 'layout.js': layout, 'useLayout.js': hook, 'ops/OpsDocsForms.jsx': opsDocs })) {
    assert.doesNotMatch(text, /[–—]/, name);
  }
});
