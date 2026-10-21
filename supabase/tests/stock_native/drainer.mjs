// drainer.mjs: the proof of the drainer release (multi site stock map 8.1; the frozen drainer contract):
// supabase/migrations/20261023a_OPS_stock_drainer_v2.sql and its rollback, applied after Drop 0 as it
// is live (0a and its revalue file), once without 0b and once with it. run.mjs --drainer calls
// drainerProof() after its section 1 (the base database). Local, throwaway PostgreSQL only.
//
// Sections (numbered after run.mjs's 18, so STOCKN_STOP_AT works the same):
//   19  the drainer base: 0a and its revalue file as Peter ran them, the basket rows, the history the
//       release compares (Drop 0's channels at the three venues), every body contract 2.1 checks has
//       the live md5; a copy with 0b
//   20  the every channel basket (map 9.1, contract 6.2) BEFORE the release, with and without 0b
//   21  the paste: the check row, the guard's refusals, the in migration proof refusing a real
//       difference
//   22  what it made: columns, tables, read rules, fences, triggers, functions and grants, cron, backup
//   23  the basket AFTER the release: identical movements, waste, outbox events and flags, identical net
//       of VAT (JS and the SQL port); the new rows are only in the new tables; what each sale took
//   24  the deliberate changes, each with its own figures: archived rows (D1), made to order at depth 3,
//       a loop, the depth cap, no recipe, per site (D2), oat milk and no cheese (D3), refunds from the
//       sale's own takes (D4), takes never undo a sale
//   25  stock day totals: equal to the ledger per venue day after inserts, updates and deletes, the demo
//       markers, the venue clock (unknown, arriving, a changed day start, the bucket edge), the trigger
//       never failing a post (a forced lock wait and a forced error go to the repair queue), a rebuild
//       during sales, the drain backoff, the health read
//   26  sales day totals: every column against an independent oracle (net by the one sales rule,
//       theoretical cost from the takes, staff, comp and loyalty), the day check, the JS against SQL
//       parity of checkSalesParts, the enqueue never failing a close
//   27  speed with every trigger on, against 15,000 checks an hour company wide (before and after)
//   28  who may do what: option tables, the second step, stock_sale_takes and every new function closed
//       to the API, discounts.kind writable by a Back Office login, the live limits
//   29  the rollbacks: 0a's refused while the drainer is in; the drainer's restores the seven bodies and
//       the basket matches the original again; then the release applies again
//
// --before-only runs what needs no drainer file (19, 20, the v1 half of 24 and 27): green before the
// file exists. Exit code 0 only when every check holds.

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { here, lit, jlit } from './base.mjs';
import { ORG_T, PROVO, LOC2, ORG_S, SOLO, ORG_X, I, R, M, PACK, CALLERS } from './fixtures.mjs';
import { BASKET_SETUP, basketEvents, basketTimeArrives, basketBookedSql, basketChecksSql, insertRow } from './channels.mjs';
import {
  BI, BM, DISC, PRICE, basketSql, presetKindsSql, DI, DEEP, DPACK, DCONV, DR, DM, DOPT, deliberateSql, deliberateArchiveSql,
  deliberateToOrderSql, optionRulesSql, SPEED_ORG, speedLoc, speedSql, speedChecksSql, PARITY_ROWS,
} from './drainer_fixtures.mjs';
import { chargedNothing } from '../../functions/_shared/tradingSales.js';
import { checkTenderParts, checkTenders, canonicalMethod, MONEY_KINDS } from '../../functions/_shared/accountingDay.js';

// -- contract 2.1: the bodies the guard checks (live normalised md5, 20 Oct 2026) ---------------------------
export const REPLACED = [
  ['public.stock_qty_to_base(numeric,text,uuid)', 'c052fead38aa366e8145a85790dda91c', 'public', 'postgres'],
  ['public.stock_explode(uuid,jsonb,text,text)', '5e27ac77aa8022d035f226f9bc8d2db9', 'public', 'postgres'],
  ['public.stock_explode_skipped(uuid,jsonb,text)', '1cfd825ca6f678d745552418008f6f46', 'public', 'postgres'],
  ['public._stock_outbox_apply(bigint)', 'e71a501b8571b4627558b0b1541d3417', 'public, pg_temp', 'postgres'],
  ['public.stock_day_sums_rebuild(uuid,date,date)', '9a7d26c203d7ce2ae2c2e18879c9f29d', 'public, pg_temp', 'postgres,service_role'],
  ['public.sales_day_sums_rebuild(uuid,date,date)', '76d10f6c92e685bc5ef20e04e29de0d9', 'public, pg_temp', 'postgres,service_role'],
  ['public.sales_day_sums_check(uuid,date)', '5fb95ca9d5987700a490f98b0565eb22', 'public, pg_temp', 'postgres,service_role'],
];
export const CHECKED_ONLY = [
  ['public._post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)', '2974176b3ea49b90065dc0c20572e343'],
  ['public._stock_post(uuid,uuid,numeric,text,text,text,text,timestamptz,numeric,uuid,text,boolean)', '858c0e57136998f6613cde7bba42010d'],
  ['public._stock_taken(uuid,text)', '3180631cc277fb3003c05a772b5400d5'],
  ['public._stock_given_back(uuid,text)', 'a7fc1b530093d9d51504396184eaf7d4'],
  ['public._stock_refund_lines(jsonb,jsonb)', '3878bfefa4e0e09ffee13e157da752de'],
  ['public._stock_refund_at(uuid,text,jsonb)', 'de946a006072960781b6a8cc9e0e2df3'],
  ['public.stock_record_waste(uuid,jsonb,jsonb)', '7adec1618754c96e9f3d9655fcf98070'],
  ['public.stock_outbox_drain(integer,integer,numeric,boolean)', '1528946997db29d2f6c8685ca8425ec5'],
  ['public._stock_outbox_on_insert()', 'e8acd544e17a4c176ae5015118f5fb80'],
  ['public._stock_outbox_on_update()', 'df31713b61a21394dd8225bb3079538f'],
  ['public.stock_js_truthy(jsonb)', '3c65ef2a35812850480485860145722d'],
  ['public.stock_js_num(jsonb)', '2350548e9309c22a340dc216b765c43d'],
  ['public.stock_js_qty(jsonb)', '72cf646903b672f80119819049810d14'],
  ['public.stock_js_key(jsonb)', 'cdf4f77b33245549db9a5e2787e5e731'],
  ['public.stock_line_applies(jsonb,text,boolean)', '5b84b40043adb5d649b1e13799aef19c'],
  ['public.stock_norm_order_type(text)', '1bb362aea591604ca01108e2ad74a096'],
  ['public.stock_co__venue_day(uuid,timestamptz)', '8c9513db8ec56ddb68a1a3f247360742'],
  ['public.stock_co__clock_of(uuid)', '605fce03d4e44064df5cf3b03ecd0350'],
  ['public.stock_co__day_start_at(date,time,text)', '2cb462264587615075225d05a84cd051'],
  ['public.report_day_sums(text[],date,date,jsonb)', '25a8daf22bd412c1a2579807d21b223c'],
  ['public._rds_num(jsonb)', '28a3269e1d37a550643da3b08ae6daff'],
];
// contract 2.2 to 2.5: [signature, language, definer, volatility (i, s, v; p for the procedure), search_path, grants beyond postgres]
const NEW_FUNCS = [
  ['stock_co__option_org_guard()', 'plpgsql', true, 'v', 'public, pg_temp', []],
  ['stock_qty_to_base(numeric,text,uuid)', 'plpgsql', true, 's', 'public', []],
  ['stock_explode_lines(uuid,jsonb,text,text)', null, true, 's', 'public, pg_temp', []],
  ['stock_explode(uuid,jsonb,text,text)', 'sql', true, 's', 'public', []],
  ['stock_explode_skipped(uuid,jsonb,text)', 'sql', true, 's', 'public', []],
  ['_stock_takes_share(jsonb,jsonb)', 'sql', true, 's', 'public, pg_temp', []],
  ['_stock_outbox_apply(bigint)', 'plpgsql', true, 'v', 'public, pg_temp', []],
  ['_stock_day_sums_apply()', 'plpgsql', true, 'v', 'public, pg_temp', []],
  ['stock_day_sums_rebuild(uuid,date,date)', 'plpgsql', true, 'v', 'public, pg_temp', ['service_role']],
  ['_venue_clock_requeue()', 'plpgsql', true, 'v', 'public, pg_temp', []],
  ['stock_drainer_health(uuid)', 'plpgsql', true, 's', 'public, pg_temp', ['service_role']],
  ['_sales_js_round(double precision)', 'sql', false, 'i', 'public, pg_temp', []],
  ['_sales_js_num(jsonb)', 'plpgsql', false, 'i', 'public, pg_temp', []],
  ['_sales_check_parts(closed_checks)', 'plpgsql', true, 's', 'public, pg_temp', []],
  ['sales_day_sums_rebuild(uuid,date,date)', 'plpgsql', true, 'v', 'public, pg_temp', ['service_role']],
  ['sales_day_sums_check(uuid,date)', 'plpgsql', true, 's', 'public, pg_temp', ['service_role']],
  ['_sales_day_sums_enqueue()', 'plpgsql', true, 'v', 'public, pg_temp', []],
  ['stock_day_sums_drain(integer,integer)', 'plpgsql', false, 'p', '', []],
];
const OPTIONAL_FUNCS = [['_stock_explode_made(uuid,uuid,numeric,text,uuid[])', 'plpgsql', true, 's', 'public, pg_temp', []]];
const NEW_FLAGS = ['takes_not_saved', 'to_order_fallback', 'refund_by_recipe', 'refund_line_unmatched'];
const TARGET_PER_S = 15000 / 3600;

// The basket's venues: Provo every case; Location 2 and the one site venue a subset.
const BASKET = [
  { p: 'bp', loc: PROVO, menu: { a: M.pLatte, b: M.pFlat, c: M.pBoard, juice: BM.juice, shot: BM.shot, drive: BM.drive },
    dev: { till: 'tillProvo', kiosk: 'kioskProvo', mpos: 'mposProvo' }, presets: { staff: DISC.pStaff, comp: DISC.pComp, loyalty: DISC.pLoyalty }, only: null },
  { p: 'bl', loc: LOC2, menu: { a: M.lLatte, b: M.lSoup, c: M.lBread }, dev: { till: 'tillLoc2', kiosk: 'tillLoc2', mpos: 'tillLoc2' }, presets: { staff: DISC.lStaff },
    only: ['cash', 'kiosk', 'online', 'qrtab', 'cater-net', 'pat', 'mpos', 'hubrise', 'ezcater', 'ref-uid', 'ref-full', 'void-made', 'booking', 'demo', 'staff-label', 'loy-tender'] },
  { p: 'bs', loc: SOLO, menu: { a: M.sWater, b: M.sWater, c: M.sWater }, dev: { till: 'tillSolo', kiosk: 'tillSolo', mpos: 'tillSolo' }, presets: {},
    only: ['cash', 'kiosk', 'ref-uid', 'void-made', 'pack', 'booking', 'demo'] },
];
const BOOKS = ['cash', 'card', 'split', 'terminal', 'bartab', 'kiosk', 'online', 'qrnow', 'qrtab', 'cater', 'cater-net', 'pat', 'mpos', 'hubrise', 'hr-cancel', 'ezcater',
  'ref-uid', 'ref-nouid', 'ref-full', 'ref-refused', 'sealed', 'staff-check', 'staff-item', 'staff-label', 'custom', 'comp', 'loy-tender', 'loy-kind', 'loy-legacy',
  'promo', 'mods', 'pack', 'drive', 'gift', 'deposit'];

// JS figures of one check (contract 2.5 _sales_check_parts: what the SQL port must return).
export function jsParts(row) {
  const cn = chargedNothing(row);
  const { legacy, parts } = checkTenderParts(row || {});
  let gross = 0; let tax = 0; let rg = 0; let rt = 0;
  if (!cn) {
    for (const p of parts) {
      if (MONEY_KINDS.has(p.kind)) { gross += p.sales; tax += p.tax; } else if (p.kind === 'discount') { rg += p.sales; rt += p.tax; }
    }
  }
  return { gross_minor: gross, tax_minor: tax, net_minor: gross - tax, reward_minor: rg, reward_tax_minor: rt, charged_nothing: cn, legacy: !!legacy };
}
const jsTruthy = (v) => (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : typeof v === 'string' ? v !== '' : v != null && typeof v === 'object');
const jsKey = (v) => ((typeof v === 'string' || typeof v === 'number') && String(v) !== '' ? String(v) : null);
const jsNum = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(v.trim())) return Number(v.trim());
  return 0;
};
const jsQty = (v) => jsNum(v) || 1;
// md5(text)::uuid, as the drainer keys its waste_events rows
const md5uuid = (t) => { const h = createHash('md5').update(t).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
const isNull = (v) => v === '' || v == null;

// L9 (contract 2.5): the kind of one discount entry.
function entryKind(e, presets) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  if (['staff', 'comp', 'loyalty'].includes(e.kind)) return e.kind;
  if (!('kind' in e) && e.source == null && !jsTruthy(e.isAuto)) {
    const name = String(e.label ?? e.name ?? '').trim().toLowerCase();
    const kinds = new Set(presets.filter((p) => p.kind && String(p.name).trim().toLowerCase() === name).map((p) => p.kind));
    if (kinds.size === 1) return [...kinds][0];
  }
  return null;
}

export async function drainerProof(x) {
  const { c, ok, near, short, pj, sql, num, asCaller, asCallerAsync, callJ, outcome, guarded, section, FILES, QUICK, onHandEqLedger, md5Of, aclOf, pathOf, canExec, fnExists, tableExists, FNS } = x;
  const HAVE = existsSync(FILES.d);
  const AFTER = HAVE && !x.BEFORE_ONLY;
  const VNAME = { [PROVO]: 'Provo', [LOC2]: 'Location 2', [SOLO]: 'Solo venue' };
  const drain = () => sql('call public.stock_outbox_drain(10, 50, 0.05, true);');
  const dsDrain = (budget = 20) => sql(`call public.stock_day_sums_drain(${budget}, 50);`);
  const dsDrainAll = () => {
    for (let k = 0; k < 20; k++) {
      dsDrain(30);
      if (num(`select (select count(*) from stock_day_sums_repair where due_at <= now()) + (select count(*) from sales_day_sums_queue where due_at <= now())`) === 0) return k + 1;
    }
    return -1;
  };
  const tf = (v) => v === 't' || v === 'true' || v === true;
  const mapBy = (rows, key) => Object.fromEntries((rows || []).map((r) => [r[key], r]));
  if (!HAVE) console.log(`     the drainer file is not there yet (${FILES.d}); ${x.BEFORE_ONLY ? 'running' : 'running only'} the parts that need no drainer file`);
  if (!x.BEFORE_ONLY) ok(HAVE, `the drainer file is there (${FILES.d})`);

  // what one venue's basket booked, by check id
  const takenBy = (b, id) => {
    const out = {};
    for (const m of b.movements) if (m.check === id && m.type === 'SALE_DEPLETION' && m.key.startsWith(`sale:${id}:`)) out[m.item] = (out[m.item] || 0) - Number(m.qty);
    return out;
  };
  const rowsBy = (b, id, prefix) => b.movements.filter((m) => m.check === id && m.key.startsWith(prefix));
  const flagsOf = (b, id, kind = 'sale') => (b.outbox.find((o) => o.check === id && o.kind === kind) || {}).flags || null;

  // The basket on the database in use: phases A, B, C with a drain after each, then the event time.
  function runBasket(t0) {
    const problems = [];
    const evs = BASKET.map((v) => ({ v, e: basketEvents({ ...v, t0, price: PRICE }) }));
    for (const phase of ['A', 'B', 'C']) {
      for (const { v, e } of evs) {
        for (const ev of e.filter((z) => z.phase === phase)) {
          const r = asCaller(ev.caller, phase === 'A' ? ev.sql : `${ev.sql} returning id`);
          if (r.status !== 0) problems.push(`${v.p} ${phase} ${ev.name}: ${outcome(r)}`);
          else if (phase !== 'A' && !r.out.includes(`${v.p}-`)) problems.push(`${v.p} ${phase} ${ev.name}: no row changed`);
        }
      }
      drain();
    }
    for (let k = 0; k < 3; k++) { for (const v of BASKET) sql(basketTimeArrives(v.p)); drain(); }
    const out = {};
    for (const v of BASKET) out[v.p] = { booked: pj(sql(basketBookedSql(v.p, t0))), checks: pj(sql(basketChecksSql(v.p))) };
    return { out, problems };
  }
  // net of VAT per check, and per refund entry (JS, the one sales rule)
  const netOf = (checks) => Object.fromEntries(checks.map((r) => [r.id, jsParts(r)]));
  // What v1 must have booked on the basket (map 9.1): every channel, skips, refunds, voids, catering.
  function basketExpect(label, out) {
    for (const v of BASKET) {
      const b = out[v.p].booked;
      const has = (n) => !v.only || v.only.includes(n);
      const books = BOOKS.filter((n) => has(n) && !(n === 'sealed' && !v.menu.juice) && !(n === 'mods' && !v.menu.shot) && !(n === 'drive' && !v.menu.drive));
      const missing = books.filter((n) => Object.keys(takenBy(b, `${v.p}-${n}`)).length === 0);
      ok(missing.length === 0, `${label}, ${VNAME[v.loc]}: every channel and case takes stock off through the drainer (${books.length - missing.length}/${books.length}${missing.length ? `; none: ${missing.join(', ')}` : ''})`);
      const notDone = b.outbox.filter((o) => o.status !== 'done');
      ok(notDone.length === 0, `${label}, ${VNAME[v.loc]}: every outbox event is done (${notDone.length ? short(notDone, 300) : `${b.outbox.length} events`})`);
      ok(!b.outbox.some((o) => o.check === `${v.p}-booking` || o.check === `demo-${v.p}-1`) && !b.movements.some((m) => m.check === `${v.p}-booking` || m.check === `demo-${v.p}-1`),
        `${label}, ${VNAME[v.loc]}: the booking source check and the demo id check are skipped (no event, no movement)`);
      if (has('void-made')) {
        const w = rowsBy(b, `${v.p}-void-made`, `waste:${v.p}-void-made:tomb:`);
        const want = pj(sql(`select json_object_agg(x.inventory_item_id, x.qty_base) from public.stock_explode('${v.loc}', ${jlit([{ itemId: v.menu.a, qty: 1 }, { itemId: v.menu.c, qty: 1 }])}, 'dine-in') x`)) || {};
        const got = Object.fromEntries(w.map((m) => [m.item, -Number(m.qty)]));
        ok(Object.keys(want).length > 0 && Object.keys(want).every((k) => near(got[k], want[k], 1e-4)) && Object.keys(got).length === Object.keys(want).length,
          `${label}, ${VNAME[v.loc]}: the void after making books waste for the sent and fired line and the old fired line only, not the held line or the course 0 drink (${short(got, 200)})`);
      }
      if (has('void-unsent')) ok((flagsOf(b, `${v.p}-void-unsent`, 'tomb') || []).includes('nothing_made'), `${label}: the void before sending books nothing (nothing_made)`);
      if (has('ref-uid')) {
        const rf = rowsBy(b, `${v.p}-ref-uid`, `waste:${v.p}-ref-uid:${v.p}-rf1:`);
        const un = rowsBy(b, `${v.p}-ref-uid`, `unsale:${v.p}-ref-uid:${v.p}-rf1:`);
        const want = pj(sql(`select json_object_agg(x.inventory_item_id, x.qty_base) from public.stock_explode('${v.loc}', ${jlit([{ itemId: v.menu.a, qty: 1 }])}, 'dine-in') x`)) || {};
        const ret = rowsBy(b, `${v.p}-ref-uid`, 'return:');
        ok(rf.length === Object.keys(want).length && rf.every((m) => near(-Number(m.qty), want[m.item], 1e-4)) && un.length === rf.length && ret.length === 0,
          `${label}, ${VNAME[v.loc]}: the part refund with a uid gives back one unit as an unsale and the same amount as waste (refunded food is waste) (${rf.length} items)`);
        const ids = new Set(b.waste.map((w) => w.id));
        ok(rf.length > 0 && rf.every((m) => ids.has(md5uuid(m.key)) && b.waste.find((w) => w.id === md5uuid(m.key)).reason === 'Refunded'),
          `${label}, ${VNAME[v.loc]}: and a waste_events row per item (reason Refunded)`);
      }
      if (has('ref-full')) {
        const taken = takenBy(b, `${v.p}-ref-full`);
        const back = {};
        for (const m of rowsBy(b, `${v.p}-ref-full`, 'unsale:')) back[m.item] = (back[m.item] || 0) + Number(m.qty);
        for (const m of rowsBy(b, `${v.p}-ref-full`, 'return:')) back[m.item] = (back[m.item] || 0) + Number(m.qty);
        ok(Object.keys(taken).every((k) => near(back[k], taken[k], 1e-4)), `${label}, ${VNAME[v.loc]}: the full refund gives back everything the sale took (${short(back, 160)})`);
      }
      if (has('cater-net')) {
        const f = flagsOf(b, `${v.p}-cater-net`) || [];
        ok(f.includes('refund_before_made') && f.includes(`netted:${v.p}-rf6`) && (flagsOf(b, `${v.p}-cater-net`, 'refund') || []).includes('before_made'),
          `${label}, ${VNAME[v.loc]}: the catering order refunded in part before its event is netted (refund_before_made, netted:<id>; the refund books nothing) (${short(f)})`);
        const per = pj(sql(`select json_object_agg(x.inventory_item_id, x.qty_base) from public.stock_explode('${v.loc}', ${jlit([{ itemId: v.menu.a, qty: 3 }, { itemId: v.menu.b, qty: 2 }])}, 'catering') x`)) || {};
        const t = takenBy(b, `${v.p}-cater-net`);
        ok(Object.keys(per).every((k) => near(t[k], per[k], 1e-4)), `${label}, ${VNAME[v.loc]}: and takes off 3 of the 4 lattes and both of the rest at the event time`);
        const occ = b.movements.filter((m) => m.key.startsWith(`sale:${v.p}-cater-net:`)).map((m) => Number(m.occ));
        ok(occ.length > 0 && occ.every((s) => s > 2 * 86400 - 60), 'and the sale is dated at the event, two days ahead');
      }
      if (has('cater')) {
        ok(Object.keys(takenBy(b, `${v.p}-cater`)).length > 0 && b.movements.filter((m) => m.key.startsWith(`sale:${v.p}-cater:`)).every((m) => Number(m.occ) > 2 * 86400 - 60),
          `${label}, ${VNAME[v.loc]}: the catering order dated ahead takes stock off at its event time`);
      }
      if (has('cater-void')) {
        ok((flagsOf(b, `${v.p}-cater-void`) || []).includes('cancelled_before_made') && Object.keys(takenBy(b, `${v.p}-cater-void`)).length === 0,
          `${label}, ${VNAME[v.loc]}: the catering order voided before its event takes nothing (cancelled_before_made)`);
      }
      if (has('ref-refused')) {
        const rows = b.movements.filter((m) => m.check === `${v.p}-ref-refused` && m.source === 'closed_check_refund');
        const sum = {};
        for (const m of rows) sum[`${m.item}:${m.type}`] = (sum[`${m.item}:${m.type}`] || 0) + Number(m.qty);
        const wids = new Set(b.waste.map((w) => w.id));
        ok(rows.some((m) => m.key.startsWith('undo:')) && Object.values(sum).every((q) => near(q, 0, 1e-9))
           && rows.filter((m) => m.key.startsWith('waste:')).every((m) => !wids.has(md5uuid(m.key))),
          `${label}, ${VNAME[v.loc]}: the refund the processor refused is undone exactly (every row reversed, its waste rows gone)`);
      }
      if (has('sealed') && v.menu.juice) {
        const ret = rowsBy(b, `${v.p}-sealed`, `return:${v.p}-sealed:${v.p}-rf5:`);
        ok(ret.length === 1 && ret[0].item === BI.juice && near(ret[0].qty, 1) && ret[0].type === 'RETURN',
          `${label}: the sealed juice (returns_to_shelf) goes back on the shelf as a RETURN of 1; the latte beside it is waste`);
        ok(rowsBy(b, `${v.p}-sealed`, `waste:${v.p}-sealed:${v.p}-rf5:`).length > 0 && !rowsBy(b, `${v.p}-sealed`, `waste:${v.p}-sealed:${v.p}-rf5:${BI.juice}`).length,
          `${label}: and the juice is never waste`);
      }
      if (has('cash')) ok((flagsOf(b, `${v.p}-cash`, 'refund') || []).includes('money_only'), `${label}, ${VNAME[v.loc]}: a money only refund (no lines) moves nothing (money_only)`);
      if (has('hr-cancel')) {
        const taken = takenBy(b, `${v.p}-hr-cancel`);
        const back = {};
        for (const m of rowsBy(b, `${v.p}-hr-cancel`, `unsale:${v.p}-hr-cancel:void:`)) back[m.item] = (back[m.item] || 0) + Number(m.qty);
        ok(Object.keys(taken).length > 0 && Object.keys(taken).every((k) => near(back[k], taken[k], 1e-4)), `${label}: the HubRise cancel (void after booking) gives everything back as waste`);
      }
      if (has('mods') && v.menu.shot) {
        const want = pj(sql(`select json_object_agg(x.inventory_item_id, x.qty_base) from public.stock_explode('${v.loc}', ${jlit([{ itemId: v.menu.a, qty: 2 }, { itemId: v.menu.shot, qty: 2 }])}, 'dine-in') x`)) || {};
        const t = takenBy(b, `${v.p}-mods`);
        ok(Object.keys(want).every((k) => near(t[k], want[k], 1e-4)) && Object.keys(t).length === Object.keys(want).length,
          `${label}: the modifier with its own recipe takes its beans per unit of the line; the instruction and the removed modifier take nothing (${short(t, 200)})`);
      }
      if (has('drive') && v.menu.drive) {
        const t = takenBy(b, `${v.p}-drive`);
        ok(near(t[BI.tray], 2) && near(t[I.pCups], 1), `${label}: the drive thru order takes its drive thru tray and leaves the takeaway cup line of that recipe (cups 1 from the latte only) (${short(t, 200)})`);
      }
      if (has('pack')) {
        const t = takenBy(b, `${v.p}-pack`);
        ok(Object.keys(t).length === 1, `${label}, ${VNAME[v.loc]}: the pack line dish ("@" pack) takes its pack amount (${short(t)})`);
      }
      ok(onHandEqLedger(v.loc), `${label}, ${VNAME[v.loc]}: on hand equals the ledger after the basket`);
    }
  }
  const basketCompare = (label, a, b) => {
    for (const v of BASKET) {
      const x1 = a[v.p].booked; const x2 = b[v.p].booked;
      for (const part of ['movements', 'waste', 'outbox']) {
        const s1 = JSON.stringify(x1[part]); const s2 = JSON.stringify(x2[part]);
        ok(s1 === s2, `${label}, ${VNAME[v.loc]}: identical ${part} (${(x2[part] || []).length} rows)`);
        if (s1 !== s2) {
          const k1 = new Set((x1[part] || []).map((r) => JSON.stringify(r)));
          const k2 = new Set((x2[part] || []).map((r) => JSON.stringify(r)));
          console.log(`     only before: ${short([...k1].filter((r) => !k2.has(r)).slice(0, 4), 900)}\n     only after:  ${short([...k2].filter((r) => !k1.has(r)).slice(0, 4), 900)}`);
        }
      }
      const n1 = netOf(a[v.p].checks); const n2 = netOf(b[v.p].checks);
      const ids = [...new Set([...Object.keys(n1), ...Object.keys(n2)])];
      const off = ids.filter((id) => JSON.stringify(n1[id]) !== JSON.stringify(n2[id]));
      ok(off.length === 0 && ids.length === a[v.p].checks.length, `${label}, ${VNAME[v.loc]}: identical net of VAT, VAT and gross on all ${ids.length} checks (the JS rule) (${off.join(', ') || 'all equal'})`);
    }
  };

  // ==================================================================================================
  section(19, '19. The drainer base: Drop 0 as live (0a and its revalue file), the basket rows, the history; and a copy with 0b');
  let baseOk = false;
  await guarded('drainer base', () => {
    c.createFrom('n_d0', 'n_base');
    c.use('n_d0');
    let r = c.paste(FILES.a);
    ok(r.status === 0, `0a applies as Peter ran it (${r.status ? short(r.stderr, 300) : `${r.ms} ms`})`);
    r = c.paste(FILES.rv);
    ok(r.status === 0, `its revalue file applies as Peter ran it (${r.status ? short(r.stderr, 300) : `${r.ms} ms`})`);
    c.sqlFile(join(here, 'live_discounts.sql'));
    c.psql({ input: BASKET_SETUP });
    c.psql({ input: basketSql() });
    ok(num(`select count(*) from inventory_items where id in ('${BI.juice}', '${BI.tray}') and company_ref is not null`) === 2
       && num(`select count(*) from stock_co_recipe_lines l join recipes r on r.company_ref = l.recipe_id where r.id = '${R.pLatte}'`) >= 3,
      'the basket rows are added the way a demo file adds them (0a gives each its company record)');
    const { problems } = x.runChannels('history');
    ok(problems.length === 0, `the history the release compares: Drop 0's channels at the three venues, drained (${problems.join('; ') || 'all written'})`);
    for (const [sig, md5, sp, acl] of REPLACED) {
      const name = sig.slice(7, sig.indexOf('('));
      ok(md5Of(sig) === md5 && pathOf(sig) === sp && aclOf(sig) === acl, `${name}: the live body the release replaces (md5 ${md5Of(sig)}, search_path ${pathOf(sig)}, EXECUTE ${aclOf(sig)})`);
    }
    const off = CHECKED_ONLY.filter(([sig, md5]) => md5Of(sig) !== md5).map(([sig]) => `${sig.slice(7, sig.indexOf('('))} ${md5Of(sig)}`);
    ok(off.length === 0, `the ${CHECKED_ONLY.length} bodies the release only checks have the live md5 (${off.join(', ') || 'all'})`);
    const pre = pj(sql(`select json_build_object('ops', to_regclass('public.user_locations') is not null and to_regclass('public.billing_state') is null,
        'a0', (select count(*) from stock_native_backup) = 7,
        'tables', to_regclass('public.stock_co_items') is not null and to_regclass('public.stock_co_item_sites') is not null and to_regclass('public.stock_co_recipes') is not null
                  and to_regclass('public.stock_day_sums') is not null and to_regclass('public.stock_day_sums_repair') is not null and to_regclass('public.sales_day_sums') is not null
                  and to_regclass('public.sales_day_sums_queue') is not null and to_regclass('public.venue_clock') is not null,
        'cols', (select count(*) from information_schema.columns where table_schema = 'public' and ((table_name = 'recipes' and column_name = 'company_ref')
                  or (table_name = 'item_packaging_formats' and column_name = 'archived_at') or (table_name = 'inventory_item_conversions' and column_name = 'archived_at'))) = 3,
        'not_yet', to_regclass('public.stock_sale_takes') is null and to_regclass('public.stock_co_option_rules') is null
                  and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'discounts' and column_name = 'kind')
                  and not exists (select 1 from pg_trigger where tgname = 'stock_movements_day_sums_ins'),
        'cron', to_regprocedure('cron.schedule(text,text,text)') is not null,
        'no_mv_trigger', not exists (select 1 from pg_trigger where tgrelid = 'public.stock_movements'::regclass and not tgisinternal))`));
    ok(pre && Object.values(pre).every(Boolean), `everything the drainer's guard asks for is there, and nothing of the release is (${short(pre)})`);
    ok(num(`select count(*) from stock_day_sums`) === 0 && num(`select count(*) from venue_clock`) === 0 && num(`select count(*) from stock_co_item_sites where supply_mode = 'to_order'`) === 0,
      'as live: no day totals yet, no venue clock, no made to order site item');
    c.createFrom('n_d0b', 'n_d0');
    c.use('n_d0b');
    r = c.paste(FILES.b);
    ok(r.status === 0, `the copy with 0b: 0b applies (${r.status ? short(r.stderr, 300) : `${r.ms} ms`})`);
    baseOk = true;
  });
  if (!baseOk) return;

  // ==================================================================================================
  section(20, '20. The every channel basket before the release (v1), without and with 0b');
  const before = {};
  const t0 = Date.now() - 10 * 60000;
  for (const [db, label] of [['n_d0', 'v1'], ['n_d0b', 'v1 with 0b']]) {
    await guarded(`basket ${label}`, () => {
      c.createFrom(`n_bk1_${db}`, db);
      c.use(`n_bk1_${db}`);
      const { out, problems } = runBasket(t0);
      ok(problems.length === 0, `${label}: every check, refund, void and undo is written by its own writer (${problems.slice(0, 5).join('; ') || 'all written'})`);
      basketExpect(label, out);
      before[db] = out;
      const n = netOf(out.bp.checks);
      console.log(`     ${label}: ${Object.values(out).reduce((s, o) => s + o.booked.movements.length, 0)} movements, ${Object.values(out).reduce((s, o) => s + o.checks.length, 0)} checks; Provo net of VAT ${(Object.values(n).reduce((s, p) => s + p.net_minor, 0) / 100).toFixed(2)}`);
    });
  }
  if (before.n_d0 && before.n_d0b) basketCompare('0b changes no stock: v1 with 0b against v1 without', before.n_d0, before.n_d0b);

  // the deliberate cases' base (part A, a sale booked before the release) and the speed base, both
  // made now so the v1 half runs whether or not the drainer file is there
  let dlOk = false;
  await guarded('deliberate base', () => {
    c.createFrom('n_dl', 'n_d0');
    c.use('n_dl');
    c.psql({ input: deliberateSql() });
    ok(num(`select count(*) from inventory_items where company_ref is null`) === 0 && num(`select count(*) from recipes where company_ref is null`) === 0,
      'the deliberate rows have their company records');
    asCaller('tillProvo', insertRow({ id: 'dl-rs0', location_id: PROVO, ref: 'DLRS0', items: [{ itemId: M.pFlat, qty: 2, uid: 'p1', price: 3.1 }], subtotal: 6.2, total: 6.2, tax_amount: 1.03,
      tenders: [{ method: 'cash', amount: 6.2 }], closed_at: new Date(Date.now() - 20 * 60000).toISOString() }));
    drain();
    ok(num(`select count(*) from stock_movements where source_id = 'dl-rs0'`) === 2, 'a sale booked before the release (no takes row will exist for it)');
    dlOk = true;
  });

  // ==================================================================================================
  section(21, '21. The release as the SQL editor runs it: the check row, its refusals, the in migration proof');
  let pasted = false;
  if (AFTER) {
    await guarded('paste', () => {
      // what the check row must count, read before the paste
      c.use('n_d0');
      const expectRow = {};
      for (const v of [PROVO, LOC2, SOLO]) {
        expectRow[v] = pj(sql(`select json_build_object(
            'live', (select count(*) from closed_checks c where c.location_id = '${v}' and c.closed_at > now() - interval '7 days' and not (coalesce(c.voided, false) or coalesce(c.status, '') in ('void', 'voided'))),
            'all', (select count(*) from closed_checks c where c.location_id = '${v}' and c.closed_at > now() - interval '7 days'),
            'rows', (select count(*) from closed_checks c, public.stock_explode('${v}', c.items, c.order_type) e where c.location_id = '${v}' and c.closed_at > now() - interval '7 days'
                       and not (coalesce(c.voided, false) or coalesce(c.status, '') in ('void', 'voided'))),
            'refunds', (select count(*) from closed_checks c, jsonb_array_elements(case when jsonb_typeof(c.refunds) = 'array' then c.refunds else '[]'::jsonb end) x
                         where c.location_id = '${v}' and c.closed_at > now() - interval '7 days' and public.stock_js_key(x -> 'id') is not null),
            'lines', (select count(*) from recipe_lines where location_id = '${v}'))`));
      }
      for (const [db, label] of [['n_d0', 'without 0b'], ['n_d0b', 'with 0b']]) {
        c.use(db);
        const fnBefore = FNS();
        c.createFrom(`n_dr_${db}`, db);
        c.use(`n_dr_${db}`);
        const r = c.paste(FILES.d);
        ok(r.status === 0, `${label}: the release applies in one transaction (${r.status ? short(r.stderr, 700) : `${r.ms} ms`})`);
        if (r.status !== 0) continue;
        const last = r.sets[r.sets.length - 1] || { cols: [], rows: [] };
        const want = ['venue', 'location_id', 'checks_compared', 'explode_rows_compared', 'explode_differences', 'skipped_flag_differences', 'refunds_compared',
          'refund_differences', 'recipe_lines_compared', 'base_qty_differences', 'bodies_replaced', 'bodies_backed_up', 'new_tables', 'discounts_kind', 'day_sums_triggers',
          'sales_enqueue_triggers', 'clock_triggers', 'option_guard_triggers', 'drain_job', 'internals_open_to_api', 'takes_rows', 'repair_days_queued', 'sales_days_queued'];
        ok(JSON.stringify(last.cols) === JSON.stringify(want), `${label}: the check row has contract 5.4's columns in order (${last.cols.join(',')})`);
        for (const row of last.rows) console.log(`     ${row.venue}: ${short(row, 700)}`);
        ok(last.rows.length === 3 && [PROVO, LOC2, SOLO].every((v) => last.rows.some((w) => w.location_id === v)), `${label}: one row per venue that holds stock (${last.rows.map((w) => w.venue).join(', ')})`);
        for (const row of last.rows) {
          const e = expectRow[row.location_id] || {};
          const n = (k) => Number(row[k]);
          ok(n('explode_differences') === 0 && n('skipped_flag_differences') === 0 && n('refund_differences') === 0 && n('base_qty_differences') === 0,
            `${label}, ${row.venue}: v2 gives v1's answer on every live check, refund and recipe line (differences ${n('explode_differences')}, ${n('skipped_flag_differences')}, ${n('refund_differences')}, ${n('base_qty_differences')})`);
          ok(n('checks_compared') >= e.live && n('checks_compared') <= e.all && n('checks_compared') > 0 && n('explode_rows_compared') === e.rows && n('refunds_compared') === e.refunds
             && n('recipe_lines_compared') === e.lines,
            `${label}, ${row.venue}: it compared the history: checks ${row.checks_compared} (${e.live} sold, ${e.all} in all), explode rows ${row.explode_rows_compared} (${e.rows}), refunds ${row.refunds_compared} (${e.refunds}), recipe lines ${row.recipe_lines_compared} (${e.lines})`);
          ok(n('bodies_replaced') === 7 && n('bodies_backed_up') === 7 && n('new_tables') === 3 && tf(row.discounts_kind) && n('day_sums_triggers') === 3 && n('sales_enqueue_triggers') === 2
             && n('clock_triggers') === 2 && n('option_guard_triggers') === 2 && tf(row.drain_job) && !tf(row.internals_open_to_api) && n('takes_rows') === 0
             && n('repair_days_queued') >= 0 && n('sales_days_queued') >= 0,
            `${label}, ${row.venue}: bodies 7 and 7, tables 3, discounts.kind, triggers 3, 2, 2, 2, drain job, internals closed, no takes yet (queued ${row.repair_days_queued} and ${row.sales_days_queued} days)`);
        }
        const fnAfter = FNS();
        const changed = Object.keys(fnBefore).filter((k) => fnAfter[k] !== fnBefore[k]).map((k) => k.slice(0, k.indexOf('(')));
        const named = REPLACED.map(([s]) => s.slice(7, s.indexOf('(')));
        ok(changed.filter((k) => !named.includes(k)).length === 0 && named.every((k) => changed.includes(k)),
          `${label}: of ${Object.keys(fnBefore).length} functions that were there, exactly the seven named ones changed (${changed.join(', ')})`);
        const bk = pj(sql(`select json_object_agg(name, md5) from stock_native_backup where left(name, 11) = 'drainer_v2:'`)) || {};
        ok(REPLACED.every(([s, md5]) => bk[`drainer_v2:${s.slice(7, s.indexOf('('))}`] === md5) && Object.keys(bk).length === 7
           && num(`select count(*) from stock_native_backup where left(name, 11) <> 'drainer_v2:'`) === 7,
          `${label}: the seven bodies are backed up as drainer_v2:<name> with their live md5; 0a's own seven rows are untouched`);
        ok(num(`select count(*) from stock_native_backup b where left(b.name, 11) = 'drainer_v2:' and b.body like 'CREATE OR REPLACE FUNCTION public.%'`) === 7, `${label}: each backup is the pg_get_functiondef text`);
        pasted = true;
      }
    });
    await guarded('refusals', () => {
      const tryPaste = (db, setup, label, re) => {
        c.createFrom('n_refuse', db);
        c.use('n_refuse');
        if (setup) sql(setup);
        const fns = FNS();
        const r = c.paste(FILES.d);
        ok(r.status !== 0 && re.test(r.stderr) && JSON.stringify(FNS()) === JSON.stringify(fns) && !tableExists('stock_sale_takes'),
          `${label}: refused, nothing changed (${short((r.error || r.stderr || '').trim(), 200)})`);
      };
      c.use('n_dr_n_d0');
      {
        const fns = FNS();
        const r = c.paste(FILES.d);
        ok(r.status !== 0 && /The drainer release has run already\. Nothing was changed\./.test(r.stderr) && JSON.stringify(FNS()) === JSON.stringify(fns), `a second paste: refused, nothing changed (${short(r.error, 160)})`);
      }
      tryPaste('n_base', null, 'before 0a', /Run 20261021a_OPS_stock_native_0a\.sql first\. Nothing was changed\./);
      tryPaste('n_d0', 'create table public.billing_state (id integer)', 'on a database that is not Ops', /This is not the Ops database \(tbetcegmszzotrwdtqhi\)\. Nothing was changed\./);
      tryPaste('n_d0', `create or replace function public.stock_explode_skipped(p_loc uuid, p_lines jsonb, p_order_type text) returns integer language sql stable security definer set search_path = public as $f$ select 0 $f$`,
        'a replaced body changed since the file was written', /A stock function changed since this file was written\. Ask Claude for a new file\.[\s\S]*stock_explode_skipped/);
      tryPaste('n_d0', `create or replace function public._stock_refund_lines(p_items jsonb, p_entry jsonb) returns jsonb language sql immutable parallel safe as $f$ select '[]'::jsonb $f$`,
        'a checked body changed', /A stock function changed since this file was written\. Ask Claude for a new file\.[\s\S]*_stock_refund_lines/);
      tryPaste('n_d0', 'drop function cron.schedule(text,text,text)', 'with no pg_cron', /ERROR/);
      tryPaste('n_d0', `update recipes set archived_at = now() where id = '${R.pFlat}'`, 'an archived recipe still linked, with live checks that sold it (v2 would give another answer)',
        /The new stock rule gives a different answer on [0-9]+ live checks \(first: [^)]+\)\. Nothing was changed\. Send this line to Claude\./);
      tryPaste('n_d0', `insert into item_packaging_formats (id, location_id, inventory_item_id, name, qty_in_base, archived_at) values ('${DPACK.scoop}', '${PROVO}', '${I.pBeans}', 'Scoop', 0.05, now());
        insert into recipes (id, location_id, name) values ('${DR.scoop}', '${PROVO}', 'Bean Scoop');
        insert into recipe_lines (location_id, recipe_id, component_item_id, qty, unit) values ('${PROVO}', '${DR.scoop}', '${I.pBeans}', 1, '@${DPACK.scoop}')`,
        'a recipe line on an archived pack (never sold)', /The new stock rule gives a different answer on [0-9]+ recipe lines/);
    });
  }

  // ==================================================================================================
  section(22, '22. What the release made: columns, tables, read rules, fences, triggers, functions, grants, cron');
  if (AFTER && pasted) {
    await guarded('made', () => {
      c.use('n_dr_n_d0');
      const col = (t, k) => pj(sql(`select json_build_object('type', data_type, 'null', is_nullable, 'def', column_default) from information_schema.columns where table_schema = 'public' and table_name = '${t}' and column_name = '${k}'`));
      const kind = col('discounts', 'kind');
      ok(kind && kind.type === 'text' && kind.null === 'YES' && kind.def == null, `discounts.kind text, null by default (${short(kind)})`);
      const kc = sql(`select pg_get_constraintdef(oid) from pg_constraint where conname = 'discounts_kind_known' and conrelid = 'public.discounts'::regclass`);
      ok(/staff/.test(kc) && /comp/.test(kc) && /loyalty/.test(kc), `CHECK discounts_kind_known (${kc})`);
      ok(/20261023a/.test(sql(`select coalesce(col_description('public.discounts'::regclass, (select attnum from pg_attribute where attrelid = 'public.discounts'::regclass and attname = 'kind')), '')`)), 'its comment names 20261023a');
      const demo = col('stock_day_sums', 'demo');
      ok(demo && demo.type === 'boolean' && demo.null === 'NO' && demo.def === 'false', `stock_day_sums.demo boolean not null default false (${short(demo)})`);
      ok(sql(`select pg_get_constraintdef(oid) from pg_constraint where conname = 'stock_day_sums_pkey'`) === 'PRIMARY KEY (location_id, business_day, inventory_item_id, movement_type, source_type, demo)',
        'stock_day_sums_pkey takes demo as its last column');
      for (const t of ['stock_day_sums_repair', 'sales_day_sums_queue']) {
        const a = col(t, 'attempts'); const d = col(t, 'due_at'); const e = col(t, 'last_error');
        ok(a?.type === 'integer' && a.null === 'NO' && a.def === '0' && d?.type === 'timestamp with time zone' && d.null === 'NO' && /now\(\)/.test(d.def || '') && e?.type === 'text',
          `${t}: attempts, due_at, last_error (${short([a, d, e])})`);
        ok(/\(due_at\)/.test(sql(`select coalesce(pg_get_indexdef(to_regclass('public.${t}_due')), '')`)), `${t}_due on (due_at)`);
      }
      const T = {
        stock_co_option_rules: { grants: ['authenticated:select', 'service_role:select'], read: 'stock_co_option_rules_read', fence: true },
        stock_co_option_rule_sites: { grants: ['authenticated:select', 'service_role:select'], read: 'stock_co_option_rule_sites_read', fence: true },
        stock_sale_takes: { grants: ['service_role:select'], read: null, fence: false },
      };
      for (const [t, spec] of Object.entries(T)) {
        const ex = tableExists(t);
        const rls = ex && sql(`select relrowsecurity from pg_class where oid = 'public.${t}'::regclass`) === 't';
        const priv = ex ? ['anon', 'authenticated', 'service_role'].flatMap((r) => ['select', 'insert', 'update', 'delete'].filter((p) => sql(`select has_table_privilege('${r}', 'public.${t}', '${p}')`) === 't').map((p) => `${r}:${p}`)) : [];
        const pols = ex ? pj(sql(`select coalesce(json_agg(json_build_object('n', policyname, 'p', permissive, 'c', cmd, 'r', roles::text, 'q', qual) order by policyname), '[]') from pg_policies where schemaname = 'public' and tablename = '${t}'`)) : [];
        const read = pols.find((q) => q.n === spec.read);
        const fence = pols.find((q) => q.n === 'second_step_fence');
        const writes = pols.filter((q) => q.p === 'PERMISSIVE' && q.c !== 'SELECT');
        ok(ex && rls && JSON.stringify(priv) === JSON.stringify(spec.grants) && (spec.read ? read && read.c === 'SELECT' && read.r === '{authenticated}' : !pols.length)
           && (spec.fence ? fence && fence.p === 'RESTRICTIVE' : !fence) && writes.length === 0,
          `${t}: RLS on, grants ${spec.grants.join(' ')}, ${spec.read ? 'its read rule to authenticated, the second step fence, ' : 'no policy, '}no write policy (${short({ priv, pols: pols.map((q) => `${q.n}:${q.p}:${q.c}:${q.r}`) }, 300)})`);
      }
      ok(/stock_reach_orgs/.test(sql(`select qual from pg_policies where tablename = 'stock_co_option_rules' and policyname = 'stock_co_option_rules_read'`))
         && /stock_reach_locations/.test(sql(`select qual from pg_policies where tablename = 'stock_co_option_rule_sites' and policyname = 'stock_co_option_rule_sites_read'`)),
        'read rules: rules by stock_reach_orgs, site rows by stock_reach_locations');
      ok(num(`select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('stock_sale_takes', 'stock_co_option_rules', 'stock_co_option_rule_sites')`) === 0, 'none of the three is in supabase_realtime');
      const pk = sql(`select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.stock_sale_takes'::regclass and contype = 'p'`);
      ok(pk === 'PRIMARY KEY (location_id, check_id)' && /\(location_id, occurred_at\)/.test(sql(`select coalesce(pg_get_indexdef(to_regclass('public.stock_sale_takes_loc_time')), '')`)),
        `stock_sale_takes: primary key (location_id, check_id), index on (location_id, occurred_at) (${pk})`);
      ok(sql(`select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.stock_co_option_rule_sites'::regclass and contype = 'p'`) === 'PRIMARY KEY (rule_id, location_id)'
         && /WHERE \(archived_at IS NULL\)/.test(sql(`select coalesce(pg_get_indexdef(to_regclass('public.stock_co_option_rules_recipe')), '')`))
         && /\(org_id\)/.test(sql(`select coalesce(pg_get_indexdef(to_regclass('public.stock_co_option_rules_org')), '')`))
         && /site_modifier_id IS NOT NULL/.test(sql(`select coalesce(pg_get_indexdef(to_regclass('public.stock_co_option_rule_sites_loc')), '')`)),
        'the option tables\' keys and indexes as contract 1.2');
      // the shape CHECK and the org guard
      const latte = sql(`select company_ref from recipes where id = '${R.pLatte}'`);
      const milk = sql(`select company_ref from inventory_items where id = '${I.pMilk}'`);
      const oat = sql(`select company_ref from inventory_items where id = '${I.pOat}'`);
      const water = sql(`select company_ref from inventory_items where id = '${I.sWater}'`);
      const soloRecipe = sql(`select company_ref from recipes where id = '${R.sWater}'`);
      const tryRule = (vals) => c.psql({ input: `\\set VERBOSITY verbose\ninsert into stock_co_option_rules (org_id, recipe_id, kind, option_name, option_company_item_id, replaces_item_id, removes_item_id) values (${vals})`, allowFail: true });
      const sqlstate = (rr) => (/ERROR:\s+([0-9A-Z]{5})/.exec(rr.stderr || '') || [])[1] || (rr.status ? 'error' : 'ok');
      const shape = [
        [`'${ORG_T}', '${latte}', 'replace', 'Oat', null, '${milk}', null`, 'a replace with no option item'],
        [`'${ORG_T}', '${latte}', 'replace', 'Oat', '${milk}', '${milk}', null`, 'a replace of an item by itself'],
        [`'${ORG_T}', '${latte}', 'remove', 'No milk', null, '${milk}', '${milk}'`, 'a remove that also replaces'],
        [`'${ORG_T}', '${latte}', 'swap', 'Oat', '${oat}', '${milk}', null`, 'an unknown kind'],
        [`'${ORG_T}', '${latte}', 'replace', '  ', '${oat}', '${milk}', null`, 'a blank option name'],
      ];
      for (const [vals, what] of shape) { const rr = tryRule(vals); ok(sqlstate(rr) === '23514', `stock_co_option_rules refuses ${what} (23514; got ${sqlstate(rr)} ${short((rr.stderr || '').split('\n')[0], 140)})`); }
      const g1 = tryRule(`'${ORG_T}', '${soloRecipe}', 'remove', 'No water', null, null, '${water}'`);
      ok(g1.status !== 0 && /That recipe is not in this company\./.test(g1.stderr), `the org guard: a recipe of another company (${short((g1.stderr || '').trim(), 120)})`);
      const g2 = tryRule(`'${ORG_T}', '${latte}', 'remove', 'No water', null, null, '${water}'`);
      ok(g2.status !== 0 && /That stock item is not in this company\./.test(g2.stderr), 'the org guard: a stock item of another company');
      const ok1 = c.psql({ input: `insert into stock_co_option_rules (id, org_id, recipe_id, kind, option_name, option_company_item_id, replaces_item_id) values ('${DOPT.a}', '${ORG_T}', '${latte}', 'replace', 'Oat milk', '${oat}', '${milk}')`, allowFail: true });
      ok(ok1.status === 0, `a good rule saves (${ok1.status ? short(ok1.stderr, 200) : 'ok'})`);
      const g3 = c.psql({ input: `insert into stock_co_option_rule_sites (rule_id, org_id, location_id, site_modifier_id) values ('${DOPT.a}', '${ORG_T}', '${SOLO}', 'm-oat')`, allowFail: true });
      ok(g3.status !== 0 && /That site is not in this company\./.test(g3.stderr), 'the org guard: a site of another company');
      const g4 = c.psql({ input: `update stock_co_option_rules set org_id = '${ORG_S}' where id = '${DOPT.a}'`, allowFail: true });
      ok(g4.status !== 0 && /That stock record cannot move to another company\./.test(g4.stderr),
        'the org guard: a rule cannot move to another company');
      sql(`delete from stock_co_option_rules where id = '${DOPT.a}'`);
      // the nine triggers
      const td = (t, n) => sql(`select coalesce(pg_get_triggerdef(oid), '') from pg_trigger where tgrelid = 'public.${t}'::regclass and tgname = '${n}' and not tgisinternal`);
      const TRG = [
        ['stock_movements', 'stock_movements_day_sums_ins', /AFTER INSERT ON public\.stock_movements REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION (public\.)?_stock_day_sums_apply\(\)/],
        ['stock_movements', 'stock_movements_day_sums_upd', /AFTER UPDATE ON public\.stock_movements REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION (public\.)?_stock_day_sums_apply\(\)/],
        ['stock_movements', 'stock_movements_day_sums_del', /AFTER DELETE ON public\.stock_movements REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION (public\.)?_stock_day_sums_apply\(\)/],
        ['closed_checks', 'closed_checks_sales_day_ins', /AFTER INSERT ON public\.closed_checks REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION (public\.)?_sales_day_sums_enqueue\(\)/],
        ['closed_checks', 'closed_checks_sales_day_upd', /AFTER UPDATE ON public\.closed_checks REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION (public\.)?_sales_day_sums_enqueue\(\)/],
        ['venue_clock', 'venue_clock_requeue_ins', /AFTER INSERT ON public\.venue_clock FOR EACH ROW EXECUTE FUNCTION (public\.)?_venue_clock_requeue\(\)/],
        ['venue_clock', 'venue_clock_requeue_upd', /AFTER UPDATE OF timezone, day_start ON public\.venue_clock FOR EACH ROW WHEN \(\(\(?old\.timezone IS DISTINCT FROM new\.timezone\)? OR \(?old\.day_start IS DISTINCT FROM new\.day_start\)?\)\) EXECUTE FUNCTION (public\.)?_venue_clock_requeue\(\)/],
        ['stock_co_option_rules', 'stock_co_option_org_guard', /BEFORE INSERT OR UPDATE ON public\.stock_co_option_rules FOR EACH ROW EXECUTE FUNCTION (public\.)?stock_co__option_org_guard\(\)/],
        ['stock_co_option_rule_sites', 'stock_co_option_org_guard', /BEFORE INSERT OR UPDATE ON public\.stock_co_option_rule_sites FOR EACH ROW EXECUTE FUNCTION (public\.)?stock_co__option_org_guard\(\)/],
      ];
      for (const [t, n, re] of TRG) { const d = td(t, n); ok(re.test(d), `${n} on ${t} as contract 1.3 (${short(d, 220)})`); }
      ok(num(`select count(*) from pg_trigger where tgrelid = 'public.stock_movements'::regclass and not tgisinternal`) === 3, 'stock_movements carries exactly the three day total triggers');
      // the functions
      const bad = [];
      for (const [sig, lang, definer, vol, sp, grants] of [...NEW_FUNCS, ...OPTIONAL_FUNCS.filter(([s]) => fnExists(`public.${s}`))]) {
        const full = `public.${sig}`;
        if (!fnExists(full)) { bad.push(`${sig} missing`); continue; }
        const f = pj(sql(`select json_build_object('l', l.lanname, 'd', p.prosecdef, 'v', p.provolatile, 'k', p.prokind) from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = to_regprocedure('${full}')`));
        if (lang && f.l !== lang) bad.push(`${sig} language ${f.l}`);
        if (f.d !== definer) bad.push(`${sig} definer ${f.d}`);
        if (vol === 'p' ? f.k !== 'p' : f.v !== vol) bad.push(`${sig} ${vol === 'p' ? `kind ${f.k}` : `volatility ${f.v}`}`);
        if (pathOf(full) !== sp) bad.push(`${sig} search_path '${pathOf(full)}'`);
        const acl = aclOf(full); const want = ['postgres', ...grants].sort().join(',');
        if (acl !== want) bad.push(`${sig} EXECUTE ${acl} (want ${want})`);
      }
      ok(bad.length === 0, `every function of contract 2.2 to 2.5: language, definer or invoker, volatility, search_path and exactly its grants (${bad.join('; ') || 'all'})`);
      const res = (sig) => sql(`select pg_get_function_result(to_regprocedure('public.${sig}'))`);
      ok(res('stock_explode_lines(uuid,jsonb,text,text)') === 'TABLE(line_no integer, line_uid text, menu_item_id text, line_qty numeric, inventory_item_id uuid, unit_qty_base numeric, qty_base numeric, note text)'
         && res('stock_explode(uuid,jsonb,text,text)') === 'TABLE(inventory_item_id uuid, qty_base numeric)' && res('stock_explode_skipped(uuid,jsonb,text)') === 'integer'
         && res('_stock_takes_share(jsonb,jsonb)') === 'TABLE(line_no integer, inventory_item_id uuid, qty_base numeric, refund_qty numeric)'
         && res('_sales_check_parts(closed_checks)') === 'TABLE(gross_minor bigint, tax_minor bigint, net_minor bigint, reward_minor bigint, reward_tax_minor bigint, charged_nothing boolean, legacy boolean)'
         && res('stock_drainer_health(uuid)') === 'jsonb' && res('stock_day_sums_rebuild(uuid,date,date)') === 'jsonb' && res('sales_day_sums_check(uuid,date)') === 'jsonb',
        'the result shapes of contract 2.3 to 2.5');
      const args = ['stock_explode_lines(uuid,jsonb,text,text)', 'stock_drainer_health(uuid)', 'stock_day_sums_drain(integer,integer)']
        .map((s2) => sql(`select pg_get_function_arguments(to_regprocedure('public.${s2}'))`));
      ok(args[0] === "p_loc uuid, p_lines jsonb, p_order_type text, p_qty_key text DEFAULT 'qty'::text" && args[1] === 'p_location uuid DEFAULT NULL::uuid'
         && args[2] === 'IN p_budget_s integer DEFAULT 40, IN p_batch integer DEFAULT 20',
        `argument names and defaults as the contract (${args.join(' | ')})`);
      const open = sql(`select coalesce(string_agg(p.oid::regprocedure::text, ', '), '') from pg_proc p where p.pronamespace = 'public'::regnamespace
         and p.oid = any (array[${[...NEW_FUNCS, ...OPTIONAL_FUNCS].map(([s]) => `to_regprocedure('public.${s}')`).join(', ')}]::oid[])
         and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'))`);
      ok(open === '', `no new or replaced function is open to public, anon or authenticated (${open || 'none'})`);
      const jobs = sql(`select coalesce(string_agg(schedule || '|' || command, ';'), '') from cron.job where jobname = 'stock-day-sums-drain'`);
      ok(jobs === '* * * * *|call public.stock_day_sums_drain();', `cron stock-day-sums-drain every minute: ${jobs}`);
      ok(CHECKED_ONLY.every(([sig, md5]) => md5Of(sig) === md5), 'the 21 bodies it only checked are untouched (posting core, outbox, waste, the sales report)');
    });
  }

  // ==================================================================================================
  section(23, '23. The every channel basket after the release: identical movements, waste, outbox events and net of VAT');
  const after = {};
  if (AFTER && pasted) {
    for (const [db, label] of [['n_d0', 'v2'], ['n_d0b', 'v2 with 0b']]) {
      await guarded(`basket ${label}`, () => {
        c.createFrom(`n_bk2_${db}`, `n_dr_${db}`);
        c.use(`n_bk2_${db}`);
        // the presets get their kind as the Back Office saves it (contract 3.2)
        const k = asCaller('ownerT', presetKindsSql.split(';').map((s) => s.trim()).filter(Boolean).join(';\n'));
        ok(k.status === 0 && num(`select count(*) from discounts where kind is not null`) === 4, `the owner marks Staff meal, Manager comp and Loyalty treat in Back Office > Discounts (${outcome(k)})`);
        const { out, problems } = runBasket(t0);
        ok(problems.length === 0, `${label}: every check, refund, void and undo is written by its own writer (${problems.slice(0, 5).join('; ') || 'all written'})`);
        after[db] = out;
      });
      if (before[db] && after[db]) basketCompare(`${label} against ${label.replace('v2', 'v1')}`, before[db], after[db]);
    }
    await guarded('basket after: new rows and takes', () => {
      c.use('n_bk2_n_d0');
      const out = after.n_d0;
      if (!out) throw new Error('the basket after the release did not run');
      // the SQL port gives the JS figures on every basket check
      for (const v of BASKET) {
        const got = pj(sql(`select coalesce(json_object_agg(c.id, to_jsonb(p)), '{}') from closed_checks c cross join lateral public._sales_check_parts(c) p
                             where left(c.id, ${v.p.length + 1}) = '${v.p}-' or left(c.id, ${v.p.length + 6}) = 'demo-${v.p}-'`)) || {};
        const want = netOf(out[v.p].checks);
        const off = Object.keys(want).filter((id) => !got[id] || ['gross_minor', 'tax_minor', 'net_minor', 'reward_minor', 'reward_tax_minor'].some((kk) => Number(got[id][kk]) !== want[id][kk])
          || got[id].charged_nothing !== want[id].charged_nothing || got[id].legacy !== want[id].legacy);
        ok(off.length === 0 && Object.keys(want).length > 0, `${VNAME[v.loc]}: _sales_check_parts gives the JS integers on all ${Object.keys(want).length} checks (${off.map((id) => `${id} ${short(got[id])} want ${short(want[id])}`).join('; ') || 'all equal'})`);
      }
      // what each sale took (stock_sale_takes), against the movements it posted
      for (const v of BASKET) {
        const b = out[v.p].booked;
        const takes = pj(sql(`select coalesce(json_object_agg(check_id, json_build_object('lines', lines, 'ot', order_type, 'occ', occurred_at)), '{}') from stock_sale_takes
                               where location_id = '${v.loc}' and (left(check_id, ${v.p.length + 1}) = '${v.p}-' or left(check_id, ${v.p.length + 6}) = 'demo-${v.p}-')`)) || {};
        const sales = b.outbox.filter((o) => o.kind === 'sale' && o.status === 'done');
        const wantRow = sales.filter((o) => !(o.flags || []).includes('cancelled_before_made')).map((o) => o.check);
        const extra = Object.keys(takes).filter((k) => !wantRow.includes(k));
        const miss = wantRow.filter((k) => !takes[k]);
        ok(miss.length === 0 && extra.length === 0, `${VNAME[v.loc]}: one stock_sale_takes row per sale event that reached the posting step, none for a tomb or a cancelled one (${wantRow.length}; missing ${miss.join(', ') || 'none'}; extra ${extra.join(', ') || 'none'})`);
        const bad = [];
        for (const id of wantRow) {
          const row = takes[id]; if (!row) continue;
          const chk = out[v.p].checks.find((r) => r.id === id);
          const items = Array.isArray(chk.items) ? chk.items : [];
          const sold = items.map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => l && typeof l === 'object' && !Array.isArray(l) && !jsTruthy(l.voided) && (jsKey(l.itemId) ?? jsKey(l.id)) && jsQty(l.qty) > 0);
          const lines = Array.isArray(row.lines) ? row.lines : [];
          if (JSON.stringify(lines.map((t) => t.n).sort((p, q) => p - q)) !== JSON.stringify(sold.map((s) => s.n))) bad.push(`${id}: lines n ${lines.map((t) => t.n)} want ${sold.map((s) => s.n)}`);
          for (const t of lines) {
            const s = sold.find((z) => z.n === t.n); if (!s) continue;
            if ((t.u ?? null) !== (jsKey(s.l.uid) ?? null) || t.m !== (jsKey(s.l.itemId) ?? jsKey(s.l.id))) bad.push(`${id} n${t.n}: u ${t.u} m ${t.m}`);
            const netted = id.endsWith('-cater-net') && s.l.uid === 'n1' ? 1 : 0;
            if (!near(t.q, jsQty(s.l.qty) - netted, 1e-9)) bad.push(`${id} n${t.n}: q ${t.q}`);
          }
          const per = {}; const cost = {};
          for (const m of b.movements) if (m.check === id && m.key === `sale:${id}:${m.item}`) { per[m.item] = -Number(m.qty); cost[m.item] = Number(m.cost); }
          const sum = {};
          for (const t of lines) for (const e of (t.t || [])) sum[e.i] = (sum[e.i] || 0) + Number(e.b) * Number(t.q);
          for (const it of new Set([...Object.keys(per), ...Object.keys(sum).filter((k) => sum[k] > 0.00005)])) {
            if (!near(per[it] ?? 0, sum[it] ?? 0, 1.5e-4)) bad.push(`${id}: ${it} took ${per[it]} takes say ${sum[it]}`);
          }
          for (const t of lines) {
            const want = (t.t || []).reduce((s2, e) => s2 + Number(e.b) * Number(t.q) * (cost[e.i] ?? 0), 0);
            if (!near(t.c, want, 1e-6)) bad.push(`${id} n${t.n}: c ${t.c} want ${want}`);
          }
          if (row.ot !== (chk.order_type ?? null)) bad.push(`${id}: order_type ${row.ot}`);
        }
        ok(bad.length === 0, `${VNAME[v.loc]}: every takes row has the sold lines (n, uid, menu id, qty less any netted refund), per unit amounts that add up to the movements posted, and each line's theoretical cost (${bad.slice(0, 4).join('; ') || 'all'})`);
      }
      const types = pj(sql(`select json_build_object('mv', (select coalesce(json_agg(distinct movement_type || ':' || coalesce(source_type, '')), '[]') from stock_movements where left(source_id, 1) = 'b'),
         'flags', (select coalesce(json_agg(distinct f), '[]') from stock_outbox o, unnest(o.flags) f where left(o.check_id, 1) = 'b'))`));
      ok(!(types.flags || []).some((f) => NEW_FLAGS.includes(f)), `no new flag on any basket event (they belong to the new paths only) (${short(types.flags, 300)})`);
      ok(num(`select count(*) from sales_day_sums_queue`) + num(`select count(*) from sales_day_sums`) > 0 && num(`select count(*) from stock_day_sums`) > 0,
        'the new rows are in the new tables: stock_day_sums, sales_day_sums and the queues');
    });
  }

  // ==================================================================================================
  section(24, '24. The deliberate changes, each with its own figures (v1 beside v2)');
  const DEL = {};
  if (dlOk) {
    // the events, booked the same way on both copies
    const L = (itemId, qty, extra = {}) => ({ itemId, qty, price: 3, ...extra });
    const sale = (id, loc, lines, ot = 'dine-in') => [loc === PROVO ? 'tillProvo' : 'tillLoc2', insertRow({ id, location_id: loc, ref: id.toUpperCase().replace(/-/g, ''), items: lines,
      subtotal: 3 * lines.reduce((s, l) => s + l.qty, 0), total: 3 * lines.reduce((s, l) => s + l.qty, 0), tax_amount: 0.5 * lines.reduce((s, l) => s + l.qty, 0), order_type: ot,
      tenders: [{ method: 'card', amount: 3 * lines.reduce((s, l) => s + l.qty, 0) }], closed_at: new Date(Date.now() - 5 * 60000).toISOString() })];
    const refundOf = (id, rid, items, full = false) => ['tillProvo', `update closed_checks set refunds = coalesce(refunds, '[]'::jsonb) || ${jlit([{ id: rid, timestamp: Date.now() - 60000, items, isFullRefund: full, amount: 1 }])}, status = '${full ? 'refunded' : 'partial_refund'}' where id = '${id}' returning id`];
    const EVENTS1 = [
      sale('dl-arch-recipe', PROVO, [L(DM.muffin, 2)]), sale('dl-arch-item', PROVO, [L(DM.lemonTea, 1)]), sale('dl-arch-pack', PROVO, [L(DM.scoop, 2)]),
      sale('dl-arch-bridge', PROVO, [L(DM.caramel, 1)]), sale('dl-made3', PROVO, [L(DM.club, 2)]), sale('dl-loop', PROVO, [L(DM.pie, 1)]), sale('dl-depth', PROVO, [L(DM.deep, 1)]),
      sale('dl-norecipe', PROVO, [L(DM.sauce, 1)]), sale('dl-soup-p', PROVO, [L(M.pSoup, 2)]), sale('dl-soup-l', LOC2, [L(M.lSoup, 2)]),
      sale('dl-oat', PROVO, [L(M.pLatte, 2, { uid: 'o1', mods: [{ itemId: DM.oat, name: 'Oat milk', qty: 1, price: 0.5 }] })]),
      sale('dl-oat-l2', LOC2, [L(M.lLatte, 1, { uid: 'o2', mods: [{ id: 'mod-oat-l2', name: 'Oat milk' }] })]),
      sale('dl-nocheese', PROVO, [L(DM.toastie, 2, { uid: 't1', mods: [{ id: 'mod-nocheese', name: 'No cheese', _instruction: true }] })]),
      sale('dl-remove-wins', PROVO, [L(M.pLatte, 1, { uid: 'w1', mods: [{ itemId: DM.oat, qty: 1 }, { id: 'mod-nomilk', name: 'No milk', _instruction: true }] })]),
      sale('dl-mod-own', PROVO, [L(M.pLatte, 1, { uid: 'w2', mods: [{ itemId: DM.oat, qty: 1 }, { itemId: DM.milkShot, qty: 1 }] })]),
      sale('dl-no-site', LOC2, [L(M.lLatte, 1, { uid: 'w3', mods: [{ id: DM.oat, name: 'Oat milk' }] })]),
      sale('dl-rs1', PROVO, [L(M.pFlat, 3, { uid: 'r1' }), L(BM.juice, 2, { uid: 'r2' }), L(M.pLatte, 2, { uid: 'r3' })]),
      sale('dl-rs2', PROVO, [L(M.pLatte, 1), L(M.pLatte, 1, { mods: [{ itemId: DM.oat, qty: 1 }] }), L(M.pFlat, 1)]),
      sale('dl-rs3', PROVO, [L(M.pFlat, 2, { uid: 'q1' })]),
    ];
    const RECIPE_CHANGE = `update recipe_lines set qty = 200 where recipe_id = '${R.pFlat}' and component_item_id = '${I.pMilk}';
      update recipe_lines set qty = 0.020 where recipe_id = '${R.pFlat}' and component_item_id = '${I.pBeans}';`;
    const EVENTS2 = [
      refundOf('dl-rs1', 'dl-rs1-a', [{ uid: 'r1', itemId: M.pFlat, qty: 3, refundQty: 2 }, { uid: 'r2', itemId: BM.juice, qty: 2, refundQty: 1 }]),
      refundOf('dl-rs1', 'dl-rs1-b', [{ uid: 'r3', itemId: M.pLatte, qty: 2, refundQty: 1 }, { uid: 'zz9', itemId: 'm-ghost', qty: 1, refundQty: 1 }]),
      refundOf('dl-rs2', 'dl-rs2-a', [{ itemId: M.pLatte, qty: 1, refundQty: 1 }]),
      refundOf('dl-rs0', 'dl-rs0-a', [{ uid: 'p1', itemId: M.pFlat, qty: 2, refundQty: 1 }]),
      refundOf('dl-rs3', 'dl-rs3-a', [{ uid: 'q1', itemId: M.pFlat, qty: 2, refundQty: 2 }], true),
    ];
    const book = (label, v2) => {
      const problems = [];
      sql(deliberateArchiveSql);
      sql(deliberateToOrderSql);
      if (v2) sql(optionRulesSql());
      for (const [who, q] of EVENTS1) { const r = asCaller(who, q); if (r.status) problems.push(outcome(r)); }
      drain();
      sql(RECIPE_CHANGE);
      for (const [who, q] of EVENTS2) { const r = asCaller(who, q); if (r.status || !r.out.includes('dl-')) problems.push(`${outcome(r)} ${short(q, 60)}`); }
      drain();
      // takes never undo a sale: the takes insert refused, the sale still books (v2 flags takes_not_saved)
      if (v2) sql(`alter table stock_sale_takes add constraint harness_refuse check (false) not valid`);
      { const r = asCaller(...sale('dl-rs4', PROVO, [L(M.pFlat, 1, { uid: 'u4' })])); if (r.status) problems.push(outcome(r)); }
      drain();
      if (v2) sql(`alter table stock_sale_takes drop constraint harness_refuse`);
      { const r = asCaller(...refundOf('dl-rs4', 'dl-rs4-a', [{ uid: 'u4', itemId: M.pFlat, qty: 1, refundQty: 1 }])); if (r.status) problems.push(outcome(r)); }
      drain();
      ok(problems.length === 0, `${label}: every deliberate sale and refund written (${problems.join('; ') || 'all'})`);
      const mv = pj(sql(`select coalesce(json_agg(json_build_object('check', source_id, 'item', inventory_item_id, 'type', movement_type, 'qty', qty_base, 'key', idempotency_key) order by idempotency_key), '[]')
                          from stock_movements where left(source_id, 3) = 'dl-'`));
      const ob = pj(sql(`select coalesce(json_agg(json_build_object('check', check_id, 'kind', kind, 'ref', event_ref, 'status', status, 'flags', flags) order by check_id, kind, event_ref), '[]')
                          from stock_outbox where left(check_id, 3) = 'dl-'`));
      return { movements: mv, outbox: ob };
    };
    await guarded('deliberate v1', () => {
      c.createFrom('n_dl1', 'n_dl');
      c.use('n_dl1');
      DEL.v1 = book('v1', false);
    });
    if (AFTER) {
      await guarded('deliberate v2', () => {
        c.createFrom('n_dl2', 'n_dl');
        c.use('n_dl2');
        const r = c.paste(FILES.d);
        ok(r.status === 0, `the release applies on the deliberate base (a sale booked before it, the deliberate rows not yet archived) (${r.status ? short(r.stderr, 400) : `${r.ms} ms`})`);
        DEL.v2 = book('v2', true);
      });
    }
    const T = (set, id) => { const o = {}; for (const m of (set?.movements || [])) if (m.check === id && m.key === `sale:${id}:${m.item}`) o[m.item] = -Number(m.qty); return o; };
    const back = (set, id, rid, types = ['SALE_DEPLETION', 'RETURN']) => {
      const o = {};
      for (const m of (set?.movements || [])) if (m.check === id && types.includes(m.type) && m.key.split(':')[2] === rid && !m.key.startsWith('undo:') && !m.key.startsWith('sale:')) o[`${m.type}:${m.item}`] = (o[`${m.type}:${m.item}`] || 0) + Number(m.qty);
      return o;
    };
    const fl = (set, id, kind = 'sale', ref = '') => ((set?.outbox || []).find((o) => o.check === id && o.kind === kind && o.ref === ref) || {}).flags;
    const same = (got, want) => {
      const keys = new Set([...Object.keys(got || {}), ...Object.keys(want)]);
      return [...keys].every((k) => near(got?.[k] ?? 0, want[k] ?? 0, 1e-4));
    };
    const show = (o) => short(Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [Object.entries({ ...I, ...DI, ...BI }).find(([, z]) => k.endsWith(z))?.[0] || k.slice(0, 8), Math.round(v * 10000) / 10000])), 300);
    const CASES = [
      ['dl-arch-recipe', 'D1 an archived recipe still linked takes nothing', { [I.pEggs]: 2 }, {}, [], ['nothing_to_take']],
      ['dl-arch-item', 'D1 a line on an archived item is left out, not counted', { [I.pLemons]: 1, [DI.teaOld]: 1 }, { [I.pLemons]: 1 }, [], []],
      ['dl-arch-pack', 'D1 a line on an archived pack is left out and flags unit_skipped', { [DI.cocoa]: 0.1 }, {}, [], ['nothing_to_take', 'unit_skipped']],
      ['dl-arch-bridge', 'D1 a line whose only bridge is archived is left out and flags unit_skipped', { [DI.caramel]: 10 }, {}, [], ['nothing_to_take', 'unit_skipped']],
      ['dl-made3', 'D2 made to order three levels down: raw chicken (80% usable), eggs, oil and garlic come off', { [DI.fill]: 2 },
        { [DI.chicken]: 0.375, [I.pEggs]: 0.4, [DI.oil]: 0.04, [DI.garlic]: 0.08 }, [], []],
      ['dl-loop', 'D2 a made to order loop is refused: the looping item itself comes off, flag to_order_fallback', { [DI.pieMix]: 1 },
        { [DI.pieMix]: 0.5, [I.pEggs]: 1, [DI.garlic]: 1 }, [], ['to_order_fallback']],
      ['dl-depth', 'D2 the depth cap (6 sub recipe levels): levels 1 to 6 expand, layer 7 itself comes off, flag to_order_fallback', { [DEEP[0]]: 1 },
        { [DI.garlic]: 6, [DEEP[6]]: 1 }, [], ['to_order_fallback']],
      ['dl-norecipe', 'D2 a made to order item with no recipe comes off itself, flag to_order_fallback', { [DI.sauce]: 0.1 }, { [DI.sauce]: 0.1 }, [], ['to_order_fallback']],
      ['dl-soup-p', 'D2 per site: the soup is made to order at Provo, so its raw milk and butter come off', { [I.pSoup]: 0.7 }, { [I.pMilk]: 0.14, [I.pButter]: 0.28 }, [], []],
      ['dl-soup-l', 'D2 per site: the same company soup is made in batches at Location 2, so the soup comes off', { [I.lSoup]: 0.7 }, { [I.lSoup]: 0.7 }, [], []],
      ['dl-oat', 'D3 oat milk replaces the latte\'s milk at Provo; the oat modifier does not also take its own recipe', { [I.pMilk]: 0.5, [I.pOat]: 0.5, [I.pBeans]: 0.036, [I.pCups]: 2 },
        { [I.pOat]: 0.5, [I.pBeans]: 0.036, [I.pCups]: 2 }, [], []],
      ['dl-oat-l2', 'D3 oat milk at Location 2 (its own oat milk, kept in ml): 0.25 l of milk becomes 250 ml of oat milk', { [I.lMilk]: 0.25, [I.lBeans]: 0.018, [I.lCups]: 1 },
        { [I.lOat]: 250, [I.lBeans]: 0.018, [I.lCups]: 1 }, [], []],
      ['dl-nocheese', 'D3 no cheese removes the cheese line (an instruction modifier matches)', { [DI.cheddar]: 0.08, [DI.sliced]: 4, [I.pButter]: 0.08 },
        { [DI.sliced]: 4, [I.pButter]: 0.08 }, [], []],
      ['dl-remove-wins', 'D3 remove wins over replace on one line: no milk and no oat milk', { [I.pMilk]: 0.25, [I.pOat]: 0.25, [I.pBeans]: 0.018, [I.pCups]: 1 },
        { [I.pBeans]: 0.018, [I.pCups]: 1 }, [], []],
      ['dl-mod-own', 'D3 options apply to the dish\'s own recipe only: the milk shot modifier keeps its own whole milk', { [I.pMilk]: 0.3, [I.pOat]: 0.25, [I.pBeans]: 0.018, [I.pCups]: 1 },
        { [I.pOat]: 0.25, [I.pMilk]: 0.05, [I.pBeans]: 0.018, [I.pCups]: 1 }, [], []],
      ['dl-no-site', 'D3 a rule with no site row at the venue does nothing (Provo\'s modifier id at Location 2)', { [I.lMilk]: 0.25, [I.lBeans]: 0.018, [I.lCups]: 1 },
        { [I.lMilk]: 0.25, [I.lBeans]: 0.018, [I.lCups]: 1 }, [], []],
    ];
    for (const [id, what, w1, w2, f1, f2] of CASES) {
      if (DEL.v1) ok(same(T(DEL.v1, id), w1) && JSON.stringify(fl(DEL.v1, id) || []) === JSON.stringify(f1), `v1 ${id}: ${show(T(DEL.v1, id))}, flags ${short(fl(DEL.v1, id))} (today's rule)`);
      if (DEL.v2) ok(same(T(DEL.v2, id), w2) && JSON.stringify((fl(DEL.v2, id) || []).slice().sort()) === JSON.stringify(f2.slice().sort()), `v2 ${what}: ${show(T(DEL.v2, id))}, flags ${short(fl(DEL.v2, id))}`);
    }
    const RF = [
      ['dl-rs1', 'dl-rs1-a', 'D4 a part refund after a recipe change gives back what the sale took (2 of 3 flat whites at 150 ml, not today\'s 200 ml); the sealed juice goes back on the shelf',
        { [`SALE_DEPLETION:${I.pMilk}`]: 0.4, [`SALE_DEPLETION:${I.pBeans}`]: 0.04, [`RETURN:${BI.juice}`]: 1 },
        { [`SALE_DEPLETION:${I.pMilk}`]: 0.3, [`SALE_DEPLETION:${I.pBeans}`]: 0.036, [`RETURN:${BI.juice}`]: 1 }, [], []],
      ['dl-rs1', 'dl-rs1-b', 'D4 a refund line that matches no sold line gives nothing back and flags refund_line_unmatched',
        { [`SALE_DEPLETION:${I.pMilk}`]: 0.25, [`SALE_DEPLETION:${I.pBeans}`]: 0.018, [`SALE_DEPLETION:${I.pCups}`]: 1 },
        { [`SALE_DEPLETION:${I.pMilk}`]: 0.25, [`SALE_DEPLETION:${I.pBeans}`]: 0.018, [`SALE_DEPLETION:${I.pCups}`]: 1 }, [], ['refund_line_unmatched']],
      ['dl-rs2', 'dl-rs2-a', 'D4 a refund with no uid gives back the menu item\'s average per unit of the sale (half a plain latte, half an oat latte)',
        { [`SALE_DEPLETION:${I.pMilk}`]: 0.25, [`SALE_DEPLETION:${I.pBeans}`]: 0.018, [`SALE_DEPLETION:${I.pCups}`]: 1 },
        { [`SALE_DEPLETION:${I.pMilk}`]: 0.125, [`SALE_DEPLETION:${I.pOat}`]: 0.125, [`SALE_DEPLETION:${I.pBeans}`]: 0.018, [`SALE_DEPLETION:${I.pCups}`]: 1 }, [], []],
      ['dl-rs0', 'dl-rs0-a', 'D4 a sale booked before the release (no takes row) is refunded by today\'s recipe and flags refund_by_recipe',
        { [`SALE_DEPLETION:${I.pMilk}`]: 0.2, [`SALE_DEPLETION:${I.pBeans}`]: 0.02 }, { [`SALE_DEPLETION:${I.pMilk}`]: 0.2, [`SALE_DEPLETION:${I.pBeans}`]: 0.02 }, [], ['refund_by_recipe']],
      ['dl-rs3', 'dl-rs3-a', 'a full refund after a recipe change: everything taken comes back, as before',
        { [`SALE_DEPLETION:${I.pMilk}`]: 0.3, [`SALE_DEPLETION:${I.pBeans}`]: 0.036 }, { [`SALE_DEPLETION:${I.pMilk}`]: 0.3, [`SALE_DEPLETION:${I.pBeans}`]: 0.036 }, [], []],
      ['dl-rs4', 'dl-rs4-a', 'takes never undo a sale: the takes row was refused, the sale booked; its refund goes by today\'s recipe (refund_by_recipe)',
        { [`SALE_DEPLETION:${I.pMilk}`]: 0.2, [`SALE_DEPLETION:${I.pBeans}`]: 0.02 }, { [`SALE_DEPLETION:${I.pMilk}`]: 0.2, [`SALE_DEPLETION:${I.pBeans}`]: 0.02 }, [], ['refund_by_recipe']],
    ];
    for (const [id, rid, what, w1, w2, f1, f2] of RF) {
      if (DEL.v1) ok(same(back(DEL.v1, id, rid), w1) && JSON.stringify(fl(DEL.v1, id, 'refund', rid) || []) === JSON.stringify(f1), `v1 ${rid}: ${show(back(DEL.v1, id, rid))} (today's recipe)`);
      if (DEL.v2) ok(same(back(DEL.v2, id, rid), w2) && JSON.stringify((fl(DEL.v2, id, 'refund', rid) || []).slice().sort()) === JSON.stringify(f2.slice().sort()), `v2 ${what}: ${show(back(DEL.v2, id, rid))}, flags ${short(fl(DEL.v2, id, 'refund', rid))}`);
    }
    if (DEL.v2) {
      const w = (DEL.v2.movements || []).filter((m) => m.check === 'dl-rs1' && m.key.split(':')[2] === 'dl-rs1-a');
      ok(w.some((m) => m.type === 'WASTE' && m.item === I.pMilk && near(m.qty, -0.3)) && !w.some((m) => m.type === 'WASTE' && m.item === BI.juice),
        'D4 refunded food is waste (the milk given back is booked as waste at once); the sealed juice is never waste');
      ok((fl(DEL.v2, 'dl-rs4') || []).includes('takes_not_saved') && Object.keys(T(DEL.v2, 'dl-rs4')).length === 2,
        `the sale whose takes row was refused still booked its stock, flag takes_not_saved (${short(fl(DEL.v2, 'dl-rs4'))})`);
      c.use('n_dl2');
      const lines = pj(sql(`select lines from stock_sale_takes where check_id = 'dl-oat'`)) || [];
      ok(lines.length === 1 && lines[0].q === 2 && (lines[0].t || []).some((e) => e.i === I.pOat && near(e.b, 0.25)) && !(lines[0].t || []).some((e) => e.i === I.pMilk),
        `the takes of the oat latte keep its oat milk per unit (refunds give back what was taken, options included) (${short(lines, 200)})`);
      const h = callJ('service', `select public.stock_drainer_health('${PROVO}')`).j || {};
      const pv = (h.venues || []).find((z) => z.location_id === PROVO) || {};
      ok(h.ok === false && Number(pv.lines_on_archived) === 2 && Number(pv.foreign_pack_lines) === 1 && Number(pv.to_order_loops) >= 2 && Number(pv.lines_unresolved) >= 1
         && Number(pv.takes_missing_24h) >= 1 && Number(pv.to_order_fallback_24h) >= 3 && Number(pv.unit_skipped_24h) >= 2 && Number(pv.refund_by_recipe_24h) === 2
         && Number(pv.takes_not_saved_24h) === 1 && Number(pv.refund_line_unmatched_24h) === 1 && Number(pv.dead) === 0,
        `stock_drainer_health names every problem the deliberate rows hold (${short(pv, 600)})`);
    }
  }

  // ==================================================================================================
  section(25, '25. Stock day totals: the ledger per venue day, the venue clock, the trigger never failing a post');
  // ledger groups against stock_day_sums for some venue days (the venue clock in force)
  const dayGap = (loc, days) => (days.length ? pj(sql(`with d as (select unnest(array[${days.map((z) => `'${z}'::date`).join(',')}]) as day),
      led as (select v.business_day as day, m.inventory_item_id as i, m.movement_type as t, coalesce(m.source_type, 'unknown') as s,
                     coalesce(left(m.idempotency_key, 8) = 'demo-v1:' or left(m.idempotency_key, 7) = 'demo71:' or left(m.idempotency_key, 5) = 'seed:', false) as demo,
                     sum(m.qty_base) as q, sum(coalesce(m.value_delta, 0)) as v
                from stock_movements m cross join lateral public.stock_co__venue_day(m.location_id, coalesce(m.occurred_at, now())) v
               where m.location_id = '${loc}' group by 1, 2, 3, 4, 5),
      sums as (select business_day as day, inventory_item_id as i, movement_type as t, source_type as s, demo, qty_base as q, value as v from stock_day_sums where location_id = '${loc}')
      select json_build_object('bad', count(*), 'first', min(coalesce(a.day, b.day)::text || ' ' || coalesce(a.t, b.t) || ' ' || coalesce(a.q, 0) || '/' || coalesce(b.q, 0)))
        from (select * from led where day in (select day from d)) a full join (select * from sums where day in (select day from d)) b using (day, i, t, s, demo)
       where coalesce(a.q, 0) <> coalesce(b.q, 0) or coalesce(a.v, 0) <> coalesce(b.v, 0)`)) : { bad: 0 });
  const daysOf = (loc, since) => sql(`select coalesce(string_agg(distinct d.business_day::text, ','), '') from stock_movements m cross join lateral public.stock_co__venue_day(m.location_id, m.occurred_at) d
     where m.location_id = '${loc}' and m.posted_at >= ${since}`).split(',').filter(Boolean);
  const allDays = (loc) => sql(`select coalesce(string_agg(distinct d.business_day::text, ','), '') from stock_movements m cross join lateral public.stock_co__venue_day(m.location_id, m.occurred_at) d
     where m.location_id = '${loc}'`).split(',').filter(Boolean);
  const venueToday = (loc) => sql(`select d.business_day::text from public.stock_co__venue_day('${loc}', now()) d`);
  // an instant some hours into a venue day, on the venue clock in force; a movement posted at it
  const inDay = (loc, day, hours = 3) => `((select public.stock_co__day_start_at('${day}'::date, k.day_start, k.timezone) from public.stock_co__clock_of('${loc}') k) + interval '${hours} hours')`;
  const postAt = (loc, item, q, key, at, src = 'harness_old') => `select public._post_stock_movement('${loc}', '${item}', ${q}, 'MANUAL_ADJ', 0.08, '${src}', null, '${key}', ${at}, null, null, null);`;
  if (AFTER && pasted) {
    // the review of 21 Oct: the trigger adds only the rows that change, so a day it never held whole
    // stays a part total. The paste therefore queues every venue day of the ledger, history included.
    await guarded('stock day totals at the paste', () => {
      c.createFrom('n_bf', 'n_d0');
      c.use('n_bf');
      const t0d = venueToday(PROVO);
      const back = (n) => sql(`select ('${t0d}'::date - ${n})::text`);
      sql([postAt(PROVO, I.pCups, -1, 'dmx:bf1', inDay(PROVO, back(20))), postAt(PROVO, I.pCups, -2, 'dmx:bf2', inDay(PROVO, back(20), 5)),
        postAt(PROVO, I.pMilk, -1, 'dmx:bf3', inDay(PROVO, back(45))), postAt(LOC2, I.lCups, -1, 'dmx:bf4', inDay(LOC2, back(60))),
        postAt(PROVO, I.pCups, -1, 'seed:bf5', inDay(PROVO, back(54)), 'demo_seed')].join('\n'));
      const had = Object.fromEntries([PROVO, LOC2, SOLO].map((v) => [v, allDays(v)]));
      ok([back(20), back(45), back(54)].every((d) => had[PROVO].includes(d)) && had[LOC2].includes(back(60)),
        `history before the release, 20, 45 and 54 days back at Provo and 60 at Location 2 (venue days with movements: ${had[PROVO].length}, ${had[LOC2].length} and ${had[SOLO].length})`);
      const r = c.paste(FILES.d);
      ok(r.status === 0, `the release applies on that history (${r.status ? short(r.stderr, 400) : `${r.ms} ms`})`);
      if (r.status) return;
      const rows = (r.sets[r.sets.length - 1] || { rows: [] }).rows;
      for (const v of [PROVO, LOC2, SOLO]) {
        const q = sql(`select coalesce(string_agg(business_day::text, ','), '') from stock_day_sums_repair where location_id = '${v}'`).split(',').filter(Boolean);
        const recent = sql(`select coalesce(string_agg(d.business_day::text, ','), '') from generate_series(now() - interval '2 days', now(), interval '1 day') g(at)
          cross join lateral public.stock_co__venue_day('${v}', g.at) d`).split(',');
        const missing = had[v].filter((d) => !q.includes(d));
        const extra = q.filter((d) => !had[v].includes(d) && !recent.includes(d));
        const row = rows.find((w) => w.location_id === v);
        ok(missing.length === 0 && extra.length === 0 && row && Number(row.repair_days_queued) === q.length,
          `${VNAME[v]}: the paste queued every venue day that holds a movement (the whole ledger) and nothing else but today and the two days before (${q.length} days, check row ${row?.repair_days_queued}${missing.length ? `; missing ${missing.join(', ')}` : ''}${extra.length ? `; extra ${extra.join(', ')}` : ''})`);
      }
      const loops = dsDrainAll();
      ok(loops > 0, `the drain empties both queues (${loops} runs)`);
      for (const v of [PROVO, LOC2, SOLO]) {
        const days = allDays(v);
        const g = dayGap(v, days);
        const chk = days.map((d) => callJ('service', `select public.stock_day_sums_check('${v}', '${d}')`).j);
        ok(g.bad === 0 && chk.every((z) => z && z.ok === true),
          `${VNAME[v]}: stock_day_sums equals the ledger on every venue day of the whole ledger, and stock_day_sums_check says ok on each (${days.length} days${g.bad ? `; first ${g.first}` : ''})`);
      }
      ok(near(num(`select coalesce(sum(qty_base), 0) from stock_day_sums where location_id = '${PROVO}' and business_day = '${back(54)}' and demo`), -1),
        'the seed row 54 days back is in the demo totals of its own day');
    });
  }
  if (AFTER && pasted && after.n_d0) {
    await guarded('stock day totals', async () => {
      c.createFrom('n_ds', 'n_bk2_n_d0');
      c.use('n_ds');
      // the moment of the paste (its transaction time, stamped on the backup rows): movements posted
      // since then went through the trigger; the days the paste queued are rebuilt whole by the drain
      const pasteAt = sql(`select min(saved_at)::text from stock_native_backup where left(name, 11) = 'drainer_v2:'`);
      const queued = Object.fromEntries([PROVO, LOC2, SOLO].map((v) => [v, sql(`select coalesce(string_agg(business_day::text, ','), '') from stock_day_sums_repair where location_id = '${v}'`).split(',').filter(Boolean)]));
      const loops = dsDrainAll();
      ok(loops > 0, `the drain empties both queues (${loops} runs of stock_day_sums_drain)`);
      for (const v of [PROVO, LOC2, SOLO]) {
        const days = [...new Set([...queued[v], ...daysOf(v, `'${pasteAt}'::timestamptz`)])].sort();
        const today = venueToday(v);
        ok(days.includes(today), `${VNAME[v]}: the release's own day is covered (queued at the paste or written since) (${days.join(', ')})`);
        const ledger = allDays(v);
        const notKept = ledger.filter((d) => !days.includes(d));
        ok(notKept.length === 0, `${VNAME[v]}: and so is every venue day of the ledger (${ledger.length} days${notKept.length ? `; never built: ${notKept.join(', ')}` : ''})`);
        const g = dayGap(v, days);
        ok(g.bad === 0, `${VNAME[v]}: stock_day_sums equals the ledger on every venue day the release keeps (${days.length} days; ${g.bad ? `first ${g.first}` : 'all equal'})`);
        const chk = days.map((d) => callJ('service', `select public.stock_day_sums_check('${v}', '${d}')`).j);
        ok(chk.every((z) => z && z.ok === true), `${VNAME[v]}: stock_day_sums_check says ok on each (${short(chk.filter((z) => !z?.ok), 200) || 'all'})`);
        ok(num(`select count(*) from stock_day_sums where location_id = '${v}' and clock_known`) === 0, `${VNAME[v]}: no venue clock yet, so every row is clock_known false`);
      }
      // the demo markers, inserts, updates and deletes (the days around today rebuilt first, below)
      const mark = (key, q) => `select public._post_stock_movement('${PROVO}', '${I.pCups}', ${q}, 'MANUAL_ADJ', 0.08, 'harness_demo', 'dm', '${key}', now(), null, null, null);`;
      sql([mark('demo-v1:x1', -1), mark('demo71:x2', -1), mark('seed:x3', -1), mark('dmx:x4', -1), mark('dmx:x5', -2)].join('\n'));
      const dm = pj(sql(`select json_object_agg(demo::text, q) from (select demo, sum(qty_base) q from stock_day_sums where location_id = '${PROVO}' and source_type = 'harness_demo' group by demo) z`)) || {};
      ok(near(dm.true, -3) && near(dm.false, -3), `the demo markers (demo-v1:, demo71:, seed:) land in demo rows, the rest in ordinary rows (${short(dm)})`);
      const today = venueToday(PROVO);
      // from here on the days around today are whole (rebuilt), so every insert, update and delete must keep them equal
      ok(callJ('service', `select public.stock_day_sums_rebuild('${PROVO}', '${today}'::date - 5, '${today}'::date + 3)`).j?.ok === true, 'Provo rebuilt for the days around today (the trigger then keeps them)');
      const lo = sql(`select ('${today}'::date - 5)::text`); const hi = sql(`select ('${today}'::date + 3)::text`);
      const scope = () => allDays(PROVO).filter((d) => d >= lo && d <= hi);
      ok(dayGap(PROVO, scope()).bad === 0, 'after the inserts: equal to the ledger');
      sql(`update stock_movements set qty_base = qty_base * 2, value_delta = value_delta * 2 where idempotency_key = 'dmx:x4'`);
      ok(dayGap(PROVO, scope()).bad === 0, 'after an update of the quantity and value: equal');
      sql(`update stock_movements set occurred_at = occurred_at - interval '2 days' where idempotency_key = 'demo71:x2'`);
      ok(dayGap(PROVO, scope()).bad === 0, 'after an update that moves a row to another day: equal on both days');
      sql(`update stock_movements set movement_type = 'WASTE' where idempotency_key = 'dmx:x5'`);
      ok(dayGap(PROVO, scope()).bad === 0, 'after an update of the movement type: equal');
      sql(`update stock_movements set notes = coalesce(notes, '') where location_id = '${PROVO}' and source_type = 'closed_check'`);
      ok(dayGap(PROVO, scope()).bad === 0, 'after a many row update that changes no figure: equal');
      sql(`delete from stock_movements where left(idempotency_key, 7) = 'demo71:' or left(idempotency_key, 8) = 'demo-v1:'`);
      ok(dayGap(PROVO, scope()).bad === 0, 'after the demo files delete their own rows: equal (rows at zero stay, a rebuild drops them)');
      const back = (n) => sql(`select ('${today}'::date - ${n})::text`);
      const lateRows = () => sql(`select coalesce(string_agg(business_day::text || ' ' || reason, ', ' order by business_day), '') from stock_day_sums_repair`);
      ok(lateRows() === `${back(2)} late`,
        `and none of it needed the repair queue for an error: the one row is the day two back that the moved row landed on, queued for a whole rebuild (late) (${lateRows() || 'none'})`);
      dsDrainAll();
      ok(dayGap(PROVO, scope()).bad === 0 && num(`select count(*) from stock_day_sums_repair`) === 0, 'the drain rebuilds it: equal to the ledger, the queue empty');
      // the review of 21 Oct: a day these totals never held whole (rows written while no day totals
      // trigger ran, as before the release), then a late row, a delete and an update on it. Each queues
      // the day (late) and the drain rebuilds it whole; without that the day read -1 against -4.
      const dayChk = (d) => callJ('service', `select public.stock_day_sums_check('${PROVO}', '${d}')`).j || {};
      const D20 = back(20); const D25 = back(25); const D54 = back(54); const Y = back(1);
      sql(`alter table stock_movements disable trigger stock_movements_day_sums_ins;
           ${postAt(PROVO, I.pCups, -1, 'dmx:old1', inDay(PROVO, D20, 1))}
           ${postAt(PROVO, I.pCups, -1, 'dmx:old2', inDay(PROVO, D20, 2))}
           ${postAt(PROVO, I.pCups, -1, 'dmx:old3', inDay(PROVO, D20, 3))}
           alter table stock_movements enable trigger stock_movements_day_sums_ins;`);
      let k20 = dayChk(D20);
      ok(k20.ok === false && near(k20.ledger_qty, -3) && near(k20.sums_qty, 0),
        `a day the totals never held (3 rows 20 days back written with no trigger, as before the release): not ok, ledger -3 against sums 0 (${short(k20)})`);
      sql(postAt(PROVO, I.pCups, -1, 'dmx:old4', inDay(PROVO, D20, 4)));
      k20 = dayChk(D20);
      ok(near(k20.sums_qty, -1) && lateRows() === `${D20} late`, `a late row on it: its delta is added (sums ${k20.sums_qty}) and the day is queued for a whole rebuild (${lateRows() || 'none'})`);
      dsDrainAll();
      k20 = dayChk(D20);
      ok(k20.ok === true && near(k20.sums_qty, -4) && near(k20.ledger_qty, -4) && num(`select count(*) from stock_day_sums_repair`) === 0,
        `the drain rebuilds it whole: -4 against a ledger of -4, stock_day_sums_check ok (${short(k20)})`);
      sql(`delete from stock_movements where idempotency_key = 'dmx:old1'`);
      ok(lateRows() === `${D20} late`, `a delete on that day queues it (${lateRows() || 'none'})`);
      dsDrainAll();
      k20 = dayChk(D20);
      ok(k20.ok === true && near(k20.ledger_qty, -3), `rebuilt: ok at -3 (${short(k20)})`);
      sql(`update stock_movements set occurred_at = ${inDay(PROVO, D25)} where idempotency_key = 'dmx:old2'`);
      ok(lateRows() === `${D25} late, ${D20} late`, `an update that moves a row from 20 to 25 days back queues both days (${lateRows() || 'none'})`);
      dsDrainAll();
      const k25 = dayChk(D25); k20 = dayChk(D20);
      ok(k20.ok === true && k25.ok === true && near(k20.ledger_qty, -2) && near(k25.ledger_qty, -1), `rebuilt: both ok (-2 and -1) (${short([k20, k25])})`);
      sql(`update stock_movements set notes = coalesce(notes, '') where left(idempotency_key, 8) = 'dmx:old'`);
      ok(lateRows() === '', `an update on old rows that moves no figure queues nothing (${lateRows() || 'none'})`);
      sql(postAt(PROVO, I.pCups, -1, 'dmx:yday', inDay(PROVO, Y)));
      ok(lateRows() === '' && dayGap(PROVO, [Y]).bad === 0, `a row dated yesterday is kept by its delta alone (no queue), and yesterday equals the ledger (${lateRows() || 'none'})`);
      sql(postAt(PROVO, I.pCups, -1, 'seed:old5', inDay(PROVO, D54), 'demo_seed'));
      ok(lateRows() === `${D54} late`, `a seed file row 54 days back queues its day (${lateRows() || 'none'})`);
      dsDrainAll();
      ok(dayChk(D54).ok === true && near(num(`select coalesce(sum(qty_base), 0) from stock_day_sums where location_id = '${PROVO}' and business_day = '${D54}' and demo`), -1),
        'rebuilt: ok, the row in the demo totals of its day');
      ok(num(`select count(*) from stock_day_sums_repair`) === 0 && dayGap(PROVO, allDays(PROVO)).bad === 0, 'every Provo venue day of the ledger equals its totals again, the queue empty');
      // the trigger never fails a post: a lock held by a rebuild (forced lock wait)
      const holder = c.psqlAsync({ input: `select pg_advisory_lock(hashtext('stock_day_sums:${PROVO}')); select pg_sleep(2.5); select pg_advisory_unlock(hashtext('stock_day_sums:${PROVO}'));` });
      await new Promise((res) => setTimeout(res, 400));
      const t1 = Date.now();
      const post = c.psql({ input: `select public._post_stock_movement('${PROVO}', '${I.pCups}', -1, 'WASTE', 0.08, 'waste', null, 'dmx:lock1', now(), null, null, null);`, allowFail: true });
      const ms = Date.now() - t1;
      await holder;
      ok(post.status === 0 && ms >= 400 && ms < 2000 && num(`select count(*) from stock_movements where idempotency_key = 'dmx:lock1'`) === 1,
        `a post while a rebuild holds the venue's day totals lock waits at most 500 ms, then posts (${ms} ms)`);
      const rep = sql(`select coalesce(string_agg(business_day::text || ' ' || reason, ', '), '') from stock_day_sums_repair where location_id = '${PROVO}'`);
      ok(/trigger: 55P03/.test(rep), `and its venue day goes to the repair queue (reason trigger: 55P03) (${rep})`);
      dsDrainAll();
      ok(dayGap(PROVO, scope()).bad === 0 && num(`select count(*) from stock_day_sums_repair`) === 0, 'the drain rebuilds that day: equal again, the queue empty');
      // a forced error inside the trigger
      sql(`alter table stock_day_sums add constraint harness_refuse check (movement_type <> 'RETURN') not valid`);
      const p2 = c.psql({ input: `select public._post_stock_movement('${PROVO}', '${I.pCups}', 1, 'RETURN', 0.08, 'harness', null, 'dmx:err1', now(), null, null, null);`, allowFail: true });
      ok(p2.status === 0 && num(`select count(*) from stock_movements where idempotency_key = 'dmx:err1'`) === 1 && /trigger: 23514/.test(sql(`select coalesce(string_agg(reason, ','), '') from stock_day_sums_repair where location_id = '${PROVO}'`)),
        `a forced error in the day totals (a CHECK refusing the row): the movement posts, the day goes to the repair queue (trigger: 23514) (${p2.status ? short(p2.stderr, 200) : 'posted'})`);
      sql(`alter table stock_day_sums_repair add constraint harness_refuse check (false) not valid`);
      const p3 = c.psql({ input: `select public._post_stock_movement('${PROVO}', '${I.pCups}', 1, 'RETURN', 0.08, 'harness', null, 'dmx:err2', now(), null, null, null);`, allowFail: true });
      ok(p3.status === 0 && num(`select count(*) from stock_movements where idempotency_key = 'dmx:err2'`) === 1, 'even when the repair queue refuses too, the movement posts (a warning only)');
      sql(`alter table stock_day_sums drop constraint harness_refuse; alter table stock_day_sums_repair drop constraint harness_refuse;
           insert into stock_day_sums_repair (location_id, business_day, reason) values ('${PROVO}', '${today}', 'harness') on conflict do nothing;`);
      dsDrainAll();
      ok(dayGap(PROVO, scope()).bad === 0, 'once rebuilt: equal again');
      // a real sale through the drainer while the day totals refuse its rows: the sale books, the day is repaired
      sql(`alter table stock_day_sums add constraint harness_refuse check (movement_type <> 'SALE_DEPLETION') not valid`);
      const rs = asCaller('tillProvo', insertRow({ id: 'ds-err-sale', location_id: PROVO, ref: 'DSERR', items: [{ itemId: M.pLatte, qty: 1, price: 3.2, uid: 'e1' }],
        subtotal: 3.2, total: 3.2, tax_amount: 0.53, tenders: [{ method: 'cash', amount: 3.2 }] }));
      drain();
      const sold = num(`select count(*) from stock_movements where source_id = 'ds-err-sale' and movement_type = 'SALE_DEPLETION'`);
      const evs = sql(`select coalesce(string_agg(status || ':' || array_to_string(coalesce(flags, '{}'), '|'), ','), '') from stock_outbox where check_id = 'ds-err-sale'`);
      const reasons = sql(`select coalesce(string_agg(reason, ','), '') from stock_day_sums_repair where location_id = '${PROVO}'`);
      sql(`alter table stock_day_sums drop constraint harness_refuse`);
      ok(rs.status === 0 && sold > 0 && evs === 'done:' && /trigger: 23514/.test(reasons) && num(`select count(*) from stock_sale_takes where check_id = 'ds-err-sale'`) === 1,
        `a till sale drained while the day totals refuse its rows: the sale books (${sold} movements, event ${evs}, its takes row), the day goes to the repair queue (${reasons})`);
      dsDrainAll();
      ok(dayGap(PROVO, scope()).bad === 0 && num(`select count(*) from stock_day_sums_repair`) === 0, 'the drain repairs that day: equal to the ledger again');
      // a rebuild during sales: no lost delta, every post waits at most 500 ms
      const rb = c.psqlAsync({ input: `begin; select public.stock_day_sums_rebuild('${PROVO}', current_date - 30, current_date + 3); select pg_sleep(2); commit;` });
      await new Promise((res) => setTimeout(res, 400));
      const posts = await Promise.all([1, 2, 3, 4].map((k) => c.psqlAsync({ input: `select public._post_stock_movement('${PROVO}', '${I.pCups}', -1, 'WASTE', 0.08, 'waste', null, 'dmx:rb${k}', now(), null, null, null);` })));
      const r0 = await rb;
      ok(r0.code === 0 && posts.every((z) => z.code === 0 && z.ms < 1800) && num(`select count(*) from stock_movements where left(idempotency_key, 6) = 'dmx:rb'`) === 4,
        `4 sales posted while a rebuild held the venue: every one posted, the slowest in ${Math.max(...posts.map((z) => z.ms))} ms`);
      dsDrainAll();
      ok(dayGap(PROVO, scope()).bad === 0, 'and after the drain no delta is lost: equal to the ledger');
      // the drain's backoff: a writer holds the venue (shared) past the rebuild's 2 s wait
      for (const [kind, table] of [['stock_day_sums', 'stock_day_sums_repair'], ['sales_day_sums', 'sales_day_sums_queue']]) {
        const hold = c.psqlAsync({ input: `begin; select pg_advisory_xact_lock_shared(hashtext('${kind}:${PROVO}')); select pg_sleep(3.5); commit;` });
        await new Promise((res) => setTimeout(res, 300));
        sql(`insert into ${table} (location_id, business_day, reason) values ('${PROVO}', '${today}', 'harness') on conflict do nothing`);
        sql('call public.stock_day_sums_drain(3, 20);');
        await hold;
        const rr = pj(sql(`select json_build_object('a', attempts, 'later', due_at > now() + interval '30 seconds', 'e', last_error) from ${table} where location_id = '${PROVO}' and business_day = '${today}'`));
        ok(rr && rr.a === 1 && rr.later === true && /^55P03/.test(rr.e || ''), `${table}: a rebuild that cannot get the venue goes back with attempts 1, due later, last_error 55P03 (${short(rr)})`);
        sql(`update ${table} set due_at = now() where location_id = '${PROVO}'`);
        dsDrainAll();
        ok(num(`select count(*) from ${table}`) === 0, `${table}: due again, the drain rebuilds it`);
      }
      // two drains at once: one runs, the other returns
      for (let d = 0; d < 20; d++) sql(`insert into stock_day_sums_repair (location_id, business_day, reason) values ('${PROVO}', '${today}'::date - ${d}, 'harness') on conflict do nothing`);
      const [d1, d2] = await Promise.all([c.psqlAsync({ input: 'call public.stock_day_sums_drain(10, 2);' }), c.psqlAsync({ input: 'call public.stock_day_sums_drain(10, 2);' })]);
      ok(d1.code === 0 && d2.code === 0 && num(`select count(*) from stock_day_sums_repair`) === 0, `two drains at once: both end cleanly, every day done once (${d1.ms} and ${d2.ms} ms)`);
      // the venue clock: unknown, then it arrives, then the day start changes
      sql(`select public._post_stock_movement('${PROVO}', '${I.pCups}', -1, 'WASTE', 0.08, 'waste', null, 'dmx:clk0', now(), null, null, null);`);
      ok(num(`select count(*) from stock_day_sums_repair`) === 0 && num(`select count(*) from stock_day_sums where location_id = '${PROVO}' and clock_known`) === 0,
        'an unknown clock writes clock_known false and queues nothing');
      let rj = callJ('service', `select public.venue_clock_sync(${jlit([{ ops_location_id: PROVO, platform_location_id: '9a000000-0000-4000-8000-000000000001', timezone: 'America/Denver', business_day_start: '05:00' }])})`).j;
      ok(rj?.ok === true, `the clock arrives (venue_clock_sync, America/Denver 05:00) (${short(rj, 120)})`);
      const q1 = pj(sql(`select json_build_object('s', (select count(*) from stock_day_sums_repair where location_id = '${PROVO}' and reason = 'clock_changed'),
                                                  'q', (select count(*) from sales_day_sums_queue where location_id = '${PROVO}' and reason = 'clock_changed'))`));
      ok(q1.s > 0 && q1.q > 0, `the clock trigger queues every venue day of Provo's totals, stock and sales (${short(q1)})`);
      dsDrainAll();
      const known = num(`select count(*) from stock_day_sums where location_id = '${PROVO}' and not clock_known`);
      ok(known === 0, 'rebuilt: every Provo row is now clock_known');
      ok(dayGap(PROVO, allDays(PROVO)).bad === 0, 'and equal to the ledger on the new days (every movement on its Denver business day)');
      rj = callJ('service', `select public.venue_clock_sync(${jlit([{ ops_location_id: PROVO, platform_location_id: '9a000000-0000-4000-8000-000000000001', timezone: 'America/Denver', business_day_start: '04:00' }])})`).j;
      ok(num(`select count(*) from stock_day_sums_repair where location_id = '${PROVO}' and reason = 'clock_changed'`) > 0, 'a changed day start queues them again');
      dsDrainAll();
      ok(dayGap(PROVO, allDays(PROVO)).bad === 0, 'rebuilt on the 04:00 day: equal to the ledger');
      callJ('service', `select public.venue_clock_sync(${jlit([{ ops_location_id: PROVO, platform_location_id: '9a000000-0000-4000-8000-000000000001', timezone: 'America/Denver', business_day_start: '04:00' }])})`);
      ok(num(`select count(*) from stock_day_sums_repair`) + num(`select count(*) from sales_day_sums_queue`) === 0, 'the same clock again (the nightly upsert) queues nothing');
      // every bucket on the venue day: one minute either side of a day start
      const D = sql(`select (d.business_day - 1)::text from public.stock_co__venue_day('${PROVO}', now()) d`);
      const edge = `public.stock_co__day_start_at('${D}'::date, '04:00', 'America/Denver')`;
      sql(`select public._post_stock_movement('${PROVO}', '${I.pCups}', -1, 'WASTE', 0.08, 'harness_edge', null, 'dmx:edge-a', ${edge} - interval '1 minute', null, null, null);
           select public._post_stock_movement('${PROVO}', '${I.pCups}', -2, 'WASTE', 0.08, 'harness_edge', null, 'dmx:edge-b', ${edge} + interval '1 minute', null, null, null);`);
      const eg = pj(sql(`select json_object_agg(business_day::text, qty_base) from stock_day_sums where location_id = '${PROVO}' and source_type = 'harness_edge'`)) || {};
      const Dm1 = sql(`select ('${D}'::date - 1)::text`);
      ok(near(eg[Dm1], -1) && near(eg[D], -2), `every bucket on the venue day: a minute before 04:00 Denver is the day before, a minute after is the day (${short(eg)})`);
      const hb = callJ('service', 'select public.stock_drainer_health()').j || {};
      const keys = ['location_id', 'mode', 'pending', 'held', 'dead', 'oldest_pending_s', 'done_24h', 'unit_skipped_24h', 'to_order_fallback_24h', 'takes_not_saved_24h', 'refund_by_recipe_24h',
        'refund_line_unmatched_24h', 'takes_missing_24h', 'lines_on_archived', 'lines_unresolved', 'foreign_pack_lines', 'to_order_loops', 'repair_due', 'repair_failing', 'sales_queue_due',
        'sales_queue_failing', 'oldest_queue_s', 'day_sums_ok_yesterday'];
      const venues = hb.venues || [];
      ok('ok' in hb && 'at' in hb && venues.length >= 3 && venues.every((z) => keys.every((kk) => kk in z)), `stock_drainer_health(): ok, at, and per venue every field of contract 3.3 (${venues.length} venues)`);
      ok(hb.ok === true && venues.every((z) => Number(z.dead) === 0 && Number(z.lines_on_archived) === 0 && Number(z.foreign_pack_lines) === 0 && Number(z.to_order_loops) === 0
         && Number(z.takes_missing_24h) === 0 && Number(z.repair_failing) === 0 && Number(z.sales_queue_failing) === 0 && z.day_sums_ok_yesterday !== false),
        `on the basket database the health is ok (${short(venues.filter((z) => Number(z.dead) || z.day_sums_ok_yesterday === false), 300) || 'every venue clean'})`);
      sql(`insert into stock_day_sums_repair (location_id, business_day, reason, attempts) values ('${PROVO}', '${today}'::date - 50, 'harness', 8)`);
      const hf = callJ('service', `select public.stock_drainer_health('${PROVO}')`).j || {};
      ok(hf.ok === false && Number((hf.venues || [])[0]?.repair_failing) === 1, `a day that failed 8 times shows as repair_failing and the health is not ok (${short(hf.venues?.[0]?.repair_failing)})`);
      sql(`delete from stock_day_sums_repair where reason = 'harness'`);
    });
  }

  // ==================================================================================================
  section(26, '26. Sales day totals: every column against an independent oracle; the day check; the sales rule parity');
  if (AFTER && pasted && after.n_d0) {
    await guarded('sales day totals', async () => {
      c.createFrom('n_sd', 'n_bk2_n_d0');
      c.use('n_sd');
      dsDrainAll();
      const presets = pj(sql(`select coalesce(json_agg(json_build_object('loc', location_id, 'name', name, 'kind', kind)), '[]') from discounts`)) || [];
      for (const v of [PROVO, LOC2, SOLO]) {
        const days = sql(`select coalesce(string_agg(distinct d.business_day::text, ','), '') from closed_checks c cross join lateral public.stock_co__venue_day('${v}', c.closed_at) d
                           where c.location_id = '${v}' and left(c.id, 1) = 'b'`).split(',').filter(Boolean);
        const lines = pj(sql(`with chk as (
            select c.id, vd.business_day as day, coalesce(c.order_type, 'unknown') as ot, coalesce(c.subtotal, 0) as sub,
                   case when c.discounts is null or jsonb_typeof(c.discounts) <> 'array' then 0
                        else (select coalesce(sum(coalesce(nullif(public._rds_num(d -> 'amount'), 0), nullif(public._rds_num(d -> 'value'), 0), 0)), 0) from jsonb_array_elements(c.discounts) d) end as disc,
                   case when c.tax_amount is not null then c.tax_amount else greatest(0, coalesce(c.total, 0) - coalesce(c.subtotal, 0) - coalesce(c.service, 0) - coalesce(c.tip, 0)) end as tax0,
                   case when jsonb_typeof(c.items) = 'array' then c.items else '[]'::jsonb end as items
              from closed_checks c cross join lateral public.stock_co__venue_day(c.location_id::uuid, c.closed_at) vd
             where c.location_id = '${v}' and not (c.voided is true or coalesce(c.status, '') in ('void', 'voided'))),
          ln as (
            select k.id, k.day, k.ot, k.disc, k.tax0, l.n::integer as n, coalesce(public.stock_js_key(l.v -> 'itemId'), public.stock_js_key(l.v -> 'id'), 'unknown') as mid,
                   public.stock_js_qty(l.v -> 'qty') as q, public.stock_js_num(l.v -> 'price') * public.stock_js_qty(l.v -> 'qty') as g
              from chk k cross join lateral jsonb_array_elements(k.items) with ordinality as l(v, n)
             where jsonb_typeof(l.v) = 'object' and not public.stock_js_truthy(l.v -> 'voided')
            union all
            select k.id, k.day, k.ot, k.disc, k.tax0, null, 'unknown', 0, k.sub from chk k
             where k.sub <> 0 and not exists (select 1 from jsonb_array_elements(k.items) as l where jsonb_typeof(l) = 'object' and not public.stock_js_truthy(l -> 'voided')))
          select coalesce(json_agg(json_build_object('id', id, 'day', day, 'ot', ot, 'disc', disc, 'tax0', tax0, 'n', n, 'mid', mid, 'q', q, 'g', g)), '[]') from ln
           where day::text = any (array[${days.map((d) => `'${d}'`).join(',') || "''"}])`)) || [];
        const ids = [...new Set(lines.map((z) => z.id))];
        const rows = mapBy(pj(sql(`select coalesce(json_agg(to_jsonb(c)), '[]') from closed_checks c where c.id = any (array[${ids.map((z) => lit(z)).join(',') || "''"}])`)), 'id');
        const takes = mapBy(pj(sql(`select coalesce(json_agg(json_build_object('id', check_id, 'lines', lines)), '[]') from stock_sale_takes where location_id = '${v}'`)), 'id');
        const vp = presets.filter((p2) => p2.loc === v);
        // the oracle: contract 2.5 sales_day_sums_rebuild v2, line by line
        const groups = {};
        for (const id of ids) {
          const row = rows[id] || {};
          const ls = lines.filter((z) => z.id === id);
          const sumG = ls.reduce((s, z) => s + Number(z.g), 0);
          const share = (z) => (sumG !== 0 ? Number(z.g) / sumG : 1 / ls.length);
          const parts = jsParts(row);
          const tl = mapBy((takes[id]?.lines) || [], 'n');
          const items = Array.isArray(row.items) ? row.items : [];
          const ds = Array.isArray(row.discounts) ? row.discounts.filter((d) => d && typeof d === 'object' && !Array.isArray(d)) : [];
          const kindOf = (z) => {
            if (z.n == null) return null;
            const line = items[z.n - 1] || {};
            const cover = ds.filter((d) => (d.scope === 'items' ? (Array.isArray(d.itemUids) ? d.itemUids : []).includes(line.uid) : true)).map((d) => entryKind(d, vp));
            if (line.discount && typeof line.discount === 'object') cover.push(entryKind(line.discount, vp));
            return cover.includes('staff') ? 'staff' : cover.includes('comp') ? 'comp' : cover.includes('loyalty') ? 'loyalty' : null;
          };
          const hasTenders = Array.isArray(row.tenders) && row.tenders.length > 0;
          const credit = hasTenders ? row.tenders.filter((t) => t && typeof t === 'object' && canonicalMethod(t.method).includes('loyalty')).reduce((s, t) => s + jsNum(t.amount), 0)
            : row.loyalty && row.loyalty.discount_value != null ? jsNum(row.loyalty.discount_value) / 100
              : ds.filter((d) => d.source === 'loyalty').reduce((s, d) => s + (jsNum(d.amount) || jsNum(d.value)), 0);
          const lshare = sumG > 0 ? Math.min(1, credit / sumG) : 0;
          for (const z of ls) {
            const key = `${z.day}|${z.mid}|${z.ot}`;
            const gk = groups[key] || (groups[key] = { qty: 0, gross: 0, net: 0, discount_spread: 0, reward_spread: 0, tax: 0, loyalty_qty: 0, staff_qty: 0, comp_qty: 0, loyalty_cost: 0, staff_cost: 0, comp_cost: 0, theo: null });
            const t = z.n != null ? tl[z.n] : null;
            const cst = t ? Number(t.c) : 0;
            const sh = share(z);
            gk.qty += Number(z.q); gk.gross += Number(z.g); gk.discount_spread += Number(z.disc) * sh; gk.tax += Number(z.tax0) * sh;
            gk.net += (parts.net_minor / 100) * sh; gk.reward_spread += (parts.reward_minor / 100) * sh;
            if (t) gk.theo = (gk.theo || 0) + cst;
            const kd = kindOf(z);
            if (kd) { gk[`${kd}_qty`] += Number(z.q); gk[`${kd}_cost`] += cst; } else if (lshare > 0) { gk.loyalty_qty += Number(z.q) * lshare; gk.loyalty_cost += cst * lshare; }
          }
        }
        const got = mapBy((pj(sql(`select coalesce(json_agg(json_build_object('k', business_day::text || '|' || menu_item_id || '|' || order_type, 'r', to_jsonb(s))), '[]') from sales_day_sums s
                                    where location_id = '${v}' and business_day::text = any (array[${days.map((d) => `'${d}'`).join(',') || "''"}])`)) || []).map((z) => ({ k: z.k, ...z.r })), 'k');
        const COLS = ['qty', 'gross', 'net', 'discount_spread', 'reward_spread', 'tax', 'loyalty_qty', 'staff_qty', 'comp_qty', 'loyalty_cost', 'staff_cost', 'comp_cost'];
        const bad = [];
        for (const [k, w] of Object.entries(groups)) {
          const gr = got[k];
          if (!gr) { bad.push(`${k} missing`); continue; }
          for (const col of COLS) if (!near(gr[col], w[col], 1e-6)) bad.push(`${k} ${col} ${gr[col]} want ${w[col]}`);
          if ((w.theo == null) !== (gr.theo_cost == null) || (w.theo != null && !near(gr.theo_cost, w.theo, 1e-6))) bad.push(`${k} theo_cost ${gr.theo_cost} want ${w.theo}`);
        }
        const extra = Object.keys(got).filter((k) => !groups[k]);
        ok(bad.length === 0 && extra.length === 0 && Object.keys(groups).length > 0,
          `${VNAME[v]}: every sales_day_sums row of the basket days equals the oracle: qty, gross, net, discounts, rewards, tax, theoretical cost, staff, comp and loyalty (${Object.keys(groups).length} rows; ${bad.slice(0, 4).join('; ') || 'all equal'}${extra.length ? `; extra ${extra.join(', ')}` : ''})`);
        const kinds = Object.values(got).reduce((s, gr) => ({ staff: s.staff + Number(gr.staff_qty), comp: s.comp + Number(gr.comp_qty), loyalty: s.loyalty + Number(gr.loyalty_qty) }), { staff: 0, comp: 0, loyalty: 0 });
        if (v === PROVO) ok(kinds.staff >= 5 && kinds.comp >= 2 && kinds.loyalty > 1, `Provo: staff food (check level, item level, matched by label), the comp and the loyalty rewards each reach their own line (${short(kinds)})`);
        for (const d of days) {
          const j = callJ('service', `select public.sales_day_sums_check('${v}', '${d}')`).j || {};
          const wantNet = Math.round(Object.values(rows).filter((r) => {
            const day = lines.find((z) => z.id === r.id)?.day; return day === d;
          }).reduce((s, r) => s + jsParts(r).net_minor, 0)) / 100;
          ok(j.ok === true && j.net_checked === true && near(j.net?.sums, j.net?.rule, 0.001) && near(j.theo?.sums, j.theo?.ledger, 0.001) && near(j.net?.rule, wantNet, 0.011),
            `${VNAME[v]} ${d}: sales_day_sums_check ok (gross, discounts, voids, tax against report_day_sums; net ${j.net?.sums} = the rule ${j.net?.rule} = JS ${wantNet}; theoretical cost ${j.theo?.sums} = the ledger's sale value ${j.theo?.ledger})`);
        }
      }
      // the sales rule parity: every legacy path, the SQL port against the JS
      const bad = [];
      for (const row of PARITY_ROWS) {
        const r = pj(sql(`select json_build_object('row', to_jsonb(r), 'p', (select to_jsonb(p) from public._sales_check_parts(r) p)) from jsonb_populate_record(null::public.closed_checks, ${jlit({ location_id: PROVO, ...row })}) r`));
        const want = jsParts(r.row);
        const p2 = r.p || {};
        if (['gross_minor', 'tax_minor', 'net_minor', 'reward_minor', 'reward_tax_minor'].some((kk) => Number(p2[kk]) !== want[kk]) || p2.charged_nothing !== want.charged_nothing || p2.legacy !== want.legacy) {
          bad.push(`${row.id}: ${short(p2)} want ${short(want)}`);
        }
      }
      ok(bad.length === 0, `_sales_check_parts gives the JS integers on all ${PARITY_ROWS.length} parity rows (every tender and legacy path) (${bad.slice(0, 3).join('; ') || 'all equal'})`);
      const js = pj(sql(`select json_build_object('r', public._sales_js_round(2.5), 'n', public._sales_js_round(-2.5), 'm', public._sales_js_round(1.4999999), 'z', public._sales_js_round(null),
         'a', public._sales_js_num('" 12.5 "'::jsonb), 'b', public._sales_js_num('true'::jsonb), 'c', public._sales_js_num('null'::jsonb), 'd', public._sales_js_num('"1e2"'::jsonb),
         'e', public._sales_js_num('"abc"'::jsonb), 'f', public._sales_js_num('""'::jsonb))`)) || {};
      ok(js.r === 3 && js.n === -2 && js.m === 1 && js.z == null && js.a === 12.5 && js.b === 1 && js.c === 0 && js.d === 100 && js.e == null && js.f === 0,
        `_sales_js_round is Math.round (ties up) and _sales_js_num is Number() (${short(js)})`);
      // the enqueue never fails a close
      const holder = c.psqlAsync({ input: 'begin; lock table public.sales_day_sums_queue in access exclusive mode; select pg_sleep(2); commit;' });
      await new Promise((res) => setTimeout(res, 300));
      const r1 = asCaller('tillProvo', insertRow({ id: 'sq-lock', location_id: PROVO, ref: 'SQLOCK', items: [{ itemId: M.pLatte, qty: 1, price: 3.2 }], subtotal: 3.2, total: 3.2, tax_amount: 0.53, tenders: [{ method: 'cash', amount: 3.2 }] }));
      await holder;
      ok(r1.status === 0 && r1.ms < 1800 && num(`select count(*) from closed_checks where id = 'sq-lock'`) === 1, `a till close while the sales queue is locked: the check is written in ${r1.ms} ms (the enqueue gives up after 500 ms)`);
      sql(`alter table sales_day_sums_queue add constraint harness_refuse check (false) not valid`);
      const r2 = asCaller('tillProvo', insertRow({ id: 'sq-err', location_id: PROVO, ref: 'SQERR', items: [{ itemId: M.pLatte, qty: 1, price: 3.2 }], subtotal: 3.2, total: 3.2, tax_amount: 0.53, tenders: [{ method: 'cash', amount: 3.2 }] }));
      sql(`alter table sales_day_sums_queue drop constraint harness_refuse`);
      ok(r2.status === 0 && num(`select count(*) from closed_checks where id = 'sq-err'`) === 1, `a forced error in the enqueue: the check is still written (${outcome(r2)})`);
      drain();
      ok(['sq-lock', 'sq-err'].every((id) => num(`select count(*) from stock_movements where source_id = '${id}' and movement_type = 'SALE_DEPLETION'`) > 0
         && sql(`select status from stock_outbox where check_id = '${id}' and kind = 'sale'`) === 'done'),
        'and both checks still have their stock taken off by the drainer (events done)');
      const r3 = asCaller('tillProvo', `update closed_checks set refunds = '[]'::jsonb where id = 'sq-err'`);
      ok(r3.status === 0 && num(`select count(*) from sales_day_sums_queue where location_id = '${PROVO}'`) >= 1, 'a later update of a check queues its day');
    });
  }

  // ==================================================================================================
  section(27, `27. Speed with every trigger on, against ${Math.round(TARGET_PER_S * 3600)} checks an hour company wide`);
  const SITES = QUICK ? 10 : 50;
  const N = QUICK ? 600 : 3000;
  const rates = {};
  // busy: sales injected all through the drain (and, with the release, day total rebuilds and drains
  // beside it, which hold the venue lock the triggers wait on). The rate counts every check done during
  // the timed drain call, injected ones included.
  const speed = async (label, db, v2, busy) => {
    c.createFrom(`n_speed_${label}`, db);
    c.use(`n_speed_${label}`);
    c.psql({ input: speedSql(SITES) });
    if (v2) sql(`insert into venue_clock (location_id, timezone, day_start, synced_at) select id, 'Europe/London', '06:00', now() from locations where org_id = '${SPEED_ORG}'`);
    if (v2) dsDrainAll();
    for (let k = 0; k < N; k += 50) sql(speedChecksSql(k + 1, Math.min(50, N - k), SITES));
    ok(num(`select count(*) from stock_outbox where left(check_id, 4) = 'spd-' and status = 'pending'`) === N, `${label}: ${N} checks over ${SITES} sites queued for the drainer`);
    let stop = false; const side = []; let injected = 0;
    const inject = busy ? (async () => {
      let g = 100000;
      while (!stop) { await c.psqlAsync({ input: `${speedChecksSql(g, 10, SITES)};` }); g += 10; injected += 10; await new Promise((res) => setTimeout(res, 150)); }
    })() : Promise.resolve();
    const rebuilds = v2 && busy ? (async () => {
      let n = 1;
      while (!stop) {
        const loc = speedLoc((n % SITES) + 1);
        side.push(await c.psqlAsync({ input: `select public.stock_day_sums_rebuild('${loc}', current_date - 1, current_date); select public.sales_day_sums_rebuild('${loc}', current_date - 1, current_date);` }));
        side.push(await c.psqlAsync({ input: 'call public.stock_day_sums_drain(2, 20);' }));
        n++;
      }
    })() : Promise.resolve();
    const tStart = Date.now();
    const d = await c.psqlAsync({ input: 'call public.stock_outbox_drain(600, 200, 0.05, true);' });
    const secs = (Date.now() - tStart) / 1000;
    const doneTimed = num(`select count(*) from stock_outbox where left(check_id, 4) = 'spd-' and status = 'done'`);
    stop = true;
    await inject; await rebuilds;
    drain(); drain();
    const doneN = num(`select count(*) from stock_outbox where left(check_id, 4) = 'spd-' and status = 'done'`);
    const st = pj(sql(`select json_object_agg(status, n) from (select status, count(*) n from stock_outbox where left(check_id, 4) = 'spd-' group by status) z`)) || {};
    const rate = doneTimed / secs;
    rates[label] = rate;
    console.log(`     ${label}: ${doneTimed} checks drained in ${secs.toFixed(1)} s = ${rate.toFixed(1)} checks a second (${Math.round(rate * 3600)} an hour)${busy ? `; ${injected} injected during the run${v2 ? `, ${side.length} rebuilds and drains beside it` : ''}` : ''}`);
    ok(d.code === 0 && doneN === N + injected && !st.dead && !st.held && !st.pending, `${label}: every check done, 0 dead, 0 held (${short(st)})`);
    ok(rate >= TARGET_PER_S, `${label}: ${rate.toFixed(1)} checks a second, above the company target of ${TARGET_PER_S.toFixed(2)} (15,000 an hour)`);
    if (busy) ok(side.every((z) => z.code === 0), `${label}: every rebuild and drain beside the sales ended cleanly (${side.filter((z) => z.code).map((z) => z.sqlstate).join(', ') || 'all'})`);
    if (v2) {
      const repairs = num(`select count(*) from stock_day_sums_repair where location_id in (select id from locations where org_id = '${SPEED_ORG}')`);
      if (!busy) ok(repairs === 0, `${label}: no day total needed the repair queue (${repairs})`);
      dsDrainAll();
      const sites = sql(`select string_agg(id::text, ',') from locations where org_id = '${SPEED_ORG}'`).split(',');
      const bad = sites.filter((loc) => dayGap(loc, allDays(loc)).bad !== 0);
      ok(bad.length === 0, `${label}: stock_day_sums equals the ledger at all ${sites.length} sites after the run${busy ? ` (${repairs} venue days went through the repair queue)` : ''} (${bad.length} differ)`);
      const takes = num(`select count(*) from stock_sale_takes where left(check_id, 4) = 'spd-'`);
      ok(takes === N + injected, `${label}: one takes row per check (${takes})`);
    }
    const oh = num(`select count(*) from inventory_items i where i.org_id = '${SPEED_ORG}' and i.on_hand <> coalesce((select sum(m.qty_base) from stock_movements m where m.inventory_item_id = i.id), 0)`);
    ok(oh === 0, `${label}: on hand equals the ledger at every speed site`);
  };
  await guarded('speed v1', () => speed('v1', 'n_d0', false, false));
  await guarded('speed v1 busy', () => speed('v1_busy', 'n_d0', false, true));
  if (AFTER && pasted) {
    await guarded('speed v2', () => speed('v2', 'n_dr_n_d0', true, false));
    await guarded('speed v2 busy', () => speed('v2_busy', 'n_dr_n_d0', true, true));
    if (rates.v1 && rates.v2) console.log(`     with every trigger on the drain runs at ${(100 * rates.v2 / rates.v1).toFixed(0)}% of today's rate (${rates.v1.toFixed(1)} to ${rates.v2.toFixed(1)} checks a second); under load ${(rates.v1_busy || 0).toFixed(1)} to ${(rates.v2_busy || 0).toFixed(1)}`);
    await guarded('health at scale', () => {
      c.use('n_speed_v2_busy');
      const h = callJ('service', 'select public.stock_drainer_health()');
      const vs = h.j?.venues || [];
      ok(h.status === 0 && h.ms < 8000 && vs.length === SITES + 3, `stock_drainer_health() over ${vs.length} venues (${SITES} speed sites and the 3 stock venues) answers in ${h.ms} ms, under the 8 s limit (${h.status ? outcome(h) : 'ok'})`);
      ok(vs.filter((z) => z.location_id.startsWith('e5000000')).every((z) => Number(z.dead) === 0 && Number(z.takes_missing_24h) === 0 && Number(z.done_24h) > 0),
        `and every speed site shows its sales done, 0 dead, no takes missing (${short(vs.filter((z) => z.location_id.startsWith('e5000000')).slice(0, 1), 300)})`);
      const day = sql(`select d.business_day::text from public.stock_co__venue_day('${speedLoc(1)}', now()) d`);
      const r = callJ('service', `select public.sales_day_sums_check('${speedLoc(1)}', '${day}')`);
      ok(r.status === 0 && r.ms < 8000 && r.j?.ok === true && Number(r.j?.gross?.sums) > 0 && Number(r.j?.theo?.sums) > 0,
        `sales_day_sums_check on a busy speed site (${day}): ok in ${r.ms} ms, with sales and theoretical cost on it (${short(r.j, 300)})`);
    });
  }

  // ==================================================================================================
  section(28, '28. Who may do what: option tables, second step, takes and every new function closed, discounts.kind');
  if (AFTER && pasted) {
    await guarded('roles', () => {
      c.createFrom('n_roles', 'n_dr_n_d0');
      c.use('n_roles');
      sql(optionRulesSql({ toastie: false }));
      sql(`insert into stock_co_option_rules (id, org_id, recipe_id, kind, option_name, removes_item_id) values ('68000000-0000-4000-8000-000000000b01', '${ORG_S}',
             (select company_ref from recipes where id = '${R.sWater}'), 'remove', 'No ice', (select company_ref from inventory_items where id = '${I.sWater}'));
           insert into stock_co_option_rule_sites (rule_id, org_id, location_id, site_modifier_id) values ('68000000-0000-4000-8000-000000000b01', '${ORG_S}', '${SOLO}', 'mod-noice');`);
      const count = (who, t) => { const r = asCaller(who, `select count(*) from public.${t}`); return r.status === 0 ? Number(r.out) : r.sqlstate; };
      ok(count('ownerT', 'stock_co_option_rules') === 4 && count('ownerT', 'stock_co_option_rule_sites') === 4, `the owner of the test company reads its 4 rules and their 4 site rows (${count('ownerT', 'stock_co_option_rules')}, ${count('ownerT', 'stock_co_option_rule_sites')})`);
      ok(count('mgrProvo', 'stock_co_option_rules') === 4 && count('mgrProvo', 'stock_co_option_rule_sites') === 3, `a Provo manager reads the company's rules and Provo's 3 site rows only (${count('mgrProvo', 'stock_co_option_rule_sites')})`);
      ok(count('mgrLoc2', 'stock_co_option_rule_sites') === 1 && count('soloMgr', 'stock_co_option_rules') === 1 && count('ownerX', 'stock_co_option_rules') === 4,
        'Location 2 sees its one site row; the one site company sees only its own rule; another company\'s owner linked at Provo reads the rules of the company it reaches');
      ok(count('noStep', 'stock_co_option_rules') === 0 && count('noStep', 'stock_co_option_rule_sites') === 0, 'a login without the second step reads nothing (the fence)');
      ok(count('anonKey', 'stock_co_option_rules') === '42501' && count('anonKey', 'stock_sale_takes') === '42501', 'the bare anon key reads neither (no grant)');
      for (const who of ['ownerT', 'mgrProvo', 'tillProvo']) {
        ok(count(who, 'stock_sale_takes') === '42501', `${CALLERS[who].what}: stock_sale_takes is closed (42501)`);
        const w = asCaller(who, `insert into stock_co_option_rules (org_id, recipe_id, kind, option_name, removes_item_id) values ('${ORG_T}', (select company_ref from recipes where id = '${R.pLatte}'), 'remove', 'x', (select company_ref from inventory_items where id = '${I.pMilk}'))`);
        ok(w.sqlstate === '42501', `${CALLERS[who].what}: cannot write an option rule (${outcome(w)})`);
      }
      ok(typeof count('service', 'stock_sale_takes') === 'number', 'the service role reads stock_sale_takes');
      for (const [sig, call] of [['stock_drainer_health(uuid)', 'select public.stock_drainer_health()'], ['_sales_check_parts', `select * from public._sales_check_parts(null::public.closed_checks)`],
        ['stock_explode_lines', `select * from public.stock_explode_lines('${PROVO}', '[]'::jsonb, 'dine-in')`], ['_stock_takes_share', `select * from public._stock_takes_share('[]'::jsonb, '[]'::jsonb)`],
        ['stock_day_sums_drain', 'call public.stock_day_sums_drain(1, 1)'], ['sales_day_sums_rebuild', `select public.sales_day_sums_rebuild('${PROVO}', current_date, current_date)`]]) {
        for (const who of ['ownerT', 'tillProvo', 'anonKey']) {
          const r = asCaller(who, call);
          ok(r.sqlstate === '42501', `${CALLERS[who].what} may not run ${sig} (${outcome(r)})`);
        }
      }
      const svc = callJ('service', `select public.sales_day_sums_rebuild('${PROVO}', current_date - 1, current_date)`);
      ok(svc.status === 0 && svc.ms < 8000 && svc.j?.ok === true, `the service role rebuilds the sales day totals in ${svc.ms} ms (under 8 s)`);
      ok(asCaller('service', `select * from public.stock_explode_lines('${PROVO}', '[]'::jsonb, 'dine-in')`).sqlstate === '42501', 'and the service role may not run the internals (owner only)');
      // discounts.kind from the Back Office
      let r = asCaller('ownerT', `update discounts set kind = 'staff' where id = '${DISC.pStaff}' returning kind`);
      ok(r.status === 0 && r.out === 'staff', `a Back Office login sets a discount's kind under the live discounts rules (${outcome(r)})`);
      r = asCaller('mgrProvo', `update discounts set kind = null where id = '${DISC.pHappy}' returning id`);
      ok(r.status === 0, 'and a manager clears it on an ordinary discount');
      r = asCaller('ownerT', `update discounts set kind = 'free' where id = '${DISC.pStaff}'`);
      ok(r.sqlstate === '23514', `a kind that is not staff, comp or loyalty is refused (${outcome(r)})`);
      r = asCaller('noStep', `update discounts set kind = 'comp' where id = '${DISC.pStaff}' returning id`);
      ok(r.status === 0 && r.out === '' && sql(`select kind from discounts where id = '${DISC.pStaff}'`) === 'staff', 'a login without the second step changes nothing (the live fence)');
      r = asCaller('anonKey', `update discounts set kind = 'comp' where id = '${DISC.pStaff}' returning id`);
      ok(r.out === '' && sql(`select kind from discounts where id = '${DISC.pStaff}'`) === 'staff', `the bare anon key changes nothing (${outcome(r)})`);
      r = asCaller('anonKey', `select pg_sleep(4)`);
      ok(r.sqlstate === '57014', 'the anon key\'s 3 s limit holds');
    });
  }

  // ==================================================================================================
  section(29, '29. The rollbacks: 0a\'s refused while the release is in; the release\'s restores everything; then it applies again');
  if (AFTER && pasted) {
    await guarded('rollback', () => {
      c.createFrom('n_rb', 'n_dr_n_d0');
      c.use('n_rb');
      const fns = FNS();
      let r = c.paste(FILES.aRb);
      ok(r.status !== 0 && /The drainer release \(20261023a\) is still in\. Run 20261023a_OPS_stock_drainer_v2_ROLLBACK\.sql first\. Nothing was changed\./.test(r.stderr)
         && JSON.stringify(FNS()) === JSON.stringify(fns) && tableExists('stock_sale_takes') && tableExists('stock_co_items'),
        `the 0a rollback is refused while the release is in, nothing changed (${short(r.error, 200)})`);
      ok(existsSync(FILES.dRb), `the drainer rollback file is there (${FILES.dRb})`);
      if (!existsSync(FILES.dRb)) return;
      r = c.paste(FILES.dRb);
      ok(r.status === 0, `the drainer rollback applies (${r.status ? short(r.stderr, 500) : `${r.ms} ms`})`);
      const row = ((r.sets[r.sets.length - 1] || { rows: [] }).rows[0]) || {};
      console.log(`     ${short(row, 400)}`);
      ok(Number(row.bodies_restored) === 7 && Number(row.triggers_left) === 0 && Number(row.functions_left) === 0 && Number(row.tables_left) === 0 && !tf(row.drain_job) && tf(row.discounts_kind_kept),
        'its check row: bodies restored 7, triggers 0, functions 0, tables 0, no drain job, discounts.kind kept');
      ok(REPLACED.every(([sig, md5]) => md5Of(sig) === md5), 'the seven bodies are the live ones again (md5)');
      ok(REPLACED.every(([sig, , sp, acl]) => pathOf(sig) === sp && aclOf(sig) === acl), 'with their live search_path and grants');
      c.use('n_d0');
      const base = FNS();
      c.use('n_rb');
      const now = FNS();
      const diff = [...new Set([...Object.keys(base), ...Object.keys(now)])].filter((k) => base[k] !== now[k]);
      ok(diff.length === 0, `every function is exactly the base database's again (${diff.join(', ') || 'none differ'})`);
      ok(sql(`select pg_get_constraintdef(oid) from pg_constraint where conname = 'stock_day_sums_pkey'`) === 'PRIMARY KEY (location_id, business_day, inventory_item_id, movement_type, source_type)'
         && num(`select count(*) from information_schema.columns where table_schema = 'public' and ((table_name = 'stock_day_sums' and column_name = 'demo')
               or (table_name in ('stock_day_sums_repair', 'sales_day_sums_queue') and column_name in ('attempts', 'due_at', 'last_error')))`) === 0
         && isNull(sql(`select to_regclass('public.stock_day_sums_repair_due')`)) && isNull(sql(`select to_regclass('public.sales_day_sums_queue_due')`)),
        'stock_day_sums has its old key, no demo column; the queues have no attempts, due_at, last_error or due index');
      ok(!tableExists('stock_sale_takes') && !tableExists('stock_co_option_rules') && !tableExists('stock_co_option_rule_sites') && num(`select count(*) from cron.job where jobname = 'stock-day-sums-drain'`) === 0
         && num(`select count(*) from pg_trigger where tgname in ('stock_movements_day_sums_ins', 'stock_movements_day_sums_upd', 'stock_movements_day_sums_del', 'closed_checks_sales_day_ins',
               'closed_checks_sales_day_upd', 'venue_clock_requeue_ins', 'venue_clock_requeue_upd', 'stock_co_option_org_guard')`) === 0,
        'the three tables, the nine triggers and the drain job are gone');
      ok(num(`select count(*) from stock_native_backup where left(name, 11) = 'drainer_v2:'`) === 0 && num(`select count(*) from stock_native_backup`) === 7, 'its backup rows are gone; 0a\'s seven stay');
      ok(num(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'discounts' and column_name = 'kind'`) === 1
         && num(`select count(*) from pg_constraint where conname = 'discounts_kind_known'`) === 1, 'discounts.kind and its CHECK are kept (Peter\'s settings)');
      ok(!/like\s+'[%_]*(stock_co|drainer)/i.test(readFileSync(FILES.dRb, 'utf8').replace(/--[^\n]*/g, '')), 'the rollback drops by exact name (no LIKE)');
      c.createFrom('n_rb_bk', 'n_rb');
      c.use('n_rb_bk');
      const { out, problems } = runBasket(t0);
      ok(problems.length === 0, `after the rollback every channel writes its checks (${problems.slice(0, 3).join('; ') || 'all written'})`);
      if (before.n_d0) basketCompare('after the rollback against v1', before.n_d0, out);
      c.use('n_rb');
      r = c.paste(FILES.d);
      ok(r.status === 0, `the release applies again after its rollback (${r.status ? short(r.stderr, 400) : `${r.ms} ms`})`);
      if (r.status === 0) {
        const last = (r.sets[r.sets.length - 1] || { rows: [] }).rows;
        ok(last.length === 3 && last.every((w) => Number(w.explode_differences) === 0 && Number(w.bodies_replaced) === 7 && Number(w.bodies_backed_up) === 7),
          `and its check row is clean again (${short(last.map((w) => `${w.venue} ${w.bodies_replaced}/${w.bodies_backed_up}`))})`);
      }
    });
  }
}
