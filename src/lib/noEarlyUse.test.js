// 5.12.92: no screen may read a value above the line that makes it.
//
// 5.12.91 put an effect above `const locationId` in the Workforce screen. Its dependency list read
// locationId during the draw, before that line had run, so every Workforce page stopped with
// "Cannot access before initialization" on the live app. Tests passed and the build passed, because
// nothing draws that screen in a test. The same mistake stopped the staff app in 5.6.3.
//
// This reads every source file and refuses a value used in the SAME scope above its own const or let.
// A use inside a later callback, or of a style object at the bottom of the file, is fine and is not
// counted (that is what `variables: false` means).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { sourceFiles(full, out); continue; }
    if (!/\.(js|jsx)$/.test(name) || /\.test\.js$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

const CONFIG = [{
  files: ['**/*.js', '**/*.jsx'],
  linterOptions: { reportUnusedDisableDirectives: 'off' },
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
  rules: { 'no-use-before-define': ['error', { functions: false, classes: false, variables: false }] },
}];

export function earlyUses(code, filename = 'file.jsx') {
  const linter = new Linter({ configType: 'flat' });
  return linter.verify(code, CONFIG, { filename, allowInlineConfig: false })
    .filter(m => m.ruleId === 'no-use-before-define' || m.fatal)
    .map(m => `${filename}:${m.line} ${m.message}`);
}

test('the check sees the 5.12.91 mistake: a dependency list above its const', () => {
  const bad = `
    import { useEffect } from 'react';
    export default function Screen({ orgCtx }) {
      useEffect(() => { load(locationId); }, [locationId]);
      const locationId = orgCtx?.locationId || null;
      return <div>{locationId}</div>;
    }`;
  const hits = earlyUses(bad);
  assert.equal(hits.length, 1, hits.join('\n'));
  assert.match(hits[0], /locationId/);
});

test('the check allows a later const used inside a callback, and a style object at the bottom', () => {
  const fine = `
    import { useEffect } from 'react';
    export default function Screen({ orgCtx }) {
      const go = () => save(locationId);
      const locationId = orgCtx?.locationId || null;
      useEffect(() => { go(); }, [locationId]);
      return <div style={box} onClick={go}>{locationId}</div>;
    }
    const box = { padding: 4 };`;
  assert.deepEqual(earlyUses(fine), []);
});

test('no source file reads a value above the line that makes it', () => {
  const hits = [];
  const files = sourceFiles(SRC);
  assert.ok(files.length > 300, `only ${files.length} files found, the walk is broken`);
  for (const f of files) hits.push(...earlyUses(readFileSync(f, 'utf8'), f.slice(SRC.length + 1)));
  assert.deepEqual(hits, [], `\n${hits.join('\n')}\nMove the line that uses the value below the line that makes it.`);
});
