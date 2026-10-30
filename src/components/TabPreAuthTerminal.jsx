import { useState, useRef, useEffect } from 'react';
import { getActiveLocationSync, ensureAuthToken } from '../lib/supabase';
import { confirmLinkBeforeCard } from '../lib/deviceLink';
import { usePaymentBusy } from '../lib/usePaymentBusy';
import { getLocationProcessorInfo } from '../lib/payments/processor';
import { findPaxTerminal, getPosDeviceId } from '../lib/payments/terminalJobs';
import { money } from '../lib/currency';
import { isTrainingMode } from '../lib/trainingMode';
import { useStore } from '../store';

// ─── v5.5.324: Bar-tab card pre-authorisation ──────────────────────────────
// Places a card HOLD on the customer's card on the paired Adyen terminal when a bar tab is
// opened (adyen-terminal-charge hold_start, v5.6.58). The hold is captured (tab closed &
// charged) or released (void / pay another way) later.
//
// No reader assigned → 'simulated' state: we can't really hold a card, so we
// offer to open the tab WITHOUT a hold (the pre-v5.5.324 behaviour).
export default function TabPreAuthTerminal({ amountMinor, guestName, onAuthorized, onSkip, onCancel }) {
  const [state, setState] = useState('resolving'); // resolving | collecting | success | error | cancelling | simulated
  const [statusMsg, setStatusMsg] = useState('Connecting to reader…');
  const [errorMsg, setErrorMsg] = useState(null);
  const [readerLabel, setReaderLabel] = useState('');
  const startedRef = useRef(false);
  // v5.6.94: the terminal the hold started on, so "Try hold again" retries the SAME one.
  const adyenTermRef = useRef(null);

  // v5.5.731: hold the auto-sign-out guard while a card hold is being taken on the reader — the
  // customer tapping their card is not POS activity, so an idle timeout must not sign the operator
  // out and abandon the pre-auth mid-flow.
  useEffect(() => {
    const { blockSignout, unblockSignout } = useStore.getState();
    blockSignout?.();
    return () => unblockSignout?.();
  }, []);
  // v5.11.1: and payment busy (lib/paymentBusy.js), taken before the effect below starts the
  // reader, so a release never reloads the till under a card hold.
  usePaymentBusy(true, 'bar tab card hold');

  const pounds = (m) => `${money(((m || 0) / 100))}`;

  const runAdyenHold = async (terminal) => {
    setState('collecting');
    setStatusMsg(`Present card on ${terminal.label || 'the reader'} — the hold completes or cancels on the reader`);
    // v5.6.94 — demo reader window (cosmetic): a hold has no job row for the
    // demo reader to poll, so tell any open ?mode=readerdemo window on this
    // machine to play its card-present animation. Fire-and-forget, same-origin
    // only — the server's simulated hold succeeds whether or not the window
    // exists. Only the demo terminal broadcasts: on the Adyen branch a
    // terminal with no adyen_terminal_id can only be the DEMO- reader (the
    // server refuses hold_start for anything else without an Adyen link).
    if (!terminal.adyen_terminal_id) {
      try {
        const ch = new BroadcastChannel('rpos-demo-reader');
        ch.postMessage({ kind: 'hold_start', amountMinor });
        ch.close();
      } catch { /* unsupported browser — cosmetic only */ }
    }
    try {
      const token = await ensureAuthToken();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/adyen-terminal-charge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'hold_start', terminal_device_id: terminal.id, amount_minor: amountMinor }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) {
        setState('error');
        setErrorMsg(j.declined ? 'Card declined or cancelled on the reader' : (j.error || `HTTP ${res.status}`));
        return;
      }
      setState('success');
      onAuthorized?.({ paymentIntentId: j.psp_reference, heldMinor: j.held_minor ?? amountMinor, processor: 'adyen' });
    } catch (e) {
      setState('error');
      setErrorMsg(e?.message || 'Hold failed');
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // TRAINING MODE: never place a real card hold. Simulate an authorised hold
        // so the tab opens; capture is separately gated in BarSurface.captureHeldTab.
        if (isTrainingMode()) {
          setState('success');
          setStatusMsg('TRAINING — hold simulated, no card charged');
          setTimeout(() => onAuthorized?.({ paymentIntentId: 'pi_training_hold', heldMinor: amountMinor }), 600);
          return;
        }
        const opsLocationId = getActiveLocationSync();
        if (!opsLocationId) { setState('error'); setErrorMsg('Location not resolved'); return; }

        // Database fence stage 1, fix round 2: no card hold starts on a till that is not linked
        // to its venue (lib/deviceLink.js confirmLinkBeforeCard). Nothing has been held.
        const linkGate = await confirmLinkBeforeCard();
        if (cancelled) return;
        if (!linkGate.ok) { setState('error'); setErrorMsg(linkGate.message); return; }

        // The venue's payment account must answer definitively before a hold starts; on a
        // lookup blip the honest offer is to open the tab without a hold.
        const procInfo = await getLocationProcessorInfo(opsLocationId);
        if (cancelled) return;
        if (!procInfo.definitive) { setState('simulated'); return; }

        // Hold on the Adyen reader (card-present pre-auth via adyen-terminal-charge
        // hold_start — v5.6.58). No reader resolved → the honest 'simulated' offer.
        const { terminal, reason } = await findPaxTerminal({ posDeviceId: getPosDeviceId() });
        if (cancelled) return;
        if (!terminal) {
          if (reason) { setState('error'); setErrorMsg(reason); }
          else setState('simulated');
          return;
        }
        setReaderLabel(terminal.label || 'card reader');
        adyenTermRef.current = terminal;
        if (!startedRef.current) { startedRef.current = true; runAdyenHold(terminal); }
      } catch (e) {
        if (!cancelled) { setState('error'); setErrorMsg(e?.message || 'Reader setup failed'); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const cancelHold = async () => {
    // The hold completes or cancels on the reader itself; this only leaves the screen.
    setState('cancelling');
    onCancel?.();
  };

  const box = {
    background: 'var(--bg1)', border: '1px solid var(--bdr2)', borderRadius: 20,
    width: '100%', maxWidth: 380, padding: 24, boxShadow: 'var(--sh3)', textAlign: 'center',
  };

  return (
    <div className="modal-back">
      <div style={box}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 6 }}>
          Card pre-authorisation
        </div>
        <div style={{ fontSize: 34, fontWeight: 800, color: 'var(--t1)', fontFamily: 'DM Mono,monospace', marginBottom: 4 }}>{pounds(amountMinor)}</div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 18 }}>
          {guestName ? `${guestName} · ` : ''}hold only — charged when the tab closes
        </div>

        {(state === 'resolving' || state === 'collecting' || state === 'cancelling') && (
          <>
            <div style={{ fontSize: 14, color: 'var(--t2)', marginBottom: 16 }}>{statusMsg}</div>
            {readerLabel && <div style={{ fontSize: 11, color: 'var(--t4)', marginBottom: 16 }}>Reader: {readerLabel}</div>}
            <button className="btn btn-ghost btn-full" onClick={cancelHold} disabled={state === 'cancelling'}>
              {state === 'cancelling' ? 'Cancelling…' : 'Cancel'}
            </button>
          </>
        )}

        {state === 'success' && (
          <div style={{ padding: '12px 0' }}>
            <div style={{ fontSize: 44, marginBottom: 6 }}>🔒</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--grn)' }}>{pounds(amountMinor)} held</div>
          </div>
        )}

        {state === 'error' && (
          <>
            <div style={{ fontSize: 13, color: 'var(--red)', marginBottom: 16 }}>{errorMsg || 'Authorisation failed'}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* v5.6.94: retry on the terminal the hold actually started on. */}
              {readerLabel && (
                <button className="btn btn-acc btn-full" onClick={() => runAdyenHold(adyenTermRef.current)}>Try hold again</button>
              )}
              <button className="btn btn-ghost btn-full" onClick={() => onSkip?.()}>Open tab without a hold</button>
              <button className="btn btn-ghost btn-full" onClick={() => onCancel?.()}>Cancel</button>
            </div>
          </>
        )}

        {state === 'simulated' && (
          <>
            <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 16 }}>
              No card reader is assigned to this terminal, so a card can't be held here.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button className="btn btn-acc btn-full" onClick={() => onSkip?.()}>Open tab without a hold</button>
              <button className="btn btn-ghost btn-full" onClick={() => onCancel?.()}>Cancel</button>
            </div>
          </>
        )}

      </div>
    </div>
  );
}
