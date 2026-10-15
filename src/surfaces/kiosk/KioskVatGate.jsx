/**
 * KioskVatGate: the kiosk never opens its card screen while it cannot book the VAT (8 Oct 2026).
 *
 * The VAT audit of 8 Oct 2026 (Fix 2) found the kiosk kept an empty rates list after one failed
 * tax_rates read and wrote tax_amount null for every sale until a restart. ScreenPay starts the
 * card reader the moment it mounts, so the check must happen BEFORE it mounts, the way
 * KioskPayLinkGate checks the device link. This gate decides WHETHER ScreenPay mounts: with the
 * rates loaded it renders its children; otherwise the customer is asked to fetch a member of staff,
 * who can press Try again (a fresh tax_rates read, lib/kioskVat.js) or start again. Nothing is
 * charged, and a gift card or points are only spent inside submitOrder, which never runs either.
 *
 * CARD PATH RULE (owner, non negotiable): this file never touches ScreenPay's logic or submitOrder
 * (kioskCardPathGuard.test.js fingerprints them). It only decides whether ScreenPay mounts.
 *
 * The gate state comes from KioskApp through a context (KioskVatGateContext), so the new design's
 * LinkedScreenPay, a module level component, can read it without a new prop on every screen.
 */
import { useContext } from 'react';
import { KIOSK_VAT_WORDS } from '../../lib/kioskVat';
import { KioskVatGateContext } from './kioskVatGateContext';

const screen = { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 'clamp(14px, 2.2vh, 24px)', padding: '6vh 6vw', textAlign: 'center' };
const btn = (primary, brandColor) => ({
  padding: 'clamp(12px, 1.6vh, 18px) clamp(22px, 3vw, 36px)',
  borderRadius: 'clamp(10px, 1.2vw, 16px)',
  border: primary ? 'none' : '1px solid var(--kBorder2, rgba(255,255,255,0.2))',
  background: primary ? (brandColor || 'var(--kAccent, #15C26A)') : 'transparent',
  color: primary ? '#fff' : 'var(--kFg, #fff)',
  fontSize: 'clamp(15px, 1.8vw, 20px)', fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit',
});

export default function KioskVatGate({ children, brandColor, onBack, onCancel, gate: gateProp, onRetry: onRetryProp }) {
  const ctx = useContext(KioskVatGateContext) || {};
  const gate = gateProp !== undefined ? gateProp : ctx.gate;
  const onRetry = onRetryProp || ctx.onRetry || null;

  if (!gate) return children;

  return (
    <div style={screen} role="alert" data-kiosk-vat-gate={gate.code || 'shut'}>
      <div style={{ fontSize: 'clamp(24px, 3.4vw, 40px)', fontWeight: 900, color: 'var(--kFg, #fff)' }}>{KIOSK_VAT_WORDS.title}</div>
      <div style={{ maxWidth: 560, fontSize: 'clamp(15px, 1.9vw, 20px)', lineHeight: 1.5, color: 'var(--kFgMuted, rgba(255,255,255,0.7))' }}>
        {gate.message}
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center' }}>
        {onRetry && <button type="button" style={btn(true, brandColor)} onClick={onRetry}>{KIOSK_VAT_WORDS.retry}</button>}
        {onBack && <button type="button" style={btn(false, brandColor)} onClick={onBack}>Back</button>}
        {onCancel && <button type="button" style={btn(false, brandColor)} onClick={onCancel}>Start again</button>}
      </div>
    </div>
  );
}
