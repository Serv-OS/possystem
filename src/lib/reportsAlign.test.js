/**
 * reportsAlign.test.js: the cross report parity test (v5.11.99, Reports align, 22 Oct 2026).
 * Run: `npm test`, or `node --test src/lib/reportsAlign.test.js`.
 *
 * Peter, 22 Oct 2026: "make sure this does filter into the other reports correctly ... all reports align
 * correctly". One seeded set of checks, refunds (on the day and days later, failed ones, demo ones), voided
 * checks, labour (approved, paid, pending, an early opener, an overnight closer), stock movements and waste
 * (refunded food, a dish row with a cost and no ledger, demo history) goes through EVERY report's own JS
 * rule, and per venue business day they must give the same figure:
 *   net sales  Daily trading (trading-report: leaveOutDemo then tradingDays), the Business summary and All
 *              sites overview (salesBreakdown), Daily trend (tradingDays over its rows), the Owner app
 *              (buildOwnerSnapshot itself, through a PostgREST stand in), the Manager app (its money loop),
 *              and the JS twin of the Stock and GP SQL (stock/alignTwin.js)
 *   labour     Daily trading (timesheetDays), the Owner app, the Manager app, the Stock and GP twin
 *   waste      Daily trading (ledgerDays), the Wastage log (wasteFromLedger), the Stock and GP twin
 *   cost       the twin's theoretical cost = Daily trading's COGS less a voided check's stock rows
 *   GP         after never above before
 * Then the same on random data (property tests), and: the demo rule changes nothing at a venue with no demo
 * rows (the same array back, the same figures).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tradingDays, timesheetDays, ledgerDays, timesheetDayMs } from '../../supabase/functions/_shared/tradingSales.js';
import { leaveOutDemo, isDemoCheck, isDemoStockKey, DEMO_NOTE, withoutDemoRows } from '../../supabase/functions/_shared/demoHistory.js';
import { businessDayOf, businessDayWindow } from '../../supabase/functions/_shared/businessDay.js';
import { emptySales, addCheckSales, addRefundSales, refundMadeAt } from '../../supabase/functions/_shared/snapshotSales.js';
import { buildOwnerSnapshot } from '../../supabase/functions/_shared/ownerSnapshot.js';
import { toAccountingRow } from '../../supabase/functions/_shared/saleVat.js';
import { salesBreakdown } from './salesBreakdown.js';
import { computeSalesStats } from './salesStats.js';
import { summariseShift, buildShiftReportDoc } from './shiftReport.js';
import { checkSalesParts } from '../../supabase/functions/_shared/tradingSales.js';
import { buildGroupedDay, makeGroupResolver } from '../../supabase/functions/_shared/accountingGroups.js';
import { planXeroInvoiceDay } from '../../supabase/functions/_shared/xeroInvoicePlan.js';
import { UK_TAX, CATEGORIES, mapping as xeroMapping, DETAIL as XERO_DETAIL, SITE as XERO_SITE, breakdown as xeroBreakdown } from './accounting/xeroInvoiceFixtures.js';
import { wasteFromLedger } from './stock/wasteLedger.js';
import { stockGpDays } from './stock/alignTwin.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');
const TZ = 'Europe/London', START = '06:30';
const dayOf = (ms) => businessDayOf(ms, TZ, START);
const r2 = (x) => Math.round(x * 100) / 100;
const near = (a, b, msg) => assert.ok(Math.abs((a || 0) - (b || 0)) < 0.0051, `${msg}: ${a} against ${b}`);

// a small seeded random
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// ── the seeded world ─────────────────────────────────────────────────────────
// Days 12 to 17 Oct 2026 at a 06:30 UK venue (before the clocks change). Prices include VAT at 20%.
export function world(seed = 1, { days = 6, demo = true } = {}) {
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const DAYS = Array.from({ length: days }, (_, k) => `2026-10-${String(12 + k).padStart(2, '0')}`);
  const checks = [], movements = [], waste = [], timesheets = [];
  let n = 0;
  const at = (d, h, m = 0) => new Date(businessDayWindow(d, TZ, START).fromMs + ((h - 6.5) * 60 + m) * 60000).toISOString();
  for (const d of DAYS) {
    const count = 4 + Math.floor(rand() * 8);
    for (let k = 0; k < count; k++) {
      n += 1;
      const id = `chk-${seed}-${n}`;
      const lines = Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, j) => ({ uid: `u${j}`, itemId: `m${j}`, qty: 1 + Math.floor(rand() * 2), price: pick([2.5, 3.2, 4.6, 5.95, 8]) }));
      const goods = r2(lines.reduce((s, l) => s + l.price * l.qty, 0));
      const tip = rand() < 0.2 ? 0.5 : 0;
      const service = rand() < 0.1 ? r2(goods * 0.1) : 0;
      const kind = pick(['card', 'card', 'cash', 'split', 'loyalty', 'gift']);
      const comp = rand() < 0.08;
      // 29 Oct 2026 (Drop C): now and then a gift card is sold on the check too (money in, not sales),
      // paid with the rest of the bill; never on a comp (a comp takes no money).
      const giftSold = !comp && rand() < 0.15 ? pick([10, 20, 25]) : 0;
      const money = r2(goods + service + giftSold);
      const tenders = kind === 'split' ? [{ method: 'card', amount: r2(money / 2), tip }, { method: 'cash', amount: r2(money - r2(money / 2)), tip: 0 }]
        : kind === 'loyalty' ? [{ method: 'loyalty', amount: lines[0].price, tip: 0 }, { method: 'card', amount: r2(money - lines[0].price), tip }]
        : kind === 'gift' ? [{ method: 'gift_card', amount: 2, tip: 0 }, { method: 'card', amount: r2(money - 2), tip }]
        : [{ method: kind, amount: money, tip }];
      const hour = pick([8, 9, 12, 13, 17, 22, 24.7]);   // 24.7: 00:42 the next morning, still this business day
      const closed = at(d, Math.floor(hour), Math.round((hour % 1) * 60));
      const items = giftSold ? [...lines, { uid: 'ug', itemId: 'gift_card', kind: 'gift_card_sale', name: 'Gift card', price: giftSold, qty: 1, taxExempt: true, noDiscount: true }] : lines;
      const row = { id, location_id: 'L', ref: `R${n}`, closed_at: closed, subtotal: r2(goods + giftSold), total: r2(money + tip), tax_amount: r2((comp ? 0 : goods) / 6),
        service: comp ? 0 : service, tip: comp ? 0 : tip, status: 'paid', voided: false, discounts: comp ? [{ amount: goods, kind: 'comp' }] : [],
        tenders: comp ? [] : tenders, method: kind, payment_method: kind, source: 'pos', processor: null, gift_card: null, loyalty: null, promo: null,
        payment_intents: null, items, refunds: [], order_type: 'dine-in' };
      if (rand() < 0.05) { row.voided = true; row.status = 'voided'; }
      checks.push(row);
      // the sale's stock, taken off when the check closed (the drainer's sale rows)
      const cost = r2(goods * 0.3);
      movements.push({ id: `mv-${id}`, value_delta: -cost, occurred_at: closed, movement_type: 'SALE_DEPLETION', source_type: 'closed_check', source_id: id, idempotency_key: `sale:${id}:i1`, inventory_item_id: 'i1' });
      // a refund now and then: the same day or up to three days later, sometimes refused by the card processor
      if (!row.voided && !comp && rand() < 0.25) {
        const l = lines[0];
        const later = Math.floor(rand() * 4);
        const ts = Date.parse(closed) + later * 86400000 + 3600000;
        const failed = rand() < 0.15;
        const entry = { id: `rf-${id}`, timestamp: ts, items: [{ uid: l.uid, itemId: l.itemId, qty: l.qty, refundQty: 1, price: l.price }], isFullRefund: false,
          amount: l.price, taxAmount: r2(l.price / 6), tipAmount: 0, serviceAmount: 0, tenderMethod: tenders[tenders.length - 1].method === 'cash' ? 'cash' : 'card',
          cardStatus: failed ? 'failed' : 'accepted', legs: [] };
        row.refunds.push(entry);
        if (!failed) {
          const back = r2(cost * l.price / goods);
          const when = new Date(ts).toISOString();
          movements.push({ id: `un-${id}`, value_delta: back, occurred_at: when, movement_type: 'SALE_DEPLETION', source_type: 'closed_check_refund', source_id: id, idempotency_key: `unsale:${id}:${entry.id}:i1`, inventory_item_id: 'i1' });
          movements.push({ id: `wr-${id}`, value_delta: -back, occurred_at: when, movement_type: 'WASTE', source_type: 'closed_check_refund', source_id: id, idempotency_key: `waste:${id}:${entry.id}:i1`, inventory_item_id: 'i1' });
          waste.push({ id: `we-${id}`, inventoryItemId: 'i1', occurredAt: when, source: 'refund', costValue: back, reason: 'Refunded' });
        }
      }
    }
    // waste from Back Office, with its ledger row
    const wid = `w-${d}`;
    const wv = r2(1 + rand() * 4);
    movements.push({ id: `mv-${wid}`, value_delta: -wv, occurred_at: at(d, 15), movement_type: 'WASTE', source_type: 'waste', source_id: wid, idempotency_key: `waste:${wid}`, inventory_item_id: 'i2' });
    waste.push({ id: wid, inventoryItemId: 'i2', occurredAt: at(d, 15), source: 'backoffice', costValue: wv, reason: 'Dropped' });
    // a dish row with a cost and nothing off stock (written past the ledger): never counted
    if (d === DAYS[1]) waste.push({ id: `ghost-${d}`, inventoryItemId: null, occurredAt: at(d, 12), source: 'pos', costValue: 3.42, reason: 'Over-production' });
    // labour: approved, a paid opener before the 06:30 day start, an overnight closer, a pending shift, a draft
    timesheets.push({ id: `t1-${d}`, clock_in: at(d, 8), clock_out: at(d, 16), pay_amount: r2(80 + rand() * 20), status: 'approved' });
    timesheets.push({ id: `t2-${d}`, clock_in: at(d, 6), clock_out: at(d, 14), pay_amount: 72, status: 'paid' });
    timesheets.push({ id: `t3-${d}`, clock_in: at(d, 21), clock_out: at(d, 27), pay_amount: 66, status: 'approved' });
    timesheets.push({ id: `t4-${d}`, clock_in: at(d, 10), clock_out: at(d, 14), pay_amount: 40, status: 'pending' });
    timesheets.push({ id: `t5-${d}`, clock_in: at(d, 11), clock_out: null, pay_amount: null, status: 'draft' });
    if (demo) {
      // demo history: a demo check with a refund, its stock and waste under demo keys
      const did = `demo-s-${seed}-${d}`;
      checks.push({ id: did, location_id: 'L', ref: `D${d}`, closed_at: at(d, 12), subtotal: 30, total: 30, tax_amount: 5, service: 0, tip: 0, status: 'paid', voided: false,
        discounts: [], tenders: [{ method: 'card', amount: 30, tip: 0 }], method: 'card', payment_method: 'card', source: 'pos', items: [{ itemId: 'm0', qty: 3, price: 10 }],
        refunds: [{ id: `dr-${d}`, timestamp: Date.parse(at(d, 14)), amount: 10, taxAmount: 1.67, tipAmount: 0, serviceAmount: 0, tenderMethod: 'card', cardStatus: 'accepted', items: [], isFullRefund: false }],
        order_type: 'dine-in' });
      movements.push({ id: `dm-${d}`, value_delta: -9, occurred_at: at(d, 12), movement_type: 'SALE_DEPLETION', source_type: 'closed_check', source_id: did, idempotency_key: `demo-v1:sale:${did}`, inventory_item_id: 'i1' });
      movements.push({ id: `dw-${d}`, value_delta: -2, occurred_at: at(d, 16), movement_type: 'WASTE', source_type: 'waste', source_id: `dwe-${d}`, idempotency_key: `demo-v1:w:${d}`, inventory_item_id: 'i2' });
      waste.push({ id: `dwe-${d}`, inventoryItemId: 'i2', occurredAt: at(d, 16), source: 'backoffice', costValue: 2, reason: 'Spoilage' });
    }
  }
  return { DAYS, checks, movements, waste, timesheets };
}

// ── every report's own rule ──────────────────────────────────────────────────

// Daily trading (trading-report): demo checks left out, then the one rule; the ledger; the timesheets.
function pnl(w) {
  const rows = leaveOutDemo(w.checks).rows;
  return { sales: tradingDays({ saleRows: rows, refundRows: rows, dayOf }), labour: timesheetDays({ timesheets: w.timesheets, dayOf }), ledger: ledgerDays({ movements: w.movements, dayOf }) };
}
// the Business summary and All sites overview (BOReports leaves demo out first): salesBreakdown over the
// day's checks, with the older checks for the refunds made that day
function businessSummaryAll(w, d) {
  const rows = leaveOutDemo(w.checks).rows;
  const win = businessDayWindow(d, TZ, START);
  const inDay = rows.filter((c) => { const t = Date.parse(c.closed_at); return t >= win.fromMs && t < win.toMs; });
  const older = rows.filter((c) => Date.parse(c.closed_at) < win.fromMs);
  return salesBreakdown(inDay, { range: { fromMs: win.fromMs, toMs: win.toMs - 1 }, refundRows: older, currency: 'GBP' });
}
function businessSummary(w, d) { return businessSummaryAll(w, d).net; }
// Daily trend: the same rule over the rows as the report has them (camelCase through toAccountingRow)
function dailyTrend(w) {
  const rows = leaveOutDemo(w.checks).rows.map(toAccountingRow);
  return tradingDays({ saleRows: rows, refundRows: rows, dayOf });
}
// the Manager app's money loop (manager-snapshot), for one business day
function managerMoney(w, bizDay) {
  const live = leaveOutDemo(w.checks).rows;
  const sales = emptySales();
  for (const c of live) { const t = Date.parse(c.closed_at); if (Number.isFinite(t) && dayOf(t) === bizDay) addCheckSales(sales, c); }
  for (const c of live) for (const e of (Array.isArray(c.refunds) ? c.refunds : [])) { const at = refundMadeAt(e, c); if (at != null && dayOf(at) === bizDay) addRefundSales(sales, e, c); }
  let labour = 0;
  for (const t of w.timesheets) {
    if (!['approved', 'paid'].includes(String(t.status))) continue;
    const at = timesheetDayMs(t);
    if (at == null || dayOf(at) !== bizDay) continue;
    labour += Number(t.pay_amount) || 0;
  }
  return { net: sales.net, labour, gift: sales.gift_sold };
}
// the Owner app itself (buildOwnerSnapshot), through a stand in that answers like PostgREST
function fakeOps(tables) {
  const cmp = (a, b) => { const t = typeof a === 'string' && a.includes('T') && typeof b === 'string' && b.includes('T'); const [x, y] = t ? [Date.parse(a), Date.parse(b)] : [a, b]; return x < y ? -1 : x > y ? 1 : 0; };
  const run = async (q) => {
    if (!(q.table in tables)) return { data: null, error: { message: `relation "${q.table}" does not exist` } };
    let rows = tables[q.table].filter((row) => q.tests.every((t) => t(row)));
    rows = [...rows].sort((a, b) => { for (const c of q.orders) { const d = cmp(a[c], b[c]); if (d) return d; } return 0; });
    const [from, to] = q.range ?? [0, Infinity];
    rows = rows.slice(from, to + 1).slice(0, 1000);
    const cols = q.select.split(',').map((c) => c.trim());
    return { data: rows.map((row) => (q.select === '*' ? row : Object.fromEntries(cols.map((c) => [c, row[c]])))), error: null };
  };
  const from = (table) => {
    const q = { table, select: '*', tests: [], orders: [], range: null };
    const where = (t) => { q.tests.push(t); return b; };
    const b = {
      select: (cols) => { q.select = cols; return b; },
      eq: (c, v) => where((r) => r[c] === v), in: (c, vs) => where((r) => vs.includes(r[c])),
      gte: (c, v) => where((r) => cmp(r[c], v) >= 0), lte: (c, v) => where((r) => cmp(r[c], v) <= 0), lt: (c, v) => where((r) => cmp(r[c], v) < 0),
      not: (c, op, v) => where((r) => r[c] !== v), neq: (c, v) => where((r) => r[c] != null && JSON.stringify(r[c]) !== v),
      contains: (c, v) => where((r) => Array.isArray(r[c]) && v.every((o) => r[c].some((x) => x && typeof x === 'object' && Object.entries(o).every(([k, val]) => x[k] === val)))),
      limit: () => b, order: (c) => { q.orders.push(c); return b; }, range: (a, z) => { q.range = [a, z]; return b; },
      then: (ok, bad) => run(q).then(ok, bad),
    };
    return b;
  };
  return { from, rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'not here' } }) };
}
async function ownerToday(w, d) {
  const tables = { closed_checks: w.checks, wf_sales_forecast: [], wf_timesheets: w.timesheets.map((t) => ({ ...t, location_id: 'L' })), order_queue: [], active_sessions: [],
    menu_categories: [], wf_venue_settings: [], xero_config: [], locations: [], inventory_items: [] };
  const now = new Date(businessDayWindow(d, TZ, START).fromMs + 23 * 3600000);   // 05:30 the next morning: still that business day
  const snap = await buildOwnerSnapshot({ ops: fakeOps(tables), opsIds: ['L'], meta: { L: { name: 'Leeds', tz: TZ, currency: 'GBP', dayStart: START } }, now, period: 'today' });
  return snap.locations[0];
}

// ── the parity ───────────────────────────────────────────────────────────────

async function parity(w, label, { owner = true } = {}) {
  const p = pnl(w);
  const trend = dailyTrend(w);
  const twin = stockGpDays({ checks: w.checks, movements: w.movements, timesheets: w.timesheets, dayOf, isComp: (c) => (c.discounts || []).some((x) => x.kind === 'comp') });
  const voided = new Set(w.checks.filter((c) => c.voided).map((c) => c.id));
  const kept = ledgerDays({ movements: w.movements.filter((m) => voided.has(m.source_id)), dayOf }).cogs;
  for (const d of w.DAYS) {
    const net = p.sales[d]?.net ?? 0;
    const gift = p.sales[d]?.gift_sold ?? 0;
    const bs = businessSummaryAll(w, d);
    near(bs.net, net, `${label} ${d}: Business summary and All sites overview net`);
    // 29 Oct 2026 (Drop C): gift cards sold agree everywhere too, and sit outside net and inside the money.
    near(bs.giftSold, gift, `${label} ${d}: Business summary gift cards sold`);
    near(bs.collected, bs.sales + bs.service + bs.tips + bs.giftSold, `${label} ${d}: Money collected = sales + service + tips + gift cards sold`);
    near(trend[d]?.net ?? 0, net, `${label} ${d}: Daily trend net`);
    near(trend[d]?.gift_sold ?? 0, gift, `${label} ${d}: Daily trend gift cards sold`);
    const m = managerMoney(w, d);
    near(m.net, net, `${label} ${d}: Manager app net`);
    near(m.gift, gift, `${label} ${d}: Manager app gift cards sold`);
    near(m.labour, p.labour[d] ?? 0, `${label} ${d}: Manager app labour`);
    near(twin[d]?.net ?? 0, net, `${label} ${d}: Stock and GP net (the SQL's twin)`);
    near(twin[d]?.labour ?? 0, p.labour[d] ?? 0, `${label} ${d}: Stock and GP labour`);
    near(twin[d]?.waste ?? 0, p.ledger.waste[d] ?? 0, `${label} ${d}: Stock and GP waste`);
    const dayEvents = w.waste.filter((e) => dayOf(Date.parse(e.occurredAt)) === d);
    const dayMv = w.movements.filter((x) => x.movement_type === 'WASTE' && dayOf(Date.parse(x.occurred_at)) === d);
    near(wasteFromLedger({ events: dayEvents, movements: dayMv }).total, p.ledger.waste[d] ?? 0, `${label} ${d}: Wastage log waste`);
    near(twin[d]?.theo ?? 0, (p.ledger.cogs[d] ?? 0) - (kept[d] ?? 0), `${label} ${d}: Stock and GP cost = the P&L's COGS less a voided check's stock rows`);
    assert.ok((twin[d]?.gp_after ?? 0) <= (twin[d]?.gp_before ?? 0) + 1e-9, `${label} ${d}: GP after is never above GP before`);
    if (owner) {
      const o = await ownerToday(w, d);
      near(o.today.net_sales, net, `${label} ${d}: Owner app net`);
      near(o.today.gift_cards_sold ?? 0, gift, `${label} ${d}: Owner app gift cards sold`);
      near(o.today.labour, p.labour[d] ?? 0, `${label} ${d}: Owner app labour`);
      assert.equal(o.demo_left_out, w.checks.some((c) => isDemoCheck(c)), `${label} ${d}: the Owner app says when demo history was left out`);
    }
  }
}

// ── 29 Oct 2026 (v5.11.118, Drop C): gift cards sold at the till ─────────────
// Peter's call: a gift card sale is MONEY IN, NOT SALES. One closed check with a £20 gift card line
// and a £10 latte at 20% VAT, £30 by card, goes through EVERY report's own rule, and each must say:
// net sales 8.33, VAT 1.67, gift cards sold 20.00, money collected 30.00.
test('Drop C parity: a £20 gift card and a £10 latte paid £30 by card reads the same in every report', async () => {
  const d = '2026-10-14';
  const closed = new Date(businessDayWindow(d, TZ, START).fromMs + 5 * 3600000).toISOString();
  const giftLine = { uid: 'ug', itemId: 'gift_card', kind: 'gift_card_sale', name: 'Gift card', price: 20, qty: 1, taxExempt: true, noDiscount: true };
  const row = {
    id: 'gift-parity', location_id: 'L', ref: 'GP1', closed_at: closed, subtotal: 30, total: 30, tax_amount: 1.67, service: 0, tip: 0, status: 'paid', voided: false,
    discounts: [], tenders: [{ method: 'card', amount: 30, tip: 0, processor: 'adyen' }], method: 'card', payment_method: 'card', source: 'pos', processor: 'adyen',
    gift_card: null, loyalty: null, promo: null, payment_intents: null, refunds: [], order_type: 'dine-in',
    tax_breakdown: xeroBreakdown([{ id: 'r20', gross: 10, tax: 1.6667 }]),
    items: [{ uid: 'u0', cat: 'cat-hot_1e945c26', itemId: 'm-latte', name: 'Latte', qty: 1, price: 10, taxRateId: 'r20' }, giftLine],
  };
  const want = { net: 8.33, vat: 1.67, gift: 20, collected: 30 };
  // the one rule itself
  const parts = checkSalesParts(row);
  near(parts.net, want.net, 'checkSalesParts net'); near(parts.vat, want.vat, 'checkSalesParts VAT'); near(parts.giftCardsSold, want.gift, 'checkSalesParts gift');
  near(parts.gross + parts.giftCardsSold, want.collected, 'the card took goods, VAT and the gift card');
  // Daily trading (tradingDays) and Daily trend
  const td = tradingDays({ saleRows: [row], refundRows: [row], dayOf })[d];
  near(td.net, want.net, 'Daily trading net'); near(td.vat, want.vat, 'Daily trading VAT'); near(td.gift_sold, want.gift, 'Daily trading gift cards sold');
  // the Business summary and the X and Z slip (salesBreakdown through summariseShift)
  const w = { checks: [row], timesheets: [], movements: [], waste: [] };
  const bs = businessSummaryAll(w, d);
  near(bs.net, want.net, 'Business summary net'); near(bs.tax, want.vat, 'Business summary VAT'); near(bs.giftSold, want.gift, 'Business summary gift cards sold');
  near(bs.collected, want.collected, 'Business summary money collected'); near(bs.items, 10, 'Business summary item sales leave the gift card out');
  const win = businessDayWindow(d, TZ, START);
  const shift = summariseShift([row], { range: { fromMs: win.fromMs, toMs: win.toMs - 1 }, currency: 'GBP' });
  near(shift.sales.net, want.net, 'Z report net'); near(shift.sales.giftSold, want.gift, 'Z report gift cards sold'); near(shift.sales.collected, want.collected, 'Z report money collected');
  near(shift.payments.reduce((s, p) => s + p.amount, 0), want.collected, 'Z report payments');
  const slip = buildShiftReportDoc({ kind: 'Z', sales: shift.sales, payments: shift.payments, currency: 'GBP' }).ops
    .filter((o) => o.t === 'twoCol' || o.t === 'twoColTrunc').map((o) => `${o.l} | ${o.r}`);
  assert.ok(slip.includes('plus Gift cards sold | £20.00') && slip.includes('  Net sales excluding VAT | £8.33'), slip.join('\n'));
  // the old Business summary reading (computeSalesStats, still used for the service period split)
  const old = computeSalesStats([toAccountingRow(row)].map((r) => ({ ...r, taxAmount: r.tax_amount, closedAt: Date.parse(r.closed_at) })));
  near(old.giftSold, want.gift, 'computeSalesStats gift cards sold'); near(old.gross, 10, 'computeSalesStats gross leaves the gift card out'); near(old.total, want.collected, 'computeSalesStats total');
  // the Manager app's money loop and the Owner app itself
  const m = managerMoney(w, d);
  near(m.net, want.net, 'Manager app net'); near(m.gift, want.gift, 'Manager app gift cards sold');
  const o = await ownerToday(w, d);
  near(o.today.net_sales, want.net, 'Owner app net'); near(o.today.vat, want.vat, 'Owner app VAT'); near(o.today.gift_cards_sold, want.gift, 'Owner app gift cards sold');
  near(o.today.gross_sales, 10, 'Owner app gross leaves the gift card out');
  // the Stock and GP SQL's twin
  const twin = stockGpDays({ checks: [row], movements: [], timesheets: [], dayOf, isComp: () => false });
  near(twin[d]?.net ?? 0, want.net, 'Stock and GP twin net');
  // the Xero daily invoice: goods at 20% with the till's VAT, Gift cards sold No VAT to the liability, the card paid 30.00
  const g = buildGroupedDay({ day: win, saleRows: [row], refundRows: [], venue: { timezone: TZ, dayStart: START }, taxRates: UK_TAX, resolver: makeGroupResolver(xeroMapping(), CATEGORIES) });
  const plan = planXeroInvoiceDay(g, { mapping: xeroMapping(), detail: XERO_DETAIL, site: XERO_SITE, date: d, currency: 'GBP' });
  assert.deepEqual(plan.blocked, []);
  assert.deepEqual(plan.invoice.lines.map((l) => [l.kind, l.description, l.taxType, l.amount, l.tax]), [['sales', 'Hot drinks 20%', 'OUTPUT2', 1000, 167], ['gift', 'Gift cards sold', 'NONE', 2000, 0]]);
  assert.deepEqual(plan.payments.map((x) => [x.account, x.amount]), [['CARDCLR', 3000]]);
  near(g.summary.sales.totals.sales / 100 - g.summary.sales.totals.tax / 100, want.net, 'Xero net');
});

test('one seeded world: every report gives the same net, labour, waste and cost per venue day', async () => {
  const w = world(7);
  assert.ok(w.checks.some((c) => c.refunds.length && c.refunds.some((e) => dayOf(e.timestamp) !== dayOf(Date.parse(c.closed_at)))), 'the world has a refund made on a later day');
  assert.ok(w.checks.some(isDemoCheck) && w.checks.some((c) => c.voided), 'and demo checks and a voided check');
  assert.ok(w.checks.some((c) => c.items.some((i) => i.kind === 'gift_card_sale')), 'and gift cards sold at the till');
  await parity(w, 'seed 7');
  // the figures that moved the most in the audit, here: a refund comes off the day it was MADE
  const p = pnl(w);
  const lateDays = new Set(w.checks.filter((c) => !isDemoCheck(c) && !c.voided).flatMap((c) => c.refunds.filter((e) => e.cardStatus === 'accepted').map((e) => dayOf(e.timestamp))));
  for (const d of lateDays) if (w.DAYS.includes(d)) assert.ok(p.sales[d].refunds > 0, `${d} carries its refunds`);
});

test('property: 25 random worlds, the same figure everywhere (the Owner app on 5 of them)', async () => {
  for (let s = 100; s < 125; s++) await parity(world(s, { days: 3 }), `seed ${s}`, { owner: s < 105 });
});

test('the demo rule changes nothing at a venue with no demo history: the same array, the same figures', async () => {
  const w = world(11, { demo: false });
  assert.equal(leaveOutDemo(w.checks).rows, w.checks, 'the same array comes back');
  assert.equal(leaveOutDemo(w.checks).left, 0);
  const withDemo = world(11, { demo: true });
  const a = pnl(w), b = pnl(withDemo);
  for (const d of w.DAYS) {
    assert.deepEqual(b.sales[d], a.sales[d], `${d}: demo checks change no P&L sales figure`);
    assert.deepEqual(b.ledger.cogs[d], a.ledger.cogs[d], `${d}: demo stock changes no COGS`);
    assert.deepEqual(b.ledger.waste[d], a.ledger.waste[d], `${d}: demo stock changes no waste`);
  }
  assert.ok(b.ledger.demoLeft > 0, 'and the demo rows were seen and left out');
  const o = await ownerToday(w, w.DAYS[0]);
  assert.equal(o.demo_left_out, false, 'a venue with no demo history says nothing');
});

test('the one demo rule: checks, stock keys, the page callback and the words', () => {
  assert.equal(isDemoCheck({ id: 'demo-s-1' }), true);
  for (const id of ['chk-1', 'QR-DEMO1', 'c3ebfa7f-61b3', 'Demo-1', null]) assert.equal(isDemoCheck({ id }), false, String(id));
  for (const k of ['demo-v1:sale:x', 'demo71:x', 'seed:x']) assert.equal(isDemoStockKey(k), true, k);
  for (const k of ['sale:demo-1:i', 'waste:x', null]) assert.equal(isDemoStockKey(k), false, String(k));
  let marked = 0; const got = [];
  withoutDemoRows((rows) => got.push(...rows), () => { marked += 1; })([{ id: 'demo-1' }, { id: 'chk-2' }]);
  assert.deepEqual(got, [{ id: 'chk-2' }]);
  assert.equal(marked, 1);
  assert.equal(DEMO_NOTE, 'Demo history left out');
  // the same words as Stock and GP and the Owner app's Stock line
  assert.match(read('./stock/dashboardRules.js'), /export const DEMO_LINE = 'Demo history left out';/);
  assert.match(read('./ownerStock.js'), /'Demo history left out'/);
});

// ── the pins: each report really calls the rule this test runs ────────────────

test('pin: Daily trading leaves demo out of sales, refunds and the ledger, and its costs are ledgerDays', () => {
  const src = read('../../supabase/functions/trading-report/index.ts');
  assert.match(src, /const sales = leaveOutDemo\(saleRows\), refunds = leaveOutDemo\(refundRows\);/);
  assert.match(src, /select\('value_delta, occurred_at, movement_type, idempotency_key'\)/);
  assert.match(src, /const ledger = ledgerDays\(\{ movements: mv, dayOf \}\);/);
  assert.match(src, /demo_left_out: demo\.left > 0/);
});

test('pin: the Manager app is on the business day, the P&L labour rule and the demo rule', () => {
  const src = read('../../supabase/functions/manager-snapshot/index.ts');
  // The venue clock, with the venue's own zone when the Platform row is missing and the calendar day
  // when the clock cannot be read (review fix), and the rota for both days before the day starts.
  assert.match(src, /const c = await venueClock\(platform, loc\);/);
  assert.match(src, /clock = \{ timezone: c\.found \? c\.timezone : tz/);
  assert.match(src, /in\('shift_date', bizDay === today \? \[today\] : \[bizDay, today\]\)/);
  assert.match(src, /const live = leaveOutDemo\(checks\), older = leaveOutDemo\(olderRefunds\);/);
  assert.match(src, /if \(Number\.isFinite\(t\) && dayOf\(t\) === bizDay\) addCheckSales\(sales, c\);/);
  assert.match(src, /if \(at != null && dayOf\(at\) === bizDay\) addRefundSales\(sales, e, c\);/);
  assert.match(src, /const at = timesheetDayMs\(t\);/);
  assert.match(src, /eq\('forecast_date', bizDay\)/);
  assert.doesNotMatch(src, /ymd\(new Date\(c\.closed_at\), tz\) === today/, 'no calendar day for money');
});

test('pin: the Owner app reads every check page through the demo rule', () => {
  const src = read('../../supabase/functions/_shared/ownerSnapshot.js');
  const reads = src.match(/pagedEach\('[^']+', \(\) => ops\.from\('closed_checks'\)[\s\S]*?\), (withoutDemoRows\()?\(rows\)/g) || [];
  assert.ok(reads.length >= 8, `the closed checks page reads (${reads.length})`);
  for (const r of reads) assert.match(r, /withoutDemoRows\(\(rows\)$/, r.slice(0, 80));
});

test('pin: Xero daily sales leave a demo check out; the Back Office reports, the refund lookback, All sites overview and Daily trend too', () => {
  assert.match(read('../../supabase/functions/_shared/accountingData.ts'), /const saleNoDemo = leaveOutDemo\(sale\)\.rows, refundNoDemo = leaveOutDemo\(refund\)\.rows;/);
  const bo = read('../backoffice/sections/BOReports.jsx');
  assert.match(bo, /const demoCur {2}= useMemo\(\(\) => leaveOutDemo\(allChecksRaw\), \[allChecksRaw\]\);/);
  assert.match(bo, /\{demoNote && <div style=\{\{ fontSize:11, color:'var\(--t4\)', margin:'0 0 8px' \}\}>\{DEMO_NOTE\}<\/div>\}/);
  assert.match(read('../backoffice/sections/reports/_refundLookback.js'), /rows\[ids\[i\]\] = leaveOutDemo\(r\.data\)\.rows/);
  const lc = read('../backoffice/sections/reports/LocationCompare.jsx');
  assert.match(lc, /salesBreakdown\(of\(checks, id\), \{ range: \{ fromMs: toMs\(w\.from\), toMs: toMs\(w\.to\) \}, refundRows: lookback\.rows\[id\] \|\| \[\], currency \}\)\.net/);
  assert.doesNotMatch(lc, /loc\.revenue {3}\+= c\.total/, 'All sites overview no longer adds check totals');
  assert.match(lc, /<StatTile label="Portfolio net sales"/);
  const dt = read('../backoffice/sections/reports/DailyTrend.jsx');
  assert.match(dt, /const net = tradingDays\(\{ saleRows, refundRows: \[\.\.\.saleRows, \.\.\.\(refundRows \|\| \[\]\)\.map\(toAccountingRow\)\], dayOf: \(ms\) => dayOfCheck\(ms, clock\) \}\);/);
  assert.doesNotMatch(dt, /buckets\[k\]\.revenue \+= Number\(c\.total\)/, 'Daily trend no longer adds check totals');
  assert.match(dt, /<StatTile label="Net sales" value=\{fmt\(totals\.totalRevenue\)\}/);
});

test('pin: the Wastage log values waste from the ledger; one Gross; the menu engineering basis says so', () => {
  const wl = read('../backoffice/sections/Wastage.jsx');
  assert.match(wl, /const wl = useMemo\(\(\) => wasteFromLedger\(\{ events: log, movements: ledger \|\| \[\] \}\), \[log, ledger\]\);/);
  assert.doesNotMatch(wl, /log\.reduce\(\(s, w\) => s \+ \(w\.costValue \|\| 0\), 0\)/, 'the total is not the waste rows\' own cost');
  const dtr = read('../backoffice/sections/reports/DailyTrading.jsx');
  assert.doesNotMatch(dtr, />Gross takings |Gross \(inc VAT\)<\/th>/, 'Daily trading no longer says Gross for takings before refunds');
  assert.match(dtr, /Takings before refunds/);
  assert.match(read('../backoffice/sections/reports/MenuEngineering.jsx'), /Margin here is the average price per unit/);
  assert.match(read('../backoffice/sections/StockReports.jsx'), /GP here is each dish's menu price excluding VAT less its plate cost at today's costs/);
});

test('pin: the SQL release puts the rules where this test holds them (20261029a)', () => {
  const mig = read('../../supabase/migrations/20261029a_OPS_reports_align.sql');
  assert.ok([...mig].every((ch) => ch.charCodeAt(0) < 128), 'ASCII only');
  assert.ok(!mig.includes('!'), 'no exclamation mark anywhere (a zsh paste trap)');
  assert.match(mig, /create or replace function public\._sales_is_demo\(p_id text\)[\s\S]*?select coalesce\(left\(p_id, 5\) = 'demo-', false\);/);
  assert.match(mig, /from t where t\.status in \('approved', 'paid'\) and t\.day between p_from and p_to/);
  assert.match(mig, /'gp_before', \(p_row ->> 'sales_net'\)::numeric - \(p_row ->> 'theo_cost'\)::numeric \+ \(p_row ->> 'comps_cost'\)::numeric,\s*'gp_after', \(p_row ->> 'sales_net'\)::numeric - \(p_row ->> 'theo_cost'\)::numeric,/);
  assert.match(mig, /coalesce\(od\.sold, 0\) \+ coalesce\(s\.theo_cost, 0\) - coalesce\(u\.v, 0\)/);
  assert.match(mig, /coalesce\(s\.net, 0\) - coalesce\(r\.net_back, 0\),/);
  assert.match(mig, /drop policy waste_events_ins on public\.waste_events;/);
  const rb = read('../../supabase/migrations/20261029a_OPS_reports_align_ROLLBACK.sql');
  assert.ok([...rb].every((ch) => ch.charCodeAt(0) < 128) && !rb.includes('!'), 'the rollback: ASCII only, no exclamation mark');
});

// v5.11.100 (Drop 4b): the new Stock and GP reports that show a figure another report shows read it by the
// same rule, from the same place, never their own copy. The local PostgreSQL proof that the figures are equal
// is supabase/tests/stock_native/drop4b.mjs section 64 (budget sales = Cost of sales, transfers = Stock
// movement, month end closing, opening and purchases = Stock movement, month end waste = Waste, league budget =
// Purchase budget); this pins where each one is read.
test('pin: the Drop 4b reports read every overlapping figure by the Reports align rule (20261030a)', () => {
  const mig = read('../../supabase/migrations/20261030a_OPS_stock_native_4b.sql');
  const fn = (name) => {
    const m = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$fn\\$;`).exec(mig);
    assert.ok(m, `${name} is in the file`);
    return m[0];
  };
  // net sales after refunds, demo history left out: the site figures every Stock and GP report reads (align's v3 day totals)
  const budget = fn('stock_report_budget');
  assert.match(budget, /v_fig := public\.stock_rp__site_figures\(v_g, v_win\);/);
  assert.match(budget, /'sales_net', \(f ->> 'sales_net'\)::numeric/);
  assert.match(budget, /case when pg\.sd then null else coalesce\(\(select round\(sum\(d\.net\), 2\) from sales_day_sums d/, 'a week with demo sales not yet rebuilt shows no sales, as every Stock and GP report');
  // waste, purchases, opening and closing: the stock ledger through the site figures (and a locked period's snapshot)
  const me = fn('stock_report_month_end');
  for (const k of ['closing_value', 'purchases', 'transfers_in', 'transfers_out', 'waste_value']) assert.match(me, new RegExp(`\\(s\\.f ->> '${k}'\\)::numeric`));
  // transfers in and out: the ledger, as Stock movement
  const tr = fn('stock_report_transfers');
  assert.match(tr, /'sent_out', round\(coalesce\(\(f ->> 'transfers_out'\)::numeric, 0\), 2\), 'received_in', round\(coalesce\(\(f ->> 'transfers_in'\)::numeric, 0\), 2\)/);
  // the league and the dashboard budget: the one budget rule (stock_rp__budget), also behind Purchase budget
  assert.match(fn('stock_rp__budget_merge'), /public\.stock_rp__budget\(w\.loc, w\.f, w\.tt, false\)/);
  assert.match(budget, /cross join lateral public\.stock_rp__budget\(s\.id, p_from, p_to, true\) b/);
  // no new report adds up closed checks, timesheets or waste rows of its own
  for (const n of ['stock_report_off_contract', 'stock_report_budget', 'stock_report_transfers', 'stock_report_count_compliance', 'stock_report_month_end']) {
    const b = fn(n);
    assert.doesNotMatch(b, /from closed_checks|from wf_timesheets|from waste_events/, `${n} reads no sales, labour or waste of its own`);
  }
  assert.ok([...mig].every((ch) => ch.charCodeAt(0) < 128) && !mig.includes('!'), 'ASCII only, no exclamation mark');
});
