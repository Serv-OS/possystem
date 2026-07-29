// src/components/ChangeDueOverlay.jsx — v5.5.943
//
// After a cash sale the change figure only ever lived on the tender screen, which
// unmounts the instant staff tap Complete — all that survived was a 2.8s "Payment
// complete" toast with no amount on it. Staff counting coins out of the drawer had
// to remember the figure or re-open the check.
//
// This overlay parks CHANGE DUE over the whole till and stays until somebody taps.
// It renders next to the global Toast (App.jsx) rather than inside CheckoutModal
// because a table cash-off immediately switches surface back to the floor plan —
// anything mounted under POSSurface would vanish with it.
import { useStore } from '../store';
import { money } from '../lib/currency';

export default function ChangeDueOverlay() {
  const changeDue = useStore(s => s.changeDue);
  const clearChangeDue = useStore(s => s.clearChangeDue);
  if (!changeDue) return null;
  return (
    <div onClick={clearChangeDue} style={{
      position: 'fixed', inset: 0, zIndex: 100000,
      background: 'rgba(8,10,14,.85)',
      backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 6, cursor: 'pointer', userSelect: 'none',
    }}>
      <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: '.22em', color: 'var(--grn, #3fd97b)', textTransform: 'uppercase' }}>
        Change due
      </div>
      <div style={{ fontSize: 'clamp(64px, 18vw, 150px)', fontWeight: 900, color: '#fff', fontFamily: 'DM Mono, ui-monospace, monospace', letterSpacing: '-.02em', lineHeight: 1.15 }}>
        {money(changeDue.amount)}
      </div>
      <div style={{ fontSize: 14, color: 'rgba(255,255,255,.55)', fontWeight: 600, marginTop: 16 }}>
        Tap anywhere to close
      </div>
    </div>
  );
}
