// marketingV3Resolver.test.js (6 Nov 2026, 5.12.67): the segment resolver, run for real.
//
// The resolver is SQL (20261126a_OPS_marketing_v3.sql). Where a local Postgres is installed
// (pg_ctl on the PATH, as on the build Mac) this test starts a throwaway cluster, loads the stub
// tables the migration leans on, the real customer_rfm view and the real migration, and proves:
//   - an old flat definition resolves as before,
//   - groups nest to three levels (all inside any, any inside all) and a fourth level is ignored,
//   - "ordered this item / anything in this category in the last N days" counts a till check with a
//     customer_id, an online check tied only by email, a QR check tied only by phone, a loyalty
//     check tied by the loyalty block, and ignores a voided check, a demo check and an old check,
//   - a customer_id list rule (what the loyalty rules expand to) works,
//   - a textbook injection in a value, a field and an op matches nobody and leaves the table intact,
//   - the public reviews read gives rating, words, "Jane S." and the source and nothing private.
// Without pg_ctl (GitHub) the test is skipped, and the pure text checks below still run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, p), 'utf8');
const MIGRATION = read('../../supabase/migrations/20261126a_OPS_marketing_v3.sql');
const SEGMENTS_MIGRATION = read('../../supabase/migrations/20260616c_marketing_segments.sql');

test('marketing v3 migration: ASCII only, rollback twin, no transaction words, values bound not pasted', () => {
  assert.ok(!/[^ -~\n\r\t]/.test(MIGRATION), 'migration must be ASCII');
  assert.ok(fs.existsSync(path.join(here, '../../supabase/migrations/20261126a_OPS_marketing_v3_ROLLBACK.sql')));
  assert.ok(!/^\s*(begin|commit);/im.test(MIGRATION));
  // every security definer function pins its search path
  const defs = MIGRATION.match(/security definer[^$]*?\$\$/g) || [];
  for (const d of defs) assert.match(d, /set search_path = public, pg_temp/);
  // the clause builder never calls quote_literal on a value: values come out of $1 by path
  assert.ok(!/quote_literal\(/.test(MIGRATION), 'no value is pasted into the SQL text');
  assert.match(MIGRATION, /\$1 #>> /);
  assert.match(MIGRATION, /grant execute on function public\.review_feedback_public\(text\[\], int, int\) to anon, authenticated/);
});

function which(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  for (const p of ['/opt/homebrew/opt/postgresql@17/bin', '/opt/homebrew/bin', '/usr/local/bin']) {
    if (fs.existsSync(path.join(p, bin))) return path.join(p, bin);
  }
  return null;
}

// A Mac shell with no LANG makes the postmaster 'multithreaded during startup'; a plain C locale cures it.
const PG_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };
const PG_CTL = which('pg_ctl');
const INITDB = which('initdb');
const PSQL = which('psql');
const hasPg = !!(PG_CTL && INITDB && PSQL);

const ORG = '11111111-1111-1111-1111-111111111111';
const OTHER_ORG = '22222222-2222-2222-2222-222222222222';
const LOC = '33333333-3333-3333-3333-333333333333';
const LOC2 = '34333333-3333-3333-3333-333333333333';
const CUST = {
  alice: 'aaaaaaaa-0000-0000-0000-000000000001',   // till check with customer_id, VIP
  bob: 'aaaaaaaa-0000-0000-0000-000000000002',     // online check tied by email only
  carol: 'aaaaaaaa-0000-0000-0000-000000000003',   // qr check tied by phone only (different format)
  dave: 'aaaaaaaa-0000-0000-0000-000000000004',    // loyalty block customer_id, bought a size (child item)
  erin: 'aaaaaaaa-0000-0000-0000-000000000005',    // voided check only
  frank: 'aaaaaaaa-0000-0000-0000-000000000006',   // demo check only
  gina: 'aaaaaaaa-0000-0000-0000-000000000007',    // old check (200 days)
  hal: 'aaaaaaaa-0000-0000-0000-000000000008',     // never ordered, has email, lapsed
  other: 'bbbbbbbb-0000-0000-0000-000000000001',   // other org, bought everything
};

const STUBS = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create table public.user_locations (user_id uuid, location_id uuid);
create table public.marketing_messages (id uuid primary key default gen_random_uuid(), org_id uuid, campaign_id uuid, workflow_id uuid, customer_id uuid);
create table public.locations (id uuid primary key, org_id uuid, timezone text default 'Europe/London', created_at timestamptz default now());
create table public.customers (id uuid primary key, org_id uuid, first_name text, last_name text, name text, email text, phone text, birthday date, marketing_opt_in boolean default true, source text, is_local boolean, created_at timestamptz default now(), deleted_at timestamptz);
create table public.customer_locations (customer_id uuid, location_id uuid, visit_count int default 0, lifetime_revenue numeric default 0, last_visit_at timestamptz, first_visit_at timestamptz);
create table public.closed_checks (id text primary key, location_id text, items jsonb default '[]', customer_id uuid, customer jsonb, customer_phone text, loyalty jsonb, closed_at timestamptz default now(), voided boolean default false, status text default 'paid');
create table public.menu_items (id text, location_id text, name text, cat text, parent_id text, archived boolean default false);
create table public.menu_categories (id text, location_id text, label text);
create table public.campaigns (id uuid primary key default gen_random_uuid(), org_id uuid, name text);
create table public.workflows (id uuid primary key default gen_random_uuid(), org_id uuid, name text);
create table public.review_feedback (id uuid primary key default gen_random_uuid(), location_id text, customer_name text, customer_email text, customer_phone text, customer_id uuid, rating smallint, comment text, private_detail text, is_public boolean, status text default 'new', source_platform text, created_at timestamptz default now());
create function public.user_accessible_orgs() returns setof text language sql stable as $$ select null::text where false $$;
create function public._sales_is_demo(p_id text) returns boolean language sql immutable as $$ select coalesce(left(p_id, 5) = 'demo-', false) $$;
create function public.stock_js_truthy(j jsonb) returns boolean language sql immutable as $$
  select case jsonb_typeof(j) when 'boolean' then (j #>> '{}')::boolean when 'number' then (j #>> '{}')::numeric <> 0 when 'string' then (j #>> '{}') <> '' when 'null' then false else j is not null end $$;
create function public.stock_js_key(j jsonb) returns text language sql immutable as $$
  select case jsonb_typeof(j) when 'string' then nullif(j #>> '{}', '') when 'number' then j #>> '{}' else null end $$;
`;

const SEED = `
insert into public.locations (id, org_id) values ('${LOC}', '${ORG}'), ('${LOC2}', '${ORG}'), ('44444444-4444-4444-4444-444444444444', '${OTHER_ORG}');
insert into public.customers (id, org_id, first_name, name, email, phone, marketing_opt_in, created_at) values
  ('${CUST.alice}', '${ORG}', 'Alice', 'Alice A', 'alice@x.com', '+447700900001', true, now() - interval '400 days'),
  ('${CUST.bob}', '${ORG}', 'Bob', 'Bob B', 'Bob@X.com', null, true, now() - interval '10 days'),
  ('${CUST.carol}', '${ORG}', 'Carol', 'Carol C', null, '07700 900003', true, now() - interval '50 days'),
  ('${CUST.dave}', '${ORG}', 'Dave', 'Dave D', 'dave@x.com', '+447700900004', false, now() - interval '50 days'),
  ('${CUST.erin}', '${ORG}', 'Erin', 'Erin E', 'erin@x.com', null, true, now()),
  ('${CUST.frank}', '${ORG}', 'Frank', 'Frank F', 'frank@x.com', null, true, now()),
  ('${CUST.gina}', '${ORG}', 'Gina', 'Gina G', 'gina@x.com', null, true, now()),
  ('${CUST.hal}', '${ORG}', 'Hal', 'Hal H', 'hal@x.com', null, true, now() - interval '300 days'),
  ('${CUST.other}', '${OTHER_ORG}', 'Zed', 'Zed Z', 'zed@x.com', '+447700900009', true, now());
insert into public.customer_locations (customer_id, location_id, visit_count, lifetime_revenue, last_visit_at) values
  ('${CUST.alice}', '${LOC}', 20, 900, now() - interval '2 days'),
  ('${CUST.bob}', '${LOC}', 1, 12, now() - interval '3 days'),
  ('${CUST.carol}', '${LOC}', 3, 40, now() - interval '4 days'),
  ('${CUST.dave}', '${LOC}', 6, 150, now() - interval '5 days'),
  ('${CUST.hal}', '${LOC}', 4, 80, now() - interval '120 days'),
  ('${CUST.other}', '44444444-4444-4444-4444-444444444444', 50, 5000, now());
insert into public.menu_items (id, location_id, name, cat, parent_id) values
  ('item-pizza', '${LOC}', 'Pizza', 'cat-mains', null),
  ('item-pizza-large', '${LOC}', 'Large', 'cat-mains', 'item-pizza'),
  ('item-coffee', '${LOC}', 'Flat white', 'cat-drinks', null),
  ('item-pizza-b', '${LOC2}', 'Pizza', 'cat-mains-b', null),
  ('item-pizza', '44444444-4444-4444-4444-444444444444', 'Pizza', 'cat-mains', null);
insert into public.closed_checks (id, location_id, items, customer_id, customer, customer_phone, loyalty, closed_at, voided, status) values
  ('chk-till', '${LOC}', '[{"itemId":"item-pizza","qty":1,"cat":"cat-mains"}]', '${CUST.alice}', null, null, null, now() - interval '1 day', false, 'paid'),
  ('chk-online', '${LOC}', '[{"itemId":"item-coffee","qty":2,"cat":"cat-drinks"}]', null, '{"name":"Bob","email":"bob@x.com"}', null, null, now() - interval '2 days', false, 'paid'),
  ('chk-qr', '${LOC}', '[{"itemId":"item-pizza-b","qty":1,"cat":"cat-mains-b"}]', null, '{"name":"Carol"}', '+44 7700 900003', null, now() - interval '3 days', false, 'paid'),
  ('chk-loyalty', '${LOC}', '[{"id":"item-pizza-large","itemId":"item-pizza-large","qty":1}]', null, '"Dave"', null, '{"customer_id":"${CUST.dave}"}', now() - interval '4 days', false, 'paid'),
  ('chk-void', '${LOC}', '[{"itemId":"item-pizza","qty":1,"cat":"cat-mains"}]', '${CUST.erin}', null, null, null, now(), true, 'voided'),
  ('demo-chk', '${LOC}', '[{"itemId":"item-pizza","qty":1,"cat":"cat-mains"}]', '${CUST.frank}', null, null, null, now(), false, 'paid'),
  ('chk-old', '${LOC}', '[{"itemId":"item-pizza","qty":1,"cat":"cat-mains"}]', '${CUST.gina}', null, null, null, now() - interval '200 days', false, 'paid'),
  ('chk-voidline', '${LOC}', '[{"itemId":"item-coffee","qty":1,"cat":"cat-drinks","voided":true}]', '${CUST.hal}', null, null, null, now(), false, 'paid'),
  ('chk-other', '44444444-4444-4444-4444-444444444444', '[{"itemId":"item-pizza","qty":1,"cat":"cat-mains"}]', '${CUST.other}', null, null, null, now(), false, 'paid');
insert into public.review_feedback (location_id, customer_name, customer_email, rating, comment, private_detail, is_public, status, source_platform, created_at) values
  ('${LOC}', 'Jane Smith', 'jane@x.com', 5, 'Lovely food', 'secret', true, 'approved', 'google', now() - interval '1 day'),
  ('${LOC}', 'Tom', 't@x.com', 4, 'Good', null, true, 'new', null, now() - interval '2 days'),
  ('${LOC}', 'Low Rater', 'l@x.com', 2, 'Meh', null, false, 'new', null, now()),
  ('${LOC}', 'Hidden', 'h@x.com', 5, 'Archived one', null, true, 'archived', null, now()),
  ('${LOC}', 'Quiet', 'q@x.com', 5, '', null, true, 'new', null, now()),
  ('44444444-4444-4444-4444-444444444444', 'Other Venue', 'o@x.com', 5, 'Not yours', null, true, 'new', null, now());
`;

test('resolver + item rules + reviews read against a real Postgres', { skip: !hasPg && 'no local Postgres (pg_ctl) on this machine' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mktv3-pg-'));
  const data = path.join(dir, 'data');
  const port = 54000 + Math.floor(Math.random() * 1000);
  const sock = dir;
  execFileSync(INITDB, ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8'], { stdio: 'ignore', env: PG_ENV });
  execFileSync(PG_CTL, ['-D', data, '-o', `-p ${port} -k ${sock} -c listen_addresses=''`, '-w', '-l', path.join(dir, 'pg.log'), 'start'], { stdio: 'ignore', env: PG_ENV });
  t.after(() => {
    try { execFileSync(PG_CTL, ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore', env: PG_ENV }); } catch { /* best effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  const sql = (text, { tuples = true } = {}) => {
    const r = spawnSync(PSQL, ['-h', sock, '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', ...(tuples ? ['-tA'] : [])], { input: text, encoding: 'utf8', env: PG_ENV });
    if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}\n--- sql ---\n${text.slice(0, 400)}`);
    return r.stdout.trim();
  };
  sql(STUBS);
  // the real view + segments table + the old resolver (slice 3), then the real v3 migration on top
  sql(SEGMENTS_MIGRATION);
  sql(SEED);
  sql(MIGRATION);

  const resolve = (def, limit = 'null') => sql(`select customer_id from public.marketing_resolve_segment('${ORG}', '${JSON.stringify(def).replace(/'/g, "''")}'::jsonb, ${limit}) order by 1`).split('\n').filter(Boolean);
  const names = (ids) => ids.map((id) => Object.entries(CUST).find(([, v]) => v === id)?.[0] || id).sort();

  // 1. an old flat definition, unchanged
  assert.deepEqual(names(resolve({ match: 'all', rules: [{ field: 'lifetime_revenue', op: 'gte', value: 250 }] })), ['alice']);
  assert.deepEqual(names(resolve({ match: 'any', rules: [{ field: 'visit_count', op: 'gte', value: 20 }, { field: 'days_since_visit', op: 'gte', value: 90 }] })), ['alice', 'hal']);
  assert.deepEqual(names(resolve({ match: 'all', rules: [{ field: 'source', op: 'in', value: ['qr', 'wifi'] }] })), []);
  assert.deepEqual(names(resolve({ match: 'all', rules: [{ field: 'has_email', op: 'is_true' }, { field: 'marketing_opt_in', op: 'is_true' }] })), ['alice', 'bob', 'erin', 'frank', 'gina', 'hal']);
  assert.equal(resolve({ match: 'all', rules: [] }).length, 8, 'empty definition = every customer in the org');
  assert.equal(resolve({ match: 'all', rules: [] }, 3).length, 3, 'limit honoured');

  // 2. items ordered, every channel, last 90 days: pizza (till, qr at the other venue, the large size by loyalty block)
  const pizza = { field: 'ordered_item', op: 'in', value: { items: ['item-pizza', 'item-pizza-b'], days: 90 } };
  assert.deepEqual(names(resolve({ match: 'all', rules: [pizza] })), ['alice', 'carol', 'dave']);
  // coffee: online check tied by email (case differs), the voided line does not count
  assert.deepEqual(names(resolve({ match: 'all', rules: [{ field: 'ordered_item', op: 'in', value: { items: ['item-coffee'], days: 30 } }] })), ['bob']);
  // the window: 400 days brings gina's old check in; the demo and voided checks never count
  assert.deepEqual(names(resolve({ match: 'all', rules: [{ field: 'ordered_item', op: 'in', value: { items: ['item-pizza'], days: 400 } }] })), ['alice', 'dave', 'gina']);
  // anything in a category
  assert.deepEqual(names(resolve({ match: 'all', rules: [{ field: 'ordered_category', op: 'in', value: { categories: ['cat-drinks'], days: 90 } }] })), ['bob']);
  assert.deepEqual(names(resolve({ match: 'all', rules: [{ field: 'ordered_category', op: 'in', value: { categories: ['cat-mains', 'cat-mains-b'], days: 90 } }] })), ['alice', 'carol', 'dave']);
  // did NOT order pizza
  assert.deepEqual(names(resolve({ match: 'all', rules: [{ field: 'ordered_item', op: 'not_in', value: { items: ['item-pizza', 'item-pizza-b'], days: 90 } }] })), ['bob', 'erin', 'frank', 'gina', 'hal']);
  // a missing days value falls back to 90
  assert.deepEqual(names(resolve({ match: 'all', rules: [{ field: 'ordered_item', op: 'in', value: { items: ['item-pizza'] } }] })), ['alice', 'dave']);

  // 3. nested groups: VIPs who ordered pizza OR lapsed customers with email
  const nested = { match: 'any', rules: [
    { match: 'all', rules: [{ field: 'lifetime_revenue', op: 'gte', value: 250 }, pizza] },
    { match: 'all', rules: [{ field: 'days_since_visit', op: 'gte', value: 90 }, { field: 'has_email', op: 'is_true' }] },
  ] };
  assert.deepEqual(names(resolve(nested)), ['alice', 'hal']);
  // three levels: all( any( all(vip, pizza), hal ), opt in )
  const three = { match: 'all', rules: [
    { match: 'any', rules: [
      { match: 'all', rules: [{ field: 'lifetime_revenue', op: 'gte', value: 250 }, pizza] },
      { field: 'customer_id', op: 'in', value: [CUST.hal] },
    ] },
    { field: 'marketing_opt_in', op: 'is_true' },
  ] };
  assert.deepEqual(names(resolve(three)), ['alice', 'hal']);
  // a fourth level is ignored (treated as no condition), so the third level group is empty = true
  const four = { match: 'all', rules: [{ match: 'all', rules: [{ match: 'all', rules: [{ match: 'all', rules: [{ field: 'lifetime_revenue', op: 'gte', value: 99999 }] }] }] }] };
  assert.equal(resolve(four).length, 8);
  // an empty group inside any
  assert.deepEqual(names(resolve({ match: 'any', rules: [{ match: 'all', rules: [] }] })).length, 8);

  // 4. customer_id list (what the loyalty rules expand to) and not_in
  assert.deepEqual(names(resolve({ match: 'all', rules: [{ field: 'customer_id', op: 'in', value: [CUST.bob, CUST.carol, CUST.other] }] })), ['bob', 'carol']);
  assert.deepEqual(names(resolve({ match: 'all', rules: [{ field: 'customer_id', op: 'not_in', value: [CUST.bob] }] })).length, 7);
  assert.deepEqual(names(resolve({ match: 'all', rules: [{ field: 'customer_id', op: 'in', value: [] }] })), []);

  // 5. injection attempts: a value, a field and an op
  const before = sql('select count(*) from public.customers');
  assert.deepEqual(resolve({ match: 'all', rules: [{ field: 'source', op: 'eq', value: "x') or true; drop table customers; --" }] }), []);
  assert.deepEqual(resolve({ match: 'all', rules: [{ field: 'source', op: 'contains', value: "%' or 1=1 --" }] }), []);
  assert.deepEqual(resolve({ match: 'all', rules: [{ field: 'source; drop table customers; --', op: 'eq', value: 1 }] }).length, 8, 'unknown field ignored');
  assert.deepEqual(resolve({ match: 'all', rules: [{ field: 'source', op: 'eq) or true or (1', value: 'x' }] }).length, 8, 'unknown op ignored');
  assert.deepEqual(resolve({ match: 'all', rules: [{ field: 'ordered_item', op: 'in', value: { items: ["x') or true--"], days: 7 } }] }), [], 'a bad item id is a bound value, nobody matches');
  assert.throws(() => resolve({ match: 'all', rules: [{ field: 'ordered_item', op: 'in', value: { items: ['item-pizza'], days: '7; drop table customers' } }] }), /invalid input syntax/, 'a bad days value is a bound cast that fails, never SQL');
  assert.deepEqual(resolve({ match: "any' or '1'='1", rules: [{ field: 'lifetime_revenue', op: 'gte', value: 250 }] }).length, 1, 'a bad match word reads as all');
  assert.equal(sql('select count(*) from public.customers'), before);
  // a string where a number is expected is refused, never silently matched
  assert.throws(() => resolve({ match: 'all', rules: [{ field: 'visit_count', op: 'gte', value: 'abc' }] }), /invalid input syntax/);

  // 6. the other org sees its own customers only
  assert.deepEqual(sql(`select customer_id from public.marketing_resolve_segment('${OTHER_ORG}', '${JSON.stringify({ match: 'all', rules: [pizza] })}'::jsonb, null)`).split('\n').filter(Boolean), [CUST.other]);

  // 7. the public reviews read
  const rows = sql(`select row_to_json(x) from public.review_feedback_public(array['${LOC}'], 4, 6) x`).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => [r.rating, r.comment, r.author, r.source]), [[5, 'Lovely food', 'Jane S.', 'google'], [4, 'Good', 'Tom', 'card']]);
  assert.ok(rows.every((r) => !('customer_email' in r) && !('private_detail' in r) && !('customer_id' in r)));
  assert.equal(sql(`select count(*) from public.review_feedback_public(array['${LOC}'], 5, 6)`), '1');
  assert.equal(sql(`select count(*) from public.review_feedback_public(array['${LOC}'], 1, 1)`), '1');
  assert.equal(sql(`select count(*) from public.review_feedback_public(array['44444444-4444-4444-4444-444444444444'], 4, 6)`), '1');
  // anon may call the reviews read, never the resolver or the buyers list
  assert.equal(sql(`select has_function_privilege('anon', 'public.review_feedback_public(text[], int, int)', 'execute')`), 't');
  assert.equal(sql(`select has_function_privilege('anon', 'public.marketing_resolve_segment(uuid, jsonb, int)', 'execute')`), 'f');
  assert.equal(sql(`select has_function_privilege('anon', 'public.marketing_item_buyers(uuid, text[], text[], int)', 'execute')`), 'f');

  // 8. the report reads run on an empty table and the website report groups days
  sql(`insert into public.campaigns (id, org_id, name) values ('cccccccc-0000-0000-0000-000000000001', '${ORG}', 'Pizza night')`);
  sql(`insert into public.marketing_link_clicks (org_id, message_id, campaign_id, customer_id, url) values ('${ORG}', gen_random_uuid(), 'cccccccc-0000-0000-0000-000000000001', '${CUST.alice}', 'https://a.test/menu'), ('${ORG}', gen_random_uuid(), 'cccccccc-0000-0000-0000-000000000001', '${CUST.alice}', 'https://a.test/menu'), ('${ORG}', gen_random_uuid(), 'cccccccc-0000-0000-0000-000000000001', '${CUST.bob}', 'https://a.test/book')`);
  const lr = JSON.parse(sql(`select public.marketing_link_report('${ORG}', now() - interval '1 day')`));
  assert.equal(lr.clicks, 3); assert.equal(lr.customers, 2);
  assert.equal(lr.campaigns[0].name, 'Pizza night'); assert.equal(lr.campaigns[0].links[0].url, 'https://a.test/menu'); assert.equal(lr.campaigns[0].links[0].clicks, 2);
  sql(`insert into public.website_visits (org_id, path, referrer, utm_source, campaign_id, visitor_key, created_at) values ('${ORG}', '/', 'google.com', null, null, 'v1', now()), ('${ORG}', '/menu', '', 'servos', 'cccccccc-0000-0000-0000-000000000001', 'v1', now()), ('${ORG}', '/menu', null, null, null, 'v2', now() - interval '1 day')`);
  const wr = JSON.parse(sql(`select public.website_report('${ORG}', now() - interval '3 days')`));
  assert.equal(wr.visits, 3); assert.equal(wr.visitors, 2); assert.equal(wr.from_campaigns, 1);
  assert.equal(wr.days.length, 2); assert.equal(wr.pages[0].path, '/menu'); assert.equal(wr.pages[0].visits, 2);
  assert.equal(wr.campaigns[0].name, 'Pizza night'); assert.equal(wr.campaigns[0].visits, 1);
  assert.ok(wr.referrers.some((r) => r.referrer === '(direct)' && r.visits === 2));

  // 9. the rollback leaves the old resolver signature and the tables gone, and runs twice
  const ROLLBACK = read('../../supabase/migrations/20261126a_OPS_marketing_v3_ROLLBACK.sql');
  sql(ROLLBACK); sql(ROLLBACK);
  assert.equal(sql(`select to_regclass('public.website_visits') is null`), 't');
  assert.equal(sql(`select to_regprocedure('public.marketing_resolve_segment(uuid, jsonb, int)') is not null`), 't');
  assert.deepEqual(names(resolve({ match: 'all', rules: [{ field: 'lifetime_revenue', op: 'gte', value: 250 }] })), ['alice'], 'the slice 3 resolver is back after rollback');
});
