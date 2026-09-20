// PaymentCheckModal: database fence stage 1, fix round (docs/FENCE_STAGE_1_APP.md section 11, S3).
//
// An online, QR or catering order whose payment the server could not prove yet arrives as
// "Payment being checked" (customer.payment_state 'checking'). It is never charged again. Staff
// have two ways to settle it, and both write the paid check the server kept aside, so the sale
// reaches the reports:
//   - Check payment: the payment-proof function reads the card processor again, then
//     verify_public_order_payment counts the proof.
//   - Confirm payment (manager PIN, with a note): a manager saw the money in the card processor
//     (confirm_public_order_payment records who and why).
// Rules live in lib/orderPayment.js (tested). This file is only the buttons.
import { useState } from 'react';
import { useStore } from '../store';
import { supabase, getActiveLocationSync } from '../lib/supabase';
import { isMissingRpc } from '../lib/deviceFence';
import { requestPaymentProof } from '../lib/publicOrderClient';
import { money } from '../lib/currency';
import { shortOrderRef } from '../lib/db';
import {
  PAYMENT_CHECKING_LABEL, PAYMENT_CHECKING_HELP, paymentCheckRequest,
  checkOrderPayment, confirmOrderPayment, markOrderPaymentSettled,
  PAYMENT_SHORT_HELP, paymentShortInfo, paymentShortLine, paymentStatusLabel,
} from '../lib/orderPayment';

const managerPinsFrom = (staffMembers) =>
  (staffMembers || [])
    .filter(s => s.role === 'Manager' && s.active !== false && s.pin)
    .map(s => ({ pin: String(s.pin), name: s.name, id: s.id }));

/** Mirror the server's answer on this till at once (realtime brings the row as well). */
function settleLocally(ref, byStaff) {
  const s = useStore.getState();
  const q = s.orderQueue || [];
  if (!q.some(o => o.ref === ref)) return;
  useStore.setState({ orderQueue: q.map(o => (o.ref === ref ? markOrderPaymentSettled(o, { byStaff }) : o)) });
}

export default function PaymentCheckModal({ order, onClose, onSettled }) {
  const { staff, staffMembers, showToast } = useStore();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [step, setStep] = useState('check');    // check | pin | note
  const [pin, setPin] = useState('');
  const [manager, setManager] = useState(staff?.role === 'Manager' ? staff : null);
  const [note, setNote] = useState('');
  if (!order) return null;

  const locationId = getActiveLocationSync();
  const req = paymentCheckRequest(order);
  const rpc = (name, args) => supabase.rpc(name, args);
  // Fix round 2 (S5): an order paid less than the server's own price ('short').
  const short = paymentShortInfo(order);
  const label = paymentStatusLabel(order);

  const done = (res, byStaff) => {
    settleLocally(order.ref, byStaff);
    showToast?.(`${shortOrderRef(order.ref)}: payment ${byStaff ? 'confirmed' : 'checked'}. It is paid.`, 'success');
    onSettled?.(res);
    onClose?.();
  };

  const onCheck = async () => {
    if (busy) return;
    setBusy(true); setMsg('');
    const res = await checkOrderPayment({
      requestProof: (r) => requestPaymentProof({ opsLocationId: locationId, processor: r.processor, kind: r.kind, paymentRef: r.paymentRef }),
      rpc, locationId, order, isMissingRpc,
    });
    setBusy(false);
    if (res.status === 'paid') return done(res, false);
    setMsg(res.message || 'Not confirmed yet.');
  };

  const onPinDigit = (d) => {
    if (pin.length >= 4) return;
    const next = pin + d;
    setPin(next);
    if (next.length === 4) {
      const m = managerPinsFrom(staffMembers).find(x => x.pin === next);
      if (m) { setManager(m); setStep('note'); setMsg(''); }
      else { setMsg('Incorrect manager PIN'); setTimeout(() => setPin(''), 500); }
    }
  };

  const onConfirm = async () => {
    if (busy) return;
    setBusy(true); setMsg('');
    const res = await confirmOrderPayment({
      rpc, locationId, order, isMissingRpc,
      note: `${note.trim()}${manager?.name ? ` (manager: ${manager.name})` : ''}`,
    });
    setBusy(false);
    if (res.status === 'paid') return done(res, true);
    setMsg(res.message || 'Could not confirm.');
  };

  const btn = (bg, fg) => ({ padding: '10px 14px', borderRadius: 9, border: 'none', background: bg, color: fg, fontWeight: 800, fontSize: 13, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit', opacity: busy ? 0.6 : 1 });

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1300, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div role="dialog" aria-label={label || PAYMENT_CHECKING_LABEL} onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 420, background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 18, color: 'var(--t1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 8, background: '#f59e0b22', border: '1px solid #f59e0b66', color: '#b45309' }}>{label.toUpperCase()}</span>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>{shortOrderRef(order.ref)}</span>
          <span style={{ fontSize: 15, fontWeight: 800, fontFamily: 'var(--font-mono)' }}>{money(Number(order.total) || 0)}</span>
        </div>
        {short && (
          <div style={{ fontSize: 13, fontWeight: 800, color: '#b45309', marginBottom: 4 }}>{paymentShortLine(order, money)}</div>
        )}
        <div style={{ fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.5, marginBottom: 12 }}>
          {short ? PAYMENT_SHORT_HELP : PAYMENT_CHECKING_HELP}
          {req ? ` Card payment ${req.paymentRef.slice(-8)} (${req.processor}).` : ' No card payment is named on this order: a manager can confirm it.'}
        </div>

        {step === 'check' && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={onCheck} disabled={busy} style={btn('#f59e0b', '#0b0c10')}>{busy ? 'Checking…' : 'Check payment'}</button>
            <button onClick={() => { setMsg(''); setStep(manager ? 'note' : 'pin'); }} disabled={busy} style={btn('var(--bg3)', 'var(--t1)')}>Confirm payment</button>
            <button onClick={onClose} style={{ ...btn('transparent', 'var(--t3)'), marginLeft: 'auto' }}>Close</button>
          </div>
        )}

        {step === 'pin' && (
          <div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 8 }}>Manager PIN to confirm a payment seen in the card processor.</div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginBottom: 10 }}>
              {[0, 1, 2, 3].map(i => <div key={i} style={{ width: 12, height: 12, borderRadius: '50%', background: i < pin.length ? 'var(--acc)' : 'var(--bg4)' }} />)}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6 }}>
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((d, i) => (
                <button key={i} disabled={!d}
                  onClick={() => (d === '⌫' ? setPin(p => p.slice(0, -1)) : onPinDigit(d))}
                  style={{ height: 42, borderRadius: 8, border: '1px solid var(--bdr)', background: d ? 'var(--bg2)' : 'transparent', color: 'var(--t1)', fontSize: 16, fontWeight: 700, cursor: d ? 'pointer' : 'default', fontFamily: 'inherit' }}>{d}</button>
              ))}
            </div>
            <button onClick={() => { setStep('check'); setPin(''); setMsg(''); }} style={{ ...btn('transparent', 'var(--t3)'), marginTop: 8 }}>Back</button>
          </div>
        )}

        {step === 'note' && (
          <div>
            {short && (
              <div style={{ fontSize: 12, color: 'var(--t2)', marginBottom: 6, lineHeight: 1.5 }}>
                Confirming books only the {money(short.provenMinor / 100)} the online payment took. If you took the rest on the till, that is its own sale.
              </div>
            )}
            <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 6 }}>What did you check? For example "seen in Stripe, 12.50".</div>
            <input value={note} onChange={e => setNote(e.target.value)} maxLength={160} autoFocus
              style={{ width: '100%', boxSizing: 'border-box', padding: '9px 10px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--bg)', color: 'var(--t1)', fontFamily: 'inherit', fontSize: 13, marginBottom: 10 }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={onConfirm} disabled={busy || !note.trim()} style={btn('#16a34a', '#fff')}>{busy ? 'Confirming…' : 'Confirm payment'}</button>
              <button onClick={() => { setStep('check'); setMsg(''); }} style={btn('transparent', 'var(--t3)')}>Back</button>
            </div>
          </div>
        )}

        {msg && <div style={{ marginTop: 10, fontSize: 12.5, color: '#b45309', lineHeight: 1.5 }}>{msg}</div>}
      </div>
    </div>
  );
}
