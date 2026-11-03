// src/lib/noDefaultPositions.test.js: a new site starts with no positions (5.12.50).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../staff/wfData.js', import.meta.url), 'utf8');

test('opening Workforce never writes positions into a venue', () => {
  const i = src.indexOf('export async function loadRoles(');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(i > 0);
  assert.doesNotMatch(body, /insert|upsert|seedDefaultRoles/, 'loadRoles only reads');
  assert.doesNotMatch(src, /async function seedDefaultRoles/, 'the database seeder is gone');
  // The offline demo (no database) may still show the sample list.
  assert.match(body, /if \(isMock \|\| !supabase\) \{\s+list = lsGet\('roles'\);/);
});

test('the only writes to wf_roles are saving or removing a position the manager chose', () => {
  const writes = [...src.matchAll(/from\('wf_roles'\)\.(insert|upsert|delete|update)/g)].length;
  const inSave = (src.match(/export async function saveRole[\s\S]*?\n}\n/)?.[0].match(/from\('wf_roles'\)\.(insert|upsert)/g) || []).length;
  const inDelete = (src.match(/export async function deleteRole[\s\S]*?\n}\n/)?.[0].match(/from\('wf_roles'\)\.delete/g) || []).length;
  assert.equal(writes, inSave + inDelete);
});
