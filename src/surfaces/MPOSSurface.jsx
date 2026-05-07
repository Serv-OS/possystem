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
import PINScreen from './PINScreen';
import MHome from './mpos/MHome';
import MOrdersList from './mpos/MOrdersList';
import MTablesList from './mpos/MTablesList';
import MMe from './mpos/MMe';
import MNewOrder from './mpos/MNewOrder';
import MCoversPicker from './mpos/MCoversPicker';
import MTableView from './mpos/MTableView';
import MMenu from './mpos/MMenu';
import MItemDetail from './mpos/MItemDetail';
import MVariantPicker from './mpos/MVariantPicker';
import MCartSheet from './mpos/MCartSheet';
import MTender from './mpos/MTender';
import MCardFlow from './mpos/MCardFlow';
import MPayAtCounter from './mpos/MPayAtCounter';
import MReceiptPrompt from './mpos/MReceiptPrompt';
import MDone from './mpos/MDone';
import { Sx } from './mpos/MShellStyles';

const TABS = [
  { id:'home',   label:'Home',   icon:'🏠' },
  { id:'orders', label:'Orders', icon:'📋' },
  { id:'tables', label:'Tables', icon:'🪑' },
  { id:'me',     label:'Me',     icon:'⚙' },
];

export default function MPOSSurface() {
  const { staff } = useStore();

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

  if (!staff) return <PINScreen />;
  return <MPOSRouter />;
}

function MPOSRouter() {
  const { deviceConfig, activeTableId, setActiveTableId, showToast } = useStore();
  const runnerMode = !!deviceConfig?.runnerMode;

  const [tab, setTab] = useState(runnerMode ? 'orders' : 'home');
  // flow.screen: null | 'newOrder' | 'covers' | 'tableView' | 'menu' | 'item' | 'cart'
  // flow.context carries flow-specific state (selected table, item, etc.)
  const [flow, setFlow] = useState({ screen: null });

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
      // Stay in the order flow — show a dedicated full-screen table picker.
      // Tab switching was confusing because the floating "+" overlay closed
      // and the user landed on the Tables tab without context. Now they get
      // an explicit "Pick a table" screen with a Back arrow back to types.
      setFlow({ screen: 'pickTable' });
      return;
    }
    if (type === 'bar') {
      // Bar tabs handled by existing BarSurface — out of MPOS Phase 1B scope.
      // For now route as a takeaway-style walk-in until 1C adds bar tab UI.
      useStore.getState().setOrderType('takeaway');
    }
    // Walk-in style: clear any prior walk-in, keep customer for collection/delivery later
    useStore.setState({ walkInOrder: null, customer: null, activeTableId: null });
    setFlow({ screen: 'menu', context: { source: 'walkin' } });
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
  // From menu → item detail. Variant parents (type === 'variants') open the
  // variant picker first; the picked variant then routes to MItemDetail (for
  // modifier selection) or, if it has no modifiers, straight into the cart
  // via the parent flow.
  const goItem = (item) => {
    if (item?.type === 'variants') {
      setFlow(f => ({ screen: 'variantPicker', context: { ...(f.context||{}), parent: item } }));
      return;
    }
    setFlow(f => ({ screen: 'item', context: { ...(f.context||{}), item } }));
  };
  // From menu/table-view → cart
  const goCart = () => setFlow(f => ({ screen: 'cart', context: f.context || {} }));
  // From item → back to menu (after add)
  const goBackToMenu = () => setFlow(f => ({ screen: 'menu', context: f.context || {} }));

  // After Send to kitchen on a table — go back to table view
  const onSentToKitchen = () => {
    const tableId = flow.context?.tableId || activeTableId;
    if (tableId) setFlow({ screen: 'tableView', context: { tableId } });
    else setFlow({ screen: null });
    showToast?.('Sent to kitchen', 'success');
  };

  // Walk-in "Send & take payment" or table "Take payment" → tender flow (1C)
  const onSendAndPay = () => {
    // For walk-in flows, fire to kitchen first if anything is still pending. The
    // tender wizard then takes over.
    const { walkInOrder } = useStore.getState();
    if (!activeTableId && walkInOrder?.items?.length) {
      const pending = walkInOrder.items.filter(i => i.status !== 'sent' && !i.voided);
      if (pending.length) {
        try { useStore.getState().sendToKitchen?.(); } catch {}
      }
    }
    setFlow({ screen: 'tender', context: flow.context || {} });
  };

  // After payment is approved (card REST or simulated)
  const onPaymentApproved = (paymentInfo) => {
    // Close the check using the existing store actions. They route automatically
    // by activeTableId — same path the desktop POS uses.
    const state = useStore.getState();
    let closedCheck = null;
    try {
      if (activeTableId) {
        state.recordClosedCheck(activeTableId, paymentInfo);
        // recordClosedCheck doesn't return — read the latest closed check
        closedCheck = useStore.getState().closedChecks?.[0] || null;
      } else if (state.walkInOrder) {
        state.recordWalkInClosed(state.walkInOrder, state.orderType || 'takeaway', state.customer, paymentInfo);
        closedCheck = useStore.getState().closedChecks?.[0] || null;
      }
    } catch (e) {
      console.warn('[mpos] close check failed', e);
    }
    setFlow({ screen: 'receipt', context: { check: closedCheck } });
  };

  // After "Pay at counter" routes to the order_queue
  const onSentToCounter = () => {
    showToast?.('Sent to counter for payment', 'success');
    // Clear the active order locally — counter POS owns it now
    if (activeTableId) {
      // For tables, we leave the session open — counter staff will close it
    } else {
      useStore.setState({ walkInOrder: null });
    }
    setFlow({ screen: 'done', context: { check: null, deliveredVia: 'counter' } });
  };

  // After receipt prompt resolves
  const onReceiptDone = (deliveredVia) => {
    setFlow({ screen: 'done', context: { ...flow.context, deliveredVia: deliveredVia?.deliveredVia ?? deliveredVia } });
  };

  // "Take next order" on MDone → reset to home
  const onAllDone = () => {
    setActiveTableId(null);
    useStore.setState({ walkInOrder: null, customer: null });
    setFlow({ screen: null });
    setTab(runnerMode ? 'orders' : 'home');
  };

  // ── Render flow overlays first so they sit above everything ──────────────

  if (flow.screen === 'newOrder') {
    return (
      <div style={Sx.shell}>
        <BlankBg />
        <MNewOrder onPick={onPickType} onClose={closeFlow} />
      </div>
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
          onPick={(variant) => setFlow(f => ({ screen:'item', context:{ ...(f.context||{}), item: variant, parent: undefined } }))}
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
          useStore.getState().sendToKitchen?.();
          onSentToKitchen();
        }}
        onSendAndPay={onSendAndPay}
      />
    );
  }

  if (flow.screen === 'tender') {
    return (
      <MTender
        onBack={() => {
          const tableId = flow.context?.tableId || activeTableId;
          if (tableId) setFlow({ screen: 'tableView', context: { tableId } });
          else setFlow({ screen: 'cart', context: flow.context || {} });
        }}
        onPay={(payment) => setFlow(f => ({ screen: 'card', context: { ...(f.context || {}), payment } }))}
        onPayAtCounter={(payment) => setFlow(f => ({ screen: 'payAtCounter', context: { ...(f.context || {}), payment } }))}
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

  if (flow.screen === 'payAtCounter' && flow.context?.payment) {
    return (
      <MPayAtCounter
        payment={flow.context.payment}
        onBack={() => setFlow(f => ({ screen: 'tender', context: f.context || {} }))}
        onSent={onSentToCounter}
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

  // ── Default: tab bar shell ────────────────────────────────────────────────
  return (
    <div style={Sx.shell}>
      <div style={Sx.body}>
        {tab === 'home'   && <MHome onTakeOrder={startNewOrder} onSeeOrders={() => setTab('orders')} onSeeTables={() => setTab('tables')} />}
        {tab === 'orders' && <MOrdersList onOpenOrder={() => alert('Order detail lands in 1D.')} />}
        {tab === 'tables' && <MTablesList onPickTable={onPickTable} />}
        {tab === 'me'     && <MMe />}

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
