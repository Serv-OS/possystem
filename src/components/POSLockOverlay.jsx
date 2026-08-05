// v4.6.51: Self-contained POS lock overlay.
//
// Rules:
//   - POS with no drawer bound     → NEVER locks (returns null)
//   - POS with drawer bound, NOT signed in → waits for sign-in (returns null)
//   - Drawer bound, staff signed in, drawer status === 'open' or 'counting' → never locks
//   - Drawer bound, staff signed in, drawer status === 'idle' (or anything else) → LOCK:
//       • Manager/Admin/cashup perm → show cash-in modal
//       • Other roles → show read-only "ask a manager" screen
//
// Uses React Portal to render above everything, bypassing z-index/overflow issues.
// Subscribes directly to store state so any change (drawer status, staff) triggers re-evaluation.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';
import DrawerCashModal from './DrawerCashModal';

export default function POSLockOverlay() {
  const staff         = useStore(s => s.staff);
  const cashDrawers   = useStore(s => s.cashDrawers);
  const cashInDrawer  = useStore(s => s.cashInDrawer);
  const loadCashDrawers        = useStore(s => s.loadCashDrawers);
  const loadCurrentDrawerSession = useStore(s => s.loadCurrentDrawerSession);

  // Periodically re-sync drawer state from Supabase so back-office changes
  // propagate to this POS without a manual refresh.
  useEffect(() => {
    const tick = async () => {
      try {
        if (typeof loadCashDrawers === 'function') await loadCashDrawers();
        if (typeof loadCurrentDrawerSession === 'function') await loadCurrentDrawerSession();
      } catch {}
    };
    tick();
    const id = setInterval(tick, 15000);
    return () => clearInterval(id);
  }, [loadCashDrawers, loadCurrentDrawerSession]);

  // Resolve this device's drawer. Match on rpos-device.id UUID.
  const deviceId = (() => {
    try { return JSON.parse(localStorage.getItem('rpos-device') || '{}')?.id || null; }
    catch { return null; }
  })();
  const drawer = Array.isArray(cashDrawers)
    ? cashDrawers.find(d => d.deviceId === deviceId) || null
    : null;

  // Decide whether to lock
  const needsLock = drawer && drawer.status !== 'open' && drawer.status !== 'counting';

  if (typeof window !== 'undefined' && window.__RPOS_DEBUG_LOCK !== false) {
    // Log so we can verify in prod
    // eslint-disable-next-line no-console
    console.log('[POSLockOverlay]', { deviceId, drawerName: drawer?.name, status: drawer?.status, staffRole: staff?.role, needsLock });
  }

  // Gate off when nothing to lock, no drawer, or no staff signed in yet.
  if (!drawer) return null;
  if (!staff) return null;
  if (!needsLock) return null;

  // Permission — Manager, Admin, or cashup permission holder can cash in.
  const canCashIn =
    staff?.role === 'Manager' ||
    staff?.role === 'Admin' ||
    (Array.isArray(staff?.permissions) && staff.permissions.includes('cashup'));

  const overlay = canCashIn ? (
    // Authorised → show the cash-in modal (locked, cannot be dismissed).
    // The Sign out button is the ONLY way past this without declaring a float. Without it
    // a manager who cashes up at close of trade is trapped: the drawer goes 'idle', this
    // modal covers the till, and `locked` hides DrawerCashModal's Cancel — leaving no exit
    // but inventing an opening float or clearing browser storage.
    <>
      <DrawerCashModal
        mode="in"
        drawer={drawer}
        locked={true}
        onComplete={async ({ amount, denominations }) => {
          await cashInDrawer?.(drawer.id, { openingFloat: amount, denominations });
          await loadCurrentDrawerSession?.();
          await loadCashDrawers?.();
        }}
      />
      <LockSignOut />
    </>
  ) : (
    // Not authorised → read-only lock screen
    <AskManagerLock drawerName={drawer.name} />
  );

  // Render via portal so it sits above everything regardless of parent CSS.
  return createPortal(overlay, document.body);
}

// Sits above the locked cash-in modal so cashing up at close of trade lands the till
// on the PIN screen instead of an undismissable float prompt.
function LockSignOut() {
  const logout = useStore(s => s.logout);
  return createPortal(
    <button
      className="btn btn-ghost"
      onClick={() => logout?.()}
      style={{ position: 'fixed', top: 16, right: 16, zIndex: 100010 }}
    >
      Sign out
    </button>,
    document.body,
  );
}

function AskManagerLock({ drawerName }) {
  const logout = useStore(s => s.logout);
  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.78)',
        zIndex: 99999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
    >
      <div style={{
        background: 'var(--bg1)', border: '1.5px solid var(--bdr2)', borderRadius: 20,
        padding: '36px 32px', maxWidth: 460, textAlign: 'center',
        boxShadow: 'var(--sh3)',
      }}>
        <div style={{ fontSize: 46, marginBottom: 18 }}>&#128274;</div>
        <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--t1)', marginBottom: 10 }}>POS locked</div>
        <div style={{ fontSize: 14, color: 'var(--t2)', marginBottom: 6, lineHeight: 1.5 }}>
          <b>{drawerName}</b> needs to be cashed in before this terminal can trade.
        </div>
        <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 26, lineHeight: 1.5 }}>
          Ask a manager to sign in and declare the opening float. Or sign out and let them sign in here.
        </div>
        <button
          onClick={() => { try { logout?.(); } catch {} }}
          style={{
            padding: '11px 28px', borderRadius: 10,
            border: '1px solid var(--bdr2)', background: 'var(--bg3)', color: 'var(--t2)',
            fontFamily: 'inherit', fontWeight: 700, fontSize: 13, cursor: 'pointer',
          }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
