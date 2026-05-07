// src/surfaces/MPOSSurface.jsx
//
// v5.5.60 — Phase 1A of the reimagined MPOS. A phone-native router with a
// bottom tab bar (Home / Orders / Tables / Me) and a persistent floating "+"
// button for instant new-order entry. Reuses the same Zustand store, sync,
// realtime, and edge functions as the desktop POS — the UI is the only thing
// that's different. See docs/MPOS-SPEC.md for the full design.
//
// 1A scope: tab scaffold + 4 main tab screens. The new-order flow, tender flow,
// and order management screens land in 1B-1D. Native iOS / Android shells with
// Tap to Pay land in 1E.

import { useState, useEffect } from 'react';
import { useStore } from '../store';
import PINScreen from './PINScreen';
import MHome from './mpos/MHome';
import MOrdersList from './mpos/MOrdersList';
import MTablesList from './mpos/MTablesList';
import MMe from './mpos/MMe';
import { Sx } from './mpos/MShellStyles';

const TABS = [
  { id:'home',   label:'Home',   icon:'🏠' },
  { id:'orders', label:'Orders', icon:'📋' },
  { id:'tables', label:'Tables', icon:'🪑' },
  { id:'me',     label:'Me',     icon:'⚙' },
];

export default function MPOSSurface() {
  const { staff } = useStore();

  // Swap PWA manifest to portrait MPOS variant + tighten viewport so layouts
  // can use safe-area insets and we never zoom into double-taps.
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
  const { deviceConfig } = useStore();
  const runnerMode = !!deviceConfig?.runnerMode;
  // In runner mode the default landing tab is Orders (the runner's queue) and
  // the floating "+" button is hidden — runners don't take orders.
  const [tab, setTab] = useState(runnerMode ? 'orders' : 'home');
  const goNewOrder = () => {
    // Phase 1B: open MNewOrder. For now show a placeholder so the button is testable.
    alert('New-order flow lands in MPOS Phase 1B (next).');
  };

  return (
    <div style={Sx.shell}>
      <div style={Sx.body}>
        {tab === 'home'   && <MHome onTakeOrder={goNewOrder} onSeeOrders={() => setTab('orders')} onSeeTables={() => setTab('tables')} />}
        {tab === 'orders' && <MOrdersList onOpenOrder={() => alert('Order detail lands in 1D.')} />}
        {tab === 'tables' && <MTablesList onPickTable={() => alert('Table flow lands in 1B.')} />}
        {tab === 'me'     && <MMe />}

        {/* Floating "+" — hidden in runner mode */}
        {!runnerMode && tab !== 'me' && (
          <button onClick={goNewOrder} aria-label="New order" style={{
            position:'absolute', right:18, bottom:'calc(76px + env(safe-area-inset-bottom))',
            width:60, height:60, borderRadius:'50%', border:'none',
            background:'var(--acc)', color:'#0b0c10', fontSize:32, fontWeight:800,
            boxShadow:'0 6px 22px rgba(0,0,0,.35), 0 2px 6px rgba(0,0,0,.25)',
            cursor:'pointer', fontFamily:'inherit', zIndex:10,
            display:'flex', alignItems:'center', justifyContent:'center', lineHeight:1,
          }}>+</button>
        )}
      </div>

      {/* Bottom tab bar */}
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
