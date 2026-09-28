// 28 Sep 2026 (release review): What's new crashed the till (App Error) because it read only the
// old { version, changes } shape; every entry since 5.8.5 is { v, items }.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('What\'s new reads both changelog shapes and never calls .map on undefined', async () => {
  const src = fs.readFileSync(new URL('./WhatsNewModal.jsx', import.meta.url), 'utf8');
  assert.match(src, /const ver = \(c\) => \(c && \(c\.version \?\? c\.v\)\) \|\| '';/);
  assert.match(src, /const changesOf = \(e\) => \(e && \(e\.changes \?\? e\.items\)\) \|\| \[\];/);
  assert.doesNotMatch(src, /entry\.changes\.map/);
  assert.doesNotMatch(src, /===\s*c\.version|key=\{c\.version\}|v\{c\.version\}|v\{entry\.version\}/);
  const { CHANGELOG } = await import('../lib/changelog.js');
  const ver = (c) => (c && (c.version ?? c.v)) || '';
  const changesOf = (e) => (e && (e.changes ?? e.items)) || [];
  for (const c of CHANGELOG) {
    assert.ok(ver(c), 'every entry has a version');
    assert.ok(Array.isArray(changesOf(c)), `entry ${ver(c)} has a list of changes`);
  }
  // The newest entry is the running version (was the literal '5.11.0', which failed every later release).
  const { VERSION } = await import('../lib/version.js');
  assert.equal(ver(CHANGELOG[0]), VERSION);
});
