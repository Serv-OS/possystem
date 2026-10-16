// src/surfaces/bookings/PayLinkPanel.jsx
//
// Pay link from the stand (16 Oct 2026, v5.11.70 host tools, plan item 9).
// A booking taken by phone on a package that takes a deposit or a prepay, or
// at a venue with a card hold, gets a text with a pay link. The guest pays on
// the venue's own booking page (the same card form the online booking uses).
// After migration 20261016d the booking waits as Awaiting payment while the
// link is live (24 hours); before it the booking stays confirmed and the link
// still works. booking-host sends it; booking-widget takes the payment.

import { useState } from 'react';
import { useStore } from '../../store';
import { moneyMinor } from '../../lib/currency';
import { paymentDue, packagePaymentNeed } from '../../../supabase/functions/_shared/bookingPayment.js';
import { sendPayLink } from '../../lib/bookings/hostData.js';
import { rulesOf } from './bits.jsx';

const fmtUntil = (iso, tz) => {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  } catch { return ''; }
};

export default function PayLinkPanel({ b, by = null }) {
  const packages = useStore((s) => s.packages) || [];
  const bookingRules = useStore((s) => s.bookingRules);
  const tz = useStore((s) => s.locationConfig?.timezone);
  const rules = rulesOf(bookingRules);
  const payable = packages.filter((p) => p.isActive !== false && packagePaymentNeed(p).needsPayment);
  const own = b.packageId ? payable.find((p) => p.id === b.packageId) : null;
  const holdOn = Number(bookingRules?.holdPerCover) > 0;
  const [choice, setChoice] = useState(own ? own.id : (holdOn ? 'hold' : (payable[0]?.id || '')));
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState(null);
  const [forId, setForId] = useState(b.id);
  if (forId !== b.id) { setForId(b.id); setOut(null); setChoice(own ? own.id : (holdOn ? 'hold' : (payable[0]?.id || ''))); }

  const live = b.status === 'confirmed' || (b.status === 'pending_payment' && b.source !== 'widget');
  if (!live || Number(b.paidMinor) > 0) return null;
  if (!payable.length && !holdOn) return null;
  const phone = b.customer?.phone;

  const pkg = choice && choice !== 'hold' ? payable.find((p) => p.id === choice) : null;
  const due = pkg
    ? paymentDue({ covers: b.covers, pkg, rules: null })
    : paymentDue({ covers: b.covers, pkg: null, rules: { cardCaptureEnabled: true, cardCaptureMinCovers: 0, holdPerCover: rules.holdPerCover } });
  const dueWords = !due ? 'Nothing to pay'
    : due.kind === 'hold' ? 'Card saved, nothing taken'
    : due.kind === 'deposit' ? `${moneyMinor(due.amountMinor)} deposit` : `${moneyMinor(due.amountMinor)} prepay`;

  const send = async () => {
    if (busy || !due) return;
    setBusy(true); setOut(null);
    const res = await sendPayLink(b.id, { packageId: pkg ? pkg.id : null, kind: pkg ? null : 'hold', by });
    setBusy(false);
    setOut(res);
  };
  const copy = async (link) => {
    try { await navigator.clipboard.writeText(link); setOut((o) => ({ ...o, copied: true })); } catch { /* the link is on screen */ }
  };

  const waiting = b.status === 'pending_payment' && b.payLinkUntil;
  return (
    <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, border: '1px dashed var(--bdr2)' }}>
      <div style={{ fontSize: 12.5, fontWeight: 800 }}>{waiting ? 'Pay link sent' : 'Take a deposit by text'}</div>
      {waiting && (
        <div style={{ fontSize: 12.5, color: 'var(--orn)', fontWeight: 700, marginTop: 3, lineHeight: 1.4 }}>
          Waiting for the guest to pay until {fmtUntil(b.payLinkUntil, tz)}. Then the booking is released.
        </div>
      )}
      {!phone ? (
        <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4, lineHeight: 1.4 }}>Add the guest&rsquo;s mobile with Edit to text them a pay link.</div>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {payable.map((p) => (
              <button key={p.id} onClick={() => setChoice(p.id)} aria-pressed={choice === p.id}
                style={{ fontSize: 12, fontWeight: 700, padding: '7px 10px', minHeight: 36, borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit',
                  background: choice === p.id ? 'color-mix(in srgb, var(--acc) 14%, transparent)' : 'var(--bg3)',
                  border: `1.5px solid ${choice === p.id ? 'var(--acc)' : 'var(--bdr2)'}`, color: choice === p.id ? 'var(--acc)' : 'var(--t2)' }}>
                {p.name}
              </button>
            ))}
            {holdOn && (
              <button onClick={() => setChoice('hold')} aria-pressed={choice === 'hold'}
                style={{ fontSize: 12, fontWeight: 700, padding: '7px 10px', minHeight: 36, borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit',
                  background: choice === 'hold' ? 'color-mix(in srgb, var(--acc) 14%, transparent)' : 'var(--bg3)',
                  border: `1.5px solid ${choice === 'hold' ? 'var(--acc)' : 'var(--bdr2)'}`, color: choice === 'hold' ? 'var(--acc)' : 'var(--t2)' }}>
                Card hold
              </button>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--t2)', marginTop: 6 }}>{dueWords} for {b.covers} covers, texted to {phone}</div>
          <button className="btn btn-acc" onClick={send} disabled={busy || !due} style={{ width: '100%', height: 42, marginTop: 8, fontWeight: 800 }}>
            {busy ? 'Sending…' : waiting ? 'Send the pay link again' : 'Text a pay link'}
          </button>
        </>
      )}
      {out && !out.ok && <div role="alert" style={{ fontSize: 12.5, color: 'var(--red)', fontWeight: 700, marginTop: 6, lineHeight: 1.45 }}>{out.error || 'Pay link NOT sent.'}</div>}
      {out?.ok && (
        <div role="status" style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.45, fontWeight: 700, color: out.sms?.sent ? 'var(--grn)' : 'var(--orn)' }}>
          {out.sms?.sent ? 'Pay link texted to the guest.' : `The text did not go (${out.sms?.reason || 'unknown reason'}). Read the link to the guest or copy it.`}
          {out.waitsUntil ? ` The booking waits for payment until ${fmtUntil(out.waitsUntil, tz)}.` : ' The booking stays confirmed while the guest pays.'}
          {out.link && (
            <button className="btn btn-ghost" onClick={() => copy(out.link)} style={{ display: 'block', width: '100%', height: 36, marginTop: 6, fontSize: 12 }}>
              {out.copied ? 'Link copied' : 'Copy the link'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
