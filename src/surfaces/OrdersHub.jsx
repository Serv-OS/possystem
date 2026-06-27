/**
 * Orders — unified order management screen
 *
 * Three clear sections, always visible:
 *   1. Tables        — occupied table sessions
 *   2. Bar tabs      — open bar tabs
 *   3. Queue         — walk-in named / takeaway / collection / delivery
 *
 * Filters: order type tabs + My orders quick filter + search
 * Each section keeps its own functionality (advance status, open order, etc.)
 */
import { useState, useMemo, useEffect } from 'react';
import { useStore } from '../store';
import { supabase } from '../lib/supabase';
import { isTrainingMode } from '../lib/trainingMode';
import CardErrorBoundary from '../components/CardErrorBoundary';
import { syncQrTableSession } from '../lib/qrTableSession';
import { money, currencySymbol } from '../lib/currency';
import { ryftTab } from '../lib/payments/ryft';
import { getActiveLocationSync } from '../lib/supabase';
import { hubrisePushStatus } from '../lib/hubrise';
import { getDeliveryDetail } from '../lib/delivery/deliveryConfig';
import { dispatchDelivery, sendDeliveryTrackingSMS } from '../lib/delivery/dispatch';

// ── Channel definitions ────────────────────────────────────────────────────────
const FILTER_TABS = [
  { id:'all',        label:'All orders',  icon:'⊞' },
  { id:'table',      label:'Tables',      icon:'⬚',  color:'#3b82f6' },
  { id:'bar',        label:'Bar tabs',    icon:'🍸',  color:'#a855f7' },
  { id:'dine-in',    label:'Counter',     icon:'🏷',  color:'#22d3ee' },
  { id:'takeaway',   label:'Takeaway',    icon:'🥡',  color:'#e8a020' },
  { id:'collection', label:'Collection',  icon:'📦',  color:'#22c55e' },
  { id:'delivery',   label:'Delivery',    icon:'🛵',  color:'#ef4444' },
];

const SECTION_COLORS = {
  table:      '#3b82f6',
  bar:        '#a855f7',
  'dine-in':  '#22d3ee',
  takeaway:   '#e8a020',
  collection: '#22c55e',
  delivery:   '#ef4444',
};

const Q_STATUS = {
  received:  { label:'Received',  color:'#3b82f6' },
  prep:      { label:'In prep',   color:'#e8a020' },
  ready:     { label:'Ready ✓',   color:'#22c55e' },
  collected: { label:'Collected', color:'#888780' },
  paid:      { label:'Paid',      color:'#888780' },
  cancelled: { label:'Cancelled', color:'#ef4444' },
};
const DONE_STATUSES = ['collected', 'paid', 'cancelled'];

// v5.5.659: an order counts as paid (no money outstanding) if it carries a paid flag, OR it came
// from a channel that is ALWAYS prepaid before it reaches the queue (online/kiosk). Anything else —
// catering pay-later, an unpaid walk-in/phone order, an unpaid (test/cash) HubRise order — still
// owes money, so it must be CHARGED before it can be marked collected (never silently cleared).
const PREPAID_CHANNELS = ['online', 'kiosk'];
const isOrderPaid = (o) => !!(o?.paid || o?.customer?.paid || PREPAID_CHANNELS.includes(o?.source));

function elapsed(date) {
  if (!date) return '';
  const s = Math.floor((Date.now() - new Date(date)) / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// v5.5.326: money() now imported from lib/currency (multi-currency); sweep adds the import

// ── Root ──────────────────────────────────────────────────────────────────────
export default function OrdersHub() {
  const {
    tables, tabs, orderQueue,
    updateQueueStatus, removeFromQueue,
    showToast, setSurface, setActiveTableId,
    acceptOrderByRef, rejectOrderByRef,
    reprintOrderReceipt,
    staff,
  } = useStore();

  const [filter, setFilter]     = useState('all');
  const [search, setSearch]     = useState('');
  const [myOrders, setMyOrders] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [tick, setTick]         = useState(0);
  const [closingTabRef, setClosingTabRef] = useState(null); // ref currently being captured
  const [viewOrder, setViewOrder] = useState(null); // already-paid order shown read-only (no re-pay)
  const [delDetail, setDelDetail] = useState(null);  // { delivery, ... } courier status for viewOrder
  const [delBusy, setDelBusy]     = useState(false);  // dispatching / printing in progress
  const [printBusy, setPrintBusy] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  // Courier status for the order currently open in the read-only drawer. Only for courier
  // delivery orders (delivery_mode 'uber'). Refreshes when the drawer opens + every 20s.
  // Queue orders carry the order type on `channel` (set from o.type) and the raw row on `_raw`;
  // `viewOrder.type` is not populated here. Detect a courier delivery from the reliable fields.
  const viewIsCourier = !!viewOrder
    && (viewOrder.channel === 'delivery' || viewOrder._raw?.type === 'delivery' || viewOrder.type === 'delivery' || viewOrder.customer?.serviceType === 'delivery')
    && viewOrder.customer?.delivery_mode === 'uber';
  useEffect(() => {
    if (!viewIsCourier || !viewOrder?.ref) { setDelDetail(null); return; }
    let live = true;
    const load = async () => {
      const r = await getDeliveryDetail(getActiveLocationSync(), { orderRef: viewOrder.ref });
      if (live && r?.ok) setDelDetail(r);
    };
    load();
    const id = setInterval(load, 20000);
    return () => { live = false; clearInterval(id); };
  }, [viewIsCourier, viewOrder?.ref]);

  // Manually dispatch (or retry) a Stuart courier for the open delivery order.
  const sendToCourier = async () => {
    if (!viewOrder) return;
    if (isTrainingMode()) { showToast('Training mode — courier not dispatched.', 'info'); return; }
    setDelBusy(true);
    const locId = getActiveLocationSync();
    const c = viewOrder.customer || {};
    const quote = { dropoff: c.address || null, currency: 'GBP', dispatchable: true,
      customerFeeMinor: c.delivery_fee != null ? Math.round(Number(c.delivery_fee) * 100) : 0, quoteId: null };
    const order = { ref: viewOrder.ref, items: viewOrder.items || [], total: viewOrder.total, customer: c };
    const res = await dispatchDelivery({ opsLocationId: locId, order, quote }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (res?.ok && res.trackingUrl) sendDeliveryTrackingSMS({ opsLocationId: locId, phone: c.phone, trackingUrl: res.trackingUrl, ref: viewOrder.ref });
    if (res?.ok && !res.skipped) showToast('Courier requested from Stuart', 'success');
    else if (res?.skipped) showToast('Already sent to a courier', 'info');
    else showToast(res?.reason === 'out_of_coverage' ? 'Stuart can’t deliver to this address (out of coverage)' : `Courier dispatch failed${res?.error ? ': ' + res.error : ''}`, 'error');
    const r = await getDeliveryDetail(locId, { orderRef: viewOrder.ref });
    if (r?.ok) setDelDetail(r);
    setDelBusy(false);
  };

  const printReceipt = async () => {
    if (!viewOrder) return;
    setPrintBusy(true);
    await reprintOrderReceipt?.(viewOrder);
    setPrintBusy(false);
  };

  // ── Build unified order pool ──────────────────────────────────────────────
  const allOrders = useMemo(() => {
    const out = [];

    // Table sessions
    tables.filter(t => t.status !== 'available' && t.session).forEach(t => {
      const items = t.session?.items?.filter(i => !i.voided) || [];
      out.push({
        _kind: 'table', id: `tbl-${t.id}`,
        ref: `Table ${t.label}`, channel: 'table',
        displayName: `Table ${t.label}`,
        section: t.section, server: t.session?.server,
        covers: t.session?.covers,
        items, total: t.session?.total || 0,
        status: t.status === 'bill' ? 'bill_req' : t.session?.sentAt ? 'active' : 'ordering',
        createdAt: t.session?.createdAt || t.session?.sentAt,
        sentAt: t.session?.sentAt,
        tableId: t.id, isChild: !!t.parentId, parentId: t.parentId,
        _table: t,
      });
    });

    // Bar tabs
    tabs?.filter(tab => tab.status !== 'closed').forEach(tab => {
      const rounds = tab.rounds || [];
      const items  = rounds.flatMap(r => r.items || []).filter(i => !i.voided);
      out.push({
        _kind: 'tab', id: `tab-${tab.id}`,
        ref: tab.ref || tab.id, channel: 'bar',
        displayName: tab.name || 'Bar tab',
        server: tab.openedBy,
        items, total: tab.total || 0,
        status: 'active',
        createdAt: tab.openedAt,
        sentAt: tab.openedAt,
        _tab: tab,
      });
    });

    // Queue (named dine-in, takeaway, collection, delivery)
    orderQueue.forEach(o => {
      out.push({
        _kind: 'queue', id: `q-${o.ref}`,
        ref: o.ref, channel: o.type || 'dine-in',
        displayName: o.customer?.name || o.ref,
        server: o.staff, customer: o.customer,
        items: o.items || [], total: o.total || 0,
        status: o.status || 'received',
        createdAt: o.createdAt, sentAt: o.sentAt,
        collectionTime: o.collectionTime, isASAP: o.isASAP,
        source: o.source || 'pos',
        paid: !!o.paid,
        paymentMethod: o.paymentMethod || null,
        _raw: o,
      });
    });

    return out;
  }, [tables, tabs, orderQueue, tick]);

  // ── Apply filters ────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = allOrders;
    if (filter !== 'all') list = list.filter(o => o.channel === filter);
    if (!showDone) list = list.filter(o => !DONE_STATUSES.includes(o.status));
    if (myOrders && staff) {
      const me = staff.name?.toLowerCase();
      list = list.filter(o => o.server?.toLowerCase() === me);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(o =>
        (o.displayName || '').toLowerCase().includes(q) ||
        (o.ref || '').toLowerCase().includes(q) ||
        (o.server || '').toLowerCase().includes(q)
      );
    }
    return list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }, [allOrders, filter, search, myOrders, showDone, staff]);

  // Split into sections
  const tableOrders = filtered.filter(o => o.channel === 'table');
  const barOrders   = filtered.filter(o => o.channel === 'bar');

  // v5.5.157: pool QR open-tab rounds by customer.payment_intent_id so the
  // operator sees ONE card per tab (Table 4.1 · 3 rounds · £45.20 [Close & charge])
  // not three separate cards. Each round is still its own order_queue row
  // (kitchen prints each round as a fresh ticket — table-service correct)
  // but the operator UI groups them. Force-close captures the SUM across
  // all rounds tied to the same payment_intent.
  // v5.5.159: catch ALL QR orders (pay-now AND open-tab), not just open-tab.
  // Pay-now orders are already captured but still belong in the QR section
  // alongside their tab siblings — operators expect "everything from QR
  // shows in QR" not "QR pay-now lives with walk-in/takeaway/delivery".
  const isQrOrder    = (o) => o._kind === 'queue' && o.source === 'qr';
  const isQrOpenTab  = (o) => isQrOrder(o) && o.customer?.tab_open === true && !o.customer?.tab_closed;
  const qrTabRows    = filtered.filter(isQrOrder);
  const qrTabs = useMemo(() => {
    const byKey = {};
    qrTabRows.forEach(o => {
      // v5.5.159: open-tab rounds pool by PI (so 3 rounds = 1 card).
      // Pay-now orders have no PI to pool by, so they each become their own
      // card under the QR section keyed by ref.
      const isOpen = o.customer?.tab_open === true && !o.customer?.tab_closed;
      const pi = o.customer?.payment_intent_id;
      const key = (isOpen && pi) ? pi : `paynow:${o.ref}`;
      if (!byKey[key]) {
        byKey[key] = {
          key,
          isOpenTab: isOpen,
          payment_intent_id: pi || null,
          stripe_account: o.customer?.stripe_account || null,
          // Ryft tab routing — close goes through the ryft-tab edge fn instead
          // of /api/stripe-capture. Default missing processor → stripe so tabs
          // opened before dual-processor stay on the Stripe path.
          processor: o.customer?.processor || 'stripe',
          payment_session_id: o.customer?.payment_session_id || null,
          ryft_customer_id: o.customer?.ryft_customer_id || null,
          ryft_payment_method_id: o.customer?.ryft_payment_method_id || null,
          tableLabel: o.customer?.tableLabel || '?',
          tableId: o.customer?.tableId || null,
          customerName: o.customer?.name || 'Guest',
          customerPhone: o.customer?.phone || '',
          preAuthAmount: Number(o.customer?.pre_auth_amount || 0),
          tabOpenedAt: o.customer?.tab_opened_at || o.createdAt,
          tabSurchargePct:   Number(o.customer?.tab_surcharge_pct || 0),
          tabSurchargeFixed: Number(o.customer?.tab_surcharge_fixed || 0),
          tabForceCloseMin:  Number(o.customer?.tab_force_close_after_min || 0),
          rows: [],
          total: 0,
          allItems: [],
          firstRow: o,
        };
      }
      byKey[key].rows.push(o);
      byKey[key].total += Number(o.total || 0);
      byKey[key].allItems.push(...(o.items || []));
    });
    return Object.values(byKey).sort((a, b) => (a.tableLabel || '').localeCompare(b.tableLabel || ''));
  }, [qrTabRows]);

  // v5.5.159: queueOrders excludes ALL QR rows (pay-now + open-tab) so they
  // don't double-appear under Walk-in/Takeaway/Delivery. Everything QR is
  // surfaced in the dedicated QR section above.
  const queueOrders = filtered.filter(o => !['table', 'bar'].includes(o.channel) && !isQrOrder(o));

  // Counts for tab badges
  const counts = useMemo(() => {
    const active = allOrders.filter(o => !DONE_STATUSES.includes(o.status));
    return Object.fromEntries(FILTER_TABS.map(t => [
      t.id,
      t.id === 'all'
        ? active.length
        : active.filter(o => o.channel === t.id).length
    ]));
  }, [allOrders]);

  const totalActive = counts.all || 0;

  // Actions
  const advance = (o) => {
    if (o._kind !== 'queue') return;
    const flow  = ['received', 'prep', 'ready', 'collected'];
    const idx   = flow.indexOf(o.status);
    if (idx < 0 || idx >= flow.length - 1) return;
    const next  = flow[idx + 1];
    // v5.5.659: never let an order with money still owing be "marked collected" (which clears it
    // with no payment taken). Route to the POS pay flow instead — once paid + closed, it leaves
    // the queue. Paid / prepaid-channel orders advance to collected as before.
    if (next === 'collected' && !isOrderPaid(o)) {
      showToast(`Take payment for ${o.ref} before marking collected`, 'info');
      openOrder(o);
      return;
    }
    updateQueueStatus(o.ref, next);   // in-memory only in training (flushQueues is gated)
    const training = isTrainingMode();
    // HubRise channel orders: mirror each advance to HubRise (server-side PATCH).
    // Suppressed in training so a training till never pushes a real channel status.
    if (o.source === 'hubrise' && !training) {
      const action = next === 'prep' ? 'prep' : next === 'ready' ? 'ready' : next === 'collected' ? 'collected' : null;
      if (action) hubrisePushStatus(getActiveLocationSync(), o.ref, action).catch(() => {});
    }
    if (next === 'ready')     showToast(`${o.displayName} — ready!`, 'success');
    if (next === 'collected') {
      if (o.source === 'hubrise' && !training) bookHubriseSale(o);   // record the sale in history/reports
      showToast(`${o.ref} collected`, 'info');
      setTimeout(() => removeFromQueue(o.ref), 8000);
    }
  };

  // HubRise accept/reject gate (before the normal prep→ready→collected flow).
  // Logic lives in the store (acceptOrderByRef/rejectOrderByRef) so the new-order
  // popup can run the exact same path from any surface.
  const acceptHubrise = (o) => acceptOrderByRef(o.ref);
  const rejectHubrise = (o) => {
    if (!confirm(`Reject ${o.customer?.channel || 'this'} order ${o.ref}? The channel will be notified.`)) return;
    rejectOrderByRef(o.ref);
  };

  // Book a completed HubRise order into closed_checks so it lands in sales history + reports
  // (channel orders are pre-paid sales; they aren't written to closed_checks anywhere else).
  // Idempotent via the deterministic id (a duplicate insert just errors and is ignored).
  const bookHubriseSale = async (o) => {
    try {
      const locId = getActiveLocationSync();
      const items = (o.items || []).map(i => ({ ...i, voided: false }));
      const lineTotal = items.reduce((s, it) => s + (Number(it.qty) || 1) * ((Number(it.price) || 0) + (it.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0)), 0);
      const total = Number(o.total) || 0;
      const paid = !!(o.customer?.paid);
      await supabase.from('closed_checks').insert({
        id: `chk-hr-${o.ref}`, ref: o.ref, location_id: locId,
        server: o.customer?.channel || 'HubRise', staff_id: null, covers: 1,
        order_type: o.channel || o.type || 'delivery', customer: o.customer || {}, items,
        discounts: [], subtotal: +lineTotal.toFixed(2), service: Math.max(0, +(total - lineTotal).toFixed(2)),
        tip: 0, tax_amount: null, total, method: paid ? 'card' : 'cash',
        closed_at: new Date().toISOString(), status: 'paid', refunds: [], table_id: null,
        table_label: `${o.customer?.channel || 'HubRise'} ${o.customer?.collectionCode || o.ref}`,
        source: 'hubrise',
      });
    } catch (e) { console.warn('[hubrise] book sale failed:', e?.message); }
  };

  // v5.5.157: force-close a POOLED QR tab (multiple rounds aggregated by
  // payment_intent_id). Sums totals across all rounds, applies the auto-
  // surcharge if the tab is past the threshold, captures the held pre-auth
  // (capped at the held amount — Stripe rejects over-capture), marks
  // every round on this PI as collected, writes ONE closed_check covering
  // the full bill.
  const forceCloseQrTab = async (tab) => {
    if (closingTabRef) return;
    // TRAINING MODE: these are REAL customer tabs (synced in). Never capture a card
    // or write closed_checks/order_queue from a training till — block with a notice.
    if (isTrainingMode()) { showToast('Training mode — live tabs are not charged or closed here', 'info'); return; }
    // Route by processor. Default missing processor → stripe (tabs opened
    // before dual-processor). Ryft holds are addressed by payment_session_id;
    // the ryft-tab edge fn resolves the merchant account from location_id.
    const isRyft = (tab.processor === 'ryft') || (!tab.stripe_account && !!tab.payment_session_id);
    const ryftSession = tab.payment_session_id || tab.payment_intent_id;
    if (isRyft ? !ryftSession : (!tab.payment_intent_id || !tab.stripe_account)) {
      showToast('Tab missing payment info — cannot capture', 'error');
      return;
    }
    // Surcharge math (snapshotted on the tab at open-time)
    let surcharge = 0;
    let surchargeReason = '';
    if (tab.tabOpenedAt && tab.tabForceCloseMin > 0) {
      const ageMin = (Date.now() - new Date(tab.tabOpenedAt).getTime()) / 60_000;
      if (ageMin > tab.tabForceCloseMin) {
        surcharge = +((tab.total * tab.tabSurchargePct / 100) + tab.tabSurchargeFixed).toFixed(2);
        surchargeReason = `${Math.round(ageMin)} min open · `
          + (tab.tabSurchargePct ? `${tab.tabSurchargePct}%` : '')
          + (tab.tabSurchargePct && tab.tabSurchargeFixed ? ' + ' : '')
          + (tab.tabSurchargeFixed ? `${money(tab.tabSurchargeFixed)}` : '');
      }
    }
    const finalTotal = +(tab.total + surcharge).toFixed(2);
    // v5.5.160: ALWAYS request the full bill. The capture endpoint clamps
    // to the actual amount_capturable on the PI and reports any shortfall;
    // we then charge the difference off_session on the saved payment_method
    // (saved at tab open via setup_future_usage='off_session'). User no
    // longer has to remember the £/percent pre-auth — bill above pre-auth
    // is now a normal flow, not an error.
    const willOverage = tab.preAuthAmount > 0 && finalTotal > tab.preAuthAmount;
    const paymentMethodId = tab.firstRow?.customer?.payment_method_id || null;
    // Off-session overage needs a saved card: Stripe → payment_method id;
    // Ryft → the stored customer + tokenized payment-method captured at open.
    const ryftCustomerId   = tab.ryft_customer_id || tab.firstRow?.customer?.ryft_customer_id || null;
    const ryftStoredCardId = tab.ryft_payment_method_id || tab.firstRow?.customer?.ryft_payment_method_id || null;
    const hasSavedCard = isRyft ? (!!ryftCustomerId && !!ryftStoredCardId) : !!paymentMethodId;
    if (willOverage && !hasSavedCard) {
      if (!confirm(
        `Bill is ${money(finalTotal)} but only ${money(tab.preAuthAmount)} was pre-authorised, and this tab was opened BEFORE v5.5.160 (no saved card on file).\n\n`
        + `Only ${money(tab.preAuthAmount)} can be captured. The ${money((finalTotal - tab.preAuthAmount))} shortfall must be collected via terminal or cash.\n\nProceed?`
      )) return;
    } else if (!confirm(
      (willOverage
        ? `Close Table ${tab.tableLabel}? Capture ${money(tab.preAuthAmount)} pre-auth + charge ${money((finalTotal - tab.preAuthAmount))} overage on saved card = ${money(finalTotal)} total.`
        : surcharge > 0
          ? `Close Table ${tab.tableLabel}? Bill ${money(tab.total)} + surcharge ${money(surcharge)} (${surchargeReason}) = ${money(finalTotal)} captured.`
          : `Close Table ${tab.tableLabel} (${tab.rows.length} round${tab.rows.length === 1 ? '' : 's'}) and charge ${money(finalTotal)}?`)
      + (tab.preAuthAmount > finalTotal
        ? `\n\nNOTE: customer's card was HELD for ${money(tab.preAuthAmount)} when the tab opened. We capture ${money(finalTotal)} now; the remaining ${money((tab.preAuthAmount - finalTotal))} hold is released by their bank in 1–7 days. Customer's bank statement may briefly show both — this is normal.`
        : '')
    )) return;

    setClosingTabRef(tab.payment_intent_id);
    try {
      // Capture the bill, clamped to the hold. Both paths return the same
      // shape: { captured, captured_amount(minor), shortfall(minor), currency }.
      let data;
      if (isRyft) {
        const r = await ryftTab('capture', {
          location_id: tab.firstRow?.location_id,
          payment_session_id: ryftSession,
          amount_minor: Math.round(finalTotal * 100),
        });
        // Use the hold's real currency (echoed by capture) for the overage —
        // never assume GBP, or a USD/EUR venue's MIT would currency-mismatch.
        data = { captured: !!r.success, captured_amount: Number(r.captured_amount || 0), shortfall: Number(r.shortfall || 0), currency: (r.currency || 'gbp').toLowerCase() };
      } else {
        const res = await fetch('/api/stripe-capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            paymentIntentId: tab.payment_intent_id,
            stripeAccount: tab.stripe_account,
            amountToCapture: Math.round(finalTotal * 100),
          }),
        });
        data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Capture failed');
      }
      if (!data.captured) throw new Error(data?.error || 'Capture failed');

      // v5.5.160: if the capture was capped at the auth amount, charge the
      // shortfall off_session on the saved payment_method. Stripe will
      // immediately confirm or decline; if decline, surface a clear error
      // to the operator so they can collect via terminal/cash.
      let overageCaptured = 0;
      let overageError = null;
      const shortfallMinor = Number(data.shortfall || 0);
      if (shortfallMinor > 0) {
        if (!hasSavedCard) {
          overageError = `Could not auto-charge ${money((shortfallMinor / 100))} overage — no saved card on this tab.`;
        } else if (isRyft) {
          // Off-session MIT on the card stored at tab open (new Unscheduled
          // session referencing the hold + customer + tokenized card).
          try {
            const ov = await ryftTab('overage', {
              location_id: tab.firstRow?.location_id,
              previous_session_id: ryftSession,
              customer_id: ryftCustomerId,
              stored_card_id: ryftStoredCardId,
              amount_minor: shortfallMinor,
              currency: data.currency || 'gbp',
            });
            if (!ov.charged) overageError = ov?.detail || ov?.error || 'Overage charge was not approved.';
            else overageCaptured = shortfallMinor / 100;
          } catch (e) {
            overageError = e?.detail || e?.message || 'Overage charge failed.';
          }
        } else {
          try {
            const ovRes = await fetch('/api/stripe-charge-overage', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                stripeAccount: tab.stripe_account,
                paymentMethodId,
                amount: shortfallMinor,
                currency: data.currency || 'gbp',
                description: `QR tab overage · Table ${tab.tableLabel} · ${tab.payment_intent_id}`,
                metadata: {
                  source: 'qr_overage',
                  parent_payment_intent: tab.payment_intent_id,
                  table_label: String(tab.tableLabel || ''),
                },
              }),
            });
            const ov = await ovRes.json();
            if (!ovRes.ok || !ov.ok) {
              overageError = ov?.error || `Overage charge failed (HTTP ${ovRes.status}).`;
            } else {
              overageCaptured = Number(ov.amount || shortfallMinor) / 100;
            }
          } catch (e) {
            overageError = e?.message || 'Overage charge failed.';
          }
        }
      }

      // Mark every round on this PI as collected
      try {
        const refs = tab.rows.map(r => r.ref).filter(Boolean);
        if (refs.length) {
          await supabase.from('order_queue').update({ status: 'collected' }).in('ref', refs);
          refs.forEach(ref => updateQueueStatus(ref, 'collected'));
        }
      } catch (e) { console.warn('[forceCloseQrTab] mark-collected:', e?.message); }

      const capturedFromAuth = Number(data.captured_amount || 0) / 100;
      const totalCollected = +(capturedFromAuth + overageCaptured).toFixed(2);

      // ONE closed_check for the whole tab
      // v5.5.162: was silently swallowing errors via console.warn — meaning
      // a failed insert just disappeared and the order never reached the
      // history view. Capture the error and surface it as a toast.
      let closedCheckError = null;
      try {
        const { error: ccErr } = await supabase.from('closed_checks').insert({
          id: `chk-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
          ref: tab.firstRow?.ref || tab.payment_intent_id,
          location_id: tab.firstRow?.location_id || null,
          server: 'QR (force-closed)',
          covers: 1,
          order_type: 'dine-in',
          customer: {
            ...(tab.firstRow?.customer || {}),
            tab_closed_at: new Date().toISOString(),
            surcharge_applied: surcharge,
            captured_from_pre_auth: capturedFromAuth,
            overage_charged: overageCaptured,
            overage_outstanding: overageError ? +(finalTotal - totalCollected).toFixed(2) : 0,
            overage_error: overageError || null,
          },
          items: tab.allItems.map(i => ({ ...i, voided: false })),
          discounts: [],
          subtotal: tab.total,
          service: surcharge,
          tip: 0, tax_amount: null,
          total: totalCollected,
          method: 'card',
          // Refund routing: refundCheck reads top-level processor + refunds each
          // payment_intents[].id (payment_session_id for Ryft, payment_intent_id
          // for Stripe). Reference the main captured hold; the overage is a
          // separate session and is not auto-refunded here.
          processor: isRyft ? 'ryft' : 'stripe',
          stripe_payment_intent_id: isRyft ? null : tab.payment_intent_id,
          payment_intents: [{ id: isRyft ? ryftSession : tab.payment_intent_id, amountMinor: Math.round(capturedFromAuth * 100) }],
          closed_at: new Date().toISOString(),
          // v5.5.162: was using 'partial' on shortfall but that may violate
          // a status enum/check constraint and silently fail the insert →
          // order vanishes from history. Always use 'paid'; partial state
          // lives in customer.overage_outstanding for any reporting.
          status: 'paid',
          refunds: [],
          table_id: tab.tableId || null,
          table_label: `Table ${tab.tableLabel}`,
          source: 'qr',
        });
        if (ccErr) {
          closedCheckError = ccErr.message || JSON.stringify(ccErr);
          console.error('[forceCloseQrTab] closed_checks insert FAILED:', ccErr);
        }
      } catch (e) {
        closedCheckError = e?.message || 'unknown error';
        console.error('[forceCloseQrTab] closed_checks insert threw:', e);
      }
      if (closedCheckError) {
        showToast(
          `⚠ Capture succeeded but order didn't save to history: ${closedCheckError}`,
          'error', 12000
        );
      }

      if (overageError) {
        showToast(
          `Table ${tab.tableLabel}: captured ${money(capturedFromAuth)} from pre-auth, but overage ${money((finalTotal - capturedFromAuth))} could not be charged: ${overageError}. Collect via terminal/cash.`,
          'error', 12000
        );
      } else if (overageCaptured > 0) {
        showToast(
          `Table ${tab.tableLabel}: ${money(capturedFromAuth)} captured + ${money(overageCaptured)} overage on saved card = ${money(totalCollected)} total ✓`,
          'success'
        );
      } else {
        showToast(
          surcharge > 0
            ? `Table ${tab.tableLabel} captured ${money(capturedFromAuth)} (incl ${money(surcharge)} surcharge)`
            : `Table ${tab.tableLabel} captured ${money(capturedFromAuth)}`,
          'success'
        );
      }
      tab.rows.forEach(r => setTimeout(() => removeFromQueue(r.ref), 8000));
      // v5.5.157: refresh the floor-plan table session so the closed
      // tab's items disappear from TablesSurface. If other QR tabs are
      // still open at this table the helper preserves their items.
      if (tab.tableId && tab.firstRow?.location_id) {
        syncQrTableSession(tab.firstRow.location_id, tab.tableId).catch(() => {});
      }
    } catch (e) {
      console.error('[forceCloseQrTab] failed:', e);
      showToast(`Force-close failed: ${e?.message || 'unknown'}`, 'error');
    } finally {
      setClosingTabRef(null);
    }
  };

  // v5.5.150: force-close a QR open-tab. Calls /api/stripe-capture to capture
  // the held pre-auth amount on the connected Stripe account, then writes
  // closed_checks + marks the order_queue row collected.
  // Customer.payment_intent_id + customer.stripe_account were stashed at
  // tab open by QrCheckout (no schema migration on bar_tabs needed —
  // see feedback_qr_no_bartabs memory).
  // Auto-surcharge for left-open tabs: deferred to commit 3c (this commit
  // covers the manual force-close from the operator queue).
  const forceCloseTab = async (o) => {
    if (closingTabRef) return;
    if (isTrainingMode()) { showToast('Training mode — live tabs are not charged or closed here', 'info'); return; }
    const pi = o.customer?.payment_intent_id;
    const acct = o.customer?.stripe_account;
    if (!pi || !acct) {
      showToast(`${o.ref}: no payment intent on this tab — can't capture`, 'error');
      return;
    }

    // v5.5.151: auto-surcharge for left-open tabs. Config snapshotted on
    // the tab at open-time (see QrCheckout). Apply when tab age exceeds
    // tab_force_close_after_min. Both pct AND fixed can stack.
    let surcharge = 0;
    let surchargeReason = '';
    const openedAtMs = o.customer?.tab_opened_at ? new Date(o.customer.tab_opened_at).getTime() : null;
    const thresholdMin = Number(o.customer?.tab_force_close_after_min ?? 0);
    if (openedAtMs && thresholdMin > 0) {
      const ageMin = (Date.now() - openedAtMs) / 60_000;
      if (ageMin > thresholdMin) {
        const pct   = Number(o.customer?.tab_surcharge_pct ?? 0);
        const fixed = Number(o.customer?.tab_surcharge_fixed ?? 0);
        surcharge = +((Number(o.total || 0) * pct / 100) + fixed).toFixed(2);
        surchargeReason = `Tab open ${Math.round(ageMin)} min · `
          + (pct > 0 ? `${pct}%` : '')
          + (pct > 0 && fixed > 0 ? ' + ' : '')
          + (fixed > 0 ? `${money(fixed)}` : '');
      }
    }
    const finalTotal = +(Number(o.total || 0) + surcharge).toFixed(2);

    // Cap at pre-auth — Stripe rejects capture > authorised amount. The
    // operator gets a clear warning if the auth wasn't enough so they can
    // chase the customer for the difference manually.
    const preAuth = Number(o.customer?.pre_auth_amount || 0);
    if (preAuth > 0 && finalTotal > preAuth) {
      if (!confirm(
        `WARNING: bill is ${money(finalTotal)} but only ${money(preAuth)} was pre-authorised.\n\n`
        + `Stripe will only capture ${money(preAuth)}. The ${money((finalTotal - preAuth))} shortfall must be collected separately.\n\n`
        + `Proceed?`
      )) return;
    } else if (!confirm(
      surcharge > 0
        ? `Close this tab? Bill ${money(Number(o.total || 0))} + surcharge ${money(surcharge)} (${surchargeReason}) = ${money(finalTotal)} charged.`
        : `Close this tab and charge ${money(finalTotal)} to the customer's card?`
    )) return;

    setClosingTabRef(o.ref);
    const captureAmount = preAuth > 0 ? Math.min(finalTotal, preAuth) : finalTotal;
    try {
      const res = await fetch('/api/stripe-capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentIntentId: pi,
          stripeAccount: acct,
          amountToCapture: Math.round(captureAmount * 100), // pence
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.captured) {
        throw new Error(data?.error || 'Capture failed');
      }
      // Write closed_checks now that the bill has been captured.
      try {
        await supabase.from('closed_checks').insert({
          id: `chk-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
          ref: o.ref,
          location_id: o.location_id || null,
          server: 'QR (force-closed)',
          covers: 1,
          order_type: 'dine-in',
          customer: { ...o.customer, tab_closed_at: new Date().toISOString(), surcharge_applied: surcharge },
          items: (o.items || []).map(i => ({ ...i, voided: false })),
          discounts: [],
          subtotal: o.total,
          service: surcharge,                 // surface the auto-surcharge in the service line
          tip: 0, tax_amount: null,
          total: captureAmount,                // what was actually charged
          method: 'card',
          closed_at: new Date().toISOString(),
          status: 'paid',
          refunds: [],
          table_id: null,
          table_label: o.customer?.tableLabel ? `Table ${o.customer.tableLabel}` : null,
          source: 'qr',
        });
      } catch (e) { console.warn('[OrdersHub force-close] closed_checks insert:', e?.message); }
      updateQueueStatus(o.ref, 'collected');
      showToast(
        surcharge > 0
          ? `${o.ref} captured ${money(captureAmount)} (incl ${money(surcharge)} surcharge)`
          : `${o.ref} captured ${money(captureAmount)}`,
        'success'
      );
      setTimeout(() => removeFromQueue(o.ref), 8000);
    } catch (e) {
      console.error('[OrdersHub] force-close failed:', e);
      showToast(`Force-close failed: ${e?.message || 'unknown'}`, 'error');
    } finally {
      setClosingTabRef(null);
    }
  };

  const openOrder = (o) => {
    if (o._kind === 'table') { setActiveTableId(o.tableId); setSurface('tables'); }
    else if (o._kind === 'tab') { setSurface('bar'); }
    // Already paid (e.g. a catering pre-order paid online): opening it loaded it into the POS
    // pay flow, which would take payment a SECOND time. Show it read-only instead — staff still
    // advance it (prep/ready/collected) from its card.
    // v5.5.658: also treat online/kiosk as paid by channel — those are ALWAYS prepaid before they
    // reach the queue, so even if the paid flag is missing (older rows / column absent on a venue)
    // they must never re-open into the editable pay flow. Catering (can be pay-later), QR (open
    // tabs) and HubRise (test/manual orders) stay flag-driven so genuinely unpaid ones remain payable.
    else if (o.paid || o.customer?.paid || ['online', 'kiosk'].includes(o.source)) { setViewOrder(o); }
    else {
      // A pay-later CATERING order opened for payment BEFORE its scheduled fire time would, on
      // close, delete its order_queue row before releaseDueCateringOrders fires it → silent
      // kitchen miss. Fire it now (idempotent: routeKioskOrderPrints' kitchen_routed_at claim
      // dedups against the scheduled release), so the kitchen ticket is guaranteed.
      if (o.source === 'catering') {
        try { useStore.getState().routeKioskOrderPrints?.({ ref: o.ref, source: 'catering', items: o.items || [], customer: o.customer || null, collectionTime: o.collectionTime || null, isASAP: o.isASAP, sentAt: Date.now() }); } catch { /* best-effort */ }
      }
      // Walk-in / takeaway / delivery / counter order — load it back into the
      // walk-in slot so the POS actually shows the items. Previously this branch
      // only called setSurface('pos') which left walkInOrder null, so the POS
      // rendered an empty cart every time.
      useStore.setState({
        walkInOrder: {
          id: `ORD-${(o.ref||'').replace('#','')}`,
          ref: o.ref,
          items: o.items || [],
          sentAt: o.sentAt,
          total: o.total,
          isASAP: o.isASAP,
          collectionTime: o.collectionTime,
        },
        customer: o.customer || null,
        // v4.6.5 follow-up Bug 2 real root cause: the orderQueue-to-list transform at
        // OrdersHub line 113-125 doesn't include `type` on the outer object — the original
        // entry is stashed under _raw. Read from _raw.type first so reopened takeaways don't
        // fall through to the 'dine-in' default.
        orderType: o._raw?.type || o.type || 'dine-in',
        activeTableId: null,
      });
      setSurface('pos');
    }
  };

  const showingSections = filter === 'all' && !search && !myOrders;

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', width:'100%', flex:1, minWidth:0, overflow:'hidden', background:'var(--bg)' }}>

      {/* ── Top bar ────────────────────────────────────────────────── */}
      <div style={{ padding:'10px 16px 0', borderBottom:'1px solid var(--bdr)', background:'var(--bg1)', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:10 }}>
          {/* Title */}
          <div style={{ flex:1 }}>
            <div style={{ fontSize:15, fontWeight:800, color:'var(--t1)', display:'flex', alignItems:'center', gap:10 }}>
              Orders
              {totalActive > 0 && (
                <span style={{ fontSize:11, fontWeight:800, padding:'2px 8px', borderRadius:20, background:'var(--acc)', color:'#0b0c10' }}>
                  {totalActive}
                </span>
              )}
            </div>
          </div>
          {/* Controls */}
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            {/* My orders */}
            {staff && (
              <button onClick={() => setMyOrders(m => !m)} style={{
                padding:'5px 11px', borderRadius:20, cursor:'pointer', fontFamily:'inherit', fontSize:11,
                fontWeight:myOrders ? 800 : 500,
                background:myOrders ? 'var(--acc-d)' : 'var(--bg3)',
                border:`1.5px solid ${myOrders ? 'var(--acc)' : 'var(--bdr)'}`,
                color:myOrders ? 'var(--acc)' : 'var(--t3)',
              }}>
                👤 My orders
              </button>
            )}
            {/* Show completed */}
            <label style={{ display:'flex', alignItems:'center', gap:5, cursor:'pointer', fontSize:12, color:'var(--t3)' }}>
              <input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} style={{ accentColor:'var(--acc)' }} />
              Completed
            </label>
            {/* Search */}
            <div style={{ position:'relative' }}>
              <span style={{ position:'absolute', left:8, top:'50%', transform:'translateY(-50%)', fontSize:12, color:'var(--t4)', pointerEvents:'none' }}>🔍</span>
              <input
                style={{ background:'var(--bg3)', border:'1px solid var(--bdr2)', borderRadius:9, padding:'6px 10px 6px 26px', color:'var(--t1)', fontSize:12, fontFamily:'inherit', outline:'none', width:180 }}
                placeholder="Search…"
                value={search} onChange={e => setSearch(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Filter tabs */}
        <div style={{ display:'flex', gap:2, overflowX:'auto' }}>
          {FILTER_TABS.map(tab => {
            const n = counts[tab.id] || 0;
            const active = filter === tab.id;
            const color = tab.color || 'var(--acc)';
            return (
              <button key={tab.id} onClick={() => setFilter(tab.id)} style={{
                padding:'6px 12px', cursor:'pointer', fontFamily:'inherit', border:'none',
                borderBottom:`3px solid ${active ? color : 'transparent'}`,
                background: active ? `${color}18` : 'transparent',
                color: active ? color : 'var(--t3)',
                fontSize:12, fontWeight:active ? 800 : 500, whiteSpace:'nowrap',
                borderRadius:'8px 8px 0 0', transition:'all .1s',
              }}>
                {tab.icon} {tab.label}
                {n > 0 && (
                  <span style={{ marginLeft:5, fontSize:10, fontWeight:800, padding:'1px 5px', borderRadius:8, background:active?color:'var(--bg3)', color:active?'#0b0c10':'var(--t4)' }}>
                    {n}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Content ─────────────────────────────────────────────────── */}
      <div style={{ flex:1, overflowY:'auto', padding:'14px 16px' }}>

        {filtered.length === 0 ? (
          <EmptyState filter={filter} search={search} myOrders={myOrders} staff={staff} />
        ) : showingSections ? (
          // Sectioned view when showing all orders unfiltered
          <>
            {tableOrders.length > 0 && (
              <Section title="Tables" icon="⬚" color="#3b82f6" count={tableOrders.length}>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))', gap:10 }}>
                  {tableOrders.map(o => <OrderCard key={o.id} order={o} onAdvance={()=>advance(o)} onAccept={()=>acceptHubrise(o)} onReject={()=>rejectHubrise(o)} onOpen={()=>openOrder(o)} onForceClose={()=>forceCloseTab(o)} closingTab={closingTabRef === o.ref}/>)}
                </div>
              </Section>
            )}
            {barOrders.length > 0 && (
              <Section title="Bar tabs" icon="🍸" color="#a855f7" count={barOrders.length}>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))', gap:10 }}>
                  {barOrders.map(o => <OrderCard key={o.id} order={o} onAdvance={()=>advance(o)} onAccept={()=>acceptHubrise(o)} onReject={()=>rejectHubrise(o)} onOpen={()=>openOrder(o)} onForceClose={()=>forceCloseTab(o)} closingTab={closingTabRef === o.ref}/>)}
                </div>
              </Section>
            )}
            {/* v5.5.157: QR open-tabs grouped by payment_intent_id. One card
                per tab even if the customer added multiple rounds — Force
                close & charge captures the SUM across all rounds. */}
            {qrTabs.length > 0 && (
              <Section title="📱 Open QR tabs" icon="📱" color="#10b981" count={qrTabs.length}>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(300px,1fr))', gap:10 }}>
                  {qrTabs.map(t => (
                    <QrTabCard key={t.key}
                      tab={t}
                      onForceClose={() => forceCloseQrTab(t)}
                      onAdvance={() => t.firstRow && advance(t.firstRow)}
                      closingTab={closingTabRef === (t.payment_intent_id || t.key)}/>
                  ))}
                </div>
              </Section>
            )}
            {queueOrders.length > 0 && (
              <Section title="Walk-in / Takeaway / Delivery" icon="🏷" color="#22d3ee" count={queueOrders.length}>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))', gap:10 }}>
                  {queueOrders.map(o => <OrderCard key={o.id} order={o} onAdvance={()=>advance(o)} onAccept={()=>acceptHubrise(o)} onReject={()=>rejectHubrise(o)} onOpen={()=>openOrder(o)} onForceClose={()=>forceCloseTab(o)} closingTab={closingTabRef === o.ref}/>)}
                </div>
              </Section>
            )}
          </>
        ) : (
          // Flat filtered view
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))', gap:10 }}>
            {filtered.map(o => <OrderCard key={o.id} order={o} onAdvance={()=>advance(o)} onAccept={()=>acceptHubrise(o)} onReject={()=>rejectHubrise(o)} onOpen={()=>openOrder(o)} onForceClose={()=>forceCloseTab(o)} closingTab={closingTabRef === o.ref}/>)}
          </div>
        )}
      </div>

      {/* Read-only view for already-paid orders (e.g. catering pre-orders) — no re-pay. */}
      {viewOrder && (
        <div onClick={(e) => { if (e.target === e.currentTarget) setViewOrder(null); }} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', display:'grid', placeItems:'center', zIndex:9999, padding:16 }}>
          <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:16, width:'100%', maxWidth:440, maxHeight:'85vh', overflowY:'auto', padding:20 }}>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:4 }}>
              <div style={{ fontSize:17, fontWeight:800, color:'var(--t1)', flex:1, minWidth:0 }}>{viewOrder.displayName || viewOrder.ref}</div>
              <span style={{ fontSize:9, fontWeight:700, padding:'2px 8px', borderRadius:8, background:'#22c55e18', border:'1px solid #22c55e44', color:'#22c55e' }}>PAID</span>
              <button onClick={() => setViewOrder(null)} style={{ background:'transparent', border:0, fontSize:22, color:'var(--t3)', cursor:'pointer', lineHeight:1 }}>×</button>
            </div>
            <div style={{ fontSize:12, color:'var(--t3)', marginBottom:12 }}>
              {viewOrder.ref} · {viewOrder.source === 'catering' ? 'Catering' : viewOrder.channel}
              {viewOrder.customer?.event_date ? ` · ${viewOrder.customer.event_date}${(viewOrder.customer?.event_time || viewOrder.collectionTime) ? ` at ${viewOrder.customer.event_time || viewOrder.collectionTime}` : ''}` : ''}
            </div>
            {viewOrder.customer && (viewOrder.customer.name || viewOrder.customer.phone || viewOrder.customer.address) && (
              <div style={{ fontSize:12.5, color:'var(--t2)', marginBottom:12, lineHeight:1.5 }}>
                {viewOrder.customer.name && <div>{viewOrder.customer.name}</div>}
                {viewOrder.customer.phone && <div>{viewOrder.customer.phone}</div>}
                {/* v5.5.657: address can be a {line1,postcode} object (online/catering) or a string — render safely */}
                {viewOrder.customer.address && <div>{typeof viewOrder.customer.address === 'string' ? viewOrder.customer.address : [viewOrder.customer.address.line1, viewOrder.customer.address.line2, viewOrder.customer.address.city, viewOrder.customer.address.postcode].filter(Boolean).join(', ')}</div>}
                {(viewOrder.type === 'delivery' || viewOrder.customer.delivery_fee != null) && (
                  <div style={{ color:'var(--t3)', marginTop:2 }}>
                    🚗 Delivery{viewOrder.customer.delivery_mode ? ` · ${viewOrder.customer.delivery_mode === 'uber' ? 'Courier' : 'Self-delivery'}` : ''}{viewOrder.customer.delivery_fee != null ? ` · fee ${money(Number(viewOrder.customer.delivery_fee))}` : ''}
                  </div>
                )}
                {/* Expected collection / delivery time so staff know when it's needed. */}
                {(() => {
                  const raw = viewOrder._raw || {};
                  const ct = viewOrder.collectionTime || raw.collection_time || null;
                  const asap = viewOrder.isASAP ?? raw.is_asap;
                  if (!ct && !asap) return null;
                  const isDel = viewOrder.channel === 'delivery' || raw.type === 'delivery' || viewOrder.customer.delivery_mode != null;
                  return <div style={{ color:'var(--t3)', marginTop:2 }}>🕒 {isDel ? 'Deliver' : 'Collect'}: {asap ? `ASAP${ct ? ` (ready ~${ct})` : ''}` : (ct || '—')}</div>;
                })()}
              </div>
            )}
            <div style={{ display:'flex', flexDirection:'column', gap:6, borderTop:'1px solid var(--bdr)', paddingTop:12 }}>
              {(viewOrder.items || []).map((it, i) => (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', gap:10, fontSize:13 }}>
                  <div style={{ color:'var(--t1)' }}>
                    <span style={{ color:'var(--t3)' }}>{it.qty || 1}× </span>{it.name}
                    {(it.mods || []).length > 0 && <div style={{ fontSize:11, color:'var(--t3)', paddingLeft:14 }}>{it.mods.map(m => m.name).join(', ')}</div>}
                    {it.notes && <div style={{ fontSize:11, color:'var(--t3)', paddingLeft:14, fontStyle:'italic' }}>{it.notes}</div>}
                  </div>
                  <div style={{ color:'var(--t2)', whiteSpace:'nowrap' }}>{money(((it.price || 0) + (it.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0)) * (it.qty || 1))}</div>
                </div>
              ))}
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', borderTop:'1px solid var(--bdr)', marginTop:12, paddingTop:12, fontSize:15, fontWeight:800, color:'var(--t1)' }}>
              <span>Total</span><span>{money(viewOrder.total || 0)}</span>
            </div>

            {/* Courier (Stuart) status + dispatch control — only for courier delivery orders. */}
            {viewIsCourier && (() => {
              const d = delDetail?.delivery || null;
              const st = d?.status || null;
              const MAP = {
                dispatching: ['Finding a courier…', '#f59e0b'], pending: ['Finding a courier…', '#f59e0b'],
                pickup: ['Courier heading to venue', '#3b82f6'], dropoff: ['Out for delivery', '#3b82f6'],
                delivered: ['Delivered', '#22c55e'], canceled: ['Canceled', '#888780'],
                returned: ['Returned', '#ef4444'], failed: ['Dispatch failed', '#ef4444'],
              };
              const [label, color] = MAP[st] || ['Not sent to a courier yet', '#888780'];
              const terminalBad = st === 'failed' || st === 'canceled' || !st;
              return (
                <div style={{ marginTop:12, padding:'12px 14px', borderRadius:12, background:'var(--bg2)', border:'1px solid var(--bdr)' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <span style={{ fontSize:12, fontWeight:800, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.05em' }}>Stuart courier</span>
                    <span style={{ marginLeft:'auto', fontSize:11, fontWeight:800, padding:'3px 10px', borderRadius:12, background:`${color}22`, color }}>{label}</span>
                  </div>
                  {d?.courier_name && <div style={{ fontSize:12.5, color:'var(--t2)', marginTop:6 }}>👤 {d.courier_name}{d.courier_phone ? ` · ${d.courier_phone}` : ''}</div>}
                  {d?.eta && <div style={{ fontSize:12.5, color:'var(--t2)', marginTop:2 }}>⏱ ETA {new Date(d.eta).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' })}</div>}
                  {d?.tracking_url && <a href={d.tracking_url} target="_blank" rel="noreferrer" style={{ display:'inline-block', marginTop:6, fontSize:12.5, color:'var(--acc)', fontWeight:700, textDecoration:'none' }}>Track courier ↗</a>}
                  {terminalBad && (
                    <button onClick={sendToCourier} disabled={delBusy} style={{ width:'100%', marginTop:10, padding:10, borderRadius:9, background:'var(--acc)', border:'none', color:'#0b0c10', fontWeight:800, cursor: delBusy?'wait':'pointer', fontFamily:'inherit', opacity: delBusy?0.6:1 }}>
                      {delBusy ? 'Sending…' : st === 'failed' ? '↻ Retry — send to Stuart' : '🚗 Send to Stuart courier'}
                    </button>
                  )}
                </div>
              );
            })()}

            <div style={{ display:'flex', gap:8, marginTop:14 }}>
              <button onClick={printReceipt} disabled={printBusy} style={{ flex:1, padding:11, borderRadius:10, background:'var(--bg2)', border:'1px solid var(--bdr)', color:'var(--t1)', fontWeight:700, cursor: printBusy?'wait':'pointer', fontFamily:'inherit', opacity: printBusy?0.6:1 }}>{printBusy ? 'Printing…' : '🧾 Print receipt'}</button>
            </div>
            <div style={{ fontSize:11, color:'var(--t3)', marginTop:8 }}>Already paid{viewOrder.paymentMethod ? ` · ${viewOrder.paymentMethod}` : ''}. Advance it from its card (prep → ready → collected).</div>
            <button onClick={() => { setViewOrder(null); setDelDetail(null); }} style={{ width:'100%', marginTop:12, padding:12, borderRadius:10, background:'var(--bg2)', border:'1px solid var(--bdr)', color:'var(--t1)', fontWeight:700, cursor:'pointer', fontFamily:'inherit' }}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Section header ────────────────────────────────────────────────────────────
// v5.5.157: pooled QR-tab card. One per payment_intent_id, even when the
// customer has added multiple rounds. Shows running total, rounds count,
// time open, single Force-close button that captures the lot.
function QrTabCard({ tab, onForceClose, onAdvance, closingTab }) {
  const ageMin = tab.tabOpenedAt ? Math.round((Date.now() - new Date(tab.tabOpenedAt).getTime()) / 60_000) : 0;
  const headerColor = tab.isOpenTab ? '#10b981' : '#22d3ee'; // emerald for tabs, cyan for paid
  return (
    <div style={{
      background:'var(--bg1)', borderRadius:13, overflow:'hidden',
      border:`1.5px solid ${headerColor}40`,
      display:'flex', flexDirection:'column',
    }}>
      <div style={{ height:3, background:`linear-gradient(90deg,${headerColor},${headerColor}88)` }}/>
      <div style={{ padding:'12px 14px', display:'flex', alignItems:'flex-start', gap:10 }}>
        <span style={{ fontSize:22 }}>📱</span>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:'flex', gap:8, alignItems:'baseline', flexWrap:'wrap' }}>
            <span style={{ fontSize:15, fontWeight:800, color:'var(--t1)' }}>Table {tab.tableLabel}</span>
            <span style={{ fontSize:10, color:'var(--t4)', fontFamily:'var(--font-mono)' }}>{tab.isOpenTab ? 'tab' : 'pay-now'}</span>
          </div>
          <div style={{ display:'flex', gap:10, marginTop:3, flexWrap:'wrap', fontSize:11, color:'var(--t3)' }}>
            <span>👤 {tab.customerName}</span>
            {tab.customerPhone && <span>📞 ··{(tab.customerPhone.replace(/\D/g, '').slice(-4))}</span>}
            <span>⏱ {ageMin} min open</span>
          </div>
        </div>
        {tab.isOpenTab ? (
          <span style={{ fontSize:10, fontWeight:800, padding:'3px 8px', borderRadius:12,
            background:'#fde68a', color:'#78350f', border:'1px solid #f59e0b', whiteSpace:'nowrap',
          }}>{currencySymbol()}{tab.preAuthAmount.toFixed(0)} HELD</span>
        ) : (
          <span style={{ fontSize:10, fontWeight:800, padding:'3px 8px', borderRadius:12,
            background:'#bbf7d0', color:'#14532d', border:'1px solid #22c55e', whiteSpace:'nowrap',
          }}>PAID</span>
        )}
      </div>
      <div style={{ padding:'0 14px 10px' }}>
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.05em', marginBottom:6 }}>
          {tab.rows.length} round{tab.rows.length === 1 ? '' : 's'}
        </div>
        {tab.allItems.slice(0, 6).map((item, i) => (
          <div key={i} style={{ display:'flex', gap:6, marginBottom:2, alignItems:'baseline', fontSize:12, color:'var(--t1)' }}>
            <span style={{ fontWeight:800, color:'var(--t4)', fontFamily:'var(--font-mono)', minWidth:18, textAlign:'right' }}>{item.qty}×</span>
            <span style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.kitchenName || item.name}</span>
          </div>
        ))}
        {tab.allItems.length > 6 && (
          <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>+{tab.allItems.length - 6} more</div>
        )}
      </div>
      <div style={{ padding:'10px 14px', borderTop:'1px solid var(--bdr)', background:'var(--bg2)', display:'flex', alignItems:'center', gap:8 }}>
        <span style={{ fontSize:18, fontWeight:900, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>{money(tab.total)}</span>
        <span style={{ fontSize:10, color:'var(--t4)' }}>{tab.isOpenTab ? 'running total' : 'paid'}</span>
        {tab.isOpenTab ? (
          <button onClick={onForceClose} disabled={!!closingTab} style={{
            marginLeft:'auto', padding:'6px 14px', borderRadius:8,
            cursor: closingTab ? 'wait' : 'pointer', fontFamily:'inherit',
            background:'#f59e0b', border:'none', color:'#0b0c10',
            fontSize:12, fontWeight:800, opacity: closingTab ? 0.6 : 1,
          }}>
            {closingTab ? 'Capturing…' : '🔒 Close & charge'}
          </button>
        ) : (
          <button onClick={onAdvance} style={{
            marginLeft:'auto', padding:'6px 14px', borderRadius:8,
            cursor:'pointer', fontFamily:'inherit',
            background:'var(--acc)', border:'none', color:'#0b0c10',
            fontSize:12, fontWeight:800,
          }}>
            Advance →
          </button>
        )}
      </div>
    </div>
  );
}

function Section({ title, icon, color, count, children }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ marginBottom:20 }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10, cursor:'pointer', userSelect:'none' }}>
        <div style={{ height:2, flex:1, background:`${color}40`, borderRadius:1 }} />
        <div style={{ display:'flex', alignItems:'center', gap:7, padding:'4px 12px', borderRadius:20, background:`${color}18`, border:`1px solid ${color}44` }}>
          <span>{icon}</span>
          <span style={{ fontSize:12, fontWeight:800, color }}>{title}</span>
          <span style={{ fontSize:11, fontWeight:700, padding:'0 5px', borderRadius:8, background:color, color:'#0b0c10' }}>{count}</span>
        </div>
        <div style={{ height:2, flex:1, background:`${color}40`, borderRadius:1 }} />
        <span style={{ fontSize:10, color, opacity:.7, marginLeft:4 }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && children}
    </div>
  );
}

// ── Order card ────────────────────────────────────────────────────────────────
// v5.5.658: each card is isolated in an error boundary so one malformed order can't throw
// during render and white-screen the whole Orders surface (which also tears down printing).
function OrderCard(props) {
  return (
    <CardErrorBoundary label={`Order ${props.order?.ref || ''}`}>
      <OrderCardInner {...props} />
    </CardErrorBoundary>
  );
}

function OrderCardInner({ order, onAdvance, onAccept, onReject, onOpen, onForceClose, closingTab }) {
  // v5.5.150: QR open-tab detection. Customer set tab_open=true at tab
  // creation; we surface a "Close & charge" button so the operator can
  // capture the pre-auth at end-of-meal.
  const isOpenTab = order._kind === 'queue' && order.customer?.tab_open === true && !order.customer?.tab_closed;
  const tab    = FILTER_TABS.find(t => t.id === order.channel) || FILTER_TABS[0];
  const color  = SECTION_COLORS[order.channel] || 'var(--acc)';
  const qs     = Q_STATUS[order.status] || Q_STATUS.received;
  const el     = elapsed(order.sentAt || order.createdAt);
  const items  = order.items || [];

  let statusText  = qs.label;
  let statusColor = qs.color;
  if (order.status === 'bill_req')  { statusText = 'Bill req.';    statusColor = '#ef4444'; }
  if (order.status === 'ordering')  { statusText = 'Building…';    statusColor = '#888780'; }
  if (order.status === 'scheduled') {
    // v4.6.61: dedicated label + colour for orders parked awaiting their fire time
    const fireAt = order._raw?.scheduledFireAt;
    if (fireAt) {
      const t = new Date(fireAt);
      statusText = `Fires ${t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
    } else {
      statusText = 'Scheduled';
    }
    statusColor = '#a855f7'; // violet — distinct from prep/ready
  }
  if (order.status === 'active' && order._kind === 'table') { statusText = 'In service';  statusColor = '#3b82f6'; }
  if (order.status === 'active' && order._kind === 'tab')   { statusText = 'Open tab';    statusColor = '#a855f7'; }

  const NEXT = { received:'Mark in prep →', prep:'Mark ready →', ready:'Mark collected →' };
  // HubRise channel orders start at 'received' and must be Accepted/Rejected first
  // (which sends a confirmed prep time back to the channel) before the prep flow.
  const isHubriseNew = order.source === 'hubrise' && order.status === 'received';
  const canAdvance = order._kind === 'queue' && !!NEXT[order.status] && !isHubriseNew;

  return (
    <div style={{
      background:'var(--bg1)', borderRadius:13, overflow:'hidden',
      border:`1.5px solid ${color}28`,
      display:'flex', flexDirection:'column',
      transition:'border-color .12s',
    }}
    onMouseEnter={e => e.currentTarget.style.borderColor = `${color}66`}
    onMouseLeave={e => e.currentTarget.style.borderColor = `${color}28`}>
      {/* Colour strip */}
      <div style={{ height:3, background:`linear-gradient(90deg,${color},${color}88)` }}/>

      {/* Header */}
      <div style={{ padding:'10px 13px', display:'flex', gap:10, alignItems:'flex-start' }}>
        <span style={{ fontSize:20 }}>{tab.icon}</span>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:'flex', gap:6, alignItems:'baseline', flexWrap:'wrap' }}>
            <span style={{ fontSize:13, fontWeight:800, color:'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:150 }}>
              {order.displayName}
            </span>
            <span style={{ fontSize:10, color:'var(--t4)', fontFamily:'var(--font-mono)', flexShrink:0 }}>{order.ref}</span>
            {order.isChild && <span style={{ fontSize:9, padding:'1px 5px', borderRadius:8, background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t4)' }}>split</span>}
            {order.source === 'kiosk' && <span style={{ fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:8, background:'#8b5cf618', border:'1px solid #8b5cf644', color:'#8b5cf6' }}>KIOSK</span>}
            {order.source === 'hubrise' && <span style={{ fontSize:9, fontWeight:800, padding:'1px 6px', borderRadius:8, background:'#ef444418', border:'1px solid #ef444455', color:'#ef4444', letterSpacing:'.03em' }}>{(order.customer?.channel || 'HUBRISE').toUpperCase()}</span>}
            {(order.paid || order.customer?.paid) && <span style={{ fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:8, background:'#22c55e18', border:'1px solid #22c55e44', color:'#22c55e' }}>PAID</span>}
          </div>
          <div style={{ display:'flex', gap:8, marginTop:3, flexWrap:'wrap' }}>
            {order.server  && <span style={{ fontSize:10, color:'var(--t3)' }}>👤 {order.server}</span>}
            {order.covers  && <span style={{ fontSize:10, color:'var(--t3)' }}>🧑 {order.covers}</span>}
            {el            && <span style={{ fontSize:10, color:'var(--t4)' }}>⏱ {el}</span>}
            {order.collectionTime && <span style={{ fontSize:10, fontWeight:700, color:'var(--acc)' }}>{order.isASAP ? '⚡ ASAP' : `⏰ ${order.collectionTime}`}</span>}
          </div>
        </div>
        <span style={{ fontSize:10, fontWeight:700, padding:'3px 8px', borderRadius:12, background:`${statusColor}18`, color:statusColor, border:`1px solid ${statusColor}40`, whiteSpace:'nowrap', flexShrink:0 }}>
          {statusText}
        </span>
      </div>

      {/* Items */}
      <div style={{ padding:'0 13px 10px', flex:1 }}>
        {items.length === 0 ? (
          <div style={{ fontSize:11, color:'var(--t4)', fontStyle:'italic' }}>No items yet</div>
        ) : (
          <>
            {items.slice(0, 4).map((item, i) => (
              <div key={i} style={{ display:'flex', gap:6, marginBottom:2, alignItems:'baseline' }}>
                <span style={{ fontSize:11, fontWeight:800, color:'var(--t4)', fontFamily:'var(--font-mono)', minWidth:18, textAlign:'right', flexShrink:0 }}>{item.qty}×</span>
                <span style={{ fontSize:12, color:'var(--t1)', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {item.kitchenName || item.receiptName || item.name}
                </span>
                <span style={{ fontSize:11, color:'var(--t3)', fontFamily:'var(--font-mono)', flexShrink:0 }}>{money(item.price * item.qty)}</span>
              </div>
            ))}
            {items.length > 4 && <div style={{ fontSize:10, color:'var(--t4)', marginTop:3 }}>+{items.length - 4} more…</div>}
          </>
        )}
      </div>

      {/* Footer */}
      <div style={{ padding:'8px 13px', borderTop:'1px solid var(--bdr)', background:'var(--bg2)', display:'flex', alignItems:'center', gap:8 }}>
        <span style={{ fontSize:14, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>{money(order.total)}</span>
        <span style={{ fontSize:10, color:'var(--t4)' }}>{items.length} item{items.length !== 1 ? 's' : ''}</span>
        {/* v5.5.150: tab badge so operators can spot QR open-tabs at a glance */}
        {isOpenTab && (
          <span style={{ fontSize:9, fontWeight:800, padding:'2px 7px', borderRadius:8,
            background:'#fde68a', color:'#78350f', border:'1px solid #f59e0b', letterSpacing:'.04em',
          }}>TAB · {currencySymbol()}{order.customer?.pre_auth_amount ?? '?'} HELD</span>
        )}
        <div style={{ marginLeft:'auto', display:'flex', gap:5 }}>
          <button onClick={onOpen} style={{ padding:'4px 10px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t2)', fontSize:11, fontWeight:600 }}>
            Open →
          </button>
          {/* v5.5.150: force-close-and-charge button for open QR tabs.
              Capture flows through /api/stripe-capture on the connected
              account; on success closed_checks is written and the row
              is marked collected. */}
          {isOpenTab && (
            <button onClick={onForceClose} disabled={!!closingTab} style={{
              padding:'4px 12px', borderRadius:7, cursor: closingTab ? 'wait' : 'pointer',
              fontFamily:'inherit', background:'#f59e0b', border:'none', color:'#0b0c10',
              fontSize:11, fontWeight:800, opacity: closingTab ? 0.6 : 1,
            }}>
              {closingTab ? 'Capturing…' : '🔒 Close & charge'}
            </button>
          )}
          {isHubriseNew && (
            <>
              <button onClick={onReject} style={{ padding:'4px 10px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', background:'transparent', border:'1px solid #ef444455', color:'#ef4444', fontSize:11, fontWeight:700 }}>
                Reject
              </button>
              <button onClick={onAccept} style={{ padding:'4px 12px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', background:'#22c55e', border:'none', color:'#0b0c10', fontSize:11, fontWeight:800 }}>
                Accept →
              </button>
            </>
          )}
          {!isOpenTab && canAdvance && (() => {
            // v5.5.659: the final step on an order that still owes money is "Charge", not
            // "Mark collected" — it opens the order for payment (advance() routes it there).
            const chargeStep = order.status === 'ready' && !isOrderPaid(order);
            return (
              <button onClick={onAdvance} style={{ padding:'4px 12px', borderRadius:7, cursor:'pointer', fontFamily:'inherit',
                background: chargeStep ? '#16a34a' : 'var(--acc)', border:'none', color: chargeStep ? '#fff' : '#0b0c10', fontSize:11, fontWeight:800 }}>
                {chargeStep ? `Charge ${money(order.total)} →` : NEXT[order.status]}
              </button>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────
function EmptyState({ filter, search, myOrders, staff }) {
  const tab = FILTER_TABS.find(t => t.id === filter);
  if (search)   return <Blank icon="🔍" title={`No results for "${search}"`} sub="Try a different name or order reference" />;
  if (myOrders) return <Blank icon="👤" title={`No active orders for ${staff?.name || 'you'}`} sub="Your orders will appear here once sent" />;
  if (filter !== 'all') return <Blank icon={tab?.icon || '⊞'} title={`No active ${tab?.label || ''} orders`} sub="Orders will appear here once sent" />;
  return <Blank icon="⊞" title="No active orders" sub="Orders from all terminals appear here once sent to kitchen" />;
}

function Blank({ icon, title, sub }) {
  return (
    <div style={{ textAlign:'center', padding:'64px 20px', color:'var(--t4)' }}>
      <div style={{ fontSize:40, marginBottom:14, opacity:.15 }}>{icon}</div>
      <div style={{ fontSize:14, fontWeight:700, color:'var(--t2)', marginBottom:6 }}>{title}</div>
      {sub && <div style={{ fontSize:12, lineHeight:1.6 }}>{sub}</div>}
    </div>
  );
}
