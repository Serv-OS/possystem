/**
 * KioskPayLinkGate: database fence stage 1, fix round 2 (HIGH).
 *
 * Wraps KioskApp's ScreenPay (both the old kiosk and the new design). ScreenPay starts the card
 * reader the moment it mounts, and submitOrder books the order only AFTER the card was charged.
 * After 20260919b a kiosk that is not linked to its venue has that closed_checks insert refused,
 * and nothing keeps the order: the customer pays for food that never reaches the kitchen. So the
 * link is checked FIRST (lib/deviceLink.js confirmLinkBeforeCard) and ScreenPay only mounts when
 * the server says this kiosk is linked. Otherwise the customer is asked to fetch a member of
 * staff, and nothing is charged (a gift card or points are only spent inside submitOrder, which
 * never runs either).
 *
 * CARD PATH RULE (owner, non negotiable): this file never touches ScreenPay's logic or submitOrder
 * (kioskCardPathGuard.test.js fingerprints them). It only decides WHETHER ScreenPay mounts.
 */
import { useEffect, useState } from 'react';
import { confirmLinkBeforeCard } from '../../lib/deviceLink';

const screen = { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 'clamp(14px, 2.2vh, 24px)', padding: '6vh 6vw', textAlign: 'center' };
const btn = (primary, brandColor) => ({
  padding: 'clamp(12px, 1.6vh, 18px) clamp(22px, 3vw, 36px)',
  borderRadius: 'clamp(10px, 1.2vw, 16px)',
  border: primary ? 'none' : '1px solid var(--kBorder2, rgba(255,255,255,0.2))',
  background: primary ? (brandColor || 'var(--kAccent, #15C26A)') : 'transparent',
  color: primary ? '#fff' : 'var(--kFg, #fff)',
  fontSize: 'clamp(15px, 1.8vw, 20px)', fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit',
});

export default function KioskPayLinkGate({ children, brandColor, onBack, onCancel }) {
  const [gate, setGate] = useState({ phase: 'checking', message: null });

  useEffect(() => {
    let alive = true;
    confirmLinkBeforeCard()
      .then((r) => { if (alive) setGate(r && r.ok ? { phase: 'ok', message: null } : { phase: 'refused', message: (r && r.message) || null }); })
      .catch(() => { if (alive) setGate({ phase: 'refused', message: null }); });
    return () => { alive = false; };
  }, []);

  if (gate.phase === 'ok') return children;

  if (gate.phase === 'checking') {
    return (
      <div style={screen} data-kiosk-pay-gate="checking">
        <div style={{ fontSize: 'clamp(18px, 2.4vw, 28px)', fontWeight: 800, color: 'var(--kFg, #fff)' }}>Getting the card reader ready…</div>
      </div>
    );
  }

  return (
    <div style={screen} role="alert" data-kiosk-pay-gate="refused">
      <div style={{ fontSize: 'clamp(24px, 3.4vw, 40px)', fontWeight: 900, color: 'var(--kFg, #fff)' }}>Please ask a member of staff</div>
      <div style={{ maxWidth: 560, fontSize: 'clamp(15px, 1.9vw, 20px)', lineHeight: 1.5, color: 'var(--kFgMuted, rgba(255,255,255,0.7))' }}>
        {gate.message || 'This kiosk cannot take card payments right now. Please ask a member of staff. Nothing has been charged.'}
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center' }}>
        {onBack && <button type="button" style={btn(false, brandColor)} onClick={onBack}>Back</button>}
        {onCancel && <button type="button" style={btn(true, brandColor)} onClick={onCancel}>Start again</button>}
      </div>
    </div>
  );
}
