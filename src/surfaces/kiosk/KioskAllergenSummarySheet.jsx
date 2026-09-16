/**
 * KioskAllergenSummarySheet: the allergens in the basket, opened from "See allergens" on the
 * allergen check row (decision 12). One line per allergen with the items that contain it.
 * The list is lib/kioskAllergens.js basketAllergens.
 */
import { t, tf } from '../../lib/i18n';
import { kioskAllergenLabels } from '../../lib/kioskAllergens';
import { translateEnglish, useMenuText } from '../../lib/menuText';
import { WarningIcon } from './KioskIcons';

export default function KioskAllergenSummarySheet({ list, onClose }) {
  useMenuText();   // item names in the customer's language
  return (
    <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'var(--k2Scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 56, zIndex: 30 }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('k2.allergenAck.sheetTitle')}
        onClick={(e) => e.stopPropagation()}
        style={{ background: '#FFFFFF', borderRadius: 36, padding: 44, width: '100%', display: 'flex', flexDirection: 'column', gap: 22, animation: 'kfade .2s ease', maxHeight: '100%', overflowY: 'auto' }}
      >
        <div style={{ fontSize: 42, fontWeight: 800, color: 'var(--k2Ink)', lineHeight: 1.1 }}>{t('k2.allergenAck.sheetTitle')}</div>
        <div style={{ fontSize: 21, color: 'var(--k2InkSubtle)', marginTop: -10, lineHeight: 1.35 }}>{t('k2.allergenAck.sheetSub')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {list.map(({ id, names }) => (
            <div key={id} style={{ display: 'flex', alignItems: 'flex-start', gap: 14, background: 'var(--k2WarnFill)', border: '2px solid var(--k2WarnBorder)', borderRadius: 18, padding: '18px 22px', fontSize: 22, color: 'var(--k2Ink)' }}>
              <span style={{ color: 'var(--k2WarnInk)', flex: 'none', marginTop: 2 }}><WarningIcon size={26} /></span>
              <span style={{ overflowWrap: 'anywhere' }}>
                {tf('k2.allergenAck.contains', { allergen: kioskAllergenLabels([id], t)[0] || id, items: names.map(translateEnglish).join(', ') })}
              </span>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{ border: 0, background: 'var(--k2Primary)', color: 'var(--k2OnPrimary)', borderRadius: 26, height: 112, fontSize: 30, fontWeight: 800, cursor: 'pointer' }}
        >{t('k2.common.close')}</button>
      </div>
    </div>
  );
}
