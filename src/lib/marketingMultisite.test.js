// marketingMultisite.test.js (6 Nov 2026, 5.12.68): marketing split by venue, run for real.
//
// Peter: "we dont have multi site for marketing where someone can see all marketing data in one
// place ... support much more multi site functions". The SQL is 20261127a_OPS_marketing_multisite.sql.
// With a local Postgres (pg_ctl on the PATH) this boots a cluster, loads the stubs, the real
// customer_rfm view, the real v3 migration and then the multisite one, and proves:
//   - "visited venue X (in the last N days)" and "home venue is X" rules, alone and nested,
//   - a foreign venue id matches nobody, a bad days value throws, a not_in works,
//   - marketing_report_sites splits sent/opened/clicked by home venue and redeemed/revenue by the
//     venue where the code was used, for campaigns and automations, with unassigned counted,
//   - website_report(org, since, host) filters one site and always lists every site,
//   - the rollback runs twice, restores the two argument website_report, ignores venue rules again,
//     and the migration installs again after it (safe to run twice).
// Without pg_ctl (GitHub) the Postgres test is skipped; the text checks still run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasPg, startPg, ORG, OTHER_ORG, LOC, LOC2, CUST, STUBS, SEED } from './marketingPgHarness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, p), 'utf8');
const MIGRATION = read('../../supabase/migrations/20261127a_OPS_marketing_multisite.sql');
const ROLLBACK = read('../../supabase/migrations/20261127a_OPS_marketing_multisite_ROLLBACK.sql');
const V3 = read('../../supabase/migrations/20261126a_OPS_marketing_v3.sql');
const SEGMENTS_MIGRATION = read('../../supabase/migrations/20260616c_marketing_segments.sql');

test('multisite migration: ASCII only, rollback twin, no transaction words, guarded, revoked', () => {
  for (const [name, text] of [['migration', MIGRATION], ['rollback', ROLLBACK]]) {
    assert.equal(/[^ -~\n\r\t]/.test(text), false, `${name} is plain ASCII`);
    assert.doesNotMatch(text, /^\s*(begin|commit);/mi, `${name} has no transaction words`);
    assert.match(text, /This is the OPS (migration|rollback)/, `${name} is guarded to Ops`);
  }
  assert.match(MIGRATION, /Run 20261126a_OPS_marketing_v3\.sql first/);
  for (const fn of ['marketing_venue_customers(uuid, text[], int, text)', 'marketing_report_sites(uuid, timestamptz)', 'website_report(uuid, timestamptz, text)']) {
    assert.ok(MIGRATION.includes(`revoke all on function public.${fn} from public, anon, authenticated;`), `${fn} revoked`);
  }
  assert.ok(MIGRATION.includes('p_host text)\nreturns jsonb') && !MIGRATION.includes('p_host text default'), 'no default on the third argument: the two forms never collide');
  assert.ok(MIGRATION.includes('select public.website_report(p_org, p_since, null::text)'), 'the two argument wrapper');
  assert.doesNotMatch(MIGRATION, /quote_literal\(/, 'values are bound, never pasted');
  // the venue branch reads venues and days from the bound definition and fixes the mode word itself
  assert.ok(MIGRATION.includes("case when v_field = 'home_venue' then '''home''' else '''visited''' end"));
});

const OTHER_LOC = '44444444-4444-4444-4444-444444444444';
const C1 = 'cccccccc-0000-0000-0000-000000000001';
const W1 = 'dddddddd-0000-0000-0000-000000000001';
const PC1 = 'eeeeeeee-0000-0000-0000-000000000001';

const EXTRA_SEED = `
update public.locations set name = 'Leeds' where id = '${LOC}';
update public.locations set name = 'Hudds' where id = '${LOC2}';
update public.locations set name = 'Elsewhere' where id = '${OTHER_LOC}';
insert into public.customer_locations (customer_id, location_id, visit_count, lifetime_revenue, last_visit_at) values
  ('${CUST.alice}', '${LOC2}', 5, 100, now() - interval '2 days'),
  ('${CUST.carol}', '${LOC2}', 10, 200, now() - interval '1 day'),
  ('${CUST.gina}', '${LOC2}', 2, 30, now() - interval '10 days'),
  ('${CUST.gina}', '${OTHER_LOC}', 99, 9999, now());
update public.closed_checks set total = 50 where id = 'chk-till';
update public.closed_checks set total = 30 where id = 'chk-qr';
update public.closed_checks set total = 20 where id = 'chk-loyalty';
insert into public.campaigns (id, org_id, name) values ('${C1}', '${ORG}', 'Pizza night');
insert into public.workflows (id, org_id, name) values ('${W1}', '${ORG}', 'Welcome');
insert into public.marketing_messages (id, org_id, campaign_id, customer_id, opened_at, clicked_at) values
  ('11111111-aaaa-0000-0000-000000000001', '${ORG}', '${C1}', '${CUST.alice}', now(), null),
  ('11111111-aaaa-0000-0000-000000000002', '${ORG}', '${C1}', '${CUST.bob}', null, null),
  ('11111111-aaaa-0000-0000-000000000003', '${ORG}', '${C1}', '${CUST.carol}', now(), now()),
  ('11111111-aaaa-0000-0000-000000000004', '${ORG}', '${C1}', '${CUST.erin}', null, null),
  ('11111111-aaaa-0000-0000-000000000005', '${ORG}', null, '${CUST.dave}', now(), null);
insert into public.promo_codes (id, org_id, campaign_id, code) values ('${PC1}', '${ORG}', '${C1}', 'PIZZA1');
insert into public.promo_redemptions (org_id, promo_code_id, code, order_id, discount_value, location_id) values
  ('${ORG}', '${PC1}', 'PIZZA1', 'chk-till', 5, '${LOC}'),
  ('${ORG}', '${PC1}', 'PIZZA1', 'chk-qr', 3, '${LOC2}'),
  ('${ORG}', null, 'WF1', 'chk-loyalty', 2, '${LOC2}');
insert into public.marketing_messages (id, org_id, workflow_id, customer_id, channel) values ('11111111-aaaa-0000-0000-000000000006', '${ORG}', '${W1}', '${CUST.hal}', 'sms');
insert into public.workflow_step_sends (org_id, workflow_id, email_message_id, sms_message_id, promo_code, status) values
  ('${ORG}', '${W1}', '11111111-aaaa-0000-0000-000000000005', null, 'WF1', 'sent'),
  ('${ORG}', '${W1}', null, '11111111-aaaa-0000-0000-000000000006', null, 'sent'),
  ('${ORG}', '${W1}', null, null, null, 'failed');
insert into public.website_visits (org_id, location_id, host, path, visitor_key, campaign_id, created_at) values
  ('${ORG}', '${LOC}', 'leeds.test', '/', 'v1', null, now()),
  ('${ORG}', '${LOC}', 'leeds.test', '/menu', 'v1', '${C1}', now()),
  ('${ORG}', '${LOC2}', 'hudds.test', '/', 'v2', null, now() - interval '1 day'),
  ('${OTHER_ORG}', '${OTHER_LOC}', 'other.test', '/', 'v9', null, now());
`;

test('venue rules, per venue report and site filtered website report against a real Postgres', { skip: !hasPg && 'no local Postgres (pg_ctl) on this machine' }, (t) => {
  const sql = startPg(t);
  sql(STUBS); sql(SEGMENTS_MIGRATION); sql(SEED); sql(V3); sql(EXTRA_SEED);
  sql(MIGRATION);

  const resolve = (def) => sql(`select customer_id from public.marketing_resolve_segment('${ORG}', '${JSON.stringify(def).replace(/'/g, "''")}'::jsonb, null) order by 1`).split('\n').filter(Boolean);
  const names = (ids) => ids.map((id) => Object.entries(CUST).find(([, v]) => v === id)?.[0] || id).sort();
  const venue = (venues, days, op = 'in') => ({ field: 'venue', op, value: days ? { venues, days } : { venues } });
  const home = (venues, op = 'in') => ({ field: 'home_venue', op, value: { venues } });

  // 1. visited a venue, any time / in the last 30 days
  assert.deepEqual(names(resolve({ match: 'all', rules: [venue([LOC])] })), ['alice', 'bob', 'carol', 'dave', 'hal']);
  assert.deepEqual(names(resolve({ match: 'all', rules: [venue([LOC], 30)] })), ['alice', 'bob', 'carol', 'dave'], 'hal last came 120 days ago');
  assert.deepEqual(names(resolve({ match: 'all', rules: [venue([LOC2])] })), ['alice', 'carol', 'gina']);
  assert.deepEqual(names(resolve({ match: 'all', rules: [venue([LOC, LOC2], 30)] })), ['alice', 'bob', 'carol', 'dave', 'gina']);
  // 2. home venue: the venue they visit most
  assert.deepEqual(names(resolve({ match: 'all', rules: [home([LOC2])] })), ['carol', 'gina'], 'carol 10 at Hudds vs 3 at Leeds; gina only Hudds in this org');
  assert.deepEqual(names(resolve({ match: 'all', rules: [home([LOC])] })), ['alice', 'bob', 'dave', 'hal']);
  assert.deepEqual(names(resolve({ match: 'all', rules: [home([LOC2], 'not_in')] })), ['alice', 'bob', 'dave', 'erin', 'frank', 'hal']);
  // 3. a foreign venue (other org) or rubbish matches nobody; a bad days value throws, never injects
  assert.deepEqual(resolve({ match: 'all', rules: [venue([OTHER_LOC])] }), []);
  assert.deepEqual(resolve({ match: 'all', rules: [venue(["x' or 1=1 --"])] }), []);
  assert.throws(() => resolve({ match: 'all', rules: [{ field: 'venue', op: 'in', value: { venues: [LOC], days: '1; drop table customers' } }] }), /invalid input syntax/);
  assert.equal(sql('select count(*) from public.customers'), '9', 'table intact');
  // 4. nested with other rules
  assert.deepEqual(names(resolve({ match: 'any', rules: [home([LOC2]), { match: 'all', rules: [venue([LOC], 30), { field: 'lifetime_revenue', op: 'gte', value: 250 }] }] })), ['alice', 'carol', 'gina']);
  // 5. an item rule and a venue rule together (both every channel helpers)
  assert.deepEqual(names(resolve({ match: 'all', rules: [venue([LOC]), { field: 'ordered_item', op: 'in', value: { items: ['item-pizza', 'item-pizza-b'], days: 90 } }] })), ['alice', 'carol', 'dave']);
  // 6. the other org sees none of ours
  assert.deepEqual(sql(`select customer_id from public.marketing_resolve_segment('${OTHER_ORG}', '${JSON.stringify({ match: 'all', rules: [venue([LOC])] })}'::jsonb, null)`), '');

  // 7. the per venue marketing report
  const r = JSON.parse(sql(`select public.marketing_report_sites('${ORG}', now() - interval '1 day')`));
  const byName = Object.fromEntries(r.venues.map((v) => [v.name, v]));
  assert.deepEqual(Object.keys(byName).sort(), ['Hudds', 'Leeds']);
  // Leeds: alice (opened) + bob by home venue, dave's automation step (opened); redeemed at Leeds: alice's PIZZA1 on a 50 order
  assert.equal(byName.Leeds.sent, 4, 'alice, bob, dave and the sms to hal'); assert.equal(byName.Leeds.opened, 2); assert.equal(byName.Leeds.clicked, 0);
  assert.equal(byName.Leeds.redeemed, 1); assert.equal(Number(byName.Leeds.revenue), 50); assert.equal(Number(byName.Leeds.discount), 5);
  // Hudds: carol (opened, clicked) by home venue; redeemed at Hudds: carol's PIZZA1 (30) and the automation code WF1 (20)
  assert.equal(byName.Hudds.sent, 1); assert.equal(byName.Hudds.opened, 1); assert.equal(byName.Hudds.clicked, 1);
  assert.equal(byName.Hudds.redeemed, 2); assert.equal(Number(byName.Hudds.revenue), 50); assert.equal(Number(byName.Hudds.discount), 5);
  assert.equal(r.unassigned.sent, 1, 'erin has no venue yet'); assert.equal(r.unassigned.redeemed, 0);
  assert.equal(r.campaigns.length, 1); assert.equal(r.campaigns[0].name, 'Pizza night');
  const cv = Object.fromEntries(r.campaigns[0].venues.map((v) => [v.name, v]));
  assert.equal(cv.Leeds.sent, 2); assert.equal(cv.Leeds.redeemed, 1); assert.equal(Number(cv.Leeds.revenue), 50);
  assert.equal(cv.Hudds.sent, 1); assert.equal(cv.Hudds.clicked, 1); assert.equal(cv.Hudds.redeemed, 1); assert.equal(Number(cv.Hudds.revenue), 30);
  assert.equal(r.workflows.length, 1);
  const wv = Object.fromEntries(r.workflows[0].venues.map((v) => [v.name, v]));
  assert.equal(wv.Leeds.sent, 2, 'the email step and the sms only step'); assert.equal(wv.Leeds.opened, 1); assert.equal(wv.Leeds.redeemed, 0);
  assert.equal(wv.Hudds.sent, 0); assert.equal(wv.Hudds.redeemed, 1); assert.equal(Number(wv.Hudds.revenue), 20);
  assert.equal(JSON.parse(sql(`select public.marketing_report_sites('${OTHER_ORG}', now() - interval '1 day')`)).venues[0].sent, 0, 'the other org sees only its own venue, empty');

  // 8. website report: all sites, one site
  const wa = JSON.parse(sql(`select public.website_report('${ORG}', now() - interval '3 days')`));
  assert.equal(wa.visits, 3); assert.equal(wa.host, null);
  assert.deepEqual(wa.sites.map((s) => [s.host, s.name, s.visits, s.from_campaigns]), [['leeds.test', 'Leeds', 2, 1], ['hudds.test', 'Hudds', 1, 0]]);
  const wh = JSON.parse(sql(`select public.website_report('${ORG}', now() - interval '3 days', 'hudds.test')`));
  assert.equal(wh.visits, 1); assert.equal(wh.host, 'hudds.test'); assert.equal(wh.sites.length, 2, 'the picker still lists every site');
  assert.deepEqual(wh.pages.map((p) => p.path), ['/']);
  assert.equal(JSON.parse(sql(`select public.website_report('${ORG}', now() - interval '3 days', 'nosuch.test')`)).visits, 0);

  // 9. privileges: nothing new for anon or authenticated
  for (const role of ['anon', 'authenticated']) {
    for (const fn of ['marketing_venue_customers(uuid, text[], int, text)', 'marketing_report_sites(uuid, timestamptz)', 'website_report(uuid, timestamptz, text)']) {
      assert.equal(sql(`select has_function_privilege('${role}', 'public.${fn}', 'execute')`), 'f', `${role} cannot run ${fn}`);
    }
  }

  // 10. safe to run twice; 20261126a run again on top keeps the two argument call working; then this again
  sql(MIGRATION);
  sql(V3);
  assert.equal(JSON.parse(sql(`select public.website_report('${ORG}', now() - interval '3 days')`)).visits, 3, 'two argument call still answers after 20261126a is re-run');
  sql(MIGRATION);
  assert.equal(JSON.parse(sql(`select public.website_report('${ORG}', now() - interval '3 days')`)).sites.length, 2, 'and the sites list is back');
  assert.deepEqual(names(resolve({ match: 'all', rules: [home([LOC2])] })), ['carol', 'gina']);
  sql(ROLLBACK); sql(ROLLBACK);
  assert.equal(sql("select to_regprocedure('public.website_report(uuid, timestamptz)') is not null"), 't');
  assert.equal(sql("select to_regprocedure('public.website_report(uuid, timestamptz, text)') is null"), 't');
  assert.equal(sql("select to_regprocedure('public.marketing_venue_customers(uuid, text[], int, text)') is null"), 't');
  assert.equal(resolve({ match: 'all', rules: [home([LOC2])] }).length, 8, 'after rollback a venue rule is ignored: everyone in the org');
  assert.deepEqual(names(resolve({ match: 'all', rules: [{ field: 'ordered_item', op: 'in', value: { items: ['item-pizza', 'item-pizza-b'], days: 90 } }] })), ['alice', 'carol', 'dave'], 'the v3 item rule still works');
  sql(MIGRATION);
  assert.deepEqual(names(resolve({ match: 'all', rules: [home([LOC2])] })), ['carol', 'gina'], 'installed again after rollback');
});
