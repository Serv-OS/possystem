// Category photos: static checks on supabase/migrations/20260914_OPS_category_photos.sql.
// Pins what Peter relies on when he runs it by hand: idempotent, fails fast, only adds,
// and the storage fence covers product-images/<loc>/categories/ and nothing else.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CATEGORY_PHOTO_MAX_URL, CATEGORY_PHOTO_URL_PATTERN } from './categoryPhoto.js';

const sql = fs.readFileSync(new URL('../../supabase/migrations/20260914_OPS_category_photos.sql', import.meta.url), 'utf8');
const fenceSql = fs.readFileSync(new URL('../../supabase/storage_policies/20260914_category_photo_fence.sql', import.meta.url), 'utf8');
const lower = sql.toLowerCase();
// Executable text: every line that is not a -- comment.
const code = lower.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');

test('guards: lock timeout, wrong database check, schema reload', () => {
  assert.ok(code.includes("set lock_timeout = '3s'"));
  assert.ok(code.includes("to_regclass('public.menu_categories') is null"));
  assert.ok(code.includes("to_regclass('public.device_profiles') is null"));
  assert.ok(code.includes('wrong database'));
  assert.ok(code.includes("notify pgrst, 'reload schema'"));
});

test('adds the two columns idempotently', () => {
  assert.ok(code.includes('alter table public.menu_categories add column if not exists image text'));
  assert.ok(code.includes('alter table public.device_profiles add column if not exists kiosk_category_photos boolean not null default true'));
});

test('the URL shape check is the same pattern as the JS rule', () => {
  assert.ok(code.includes("if not exists (select 1 from pg_constraint where conname = 'menu_categories_image_shape')"));
  const m = /char_length\(image\)\s*<=\s*(\d+)/.exec(code);
  assert.ok(m, 'length limit present');
  assert.equal(Number(m[1]), CATEGORY_PHOTO_MAX_URL);
  const re = /image ~ '([^']+)'/.exec(sql);   // case sensitive: from the raw file
  assert.ok(re, 'regex check present');
  assert.equal(re[1], CATEGORY_PHOTO_URL_PATTERN, 'SQL and JS patterns are identical');
});

test('the migration does not claim the storage fence is on, and shows the result last', () => {
  assert.ok(lower.includes('attempt only'));
  assert.ok(lower.includes('skipped'));
  assert.ok(lower.includes('supabase/storage_policies/20260914_category_photo_fence.sql'));
  const lastStatement = code.trim().split(';').filter(x => x.trim()).pop();
  assert.ok(/select count\(\*\) as cat_photo_policies\s+from pg_policy/.test(lastStatement), 'the visible check is the last result');
  assert.ok(code.includes('undefined_function'));
});

test('three restrictive storage policies fence the categories folder', () => {
  const creates = code.match(/create policy cat_photo_(insert|update|delete)_fence on storage\.objects as restrictive for (insert|update|delete) to authenticated/g) || [];
  assert.equal(creates.length, 3);
  assert.equal((code.match(/create policy/g) || []).length, 3, 'no other policy is created');
  for (const kind of ['insert', 'update', 'delete']) {
    const start = code.indexOf(`create policy cat_photo_${kind}_fence`);
    const end = code.indexOf(')$p$', start);
    const body = code.slice(start, end);
    assert.ok(body.includes(`for ${kind} to authenticated`));
    for (const needle of ["'product-images'", "split_part(name, '/', 2) <> 'categories'", 'is_anon_session()', "split_part(name, '/', 1) in (select public.user_accessible_locations())", 'is_super_admin()']) {
      assert.ok(body.includes(needle), `${kind} policy has ${needle}`);
    }
    if (kind !== 'delete') assert.ok(body.includes("lower(storage.extension(name)) in ('jpg', 'png', 'webp')"), `${kind} with check limits the file type`);
    if (kind === 'insert') assert.ok(body.includes('with check') && !body.includes('using'));
    if (kind === 'update') assert.ok(body.includes('using') && body.includes('with check'));
    if (kind === 'delete') assert.ok(body.includes('using') && !body.includes('with check'));
  }
  assert.ok(code.includes('exception when insufficient_privilege'));
});

test('nothing is dropped except its own policies', () => {
  assert.ok(!/drop\s+column/.test(code));
  assert.ok(!/drop\s+table/.test(code));
  assert.ok(!/drop\s+constraint/.test(code));
  const drops = code.match(/drop policy if exists (\w+)/g) || [];
  assert.equal(drops.length, 3);
  for (const d of drops) assert.ok(/cat_photo_(insert|update|delete)_fence$/.test(d), d);
  assert.ok(!lower.includes('authenticated full access'), 'existing product-images policies untouched');
  assert.ok(lower.includes('refresh every open back office tab'));
  // Rollback lines live in comments only.
  assert.ok(lower.includes('--   alter table public.menu_categories drop column if exists image;'));
});

test('the storage owner file creates exactly the same three policies', () => {
  const fenceCode = fenceSql.toLowerCase().split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  const norm = (t) => t.replace(/\s+/g, ' ').trim();
  for (const kind of ['insert', 'update', 'delete']) {
    const inMig = /create policy cat_photo_\w+_fence[\s\S]*?(?=\)\$p\$)/g;
    const migBodies = (code.match(inMig) || []).map(b => norm(b + ')'));
    const start = fenceCode.indexOf(`create policy cat_photo_${kind}_fence`);
    assert.ok(start >= 0, `${kind} policy in the storage owner file`);
    const body = norm(fenceCode.slice(start, fenceCode.indexOf(';', start)));
    assert.ok(migBodies.includes(body), `${kind} policy is identical in both files`);
  }
  assert.equal((fenceCode.match(/create policy/g) || []).length, 3);
  assert.ok(!/drop\s+(column|table|constraint)/.test(fenceCode));
});
