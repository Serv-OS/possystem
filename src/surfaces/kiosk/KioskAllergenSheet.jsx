/**
 * KioskAllergenSheet: pick allergens to avoid (decision 11). Matching items are MARKED on
 * the menu (dimmed, Unsafe badge), never hidden. The 14 UK allergens from the menu editor,
 * in the design order, so matching is exact (lib/kioskAllergens.js).
 * Centred modal in the prototype's geometry. Picks apply as they are tapped.
 */
import { t } from '../../lib/i18n';
import { UK_ALLERGENS, kioskAllergenKey, toggleAllergen } from '../../lib/kioskAllergens';

export default function KioskAllergenSheet({ allergenFilter, setAllergenFilter, onClose }) {
  const selected = allergenFilter instanceof Set ? allergenFilter : new Set();
  return (
    <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'var(--k2Scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 56, zIndex: 30 }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('k2.allergens.title')}
        onClick={(e) => e.stopPropagation()}
        style={{ background: '#FFFFFF', borderRadius: 36, padding: 44, width: '100%', display: 'flex', flexDirection: 'column', gap: 24, animation: 'kfade .2s ease', maxHeight: '100%', overflowY: 'auto' }}
      >
        <div style={{ fontSize: 42, fontWeight: 800, color: 'var(--k2Ink)', lineHeight: 1.1 }}>{t('k2.allergens.title')}</div>
        <div style={{ fontSize: 21, color: 'var(--k2InkSubtle)', marginTop: -12, lineHeight: 1.35 }}>{t('k2.allergens.sub')}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {UK_ALLERGENS.map(id => {
            const on = selected.has(id);
            return (
              <button
                key={id}
                type="button"
                aria-pressed={on}
                onClick={() => setAllergenFilter(toggleAllergen(selected, id))}
                style={{
                  border: `2px solid ${on ? 'var(--k2Danger)' : 'var(--k2Hairline)'}`,
                  background: on ? 'var(--k2DangerFill)' : '#FFFFFF', color: 'var(--k2Ink)', borderRadius: 999,
                  padding: '18px 26px', fontSize: 22, fontWeight: 700, cursor: 'pointer',
                }}
              >{t(kioskAllergenKey(id))}</button>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 14 }}>
          {selected.size > 0 ? (
            <button
              type="button"
              onClick={() => setAllergenFilter(new Set())}
              style={{ flex: 1, border: '2px solid var(--k2Hairline)', background: '#FFFFFF', borderRadius: 26, height: 112, fontSize: 28, fontWeight: 700, color: 'var(--k2InkBody)', cursor: 'pointer' }}
            >{t('k2.allergens.clear')}</button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            style={{ flex: 1.4, border: 0, background: 'var(--k2Primary)', color: 'var(--k2OnPrimary)', borderRadius: 26, height: 112, fontSize: 30, fontWeight: 800, cursor: 'pointer' }}
          >{t('k2.allergens.show')}</button>
        </div>
      </div>
    </div>
  );
}
