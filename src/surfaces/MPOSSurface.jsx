// src/surfaces/MPOSSurface.jsx
//
// v5.5.61 — Phase 1B of MPOS. Adds the order-taking flow on top of the 1A
// scaffold. Phone-native router with a bottom tab bar (Home / Orders / Tables
// / Me) PLUS an overlay flow state machine that takes over the screen when a
// new order is being entered — bottom tabs hide during active flow so the
// server's full attention is on the task.
//
// Flow states (overlay over the tabs):
//   • newOrder  — order-type picker (MNewOrder)
//   • covers    — pick covers for a freshly-tapped empty table (MCoversPicker)
//   • tableView — active order screen for a seated table (MTableView)
//   • menu      — search-first menu browser (MMenu)
//   • item      — full-screen modifier flow (MItemDetail)
//   • cart      — order review / send / tender (MCartSheet)
//
// Phase 1C will replace the placeholder "Send & take payment" with the real
// MTender wizard (card via REST + simulated). Phase 1D adds order management
// (refunds, voids, manager-PIN, swipe actions).

import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../store';
import useSupabaseInit from '../lib/useSupabaseInit';
import { queueWrite, dismissItem } from '../sync/OfflineQueue';
import { getActiveLocationSync, isMock } from '../lib/supabase';
import { isTrainingMode } from '../lib/trainingMode';
import { getNextOrderRefLocal } from '../lib/db';
import { calculateOrderTax } from '../lib/tax';
import PINScreen from './PINScreen';
import MHome from './mpos/MHome';
import MOrdersList from './mpos/MOrdersList';
import MTablesList from './mpos/MTablesList';
import MMe from './mpos/MMe';
import MNewOrder from './mpos/MNewOrder';
import MCustomerCapture from './mpos/MCustomerCapture';
import MCoversPicker from './mpos/MCoversPicker';
import MTableView from './mpos/MTableView';
import MMenu from './mpos/MMenu';
import MItemDetail from './mpos/MItemDetail';
import MVariantPicker from './mpos/MVariantPicker';
import MCartSheet from './mpos/MCartSheet';
import MSentConfirm from './mpos/MSentConfirm';
import MTender from './mpos/MTender';
import MCardFlow from './mpos/MCardFlow';
import MReceiptPrompt from './mpos/MReceiptPrompt';
import MDone from './mpos/MDone';
import MOrderHistory from './mpos/MOrderHistory';
import MOrderDetail from './mpos/MOrderDetail';
import MQueueDetail from './mpos/MQueueDetail';
import { Sx, money } from './mpos/MShellStyles';

const TABS = [
  { id:'home',   label:'Home',   icon:'🏠' },
  { id:'orders', label:'Orders', icon:'📋' },
  { id:'tables', label:'Tables', icon:'🪑' },
  { id:'me',     label:'Me',     icon:'⚙' },
];

export default function MPOSSurface() {
  const { staff } = useStore();

  // v5.5.79 fix — hydrate Supabase state on mount the same way the desktop
  // ValidatedPOSApp does. Without this, rpos-printers never gets populated
  // from the printers table, so _printerForRole('receipt') returns null and
  // every print attempt falls back to browser print (which doesn't open a
  // dialog on iOS). Also hydrates closed_checks, tax rates, shift, cash
  // drawers, etc. — all of which MPOS uses.
  useSupabaseInit();

  // v5.5.350: ServOS skin flag (staff surface) — on <html> so portaled UI inherits it.
  useEffect(() => {
    document.documentElement.setAttribute('data-skin', 'servos');
    return () => document.documentElement.removeAttribute('data-skin');
  }, []);

  // PWA + viewport — same as 1A
  useEffect(() => {
    const manifestLink = document.querySelector('link[rel="manifest"]');
    const prevHref = manifestLink?.getAttribute('href');
    if (manifestLink) manifestLink.setAttribute('href', '/mpos-manifest.json');
    const viewport = document.querySelector('meta[name="viewport"]');
    const prevViewport = viewport?.getAttribute('content');
    if (viewport) viewport.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no');
    return () => {
      if (manifestLink && prevHref) manifestLink.setAttribute('href', prevHref);
      if (viewport && prevViewport) viewport.setAttribute('content', prevViewport);
    };
  }, []);

  // v5.5.971 — MPOS NEVER RENDERED TOASTS (see MPOSToast below).
  if (!staff) return <><PINScreen /><MPOSToast /></>;
  return <><MPOSRouter /><MPOSToast /></>;
}

// v5.5.971 — store.showToast() sets `toast`, but the only <Toast> in the app lives
// inside the POS shell (App.jsx ValidatedPOSApp) and MPOS returns from an EARLIER
// branch (App.jsx:284) — so every confirmation AND every error raised anywhere in
// the MPOS tree has been silently discarded since MPOS was built. Same family as
// the vanishing-categories saga: the app knew, the server never did.
// Mirrors BackOfficeToast in src/backoffice/BackOfficeApp.jsx.
function MPOSToast() {
  const toast = useStore(s => s.toast);
  if (!toast) return null;
  const map = {
    success: { bg:'var(--grn-d)', bdr:'var(--grn-b)', color:'var(--grn)' },
    error:   { bg:'var(--red-d)', bdr:'var(--red-b)', color:'var(--red)' },
    warning: { bg:'var(--acc-d)', bdr:'var(--acc-b)', color:'var(--acc)' },
    info:    { bg:'var(--bg3)',   bdr:'var(--bdr2)',  color:'var(--t1)'  },
  };
  const c = map[toast.type] || map.info;
  return (
    <div className="toast" key={toast.key}
      style={{ background:c.bg, border:`1px solid ${c.bdr}`, color:c.color, zIndex:100003 }}>
      {toast.msg}
    </div>
  );
}

// Which courses a plain send actually fires: 0 (immediate) plus every course up to
// the lowest occupied one. MIRRORS computeFiredOnSend in store/index.js — later
// courses are held back deliberately, so "still pending" is only evidence of a lost
// send for a course that was in this set.
function firedCoursesOnSend(items) {
  const live = (items || []).filter(i => !i.voided && (i.status === 'pending' || i.status === 'sent'));
  const lowest = [...new Set(live.map(i => i.course ?? 1))].filter(c => c >= 1).sort((a, b) => a - b)[0] || 1;
  const fired = [0];
  for (let c = 1; c <= lowest; c++) fired.push(c);
  return fired;
}

function MPOSRouter() {
  const { deviceConfig, activeTableId, setActiveTableId, showToast } = useStore();
  const runnerMode = !!deviceConfig?.runnerMode;

  const [tab, setTab] = useState(runnerMode ? 'orders' : 'home');
  // flow.screen: null | 'newOrder' | 'covers' | 'tableView' | 'menu' | 'item' | 'cart'
  // flow.context carries flow-specific state (selected table, item, etc.)
  const [flow, setFlow] = useState({ screen: null });

  // v5.5.977 — the two failures the server must never be able to walk past.
  // closeFailure: the card was APPROVED and the sale did not record (money gone,
  // no closed_checks row, nothing in the Z report). kitchenFailure: the kitchen
  // never saw food the customer is about to pay for. Both were console-only.
  const [closeFailure, setCloseFailure]     = useState(null);
  const [kitchenFailure, setKitchenFailure] = useState(null);

  const closeFlow = useCallback(() => {
    setFlow({ screen: null });
    // Keep activeTableId set when returning to tabs — it lets the user resume
    // the same table by tapping it again.
  }, []);

  // ── Flow entry points ────────────────────────────────────────────────────

  // Floating "+" → start new order
  const startNewOrder = () => setFlow({ screen: 'newOrder' });

  // After picking type in MNewOrder
  const onPickType = (type) => {
    useStore.getState().setOrderType(type);
    if (type === 'dine-in') {
      setFlow({ screen: 'pickTable' });
      return;
    }
    // Reset prior walk-in state. Takeaway / collection / delivery all route
    // through the customer-capture screen first — like the counter POS, they
    // need at least a name + phone before the menu (kitchen ticket, queue row,
    // receipt). v5.5.341: takeaway was previously skipping capture.
    useStore.setState({ walkInOrder: null, customer: null, activeTableId: null });
    if (type === 'collection' || type === 'delivery' || type === 'takeaway') {
      setFlow({ screen: 'customerCapture' });
    } else {
      setFlow({ screen: 'menu', context: { source: 'walkin' } });
    }
  };

  // Tap a table from MTablesList
  const onPickTable = (table) => {
    if (!table) return;
    if (!table.session) {
      // Empty table → cover picker
      setFlow({ screen: 'covers', context: { table } });
    } else {
      // Existing session → table view
      useStore.setState({ walkInOrder: null });
      setActiveTableId(table.id);
      useStore.getState().setOrderType('dine-in');
      setFlow({ screen: 'tableView', context: { tableId: table.id } });
    }
  };

  // After cover-picker seats a table → table view
  const onSeated = () => {
    const tableId = flow.context?.table?.id;
    if (tableId) setFlow({ screen: 'tableView', context: { tableId } });
  };

  // From TableView/walk-in menu cart-bar → menu
  const goMenu = () => setFlow(f => ({ screen: 'menu', context: f.context || {} }));
  // From menu → item detail. Variant parents are detected by the existence of
  // ANY menu item whose parentId points back at this item — that's a more
  // robust check than reading `type === 'variants'` (the type field varies by
  // data source — Supabase rows might use a different value, etc.). When a
  // variant parent is tapped we open the picker; otherwise straight to the
  // item-detail modifier flow.
  const goItem = (item) => {
    const items = useStore.getState().menuItems || [];
    const hasChildren = items.some(m => m.parentId === item.id);
    if (hasChildren) {
      setFlow(f => ({ screen: 'variantPicker', context: { ...(f.context||{}), parent: item } }));
      return;
    }
    setFlow(f => ({ screen: 'item', context: { ...(f.context||{}), item } }));
  };
  // From menu/table-view → cart
  const goCart = () => setFlow(f => ({ screen: 'cart', context: f.context || {} }));
  // From item → back to menu (after add)
  const goBackToMenu = () => setFlow(f => ({ screen: 'menu', context: f.context || {} }));

  // After Send to Kitchen — show the post-send confirmation with clear next-step
  // CTAs (Take next order / Stay here / Take payment). Replaces the silent
  // back-to-table-view return that left the server with no signposted exit.
  const onSentToKitchen = () => {
    const tableId = flow.context?.tableId || activeTableId;
    const state = useStore.getState();
    let ticketCount = 0;
    let totalSent = 0;
    if (tableId) {
      const tbl = state.tables.find(t => t.id === tableId);
      const sent = (tbl?.session?.items || []).filter(i => i.status === 'sent' && !i.voided);
      ticketCount = sent.reduce((s, i) => s + (i.qty || 0), 0);
      totalSent = sent.reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0);
    } else if (state.walkInOrder) {
      const sent = (state.walkInOrder.items || []).filter(i => i.status === 'sent' && !i.voided);
      ticketCount = sent.reduce((s, i) => s + (i.qty || 0), 0);
      totalSent = sent.reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0);
    }
    setFlow({ screen: 'sentConfirm', context: { tableId, ticketCount, totalSent } });
  };

  // Fire the kitchen for the live walk-in order and REPORT whether it worked.
  // sendToKitchen is synchronous and can throw (routing / print / KDS insert), and
  // it can also quietly do nothing — either way the lines stay 'pending' and the
  // customer is about to pay for food nobody is cooking. Returns null on success,
  // otherwise a failure descriptor for the blocking screen.
  const sendWalkInToKitchen = () => {
    const before = useStore.getState();
    const items = before.walkInOrder?.items || [];
    const pending = items.filter(i => i.status !== 'sent' && !i.voided);
    if (!pending.length) return null;
    const fired = firedCoursesOnSend(items);
    let err = null;
    try { before.sendToKitchen?.(); } catch (e) { err = e; }
    const after = useStore.getState();
    // A non-ASAP collection is held back ON PURPOSE: sendToKitchen parks it in the
    // queue as status 'scheduled' and a background tick fires the kitchen nearer
    // the time. Lines still pending in that case are correct, not lost.
    if (!err && after.customer?.collectionTime && !after.customer?.isASAP) return null;
    // Only lines whose course this send was supposed to FIRE count as lost. Later
    // courses stay 'pending' by design on every multi-course order.
    const lost = (after.walkInOrder?.items || []).filter(i =>
      i.status === 'pending' && !i.voided && fired.includes(i.course ?? 1));
    if (!err && !lost.length) return null;
    return {
      count: lost.length || pending.length,
      message: err ? String(err.message || err) : null,
    };
  };

  // Walk-in "Send & take payment" or table "Take payment" → tender flow (1C)
  const onSendAndPay = () => {
    // For walk-in flows, fire to kitchen first if anything is still pending. The
    // tender wizard then takes over.
    // v5.5.977: this was `try { sendToKitchen() } catch {}` — a throw opened the
    // tender wizard anyway and the customer paid for food the kitchen never saw.
    if (!activeTableId) {
      const fail = sendWalkInToKitchen();
      if (fail) { setKitchenFailure({ ...fail, next: 'tender' }); return; }
    }
    setFlow({ screen: 'tender', context: flow.context || {} });
  };

  // Rebuild the record a healthy close would have written, so a failed close can
  // still be replayed. Table closes reuse the store's OWN builder — the recovered
  // row must not drift from the real one.
  const buildRecoveryRecord = (paymentInfo, tableId) => {
    const st = useStore.getState();
    if (tableId) {
      const table = st.tables.find(t => t.id === tableId);
      if (!table?.session) return null;
      // A QR tab's money story is the held pre-auth plus its order_queue rounds. A
      // plain closed_check queued from here would double-book it and orphan the
      // capture — Orders Hub → Open QR tabs is the only correct closer.
      if (table.session.source === 'qr') return null;
      return st.buildCloseRecord(table.session, table, paymentInfo);
    }
    const order = st.walkInOrder;
    if (!order?.items?.length) return null;
    const items = order.items.filter(i => !i.voided).map(i => ({ ...i }));
    const subtotal = items.reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0);
    const orderType = st.orderType || 'takeaway';
    let taxBreakdown = null;
    if (st.taxRates?.length) {
      try { taxBreakdown = calculateOrderTax(items, st.taxRates, orderType); }
      catch { /* leave VAT unsplit rather than book a guess */ }
    }
    return {
      // onPaymentApproved guarantees this — the recovery row and the row a retry
      // writes MUST share an id or the upsert books the sale twice.
      id:         paymentInfo.closedCheckId,
      ref:        order.ref || getNextOrderRefLocal(),
      tableId:    null,
      tableLabel: null,
      server:     st.staff?.name || 'Staff',
      staffId:    st.staff?.id || null,
      covers:     1,
      orderType,
      customer:   st.customer || null,
      items,
      discounts:  order.discounts || [],
      subtotal,
      service:    0,
      tip:        paymentInfo?.tip || 0,
      total:      paymentInfo?.grand || subtotal,
      taxAmount:  taxBreakdown?.totalTax != null ? taxBreakdown.totalTax : null,
      taxBreakdown,
      method:     paymentInfo?.method || 'card',
      giftCard:   paymentInfo?.giftCard || null,
      stripePaymentIntentId: paymentInfo?.stripePaymentIntentId || paymentInfo?.paymentIntentId || null,
      processor:  paymentInfo?.processor || 'stripe',
      cardReceipt: paymentInfo?.cardReceipt || null,
      drawerId:   st.myDrawer?.()?.id || null,
      shiftId:    st.currentShift?.id || null,
      closedAt:   Date.now(),
      status:     'paid',
      refunds:    [],
      // NO custom `source` — closed_checks_source_check rejects unknown values and
      // this row must land. null falls back to the 'pos' default.
    };
  };

  // Durable last resort for a sale whose close failed AFTER the card was approved.
  // Same IndexedDB queue every other offline write uses; kind 'closed_check' puts it
  // in OfflineQueue's ALWAYS_REPLAY set so the staleness guard can never quarantine a
  // sale. The queue key is derived from the check id so a second attempt REPLACES the
  // buffered copy instead of stacking another one. Returns whether it is buffered.
  const queueCloseRecovery = async (paymentInfo, tableId) => {
    if (isMock || isTrainingMode()) return true;   // nothing was ever going to persist
    try {
      const locationId = getActiveLocationSync();
      const record = buildRecoveryRecord(paymentInfo, tableId);
      if (!locationId || !record) return false;
      await queueWrite({
        id: recoveryQueueId(record.id),
        type: 'upsert',
        table: 'closed_checks',
        onConflict: 'id',
        kind: 'closed_check',
        label: `MPOS ${money(Number(paymentInfo?.grand) || 0)} — close failed after card approval`,
        payload: recoveryCheckRow(record, locationId),
      });
      return true;
    } catch (e) {
      console.error('[mpos] could not buffer the unrecorded sale', e);
      return false;
    }
  };

  // The card is approved and the money is gone — nothing here can undo that, so the
  // goal is only "never lose the sale record". Buffer it and hold the operator on the
  // payment screen.
  const onCloseFailed = async (err, paymentInfo, tableId) => {
    console.error('[mpos] close failed after card approval', err);
    const amount = Number(paymentInfo?.grand) || 0;
    setCloseFailure({ amount, paymentInfo, tableId, message: String(err?.message || err), queued: null });
    showToast?.(`${money(amount)} was taken but the sale was NOT recorded — do not charge again`, 'error');
    const queued = await queueCloseRecovery(paymentInfo, tableId);
    setCloseFailure(f => (f ? { ...f, queued } : f));   // null = operator already retried
  };

  // After payment is approved (card REST or simulated). Closes the check AND
  // releases the table session so the table goes back to "available". Earlier
  // versions called recordClosedCheck only, which left the table stuck on the
  // floor plan as occupied even though the customer had paid.
  //
  // v5.5.977 — EVERYTHING HERE RUNS AFTER THE CARD IS APPROVED. The old body
  // swallowed a close failure with console.warn and advanced to the receipt screen
  // with closedCheck = null: money captured, no closed_checks row, nothing in the Z
  // report, table still occupied — behind a completely normal-looking receipt
  // prompt. There is no rollback, so a failure now stops the flow dead.
  const onPaymentApproved = (paymentInfo) => {
    const state = useStore.getState();
    const tableId = activeTableId;
    const isQrTab = !!tableId && state.tables.find(t => t.id === tableId)?.session?.source === 'qr';
    // ONE id per payment attempt, minted BEFORE the close and carried through the
    // failure state into the retry. buildCloseRecord and recordWalkInClosed both adopt
    // paymentInfo.closedCheckId, so a retry rewrites the SAME closed_checks row instead
    // of minting a second one the upsert can't collapse (= the sale counted twice).
    const pi = paymentInfo?.closedCheckId
      ? paymentInfo
      : { ...paymentInfo, closedCheckId: `chk-${Date.now()}` };
    // A first attempt can book the record and still throw on a later step (loyalty,
    // drawer, Challenge 21…). The id is stable, so a retry adopts that row instead of
    // closing the same sale twice.
    let closedCheck = state.closedChecks.find(c => c.id === pi.closedCheckId) || null;
    let failure = null;
    try {
      if (closedCheck) {
        /* already recorded — nothing to redo */
      } else if (tableId) {
        // clearTable internally calls recordClosedCheck AND resets the table
        // session/status so the table flips to available + walkInOrder/customer
        // get cleared. Same path the desktop POS uses on close.
        state.clearTable(tableId, pi);
        // clearTable returns nothing and refuses outright for a QR tab, so look our
        // OWN check up by id — head-of-list would hand the PREVIOUS customer's check
        // to the receipt, and on a retry it also proves the first attempt did land.
        closedCheck = useStore.getState().closedChecks.find(c => c.id === pi.closedCheckId) || null;
      } else if (state.walkInOrder) {
        // Take the record the store returns rather than looking it up: a HubRise
        // channel close mints its own deterministic chk-hr-<ref> id.
        closedCheck = state.recordWalkInClosed(
          state.walkInOrder, state.orderType || 'takeaway', state.customer, pi,
        ) || null;
      }
      if (!closedCheck) {
        throw new Error(isQrTab
          ? 'this is a QR tab — it can only be closed from Orders Hub → Open QR tabs'
          : 'the close produced no sale record');
      }
    } catch (e) {
      failure = e;
    }

    if (failure) { onCloseFailed(failure, pi, tableId); return; }

    // A retry landed on the same id, so the buffered copy is now redundant — left in
    // the queue it would later replay the lossy rebuild over the real row. Dropped
    // unconditionally: the buffering is async, so `queued` may not be set yet.
    if (closeFailure) {
      dismissItem(recoveryQueueId(pi.closedCheckId)).catch(() => {});
      setCloseFailure(null);
    }
    // Walk-in-side cleanup: drop the now-paid order from local state. Only once the
    // record exists — on failure the cart has to survive so a retry can rebuild it.
    if (!tableId) useStore.setState({ walkInOrder: null, customer: null });
    // Belt-and-braces: clear activeTableId so the next "Take next order" lands
    // on a clean slate even if clearTable's reducer hasn't propagated yet.
    setActiveTableId(null);
    // The sale is safe but the floor may not be: a partial clearTable can record the
    // check and still leave the table sat occupied with nobody knowing why.
    if (tableId && useStore.getState().tables.find(t => t.id === tableId)?.session) {
      showToast?.('Sale recorded, but the table did not clear — clear it on the floor plan', 'warning');
    }
    setFlow({ screen: 'receipt', context: { check: closedCheck } });
  };

  // closeFailure.paymentInfo already carries the closedCheckId minted for the first
  // attempt — replaying it is what makes the retry idempotent. onPaymentApproved
  // clears closeFailure itself, but only once the sale is genuinely recorded.
  const retryClose = () => onPaymentApproved(closeFailure?.paymentInfo || {});

  // After receipt prompt resolves
  const onReceiptDone = (deliveredVia) => {
    setFlow({ screen: 'done', context: { ...flow.context, deliveredVia: deliveredVia?.deliveredVia ?? deliveredVia } });
  };

  // "Take next order" on MDone → reset to home.
  // Must clear closeFailure too: the blocking screen below is checked BEFORE flow.screen,
  // so leaving it set sends the operator straight back to it and the handheld takes no
  // further orders until the page is reloaded.
  const onAllDone = () => {
    setCloseFailure(null);
    setActiveTableId(null);
    useStore.setState({ walkInOrder: null, customer: null });
    setFlow({ screen: null });
    setTab(runnerMode ? 'orders' : 'home');
  };

  // ── Blocking post-authorisation failures ─────────────────────────────────
  // These sit ABOVE every other branch. flow.screen is left exactly where it was
  // (still 'card' for a failed close), so nothing has navigated — the server simply
  // cannot get past this screen without dealing with it.

  if (closeFailure) {
    return (
      <MCloseFailed
        amount={closeFailure.amount}
        queued={closeFailure.queued}
        message={closeFailure.message}
        onRetry={retryClose}
        onContinue={onAllDone}
      />
    );
  }

  if (kitchenFailure) {
    return (
      <MKitchenSendFailed
        count={kitchenFailure.count}
        message={kitchenFailure.message}
        continueLabel={kitchenFailure.next === 'tender' ? 'Take payment anyway' : 'Carry on anyway'}
        onRetry={() => {
          const next = kitchenFailure.next;
          setKitchenFailure(null);
          if (next === 'tender') { onSendAndPay(); return; }
          const fail = sendWalkInToKitchen();
          if (fail) { setKitchenFailure({ ...fail, next: 'sent' }); return; }
          onSentToKitchen();
        }}
        onContinue={() => {
          const next = kitchenFailure.next;
          setKitchenFailure(null);
          if (next === 'tender') setFlow({ screen: 'tender', context: flow.context || {} });
          else onSentToKitchen();
        }}
      />
    );
  }

  // ── Render flow overlays first so they sit above everything ──────────────

  if (flow.screen === 'newOrder') {
    return (
      <div style={Sx.shell}>
        <BlankBg />
        <MNewOrder onPick={onPickType} onClose={closeFlow} />
      </div>
    );
  }

  if (flow.screen === 'customerCapture') {
    const orderType = useStore.getState().orderType;
    return (
      <MCustomerCapture
        orderType={orderType}
        onContinue={() => setFlow({ screen: 'menu', context: { source: 'walkin' } })}
        onSkip={() => setFlow({ screen: 'menu', context: { source: 'walkin' } })}
        onBack={() => setFlow({ screen: 'newOrder' })}
      />
    );
  }

  if (flow.screen === 'pickTable') {
    // Inline full-screen table picker as part of the new-order flow. The user
    // tapped Dine in and now picks where to seat the guests. Back arrow goes
    // back to the order-type sheet (MNewOrder).
    return (
      <div style={Sx.shell}>
        <div style={{ ...Sx.body, display:'flex', flexDirection:'column' }}>
          <MTablesList onPickTable={onPickTable} />
          <div style={{ ...Sx.bottom, borderTop:'1px solid var(--bdr)' }}>
            <button onClick={() => setFlow({ screen:'newOrder' })} style={Sx.btnGhost}>
              ← Back to order types
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (flow.screen === 'variantPicker' && flow.context?.parent) {
    return (
      <div style={Sx.shell}>
        <BlankBg />
        <MVariantPicker
          parent={flow.context.parent}
          onPick={(variant) => {
            // Synthesize a combined display name "Parent — Variant" so the
            // cart line, kitchen ticket and receipt all show the full
            // identity (e.g. "Lager — Half" rather than just "Half"). Some
            // data sources store the child's name as just the size; others
            // store it pre-combined. We detect the case-insensitive presence
            // of the parent name to avoid double-combining.
            const parent = flow.context.parent;
            const parentName = parent?.name || '';
            const childName = variant?.name || '';
            const alreadyCombined = parentName && childName.toLowerCase().includes(parentName.toLowerCase());
            const combinedName = alreadyCombined
              ? childName
              : (parentName ? `${parentName} — ${variant.menuName || childName}` : childName);
            const displayItem = { ...variant, name: combinedName };
            setFlow(f => ({ screen:'item', context:{ ...(f.context||{}), item: displayItem, parent: undefined } }));
          }}
          onClose={() => setFlow(f => ({ screen:'menu', context: f.context || {} }))}
        />
      </div>
    );
  }

  if (flow.screen === 'covers' && flow.context?.table) {
    return (
      <MCoversPicker
        table={flow.context.table}
        onSeated={onSeated}
        onCancel={closeFlow}
      />
    );
  }

  if (flow.screen === 'tableView' && flow.context?.tableId) {
    return (
      <MTableView
        tableId={flow.context.tableId}
        onAddItems={goMenu}
        onOpenCart={goCart}
        onPay={onSendAndPay}
        onClose={closeFlow}
        onSendToKitchen={onSentToKitchen}
      />
    );
  }

  if (flow.screen === 'menu') {
    const tableId = flow.context?.tableId || activeTableId;
    const headerTitle = tableId
      ? `Add to Table ${useStore.getState().tables.find(t => t.id === tableId)?.label || ''}`
      : 'New order';
    const orderType = useStore.getState().orderType;
    return (
      <MMenu
        headerTitle={headerTitle}
        headerSub={tableId ? null : (orderType || '').toUpperCase()}
        onPickItem={goItem}
        onOpenCart={goCart}
        onBack={() => {
          if (tableId) setFlow({ screen: 'tableView', context: { tableId } });
          else closeFlow();
        }}
      />
    );
  }

  if (flow.screen === 'item' && flow.context?.item) {
    return (
      <MItemDetail
        item={flow.context.item}
        onClose={() => setFlow(f => ({ screen: 'menu', context: f.context || {} }))}
        onAdded={goBackToMenu}
      />
    );
  }

  if (flow.screen === 'cart') {
    const tableId = flow.context?.tableId || activeTableId;
    return (
      <MCartSheet
        onClose={() => {
          if (tableId) setFlow({ screen: 'tableView', context: { tableId } });
          else setFlow({ screen: 'menu', context: flow.context || {} });
        }}
        onAddMore={goMenu}
        onSend={() => {
          // Same unchecked send as onSendAndPay had — a walk-in that never reached
          // the kitchen must not reach the "sent" confirmation with its Take-payment
          // button. Table sends keep their existing behaviour.
          if (!tableId) {
            const fail = sendWalkInToKitchen();
            if (fail) { setKitchenFailure({ ...fail, next: 'sent' }); return; }
          } else {
            useStore.getState().sendToKitchen?.();
          }
          onSentToKitchen();
        }}
        onSendAndPay={onSendAndPay}
      />
    );
  }

  if (flow.screen === 'sentConfirm') {
    const { tableId, ticketCount, totalSent } = flow.context || {};
    const tableLabel = tableId ? (useStore.getState().tables.find(t => t.id === tableId)?.label) : null;
    return (
      <MSentConfirm
        ticketCount={ticketCount || 0}
        totalSent={totalSent || 0}
        isTable={!!tableId}
        isWalkIn={!tableId}
        tableLabel={tableLabel}
        onTakeNext={() => {
          // Clear active context and start a fresh order. Table stays open in
          // the background — its session lives in the store and the realtime
          // sub keeps it visible to other devices.
          setActiveTableId(null);
          useStore.setState({ walkInOrder: null, customer: null });
          setFlow({ screen: 'newOrder' });
        }}
        onStayHere={() => {
          if (tableId) setFlow({ screen: 'tableView', context: { tableId } });
          else setFlow({ screen: null });
        }}
        onTakePayment={() => {
          // Walk-in or table — both go through MTender. For walk-in we keep
          // walkInOrder intact (sent items remain payable until close).
          setFlow({ screen: 'tender', context: flow.context || {} });
        }}
      />
    );
  }

  if (flow.screen === 'tender') {
    // Customer-facing tip pass — auto-triggers MCardFlow on Confirm. No
    // method picker (card-only on the phone) and no Pay-at-counter (cash
    // belongs at the till where the drawer lives).
    return (
      <MTender
        onBack={() => {
          const tableId = flow.context?.tableId || activeTableId;
          if (tableId) setFlow({ screen: 'tableView', context: { tableId } });
          else setFlow({ screen: 'cart', context: flow.context || {} });
        }}
        onConfirm={(payment) => setFlow(f => ({ screen: 'card', context: { ...(f.context || {}), payment } }))}
      />
    );
  }

  if (flow.screen === 'card' && flow.context?.payment) {
    return (
      <MCardFlow
        payment={flow.context.payment}
        onCancel={() => setFlow(f => ({ screen: 'tender', context: f.context || {} }))}
        onApproved={onPaymentApproved}
      />
    );
  }

  if (flow.screen === 'receipt') {
    return (
      <MReceiptPrompt
        check={flow.context?.check}
        onDone={onReceiptDone}
      />
    );
  }

  if (flow.screen === 'done') {
    return (
      <MDone
        check={flow.context?.check}
        deliveredVia={flow.context?.deliveredVia}
        onNewOrder={onAllDone}
      />
    );
  }

  if (flow.screen === 'history') {
    return (
      <MOrderHistory
        onBack={closeFlow}
        onOpen={(check) => setFlow({ screen: 'orderDetail', context: { check, fromHistory: true } })}
      />
    );
  }

  if (flow.screen === 'queueDetail' && flow.context?.order) {
    return (
      <MQueueDetail
        order={flow.context.order}
        onBack={closeFlow}
      />
    );
  }

  if (flow.screen === 'orderDetail' && flow.context?.check) {
    return (
      <MOrderDetail
        check={flow.context.check}
        onBack={() => {
          // Sensible back: history → history; orders-list tap → close flow
          if (flow.context?.fromHistory) setFlow({ screen: 'history' });
          else closeFlow();
        }}
      />
    );
  }

  // ── Default: tab bar shell ────────────────────────────────────────────────
  return (
    <div style={Sx.shell}>
      <div style={Sx.body}>
        {tab === 'home'   && <MHome onTakeOrder={startNewOrder} onSeeOrders={() => setTab('orders')} onSeeTables={() => setTab('tables')} />}
        {tab === 'orders' && (
          <MOrdersList
            onOpenOrder={(o) => {
              // Tap behaviour depends on the kind of row:
              //  • table   → jump into the live table view
              //  • queue   → not yet supported (order_queue detail) — toast
              //  • closed  → open the closed-check detail (reprint / refund)
              if (o._kind === 'table') {
                setActiveTableId(o.tableId);
                useStore.getState().setOrderType('dine-in');
                setFlow({ screen: 'tableView', context: { tableId: o.tableId } });
              } else if (o._kind === 'closed') {
                // Find the underlying closedChecks row by id (MOrdersList uses
                // the wrapped shape — look up the live record so refunds
                // applied during this session appear immediately).
                const live = useStore.getState().closedChecks.find(c => c.id === (o.id?.replace(/^c-/, '') || o.id));
                setFlow({ screen: 'orderDetail', context: { check: live || o } });
              } else if (o._kind === 'queue') {
                // Live walk-in / takeaway / collection / delivery / kiosk order.
                // Pull the underlying order_queue entry by ref so updates from
                // other devices reflect.
                const live = useStore.getState().orderQueue.find(q => q.ref === o.ref) || o._raw || o;
                setFlow({ screen: 'queueDetail', context: { order: live } });
              } else {
                showToast?.('Live tab order detail lands in next sprint', 'info');
              }
            }}
          />
        )}
        {tab === 'tables' && <MTablesList onPickTable={onPickTable} />}
        {tab === 'me'     && <MMe onOpenHistory={() => setFlow({ screen: 'history' })} />}

        {!runnerMode && tab !== 'me' && (
          <button onClick={startNewOrder} aria-label="New order" style={{
            position:'absolute', right:18, bottom:'calc(76px + env(safe-area-inset-bottom))',
            width:60, height:60, borderRadius:'50%', border:'none',
            background:'var(--acc)', color:'#0b0c10', fontSize:32, fontWeight:800,
            boxShadow:'0 6px 22px rgba(0,0,0,.35), 0 2px 6px rgba(0,0,0,.25)',
            cursor:'pointer', fontFamily:'inherit', zIndex:10,
            display:'flex', alignItems:'center', justifyContent:'center', lineHeight:1,
          }}>+</button>
        )}
      </div>

      <div style={{
        display:'flex', borderTop:'1px solid var(--bdr)', background:'var(--bg1)', flexShrink:0,
        paddingBottom:'env(safe-area-inset-bottom)',
      }}>
        {TABS.map(t => {
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              flex:1, padding:'10px 4px 8px', background:'transparent', border:'none', cursor:'pointer', fontFamily:'inherit',
              display:'flex', flexDirection:'column', alignItems:'center', gap:3, minHeight:60,
              color: active ? 'var(--acc)' : 'var(--t4)',
            }}>
              <div style={{ fontSize:22, lineHeight:1 }}>{t.icon}</div>
              <div style={{ fontSize:10, fontWeight:active ? 800 : 600, letterSpacing:'.04em' }}>{t.label}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Plain background for the new-order bottom sheet so the modal stack has
// something to draw over without the user seeing an empty state.
function BlankBg() {
  return <div style={{ flex:1, background:'var(--bg)' }}/>;
}

// Explicit OfflineQueue key (the store's keyPath, normally auto-incremented) so the
// buffered copy of a sale can be replaced on a re-attempt and dropped once a retry
// records it for real.
function recoveryQueueId(checkId) {
  return `mpos-recovery-${checkId}`;
}

// snake_case row for the recovery write in queueCloseRecovery. This MIRRORS
// closedCheckRow() in src/lib/db.js, which is module-private there — if a column is
// added to that map it has to be added here too. It only ever runs on the path where
// the alternative is no row at all.
function recoveryCheckRow(check, locationId) {
  return {
    id:            check.id,
    location_id:   locationId,
    ref:           check.ref,
    server:        check.server,
    staff_id:      check.staffId || null,
    covers:        check.covers,
    order_type:    check.orderType,
    customer:      check.customer,
    items:         check.items,
    discounts:     check.discounts,
    subtotal:      check.subtotal,
    service:       check.service,
    tip:           check.tip,
    tax_amount:    check.taxAmount != null ? check.taxAmount : null,
    tax_breakdown: check.taxBreakdown || null,
    total:         check.total,
    method:        check.method,
    drawer_id:     check.drawerId || null,
    shift_id:      check.shiftId || null,
    closed_at:     check.closedAt ? new Date(check.closedAt).toISOString() : new Date().toISOString(),
    seated_at:     check.seatedAt ? new Date(check.seatedAt).toISOString() : null,
    status:        check.status || 'paid',
    refunds:       check.refunds || [],
    table_id:      check.tableId || null,
    table_label:   check.tableLabel || null,
    gift_card:     check.giftCard || null,
    loyalty:       check.loyalty || null,
    source:        check.source || null,
    stripe_payment_intent_id: check.stripePaymentIntentId || null,
    payment_intents: check.paymentIntents || null,
    processor:     check.processor || 'stripe',
  };
}

// v5.5.977 — the card was APPROVED and the sale did not record. Deliberately a
// dead end: there is no rollback, so the one thing the operator must not be given
// is a normal receipt prompt. Continue is a two-tap confirmation.
function MCloseFailed({ amount, queued, message, onRetry, onContinue }) {
  const [armed, setArmed] = useState(false);
  return (
    <div style={Sx.shell}>
      <div style={{ ...Sx.header, background:'var(--red-d)', borderBottom:'1px solid var(--red-b)' }}>
        <div style={{ ...Sx.hTitle, color:'var(--red)' }}>Sale NOT recorded</div>
      </div>
      <div style={{ ...Sx.scroller, padding:'22px 14px' }}>
        <div style={{ fontSize:46, textAlign:'center', marginBottom:8 }}>⚠️</div>
        <div style={{ fontSize:34, fontWeight:800, fontFamily:'var(--font-mono)', color:'var(--t1)', textAlign:'center' }}>
          {money(amount)}
        </div>
        <div style={{ fontSize:14, fontWeight:800, color:'var(--red)', textAlign:'center', margin:'4px 0 16px' }}>
          WAS taken from the customer's card
        </div>
        <div style={{ ...Sx.card, borderColor:'var(--red-b)', background:'var(--red-d)' }}>
          <div style={{ fontSize:13, color:'var(--t1)', lineHeight:1.55 }}>
            The payment went through, but the sale could not be saved.{' '}
            <b>Do not take the payment again.</b>
          </div>
        </div>
        <div style={Sx.card}>
          <div style={{ fontSize:13, color:'var(--t2)', lineHeight:1.55 }}>
            {queued === null && 'Saving a backup copy on this device…'}
            {queued === true && 'A backup is saved on this device and will be sent automatically. Keep the handheld online and signed in until it clears.'}
            {queued === false && 'The backup could NOT be saved on this device either. Write the order and the amount down now and tell a manager.'}
          </div>
        </div>
        {message && (
          <div style={{ fontSize:11, color:'var(--t4)', marginTop:10, wordBreak:'break-word' }}>
            Reason: {message}
          </div>
        )}
      </div>
      <div style={Sx.bottom}>
        <button onClick={onRetry} style={Sx.btnPrim}>↻ Try recording the sale again</button>
        <button
          onClick={() => (armed ? onContinue?.() : setArmed(true))}
          style={{ ...Sx.btnGhost, marginTop:8, ...(armed ? { borderColor:'var(--red-b)', color:'var(--red)' } : null) }}
        >
          {armed ? 'Tap again to confirm — no receipt for this sale' : 'Continue without a receipt'}
        </button>
      </div>
    </div>
  );
}

// v5.5.977 — the kitchen never got the food. Blocks the tender wizard (and the
// post-send confirmation, which carries its own Take-payment button) until the
// server has either re-sent or explicitly accepted it.
function MKitchenSendFailed({ count, message, continueLabel, onRetry, onContinue }) {
  const [armed, setArmed] = useState(false);
  return (
    <div style={Sx.shell}>
      <div style={{ ...Sx.header, background:'var(--red-d)', borderBottom:'1px solid var(--red-b)' }}>
        <div style={{ ...Sx.hTitle, color:'var(--red)' }}>Kitchen never got this order</div>
      </div>
      <div style={{ ...Sx.scroller, padding:'22px 14px' }}>
        <div style={{ fontSize:46, textAlign:'center', marginBottom:8 }}>🍳</div>
        <div style={{ ...Sx.card, borderColor:'var(--red-b)', background:'var(--red-d)' }}>
          <div style={{ fontSize:13, color:'var(--t1)', lineHeight:1.55 }}>
            {count === 1 ? '1 line' : `${count} lines`} could not be sent to the kitchen.
            Nothing is being cooked. <b>Do not take payment until this is sorted.</b>
          </div>
        </div>
        <div style={Sx.card}>
          <div style={{ fontSize:13, color:'var(--t2)', lineHeight:1.55 }}>
            Try again. If it keeps failing, tell the kitchen the order verbally before
            you carry on.
          </div>
        </div>
        {message && (
          <div style={{ fontSize:11, color:'var(--t4)', marginTop:10, wordBreak:'break-word' }}>
            Reason: {message}
          </div>
        )}
      </div>
      <div style={Sx.bottom}>
        <button onClick={onRetry} style={Sx.btnPrim}>↻ Send to kitchen again</button>
        <button
          onClick={() => (armed ? onContinue?.() : setArmed(true))}
          style={{ ...Sx.btnGhost, marginTop:8, ...(armed ? { borderColor:'var(--red-b)', color:'var(--red)' } : null) }}
        >
          {armed ? 'Tap again to confirm — the kitchen has not seen this' : continueLabel}
        </button>
      </div>
    </div>
  );
}
