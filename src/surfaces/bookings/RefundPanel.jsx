// src/surfaces/bookings/RefundPanel.jsx
//
// Refund a booking payment (16 Oct 2026, v5.11.70 host tools, plan item 4).
// On the host stand's booking card and in Back Office, Table bookings. Lists
// the money taken for the booking with what has gone back, and gives each
// payment a Refund button: the whole amount, the part the bill did not use, or
// any part (part refunds arrive with migration 20261016d). The host stand asks
// for a manager's PIN, checked on the server; a Back Office login needs none.
// The money goes back through adyen-modify (booking_refund); the row reads
// "on its way" until Adyen confirms. A card hold took nothing, so it has no
// Refund button. Rules: supabase/functions/_shared/bookingHost.js (tested).

import { useCallback, useEffect, useState } from 'react';
import { moneyMinor } from '../../lib/currency';
import { loadBookingMoney, refundBookingPayment } from '../../lib/bookings/hostData.js';

const KIND = { prepay: 'prepaid', deposit: 'deposit', no_show_charge: 'no-show charge' };
const inp = {
  background: 'var(--bg3)', border: '1px solid var(--bdr2)', borderRadius: 9, color: 'var(--t1)',
  padding: '8px 10px', fontSize: 14, fontFamily: 'inherit', height: 40, boxSizing: 'border-box', width: '100%',
};

export default function RefundPanel({ b, backOffice = false, by = null, onChanged = null }) {
  const [state, setState] = useState({ id: null, res: null });
  const [nonce, setNonce] = useState(0);
  const [open, setOpen] = useState(null);      // payment id with the refund box open
  const [amount, setAmount] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);        // { ok, text }

  useEffect(() => {
    let alive = true;
    loadBookingMoney(b.id).then((res) => { if (alive) setState({ id: b.id, res }); });
    return () => { alive = false; };
  }, [b.id, b.status, nonce]);

  // A different booking closes the box and clears the last message (render adjustment).
  const [forId, setForId] = useState(b.id);
  if (forId !== b.id) { setForId(b.id); setOpen(null); setMsg(null); setPin(''); }

  const res = state.id === b.id ? state.res : null;
  const rows = res?.ok ? (res.rows || []) : [];
  const money = rows.filter((r) => r.kind !== 'refund' && r.kind !== 'hold');

  // Before the database update only a full refund is allowed, so the box offers what is left.
  const openBox = useCallback((r, partial) => {
    setOpen(r.id); setMsg(null); setPin('');
    setAmount((Math.max(0, partial ? (r.suggestMinor || r.leftMinor) : r.leftMinor) / 100).toFixed(2));
  }, []);

  if (!res) return null;
  if (!res.ok) {
    if (!res.notDeployed) return null;
    return <div style={{ fontSize: 12, color: 'var(--t4)', marginTop: 8, lineHeight: 1.45 }}>Refunds from here arrive with the next server update.</div>;
  }
  if (!money.length) return null;

  const doRefund = async (r) => {
    const minor = Math.round(Number(String(amount).replace(/[^0-9.]/g, '')) * 100);
    if (!(minor > 0)) { setMsg({ ok: false, text: 'Enter an amount above zero.' }); return; }
    if (!backOffice && !/^\d{3,8}$/.test(pin)) { setMsg({ ok: false, text: 'A manager enters their PIN to refund.' }); return; }
    setBusy(true); setMsg(null);
    const out = await refundBookingPayment({ paymentId: r.id, amountMinor: minor, managerPin: backOffice ? null : pin, by });
    setBusy(false);
    if (out?.ok) {
      setMsg({ ok: true, text: `Refund of ${moneyMinor(minor)} sent${out.approved_by ? `, approved by ${out.approved_by}` : ''}. It shows as refunded once the bank confirms, usually within minutes.` });
      setOpen(null); setPin('');
      setNonce((n) => n + 1);
      onChanged?.();
      return;
    }
    setMsg({ ok: false, text: out?.error || 'Refund NOT made. Try again.' });
  };

  return (
    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {money.map((r) => {
        const seatedHold = res.bookingStatus === 'dining' && !r.applied;
        const can = r.refundable && r.leftMinor > 0 && r.hasPsp && !seatedHold;
        return (
          <div key={r.id} style={{ padding: '9px 11px', borderRadius: 10, background: 'var(--bg3)', border: '1px solid var(--bdr)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.4 }}>
                <span style={{ fontWeight: 800 }}>{moneyMinor(r.amountMinor)}</span> {KIND[r.kind] || r.kind}{r.card ? ` · ${r.card}` : ''}
                {r.refundedMinor > 0 && <span style={{ color: 'var(--orn)', fontWeight: 700 }}> · {moneyMinor(r.refundedMinor)} refunded</span>}
                {r.status === 'refunded' && <span style={{ color: 'var(--t3)' }}> · refunded in full</span>}
              </div>
              {can && open !== r.id && (
                <button className="btn btn-ghost" onClick={() => openBox(r, res.partialAllowed)} style={{ height: 34, padding: '0 12px', fontSize: 12, fontWeight: 800, flexShrink: 0 }}>Refund</button>
              )}
            </div>
            {r.refundDueMinor > 0 && r.leftMinor > 0 && (
              <div style={{ fontSize: 12, color: 'var(--orn)', fontWeight: 700, marginTop: 4 }}>{moneyMinor(r.refundDueMinor)} was not used on the bill. Give it back with Refund.</div>
            )}
            {seatedHold && r.leftMinor > 0 && (
              <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4, lineHeight: 1.4 }}>Seated: this money comes off the bill. Refund anything left over after the bill closes.</div>
            )}
            {(r.refunds || []).map((x) => (
              <div key={x.id} style={{ fontSize: 12, marginTop: 4, color: x.status === 'failed' ? 'var(--red)' : x.status === 'pending' ? 'var(--t3)' : 'var(--grn)' }}>
                {x.status === 'pending' ? `${moneyMinor(x.amountMinor)} refund on its way` : x.status === 'failed' ? `${moneyMinor(x.amountMinor)} refund failed${x.reason ? `: ${x.reason}` : ''}` : `${moneyMinor(x.amountMinor)} refunded`}
              </div>
            ))}
            {open === r.id && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)' }}>
                  Amount to refund (up to {moneyMinor(r.leftMinor)})
                  <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" disabled={!res.partialAllowed}
                    aria-label="Refund amount" style={{ ...inp, marginTop: 4, fontFamily: 'var(--font-mono)' }} />
                </label>
                {!res.partialAllowed && (
                  <div style={{ fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.4 }}>Part refunds arrive with the database update; this refunds the full amount left.</div>
                )}
                {!backOffice && (
                  <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)' }}>
                    Manager PIN
                    <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} type="password" inputMode="numeric" autoComplete="off"
                      aria-label="Manager PIN" style={{ ...inp, marginTop: 4, letterSpacing: '.3em' }} />
                  </label>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost" onClick={() => { setOpen(null); setMsg(null); }} disabled={busy} style={{ flex: 1, height: 42 }}>Keep</button>
                  <button className="btn btn-red" onClick={() => doRefund(r)} disabled={busy} style={{ flex: 2, height: 42, fontWeight: 800 }}>
                    {busy ? 'Refunding…' : `Refund to the card`}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {msg && (
        <div role={msg.ok ? 'status' : 'alert'} style={{ fontSize: 12.5, lineHeight: 1.45, fontWeight: 700, color: msg.ok ? 'var(--grn)' : 'var(--red)' }}>{msg.text}</div>
      )}
    </div>
  );
}
