// MTender — customer-facing tip pass. The server hands the phone to the
// customer at this point; the screen is designed for a one-tap interaction.
// Tip preset → big Confirm button → auto-runs the card payment (MCardFlow).
//
// "Pay at counter" was removed in this pass — the phone is always a card
// device (Tap to Pay or assigned reader); cash always happens at the counter
// where the drawer lives, so server staff route those at the till instead.

import { useState, useEffect } from 'react';
import { useStore } from '../../store';
import { bookingCreditFor, bookingLegsForBill } from '../../lib/bookings/bookingCredit';
import { Sx, money } from './MShellStyles';
import { adyenLocalBridgeAvailable } from '../../lib/payments/adyenLocalTerminal';
import { findPaxTerminal, getPosDeviceId } from '../../lib/payments/terminalJobs';

// Fallback only. v5.8.25: the chips come from the reader bound to this handset
// (terminal_devices.tip_config, the same bands the reader's own tip screen and
// Back Office → Card readers show). This list was hard-coded, so the bands a venue
// set never appeared on the handset.
const TIP_PRESETS = [10, 12.5, 15, 20];

export default function MTender({ onBack, onConfirm }) {
  // Subscribed to the whole store (as before), so the bill below is read again whenever the
  // order, the table, the device profile or the rules change.
  const { deviceConfig } = useStore();

  // 19 Oct 2026 (v5.11.78, channel parity): THE TILL'S BILL. The handheld charges exactly what the
  // till charges for this order: store.getPOSTotals, i.e. payments/checkTotals.computeCheckTotals
  // (item discounts of either kind, the check and automatic discounts, the service charge from
  // this device's profile, any added on tax), the one implementation the counter, a table close
  // and Table Pay use. MTender used to work its own sum: it read an amount item discount as a
  // percent (2.00 off a 4.00 line charged 3.92), and it ignored check discounts, automatic deals
  // and the service charge the close then booked, so the card took a different figure from the
  // record. The tax record it hands the close is the bill's own (UK VAT on what was charged).
  const bill = useStore.getState().getPOSTotals();
  const tax = Number(bill?.tax?.totalTax) || 0;
  const exclusive = !!bill?.tax?.hasExclusiveTax;
  const exclusiveTax = Number(bill?.exclusiveTax) || 0;
  const service = Number(bill?.service) || 0;
  const discountsOff = Math.max(0, (Number(bill?.subtotal) || 0) - (Number(bill?.discountedSub) || 0));
  // The goods after every discount: what a tip % applies to (the till's tipBasis).
  const subtotal = Number(bill?.discountedSub) || 0;
  const billTotal = Number(bill?.total) || 0;
  // 19 Oct 2026 (v5.11.78, channel parity): a booked party's deposit or prepay comes off the bill
  // first, as at the till (lib/bookings/bookingCredit.js, the same two helpers CheckoutModal
  // reads): the card takes the rest plus any tip, and the close books the booking legs. A tip is
  // for tonight and is never taken from booking money.
  const stNow = useStore.getState();
  const tableSession = stNow.activeTableId ? stNow.tables.find(t => t.id === stNow.activeTableId)?.session : null;
  const booking = tableSession?.booking && ((Number(tableSession.booking.prepaidMinor) || 0) + (Number(tableSession.booking.depositMinor) || 0)) > 0
    ? tableSession.booking : null;
  const bookingCredit = bookingCreditFor(booking ? { booking } : null, billTotal);
  const bookingApplied = Math.min(bookingCredit.creditMinor / 100, billTotal);
  const bookingPayment = booking ? bookingLegsForBill(booking, bookingApplied) : null;
  // Paid in full in advance: nothing for a card to take, so it closes on the till.
  const paidInAdvance = !!bookingPayment && billTotal - bookingApplied <= 0.004;
  const preTip = Math.max(0, billTotal - (bookingPayment ? bookingApplied : 0));

  // Tip in £ amount (computed from selected preset OR custom override).
  // No tip pre-selected: this is the customer's screen, and a pre-ticked tip is the
  // exact thing the venue tipping settings were built to stop.
  const [tipPct, setTipPct] = useState(0);
  const [tipBands, setTipBands] = useState({ presets: TIP_PRESETS, enabled: true, allowCustom: true });
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { terminal } = await findPaxTerminal({ posDeviceId: getPosDeviceId() });
        const tc = terminal?.tip_config;
        if (!alive || !tc) return;
        const bands = (Array.isArray(tc.percentBands) ? tc.percentBands : Array.isArray(tc.tip_percentages) ? tc.tip_percentages : [])
          .map(Number).filter(n => Number.isFinite(n) && n > 0);
        const enabled = tc.enabled !== false && tc.tipping_enabled !== false;
        setTipBands({
          presets: enabled ? (bands.length ? bands : TIP_PRESETS) : [],   // off = no chips at all
          enabled,
          allowCustom: tc.allowCustom !== false && tc.allow_custom !== false,
        });
      } catch { /* keep the fallback */ }
    })();
    return () => { alive = false; };
  }, []);
  const [customTip, setCustomTip] = useState(null); // null | number
  // v5.8.19: the tip % applies to the goods, not to goods + sales tax (preTip
  // is what the card takes before the tip; it stays the charge basis). 19 Oct 2026: the goods
  // after every discount, as the till's tipBasis.
  const tipAmount = customTip != null ? customTip : (subtotal * tipPct) / 100;
  const grand = preTip + tipAmount;

  const paymentMode = deviceConfig?.paymentMode || 'tap_to_pay';
  // v5.6.81 — on an Adyen payment terminal this app IS the card machine, so "hand
  // the phone to your guest… card prompt follows" would send staff looking for a
  // second device that does not exist.
  const subtitle =
    adyenLocalBridgeAvailable()
      ? 'Hand the terminal to your guest. They pick a tip, confirm, then present their card here.'
      : paymentMode === 'assigned_reader'
        ? 'Hand the phone to your guest — they’ll pay on the reader after confirming.'
        : 'Hand the phone to your guest. They tap a tip and Confirm — card prompt follows.';

  const onPickPreset = (p) => { setTipPct(p); setCustomTip(null); };
  const onPickNoTip = () => { setTipPct(0); setCustomTip(0); };

  return (
    <div style={Sx.shell}>
      {/* Customer-facing header — minimal, no back arrow at the top because
          this view is for the customer; server-back lives at the bottom. */}
      <div style={{ ...Sx.header, justifyContent:'center', borderBottom:'none', padding:'14px 14px 0' }}>
        <div style={{ textAlign:'center' }}>
          <div style={{ fontSize:11, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', fontWeight:800 }}>
            Customer payment
          </div>
          <div style={{ fontSize:13, color:'var(--t3)', marginTop:4, lineHeight:1.4, padding:'0 8px' }}>
            {subtitle}
          </div>
        </div>
      </div>

      <div style={Sx.scroller}>
        {/* Total panel — large, customer-readable */}
        <div style={{ padding:'24px 16px 12px', textAlign:'center' }}>
          <div style={{ fontSize:11, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', fontWeight:700 }}>Order total</div>
          <div style={{ fontSize:32, fontWeight:800, color:'var(--t2)', fontFamily:'var(--font-mono)', letterSpacing:'-.02em', marginTop:2 }}>
            {money(preTip)}
          </div>
          {bookingPayment && (
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>{`${bookingCredit.label || 'Booking payment'} ${money(bookingApplied)} already paid (bill ${money(billTotal)})`}</div>
          )}
          {discountsOff > 0.004 && (
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>{`incl. ${money(discountsOff)} off`}</div>
          )}
          {service > 0.004 && (
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>{`incl. service ${money(service)}`}</div>
          )}
          {tax > 0 && (
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>
              {/* v5.7.31: the "+" figure is the exclusive share actually charged, never totalTax */}
              {exclusive ? `${money(preTip - exclusiveTax)} + ${money(exclusiveTax)} tax` : `incl. VAT ${money(tax)}`}
            </div>
          )}
        </div>

        {/* Tip prompt */}
        <div style={{ padding:'4px 16px 8px' }}>
          {tipBands.enabled && (
            <div style={{ fontSize:14, fontWeight:800, color:'var(--t1)', textAlign:'center', marginBottom:14 }}>
              Add a tip?
            </div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:10, marginBottom:10 }}>
            {tipBands.presets.map(p => {
              const active = customTip == null && tipPct === p;
              const amt = (subtotal * p) / 100;
              return (
                <button key={p} onClick={() => onPickPreset(p)} style={{
                  padding:'18px 8px', borderRadius:14,
                  border:`2px solid ${active ? 'var(--acc)' : 'var(--bdr2)'}`,
                  background: active ? 'var(--acc-d)' : 'var(--bg2)',
                  color: active ? 'var(--acc)' : 'var(--t1)',
                  fontFamily:'inherit', cursor:'pointer',
                  display:'flex', flexDirection:'column', alignItems:'center', gap:4, minHeight:90,
                }}>
                  <div style={{ fontSize:24, fontWeight:800 }}>{p}%</div>
                  <div style={{ fontSize:13, color: active ? 'var(--acc)' : 'var(--t3)', fontFamily:'var(--font-mono)', fontWeight:700 }}>
                    {money(amt)}
                  </div>
                </button>
              );
            })}
          </div>
          <button onClick={onPickNoTip} style={{
            width:'100%', padding:'12px', borderRadius:12,
            border:`2px solid ${customTip === 0 || tipPct === 0 ? 'var(--bdr2)' : 'transparent'}`,
            background: customTip === 0 || tipPct === 0 ? 'var(--bg3)' : 'transparent',
            color:'var(--t3)', fontSize:13, fontWeight:700, fontFamily:'inherit', cursor:'pointer',
          }}>
            No tip thanks
          </button>
        </div>

        {/* Total summary */}
        <div style={{ padding:'12px 16px 24px', textAlign:'center' }}>
          <div style={{ fontSize:11, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', fontWeight:800, marginBottom:4 }}>Total to pay</div>
          <div style={{ fontSize:46, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)', letterSpacing:'-.02em' }}>
            {money(grand)}
          </div>
          {tipAmount > 0 && (
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:4 }}>incl. {money(tipAmount)} tip</div>
          )}
        </div>
      </div>

      {/* Big customer Confirm — auto-triggers card flow */}
      <div style={Sx.bottom}>
        {paidInAdvance ? (
          <div style={{ padding:'14px 16px', borderRadius:12, background:'var(--bg2)', border:'1px solid var(--bdr)', fontSize:14, fontWeight:700, color:'var(--t2)', textAlign:'center' }}>
            Paid in advance by the booking. Close this table on the till.
          </div>
        ) : (
          <button onClick={() => onConfirm?.({ method:'card', tip: tipAmount, grand, subtotal: Number(bill?.subtotal) || 0, tax, service, chargedTaxBreakdown: bill?.tax || null, ...(bookingPayment ? { bookingPayment, bookingAppliedMajor: bookingApplied } : {}) })} style={{ ...Sx.btnPrim, fontSize:17, padding:'18px 16px', minHeight:60 }}>
            Confirm · {money(grand)}
          </button>
        )}
        <button onClick={onBack} style={{ ...Sx.btnGhost, marginTop:8 }}>
          ← Back to order
        </button>
      </div>
    </div>
  );
}
