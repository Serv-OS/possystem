// src/lib/marketingPgHarness.js (6 Nov 2026, 5.12.68). The throwaway Postgres the marketing SQL
// tests run against: stub tables the migrations lean on, a seed of customers across two venues,
// and startPg(t) which boots a cluster for one test and stops it after. Shared by
// marketingV3Resolver.test.js and marketingMultisite.test.js. Without pg_ctl (GitHub) hasPg is
// false and the callers skip.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

function which(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  for (const p of ['/opt/homebrew/opt/postgresql@17/bin', '/opt/homebrew/bin', '/usr/local/bin']) {
    if (fs.existsSync(path.join(p, bin))) return path.join(p, bin);
  }
  return null;
}

// A Mac shell with no LANG makes the postmaster 'multithreaded during startup'; a plain C locale cures it.
export const PG_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };
const PG_CTL = which('pg_ctl');
const INITDB = which('initdb');
const PSQL = which('psql');
export const hasPg = !!(PG_CTL && INITDB && PSQL);

export const ORG = '11111111-1111-1111-1111-111111111111';
export const OTHER_ORG = '22222222-2222-2222-2222-222222222222';
export const LOC = '33333333-3333-3333-3333-333333333333';
export const LOC2 = '34333333-3333-3333-3333-333333333333';
export const CUST = {
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

export const STUBS = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create table public.user_locations (user_id uuid, location_id uuid);
create table public.marketing_messages (id uuid primary key default gen_random_uuid(), org_id uuid, campaign_id uuid, workflow_id uuid, customer_id uuid, channel text default 'email', opened_at timestamptz, clicked_at timestamptz, created_at timestamptz default now());
create table public.locations (id uuid primary key, org_id uuid, name text, timezone text default 'Europe/London', created_at timestamptz default now());
create table public.customers (id uuid primary key, org_id uuid, first_name text, last_name text, name text, email text, phone text, birthday date, marketing_opt_in boolean default true, source text, is_local boolean, created_at timestamptz default now(), deleted_at timestamptz);
create table public.customer_locations (customer_id uuid, location_id uuid, visit_count int default 0, lifetime_revenue numeric default 0, last_visit_at timestamptz, first_visit_at timestamptz);
create table public.closed_checks (id text primary key, location_id text, items jsonb default '[]', customer_id uuid, customer jsonb, customer_phone text, loyalty jsonb, closed_at timestamptz default now(), voided boolean default false, status text default 'paid', total numeric default 0);
create table public.menu_items (id text, location_id text, name text, cat text, parent_id text, archived boolean default false);
create table public.menu_categories (id text, location_id text, label text);
create table public.campaigns (id uuid primary key default gen_random_uuid(), org_id uuid, name text, status text default 'active');
create table public.workflows (id uuid primary key default gen_random_uuid(), org_id uuid, name text, status text default 'active');
create table public.promo_codes (id uuid primary key default gen_random_uuid(), org_id uuid, campaign_id uuid, offer_id uuid, code text);
create table public.promo_redemptions (id uuid primary key default gen_random_uuid(), org_id uuid, promo_code_id uuid, code text, order_id text, offer_id uuid, discount_value numeric default 0, location_id text not null, redeemed_at timestamptz default now());
create table public.workflow_step_sends (id uuid primary key default gen_random_uuid(), org_id uuid, workflow_id uuid, email_message_id uuid, sms_message_id uuid, promo_code text, status text default 'sent', created_at timestamptz default now());
create table public.review_feedback (id uuid primary key default gen_random_uuid(), location_id text, customer_name text, customer_email text, customer_phone text, customer_id uuid, rating smallint, comment text, private_detail text, is_public boolean, status text default 'new', source_platform text, created_at timestamptz default now());
create function public.user_accessible_orgs() returns setof text language sql stable as $$ select null::text where false $$;
create function public._sales_is_demo(p_id text) returns boolean language sql immutable as $$ select coalesce(left(p_id, 5) = 'demo-', false) $$;
create function public.stock_js_truthy(j jsonb) returns boolean language sql immutable as $$
  select case jsonb_typeof(j) when 'boolean' then (j #>> '{}')::boolean when 'number' then (j #>> '{}')::numeric <> 0 when 'string' then (j #>> '{}') <> '' when 'null' then false else j is not null end $$;
create function public.stock_js_key(j jsonb) returns text language sql immutable as $$
  select case jsonb_typeof(j) when 'string' then nullif(j #>> '{}', '') when 'number' then j #>> '{}' else null end $$;
`;

export const SEED = `
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


/** Boot a cluster for one test; returns sql(text, {tuples}) that throws on any error. */
export function startPg(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-pg-'));
  const data = path.join(dir, 'data');
  const port = 54000 + Math.floor(Math.random() * 1000);
  const sock = dir;
  execFileSync(INITDB, ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8'], { stdio: 'ignore', env: PG_ENV });
  execFileSync(PG_CTL, ['-D', data, '-o', `-p ${port} -k ${sock} -c listen_addresses=''`, '-w', '-l', path.join(dir, 'pg.log'), 'start'], { stdio: 'ignore', env: PG_ENV });
  t.after(() => {
    try { execFileSync(PG_CTL, ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore', env: PG_ENV }); } catch { /* best effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return (text, { tuples = true } = {}) => {
    const r = spawnSync(PSQL, ['-h', sock, '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', ...(tuples ? ['-tA'] : [])], { input: text, encoding: 'utf8', env: PG_ENV });
    if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}\n--- sql ---\n${text.slice(0, 400)}`);
    return r.stdout.trim();
  };
}
