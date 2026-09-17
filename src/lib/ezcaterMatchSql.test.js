/**
 * ezcaterMatchSql.test.js
 *
 * Static checks on supabase/migrations/20260917_OPS_ezcater_item_links.sql.
 * Peter runs that file by hand, so what it says has to still be true when he
 * does. This pins the parts the JS rules depend on: the key shape, the two
 * kinds, the two sources, and the service role only access.
 *
 * It does NOT run SQL. It reads the file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildLinkKey, normaliseItemName, normaliseKeyName } from './ezcaterMatch.js';

const sql = fs.readFileSync(
  new URL('../../supabase/migrations/20260917_OPS_ezcater_item_links.sql', import.meta.url),
  'utf8',
);
const lower = sql.toLowerCase();
// Executable text: every line that is not a -- comment.
const code = lower.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

test('guards: lock timeout, wrong database check, schema reload', () => {
  assert.ok(code.includes("set lock_timeout = '3s'"));
  assert.ok(code.includes("to_regclass('public.ezcater_order_links') is null"));
  assert.ok(code.includes('wrong database'));
  assert.ok(code.includes("notify pgrst, 'reload schema'"));
});

test('the header says whose database it is and who runs it', () => {
  assert.ok(lower.includes('tbetcegmszzotrwdtqhi'));
  assert.ok(lower.includes('peter runs this by hand'));
  assert.ok(lower.includes('idempotent'));
});

test('idempotent: re-runnable table, indexes and constraints', () => {
  assert.ok(code.includes('create table if not exists public.ezcater_item_links'));
  const creates = code.match(/create index/g) || [];
  const guarded = code.match(/create index if not exists/g) || [];
  assert.equal(creates.length, guarded.length);
  // Every constraint is dropped before it is added, so a half applied run heals.
  const adds = code.match(/add constraint (\w+)/g) || [];
  assert.ok(adds.length >= 4);
  for (const a of adds) {
    const name = a.replace('add constraint ', '');
    assert.ok(code.includes('drop constraint if exists ' + name), 'no drop for ' + name);
  }
});

test('the primary key is (location_id, kind, ez_key), which is what the matcher keys on', () => {
  assert.ok(code.includes('primary key (location_id, kind, ez_key)'));
  // One venue, one kind, one key is ONE row. Two spellings of the same product
  // collapse onto that one row, which is the whole point.
  assert.equal(
    buildLinkKey({ name: 'Caesar Salad (Serves 10)' }),
    buildLinkKey({ name: 'CAESAR SALAD, tray' }),
  );
  // And two SIZES do not, because they are two products. The file has to say
  // so, because Peter reads it before he runs it.
  assert.notEqual(
    buildLinkKey({ name: 'Caesar Salad Half Tray' }),
    buildLinkKey({ name: 'Caesar Salad Full Tray' }),
  );
  assert.ok(lower.includes('the size word stays in the key'));
  assert.equal(normaliseKeyName('Caesar Salad Half Tray'), 'caesar salad half');
});

test('the two kinds and the two sources are exactly what the JS writes', () => {
  assert.ok(code.includes("check (kind in ('item', 'option'))"));
  assert.ok(code.includes("check (source in ('auto', 'manual'))"));
});

test('an empty key can never be stored, because it would link everything to one product', () => {
  assert.ok(code.includes('length(btrim(ez_key)) > 0'));
  assert.ok(code.includes('length(btrim(ez_name)) > 0'));
  // The JS returns '' for a name it cannot normalise, and the caller skips it.
  assert.equal(normaliseItemName('!!!'), '');
  assert.equal(buildLinkKey({ name: '!!!' }), '');
});

test('a link must name something of ours', () => {
  assert.ok(code.includes("kind = 'item'") && code.includes('menu_item_id is not null and option_id is null'));
  assert.ok(code.includes("kind = 'option'") && code.includes('option_id is not null or menu_item_id is not null'));
});

test('service role only, the same fence as ezcater_order_links', () => {
  assert.ok(code.includes('alter table public.ezcater_item_links enable row level security'));
  assert.ok(code.includes('revoke all on public.ezcater_item_links from anon, authenticated'));
  // No policy may be created here: a policy would open the table to a paired
  // till or an anonymous kiosk session, and these rows route food and stock.
  assert.ok(!code.includes('create policy'));
});

test('no foreign key onto menu_items, so a deleted item cannot cascade the work away', () => {
  assert.ok(!code.includes('references public.menu_items'));
});

test('a row with NO target is allowed, because that is how an unmatched item is recorded', () => {
  // The Back Office matching screen lists their items we have SEEN and does not
  // know yet. Those rows have no menu_item_id and no option_id. If the target
  // check rejected them the webhook could not write one and the screen would be
  // permanently empty.
  assert.ok(code.includes('when menu_item_id is null and option_id is null then true'));
  // And "Not on our menu" is the same shape, told apart by matched_by, so it
  // needs no extra column and no extra constraint arm.
  assert.ok(lower.includes("matched_by = 'ignored'"));
});

test('the widened check is still a drop-then-add, so re-running repairs an earlier run', () => {
  const i = code.indexOf('drop constraint if exists ezcater_item_links_target_check');
  const j = code.indexOf('add constraint ezcater_item_links_target_check');
  assert.ok(i !== -1 && j !== -1 && i < j);
  // Peter may already have run the narrower version. The header has to tell him,
  // IN CAPITALS, because a venue on the old check writes no sightings at all and
  // the Item matching screen is then empty forever with no error anywhere.
  assert.ok(sql.includes('IF YOU ALREADY RAN AN EARLIER COPY OF THIS FILE, RUN IT AGAIN.'));
  const at = sql.indexOf('IF YOU ALREADY RAN AN EARLIER COPY OF THIS FILE, RUN IT AGAIN.');
  assert.ok(at < sql.indexOf('create table if not exists public.'), 'it has to be in the header, not buried');
  assert.ok(sql.includes('WIDENED'));
});
