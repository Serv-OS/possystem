// 28 Sep 2026: every kiosk still on the current design (device_profiles.kiosk_new_design off)
// crashed as soon as the menu opened. v5.9.55 (98527b26, the logo stands in for a missing
// product photo) read `venueRow?.pos_settings` inside ScreenMenu, where venueRow is not
// defined: it is KioskApp state and was never passed down. An undefined name only throws when
// its line runs. Neither these tests nor `vite build` fail on one, and CI does not run eslint,
// so it reached develop.
//
// This runs eslint's no-undef rule over every kiosk file, current design and new, and fails on
// any name that is not defined. The probe proves the rule is really running: a linter that
// matched no files or never loaded the rule would otherwise pass as "clean".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import globals from 'globals';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const KIOSK_FILES = [
  'src/surfaces/KioskSurface.jsx',
  'src/surfaces/KioskApp.jsx',
  'src/surfaces/KioskProductModal.jsx',
  'src/surfaces/kiosk/**/*.{js,jsx}',
];

// Only no-undef, so the repo's other rules (unused bindings, hooks) cannot fail this test.
function noUndefLinter() {
  return new ESLint({
    cwd: ROOT,
    overrideConfigFile: true,
    overrideConfig: {
      files: ['**/*.{js,jsx}'],
      languageOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        globals: globals.browser,
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      rules: { 'no-undef': 'error' },
    },
  });
}

const problems = (results) => results.flatMap(r => r.messages
  .filter(m => m.ruleId === 'no-undef' || m.fatal)
  .map(m => `${r.filePath.slice(ROOT.length)}:${m.line} ${m.message}`));

test('the no-undef check catches the v5.9.55 fault (probe)', async () => {
  const probe = [
    'export function ScreenMenu({ items }) {',
    '  return items.map(it => ({ it, defaultImage: venueRow?.pos_settings }));',
    '}',
  ].join('\n');
  const results = await noUndefLinter().lintText(probe, { filePath: `${ROOT}src/surfaces/probe.jsx` });
  assert.deepEqual(problems(results), ["src/surfaces/probe.jsx:2 'venueRow' is not defined."]);
});

test('no kiosk file uses a name that is not defined', async () => {
  const results = await noUndefLinter().lintFiles(KIOSK_FILES);
  const linted = results.map(r => r.filePath.slice(ROOT.length));
  assert.ok(linted.includes('src/surfaces/KioskApp.jsx'), 'KioskApp.jsx was linted');
  assert.ok(linted.some(f => f.startsWith('src/surfaces/kiosk/')), 'the new design screens were linted');
  assert.deepEqual(problems(results), []);
});

test('the current design menu gets the venue row from KioskApp', () => {
  const src = fs.readFileSync(new URL('../surfaces/KioskApp.jsx', import.meta.url), 'utf8');
  assert.match(src, /const \[venueRow, setVenueRow\] = useState\(null\);/);
  assert.match(src, /<ScreenMenu [^\n]*\bvenueRow=\{venueRow\}/);
  assert.match(src, /function ScreenMenu\(\{[^)]*\bvenueRow = null\b[^)]*\}\)/);
});
