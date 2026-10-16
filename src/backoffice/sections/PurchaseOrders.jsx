/**
 * PurchaseOrders: create, send and receive POs (Purchasing > Purchase orders).
 * Slice 7. Receiving posts PURCHASE_RECEIPT to the stock ledger + updates cost.
 *
 * v5.11.67 (16 Oct 2026). Peter: "in this screen it should show all the items from the supplier
 * with filters and a search. What if we have 1,000 items from that supplier?" A new or draft
 * order now lists EVERY item the supplier sells as a table (name, codes, pack, price, on hand,
 * on order, par, suggested packs, a quantity box, the line value), with a search box and
 * filters. Typing a quantity is adding the line. The rules are pure (lib/stock/poItemList.js,
 * tested over 1,500 items); the readers page past the API's 1,000 row cap; the table renders
 * only the rows in view, so a thousand items never means a thousand mounted inputs. The
 * expected date of a new order defaults to the supplier's next delivery day on the venue's
 * calendar, the same rule the Order pad uses. Sent, received and cancelled orders look and
 * behave as before.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useStore } from '../../store';
import { getActiveLocationSync, getLocationId, supabase } from '../../lib/supabase';
import { getLocationConfig, buildScheduleCtx } from '../../lib/locationTime';
import { money, currencySymbol } from '../../lib/currency';
import { displayInUnits } from '../../lib/stock/uom';
import { fetchSuppliers, fetchInventoryItems, fetchUsageRates, fetchUsageByWeekday } from '../../lib/stock/data';
import { fetchParLevels } from '../../lib/stock/counts';
import { outstandingOnOrder } from '../../lib/stock/onOrder';
import { nextDeliveryYmd } from '../../lib/stock/purchasingRules';
import { buildPoItemRows, filterSortPoItems, pinnedLines, categoriesOf, areasOf, countLine, applyQty, dropEmptyLines, unlistedLineCheck, rowLineValue, relineForSupplier } from '../../lib/stock/poItemList';
import { fetchPurchaseOrders, savePurchaseOrder, setPOStatus, setPOExpectedDate, receivePurchaseOrder, attachInvoiceToPO, fetchPOInvoices, fnErrorText } from '../../lib/stock/purchasing';
import { areasReady, fetchAreas } from '../../lib/stock/areas';
import { reportSave } from '../../lib/saveHealth';
import { fmtYmd } from '../../lib/venueDate';
import NumberField from '../../components/NumberField';
import { PageHeader, PrimaryBtn, Tag, SearchField } from './reports/reportKit';

const field = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const lbl = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 };
const tick = { fontSize: 12, color: 'var(--t3)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap' };
// PO status to reportKit Tag tone. Labels still carry the exact status word.
const STATUS_TONE = { DRAFT: 'neutral', SENT: 'neutral', PARTIAL: 'warn', RECEIVED: 'good', CANCELLED: 'bad' };
const NO_LINES_TEXT = "No lines yet. Add quantities to the supplier's items below.";

export default function PurchaseOrders() {
  const showToast = useStore(s => s.showToast);
  const taxRates = useStore(s => s.taxRates) || [];
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [pos, setPos] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [items, setItems] = useState([]);
  const [pars, setPars] = useState({});
  const [usage, setUsage] = useState({});
  const [weekday, setWeekday] = useState(null);
  const [onOrder, setOnOrder] = useState({});
  // The venue's timezone: the expected date and the day of week the suggestion walks from are the
  // venue's, never the laptop's (project invariant). null = Europe/London until resolved.
  const [venueTz, setVenueTz] = useState(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState(null);
  const [selId, setSelId] = useState(null);
  const [busy, setBusy] = useState(false);
  // v5.5.920: the list is a WORK QUEUE, not an archive. Default view shows only orders that
  // still need something done (awaiting send or delivery); received/cancelled live in their
  // own tabs. This is the owner's "one constant list" complaint fixed at the root.
  const [tab, setTab] = useState('open');           // 'open' | 'done' | 'all'
  const [q, setQ] = useState('');
  // v5.5.921: the "accept into stock" panel: per-line received qty + delivery-note price.
  // null = closed; otherwise { [lineId]: { qtyPacks, unitPrice } } seeded from the order.
  const [receiving, setReceiving] = useState(null);
  const [poInvoices, setPoInvoices] = useState([]);
  // 16 Oct 2026 (stock areas): the venue's areas and where this delivery lands. '' = the
  // database decides (the receiving area, else each item's own area). Empty before the migration.
  const [areas, setAreas] = useState([]);
  const [landArea, setLandArea] = useState('');

  const reload = useCallback(async (keepId) => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const cfg = await getLocationConfig(loc).catch(() => null);
    setVenueTz(cfg?.timezone || null);
    // 16 Oct 2026 (stock areas): the venue's areas ride along, so the receive panel can offer
    // a 'Lands in' dropdown. Before the migration areasOn is false and the list stays empty.
    const areasOn = await areasReady(loc);
    const [{ data: p }, { data: s }, { data: it }, { data: par }, { data: rate }, { data: wk }, areaRes] = await Promise.all([
      fetchPurchaseOrders(loc), fetchSuppliers(loc), fetchInventoryItems(loc), fetchParLevels(loc), fetchUsageRates(28, loc), fetchUsageByWeekday(8, loc),
      areasOn ? fetchAreas(loc) : Promise.resolve({ data: [] }),
    ]);
    // On order the way the Order pad counts it: SENT and PARTIAL orders, in the item's base unit.
    const byId = Object.fromEntries((it || []).map(i => [i.id, i]));
    const { byItem } = outstandingOnOrder(p || [], byId, { todayYmd: buildScheduleCtx(cfg?.timezone).ymd });
    setPos(p || []); setSuppliers(s || []); setItems(it || []); setPars(par || {}); setUsage(rate || {}); setWeekday(wk); setOnOrder(byItem); setAreas(areaRes.data || []); setLoading(false);
    if (keepId) { const f = (p || []).find(x => x.id === keepId); if (f) { setDraft(structuredClone(f)); setSelId(keepId); } }
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const supById = useMemo(() => { const m = {}; suppliers.forEach(s => { m[s.id] = s; }); return m; }, [suppliers]);
  const supName = useCallback((id) => supById[id]?.name || 'no supplier', [supById]);
  const OPEN_STATUSES = ['DRAFT', 'SENT', 'PARTIAL'];
  const visible = useMemo(() => pos.filter(p => {
    if (tab === 'open' && !OPEN_STATUSES.includes(p.status)) return false;
    if (tab === 'done' && p.status !== 'RECEIVED') return false;
    const needle = q.trim().toLowerCase();
    if (needle && !(`${supName(p.supplierId)} ${p.reference || ''}`.toLowerCase().includes(needle))) return false;
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [pos, tab, q, supName]);
  const itemName = useCallback((id) => items.find(i => i.id === id)?.name || '', [items]);
  const ratesById = useMemo(() => { const m = {}; taxRates.forEach(r => { m[r.id] = r; }); return m; }, [taxRates]);
  const lineRateDec = useCallback((l) => Number(ratesById[l.purchaseTaxRateId]?.rate || 0), [ratesById]);

  // ── the supplier's item table (new and draft orders): search and filter state ──────────────
  const [itemQ, setItemQ] = useState('');
  const [cat, setCat] = useState('');
  const [area, setArea] = useState('');
  const [belowPar, setBelowPar] = useState(false);
  const [onOrderOnly, setOnOrderOnly] = useState(false);
  const [onThisOrder, setOnThisOrder] = useState(false);
  const [showAllItems, setShowAllItems] = useState(false);
  // An item the supplier does not list, waiting for its pack and price before it joins the order.
  const [unlisted, setUnlisted] = useState(null);
  // Bumped when the user moves to another order or changes supplier: the table remounts at the
  // top with the "lines first" order re-pinned. NOT an effect on draft.id: the first Save draft
  // gives a new order its id, and that used to wipe the search, the filters and the scroll.
  const [listGen, setListGen] = useState(0);
  const resetItemFilters = () => { setItemQ(''); setCat(''); setArea(''); setBelowPar(false); setOnOrderOnly(false); setOnThisOrder(false); setShowAllItems(false); setUnlisted(null); setListGen(g => g + 1); };

  // The day a new order should arrive: the supplier's next delivery day from the venue's today
  // (tomorrow for a supplier with no schedule). One rule with the Order pad (nextDeliveryYmd).
  const defaultExpected = useCallback((supplierId) => (supplierId ? nextDeliveryYmd(supById[supplierId]?.deliveryDays, buildScheduleCtx(venueTz).ymd) || '' : ''), [supById, venueTz]);
  const newPO = () => {
    const supplierId = suppliers[0]?.id || '';
    resetItemFilters();
    setDraft({ supplierId, reference: '', expectedDate: defaultExpected(supplierId), notes: '', status: 'DRAFT', lines: [] });
    setSelId(null);
  };
  const openOrder = (p) => { resetItemFilters(); setDraft(structuredClone(p)); setSelId(p.id); };

  const upd = (k, v) => setDraft(d => ({ ...d, [k]: v }));
  // Choosing the supplier on a NEW order sets the expected date to that supplier's next delivery
  // day (still editable). A saved draft keeps the date it has. Lines already typed are rebuilt
  // from the new supplier's pack and price (relineForSupplier): a line's pack, price and
  // supplier_product_id belong to the supplier it was typed for, and the old ones were being
  // emailed to the new supplier as 'pack typed' rows. Items the new supplier has no pack for
  // come off, and the toast names them.
  const changeSupplier = (supplierId) => {
    resetItemFilters();
    const { lines, dropped } = relineForSupplier(draft?.lines, items, supplierId);
    if (dropped.length) showToast?.(supplierId ? `${dropped.join(', ')}: ${supName(supplierId)} has no pack on file, taken off the order.` : 'Lines cleared: a line\'s pack and price belong to the supplier.', 'info');
    setDraft(d => ({ ...d, supplierId, lines, ...(d.id ? {} : { expectedDate: defaultExpected(supplierId) }) }));
  };
  const updLine = (i, k, v) => setDraft(d => ({ ...d, lines: d.lines.map((l, j) => j === i ? { ...l, [k]: v } : l) }));
  const rmLine = (i) => setDraft(d => ({ ...d, lines: d.lines.filter((_, j) => j !== i) }));
  // v5.5.923: a RECEIVED order's money is what was ACCEPTED, not what was ordered. The header
  // subtotal is recomputed to accepted lines at receive time; without this the detail pane
  // showed ordered x delivery-price (order 10, receive 6: list 12, pane 20, same order,
  // two numbers). The shorted remainder's value lives on its balance order.
  const qtyFor = useCallback((l) => draft?.status === 'RECEIVED' ? (Number(l.qtyReceived) || 0) : (Number(l.qtyPacks) || 0), [draft?.status]);
  const total = useMemo(() => (draft?.lines || []).reduce((s, l) => s + qtyFor(l) * (Number(l.unitPrice) || 0), 0), [draft, qtyFor]);
  const vatTotal = useMemo(() => (draft?.lines || []).reduce((s, l) => s + qtyFor(l) * (Number(l.unitPrice) || 0) * lineRateDec(l), 0), [draft, qtyFor, lineRateDec]);

  const save = async (status) => {
    if (!draft.supplierId) { showToast?.('Pick a supplier', 'error'); return; }
    setBusy(true);
    // A box left at 0 is not an order line.
    const lines = dropEmptyLines(draft.lines);
    const { data, error } = await savePurchaseOrder({ ...draft, status: status || draft.status }, lines, locId);
    setBusy(false);
    reportSave('purchase order', error);
    if (error) { showToast?.(error.message, 'error'); return; }
    showToast?.(status === 'SENT' ? 'Marked sent' : 'Saved', 'success');
    await reload(data?.id || selId);
    return data;
  };
  // v5.5.921: actually SEND the order. Saves first (so what the supplier gets is what is on
  // screen), then po-send emails the order table and flips the status server-side only after
  // the email succeeded, so SENT finally means sent. Falls back to mark-sent when the supplier
  // has no email on file.
  const supplierEmail = supById[draft?.supplierId]?.email || null;
  const sendToSupplier = async () => {
    if (!dropEmptyLines(draft?.lines).length) { showToast?.('Nothing to send: every quantity is 0', 'error'); return; }
    const saved = await save('DRAFT');
    if (!saved?.id) return;
    setBusy(true);
    const { data: res, error } = await supabase.functions.invoke('po-send', {
      body: { po_id: saved.id, location_id: locId },
    });
    setBusy(false);
    if (error || res?.error) {
      // v5.11.64: the order is real even when the email is not. Keep it on the books as SENT,
      // exactly as the Order pad does, so it counts as on order and the Resend button appears;
      // and say what went wrong in plain words, not the SDK's "non-2xx status code". A supplier
      // with no email lands here too (po-send answers 422, so res is null and the old
      // res?.error check could never match); cleanFnError names that case in plain words.
      const reason = await fnErrorText(res, error, 'the email could not be sent');
      await setPOStatus(saved.id, 'SENT', locId);
      await reload(saved.id);
      showToast?.(`Order saved and on the books, but the email did not send: ${reason}. Use Resend to supplier once the address is fixed.`, 'error');
      return;
    }
    showToast?.(`Order emailed to ${res?.to}`, 'success');
    await reload(saved.id);
  };
  // Expected date on an order already sent: a one column update (never the full save, which
  // would reinsert the lines and break receiving). Draft orders keep the normal save path.
  const changeExpectedDate = async (value) => {
    upd('expectedDate', value);
    if (!draft?.id || editable) return;
    const { error } = await setPOExpectedDate(draft.id, value || null, locId);
    reportSave('purchase order date', error);
    if (error) { showToast?.('Expected date NOT saved', 'error'); return; }
    showToast?.(value ? `Expected date updated to ${fmtYmd(value, { weekday: true })}` : 'Expected date cleared', 'success');
    await reload(draft.id);
  };
  const openReceive = () => {
    // Seed with what was ordered: staff correct only what differs, which for a clean
    // delivery is nothing. Prices pre-filled from the PO so variance is one edit away.
    const seed = {};
    (draft.lines || []).forEach(l => { seed[l.id] = { qtyPacks: String(l.qtyPacks), unitPrice: String(l.unitPrice) }; });
    setLandArea(areas.find(a => a.isReceiving)?.id || '');
    setReceiving(seed);
  };
  const acceptIntoStock = async () => {
    if (!draft?.id || !receiving) return;
    const receipts = (draft.lines || []).map(l => ({
      lineId: l.id,
      qtyPacks: Number(receiving[l.id]?.qtyPacks ?? l.qtyPacks) || 0,
      unitPrice: receiving[l.id]?.unitPrice ?? l.unitPrice,
    }));
    setBusy(true);
    const { error, data } = await receivePurchaseOrder(draft.id, locId, receipts, { areaId: landArea || null });
    setBusy(false);
    reportSave('goods receipt', error);
    if (error) { showToast?.(error.message, 'error'); return; }
    setReceiving(null);
    showToast?.(data?.shortedCount
      ? `Received. ${data.shortedCount} shorted line${data.shortedCount === 1 ? '' : 's'} moved to a balance order`
      : 'Received into stock', 'success');
    await reload(draft.id);
  };
  const attachInvoice = async (file) => {
    if (!draft?.id || !file) return;
    setBusy(true);
    const { error } = await attachInvoiceToPO(draft.id, file, { supplierId: draft.supplierId }, locId);
    setBusy(false);
    reportSave('purchase invoice', error);
    if (error) { showToast?.(error.message, 'error'); return; }
    showToast?.('Invoice attached', 'success');
    const { data } = await fetchPOInvoices(draft.id, locId);
    setPoInvoices(data);
  };
  useEffect(() => {
    setReceiving(null);
    if (draft?.id) fetchPOInvoices(draft.id, locId).then(({ data }) => setPoInvoices(data)); else setPoInvoices([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id]);
  const cancel = async () => {
    if (!draft?.id) return;
    const { error } = await setPOStatus(draft.id, 'CANCELLED', locId);
    reportSave('purchase order status', error);
    // A cancel that didn't land leaves a live order the supplier will still deliver.
    if (error) { showToast?.('Order NOT cancelled. It is still open', 'error'); return; }
    showToast?.('Order cancelled', 'info');
    await reload(draft.id);
  };

  const editable = !draft?.id || draft.status === 'DRAFT';
  // The one field a sent order still needs: when it is due. Received and cancelled stay read only.
  const dateEditable = editable || ['SENT', 'PARTIAL'].includes(draft?.status);

  const todayDow = buildScheduleCtx(venueTz).isoDay % 7;
  const rows = useMemo(() => (draft && editable)
    ? buildPoItemRows({ items, supplierId: draft.supplierId, lines: draft.lines || [], pars, onOrder, usage, weekday, deliveryDays: supById[draft.supplierId]?.deliveryDays, todayDow })
    : [], [draft, editable, items, pars, onOrder, usage, weekday, supById, todayDow]);
  // The "lines first" order is pinned when the order is opened or a filter changes, not on every
  // keystroke: a row whose quantity is being typed must not jump to the top under the cursor.
  const filterKey = `${listGen}|${draft?.supplierId || ''}|${itemQ}|${cat}|${area}|${belowPar}|${onOrderOnly}|${onThisOrder}`;
  const pinned = useMemo(() => pinnedLines(draft?.lines), [filterKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => filterSortPoItems(rows, { q: itemQ, category: cat, area, belowPar, onOrderOnly, onThisOrder, pinned }), [rows, itemQ, cat, area, belowPar, onOrderOnly, onThisOrder, pinned]);
  const cats = useMemo(() => categoriesOf(rows), [rows]);
  const areaChoices = useMemo(() => areasOf(rows), [rows]);
  const setRowQty = (row, v) => setDraft(d => ({ ...d, lines: applyQty(d.lines, row, v) }));
  // A box left at 0 when the cursor leaves it: the line goes (a 0 line is no line).
  const blurRowQty = (row) => setDraft(d => {
    const l = d.lines.find(x => x.inventoryItemId === row.it?.id);
    return (l && String(l.qtyPacks).trim() !== '' && !(Number(l.qtyPacks) > 0)) ? { ...d, lines: applyQty(d.lines, row, '') } : d;
  });
  const setRowPrice = (row, v) => setDraft(d => ({ ...d, lines: d.lines.map(l => l.inventoryItemId === row.it?.id ? { ...l, unitPrice: v } : l) }));

  // The "Show all items" picker: an item the supplier lists simply joins at 1 pack; one the
  // supplier does not list needs its pack and price typed first (the facts pickSupplierProduct
  // reads from supplier_products for a listed item), so it opens the small form below.
  const pickAnyItem = (it) => {
    const row = rows.find(r => !r.extra && r.key === it.id);
    if (row) { if (!row.line) setRowQty(row, '1'); return; }
    if ((draft.lines || []).some(l => l.inventoryItemId === it.id)) { showToast?.(`${it.name} is already on this order.`, 'info'); return; }
    setUnlisted({ it, packQty: '1', innerQty: '1', innerUnit: it.baseUnit || 'each', unitPrice: '' });
  };
  const addUnlisted = () => {
    if (!unlisted) return;
    const it = unlisted.it;
    // The unit must convert to the item's unit now: receiving refuses the whole order otherwise,
    // after it has been sent and its lines can no longer be edited.
    const chk = unlistedLineCheck(unlisted, { baseUnit: it.baseUnit, conversions: it.conversions || [], itemName: it.name });
    if (!chk.ok) { showToast?.(chk.reason, 'error'); return; }
    setDraft(d => ({ ...d, lines: [...d.lines, {
      inventoryItemId: it.id, description: it.name, qtyPacks: '1',
      packQty: Number(unlisted.packQty), innerQty: Number(unlisted.innerQty), innerUnit: String(unlisted.innerUnit).trim(),
      unitPrice: Number(unlisted.unitPrice), qtyReceived: 0, supplierProductId: null,
      purchaseTaxRateId: it.purchaseTaxRateId || null,
    }] }));
    setUnlisted(null);
    showToast?.(`${it.name} added with the pack and price you typed. ${supName(draft.supplierId)} has no pack on file for it: add one on the item's Suppliers tab to reuse it next time.`, 'info');
  };
  const lineCount = (draft?.lines || []).length;
  // Lines with a quantity above 0: what save() writes. The send buttons follow this, not the
  // raw count, so an order whose only lines sit at 0 cannot be marked sent or emailed empty.
  const liveLines = useMemo(() => dropEmptyLines(draft?.lines).length, [draft]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--bg)' }}>
      <div style={{ padding: '22px 26px 0', flexShrink: 0 }}>
        <PageHeader eyebrow="PURCHASING" title="Orders" subtitle="Orders sent to suppliers, waiting to be accepted into stock." />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', flex: 1, minHeight: 0, borderTop: '1px solid var(--bdr)', background: 'var(--bg)' }}>
      <aside style={{ borderRight: '1px solid var(--bdr)', background: 'var(--bg1)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 14 }}>
          <button onClick={newPO} style={{ width: '100%', padding: '9px 0', borderRadius: 7, background: 'var(--acc)', color: '#0b0c10', border: 0, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>+ New purchase order</button>
        </div>
        <div style={{ display: 'flex', gap: 6, padding: '0 14px 10px' }}>
          {[['open', 'Awaiting'], ['done', 'Received'], ['all', 'All']].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{ flex: 1, padding: '6px 0', borderRadius: 7, fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', border: '1px solid ' + (tab === id ? 'var(--acc)' : 'var(--bdr)'), background: tab === id ? 'var(--bg2)' : 'transparent', color: tab === id ? 'var(--t1)' : 'var(--t3)' }}>{label}</button>
          ))}
        </div>
        <div style={{ padding: '0 14px 10px' }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search supplier / ref…" style={field} />
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading && <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>}
          {!loading && visible.length === 0 && <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>{pos.length === 0 ? 'No orders yet.' : 'No orders in this view.'}</div>}
          {visible.map(p => (
            <div key={p.id} onClick={() => openOrder(p)} style={{ padding: '11px 16px', cursor: 'pointer', borderLeft: '3px solid ' + (p.id === selId ? 'var(--acc)' : 'transparent'), background: p.id === selId ? 'var(--bg2)' : 'transparent' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, color: 'var(--t1)' }}>{supName(p.supplierId)}</span>
                <Tag label={p.status} tone={STATUS_TONE[p.status]} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>{p.reference || ''} · {p.lines.length} line{p.lines.length === 1 ? '' : 's'} · {money(p.subtotal || 0)}{p.expectedDate ? ` · due ${fmtYmd(p.expectedDate, { weekday: true, year: false })}` : ''}</div>
            </div>
          ))}
        </div>
      </aside>

      <main style={{ overflowY: 'auto', minHeight: 0 }}>
        {!draft && <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--t3)' }}>Select an order, or create one.</div>}
        {draft && (
          <div style={{ padding: '22px 26px', maxWidth: editable ? 1180 : 900 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16, flexWrap: 'wrap' }}>
              <h2 style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-.3px', margin: 0, color: 'var(--t1)', flex: 1 }}>{draft.id ? `Order · ${supName(draft.supplierId)}` : 'New purchase order'}</h2>
              {draft.id && <Tag label={draft.status} tone={STATUS_TONE[draft.status]} />}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 14, marginBottom: 16 }}>
              <div><label style={lbl}>Supplier</label>
                <select disabled={!editable} value={draft.supplierId} onChange={e => changeSupplier(e.target.value)} style={field}>
                  <option value="">choose a supplier</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div><label style={lbl}>Reference</label><input disabled={!editable} value={draft.reference || ''} onChange={e => upd('reference', e.target.value)} style={field} /></div>
              <div><label style={lbl}>Expected date</label>
                <input disabled={!dateEditable} type="date" value={draft.expectedDate || ''} onChange={e => changeExpectedDate(e.target.value)} style={field} title={dateEditable && !editable ? 'Saved as soon as you pick a date' : (editable ? "The supplier's next delivery day. Change it if you need another day." : undefined)} />
                {editable && draft.expectedDate && <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>{fmtYmd(draft.expectedDate, { weekday: true })}</div>}
              </div>
            </div>

            {editable ? (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
                  <label style={{ ...lbl, marginBottom: 0 }}>{draft.supplierId ? `${supName(draft.supplierId)}'s items` : 'Items'}</label>
                  <span style={{ fontSize: 12, color: 'var(--t3)' }}>
                    {lineCount === 0 ? NO_LINES_TEXT : `${lineCount} line${lineCount === 1 ? '' : 's'} on this order. Type a quantity to add an item; clear the box to take it off.`}
                  </span>
                </div>
                {draft.supplierId ? (
                  <>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
                      <SearchField value={itemQ} onChange={setItemQ} placeholder="Search name, SKU or supplier code…" width={260} />
                      {cats.length > 0 && (
                        <select value={cat} onChange={e => setCat(e.target.value)} style={{ ...field, width: 'auto', minWidth: 140 }} aria-label="Category">
                          <option value="">All categories</option>
                          {cats.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      )}
                      {areaChoices.length > 0 && (
                        <select value={area} onChange={e => setArea(e.target.value)} style={{ ...field, width: 'auto', minWidth: 140 }} aria-label="Storage area">
                          <option value="">All areas</option>
                          {areaChoices.map(a => <option key={a} value={a}>{a}</option>)}
                        </select>
                      )}
                      <label style={tick}><input type="checkbox" checked={belowPar} onChange={e => setBelowPar(e.target.checked)} />Below par only</label>
                      <label style={tick}><input type="checkbox" checked={onOrderOnly} onChange={e => setOnOrderOnly(e.target.checked)} />On order only</label>
                      <label style={tick}><input type="checkbox" checked={onThisOrder} onChange={e => setOnThisOrder(e.target.checked)} />On this order only</label>
                      <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--t3)', fontVariantNumeric: 'tabular-nums' }}>{countLine(shown.length, rows.length)}</span>
                    </div>
                    {rows.length === 0 && (
                      <div style={{ fontSize: 12.5, color: 'var(--t3)', padding: '14px 0' }}>
                        {supName(draft.supplierId)} has no items on file. Add this supplier's pack on each item's Suppliers tab (Stock items), or tick "Show all items" below to add an item with its pack and price typed in.
                      </div>
                    )}
                    {rows.length > 0 && (
                      <SupplierItemTable key={filterKey} rows={shown} onQty={setRowQty} onQtyBlur={blurRowQty} onPrice={setRowPrice} lineRateDec={lineRateDec} />
                    )}
                  </>
                ) : (
                  <div style={{ fontSize: 12.5, color: 'var(--t3)', padding: '14px 0' }}>Choose a supplier to see their items.</div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
                  {draft.supplierId && (
                    <label style={tick}>
                      <input type="checkbox" checked={showAllItems} onChange={e => { setShowAllItems(e.target.checked); if (!e.target.checked) setUnlisted(null); }} />
                      Show all items, not just {supName(draft.supplierId)}'s
                    </label>
                  )}
                  {showAllItems && draft.supplierId && <ItemPicker items={items} onPick={pickAnyItem} />}
                </div>
                {unlisted && (
                  <div style={{ marginTop: 10, border: '1px solid var(--bdr)', borderRadius: 10, padding: 14, background: 'var(--bg1)', maxWidth: 720 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', marginBottom: 4 }}>{unlisted.it.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 10 }}>
                      {supName(draft.supplierId)} has no pack on file for this item, so there is no pack size or price to order it by. Enter the pack and the price of one pack (ex VAT) and it joins the order.
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, color: 'var(--t3)' }}>Pack of</span>
                      <NumberField width={72} value={unlisted.packQty} onChange={v => setUnlisted(u => ({ ...u, packQty: v }))} title="inner units in a pack" />
                      <span style={{ fontSize: 12, color: 'var(--t3)' }}>x</span>
                      <NumberField width={88} value={unlisted.innerQty} onChange={v => setUnlisted(u => ({ ...u, innerQty: v }))} title="how much each inner unit holds" />
                      <input value={unlisted.innerUnit} onChange={e => setUnlisted(u => ({ ...u, innerUnit: e.target.value }))} placeholder={unlisted.it.baseUnit || 'each'} style={{ ...field, width: 80 }} title="the unit (each, kg, l)" />
                      <span style={{ fontSize: 12, color: 'var(--t3)' }}>at {currencySymbol()}</span>
                      <NumberField width={112} unit="a pack" value={unlisted.unitPrice} onChange={v => setUnlisted(u => ({ ...u, unitPrice: v }))} title="price of one pack, ex VAT" />
                      <PrimaryBtn onClick={addUnlisted}>Add to order</PrimaryBtn>
                      <button onClick={() => setUnlisted(null)} style={{ padding: '9px 14px', borderRadius: 8, background: 'transparent', border: '1px solid var(--bdr)', color: 'var(--t3)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <label style={lbl}>Lines</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                  {draft.lines.length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>No lines on this order.</div>}
                  {draft.lines.map((l, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 7, padding: '8px 10px' }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{itemName(l.inventoryItemId) || l.description}</span>
                      {/* v5.11.65: the shared NumberField (wide enough for 125.50, unit inside, no spinner); the pack reads as words, not a formula */}
                      <NumberField disabled width={104} unit="packs" value={l.qtyPacks} onChange={v => updLine(i, 'qtyPacks', v)} title="packs ordered" />
                      <span style={{ fontSize: 11, color: 'var(--t3)', whiteSpace: 'nowrap' }}>of {l.packQty} x {l.innerQty} {l.innerUnit} at {currencySymbol()}</span>
                      <NumberField disabled width={112} unit="a pack" value={l.unitPrice} onChange={v => updLine(i, 'unitPrice', v)} title="price per pack, ex VAT" />
                      {lineRateDec(l) > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t4)' }} title="purchase VAT">+{Math.round(lineRateDec(l) * 100)}%</span>}
                      {draft.status === 'RECEIVED' && Number(l.qtyReceived) !== Number(l.qtyPacks) && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--org, #f59e0b)' }} title="short: the remainder is on the balance order">rec {Number(l.qtyReceived) || 0}</span>}
                      <span style={{ width: 70, textAlign: 'right', fontSize: 13, color: 'var(--t2)' }}>{money(qtyFor(l) * (Number(l.unitPrice) || 0))}</span>
                      {editable && <button onClick={() => rmLine(i)} style={{ background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer', fontSize: 16 }}>×</button>}
                    </div>
                  ))}
                </div>
              </>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 14, color: 'var(--t1)', marginRight: 'auto' }}>
                Subtotal (ex VAT): <b>{money(total)}</b>
                {vatTotal > 0.005 && <span style={{ color: 'var(--t3)' }}> · VAT {money(vatTotal)} · <b style={{ color: 'var(--t1)' }}>pay {money(total + vatTotal)}</b></span>}
              </div>
              {editable && <button onClick={() => save('DRAFT')} disabled={busy} style={{ padding: '9px 16px', borderRadius: 8, background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t1)', fontSize: 13, cursor: 'pointer' }}>Save draft</button>}
              {editable && supplierEmail && <PrimaryBtn onClick={sendToSupplier} disabled={busy || !liveLines}>Send to supplier</PrimaryBtn>}
              {editable && <button onClick={() => save('SENT')} disabled={busy || !liveLines} style={{ padding: '9px 16px', borderRadius: 8, background: supplierEmail ? 'var(--bg2)' : 'var(--acc)', border: supplierEmail ? '1px solid var(--bdr)' : 0, color: supplierEmail ? 'var(--t1)' : '#0b0c10', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: busy || !liveLines ? 0.6 : 1 }} title={supplierEmail ? 'Mark sent without emailing' : 'No supplier email on file: marks the order sent without emailing'}>Mark sent</button>}
              {draft.id && (draft.status === 'SENT' || draft.status === 'PARTIAL') && !receiving && (
                <button onClick={async () => {
                  setBusy(true);
                  const { data: res, error: e } = await supabase.functions.invoke('po-send', { body: { po_id: draft.id, location_id: locId } });
                  setBusy(false);
                  let msg = '';
                  if (!e && res?.ok) msg = `Emailed to ${res.to}`;
                  else { try { msg = res?.error || (e?.context ? (await e.context.json())?.error : e?.message) || 'send failed'; } catch { msg = e?.message || 'send failed'; } }
                  showToast?.(msg, (!e && res?.ok) ? 'success' : 'error');
                }} disabled={busy} style={{ padding: '9px 14px', borderRadius: 8, background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t1)', fontSize: 13, cursor: 'pointer' }}>
                  ✉ Resend to supplier
                </button>
              )}
              {draft.id && (draft.status === 'SENT' || draft.status === 'PARTIAL') && !receiving && <PrimaryBtn onClick={openReceive} disabled={busy}>Accept delivery…</PrimaryBtn>}
              {draft.id && draft.status !== 'RECEIVED' && draft.status !== 'CANCELLED' && <button onClick={cancel} style={{ padding: '9px 14px', borderRadius: 8, background: 'transparent', border: '1px solid var(--bdr)', color: 'var(--t3)', fontSize: 13, cursor: 'pointer' }}>Cancel order</button>}
            </div>
            {receiving && (
              <div style={{ marginTop: 16, border: '1px solid var(--acc)', borderRadius: 10, padding: 16, background: 'var(--bg1)' }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--t1)', marginBottom: 4 }}>Accept delivery into stock</div>
                <div style={{ fontSize: 11.5, color: 'var(--t3)', marginBottom: 12 }}>
                  Check off against the delivery note. Correct any quantity that differs and any price that changed.
                  Shorted lines automatically move to a balance order. Each line can only be received once.
                </div>
                {areas.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t3)' }}>Lands in</span>
                    <select value={landArea} onChange={e => setLandArea(e.target.value)} style={{ ...field, width: 'auto', minWidth: 180 }} title="The stock area this delivery goes into. Move it on with a transfer.">
                      {!areas.some(a => a.isReceiving) && <option value="">Each item's own area</option>}
                      {areas.map(a => <option key={a.id} value={a.id}>{a.name}{a.isReceiving ? ' (receiving)' : ''}</option>)}
                    </select>
                  </div>
                )}
                {(draft.lines || []).map(l => {
                  const r = receiving[l.id] || {};
                  const short = Number(r.qtyPacks) < Number(l.qtyPacks);
                  const priceChanged = Number(r.unitPrice) !== Number(l.unitPrice);
                  return (
                    <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--bdr)' }}>
                      <span style={{ flex: 1, fontSize: 13, color: 'var(--t1)' }}>{l.description || itemName(l.inventoryItemId)}</span>
                      <span style={{ fontSize: 11, color: 'var(--t3)', whiteSpace: 'nowrap' }}>ordered {l.qtyPacks}</span>
                      <NumberField width={104} unit="packs" value={r.qtyPacks ?? ''} onChange={v => setReceiving(x => ({ ...x, [l.id]: { ...x[l.id], qtyPacks: v } }))} tone={short ? 'warn' : undefined} title="packs received" />
                      <span style={{ fontSize: 11, color: 'var(--t3)', whiteSpace: 'nowrap' }}>at {currencySymbol()}</span>
                      <NumberField width={112} unit="a pack" value={r.unitPrice ?? ''} onChange={v => setReceiving(x => ({ ...x, [l.id]: { ...x[l.id], unitPrice: v } }))} tone={priceChanged ? 'warn' : undefined} title="pack price on the delivery note, ex VAT" />
                      {short && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--org, #f59e0b)' }}>short</span>}
                    </div>
                  );
                })}
                <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center' }}>
                  <label style={{ fontSize: 12, color: 'var(--t3)', cursor: 'pointer', border: '1px dashed var(--bdr)', borderRadius: 7, padding: '7px 12px' }}>
                    📎 Attach invoice
                    <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) attachInvoice(f); e.target.value = ''; }} />
                  </label>
                  <div style={{ marginRight: 'auto' }} />
                  <button onClick={() => setReceiving(null)} style={{ padding: '9px 14px', borderRadius: 8, background: 'transparent', border: '1px solid var(--bdr)', color: 'var(--t3)', fontSize: 13, cursor: 'pointer' }}>Back</button>
                  <PrimaryBtn onClick={acceptIntoStock} disabled={busy}>Accept into stock</PrimaryBtn>
                </div>
              </div>
            )}
            {poInvoices.length > 0 && (
              <div style={{ marginTop: 12, fontSize: 12, color: 'var(--t3)' }}>
                📎 {poInvoices.length} invoice{poInvoices.length === 1 ? '' : 's'} attached
                {draft.status === 'RECEIVED' && (
                  <label style={{ marginLeft: 10, cursor: 'pointer', textDecoration: 'underline' }}>
                    add another<input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) attachInvoice(f); e.target.value = ''; }} />
                  </label>
                )}
              </div>
            )}
            {draft.status === 'RECEIVED' && poInvoices.length === 0 && (
              <div style={{ marginTop: 12, fontSize: 12, color: 'var(--t3)' }}>
                <label style={{ cursor: 'pointer', textDecoration: 'underline' }}>📎 Attach the supplier invoice
                  <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) attachInvoice(f); e.target.value = ''; }} />
                </label>
                {' '}(paperwork only, the stock is already in).
              </div>
            )}
            {draft.status === 'RECEIVED' && <div style={{ marginTop: 12, fontSize: 12, color: 'var(--grn)' }}>✓ Received into stock, costs updated. See each item's Stock tab for the delivery movement.</div>}
          </div>
        )}
      </main>
      </div>
    </div>
  );
}

// ── the supplier's items, windowed ───────────────────────────────────────────────────────────
// Only the rows in view (plus a few either side) are mounted: 1,000 items is 1,000 rows of data
// and about 25 rows of DOM, so the quantity boxes stay quick to type in. Every row is one fixed
// height so the scroll position maps straight onto a row index with no measuring.
const ROW_H = 46;
const OVERSCAN = 8;
const TABLE_MAX_H = 560;
const th = { padding: '9px 10px', fontWeight: 600, color: 'var(--t3)', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg2)', boxShadow: 'inset 0 -1px 0 var(--bdr)' };
const td = { padding: '0 10px', height: ROW_H, borderBottom: '1px solid var(--bdr)', verticalAlign: 'middle', whiteSpace: 'nowrap', fontSize: 13, color: 'var(--t1)' };
const num = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const COLS = [
  ['Item', 'left'], ['Pack', 'left'], ['Price', 'right'], ['On hand', 'right'], ['On order', 'right'], ['Par', 'right'], ['Suggested', 'right'], ['Packs', 'right'], ['Line (ex VAT)', 'right'],
];
// Every column but Item has a fixed width that fits what it holds (Price: the 88 px box plus the
// VAT tag; Packs: the 100 px box; each with 10 px padding a side). Item takes the rest, never
// less than ITEM_MIN_W: the table has a floor and the scroller scrolls sideways past it, so at
// 1,280 px (a 692 px pane beside the nav and the order list) the names stay readable and the
// right-hand columns scroll into view instead of the Item column squeezing to nothing.
const FIXED_COLS = [130, 150, 104, 96, 84, 92, 124, 104];
const ITEM_MIN_W = 260;
const TABLE_MIN_W = ITEM_MIN_W + FIXED_COLS.reduce((a, b) => a + b, 0);
const fmtQty = (v) => Number(v || 0).toLocaleString('en-GB', { maximumFractionDigits: 3 });

// The parent keys this component by its search and filter state, so a new search starts the list
// at the top again (a fresh mount) while typing a quantity leaves the scroll where it is.
function SupplierItemTable({ rows, onQty, onQtyBlur, onPrice, lineRateDec }) {
  const ref = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(TABLE_MAX_H);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setViewH(el.clientHeight || TABLE_MAX_H);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const slice = rows.slice(start, end);
  const topPad = start * ROW_H;
  const bottomPad = Math.max(0, (rows.length - end) * ROW_H);
  return (
    <div ref={ref} onScroll={e => setScrollTop(e.currentTarget.scrollTop)} style={{ maxHeight: TABLE_MAX_H, overflow: 'auto', border: '1px solid var(--bdr)', borderRadius: 12, background: 'var(--bg1)' }}>
      <table style={{ width: '100%', minWidth: TABLE_MIN_W, borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <colgroup>
          <col />{FIXED_COLS.map((w, i) => <col key={i} style={{ width: w }} />)}
        </colgroup>
        <thead><tr>{COLS.map(([h, align]) => <th key={h} style={{ ...th, textAlign: align }}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={COLS.length} style={{ ...td, textAlign: 'center', color: 'var(--t4)', height: 88, borderBottom: 'none' }}>No items match.</td></tr>}
          {topPad > 0 && <tr aria-hidden="true"><td colSpan={COLS.length} style={{ height: topPad, padding: 0, border: 0 }} /></tr>}
          {slice.map((r, i) => <ItemRow key={r.key} r={r} last={start + i === rows.length - 1} onQty={onQty} onQtyBlur={onQtyBlur} onPrice={onPrice} lineRateDec={lineRateDec} />)}
          {bottomPad > 0 && <tr aria-hidden="true"><td colSpan={COLS.length} style={{ height: bottomPad, padding: 0, border: 0 }} /></tr>}
        </tbody>
      </table>
    </div>
  );
}

function ItemRow({ r, last, onQty, onQtyBlur, onPrice, lineRateDec }) {
  const it = r.it;
  // The count unit (Keg, Case), as every other stock screen shows it.
  const uom = it ? { baseUnit: it.baseUnit, formats: it.packaging || [], itemConversions: it.conversions || [] } : null;
  const show = (base) => { if (!uom) return ''; const d = displayInUnits(base, uom); return `${fmtQty(d.qty)} ${d.label}`; };
  const cell = last ? { borderBottom: 'none' } : null;
  const qty = r.line ? String(r.line.qtyPacks ?? '') : '';
  const rate = r.line ? lineRateDec(r.line) : 0;
  const codes = [r.sku, r.supplierSku].filter(Boolean).join(' · ');
  return (
    <tr style={{ background: r.line ? 'color-mix(in srgb, var(--acc) 7%, transparent)' : 'transparent' }}>
      <td style={{ ...td, ...cell, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.extra && !it ? `${r.name}: this item was removed from Stock items after the order was drafted. The line keeps the pack and price it was typed with.` : `${r.name}${codes ? ` (${codes})` : ''}${r.category ? ` · ${r.category}` : ''}${r.area ? ` · ${r.area}` : ''}`}>
        <span style={{ fontWeight: 500 }}>{r.name}</span>
        {codes && <span style={{ color: 'var(--t4)', fontSize: 11, marginLeft: 8 }}>{codes}</span>}
        {r.extra && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: 'var(--amber, #F5A623)' }} title="This supplier has no pack on file for the item; the pack and price are the ones typed on this order">pack typed</span>}
        {r.belowPar && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: 'var(--red)', textTransform: 'uppercase', letterSpacing: '.04em' }}>low</span>}
      </td>
      <td style={{ ...td, ...cell, color: 'var(--t3)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.sp?.packDescription || ''}>{r.packQty} x {fmtQty(r.innerQty)} {r.innerUnit}</td>
      <td style={{ ...num, ...cell }}>
        {r.line
          ? <NumberField width={88} value={String(r.line.unitPrice ?? '')} onChange={v => onPrice(r, v)} title="price of one pack, ex VAT" inputStyle={{ fontSize: 13, padding: '5px 0' }} />
          : <span title="net price of one pack, ex VAT">{money(r.netPrice)}</span>}
        {rate > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t4)', marginLeft: 4 }} title="purchase VAT">+{Math.round(rate * 100)}%</span>}
      </td>
      <td style={{ ...num, ...cell, color: r.belowPar ? 'var(--red)' : 'var(--t1)' }}>{show(r.onHand)}</td>
      <td style={{ ...num, ...cell, color: 'var(--t3)' }} title="Outstanding on open orders">{r.onOrder > 0 ? show(r.onOrder) : ''}</td>
      <td style={{ ...num, ...cell, color: 'var(--t3)' }}>{r.par != null ? show(r.par) : ''}</td>
      <td style={{ ...num, ...cell }}>
        {r.suggestedPacks > 0
          ? <button onClick={() => onQty(r, String(r.suggestedPacks))} title="Order the suggested packs (the Order pad rule: usage to the next delivery, or top up to par)" style={{ background: 'transparent', border: '1px solid var(--acc)', color: 'var(--acc)', borderRadius: 7, padding: '3px 9px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums' }}>{r.suggestedPacks}</button>
          : <span style={{ color: 'var(--t4)' }}>{r.extra ? '' : '0'}</span>}
      </td>
      <td style={{ ...num, ...cell }}>
        <NumberField width={100} unit="packs" value={qty} onChange={v => onQty(r, v)} onBlur={() => onQtyBlur(r)} title="packs to order; clear the box to take the item off the order" inputStyle={{ fontSize: 13, padding: '5px 0' }} />
      </td>
      <td style={{ ...num, ...cell, fontWeight: 600 }}>{r.line && Number(r.line.qtyPacks) > 0 ? money(rowLineValue(r)) : ''}</td>
    </tr>
  );
}

function ItemPicker({ items, onPick }) {
  const [q, setQ] = useState('');
  const [focused, setFocused] = useState(false);
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items.filter(i => !i.archivedAt && i.kind !== 'MADE' && (!s || `${i.name} ${i.sku || ''}`.toLowerCase().includes(s))).slice(0, 10);
  }, [q, items]);
  return (
    <div style={{ position: 'relative', width: 360, maxWidth: '100%' }}>
      <input value={q} onChange={e => setQ(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 150)} placeholder="Add any stock item to the order…" style={field} />
      {focused && matches.length > 0 && (
        <div style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8, marginTop: 4, overflow: 'hidden', boxShadow: 'var(--sh2)' }}>
          {matches.map(i => <div key={i.id} onClick={() => { onPick(i); setQ(''); }} style={{ padding: '9px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--t1)' }}>{i.name}{i.sku ? <span style={{ color: 'var(--t4)', fontSize: 11, marginLeft: 8 }}>{i.sku}</span> : null}</div>)}
        </div>
      )}
    </div>
  );
}
