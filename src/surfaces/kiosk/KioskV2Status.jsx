/**
 * KioskV2Status: the new kiosk design's loading and "not configured" screens.
 *
 * KioskApp shows these instead of today's dark loading and error screens only when the
 * profile is already known to use the new design, so a cream kiosk never flashes the old
 * look while its menu loads. The words are the same as today's screens. With the new design
 * off nothing here is used.
 *
 *   title      the main line ("Loading…" or "Kiosk not configured")
 *   detail     the smaller line under it (the error), optional
 *   onUnpair   shows the Unpair button when given
 */
import { kioskThemeVars } from '../../lib/kioskTheme';

export default function KioskV2Status({ profile, title, detail = null, onUnpair = null }) {
  return (
    <div
      data-kiosk-theme="design"
      style={{
        position: 'fixed', inset: 0, background: '#EFE4D9', color: '#14110F', display: 'grid', placeItems: 'center',
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", padding: '0 24px', ...kioskThemeVars(profile),
      }}
    >
      <div role="status" aria-live="polite" style={{ textAlign: 'center', maxWidth: 640, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <div style={{ fontSize: 34, fontWeight: 800, lineHeight: 1.15 }}>{title}</div>
        {detail ? <div style={{ fontSize: 21, color: '#7A6F63', lineHeight: 1.4 }}>{detail}</div> : null}
        {onUnpair ? (
          <button
            type="button"
            onClick={onUnpair}
            style={{
              marginTop: 12, height: 64, padding: '0 32px', borderRadius: 999, border: '2px solid #E7DFD6',
              background: '#FFFFFF', color: '#14110F', fontSize: 21, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >Unpair</button>
        ) : null}
      </div>
    </div>
  );
}
