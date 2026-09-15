// src/components/KioskStaffAlert.jsx: a kiosk card problem, parked over the till until staff tap OK.
//
// Owner's live test (14 Sep 2026): the kiosk had no card reader, told the customer to ask a
// member of staff, and the till only beeped and flashed a 2.8 second toast. "The POS made a
// notification sound but no idea why." This card says what happened in plain words, with the
// amount and the reference the customer reads out, and stays until somebody taps OK. OK
// acknowledges the event, so it clears on every till (lib/kioskStaffAlerts.js).
//
// Mounted once per till device in App.jsx (ValidatedPOSApp and the ?mode=mpos route), above the
// PIN screen and every till surface. NEVER on a kiosk, customer page or the Back Office. Several
// alerts show one after another, oldest first, each chiming once when it arrives.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';
import { kioskStaffAlertView } from '../lib/kioskStaffAlertView';
import { registerKioskAlertHost, acknowledgeKioskAlert, markKioskAlertChimed } from '../lib/kioskStaffAlerts';
import { playOrderChime } from '../lib/orderChime';
import { Icon } from './ServOSIcons';

const EMPTY = [];
// A tap already on its way when the card appears (or when OK brings up the next alert) must not
// land on OK. The button wakes after this long.
const ARM_MS = 700;

// The order amount and the reference the customer reads out: large, in the number font.
function Fact({ label, value }) {
  return (
    <div style={{ minWidth: 0, padding: '10px 14px', borderRadius: 12, background: 'var(--bg3)', border: '1px solid var(--bdr)' }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t2)' }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--t1)', marginTop: 2, lineHeight: 1.2, fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  );
}

export default function KioskStaffAlert() {
  const queue = useStore(s => s.kioskStaffAlerts) || EMPTY;
  // An MPOS phone in the customer's hands (tip pass, card, receipt): wait, show when it is back.
  const held = useStore(s => s.tillCustomerFacing === true);
  const [now, setNow] = useState(() => Date.now());
  const [armedKey, setArmedKey] = useState(null);   // the alert whose OK is awake
  const okRef = useRef(null);

  // This device shows kiosk alerts on screen (realtime.js skips its toast for them).
  useEffect(() => registerKioskAlertHost(), []);

  // One chime per alert, the first time this till SHOWS it (not while the customer holds the phone).
  useEffect(() => {
    if (held) return;
    let fresh = false;
    for (const e of queue) if (markKioskAlertChimed(e.key)) fresh = true;
    if (fresh) playOrderChime();
  }, [queue, held]);

  const count = held ? 0 : queue.length;
  const front = count ? queue[0] : null;
  const frontKey = front ? front.key : null;

  // Lets other toasts draw above the alert while it is open (globals.css).
  useEffect(() => {
    if (!frontKey || typeof document === 'undefined' || !document.body) return undefined;
    document.body.setAttribute('data-kiosk-staff-alert-open', '');
    return () => { document.body.removeAttribute('data-kiosk-staff-alert-open'); };
  }, [frontKey]);

  // Keep "2 min ago" current while something shows (read again as soon as an alert comes up).
  useEffect(() => {
    if (!count) return undefined;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 30000);
    return () => { clearTimeout(first); clearInterval(t); };
  }, [count, frontKey]);
  useEffect(() => {
    if (!frontKey) return undefined;
    const t = setTimeout(() => {
      setArmedKey(frontKey);
      try { okRef.current?.focus({ preventScroll: true }); } catch { /* noop */ }
    }, ARM_MS);
    // Asleep again whenever this alert leaves the screen (OK, or an MPOS phone handed to a
    // customer), so it is never awake on its very first frame when it comes back.
    return () => { clearTimeout(t); setArmedKey(null); };
  }, [frontKey]);

  if (!front || typeof document === 'undefined') return null;

  const v = kioskStaffAlertView(front, { now });
  const more = count - 1;
  const metaText = [v.deviceName, v.age].filter(Boolean).join(', ');   // "Front kiosk, 2 min ago"
  const meta = metaText ? metaText.charAt(0).toUpperCase() + metaText.slice(1) : '';
  // Keyed to the alert, so the next alert's OK is asleep from its very first frame.
  const armed = armedKey === frontKey;
  const onOk = () => {
    if (!armed) return;
    const who = useStore.getState().staff?.name || null;
    acknowledgeKioskAlert(useStore, front.key, who);
  };

  return createPortal(
    <div
      data-kiosk-staff-alert=""
      style={{
        position: 'fixed', inset: 0, zIndex: 100020, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16, fontFamily: 'inherit', animation: 'fadeIn .18s ease',
      }}
    >
      {/* Scrim from the till's own background colour, so it follows the light and dark themes. */}
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'var(--bg)', opacity: 0.84 }} />
      <div
        key={v.key}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="kiosk-staff-alert-title"
        aria-describedby="kiosk-staff-alert-lines"
        style={{
          position: 'relative', width: 'min(600px, 100%)', maxHeight: 'calc(100vh - 32px)', display: 'flex', flexDirection: 'column',
          background: 'var(--bg1)', color: 'var(--t1)', borderRadius: 22, overflow: 'hidden',
          border: '1px solid var(--red-b)', boxShadow: 'var(--sh3)', animation: 'slideUp .24s ease',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '18px 22px', background: 'var(--red-d)', borderBottom: '1px solid var(--red-b)' }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--bg1)', color: 'var(--red)', border: '1px solid var(--red-b)' }}>
            <Icon name="warn" size={30} stroke={2} />
          </div>
          <div id="kiosk-staff-alert-title" style={{ flex: 1, minWidth: 0, fontSize: 'clamp(24px, 3.4vw, 31px)', fontWeight: 800, lineHeight: 1.15, color: 'var(--t1)' }}>
            {v.headline}
          </div>
          {count > 1 && (
            <div style={{ flexShrink: 0, padding: '5px 11px', borderRadius: 999, fontSize: 14, fontWeight: 800, color: 'var(--red)', background: 'var(--bg1)', border: '1px solid var(--red-b)', whiteSpace: 'nowrap' }}>
              1 of {count}
            </div>
          )}
        </div>

        <div style={{ padding: '18px 22px 4px', overflowY: 'auto', minHeight: 0 }}>
          <div id="kiosk-staff-alert-lines">
            <p style={{ margin: 0, fontSize: 20, lineHeight: 1.4, fontWeight: 600, color: 'var(--t1)' }}>{v.lines[0]}</p>
            <p style={{ margin: '12px 0 0', padding: '12px 14px', borderRadius: 12, fontSize: 20, lineHeight: 1.4, fontWeight: 800, color: 'var(--t1)', background: 'var(--bg3)', borderLeft: '4px solid var(--red)' }}>{v.lines[1]}</p>
          </div>

          {(v.amountText || v.reference) && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginTop: 16 }}>
              {v.amountText && <Fact label="Order" value={v.amountText} />}
              {v.reference && <Fact label="Ref" value={v.reference} />}
            </div>
          )}

          {meta && (
            <div style={{ marginTop: 12, fontSize: 16, fontWeight: 600, color: 'var(--t2)', overflowWrap: 'anywhere' }}>{meta}</div>
          )}

          {v.detail && (
            <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.45, color: 'var(--t2)', overflowWrap: 'anywhere' }}>
              Details: {v.detail}
            </div>
          )}
        </div>

        <div style={{ padding: '14px 22px 20px' }}>
          {more > 0 && (
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t2)', marginBottom: 10, textAlign: 'center' }}>
              {more === 1 ? '1 more kiosk alert after this one' : `${more} more kiosk alerts after this one`}
            </div>
          )}
          <button
            ref={okRef}
            type="button"
            className="btn btn-acc btn-full"
            onClick={onOk}
            disabled={!armed}
            style={{ height: 68, fontSize: 23, fontWeight: 800, borderRadius: 16 }}
          >
            OK
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
