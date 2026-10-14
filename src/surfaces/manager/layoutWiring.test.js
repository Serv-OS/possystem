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

test('no re mount: the layout never chooses a component, an element or a key', () => {
  for (const [name, text] of Object.entries(SCREENS)) {
    // L.x ? <A/> : <B/>   and   L.x && <A/>
    assert.doesNotMatch(text, /\bL\.[\w.]+\s*(\?|&&)\s*\(?\s*</, `${name}: the layout picks what renders`);
    // The same through the two names derived from it (Team "two", Home "split").
    assert.doesNotMatch(text, /\b(two|split)\s*(\?|&&)\s*\(?\s*</, `${name}: a layout flag picks what renders`);
    // An early return or a branch on the layout.
    assert.doesNotMatch(text, /\bif\s*\(\s*!?\s*(L\.|two\b|split\b)/, `${name}: a branch on the layout`);
    // A key built from the layout would re mount the element when the band changes.
    assert.doesNotMatch(text, /\bkey=\{[^}]*\b(L\.|layout\b)/, `${name}: a key from the layout`);
    // Screens read the context. Only useLayout.js calls the layout function.
    assert.doesNotMatch(text, /\blayoutFor\(|\bbandFor\(/, `${name}: calls the layout function itself`);
  }
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
