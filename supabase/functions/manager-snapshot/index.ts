// supabase/functions/manager-snapshot/index.ts
//
// Single-venue data engine for the ServOS Manager app (?mode=manager). One round trip returns the
// PAIRED location's "today" money + the live floor + live team, for a paired device (anon) or a BO
// user. Money mirrors owner-snapshot exactly (_shared/snapshotSales.js, 27 Sep 2026: what customers
// paid for the goods after discounts and comps, per check like the Daily trading report; net is
// EX-VAT; pennies; VAT is a liability, never profit; never the shelf subtotal). The client
// classifies floor/team with the unit-tested engines in src/lib/manager/*. Service-role reads,
// fenced by location + caller.
//
//   POST { action:'snapshot', ops_location_id }  — token in Authorization header.
// Auth: the device claimed to THIS location (ops_devices.device_uid = auth.uid()), OR a BO user who
// reaches it. Single venue only: multi site rollups stay in Back Office.
// v5.11.84 (multi site stock Drop 0, plan 6.2): "reaches" is the database's own rule
// (officeReachesVenue: a link row, a super admin, or the owner of the venue's company; owners were
// refused before). A login that reaches the venue ONLY through Stock control 'all' in its company
// (stockOfficeReachesVenue) gets the stock blocks only (kitchen: items, deliveries, batches and the
// tracked item count), never sales, the floor, the team or the Ops counts: scope 'stock' in the answer.

// v5.11.96 (multi site stock Drop 3, contract 3.4): new stock blocks for the phone's sheets:
// kitchen.orderBy (next delivery and order by time per supplier, from the order pad context or the
// supplier's days and cut off; items keep delivery_days for old builds), kitchen.approvals (orders
// waiting at this site), kitchen.transfers (waiting to be received here, requested of us, and the
// company's other sites), kitchen.closedown (today's short life items), kitchen.ordersIn (central
// kitchens only) and stock.alerts (the unacked stock bell rows of the last 24 hours, at most 20). A
// central kitchen order in deliveries carries internal: true (it arrives as a transfer).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { secondStepRefusal } from '../_shared/second-step.ts';
import { pagedRows } from '../_shared/pagedRows.js';
import { SALES_CHECK_COLS, emptySales, addCheckSales, addRefundSales, refundMadeAt } from '../_shared/snapshotSales.js';
// v5.11.64: the pack rule, pack content and net pack price are the Order pad's own (one copy).
import { pickSupplierProduct, packContent, packContentInBase, netPackPrice, nextDelivery, rulesFromDeliveryDays } from '../_shared/purchasingRules.js';
// v5.11.84: the two reach rules (everything / stock only), and archived rows left out of choices.
import { officeReachesVenue, stockOfficeReachesVenue, readOfficeReachFacts } from '../_shared/stockOfficeReach.js';
import { liveOrAll, liveFilter } from '../_shared/stockPhone.js';
// v5.11.99 (Reports align): the venue business day (the Owner app's and Daily trading's day), the
// P&L labour rule and the one demo rule.
import { businessDayOf, businessDayWindow } from '../_shared/businessDay.js';
import { venueClock } from '../_shared/accountingData.ts';
import { timesheetDayMs } from '../_shared/tradingSales.js';
import { leaveOutDemo } from '../_shared/demoHistory.js';

// A refund counts on the day it was MADE, so older checks that carry one are read too: the same
// reach as Daily trading (trading-report REFUND_LOOKBACK_DAYS) and the Owner app (8 Oct 2026).
const REFUND_LOOKBACK_DAYS = 400;

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
// v5.11.99: the Platform locations row holds the venue's time zone and business day start.
const platform = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

const r2 = (n: number) => Math.round(n * 100) / 100;
const ymd = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const ms = (v: any) => { if (v == null) return null; const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };

// scope 'all': the whole snapshot. scope 'stock': the stock blocks only (plan 6.2).
type Access = { ok: true; scope: 'all' | 'stock' } | { ok: false; res: Response };
async function requireManager(req: Request, loc: string): Promise<Access> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return { ok: false, res: json({ error: 'auth required' }, 401) };
  if (token === SERVICE_ROLE) return { ok: true, scope: 'all' };
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user) return { ok: false, res: json({ error: 'invalid session' }, 401) };
  // Paired device claimed to this location (and not decommissioned)?
  const { data: dev } = await sb.from('ops_devices').select('id').eq('device_uid', user.id).eq('location_id', loc).eq('active', true).not('claimed_at', 'is', null).maybeSingle();
  if (dev) return { ok: true, scope: 'all' };
  // A Back Office user who reaches the venue: a link row, a super admin, or the owner of its company.
  const facts = await readOfficeReachFacts(sb, user, loc);
  if (officeReachesVenue(facts).ok) return { ok: true, scope: 'all' };
  // Stock control 'all' in the venue's own company: the stock blocks and nothing else.
  if (stockOfficeReachesVenue(facts).ok) return { ok: true, scope: 'stock' };
  return { ok: false, res: json({ error: 'no access to this location' }, 403) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: any; try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const loc = body?.ops_location_id;
  if (!loc) return json({ error: 'ops_location_id required' }, 400);
  const acc = await requireManager(req, loc); if (!acc.ok) return acc.res;
  // v5.11.84: false for a login that reaches the venue only through Stock control 'all' (plan 6.2):
  // sales, the floor, the team and the Ops counts are not even read for it.
  const full = acc.scope === 'all';

  try {
    // Venue metadata (timezone for "today", currency).
    const [{ data: vs }, { data: locRow }] = await Promise.all([
      sb.from('wf_venue_settings').select('currency, labour_target_pct').eq('location_id', loc).maybeSingle(),
      sb.from('locations').select('timezone, name').eq('id', loc).maybeSingle(),
    ]);
    const tz = locRow?.timezone || 'Europe/London';
    const currency = vs?.currency || 'GBP';
    const now = new Date();
    // The calendar date, for the kitchen blocks only (prep schedules and the close down list are
    // kept by calendar date).
    const today = ymd(now, tz);
    // v5.11.99 (Reports align): money, labour, the forecast, the rota and the team are on the venue
    // BUSINESS day (Platform locations: time zone and business_day_start), the day the Owner app,
    // Daily trading, Back Office and Xero use. It was midnight to midnight on the Ops time zone, so
    // between midnight and 06:30 the Manager app showed an empty new day while the Owner app still
    // showed the day finishing. A failed read of the clock is an error: no day is cut on a guess.
    const clock = full ? await venueClock(platform, loc) : null;
    const dayOf = (msv: number) => businessDayOf(msv, clock!.timezone, clock!.dayStart);
    const bizDay = clock ? dayOf(now.getTime()) : today;
    const bizFromMs = clock ? businessDayWindow(bizDay, clock.timezone, clock.dayStart).fromMs : now.getTime() - 36 * 3600 * 1000;
    // From a day before the business day starts: an opener's shift and every check of the day.
    const startIso = new Date(Math.min(bizFromMs - 24 * 3600 * 1000, now.getTime() - 36 * 3600 * 1000)).toISOString();
    // 8 Oct 2026 (review): a refund made today on a sale older than those 36 hours comes off today
    // too, so the tile agrees with Daily trading (which reads refunds back 400 days) and the Owner app.
    const refundsSinceIso = new Date(now.getTime() - REFUND_LOOKBACK_DAYS * 86400000).toISOString();

    // Every list read pages (_shared/pagedRows.js): PostgREST returns at most 1000 rows a request
    // whatever .limit() asks for (.limit(20000) came back with 1000). A failed read is an error
    // (500 with the message), never £0 or an empty team.
    // v5.10.2: the timesheets read carries `id`. Each punch sends it as the target of the Team
    // tab's Clock out (manager-approve 'timesheet.clock_out'); without it the button (v5.8.21)
    // never rendered (snapshotSales.test.js pins it).
    const [checks, olderRefunds, { data: fc }, tsRows, shifts, staff, sess, ftables] = !full
      ? [[], [], { data: null }, [], [], [], [], []] as any[]
      : await Promise.all([
      pagedRows('closed checks', () => sb.from('closed_checks').select(SALES_CHECK_COLS).eq('location_id', loc).gte('closed_at', startIso).order('closed_at').order('id')),
      // Older checks that carry a refund (few): only their refunds are read, never their sales.
      pagedRows('older refunds', () => sb.from('closed_checks').select(SALES_CHECK_COLS).eq('location_id', loc).gte('closed_at', refundsSinceIso).lt('closed_at', startIso).neq('refunds', '[]').order('closed_at').order('id')),
      sb.from('wf_sales_forecast').select('forecast_date, amount').eq('location_id', loc).eq('forecast_date', bizDay).maybeSingle(),
      pagedRows('timesheets', () => sb.from('wf_timesheets').select('id, staff_id, clock_in, clock_out, break_taken, break_open_at, pay_amount, status, effective_rate').eq('location_id', loc).gte('clock_in', startIso).order('clock_in').order('id')),
      pagedRows('shifts', () => sb.from('wf_shifts').select('staff_id, role_key, shift_date, start_time, finish_time, status').eq('location_id', loc).eq('shift_date', bizDay).order('id')),
      pagedRows('staff', () => sb.from('wf_staff').select('id, name, dob').eq('location_id', loc).order('id')),
      pagedRows('open tables', () => sb.from('active_sessions').select('table_id, session').eq('location_id', loc).order('id')),
      pagedRows('tables', () => sb.from('floor_tables').select('id, label').eq('location_id', loc).order('id')),
    ]);
    // v5.5.990 — the Manager app used to hardcode 'a break is due after 6h with
    // none logged', blind to age and to the venue's own policy. Ship both so it
    // uses the same rule as the Back Office.
    const { data: vsRow } = full ? await sb.from('wf_venue_settings').select('settings').eq('location_id', loc).maybeSingle() : { data: null };
    const breakPolicy = (vsRow?.settings ?? {}) as Record<string, unknown>;
    // table_id on a session IS the floor_tables.id → resolve the friendly label ("T2", "B3", …).
    const tableLabel: Record<string, string> = {};
    for (const f of ftables) if (f?.id) tableLabel[f.id] = f.label;

    // ── Money (today, venue-local): what customers paid for the goods, VAT apart; voided checks
    //    count for nothing (_shared/snapshotSales.js, the same reading as owner-snapshot) ──
    // v5.11.99: demo checks left out by the one demo rule (_shared/demoHistory.js).
    const live = leaveOutDemo(checks), older = leaveOutDemo(olderRefunds);
    const demoLeftOut = live.left + older.left > 0;
    const sales = emptySales();
    for (const c of live.rows) { const t = Date.parse(c.closed_at); if (Number.isFinite(t) && dayOf(t) === bizDay) addCheckSales(sales, c); }
    // 8 Oct 2026: a refund made today comes off today, with its VAT (as Daily trading and Xero),
    // whether its sale closed today or weeks ago (olderRefunds, 8 Oct 2026 review).
    for (const c of [...live.rows, ...older.rows]) {
      for (const e of (Array.isArray(c.refunds) ? c.refunds : [])) {
        const at = refundMadeAt(e, c);
        if (at != null && dayOf(at) === bizDay) addRefundSales(sales, e, c);
      }
    }
    const { net, vat, gross, orders, tips } = sales;
    // v5.11.99: the P&L labour rule (_shared/tradingSales.js timesheetDays): approved and paid
    // timesheets, each on the business day most of its shift falls in (timesheetDayMs).
    let labour = 0;
    for (const t of tsRows) {
      if (!['approved', 'paid'].includes(String(t.status))) continue;
      const at = timesheetDayMs(t);
      if (at == null || dayOf(at) !== bizDay) continue;
      labour += Number(t.pay_amount) || 0;
    }
    const forecast = Number(fc?.amount) || 0;
    const money = {
      currency,
      net: r2(net), vat: r2(vat), gross: r2(gross), orders, tips: r2(tips),
      avgCheck: orders ? r2(net / orders) : 0,
      forecast: r2(forecast), forecastPct: forecast > 0 ? Math.round((net / forecast) * 100) : null,
      labour: r2(labour), labourPct: net > 0 ? r2((labour / net) * 100) : null,
      labourTargetPct: vs?.labour_target_pct != null ? Number(vs.labour_target_pct) : null,
      // 8 Oct 2026: refunds made today (already off net and vat) and sales with no VAT recorded, named.
      refunds: r2(sales.refunds || 0), refundVat: r2(sales.refund_vat || 0), vatMissing: sales.vat_missing || 0, vatMissingRefs: sales.vat_missing_refs || [],
      // v5.11.99: the business day the figures are for, and whether demo checks were left out.
      businessDay: bizDay, demoLeftOut,
    };

    // ── Floor (active_sessions.session jsonb → floor.js input shape) ──
    const floor = sess.map((row: any) => {
      const s = row.session || {};
      const items = Array.isArray(s.items) ? s.items : [];
      const hasOrder = !!s.sentAt || items.some((i: any) => i.status === 'sent' || i.fired);
      return {
        id: row.table_id || s.id || null,
        label: tableLabel[row.table_id] || s.label || 'Table',
        covers: Number(s.covers) || null,
        seatedAtMs: ms(s.seatedAt),
        lastFiredAtMs: ms(s.sentAt),
        hasOrder,
        status: s.status || null,
        server: s.server || null,
      };
    });

    // ── Team (timesheets + today's shifts → team.js input shape) ──
    const nameOf: Record<string, string> = {};
    const dobOf: Record<string, string | null> = {};
    for (const m of staff) { nameOf[m.id] = m.name; dobOf[m.id] = m.dob ?? null; }
    // "On shift now" must include anyone STILL clocked in (clock_out null) even if they clocked in
    // before midnight venue-time — otherwise a late/overnight shift vanishes the moment the venue
    // date rolls over (clocked in 23:48, it's now 00:12 → punch date != today). Today's completed
    // punches stay in for the day's team view. (tsRows is already bounded to clock_in within ~36h,
    // so a forgotten clock-out can't linger forever.)
    const punches = tsRows
      .filter((t: any) => t.clock_in && (t.clock_out == null || dayOf(Date.parse(t.clock_in)) === bizDay))
      .map((t: any) => ({
        id: t.id, staffId: t.staff_id, name: nameOf[t.staff_id] || 'Staff',
        inMs: ms(t.clock_in), outMs: ms(t.clock_out),
        breakMins: Number(t.break_taken) || 0, breakOpen: !!t.break_open_at,
        dob: dobOf[t.staff_id] || null,
      }));
    const parseShiftMs = (date: string, time: string) => (date && time ? ms(`${date}T${time}`) : null);
    const teamShifts = shifts
      .filter((sh: any) => String(sh.status) === 'published')
      .map((sh: any) => ({
        staffId: sh.staff_id, name: nameOf[sh.staff_id] || 'Staff', role: sh.role_key || null,
        startMs: parseShiftMs(sh.shift_date, sh.start_time), endMs: parseShiftMs(sh.shift_date, sh.finish_time),
      }));
    const ratesMinor: Record<string, number> = {};
    for (const t of tsRows) if (t.effective_rate != null) ratesMinor[t.staff_id] = Math.round(Number(t.effective_rate) * 100);

    // ── Approvals inbox (pending) — completed-but-unapproved timesheets (last 14d) + pending time-off.
    //    Surfaced for the Team tab's approvals (the UI gates display on the team_approvals flag; writes
    //    go through the manager-approve edge fn). Isolated: never break the rest of the snapshot. ──
    let pendingTimesheets: any[] = [], pendingTimeOff: any[] = [];
    if (full) try {
      const since = new Date(now.getTime() - 14 * 24 * 3600 * 1000).toISOString();
      const [{ data: pts }, { data: pto }] = await Promise.all([
        sb.from('wf_timesheets').select('id, staff_id, clock_in, clock_out, break_taken, status')
          .eq('location_id', loc).gte('clock_in', since).not('clock_out', 'is', null)
          .not('status', 'in', '(approved,paid)').order('clock_in', { ascending: false }).limit(200),
        sb.from('wf_time_off').select('id, staff_id, type, start_date, end_date, days, note, status')
          .eq('location_id', loc).eq('status', 'pending').order('start_date', { ascending: true }).limit(200),
      ]);
      pendingTimesheets = (pts ?? []).map((t: any) => ({
        id: t.id, staffId: t.staff_id, name: nameOf[t.staff_id] || 'Staff',
        inMs: ms(t.clock_in), outMs: ms(t.clock_out), breakMins: Number(t.break_taken) || 0, status: t.status,
        dob: dobOf[t.staff_id] || null,
      }));
      pendingTimeOff = (pto ?? []).map((l: any) => ({
        id: l.id, staffId: l.staff_id, name: nameOf[l.staff_id] || 'Staff', type: l.type,
        startDate: l.start_date, endDate: l.end_date, days: Number(l.days) || 0, note: l.note || null,
      }));
    } catch { pendingTimesheets = []; pendingTimeOff = []; }

    // ── Kitchen: stock items below par/reorder, for one PO per supplier (read-only). Greenfield stock
    //    system (inventory_items + par_levels); only items WITH a par row are "managed" → kept. The
    //    client (kitchen.js belowPar/bySupplier) decides what's short. Isolated: a stock read failure
    //    must never break takings/floor/team, so default to []. ──
    let kitchenItems: any[] = [];
    try {
      const pars = await pagedRows('par levels', () => sb.from('par_levels')
        .select('inventory_item_id, par_level, reorder_point').eq('location_id', loc).order('id'));
      const ids = pars.map((p: any) => p.inventory_item_id).filter(Boolean);
      if (ids.length) {
        // v5.11.64: the supplier is the one the Order pad names. default_supplier_id is an optional
        // preference the Back Office editor never writes; the real purchasing link is the supplier
        // pack (supplier_products), preferred first. Reading only the default put every normally
        // added item under "Unassigned" here while the pad knew its supplier. The pack itself
        // (size, net price, VAT) now travels too, so Raise order can count in packs and show the
        // money before the PIN; a made-here item (kind MADE) is cooked, not ordered, so it is left
        // out exactly as the Order pad leaves it out.
        const [invs, sups, packs, rates, convs] = await Promise.all([
          pagedRows('stock items', () => sb.from('inventory_items').select('id, name, kind, on_hand, base_unit, default_supplier_id, purchase_tax_rate_id')
            .eq('location_id', loc).in('id', ids).is('archived_at', null).order('id')),
          pagedRows('suppliers', () => sb.from('suppliers').select('id, name, delivery_days').eq('location_id', loc).order('id')),
          // v5.11.84 (multi site stock Drop 0, plan 5.4): an archived supplier price is never offered
          // (archived_at comes with 20261021a; before it every row is read, as before)
          liveOrAll((live: boolean) => pagedRows('supplier packs', () => liveFilter(sb.from('supplier_products')
            .select('id, inventory_item_id, supplier_id, supplier_sku, pack_description, pack_qty, inner_qty, inner_unit, pack_price, is_preferred, purchase_tax_rate_id, price_includes_tax, created_at')
            .eq('location_id', loc).in('inventory_item_id', ids), live).order('is_preferred', { ascending: false }).order('created_at').order('id'))),
          pagedRows('tax rates', () => sb.from('tax_rates').select('id, rate').eq('location_id', loc).order('id')),
          // the item's cross dimension bridges: the pack content is sent in the item's base unit too
          // (perPackBase), so the phone divides a shortfall in base units by a matching figure
          // v5.11.84 (Drop 0): an archived unit bridge does not convert
          liveOrAll((live: boolean) => pagedRows('unit conversions', () => liveFilter(sb.from('inventory_item_conversions').select('inventory_item_id, from_qty, from_unit, to_qty, to_unit')
            .eq('location_id', loc).in('inventory_item_id', ids), live).order('id'))),
        ]);
        const convBy: Record<string, any[]> = {};
        for (const c of convs) (convBy[c.inventory_item_id] ??= []).push({ fromQty: Number(c.from_qty), fromUnit: c.from_unit, toQty: Number(c.to_qty), toUnit: c.to_unit });
        const supBy: Record<string, any> = {};
        for (const su of sups) supBy[su.id] = su;
        const rateBy: Record<string, number> = {};
        for (const r of rates) rateBy[r.id] = Number(r.rate) || 0;
        // the camelCase pack shape src/lib/stock/data.js spFromRow gives the pad, so the shared rule reads it
        const packsBy: Record<string, any[]> = {};
        for (const p of packs) {
          if (!p.inventory_item_id || !p.supplier_id) continue;
          (packsBy[p.inventory_item_id] ??= []).push({
            id: p.id, supplierId: p.supplier_id, supplierSku: p.supplier_sku || null, packDescription: p.pack_description || null,
            packQty: Number(p.pack_qty) || 1, innerQty: Number(p.inner_qty) || 0, innerUnit: p.inner_unit || 'each',
            packPrice: Number(p.pack_price) || 0, isPreferred: p.is_preferred === true,
            purchaseTaxRateId: p.purchase_tax_rate_id || null, priceIncludesTax: p.price_includes_tax === true,
          });
        }
        const parBy: Record<string, any> = {};
        for (const p of pars) parBy[p.inventory_item_id] = p;
        kitchenItems = invs.filter((i: any) => i.kind !== 'MADE').map((i: any) => {
          const p = parBy[i.id] || {};
          const sp = pickSupplierProduct({ defaultSupplierId: i.default_supplier_id, supplierProducts: packsBy[i.id] || [] });
          // preferred pack, then the item's default supplier: the same order as pickSupplierProduct
          const sid = sp?.supplierId || i.default_supplier_id || null;
          const rate = sp ? (rateBy[sp.purchaseTaxRateId || i.purchase_tax_rate_id] || 0) : 0;
          return {
            itemId: i.id, name: i.name,
            onHand: Number(i.on_hand) || 0,
            unit: i.base_unit || 'each',
            par: p.par_level != null ? Number(p.par_level) : null,
            reorderPoint: p.reorder_point != null ? Number(p.reorder_point) : null,
            supplier: sid ? (supBy[sid]?.name || null) : null,
            supplierId: sid,   // po.raise needs the id, not just the display name
            deliveryDays: sid ? (supBy[sid]?.delivery_days ?? null) : null,
            pack: sp ? {
              id: sp.id, description: sp.packDescription, packQty: sp.packQty, innerQty: sp.innerQty, innerUnit: sp.innerUnit,
              perPack: packContent(sp), perPackBase: packContentInBase(sp, i.base_unit || 'each', convBy[i.id] || []),
              packPrice: netPackPrice(sp, rate), vatRate: rate, purchaseTaxRateId: sp.purchaseTaxRateId || i.purchase_tax_rate_id || null,
            } : null,
            eightySixed: false,
          };
        });
      }
    } catch { kitchenItems = []; }

    // v5.11.84 (multi site stock Drop 0, plan 4.23): how many live tracked stock items the venue has
    // (one head count): the phone shows Count stock only where there is stock to count. null when the
    // read fails (the phone then falls back to the items with a par).
    let trackedItems: number | null = null;
    try {
      const { count, error } = await sb.from('inventory_items').select('id', { count: 'exact', head: true })
        .eq('location_id', loc).is('archived_at', null).eq('is_tracked', true);
      trackedItems = error ? null : (count ?? 0);
    } catch { trackedItems = null; }

    // ── Ops: cheap headline counts for the Home tile (full detail lives in the Ops tab). Isolated. ──
    let ops = { openMaintenance: 0, activeAlerts: 0 };
    if (full) try {
      const [maint, al] = await Promise.all([
        pagedRows('maintenance requests', () => sb.from('maintenance_requests').select('status').eq('location_id', loc).order('id')),
        pagedRows('alerts', () => sb.from('ops_alerts').select('id').eq('location_id', loc).eq('status', 'sent').order('id')),
      ]);
      ops = {
        openMaintenance: maint.filter((m: any) => !['resolved', 'cancelled'].includes(String(m.status))).length,
        activeAlerts: al.length,
      };
    } catch { ops = { openMaintenance: 0, activeAlerts: 0 }; }

    // ── Kitchen incoming: open POs (SENT/PARTIAL) awaiting goods-in, with any delivery record.
    //    v5.11.64: the WHOLE order travels (every line with pack, quantity, net price and value, the
    //    goods-in record, the supplier id), so the Kitchen tab can open an order and receive it on the
    //    phone through manager-approve po.receive. Before this the row carried a line count and a
    //    date, nothing could be tapped, and the Ops Deliveries screen it pointed to reads
    //    purchase_orders under RLS, which a paired (anonymous) device is refused. Isolated. ──
    let kitchenDeliveries: any[] = [];
    try {
      const { data: pos } = await sb.from('purchase_orders')
        .select('id, reference, supplier_id, expected_date, status, ordered_at, subtotal, tax').eq('location_id', loc)
        .in('status', ['SENT', 'PARTIAL']).order('expected_date', { ascending: true, nullsFirst: false }).limit(500);
      if ((pos ?? []).length) {
        const poIds = (pos ?? []).map((p: any) => p.id);
        const [dels, lines, sups] = await Promise.all([
          pagedRows('deliveries', () => sb.from('deliveries').select('po_id, status, temperature_c, in_range, checked_by_name, checked_at, created_at')
            .eq('location_id', loc).in('po_id', poIds).order('created_at', { ascending: false }).order('id')),
          pagedRows('order lines', () => sb.from('po_lines')
            .select('id, po_id, inventory_item_id, supplier_product_id, description, qty_packs, pack_qty, inner_qty, inner_unit, unit_price, qty_received, sort_order')
            .eq('location_id', loc).in('po_id', poIds).order('sort_order').order('id')),
          pagedRows('suppliers', () => sb.from('suppliers').select('id, name').eq('location_id', loc).order('id')),
        ]);
        // the newest goods-in record per order
        const delBy: Record<string, any> = {};
        for (const d of dels) if (d.po_id && !delBy[d.po_id]) delBy[d.po_id] = d;
        const linesOf: Record<string, any[]> = {};
        for (const l of lines) (linesOf[l.po_id] ??= []).push(l);
        const supName: Record<string, string> = {};
        for (const su of sups) supName[su.id] = su.name;
        // codes for matching a scanned delivery note: the supplier's SKU for the item, and our own
        const itemIds = [...new Set(lines.map((l: any) => l.inventory_item_id).filter(Boolean))] as string[];
        const skuByItemSup: Record<string, string> = {};
        const itemMeta: Record<string, { sku: string | null; baseUnit: string | null }> = {};
        if (itemIds.length) {
          const [skus, its] = await Promise.all([
            pagedRows('pack codes', () => sb.from('supplier_products').select('id, inventory_item_id, supplier_id, supplier_sku')
              .eq('location_id', loc).in('inventory_item_id', itemIds).order('id')),
            pagedRows('line items', () => sb.from('inventory_items').select('id, sku, base_unit')
              .eq('location_id', loc).in('id', itemIds).order('id')),
          ]);
          for (const k of skus) if (k.supplier_sku && k.supplier_id) skuByItemSup[k.inventory_item_id + ':' + k.supplier_id] ??= k.supplier_sku;
          for (const it of its) itemMeta[it.id] = { sku: it.sku || null, baseUnit: it.base_unit || null };
        }
        kitchenDeliveries = (pos ?? []).map((p: any) => {
          const d = delBy[p.id] || null;
          const ls = linesOf[p.id] || [];
          return {
            id: p.id, reference: p.reference || null,
            supplierId: p.supplier_id || null,
            supplier: p.supplier_id ? (supName[p.supplier_id] || null) : null,
            lines: ls.length, expectedDate: p.expected_date || null, orderedAt: p.ordered_at || null,
            status: d?.status || 'pending',   // pending | accepted | rejected
            value: r2(Number(p.subtotal) || 0), tax: r2(Number(p.tax) || 0),
            delivery: d ? {
              status: d.status, temperatureC: d.temperature_c == null ? null : Number(d.temperature_c), inRange: d.in_range ?? null,
              checkedByName: d.checked_by_name || null, checkedAt: d.checked_at || null,
            } : null,
            orderLines: ls.map((l: any) => ({
              id: l.id, inventoryItemId: l.inventory_item_id || null, supplierProductId: l.supplier_product_id || null,
              description: l.description || null,
              qtyPacks: Number(l.qty_packs) || 0, packQty: Number(l.pack_qty) || 1, innerQty: Number(l.inner_qty) || 1, innerUnit: l.inner_unit || 'each',
              unitPrice: Number(l.unit_price) || 0, qtyReceived: Number(l.qty_received) || 0,
              lineValue: r2((Number(l.qty_packs) || 0) * (Number(l.unit_price) || 0)),
              supplierSku: l.inventory_item_id && p.supplier_id ? (skuByItemSup[l.inventory_item_id + ':' + p.supplier_id] || null) : null,
              itemSku: itemMeta[l.inventory_item_id]?.sku || null,
              baseUnit: itemMeta[l.inventory_item_id]?.baseUnit || null,
            })),
          };
        });
      }
    } catch { kitchenDeliveries = []; }

    // ── Kitchen batch cooks: today's scheduled prep (prep_schedule for today's weekday) + any completion
    //    (prep_log for today). The client builds dueAtMs in its own (venue-local) tz, so we pass the raw
    //    dueDate+dueTime rather than an absolute ms. Isolated: missing tables/failures default to [].
    //    v5.11.64: the Back Office Batches queue (production_batches) is the SAME work item. A planned
    //    batch for today whose schedule is not on today's weekday is still listed, and a batch completed
    //    in Back Office counts as done here even when no prep_log row was written. ──
    let kitchenBatches: any[] = [];
    try {
      const dow = new Date(today + 'T00:00:00Z').getUTCDay();   // 0=Sun..6=Sat for the venue-local date
      const [{ data: scheds }, { data: pbs }] = await Promise.all([
        sb.from('prep_schedule')
          .select('id, name, qty, unit, due_time, days_of_week, active, sort_order')
          .eq('location_id', loc).eq('active', true).order('sort_order').limit(500),
        sb.from('production_batches')
          .select('schedule_id, status, actual_qty, produced_at, due_time')
          .eq('location_id', loc).eq('planned_for', today).not('schedule_id', 'is', null).neq('status', 'CANCELLED').limit(500),
      ]);
      const pbBy: Record<string, any> = {};
      for (const b of (pbs ?? [])) if (b.schedule_id) pbBy[b.schedule_id] = b;
      const onToday = (s: any) => !Array.isArray(s.days_of_week) || s.days_of_week.length === 0 || s.days_of_week.includes(dow);
      const todays = (scheds ?? []).filter((s: any) => onToday(s) || pbBy[s.id]);
      if (todays.length) {
        const logs = await pagedRows('prep log', () => sb.from('prep_log')
          .select('schedule_id, actual_qty, recorded_at, recorded_by_name').eq('location_id', loc).eq('prep_date', today).order('id'));
        const logBy: Record<string, any> = {};
        for (const l of logs) if (l.schedule_id) logBy[l.schedule_id] = l;
        kitchenBatches = todays.map((s: any) => {
          const l = logBy[s.id];
          const pb = pbBy[s.id];
          const doneByBatch = !l && pb?.status === 'COMPLETED';
          const dueTime = s.due_time || pb?.due_time || null;
          return {
            id: s.id, scheduleId: s.id, name: s.name,
            plannedQty: s.qty != null ? Number(s.qty) : null, unit: s.unit || null,
            dueDate: today, dueTime: dueTime ? String(dueTime).slice(0, 5) : null,
            completedAtMs: l ? ms(l.recorded_at) : (doneByBatch ? ms(pb.produced_at) : null),
            actualQty: l?.actual_qty != null ? Number(l.actual_qty) : (doneByBatch && pb.actual_qty != null ? Number(pb.actual_qty) : null),
            assignee: l?.recorded_by_name || (doneByBatch ? 'Back Office' : null),
          };
        });
      }
    } catch { kitchenBatches = []; }

    // ── Kitchen: the products with a live recipe link at this venue (v5.11.93, multi site stock
    //    Drop 2), for the Recipe cards sheet: [{ menu_item_id, name }], at most 500, names from
    //    menu_items. Isolated: a failure, or a database before the recipe tables, gives []. ──
    let kitchenRecipes: any[] = [];
    try {
      const { data: links } = await sb.from('menu_item_recipes').select('menu_item_id, recipe_id').eq('location_id', loc).order('id').limit(500);
      const recipeIds = [...new Set((links ?? []).map((l: any) => l.recipe_id).filter(Boolean))];
      const live = new Set<string>();
      for (let i = 0; i < recipeIds.length; i += 100) {
        const { data: rs } = await sb.from('recipes').select('id').in('id', recipeIds.slice(i, i + 100)).is('archived_at', null);
        for (const r of (rs ?? [])) live.add(String(r.id));
      }
      const itemIds = [...new Set((links ?? []).filter((l: any) => live.has(String(l.recipe_id))).map((l: any) => String(l.menu_item_id)))];
      const names: Record<string, string> = {};
      for (let i = 0; i < itemIds.length; i += 100) {
        const { data: mis } = await sb.from('menu_items').select('id, name, menu_name, archived').in('id', itemIds.slice(i, i + 100)).eq('location_id', loc);
        for (const m of (mis ?? [])) if (!m.archived) names[String(m.id)] = m.menu_name || m.name || 'Product';
      }
      kitchenRecipes = itemIds.filter((id) => names[id]).map((id) => ({ menu_item_id: id, name: names[id] }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch { kitchenRecipes = []; }

    // ── v5.11.96 (multi site stock Drop 3, contract 3.4): the stock blocks the phone's new sheets read.
    //    Each is isolated (a failure, or a database before Drop 3, gives null or [] and never breaks the
    //    rest), and each is a stock block, so a Stock control 'all' login gets them too.
    //    orderBy: the next delivery and order by time per supplier (the order pad context's rules and
    //    exceptions, else the supplier's delivery days and cut off; delivery_days stays on items for
    //    old builds). approvals: orders waiting at this site. transfers: waiting to be received here and
    //    requested of us. closedown: today's short life items. ordersIn: a central kitchen's orders for
    //    today. alerts: the unacked stock bell rows of the last 24 hours (the Home needNow list). ──
    const actor = { uid: null, name: 'Manager app', staff_id: null, location_id: loc };
    let kitchenOrderBy: any[] = [];
    try {
      const { data: ctx, error: ctxErr } = await sb.rpc('stock_order_pad_context', { p_loc: loc, p_actor: actor });
      if (!ctxErr && ctx && Array.isArray((ctx as any).suppliers)) {
        kitchenOrderBy = (ctx as any).suppliers.map((x: any) => ({
          supplierId: x.supplier_id, name: x.name || '', internal: !!x.internal_location_id,
          deliveryDay: x.next?.delivery_day || null, orderByAt: x.next?.order_by_at || null,
          orderByYmd: x.next?.order_by_ymd || null, orderByHm: x.next?.order_by_hm || null, minutesLeft: x.next?.minutes_left ?? null,
          approvalLimit: x.approval_limit ?? null,
        }));
      } else {
        let { data: sups, error: supErr } = await sb.from('suppliers').select('id, name, delivery_days, cutoff_time').eq('location_id', loc).order('name').limit(200);
        if (supErr) ({ data: sups } = await sb.from('suppliers').select('id, name, delivery_days').eq('location_id', loc).order('name').limit(200));
        const hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
        kitchenOrderBy = (sups ?? []).map((su: any) => {
          const n = nextDelivery({ rules: rulesFromDeliveryDays(su.delivery_days, su.cutoff_time ?? null), exceptions: [], nowVenue: { ymd: today, hm } });
          return { supplierId: su.id, name: su.name || '', internal: false, deliveryDay: n?.deliveryYmd || null, orderByAt: n?.orderByAt || null,
            orderByYmd: n?.orderByYmd || null, orderByHm: n?.orderByHm || null, minutesLeft: n?.minutesLeft ?? null, approvalLimit: null };
        });
      }
    } catch { kitchenOrderBy = []; }

    let kitchenApprovals: any[] = [];
    try {
      const { data: ap, error: apErr } = await sb.from('stock_po_approvals')
        .select('po_id, status, step, amount, limit_amount, order_by_at, raised_by_name, supplier_id').eq('location_id', loc)
        .in('status', ['waiting', 'sent_back']).order('order_by_at', { ascending: true }).limit(50);
      if (!apErr) {
        const poIds = (ap ?? []).map((a: any) => a.po_id);
        const refBy: Record<string, string> = {};
        if (poIds.length) {
          const { data: pos } = await sb.from('purchase_orders').select('id, reference').eq('location_id', loc).in('id', poIds);
          for (const p of pos ?? []) refBy[p.id] = p.reference || '';
        }
        kitchenApprovals = (ap ?? []).map((a: any) => ({ poId: a.po_id, reference: refBy[a.po_id] || null, status: a.status, step: a.step,
          amount: a.amount == null ? null : Number(a.amount), limit: a.limit_amount == null ? null : Number(a.limit_amount), orderByAt: a.order_by_at || null, raisedByName: a.raised_by_name || null }));
      }
    } catch { kitchenApprovals = []; }

    let kitchenTransfers: any = { sites: [], incoming: [], requested: [] };
    try {
      const [inc, req2] = await Promise.all([
        sb.from('stock_transfers').select('id, reference, location_id, status, kind, sent_at, sent_by_name, reason').eq('to_location_id', loc).eq('status', 'SENT').order('sent_at', { ascending: true }).limit(50),
        sb.from('stock_transfers').select('id, reference, to_location_id, status, requested_by_name, requested_at, reason, note').eq('location_id', loc).eq('status', 'REQUESTED').order('requested_at', { ascending: true }).limit(50),
      ]);
      const incoming = inc.error ? [] : (inc.data ?? []);
      const ids = incoming.map((t: any) => t.id);
      const linesBy: Record<string, any[]> = {};
      if (ids.length) {
        // paged past the 1,000 row cap; before Drop 3 there is no lot or use by column, so the plain read
        let rows: any[];
        try {
          rows = await pagedRows('transfer lines', () => sb.from('stock_transfer_lines').select('id, transfer_id, name_snapshot, base_unit, qty_base, lot_code, use_by_at').in('transfer_id', ids).order('sort_order').order('id'));
        } catch {
          rows = await pagedRows('transfer lines', () => sb.from('stock_transfer_lines').select('id, transfer_id, name_snapshot, base_unit, qty_base').in('transfer_id', ids).order('sort_order').order('id'));
        }
        for (const l of rows) (linesBy[l.transfer_id] ??= []).push({ id: l.id, name: l.name_snapshot || 'Item', unit: l.base_unit || '', qtyBase: Number(l.qty_base) || 0, lotCode: l.lot_code || null, useByAt: l.use_by_at || null });
      }
      const siteIds = [...new Set([...incoming.map((t: any) => t.location_id), ...(req2.error ? [] : (req2.data ?? [])).map((t: any) => t.to_location_id)].filter(Boolean))];
      const nameBy: Record<string, string> = {};
      if (siteIds.length) {
        const { data: ls2 } = await sb.from('locations').select('id, name').in('id', siteIds);
        for (const l of ls2 ?? []) nameBy[l.id] = l.name || '';
      }
      // the other open sites of this company, for Send and Request on the phone
      let sites: any[] = [];
      const { data: me } = await sb.from('locations').select('org_id').eq('id', loc).maybeSingle();
      if (me?.org_id) {
        const { data: co } = await sb.from('locations').select('id, name, status').eq('org_id', me.org_id).order('name').limit(60);
        sites = (co ?? []).filter((l: any) => l.id !== loc && (l.status == null || l.status === 'active')).map((l: any) => ({ id: l.id, name: l.name || '' }));
      }
      kitchenTransfers = {
        sites,
        incoming: incoming.map((t: any) => ({ id: t.id, reference: t.reference || null, fromName: nameBy[t.location_id] || '', kind: t.kind || 'transfer', sentAt: t.sent_at || null, sentByName: t.sent_by_name || null, reason: t.reason || null, lines: linesBy[t.id] || [] })),
        requested: (req2.error ? [] : (req2.data ?? [])).map((t: any) => ({ id: t.id, reference: t.reference || null, toName: nameBy[t.to_location_id] || '', requestedByName: t.requested_by_name || null, requestedAt: t.requested_at || null, reason: t.reason || null, note: t.note || null })),
      };
    } catch { kitchenTransfers = { sites: [], incoming: [], requested: [] }; }

    let kitchenClosedown: number | null = null;
    try {
      const { data: cd, error: cdErr } = await sb.rpc('stock_fresh_closedown_list', { p_loc: loc, p_day: today, p_actor: actor });
      if (!cdErr) kitchenClosedown = (Array.isArray(cd) ? cd : ((cd as any)?.rows || [])).length;
    } catch { kitchenClosedown = null; }

    let kitchenOrdersIn: any = null;
    try {
      const { data: kind, error: kindErr } = await sb.from('stock_co_site_settings').select('site_kind').eq('location_id', loc).maybeSingle();
      if (!kindErr && kind?.site_kind === 'central_kitchen') {
        const { data: oi, error: oiErr } = await sb.rpc('stock_kitchen_orders_in', { p_kitchen: loc, p_day: today, p_actor: actor });
        const rows = oiErr ? [] : (Array.isArray(oi) ? oi : ((oi as any)?.rows || []));
        kitchenOrdersIn = { day: today, orders: rows.length, toPick: rows.filter((o: any) => !o.transfer_id).length };
      }
    } catch { kitchenOrdersIn = null; }

    let stockAlerts: any[] = [];
    try {
      const { data: al, error: alErr } = await sb.from('activity_events').select('id, kind, severity, title, body, ref_id, created_at')
        .eq('location_id', loc).like('kind', 'stock_%').is('acked_at', null).gte('created_at', new Date(now.getTime() - 86400000).toISOString())
        .order('created_at', { ascending: false }).limit(20);
      if (!alErr) stockAlerts = (al ?? []).map((a: any) => ({ id: a.id, kind: String(a.kind || '').replace(/^stock_/, ''), severity: a.severity, title: a.title, body: a.body || null, refId: a.ref_id || null, at: a.created_at }));
    } catch { stockAlerts = []; }

    // a central kitchen order arrives as a transfer: the phone opens Transfers for it, never Receive
    const internalSup = new Set(kitchenOrderBy.filter((x: any) => x.internal).map((x: any) => String(x.supplierId)));

    return json({
      ok: true, location_id: loc, venueName: locRow?.name || '', tz, today,   // today = the venue's calendar day (v5.11.64: the Kitchen tab marks orders due today / overdue with it)
      // v5.11.84: 'stock' for a login that reaches the venue only through Stock control 'all': the
      // money, floor, team and ops blocks are null (the Manager app shows nothing for a null block)
      scope: full ? 'all' : 'stock', currency,
      money: full ? money : null,
      floor: full ? floor : null,
      team: full ? { punches, shifts: teamShifts, ratesMinor, pendingTimesheets, pendingTimeOff, breakPolicy } : null,
      kitchen: { items: kitchenItems, deliveries: kitchenDeliveries.map((d: any) => (internalSup.has(String(d.supplierId)) ? { ...d, internal: true } : d)), batches: kitchenBatches, trackedItems, recipes: kitchenRecipes,
        orderBy: kitchenOrderBy, approvals: kitchenApprovals, transfers: kitchenTransfers, closedown: kitchenClosedown, ordersIn: kitchenOrdersIn },
      stock: { alerts: stockAlerts },
      ops: full ? ops : null,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
