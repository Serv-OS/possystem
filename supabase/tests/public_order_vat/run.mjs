#!/usr/bin/env node
// run.mjs: proves 20261009a (the server books the VAT of a public order itself) on a local,
// throwaway PostgreSQL 17, with the REAL function texts, before Peter runs it on the Ops database.
//
//   node supabase/tests/public_order_vat/run.mjs
//
// It never connects to Supabase. It starts its own cluster in a temp folder (initdb, pg_ctl from
// PATH or /opt/homebrew/bin) unless VAT_PGHOST / VAT_PGPORT name a running local server, and stops
// it at the end. What it proves, in order:
//   1. the live versions of _public_order_check_row (20261002b) and settle_qr_tab (20260927c), as
//      read from the Ops database on 8 Oct 2026 (live/*.sql), install with the md5 the guard expects;
//   2. the migration applies as the SQL editor runs it (one transaction, ON_ERROR_STOP), its self
//      test block included, and its visible check answers true;
//   3. D8: the 14 live QR sales of the audit re derive through _public_order_vat against the live
//      menu rows and rates (fixtures/*.json): 12 to the stored penny, QR-4OGI7 to 0.81, QR-186RY
//      to 0.98 (stored 0.97: a half penny the 2 Oct backfill rounded down);
//   4. D8: 200 recent till sales (1 to 8 Oct 2026, five venues, dine-in, takeaway and drive thru,
//      13 with a discount) re derive from their lines, each venue's rates and menu rows, with the
//      share of the goods charged, and the match rate is printed with every miss explained;
//   5. settle_qr_tab end to end: a tab with no figure from the phone books the server's VAT and
//      says so; a figure within 1p is kept; a round with an automatic deal scales the VAT, and a
//      deal landing on a half penny rounds up as the till does (8 Oct 2026 review);
//   6. the ROLLBACK file puts both functions back byte for byte (md5) and drops the helpers.
// Exit code 0 only when everything above holds.

import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const MIGRATION = join(repo, 'supabase/migrations/20261009a_OPS_public_order_vat_server.sql');
const ROLLBACK = join(repo, 'supabase/migrations/20261009a_OPS_public_order_vat_server_ROLLBACK.sql');
const LIVE_MD5 = { check_row: '767b8354a392322aaa6857055cbf9961', settle: '6a335ccfad4f783e2a9cb9b88928c1bb' };

const bin = (name) => (existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', PGOPTIONS: '-c client_min_messages=warning' };

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ok   ${msg}`); else { failures++; console.log(`  FAIL ${msg}`); } };

// ── the cluster ──────────────────────────────────────────────────────────────
let own = null;
let host = process.env.VAT_PGHOST;
let port = process.env.VAT_PGPORT || '55441';
if (!host) {
  const dir = mkdtempSync(join(tmpdir(), 'pgv.'));   // short path: the socket lives here
  const data = join(dir, 'data');
  let r = spawnSync(bin('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
  r = spawnSync(bin('pg_ctl'), ['-D', data, '-l', join(dir, 'pg.log'), '-w', '-o', `-p ${port} -c listen_addresses='' -k ${dir}`, 'start'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
  own = { dir, data };
  host = dir;
}
const DB = 'vat_test_' + Date.now();

function psql(args, { input, db = DB, allowFail = false } = {}) {
  const r = spawnSync(bin('psql'), ['-h', host, '-p', port, '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-X', '-q', ...args], { env, input, encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) {
    console.error('psql failed:', args.join(' '), '\n', r.stderr || r.stdout);
    stop(); process.exit(2);
  }
  return r;
}
const sql = (q, opts) => psql(['-At', '-c', q], opts).stdout.trim();
const sqlJson = (q, opts) => { const out = sql(q, opts); return out ? JSON.parse(out) : null; };
const file = (path, opts) => psql(['-1', '-f', path], opts);
function stop() {
  if (!own) return;
  spawnSync(bin('pg_ctl'), ['-D', own.data, '-m', 'fast', '-w', 'stop'], { env, encoding: 'utf8' });
  rmSync(own.dir, { recursive: true, force: true });
  own = null;
}

const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const jlit = (v) => `${lit(JSON.stringify(v))}::jsonb`;

try {
  psql(['-c', `create database ${DB}`], { db: 'postgres' });
  console.log('1. schema, live function texts, fixtures');
  file(join(here, 'live/_fence_helpers.sql'));   // the valuer stub in schema.sql reads _fence_num
  file(join(here, 'schema.sql'));
  file(join(here, 'live/_public_order_check_row.20261002b.sql'));
  file(join(here, 'live/settle_qr_tab.20260927c.sql'));
  sql(`revoke all on function public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
       grant execute on function public.settle_qr_tab(uuid, text, jsonb, uuid[]) to anon, authenticated;`);
  const md5s = sqlJson(`select jsonb_build_object(
      'check_row', (select md5(prosrc) from pg_proc where oid = 'public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb)'::regprocedure),
      'settle', (select md5(prosrc) from pg_proc where oid = 'public.settle_qr_tab(uuid, text, jsonb, uuid[])'::regprocedure))`);
  ok(md5s.check_row === LIVE_MD5.check_row, `_public_order_check_row installs as the live 20261002b text (md5 ${md5s.check_row})`);
  ok(md5s.settle === LIVE_MD5.settle, `settle_qr_tab installs as the live 20260927c text (md5 ${md5s.settle})`);

  const rates = JSON.parse(readFileSync(join(here, 'fixtures/tax_rates.json'), 'utf8'));
  const menu = JSON.parse(readFileSync(join(here, 'fixtures/menu_items.json'), 'utf8'));
  const qr14 = JSON.parse(readFileSync(join(here, 'fixtures/qr14.json'), 'utf8'));
  const till = JSON.parse(readFileSync(join(here, 'fixtures/till200.json'), 'utf8'));
  const locs = new Set([...rates.map((r) => r.location_id), ...menu.map((m) => m.location_id)]);
  const seed = [];
  for (const id of locs) seed.push(`insert into public.locations (id, name) values (${lit(id)}, ${lit(id)});`);
  for (const t of rates) seed.push(`insert into public.tax_rates (id, location_id, name, code, rate, type, applies_to, is_default, active) values (${lit(t.id)}, ${lit(t.location_id)}, ${lit(t.name)}, ${lit(t.code)}, ${t.rate}, ${lit(t.type)}, ${lit('{' + (t.applies_to || ['all']).join(',') + '}')}::text[], ${t.is_default}, ${t.active});`);
  for (const m of menu) seed.push(`insert into public.menu_items (id, location_id, name, parent_id, archived, tax_rate_id, tax_overrides, tax_profile_id) values (${lit(m.id)}, ${lit(m.location_id)}, ${lit(m.name)}, ${lit(m.parent_id)}, ${m.archived}, ${lit(m.tax_rate_id)}, ${jlit(m.tax_overrides || {})}, ${lit(m.tax_profile_id)});`);
  const seedPath = join(own ? own.dir : tmpdir(), 'seed.sql');
  writeFileSync(seedPath, seed.join('\n'));
  file(seedPath);
  ok(Number(sql('select count(*) from public.tax_rates')) === rates.length, `${rates.length} live tax rates seeded`);
  ok(Number(sql('select count(*) from public.menu_items')) === menu.length, `${menu.length} live menu rows seeded (the rows the sales name, and their parents)`);

  console.log('2. the migration, as the SQL editor runs it (one transaction, stop on error)');
  const applied = file(MIGRATION, { allowFail: true });
  ok(applied.status === 0, 'migration applied, self test block included' + (applied.status ? `\n${applied.stderr}` : ''));
  if (applied.status !== 0) throw new Error('migration failed');
  const check = sqlJson(`select to_jsonb(x) from (${readFileSync(MIGRATION, 'utf8').split('-- VISIBLE CHECK')[1].split('\n').slice(2).join('\n').replace(/;\s*$/, '')}) x`);
  ok(check.check_row_is_new && check.settle_tab_is_new && check.half_penny_rounds_up && Number(check.qr_4ogi7_books) === 0.81
     && check.check_row_not_callable_from_a_phone && check.settle_tab_still_callable_by_the_phone, `visible check: ${JSON.stringify(check)}`);
  const second = file(MIGRATION, { allowFail: true });
  ok(second.status === 0, 'the migration runs a second time (its own version passes the guard)');

  console.log('3. D8: the 14 live QR sales of the audit');
  let exact = 0;
  for (const s of qr14) {
    const r = sqlJson(`select public._public_order_vat(${lit(s.location_id)}, ${jlit(s.items)}, ${lit(s.order_type)}, 1)`);
    const got = Number(r.total_tax);
    const want = s.ref === 'QR-4OGI7' ? 0.81 : s.ref === 'QR-186RY' ? 0.98 : s.tax_amount;
    const note = s.ref === 'QR-4OGI7' ? ' (booked NULL on 8 Oct, the fault; the owner wrote 0.81 onto the record the same day)' : s.ref === 'QR-186RY' ? ' (stored 0.97: a half penny, rounded down by the 2 Oct backfill; half up is the one rule)' : '';
    if (got === s.tax_amount) exact++;
    ok(got === want && !r.record.fallbacks && r.profiles_in_use === false, `${s.ref} ${s.venue} ${s.total.toFixed(2)} -> ${got.toFixed(2)} (stored ${s.tax_amount == null ? 'NULL' : s.tax_amount.toFixed(2)})${note}`);
  }
  ok(exact === 13, `${exact} of 14 equal their stored VAT exactly (the other one is the half penny, QR-186RY)`);

  console.log('4. D8: 200 recent till sales re derived from their lines');
  const misses = [];
  let hit = 0, onePenny = 0;
  for (const s of till) {
    // The till's share: the goods charged (item and check discounts off) over the goods at menu price;
    // loyalty and promo credits are tenders and leave the VAT alone (payments/checkTotals.js).
    const goods = s.items.filter((i) => !i.voided).reduce((a, i) => a + i.price * (i.qty || 1), 0);
    const lineOff = s.items.filter((i) => !i.voided && i.discount).reduce((a, i) => {
      const base = i.price * (i.qty || 1);
      return a + (i.discount.type === 'percent' ? base * Number(i.discount.value) / 100 : Number(i.discount.value) || 0);
    }, 0);
    const checkOff = (s.discounts || []).reduce((a, d) => a + (Number(d.amount) || 0), 0);
    const share = goods > 0 ? Math.max(0, Math.min(1, (goods - lineOff - checkOff) / goods)) : 1;
    // 8 Oct 2026 (review): the share goes to SQL as an exact ratio of pence (what the server itself
    // derives from order_pricing goods_minor and auto_minor), never as a JS float. 7.47 / 8.30 in JS
    // is 0.9000000000000001, which masked a half penny the server rounded down.
    const goodsPence = Math.round(goods * 100);
    const chargedPence = Math.max(0, Math.min(goodsPence, Math.round((goods - lineOff - checkOff) * 100)));
    const shareSql = goodsPence > 0 ? `${chargedPence}::numeric / ${goodsPence}::numeric` : '1';
    // A till line's price already INCLUDES its modifiers (the store folds them in; mods ride along
    // for display), unlike an order_queue line, so the mods are not passed again.
    const lines = s.items.map((i) => ({ itemId: i.itemId, parentId: i.parentId, name: i.name, price: i.price, qty: i.qty, voided: i.voided, mods: [] }));
    const r = sqlJson(`select public._public_order_vat(${lit(s.location_id)}, ${jlit(lines)}, ${lit(s.order_type)}, ${shareSql})`);
    const got = Number(r.total_tax);
    if (got === s.tax_amount) hit++;
    else {
      // Every known miss is the server ONE PENNY ABOVE the till: the sale sits on a half penny
      // (10.05 at 20% is exactly 1.675; 9.99 charged for 11.10 of goods is 1.85 x 0.9 = 1.665) and
      // the till of 1 to 8 Oct stored a float rounded DOWN (1.6749999999999998 -> 1.67). The one
      // rounding rule (D3, half up, in the till since Lane A) gives 1.68, as the server does.
      const upOne = Math.abs(got - s.tax_amount - 0.01) < 1e-9;
      const why = upOne ? `half penny: the till stored the float ${s.stored_total_tax} rounded down, the one rule rounds up` : 'MISS';
      if (upOne) onePenny++;
      misses.push({ ref: s.ref, type: s.order_type, total: s.total, stored: s.tax_amount, got, share: +share.toFixed(4), storedShare: s.share, fallbacks: r.record?.fallbacks || null, why });
    }
  }
  console.log(`  ${hit} of ${till.length} equal to the penny; ${onePenny} one penny above (half pennies); ${misses.length - onePenny} further off`);
  for (const m of misses) console.log(`  - ${m.ref} ${m.type} total ${m.total} stored ${m.stored} got ${m.got} share ${m.share} (till ${m.storedShare ?? 1}): ${m.why}${m.fallbacks ? ' fallbacks ' + JSON.stringify(m.fallbacks) : ''}`);
  ok(misses.every((m) => m.why !== 'MISS'), 'every till sale re derives to the penny or sits on a half penny (one penny above, never below, never further)');
  ok(hit >= till.length * 0.9, `match rate ${(hit / till.length * 100).toFixed(1)}% (at least 90% exact)`);

  console.log('5. settle_qr_tab end to end (Preston, dine-in)');
  const PRESTON = 'ab45c80b-416d-4631-93e2-05048e52e0fa';
  const uid = '00000000-0000-4000-8000-000000000001';
  const cooler = { itemId: 'm-1790046914854_8e52e0fa', name: 'Mixed Berry Cooler', price: 4.85, qty: 1, mods: [] };
  const cookie = { itemId: 'm-impmumnjwf6-1_8e52e0fa', name: 'Kinder Cookie', price: 3.5, qty: 2, mods: [{ price: 0.5 }] };   // 2 x 4.00
  const openTab = (pi, rounds) => {
    const stmts = [];
    let total = 0;
    rounds.forEach((rd, i) => {
      const goods = rd.items.reduce((a, it) => a + (it.price + (it.mods || []).reduce((m, x) => m + x.price, 0)) * it.qty, 0);
      const value = goods - (rd.auto || 0);
      total += value + (rd.tip || 0);
      const customer = { tab_open: true, payment_intent_id: pi, tab_ref: `TAB-${pi}`, tableLabel: '4', processor: 'adyen', tip: rd.tip || 0,
        order_pricing: { goods_minor: Math.round(goods * 100), auto_minor: Math.round((rd.auto || 0) * 100), value_minor: Math.round(value * 100) } };
      stmts.push(`insert into public.order_queue (ref, location_id, type, customer, items, total, status, source, paid, created_at)
        values (${lit(`R-${pi}-${i}`)}, ${lit(PRESTON)}, 'dine-in', ${jlit(customer)}, ${jlit(rd.items)}, ${value + (rd.tip || 0)}, 'prep', 'qr', false, now() + interval '${i} second');`);
    });
    stmts.push(`insert into public.payment_proofs (location_id, kind, payment_ref, amount_minor) values (${lit(PRESTON)}, 'capture', ${lit(pi)}, ${Math.round(total * 100)});`);
    sql(stmts.join('\n'));
    return total;
  };
  const settle = (pi, check) => sqlJson(`set local role authenticated; select set_config('test.uid', ${lit(uid)}, true); select public.settle_qr_tab(${lit(PRESTON)}, ${lit(pi)}, ${jlit(check)}, '{}'::uuid[]);`.replace(/;\s*select public\.settle/, '; select public.settle'), { allowFail: false });
  // (one statement string with set local needs a transaction: use -1 through a file)
  const settleViaFile = (pi, check) => {
    const p = join(own ? own.dir : tmpdir(), `settle_${pi}.sql`);
    writeFileSync(p, `select set_config('test.uid', ${lit(uid)}, false);\nselect public.settle_qr_tab(${lit(PRESTON)}, ${lit(pi)}, ${jlit(check)}, '{}'::uuid[]);\n`);
    const r = psql(['-At', '-f', p]);
    const lines = r.stdout.trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
  };
  void settle;
  // (a) no figure from the phone: the server's VAT, said so. 4.85 + 2 x 4.00 = 12.85 at 20% -> 2.1417 -> 2.14
  openTab('pi_a', [{ items: [cooler] }, { items: [cookie], tip: 1 }]);
  let res = settleViaFile('pi_a', { table_label: 'Table 4' });
  let row = sqlJson(`select to_jsonb(c) from public.closed_checks c where c.id = ${lit(res.check_id)}`);
  ok(res.ok === true && Number(row.total) === 13.85 && Number(row.tip) === 1 && Number(row.subtotal) === 12.85, `tab closed: total 13.85, tip 1.00, goods 12.85 (${JSON.stringify({ total: row.total, tip: row.tip, subtotal: row.subtotal })})`);
  ok(Number(row.tax_amount) === 2.14 && row.tax_breakdown.booked === 'server' && row.tax_breakdown.reason === 'page-sent-none' && row.tax_breakdown.source === 'server', `no figure from the phone: the server books 2.14 and says so (${row.tax_amount}, ${row.tax_breakdown.booked}, ${row.tax_breakdown.reason})`);
  ok(row.tax_breakdown.breakdown.length === 1 && row.tax_breakdown.breakdown[0].rate.id === '229a7558-c675-47e9-bb16-c756815591d9' && row.tax_breakdown.breakdown[0].items === 2, 'the split by rate names Preston Standard Rate for both lines');
  // (b) the phone's figure within 1p is kept, with the server's split behind it (the phone's own rule books 2.14 too)
  openTab('pi_b', [{ items: [cooler] }, { items: [cookie] }]);
  res = settleViaFile('pi_b', { table_label: 'Table 4', tax_amount: 2.14, exclusive_tax: 0 });
  row = sqlJson(`select to_jsonb(c) from public.closed_checks c where c.id = ${lit(res.check_id)}`);
  ok(Number(row.tax_amount) === 2.14 && row.tax_breakdown.booked === 'page' && row.tax_breakdown.totalTax === 2.14, `the phone's 2.14 is kept, booked 'page' (${row.tax_amount}, ${row.tax_breakdown.booked})`);
  // (c) a figure that is not the venue's rule (the phone had no rates and sent 0): the server's
  openTab('pi_c', [{ items: [cooler] }]);
  res = settleViaFile('pi_c', { table_label: 'Table 4', tax_amount: 0, exclusive_tax: 0 });
  row = sqlJson(`select to_jsonb(c) from public.closed_checks c where c.id = ${lit(res.check_id)}`);
  ok(Number(row.tax_amount) === 0.81 && row.tax_breakdown.booked === 'server' && row.tax_breakdown.reason === 'page-differs' && Number(row.tax_breakdown.pageTaxAmount) === 0, `a phone figure of 0 is replaced by 0.81 and flagged (${row.tax_amount}, ${row.tax_breakdown.reason})`);
  // (d) an automatic deal on a round: 10.00 of goods for 5.00 -> VAT 0.83 on what was charged (share 0.5)
  openTab('pi_d', [{ items: [{ ...cooler, price: 10 }], auto: 5 }]);
  res = settleViaFile('pi_d', { table_label: 'Table 4' });
  row = sqlJson(`select to_jsonb(c) from public.closed_checks c where c.id = ${lit(res.check_id)}`);
  ok(Number(row.total) === 5 && Number(row.tax_amount) === 0.83 && Number(row.tax_breakdown.share) === 0.5, `a deal on the round: 5.00 booked, VAT 0.83, share 0.5 (${row.total}, ${row.tax_amount}, ${row.tax_breakdown.share})`);
  // (d2) 8 Oct 2026 (review): the same deal on a half penny. 8.30 of goods, 0.83 off (share 0.9, an exact
  //      ratio of pence on the server): VAT exactly 1.245, booked 1.25 as the till books it, never 1.24.
  openTab('pi_d2', [{ items: [{ ...cooler, price: 8.3 }], auto: 0.83 }]);
  res = settleViaFile('pi_d2', { table_label: 'Table 4' });
  row = sqlJson(`select to_jsonb(c) from public.closed_checks c where c.id = ${lit(res.check_id)}`);
  ok(Number(row.total) === 7.47 && Number(row.tax_amount) === 1.25 && row.tax_breakdown.booked === 'server', `a deal on a half penny: 7.47 booked, VAT 1.25 half up (${row.total}, ${row.tax_amount})`);
  // (e) a second close of the same tab is "already closed", no second check
  res = settleViaFile('pi_a', {});
  ok(res.ok === true && res.reason === 'already_closed' && Number(sql('select count(*) from public.closed_checks')) === 5, 'closing a closed tab again writes nothing');

  console.log('6. the rollback');
  const rolled = file(ROLLBACK, { allowFail: true });
  ok(rolled.status === 0, 'rollback applied' + (rolled.status ? `\n${rolled.stderr}` : ''));
  const after = sqlJson(`select jsonb_build_object(
      'check_row', (select md5(prosrc) from pg_proc where oid = 'public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb)'::regprocedure),
      'settle', (select md5(prosrc) from pg_proc where oid = 'public.settle_qr_tab(uuid, text, jsonb, uuid[])'::regprocedure),
      'helpers', (select count(*) from pg_proc where proname in ('_vat_round', '_vat_order_type_key', '_vat_for_lines', '_public_order_vat')))`);
  ok(after.check_row === LIVE_MD5.check_row, `_public_order_check_row is the 20261002b text again (md5 ${after.check_row})`);
  ok(after.settle === LIVE_MD5.settle, `settle_qr_tab is the 20260927c text again (md5 ${after.settle})`);
  ok(Number(after.helpers) === 0, 'the four helpers are gone');
  const again = file(MIGRATION, { allowFail: true });
  ok(again.status === 0, 'and the migration applies again after the rollback');
} catch (e) {
  failures++;
  console.error(e?.stack || e);
} finally {
  stop();
}
console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
