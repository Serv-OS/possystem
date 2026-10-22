// channels.mjs: one sale (and its refund or void) through every order channel, written the way each
// writer writes it, then drained by the REAL central drainer (20261018c, stock_outbox_drain). run.mjs
// books the same events on a copy of the database before 0a and on a copy after 0a and asks for
// identical movements: every channel takes stock off exactly as before (map 9.1), refunded food is
// waste, a void of fired food is waste.
//
// Writers (as live): the till, the kiosk and the MPOS phone are bound devices (anonymous sessions)
// that insert closed_checks themselves; pay at table is the till's own check (source
// adyen_pay_at_table); online, QR and catering checks are written by a server function in one
// transaction with their payment proof (the paid order token, or a payment_proofs row bound to
// venue:ref), called by the customer's session; HubRise and ezCater checks are written by their edge
// functions with the service role. Refunds and voids are the till's updates of its own check.

import { lit } from './base.mjs';

// Two server functions shaped like place_public_order and settle_qr_tab (the check and its proof in
// one transaction). Harness only: names outside every stock prefix.
export const CHANNEL_SETUP = `
create or replace function public.harness_public_order(p_loc text, p_ref text, p_id text, p_source text, p_type text, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into closed_checks (id, location_id, items, order_type, source, ref) values (p_id, p_loc, p_items, p_type, p_source, p_ref);
  insert into public_order_tokens (location_id, ref, paid) values (p_loc, p_ref, true);
end $$;
create or replace function public.harness_settle_qr(p_loc text, p_ref text, p_id text, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into closed_checks (id, location_id, items, order_type, source, ref) values (p_id, p_loc, p_items, 'dine-in', 'qr', p_ref);
  insert into payment_proofs (location_id, used_by_ref) values (p_loc, p_loc || ':' || p_ref);
end $$;
revoke all on function public.harness_public_order(text,text,text,text,text,jsonb) from public, anon;
revoke all on function public.harness_settle_qr(text,text,text,jsonb) from public, anon;
grant execute on function public.harness_public_order(text,text,text,text,text,jsonb) to authenticated;
grant execute on function public.harness_settle_qr(text,text,text,jsonb) to authenticated;
`;

const insertCheck = (row) => `insert into closed_checks (id, location_id, items, order_type, source, ref, status, voided, refunds)
  select x.id, x.location_id, coalesce(x.items, '[]'), x.order_type, x.source, x.ref, coalesce(x.status, 'paid'), coalesce(x.voided, false), coalesce(x.refunds, '[]')
    from jsonb_populate_record(null::closed_checks, ${lit(JSON.stringify(row))}::jsonb) x`;

// The events at one venue. menu: { a, b, c } three of the venue's till products (c may be a pack
// line dish); dev: { till, kiosk, mpos } caller keys (a venue with one till uses it for all three).
export function channelEvents(prefix, loc, menu, dev) {
  const line = (itemId, qty, extra = {}) => ({ itemId, qty, ...extra });
  const e = [];
  e.push({ name: 'till', caller: dev.till, sql: insertCheck({ id: `${prefix}-till`, location_id: loc, ref: `${prefix}T1`, source: 'pos', order_type: 'dine-in',
    items: [line(menu.a, 2, { uid: 'u1' }), line(menu.b, 1, { uid: 'u2' }), line(menu.c, 1, { uid: 'u3' })] }) });
  e.push({ name: 'kiosk', caller: dev.kiosk, sql: insertCheck({ id: `${prefix}-kiosk`, location_id: loc, ref: `${prefix}K1`, source: 'kiosk', order_type: 'takeaway',
    items: [line(menu.a, 1), line(menu.b, 2)] }) });
  e.push({ name: 'online', caller: 'customer', sql: `select public.harness_public_order('${loc}', '${prefix}OL1', '${prefix}-online', 'online', 'collection', ${lit(JSON.stringify([line(menu.a, 1), line(menu.c, 1)]))}::jsonb)` });
  e.push({ name: 'qr', caller: 'customer', sql: `select public.harness_settle_qr('${loc}', '${prefix}QR1', '${prefix}-qr', ${lit(JSON.stringify([line(menu.b, 1)]))}::jsonb)` });
  e.push({ name: 'catering', caller: 'customer', sql: `select public.harness_public_order('${loc}', '${prefix}CT1', '${prefix}-catering', 'catering', 'catering', ${lit(JSON.stringify([line(menu.a, 6)]))}::jsonb)` });
  e.push({ name: 'pay at table', caller: dev.till, sql: insertCheck({ id: `${prefix}-pat`, location_id: loc, ref: `${prefix}PT1`, source: 'adyen_pay_at_table', order_type: 'dine-in',
    items: [line(menu.b, 1), line(menu.c, 2)] }) });
  e.push({ name: 'MPOS', caller: dev.mpos, sql: insertCheck({ id: `${prefix}-mpos`, location_id: loc, ref: `${prefix}MP1`, source: 'mpos_adyen_local', order_type: 'dine-in',
    items: [line(menu.a, 1)] }) });
  e.push({ name: 'HubRise', caller: 'service', sql: insertCheck({ id: `${prefix}-hubrise`, location_id: loc, ref: `${prefix}HR1`, source: 'hubrise', order_type: 'delivery',
    items: [line(menu.a, 1), line(menu.b, 1)] }) });
  e.push({ name: 'ezCater', caller: 'service', sql: insertCheck({ id: `${prefix}-ezcater`, location_id: loc, ref: `${prefix}EZ1`, source: 'ezcater', order_type: 'catering',
    items: [line(menu.c, 3)] }) });
  e.push({ name: 'void', caller: dev.till, sql: insertCheck({ id: `${prefix}-void`, location_id: loc, ref: `${prefix}V1`, source: 'pos', order_type: 'dine-in', status: 'voided', voided: true,
    items: [line(menu.a, 1, { fired: true, status: 'voided', voided: true }), line(menu.b, 1, { voided: true })] }) });
  return e;
}

// The refund of part of the till check (applied after its sale is drained): refunded food is waste.
export function refundEvent(prefix, menu, dev) {
  const entry = { id: `${prefix}-ref1`, timestamp: Date.now(), items: [{ uid: 'u1', itemId: menu.a, qty: 2, refundQty: 1 }], isFullRefund: false, amount: 3 };
  return { name: 'refund', caller: dev.till, sql: `update closed_checks set refunds = coalesce(refunds, '[]'::jsonb) || ${lit(JSON.stringify([entry]))}::jsonb, status = 'partial_refund' where id = '${prefix}-till'` };
}

export const drainSql = 'call public.stock_outbox_drain(10, 50, 0.05, true);';

// What the events booked: every movement and waste row whose source is one of the checks, with the
// ids and times taken out (so a copy before 0a and a copy after 0a compare directly).
// (the fixture has no waste of its own, so every waste row at the venue is one these events made)
export function bookedSql(prefix, loc) {
  return `select json_build_object(
    'movements', (select coalesce(json_agg(json_build_object('check', m.source_id, 'item', m.inventory_item_id, 'type', m.movement_type,
                    'qty', m.qty_base, 'value', m.value_delta, 'key', m.idempotency_key, 'source', m.source_type) order by m.idempotency_key), '[]')
                  from stock_movements m where m.source_id like '${prefix}-%'),
    'waste', (select coalesce(json_agg(json_build_object('item', w.inventory_item_id, 'qty', w.qty_base, 'reason', w.reason, 'source', w.source, 'value', w.cost_value)
                    order by w.inventory_item_id, w.reason, w.qty_base), '[]')
               from waste_events w where w.location_id = '${loc}'),
    'outbox', (select coalesce(json_agg(json_build_object('check', o.check_id, 'kind', o.kind, 'writer', o.writer, 'status', o.status, 'flags', o.flags)
                    order by o.check_id, o.kind, o.event_ref), '[]')
                from stock_outbox o where o.check_id like '${prefix}-%'))`;
}

// == The every channel basket (map 9.1, drainer contract 6.2) =========================================
// One check per channel and per case, with its money (subtotal, VAT, service, tip, tenders, check and
// item discounts, loyalty), written by its own writer, in four phases so every follow up runs after
// the sale it belongs to:
//   A  the sales (till cash, card reader, split, send to terminal, bar tab, kiosk, online, QR pay now,
//      QR open tab, catering dated ahead (three), pay at table, MPOS, HubRise (two), ezCater, the
//      refund, void and discount cases, a booking check, a demo id check, a modifier with its own
//      recipe, a pack line dish, a drive thru order, gift card and booking deposit tenders);
//   B  after the first drain: a part refund with a uid, one with no uid, a full refund, a refund that
//      will be refused, a sealed item going back, a money only refund, the HubRise cancel, a part
//      refund and a void of a catering order before its event;
//   C  the processor refuses the refund (the till marks it failed): the undo;
//   D  the catering event time arrives (due_at moved to now, as the clock would).
// Every time is given relative to t0 (ms), so two runs at different moments compare directly.
// run.mjs and drainer.mjs book the basket on a copy of the database before the drainer release and on
// a copy after it, and ask for identical movements, waste, outbox events and net of VAT.

// A server function shaped like place_public_order and settle_qr_tab: the whole check row (any of its
// columns) and its payment proof in one transaction. Harness only: a name outside every stock prefix.
export const BASKET_SETUP = `
create or replace function public.harness_public_check(p_row jsonb, p_proof text)
returns void language plpgsql security definer set search_path = public as $$
declare v_cols text;
begin
  select string_agg(quote_ident(k), ', ') into v_cols from jsonb_object_keys(p_row) k
   where exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'closed_checks' and c.column_name = k);
  execute format('insert into public.closed_checks (%s) select %s from jsonb_populate_record(null::public.closed_checks, $1)', v_cols, v_cols) using p_row;
  if p_proof = 'token' then
    insert into public_order_tokens (location_id, ref, paid) values (p_row ->> 'location_id', p_row ->> 'ref', true);
  else
    insert into payment_proofs (location_id, used_by_ref) values (p_row ->> 'location_id', (p_row ->> 'location_id') || ':' || (p_row ->> 'ref'));
  end if;
end $$;
revoke all on function public.harness_public_check(jsonb, text) from public, anon;
grant execute on function public.harness_public_check(jsonb, text) to authenticated;
`;

// A row written by a device or an edge function: only the columns the row names (the rest keep their
// table defaults, as a PostgREST insert does).
export function insertRow(row) {
  const cols = Object.keys(row).map((k) => `"${k}"`).join(', ');
  return `insert into closed_checks (${cols}) select ${cols} from jsonb_populate_record(null::closed_checks, ${lit(JSON.stringify(row))}::jsonb)`;
}

const r2 = (x) => Math.round(x * 100) / 100;
const iso = (ms) => new Date(ms).toISOString();

// The bill of some lines (VAT inside the price, 20%): subtotal is shelf prices before discounts, as
// every surface writes it.
function bill(lines, { disc = 0, service = 0, tip = 0 } = {}) {
  const sub = r2(lines.filter((l) => !l.voided).reduce((s, l) => s + (l.price || 0) * (l.qty || 1), 0));
  const goods = r2(Math.max(0, sub - disc));
  return { subtotal: sub, total: r2(goods + service + tip), tax_amount: r2((goods * 0.2) / 1.2), service, tip, goods };
}

// The basket at one venue.
//   p        check id prefix ('bp' at Provo, ...); ids are `${p}-<case>`, the demo check `demo-${p}-1`
//   loc      the venue
//   t0       ms; every closed_at and refund time is t0 plus a fixed offset
//   menu     { a, b, c } three till products (c may be a pack line dish), and optionally juice (a
//            sealed item with returns_to_shelf), shot (a modifier with its own recipe), drive (a
//            recipe with drive thru and takeaway lines)
//   price    menu id -> shelf price
//   dev      { till, kiosk, mpos } caller keys
//   presets  { staff, comp, loyalty } discounts.id of the venue's presets (null when it has none)
//   only     null for every case, else the case names to book
export function basketEvents({ p, loc, t0, menu, price, dev, presets = {}, only = null }) {
  let k = 0;
  const at = (offS = null) => iso(t0 + 1000 * (offS == null ? ++k : offS));
  const L = (itemId, qty, extra = {}) => ({ itemId, qty, price: price[itemId] ?? 1, ...extra });
  const base = (name, lines, o = {}) => {
    const b = bill(lines, o.money || {});
    const row = { id: `${p}-${name}`, location_id: loc, ref: `${p.toUpperCase()}${name.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 10)}`,
      closed_at: o.closed_at || at(), items: lines, subtotal: b.subtotal, total: b.total, tax_amount: b.tax_amount, service: b.service, tip: b.tip,
      source: 'pos', order_type: 'dine-in', status: 'paid', voided: false, refunds: [], discounts: [], method: 'card', payment_method: 'card' };
    if (o.tenders !== undefined) row.tenders = typeof o.tenders === 'function' ? o.tenders(b) : o.tenders;
    else row.tenders = [{ method: 'card', amount: r2(b.goods + b.service), tip: b.tip, processor: 'adyen' }];
    const out = { ...row, ...(o.row || {}) };
    if (out.tenders === null) delete out.tenders;
    return out;
  };
  const ev = [];
  const want = (name) => !only || only.includes(name);
  const add = (name, phase, caller, sql) => { if (want(name)) ev.push({ name, phase, caller, sql }); };
  const dev1 = (name, lines, o, caller = dev.till) => add(name, 'A', caller, insertRow(base(name, lines, o)));
  const pub = (name, lines, o, proof) => add(name, 'A', 'customer', `select public.harness_public_check(${lit(JSON.stringify(base(name, lines, o)))}::jsonb, '${proof}')`);
  const svc = (name, lines, o) => add(name, 'A', 'service', insertRow(base(name, lines, o)));
  const { a, b, c } = menu;
  const disc = (d) => ({ manager: { name: 'Duty Manager', at: iso(t0) }, ...d });
  const cash = (bb) => [{ method: 'cash', amount: r2(bb.goods + bb.service), tip: bb.tip }];

  // -- A: the sales -----------------------------------------------------------------------------------
  dev1('cash', [L(a, 2, { uid: 'c1' }), L(b, 1, { uid: 'c2' }), L(c, 1, { uid: 'c3' })], { tenders: cash, row: { method: 'cash', payment_method: 'cash' } });
  dev1('card', [L(a, 1, { uid: 'k1' }), L(b, 1, { uid: 'k2' })], { money: { tip: 0.5 } });
  {
    const lines = [L(a, 2, { uid: 's1' }), L(c, 1, { uid: 's2' })];
    const bb = bill(lines, { service: 0.9 });
    const half = r2((bb.goods + bb.service) / 2);
    dev1('split', lines, { money: { service: 0.9 }, tenders: [{ method: 'cash', amount: half, tip: 0 }, { method: 'card', amount: r2(bb.goods + bb.service - half), tip: 0, processor: 'adyen' }], row: { method: 'split', payment_method: 'split' } });
  }
  dev1('terminal', [L(b, 2, { uid: 't1' })], { row: { source: 'pos_send_to_terminal' } });
  dev1('bartab', [L(a, 1, { uid: 'b1' }), L(b, 1, { uid: 'b2' })], { row: { order_type: 'bar-tab' } });
  dev1('kiosk', [L(a, 1), L(b, 2)], { tenders: null, row: { source: 'kiosk', order_type: 'takeaway', method: 'card', payment_method: 'card-external' } }, dev.kiosk);
  pub('online', [L(a, 1), L(c, 1)], { row: { source: 'online', order_type: 'collection' } }, 'token');
  pub('qrnow', [L(b, 1)], { row: { source: 'qr', order_type: 'takeaway' } }, 'token');
  pub('qrtab', [L(a, 1), L(b, 1)], { row: { source: 'qr', order_type: 'dine-in' } }, 'proof');
  const ahead = (n) => iso(t0 + 2 * 86400000 + 1000 * n);
  pub('cater', [L(a, 6, { uid: 'e1' })], { closed_at: ahead(1), row: { source: 'catering', order_type: 'catering' } }, 'token');
  pub('cater-net', [L(a, 4, { uid: 'n1' }), L(b, 2, { uid: 'n2' })], { closed_at: ahead(2), row: { source: 'catering', order_type: 'catering' } }, 'token');
  pub('cater-void', [L(b, 3, { uid: 'v1' })], { closed_at: ahead(3), row: { source: 'catering', order_type: 'catering' } }, 'token');
  dev1('pat', [L(b, 1), L(c, 2)], { row: { source: 'adyen_pay_at_table' } });
  dev1('mpos', [L(a, 1)], { row: { source: 'mpos_adyen_local' } }, dev.mpos);
  svc('hubrise', [L(a, 1), L(b, 1)], { tenders: (bb) => [{ method: 'deliveroo', amount: bb.goods, tip: 0 }], row: { source: 'hubrise', order_type: 'delivery', method: 'deliveroo', payment_method: 'deliveroo' } });
  svc('hr-cancel', [L(a, 2, { uid: 'h1' })], { tenders: (bb) => [{ method: 'uber_eats', amount: bb.goods, tip: 0 }], row: { source: 'hubrise', order_type: 'delivery' } });
  svc('ezcater', [L(c, 3)], { tenders: (bb) => [{ method: 'ezcater', amount: bb.goods, tip: 0 }], row: { source: 'ezcater', order_type: 'catering' } });
  dev1('ref-uid', [L(a, 2, { uid: 'r1' }), L(b, 1, { uid: 'r2' })], {});
  dev1('ref-nouid', [L(a, 1), L(b, 2)], {});
  dev1('ref-full', [L(a, 1, { uid: 'f1' }), L(c, 1, { uid: 'f2' })], {});
  dev1('ref-refused', [L(b, 2, { uid: 'x1' })], {});
  if (menu.juice) dev1('sealed', [L(menu.juice, 2, { uid: 'j1' }), L(a, 1, { uid: 'j2' })], {});
  const tomb = { status: 'voided', voided: true };
  dev1('void-made', [L(a, 1, { uid: 'vm1', sent: true, fired: true }), L(b, 1, { uid: 'vm2', sent: true, fired: false }), L(c, 1, { uid: 'vm3', fired: true, course: '1' }),
    L(b, 1, { uid: 'vm4', fired: true, course: '0' })], { tenders: [], row: tomb });
  dev1('void-unsent', [L(a, 1, { uid: 'vu1', sent: false })], { tenders: [], row: tomb });
  dev1('booking', [L(a, 1)], { row: { source: 'booking' } });
  if (want('demo')) ev.push({ name: 'demo', phase: 'A', caller: dev.till, sql: insertRow({ ...base('demo', [L(a, 1)], {}), id: `demo-${p}-1`, ref: `${p.toUpperCase()}DEMO` }) });
  {
    const lines = [L(a, 1, { uid: 'sc1' }), L(b, 1, { uid: 'sc2' })];
    const half = r2(bill(lines).subtotal / 2);
    dev1('staff-check', lines, { money: { disc: half }, row: { discounts: [disc({ id: 'd-sc', label: 'Staff meal', type: 'percent', value: 50, amount: half, scope: 'check', presetId: presets.staff ?? null, kind: presets.staff ? 'staff' : null })] } });
  }
  {
    const off = r2((price[a] ?? 1) / 2);
    const lines = [L(a, 1, { uid: 'si1', discount: { id: 'disc-si1', label: 'Staff meal', type: 'percent', value: 50, presetId: presets.staff ?? null, kind: presets.staff ? 'staff' : null } }), L(b, 1, { uid: 'si2' })];
    const bb = bill(lines, { disc: off });
    dev1('staff-item', lines, { money: { disc: off }, tenders: [{ method: 'card', amount: bb.goods, tip: 0, processor: 'adyen' }] });
  }
  {
    const lines = [L(a, 1, { uid: 'sl1' }), L(c, 1, { uid: 'sl2' })];
    const half = r2(bill(lines).subtotal / 2);
    dev1('staff-label', lines, { money: { disc: half }, row: { discounts: [disc({ id: 'd-sl', label: 'Staff meal', type: 'percent', value: 50, amount: half, scope: 'check' })] } });
  }
  dev1('custom', [L(a, 1, { uid: 'cu1' })], { money: { disc: 1 }, row: { discounts: [disc({ id: 'd-cu', label: 'Staff meal', type: 'amount', value: 1, amount: 1, scope: 'check', presetId: null, kind: null })] } });
  {
    const lines = [L(a, 1, { uid: 'co1' }), L(b, 1, { uid: 'co2' })];
    const sub = bill(lines).subtotal;
    dev1('comp', lines, { money: { disc: sub }, tenders: [], row: { method: 'cash', payment_method: 'cash', discounts: [disc({ id: 'd-co', label: 'Manager comp', type: 'percent', value: 100, amount: sub, scope: 'check', presetId: presets.comp ?? null, kind: presets.comp ? 'comp' : null })] } });
  }
  {
    const lines = [L(a, 1, { uid: 'lt1' }), L(b, 1, { uid: 'lt2' })];
    const bb = bill(lines);
    const pts = r2(price[a] ?? 1);
    dev1('loy-tender', lines, { tenders: [{ method: 'loyalty', amount: pts, tip: 0 }, { method: 'card', amount: r2(bb.goods - pts), tip: 0, processor: 'adyen' }],
      row: { loyalty: { member_code: 'TEST-0001', points_earned: 0, balance: 10, is_new_member: false } } });
  }
  dev1('loy-kind', [L(a, 1, { uid: 'lk1' }), L(b, 1, { uid: 'lk2' })], { money: { disc: 2 },
    row: { discounts: [disc({ id: 'd-lk', label: 'Loyalty treat', type: 'amount', value: 2, amount: 2, scope: 'items', itemUids: ['lk1'], presetId: presets.loyalty ?? null, kind: presets.loyalty ? 'loyalty' : null })] } });
  dev1('loy-legacy', [L(a, 1), L(b, 1)], { money: { disc: 1.5 }, tenders: null, row: { method: 'card', payment_method: 'card', discounts: [{ id: 'd-ll', label: 'Reward', source: 'loyalty', amount: 1.5 }] } });
  {
    const lines = [L(a, 1, { uid: 'pr1' }), L(c, 1, { uid: 'pr2' })];
    const bb = bill(lines);
    dev1('promo', lines, { tenders: [{ method: 'promo', amount: 1, tip: 0 }, { method: 'card', amount: r2(bb.goods - 1), tip: 0, processor: 'adyen' }],
      row: { discounts: [{ id: 'd-pr', label: 'Promo', source: 'promo', code: 'SAVE1', amount: 1, scope: 'check' }] } });
  }
  if (menu.shot) {
    dev1('mods', [L(a, 2, { uid: 'm1', mods: [{ itemId: menu.shot, name: 'Extra shot', qty: 1, price: 0.6 }, { id: 'note-hot', name: 'Extra hot', _instruction: true }, { itemId: menu.shot, name: 'Extra shot', removed: true }] })], {});
  }
  dev1('pack', [L(c, 2, { uid: 'pk1' })], {});
  if (menu.drive) dev1('drive', [L(menu.drive, 2, { uid: 'dt1' }), L(a, 1, { uid: 'dt2' })], { row: { order_type: 'drive-thru', source: 'pos' } });
  {
    const lines = [L(a, 2, { uid: 'g1' })];
    const bb = bill(lines);
    dev1('gift', lines, { tenders: [{ method: 'gift_card', amount: 5, tip: 0, gift_card_id: 'gift-test-1' }, { method: 'card', amount: r2(bb.goods - 5), tip: 0, processor: 'adyen' }] });
  }
  {
    const lines = [L(a, 3, { uid: 'bd1' }), L(b, 2, { uid: 'bd2' })];
    const bb = bill(lines);
    dev1('deposit', lines, { tenders: [{ method: 'booking_deposit', amount: 10, tip: 0 }, { method: 'cash', amount: r2(bb.goods - 10), tip: 0 }], row: { method: 'booking+cash', payment_method: 'booking+cash' } });
  }

  // -- B: after the sales are booked ------------------------------------------------------------------
  const refund = (name, caller, entry, status = 'partial_refund') => add(name, 'B', caller,
    `update closed_checks set refunds = coalesce(refunds, '[]'::jsonb) || ${lit(JSON.stringify([entry]))}::jsonb, status = '${status}' where id = '${p}-${name}'`);
  const rt = (min) => t0 + min * 60000;
  refund('ref-uid', dev.till, { id: `${p}-rf1`, timestamp: rt(5), items: [{ uid: 'r1', itemId: a, qty: 2, refundQty: 1 }], isFullRefund: false, amount: price[a] ?? 1 });
  refund('ref-nouid', dev.till, { id: `${p}-rf2`, timestamp: rt(6), items: [{ itemId: b, qty: 2, refundQty: 1 }], isFullRefund: false, amount: price[b] ?? 1 });
  refund('ref-full', dev.till, { id: `${p}-rf3`, timestamp: rt(7), items: [{ uid: 'f1', itemId: a, qty: 1, refundQty: 1 }, { uid: 'f2', itemId: c, qty: 1, refundQty: 1 }], isFullRefund: true, amount: r2((price[a] ?? 1) + (price[c] ?? 1)) }, 'refunded');
  refund('ref-refused', dev.till, { id: `${p}-rf4`, timestamp: rt(8), items: [{ uid: 'x1', itemId: b, qty: 2, refundQty: 1 }], isFullRefund: false, amount: price[b] ?? 1, cardStatus: 'pending' });
  if (menu.juice) refund('sealed', dev.till, { id: `${p}-rf5`, timestamp: rt(9), items: [{ uid: 'j1', itemId: menu.juice, qty: 2, refundQty: 1 }, { uid: 'j2', itemId: a, qty: 1, refundQty: 1 }], isFullRefund: false, amount: 3 });
  refund('cash', dev.till, { id: `${p}-rf7`, timestamp: rt(10), items: [], isFullRefund: false, amount: 1 });
  refund('cater-net', dev.till, { id: `${p}-rf6`, timestamp: rt(30), items: [{ uid: 'n1', itemId: a, qty: 4, refundQty: 1 }], isFullRefund: false, amount: price[a] ?? 1 });
  add('hr-cancel', 'B', 'service', `update closed_checks set voided = true, status = 'voided' where id = '${p}-hr-cancel'`);
  add('cater-void', 'B', dev.till, `update closed_checks set voided = true, status = 'voided' where id = '${p}-cater-void'`);

  // -- C: the processor refuses one refund ------------------------------------------------------------
  add('ref-refused', 'C', dev.till, `update closed_checks set refunds = (select jsonb_agg(case when x ->> 'id' = '${p}-rf4' then x || '{"cardStatus": "failed"}'::jsonb else x end order by o)
     from jsonb_array_elements(refunds) with ordinality as t(x, o)) where id = '${p}-ref-refused'`);
  return ev;
}

// Phase D: the catering event time arrives (the clock, as the drainer sees it).
export const basketTimeArrives = (p) => `update stock_outbox set due_at = now() where status = 'pending' and check_id like '${p}-%'`;

// What the basket booked, in a form two runs compare directly: every movement (times as seconds after
// t0; undo and late guard rows, and the rows of a void, are dated when they were booked, so 'now'),
// every waste row the movements made, every outbox event.
export function basketBookedSql(p, t0) {
  const T0 = `to_timestamp(${t0} / 1000.0)`;
  return `select json_build_object(
    'movements', (select coalesce(json_agg(json_build_object('check', m.source_id, 'item', m.inventory_item_id, 'type', m.movement_type, 'qty', m.qty_base,
                    'value', m.value_delta, 'cost', m.unit_cost, 'key', m.idempotency_key, 'source', m.source_type, 'area', m.area_id, 'notes', m.notes,
                    'occ', case when split_part(m.idempotency_key, ':', 1) in ('undo', 'late') or split_part(m.idempotency_key, ':', 3) = 'void' then 'now'
                                else round(extract(epoch from m.occurred_at - ${T0}))::text end)
                    order by m.idempotency_key), '[]')
                  from stock_movements m where left(m.source_id, ${p.length + 1}) = '${p}-' or left(m.source_id, ${p.length + 6}) = 'demo-${p}-'),
    'waste', (select coalesce(json_agg(json_build_object('id', w.id, 'item', w.inventory_item_id, 'qty', w.qty_base, 'unit', w.unit, 'reason', w.reason,
                    'source', w.source, 'value', w.cost_value, 'note', w.note, 'name', w.item_name) order by w.id), '[]')
               from waste_events w where w.id in (select md5(m.idempotency_key)::uuid from stock_movements m
                                                   where left(m.source_id, ${p.length + 1}) = '${p}-' and m.movement_type = 'WASTE')),
    'outbox', (select coalesce(json_agg(json_build_object('check', o.check_id, 'kind', o.kind, 'ref', o.event_ref, 'writer', o.writer, 'status', o.status,
                    'flags', o.flags, 'posted', o.posted, 'attempts', o.attempts) order by o.check_id, o.kind, o.event_ref), '[]')
                from stock_outbox o where left(o.check_id, ${p.length + 1}) = '${p}-' or left(o.check_id, ${p.length + 6}) = 'demo-${p}-'))`;
}

// The basket's checks as stored (for net of VAT: the JS checkSalesParts and the SQL port).
export const basketChecksSql = (p) => `select coalesce(json_agg(to_jsonb(c) order by c.id), '[]') from closed_checks c
  where left(c.id, ${p.length + 1}) = '${p}-' or left(c.id, ${p.length + 6}) = 'demo-${p}-'`;
