// src/surfaces/bookings/NoShowCharge.jsx
//
// The no show and late cancel charge on the booking card (16 Oct 2026, bookings audit section 3
// item 3). Shown in the Inspector's Payment section once a booking is a no show, or has been
// cancelled inside the venue's cancellation window, and only when the guest saved a card with
// it. The host sees "Charge £40.00 to the card ending 4242?" and confirms once.
//
// Everything is decided by the booking-charge edge function (rules in lib/bookings/noShowCharge.js):
// this panel asks it what may be charged (quote) and sends the one charge. A refusal is shown in
// the bank's own terms, in plain words, and nothing is tried again unless the host taps Try again.
// Before the function is deployed the panel stays quiet, except on a booking that saved a card,
// where it says charging is not switched on yet.

import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { quoteNoShowCharge, chargeNoShow } from '../../lib/bookings/noShowChargeApi.js';
import { moneyText, chargeLabel } from '../../lib/bookings/noShowCharge.js';
import { tintBg, tintBd } from './bits.jsx';

// Reasons worth a line on the card. The rest (no card saved, not a no show) say nothing.
const QUIET = new Set(['no_card', 'not_chargeable', 'no_fee', 'no_window', 'unknown_booking']);

export default function NoShowCharge({ b, hasSavedCard = false }) {
  const operatorName = useStore((s) => s.bookingsOperator?.name || s.staff?.name || null);
  const chargeable = b && (b.status === 'no_show' || b.status === 'cancelled');
  const key = b ? `${b.id}|${b.status}|${b.cancelledAt || ''}` : '';
  // { key, data } so an answer for another booking (or an older status) is never shown here.
  const [quote, setQuote] = useState({ key: null, data: null });
  const [refresh, setRefresh] = useState(0);
  const [step, setStep] = useState({ key: null, mode: 'idle', result: null }); // idle | confirm | busy | done

  useEffect(() => {
    if (!chargeable || !b?.locationId) return undefined;
    let alive = true;
    quoteNoShowCharge(b.locationId, b.id).then((data) => { if (alive) setQuote({ key, data }); });
    return () => { alive = false; };
  }, [chargeable, b?.locationId, b?.id, key, refresh]);

  if (!chargeable) return null;
  const q = quote.key === key ? quote.data : null;
  const s = step.key === key ? step : { mode: 'idle', result: null };
  if (!q) return null;   // still asking: the Payment line above already says what is on file

  if (!q.ok) {
    if (q.missing) {
      return hasSavedCard ? <Note col="var(--t4)">Charging the saved card is not switched on here yet.</Note> : null;
    }
    return hasSavedCard ? <Note col="var(--t4)">{q.message || 'Could not check the saved card just now.'}</Note> : null;
  }

  const result = s.result;
  const charges = Array.isArray(q.charges) ? q.charges : [];
  const lastFail = [...charges].reverse().find((c) => c.status === 'failed');

  const charge = async () => {
    setStep({ key, mode: 'busy', result: null });
    const res = await chargeNoShow(b.locationId, b.id, { expectedMinor: q.amountMinor, staffName: operatorName });
    setStep({ key, mode: 'done', result: res });
    setRefresh((n) => n + 1);   // the card then shows what the ledger now holds
  };

  // Charged (just now, or before).
  if (result?.ok || q.reason === 'already_charged') {
    const taken = [...charges].reverse().find((c) => c.status === 'captured' || c.status === 'authorised');
    const ref = result?.checkRef || taken?.checkRef || null;
    const text = result?.message || q.message;
    return (
      <Box col="var(--grn)">
        <Title col="var(--grn)">{chargeLabel(taken?.kind || q.kind || result?.kind)}</Title>
        <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.4 }}>{text}</div>
        {ref && (
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4, lineHeight: 1.45 }}>
            On check {ref}. To give it back, refund check {ref} in History on the till, or in Transactions in Back Office.
          </div>
        )}
      </Box>
    );
  }

  if (!q.chargeable) {
    if (QUIET.has(q.reason)) return null;
    const amber = q.reason === 'charge_in_flight';
    return <Note col={amber ? 'var(--orn)' : 'var(--t3)'}>{q.message}</Note>;
  }

  const amount = moneyText(q.amountMinor, q.currency);
  const busy = s.mode === 'busy';
  return (
    <Box col="var(--red)">
      <Title col="var(--red)">{q.label || chargeLabel(q.kind)}</Title>
      <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.45 }}>
        {q.covers > 1 && q.perCoverMinor > 0
          ? `${moneyText(q.perCoverMinor, q.currency)} a guest for ${q.covers} guests, the card hold agreed when they booked.`
          : 'The card hold the guest agreed to when they booked.'}
        {q.kind === 'late_cancel' && Number.isFinite(q.hoursBefore) && ` Cancelled ${Math.max(0, Math.round(q.hoursBefore))} hours before, inside the ${q.windowHours} hour window.`}
      </div>
      {result && !result.ok && (
        <div role="alert" style={{ marginTop: 8, fontSize: 13.5, fontWeight: 700, lineHeight: 1.4, color: result.pending ? 'var(--orn)' : 'var(--red)' }}>
          {result.message}
        </div>
      )}
      {!result && lastFail?.refusal && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--t3)', lineHeight: 1.4 }}>Last try was declined ({lastFail.refusal}).</div>
      )}
      {s.mode === 'confirm' ? (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 800, lineHeight: 1.35 }}>{q.question}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn btn-ghost" onClick={() => setStep({ key, mode: 'idle', result: null })} style={{ flex: 1, height: 44 }}>Keep</button>
            <button className="btn btn-red" onClick={charge} style={{ flex: 1, height: 44, fontWeight: 800 }}>Charge {amount}</button>
          </div>
        </div>
      ) : (
        !(result && result.pending) && (
          <button className="btn btn-red" disabled={busy} onClick={() => setStep({ key, mode: 'confirm', result: null })}
            style={{ marginTop: 10, width: '100%', height: 44, fontWeight: 800, opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Charging…' : result && !result.ok ? `Try again: charge ${amount}` : `Charge ${amount}${q.last4 ? ` to card ending ${q.last4}` : ''}`}
          </button>
        )
      )}
    </Box>
  );
}

function Box({ col, children }) {
  return (
    <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: tintBg(col, 8), border: `1px solid ${tintBd(col)}` }}>
      {children}
    </div>
  );
}

function Title({ col, children }) {
  return <div style={{ fontSize: 10, fontWeight: 800, color: col, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>{children}</div>;
}

function Note({ col, children }) {
  return <div style={{ marginTop: 8, fontSize: 13, color: col, lineHeight: 1.45 }}>{children}</div>;
}
