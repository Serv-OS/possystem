/**
 * KioskLanguageSheet: pick the kiosk language, as a README bottom sheet.
 * New design text is English for now and falls back to English in every language
 * (decision 17); switching still translates the lines that already have translations.
 */
import { t, LANGUAGES } from '../../lib/i18n';
import { KioskCloseButton } from './KioskChrome';

export default function KioskLanguageSheet({ currentLang, onPick, onClose }) {
  return (
    <div
      onClick={onClose}
      style={{ position: 'absolute', inset: 0, background: 'var(--k2Scrim)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', zIndex: 40 }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('language.choose')}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#FFFFFF', borderRadius: '40px 40px 0 0', padding: 40, display: 'flex', flexDirection: 'column',
          gap: 22, maxHeight: 'calc(100% - 140px)', animation: 'kfade .22s ease',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ fontSize: 40, fontWeight: 800, color: 'var(--k2Ink)' }}>{t('language.choose')}</div>
          <KioskCloseButton onClick={onClose} label={t('language.close')} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto', minHeight: 0 }}>
          {LANGUAGES.map((L) => {
            const selected = L.code === currentLang;
            return (
              <button
                key={L.code}
                type="button"
                aria-pressed={selected}
                onClick={() => onPick(L.code)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 22, minHeight: 104, padding: '0 28px', borderRadius: 20,
                  border: `2px solid ${selected ? 'var(--k2PrimaryLine)' : 'var(--k2Hairline)'}`,
                  background: selected ? 'var(--k2PrimaryTint)' : 'var(--k2Sunken)', color: 'var(--k2Ink)',
                  cursor: 'pointer', textAlign: 'left', flex: 'none',
                }}
              >
                <span aria-hidden="true" style={{ fontSize: 40, lineHeight: 1 }}>{L.flag}</span>
                <span style={{ flex: 1, fontSize: 28, fontWeight: 700 }}>{L.nativeName}</span>
                <span style={{ fontSize: 21, color: 'var(--k2InkSubtle)' }}>{L.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
