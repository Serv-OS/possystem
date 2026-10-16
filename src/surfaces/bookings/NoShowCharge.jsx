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
// It also shows on a booking with a charge taken whatever its status (an undone no show still
// shows the fee it kept), and never charges a card in Training Mode.

import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { quoteNoShowCharge, chargeNoShow } from '../../lib/bookings/noShowChargeApi.js';
import { moneyText, chargeLabel, hoursText } from '../../lib/bookings/noShowCharge.js';
import { isTrainingMode } from '../../lib/trainingMode.js';
import { tintBg, tintBd } from './bits.jsx';

// Reasons worth a line on the card. The rest (no card saved, not a no show) say nothing.
const QUIET = new Set(['no_card', 'not_chargeable', 'no_fee', 'no_window', 'unknown_booking']);
// Reasons shown even when no card is on file here: they are about a charge that exists.
const ABOUT_A_CHARGE = new Set(['charge_in_flight', 'stale_in_flight', 'already_charged']);
// Buttons in a 262 px Inspector (narrow stand): labels wrap instead of running out of the box.
const BTN_FIT = { whiteSpace: 'normal', lineHeight: 1.2, minWidth: 0, padding: '0 10px' };

export default function NoShowCharge({ b, hasSavedCard = false, hasCharge = false, onCharged = null }) {
  const operatorName = useStore((s) => s.bookingsOperator?.name || s.staff?.name || null);
  const deadStatus = !!b && (b.status === 'no_show' || b.status === 'cancelled');
  const chargeable = !!b && (deadStatus || hasCharge);
  const training = isTrainingMode();
  const key = b ? `${b.id}|${b.status}|${b.cancelledAt || ''}` : '';
  // { key, data } so an answer for another booking (or an older status) is never shown here.
  const [quote, setQuote] = useState({ key: null, data: null });
  const [refresh, setRefresh] = useState(0);
  const [step, setStep] = useState({ key: null, mode: 'idle', result: null }); // idle | confirm | busy | done

  useEffect(() => {
    if (!chargeable || !b?.locationId || training) return undefined;
    let alive = true;
    let retried = false;
    let timer = null;
    // The store changes before the database write lands (updateBooking): a quote asked straight
    // after No-show can still see the old status. Ask once more, 1.5 s later.
    const run = () => quoteNoShowCharge(b.locationId, b.id).then((data) => {
      if (!alive) return;
      if (deadStatus && data?.ok && data.reason === 'not_chargeable' && !retried) {
        retried = true;
        timer = setTimeout(run, 1500);
        return;
      }
      setQuote({ key, data });
    });
    run();
    return () => { alive = false; clearTimeout(timer); };
  }, [chargeable, deadStatus, training, b?.locationId, b?.id, key, refresh]);

  // A charge waiting for the bank: ask again every 15 s, so Adyen's answer shows by itself.
  const waiting = quote.key === key && quote.data?.reason === 'charge_in_flight';
  useEffect(() => {
    if (!waiting) return undefined;
    const t = setInterval(() => setRefresh((n) => n + 1), 15000);
    return () => clearInterval(t);
  }, [waiting]);

  if (!chargeable) return null;
  if (training) return hasSavedCard ? <Note col="var(--t4)">Charging the saved card is off in training mode.</Note> : null;
  const q = quote.key === key ? quote.data : null;
  const s = step.key === key ? step : { mode: 'idle', result: null };
  if (!q) return null;   // still asking: the Payment line above already says what is on file

  if (!q.ok) {
    if (q.missing) {
      return hasSavedCard ? <Note col="var(--t4)">Charging the saved card is not switched on here yet.</Note> : null;
    }
    return hasSavedCard ? <Note col="var(--t4)">{q.message || 'Could not check the saved card just now.'}</Note> : null;
  }

  // A "still waiting" answer is old news once the ledger says the charge may be tried again.
  const result = s.result?.pending ? null : s.result;
  const charges = Array.isArray(q.charges) ? q.charges : [];
  const lastFail = [...charges].reverse().find((c) => c.status === 'failed');

  const charge = async () => {
    setStep({ key, mode: 'busy', result: null });
    const res = await chargeNoShow(b.locationId, b.id, { expectedMinor: q.amountMinor, staffName: operatorName });
    if (res?.ok && typeof onCharged === 'function') onCharged(res);
    // The card then shows what the ledger now holds (read before the answer is shown, so a
    // stale quote never offers the button again under a "still waiting" answer).
    const fresh = await quoteNoShowCharge(b.locationId, b.id);
    setQuote({ key, data: fresh });
    setStep({ key, mode: 'done', result: res });
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
            To give it back, refund check {ref} in History on the till, or in Transactions in Back Office.
          </div>
        )}
      </Box>
    );
  }

  const amount = moneyText(q.amountMinor, q.currency);
  const busy = s.mode === 'busy';

  // A charge that never got an answer: the same request is asked for again (never a new charge).
  if (q.reason === 'stale_in_flight') {
    return (
      <Box col="var(--orn)">
        <Title col="var(--orn)">{q.label || chargeLabel(q.kind)}</Title>
        <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.45 }}>{q.message}</div>
        {result && !result.ok && (
          <div role="alert" style={{ marginTop: 8, fontSize: 13.5, fontWeight: 700, lineHeight: 1.4, color: 'var(--red)' }}>{result.message}</div>
        )}
        <button className="btn btn-ghost" disabled={busy} onClick={charge}
          style={{ marginTop: 10, width: '100%', height: 44, fontWeight: 800, opacity: busy ? 0.6 : 1, ...BTN_FIT }}>
          {busy ? 'Asking…' : 'Check with the bank again'}
        </button>
      </Box>
    );
  }

  if (!q.chargeable) {
    if (QUIET.has(q.reason) || (!hasSavedCard && !ABOUT_A_CHARGE.has(q.reason))) return null;
    const amber = q.reason === 'charge_in_flight';
    return <Note col={amber ? 'var(--orn)' : 'var(--t3)'}>{q.message}</Note>;
  }

  return (
    <Box col="var(--red)">
      <Title col="var(--red)">{q.label || chargeLabel(q.kind)}</Title>
      <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.45 }}>
        {q.covers > 1 && q.perCoverMinor > 0
          ? `${moneyText(q.perCoverMinor, q.currency)} a guest for ${q.covers} guests, the card hold agreed when they booked.`
          : 'The card hold the guest agreed to when they booked.'}
        {q.kind === 'late_cancel' && Number.isFinite(q.hoursBefore) && ` Cancelled ${hoursText(q.hoursBefore)}, inside the ${q.windowHours} hour window.`}
      </div>
      {result && !result.ok && (
        <div role="alert" style={{ marginTop: 8, fontSize: 13.5, fontWeight: 700, lineHeight: 1.4, color: 'var(--red)' }}>
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
            <button className="btn btn-ghost" onClick={() => setStep({ key, mode: 'idle', result: null })} style={{ flex: 1, height: 44, ...BTN_FIT }}>Not now</button>
            <button className="btn btn-red" onClick={charge} style={{ flex: 1, height: 44, fontWeight: 800, ...BTN_FIT }}>Charge {amount}</button>
          </div>
        </div>
      ) : (
        <button className="btn btn-red" disabled={busy} onClick={() => setStep({ key, mode: 'confirm', result: null })}
          style={{ marginTop: 10, width: '100%', height: 44, fontWeight: 800, opacity: busy ? 0.6 : 1, ...BTN_FIT }}>
          {busy ? 'Charging…' : result && !result.ok ? `Try again: ${amount}` : `Charge ${amount}`}
        </button>
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
