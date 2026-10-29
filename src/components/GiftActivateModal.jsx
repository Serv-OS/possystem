// GiftActivateModal.jsx (Drop C, v5.11.118, 29 Oct 2026): after a check with gift card lines is
// paid, one step per card. Peter: "asks for the code from the gift card that is already printed, or
// you can say print a gift card receipt and the receipt prints with the gift card on it, so it's not
// just one or the other but both." Both choices are always on screen:
//   Card code       scan or type the printed card's 16 character code (a scanner types it and
//                   presses Enter) -> gift-load: a blank card is loaded, an active card topped up.
//   Print new card  gift-issue (channel pos) -> the gift slip prints and the code stays on screen.
// Later closes the modal with a plain warning: the sale is booked, the card is not; History shows
// the same two buttons for the check until every line has a card. Opened again (from History, or a
// retry), it first asks the server what the check already recorded, so a card is never issued twice
// by accident. Errors from the functions are shown as plain text under the buttons.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { ensureAuthToken, getActiveLocationSync } from '../lib/supabase';
import { printService } from '../lib/printer';
import { moneyMinor } from '../lib/currency';
import { formatGiftCodeInput, normaliseGiftCode, giftLinesOf } from '../lib/giftCardLine';
import {
  giftFunctionsUrl, issueGiftCardAtTill, loadGiftCardAtTill, giftCardsOnCheck, giftLineSlots,
  giftActivationWords, GIFT_LATER_WARNING,
} from '../lib/giftAtTill';

const label = { display: 'block', fontSize: 11, color: 'var(--t2)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 };

/**
 * @param {object}   p
 * @param {string}   p.closedCheckId  the closed check (closed_checks.id, 'chk-...') the cards belong to
 * @param {string}   [p.checkRef]     its display ref, for the slip and the title
 * @param {Array}    p.items          the check's lines (gift lines are picked out here)
 * @param {string}   [p.server]
 * @param {object}   [p.location]     the venue (branding, currency) for the slip
 * @param {Function} p.onClose        called when every card is done, or after Later
 * @param {Function} [p.onChanged]    called after a card is loaded or issued (History refreshes)
 */
export default function GiftActivateModal({ closedCheckId, checkRef = null, items = [], server = null, location = null, onClose, onChanged = null }) {
  const giftLines = giftLinesOf(items);
  const currency = location?.currency;
  const fmt = (m) => moneyMinor(m, currency);

  const [slots, setSlots] = useState(() => giftLineSlots(giftLines, []));
  const [checking, setChecking] = useState(true);
  const [step, setStep] = useState(0);            // index into slots
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(null);         // 'load' | 'issue' | null
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);         // the reply for the current step once it has a card
  const [later, setLater] = useState(false);
  const codeRef = useRef(null);

  const transport = async () => ({ functionsUrl: giftFunctionsUrl(), token: await ensureAuthToken().catch(() => null) });
  const locationId = location?.id || getActiveLocationSync();
  const staffId = useStore.getState().staff?.id || null;

  const firstOpen = (list) => { const i = list.findIndex((s) => !s.card); return i < 0 ? list.length : i; };

  // What the server already holds for this check (a retry or a History reopen never issues twice).
  useEffect(() => {
    let alive = true;
    (async () => {
      const t = await transport();
      const r = await giftCardsOnCheck({ locationId, closedCheckId }, t);
      if (!alive) return;
      if (r.ok) {
        const next = giftLineSlots(giftLines, r.cards);
        setSlots(next);
        setStep(firstOpen(next));
      }
      setChecking(false);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closedCheckId]);

  useEffect(() => { if (!checking && !done && codeRef.current) codeRef.current.focus(); }, [checking, step, done]);

  const current = slots[step] || null;
  const allDone = !checking && slots.length > 0 && slots.every((s) => s.card);
  const total = slots.length;

  const finishStep = (reply) => {
    setSlots((prev) => prev.map((s, i) => (i === step ? { ...s, card: { ...reply, type: reply.type || (reply.code ? 'issue' : 'load') } } : s)));
    setDone(reply);
    setError('');
    if (typeof onChanged === 'function') { try { onChanged(reply); } catch { /* History refresh is best effort */ } }
  };

  const doLoad = async () => {
    if (!current || busy) return;
    const clean = normaliseGiftCode(code);
    if (!clean) { setError('A card code is 16 letters and digits'); return; }
    setBusy('load'); setError('');
    const t = await transport();
    const r = await loadGiftCardAtTill({ code: clean, amountMinor: current.amountMinor, locationId, closedCheckId, staffId }, t);
    setBusy(null);
    if (!r.ok) { setError(r.error || 'Could not load the card'); return; }
    finishStep({ ...r, type: 'load' });
  };

  const doIssue = async () => {
    if (!current || busy) return;
    setBusy('issue'); setError('');
    const t = await transport();
    const r = await issueGiftCardAtTill({ amountMinor: current.amountMinor, locationId, closedCheckId, staffId }, t);
    if (!r.ok) {
      // gift-issue is NOT idempotent (every call prints a new card). A reply lost on the way back
      // (status 0) may still have issued one: ask the server before this button can be tapped again.
      if (r.status === 0) {
        const st = await giftCardsOnCheck({ locationId, closedCheckId }, t);
        const mine = st.ok ? giftLineSlots(giftLines, st.cards) : null;
        const hit = mine && mine[step]?.card && !slots[step]?.card ? mine[step].card : null;
        if (hit) {
          setBusy(null);
          finishStep({ ...hit, type: hit.type || 'issue' });
          setError(`The reply was lost: a card ending ${hit.code_last4 || '????'} was issued for this line but its code did not reach this till, so no slip printed. Void that card in Back Office and issue again if the customer has nothing in hand.`);
          return;
        }
      }
      setBusy(null); setError(r.error || 'Could not issue the card'); return;
    }
    finishStep({ ...r, type: 'issue', amount_minor: current.amountMinor });
    // The slip: fail closed like the receipt; the code stays on screen whatever the printer does.
    try {
      const p = await printService.printGiftCardSlip({
        location,
        card: { code: r.code, balance_minor: r.balance_minor ?? current.amountMinor, currency, balance_url: r.balance_url || null },
        check: { ref: checkRef, server },
      });
      if (!p?.ok) useStore.getState().showToast?.(`Gift slip not printed: ${p?.error || 'no printer set for this device'}. The code is on screen.`, 'error');
    } catch (e) {
      useStore.getState().showToast?.(`Gift slip print failed: ${e?.message || e}. The code is on screen.`, 'error');
    }
    setBusy(null);
  };

  const reprint = async () => {
    if (!done?.code) return;
    try {
      const p = await printService.printGiftCardSlip({
        location,
        card: { code: done.code, balance_minor: done.balance_minor ?? current?.amountMinor, currency, balance_url: done.balance_url || null },
        check: { ref: checkRef, server },
      }, null, { idempotencyKey: `giftslip-${String(done.code).replace(/[^A-Za-z0-9]/g, '')}-reprint-${Date.now()}` });
      if (!p?.ok) setError(`Slip not printed: ${p?.error || 'no printer set for this device'}`);
    } catch (e) { setError(`Slip not printed: ${e?.message || e}`); }
  };

  const next = () => {
    setDone(null); setCode(''); setError('');
    const i = firstOpen(slots);
    if (i >= slots.length) { onClose?.(); return; }
    setStep(i);
  };

  const title = `Gift card${total > 1 ? ` ${Math.min(step + 1, total)} of ${total}` : ''}${checkRef ? ` · ${checkRef}` : ''}`;

  return (
    <div className="modal-back" data-testid="gift-activate-modal">
      <div className="modal-box" style={{ maxWidth: 440 }}>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4, color: 'var(--t1)' }}>{title}</div>

        {checking ? (
          <div style={{ padding: '24px 0', color: 'var(--t3)', fontSize: 13 }}>Checking what this check already recorded…</div>
        ) : allDone && !done ? (
          <>
            <div style={{ fontSize: 13, color: 'var(--t2)', margin: '10px 0 16px' }}>
              {slots.map((s, i) => <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid var(--bdr)' }}>{giftActivationWords(s.card, fmt)}</div>)}
            </div>
            <button className="btn btn-acc" style={{ width: '100%' }} onClick={() => onClose?.()}>Done</button>
          </>
        ) : done ? (
          <>
            <div style={{ textAlign: 'center', padding: '14px 0 6px' }}>
              <div style={{ fontSize: 13, color: 'var(--grn)', fontWeight: 700 }}>{giftActivationWords(done, fmt)}</div>
              {done.code && (
                <>
                  <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 14, textTransform: 'uppercase', letterSpacing: '.08em' }}>Card code</div>
                  <div data-testid="gift-code-large" style={{ fontSize: 26, fontWeight: 800, letterSpacing: '.12em', fontFamily: 'var(--font-mono)', color: 'var(--t1)', marginTop: 6, wordBreak: 'break-all' }}>{done.code}</div>
                  <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 8 }}>The gift slip is printing. Hand it to the customer.</div>
                </>
              )}
            </div>
            {error && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
              {done.code && <button className="btn btn-ghost" style={{ flex: 1 }} onClick={reprint}>Print again</button>}
              <button className="btn btn-acc" style={{ flex: 2 }} onClick={next}>{firstOpen(slots) >= slots.length ? 'Done' : 'Next card'}</button>
            </div>
          </>
        ) : later ? (
          <>
            <div style={{ background: 'var(--red-d)', border: '1px solid var(--red-b)', borderRadius: 10, padding: '10px 12px', color: 'var(--red)', fontSize: 13, margin: '10px 0 16px' }}>{GIFT_LATER_WARNING}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setLater(false)}>Back</button>
              <button className="btn btn-acc" style={{ flex: 1 }} onClick={() => onClose?.()}>Close anyway</button>
            </div>
          </>
        ) : current ? (
          <>
            <div style={{ textAlign: 'center', padding: '8px 0 14px' }}>
              <div data-testid="gift-amount-large" style={{ fontSize: 34, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--t1)' }}>{fmt(current.amountMinor)}</div>
              <div style={{ fontSize: 12, color: 'var(--t3)' }}>Paid. Now put it on a card.</div>
            </div>

            {/* (a) a card the venue already printed */}
            <div style={{ border: '1px solid var(--bdr2)', borderRadius: 12, padding: 12, marginBottom: 10 }}>
              <label style={label}>Card code (scan or type)</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input ref={codeRef} className="input" data-testid="gift-code-input" placeholder="XXXX-XXXX-XXXX-XXXX" value={code}
                  autoComplete="off" spellCheck={false} inputMode="text" maxLength={19}
                  style={{ flex: 1, fontFamily: 'var(--font-mono)', letterSpacing: '.06em' }}
                  onChange={(e) => setCode(formatGiftCodeInput(e.target.value))}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doLoad(); } }} />
                <button className="btn btn-acc" disabled={!!busy || !normaliseGiftCode(code)} onClick={doLoad} style={{ minWidth: 96 }}>{busy === 'load' ? 'Loading…' : 'Load card'}</button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 6 }}>A blank card is loaded with {fmt(current.amountMinor)}. A card with money on it is topped up.</div>
            </div>

            {/* (b) a new card from the printer */}
            <div style={{ border: '1px solid var(--bdr2)', borderRadius: 12, padding: 12 }}>
              <label style={label}>No card to hand</label>
              <button className="btn btn-ghost" data-testid="gift-print-new" disabled={!!busy} onClick={doIssue} style={{ width: '100%' }}>{busy === 'issue' ? 'Issuing…' : 'Print new card'}</button>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 6 }}>Prints a gift slip with a new code and shows the code here.</div>
            </div>

            {error && <div data-testid="gift-error" style={{ color: 'var(--red)', fontSize: 12, marginTop: 10 }}>{error}</div>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
              <button className="btn btn-ghost" disabled={!!busy} onClick={() => setLater(true)} style={{ fontSize: 12 }}>Later</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ padding: '16px 0', color: 'var(--t3)', fontSize: 13 }}>No gift card lines on this check.</div>
            <button className="btn btn-acc" style={{ width: '100%' }} onClick={() => onClose?.()}>Close</button>
          </>
        )}
      </div>
    </div>
  );
}
