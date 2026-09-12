/**
 * orderScreenSql.test.js: static checks on the order screen migration.
 * Run: `npm test`. No database needed.
 *
 * Pins the safety properties Peter relies on when he runs the file by hand:
 * the feed is not callable by anon, every new table has RLS, only the no personal
 * data ping table is published, the order_queue trigger swallows its own errors,
 * and the SQL name rules match the JS mirror.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { CHANNELS, NAME_PLACEHOLDER_PATTERN, NAME_CONTACT_PATTERN, CUSTOMER_TYPED_SOURCES } from './orderScreenStatus.js';

const sql = fs.readFileSync(new URL('../../../supabase/migrations/20260911_OPS_order_status_displays.sql', import.meta.url), 'utf8');
const lower = sql.toLowerCase();

// The text of one function, from `create or replace function public.<name>(` to its closing $$.
function fnText(name) {
  const start = lower.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `function ${name} is defined`);
  const open = sql.indexOf('$$', start);
  const close = sql.indexOf('$$', open + 2);
  assert.ok(open > start && close > open, `function ${name} has a body`);
  return sql.slice(start, close + 2);
}

test('the feed is revoked from public and anon', () => {
  assert.ok(sql.includes('revoke all on function public.order_status_feed(uuid) from public, anon;'));
  assert.ok(sql.includes('grant execute on function public.order_status_feed(uuid) to authenticated;'));
});

test('the feed takes a screen id only, never a location', () => {
  assert.ok(sql.includes('create or replace function public.order_status_feed(p_screen_id uuid)'));
  assert.ok(fnText('order_status_feed').includes('ms.device_uid = v_uid'));
});

test('row level security is on for all three new tables', () => {
  for (const t of ['order_status_displays', 'order_status_marks', 'order_status_pings']) {
    assert.ok(sql.includes(`alter table public.${t} enable row level security;`), t);
  }
});

test('only the ping table is published to realtime', () => {
  assert.ok(sql.includes('add table public.order_status_pings'));
  assert.ok(!sql.includes('add table public.order_status_marks'));
  assert.ok(!sql.includes('add table public.order_status_displays'));
  assert.ok(!sql.includes('add table public.order_queue'));
});

test('no draft helpers, no replica identity full, no dashes', () => {
  assert.ok(!lower.includes('pos_accessible_location'));
  assert.ok(!lower.includes('replica identity full'));
  assert.ok(!sql.includes('\u2014'), 'no em dash');
  assert.ok(!sql.includes('\u2013'), 'no en dash');
});

test('the order_queue trigger swallows its own errors', () => {
  const body = fnText('tg_order_status_marks');
  assert.ok(body.includes('exception when others then'));
  assert.ok(fnText('tg_order_status_displays_ping').includes('exception when others then'));
});

test('the replaced menu board functions clear order_display_id', () => {
  assert.ok(fnText('claim_menu_board_screen').includes('order_display_id = null'));
  assert.ok(fnText('set_menu_board_screen').includes('order_display_id = null'));
});

test('the order screen functions clear board_id', () => {
  assert.ok(fnText('claim_order_status_screen').includes('board_id = null'));
  assert.ok(fnText('set_order_status_screen').includes('board_id = null'));
});

test('every channel key appears in quotes', () => {
  for (const c of CHANNELS) assert.ok(sql.includes(`'${c.key}'`), c.key);
});

test('the name placeholder pattern matches the JS mirror verbatim', () => {
  assert.ok(sql.includes(NAME_PLACEHOLDER_PATTERN));
});

test('names: contact details never show and only letters survive (mirrors formatOrderName)', () => {
  const body = fnText('_osd_name');
  assert.ok(body.includes(`n ~ '${NAME_CONTACT_PATTERN}'`), 'contact pattern verbatim');
  assert.ok(body.includes("'[^[:alpha:][:space:]''’-]'"), 'letters, spaces, apostrophes and hyphens only');
});

test('numbers: online, catering and QR refs show their last 3 only (mirrors orderNumberOf)', () => {
  const body = fnText('_osd_number');
  assert.ok(body.includes("'^(OL|CA|QR)-'"));
  assert.ok(body.includes('right(p_ref, 3)'));
});

test('the feed hides customer typed names until a server stamped status change', () => {
  const feed = fnText('order_status_feed');
  const quoted = CUSTOMER_TYPED_SOURCES.map(s => `'${s}'`).join(',');
  assert.ok(feed.includes(`l.source in (${quoted})`), quoted);
  assert.ok(feed.includes('l.status_changed_at > l.first_seen_at'));
  assert.ok(sql.includes('first_seen_at     timestamptz not null default now()'));
});

test('the feed hides a scheduled order with no fire time, and departed rows use the earliest collection', () => {
  const feed = fnText('order_status_feed');
  assert.ok(feed.includes("not (b.status = 'scheduled' and b.sent_at is null)"));
  assert.ok(/when p\.departed then least\(/.test(feed));
});

test('order writes never wait on the shared ping row or on mark cleanup', () => {
  const body = fnText('tg_order_status_marks');
  assert.equal((body.match(/for update skip locked/g) || []).length, 2, 'ping bump and mark cleanup');
  assert.ok(!body.includes('insert into public.order_status_pings'), 'no ping upsert from order writes');
  assert.ok(body.includes('from public.locations l where l.id = v_loc::uuid'), 'junk venues return early');
  const displays = fnText('tg_order_status_displays_ping');
  assert.ok(displays.includes('on conflict (location_id) do nothing'));
  assert.ok(displays.includes('for update skip locked'));
  assert.ok(sql.includes('insert into public.order_status_pings (location_id, bumped_at)\nselect l.id::text, now() from public.locations l'), 'ping rows seeded per venue');
});

test('definer functions pin search_path', () => {
  for (const name of ['order_status_feed', 'claim_order_status_screen', 'claim_menu_board_screen', 'set_order_status_screen', 'set_menu_board_screen']) {
    assert.ok(fnText(name).includes('security definer set search_path = public'), name);
  }
});

test('Back Office pairing functions refuse anonymous sessions', () => {
  assert.ok(fnText('claim_order_status_screen').includes('public.is_anon_session()'));
  assert.ok(fnText('set_order_status_screen').includes('public.is_anon_session()'));
});

test('no names reach a TV while order_queue is open to any writer', () => {
  const gate = fnText('order_status_names_enabled');
  assert.ok(gate.includes("p.tablename = 'order_queue'"));
  assert.ok(gate.includes("p.cmd in ('ALL', 'INSERT', 'UPDATE')"));
  assert.ok(gate.includes('relrowsecurity'));
  const feed = fnText('order_status_feed');
  assert.ok(feed.includes('v_names := coalesce(public.order_status_names_enabled(), false);'));
  assert.ok(feed.includes('when not v_names then null'));
  assert.ok(sql.includes('revoke all on function public.order_status_names_enabled() from public, anon;'));
});

test('clashing online, catering and QR codes widen to 4 characters (mirrors resolveNumberClashes)', () => {
  const feed = fnText('order_status_feed');
  assert.ok(feed.includes("case when r.ref ~ '^(OL|CA|QR)-' and count(*) over (partition by r.sec_idx, r.num_base) > 1"));
  assert.ok(feed.includes('then right(r.ref, 4) else r.num_base end as num'));
  assert.ok(feed.includes("'number', l.num"));
});

test('the migration fails fast on a busy table and keeps readers moving', () => {
  const firstStatement = sql.split('\n').find(l => l.trim() && !l.trim().startsWith('--'));
  assert.equal(firstStatement, "set lock_timeout = '3s';");
  assert.ok(sql.includes('create or replace trigger order_status_marks_trg'));
  assert.ok(!sql.includes('drop trigger if exists order_status_marks_trg on public.order_queue;\ncreate'), 'no ACCESS EXCLUSIVE drop before create');
});

test('grants, policies and backfill close the gaps found on the live schema', () => {
  assert.ok(sql.includes('revoke all on table public.order_status_displays from public, anon, authenticated;'), 'no TRUNCATE for authenticated');
  assert.ok(/create policy mb_screens_insert[\s\S]*?order_display_id is null/.test(sql), 'a TV cannot give itself an order screen');
  for (const p of ['osd_logo_insert_fence', 'osd_logo_update_fence', 'osd_logo_delete_fence']) {
    assert.ok(sql.includes(`create policy ${p} on storage.objects as restrictive`), p);
  }
  assert.ok(sql.includes("select q.location_id, q.ref, q.status, coalesce(q.created_at, now()),"), 'backfill keeps the name gate closed');
  const setOrder = fnText('set_order_status_screen');
  assert.ok(setOrder.includes("set order_display_id = null, board_id = null, status = 'unpaired'"), 'unpair clears a board too');
  const seed = fnText('tg_order_status_displays_ping');
  assert.ok(seed.includes('if not exists (select 1 from public.order_status_pings p0 where p0.location_id = v_loc) then'), 'display saves never wait on an order write');
});

test('the replaced claim_menu_board_screen keeps the live error text byte for byte', () => {
  const claim = fnText('claim_menu_board_screen');
  assert.ok(claim.includes("'pairing code expired ' || convert_from('\\xe28094'::bytea, 'UTF8') || ' restart the screen to get a new code'"));
  assert.equal(Buffer.from('e28094', 'hex').toString('utf8'), '—', 'those bytes are the em dash of the live text');
  for (const m of ['board not found', 'no access to this location', 'pairing code not found', 'screen belongs to another location']) {
    assert.ok(claim.includes(`'${m}'`), m);
  }
});

test('the migration guards against the wrong database', () => {
  assert.ok(sql.includes("raise exception 'Wrong database. Run this on the Ops project.'"));
});

// ── 20260911b: the per screen "Show customer names now" override ────────────────────────
const sqlNames = fs.readFileSync(new URL('../../../supabase/migrations/20260911b_OPS_order_screen_show_names_now.sql', import.meta.url), 'utf8');

test('20260911b: the names override is per screen and only widens the gate', () => {
  const l = sqlNames.toLowerCase();
  // It replaces one function and nothing else: no table, policy or grant changes.
  assert.equal((l.match(/create or replace function/g) || []).length, 1);
  assert.ok(l.includes('create or replace function public.order_status_feed'));
  for (const word of ['drop table', 'alter table', 'create policy', 'drop policy', 'grant ', 'revoke ']) {
    assert.equal(l.includes(word), false, `the file must not contain ${word}`);
  }
  // The gate is the global check OR that screen's own setting, never the setting alone.
  assert.ok(sqlNames.includes("v_names := coalesce(public.order_status_names_enabled(), false)"));
  assert.ok(sqlNames.includes("or coalesce((d.settings->>'showNamesNow')::boolean, false)"));
  // Still a security definer function with a pinned search path, and still fenced on auth.uid().
  assert.ok(l.includes('security definer'));
  assert.ok(l.includes("set search_path to 'public'"));
  assert.ok(sqlNames.includes('ms.device_uid = v_uid'));
  // Wrong database guard, and Ops named in the header.
  assert.ok(l.includes("to_regclass('public.order_status_displays') is null"));
  assert.ok(sqlNames.includes('tbetcegmszzotrwdtqhi'));
});
