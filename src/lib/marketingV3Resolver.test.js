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
// 5.12.68: the cluster, stubs and seed moved to marketingPgHarness.js (shared with the multisite test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasPg, startPg, ORG, OTHER_ORG, LOC, LOC2, CUST, STUBS, SEED } from './marketingPgHarness.js';

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

test('resolver + item rules + reviews read against a real Postgres', { skip: !hasPg && 'no local Postgres (pg_ctl) on this machine' }, (t) => {
  const sql = startPg(t);
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
