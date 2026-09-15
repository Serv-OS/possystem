/**
 * KioskIdleOverlay: "Still there?" over the new kiosk design (build spec 3.11).
 *
 * KioskApp's idle timer decides when it shows (engine.idleWarning) and resets the order
 * with the reason 'idle' when the countdown runs out. Any tap on the kiosk counts as
 * activity (KioskV2Root's shell), so tapping anywhere here continues the order. The card
 * screen pauses the timer while the reader is live, the order is saving or staff are
 * needed, so this never shows over those.
 */
import { t, tf } from '../../lib/i18n';

export default function KioskIdleOverlay({ countdown, onContinue }) {
  return (
    <div
      onClick={onContinue}
      style={{ position: 'absolute', inset: 0, zIndex: 60, background: 'var(--k2Scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 56, animation: 'kfade .22s ease' }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={t('k2.idle.title')}
        style={{ background: '#FFFFFF', borderRadius: 36, padding: '56px 56px 48px', width: '100%', maxWidth: 760, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, textAlign: 'center' }}
      >
        <div style={{ fontSize: 48, fontWeight: 800, lineHeight: 1.1, color: 'var(--k2Ink)' }}>{t('k2.idle.title')}</div>
        <div style={{ fontSize: 26, color: 'var(--k2InkSubtle)', fontVariantNumeric: 'tabular-nums' }}>{tf('k2.idle.sub', { n: countdown })}</div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onContinue(); }}
          style={{ marginTop: 16, width: '100%', border: 0, height: 112, borderRadius: 26, fontSize: 32, fontWeight: 800, background: 'var(--k2Primary)', color: 'var(--k2OnPrimary)', cursor: 'pointer' }}
        >{t('k2.idle.continue')}</button>
      </div>
    </div>
  );
}
