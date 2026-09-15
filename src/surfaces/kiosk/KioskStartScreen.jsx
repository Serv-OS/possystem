/**
 * KioskStartScreen: README 1 "mode and table" (decision 14: every table mode fits here).
 *
 * step 'mode' : the Eat in and Take away tiles (Take away only when the mode is 'none')
 * step 'table': the table panel replaces the tiles on the same screen, with
 *               "I don't have a table number" under it when the mode is 'either'.
 * What each tile does is decided by KioskFlowV2 from kioskStartModel (lib/kioskFlow.js).
 */
import { t } from '../../lib/i18n';
import { kioskStartTitleKey } from '../../lib/kioskFlow';
import { KioskLogoPlate, KioskLanguagePill, KioskCancelPill } from './KioskChrome';
import { CutleryIcon, BagIcon, StarIcon } from './KioskIcons';
import KioskTablePanel from './KioskTablePanel';

export default function KioskStartScreen({
  model, step = 'mode', brandName, brandLogoUrl, lang,
  onOpenLanguage, showLanguage = true, showCancel = false, onCancel,
  tables, tableNumber = '',
  onEatIn, onTakeaway, onPickTable, onNoTable, onChangeMode,
  footerKey = null, showBackToOrder = false, onBackToOrder,
}) {
  const showTables = step === 'table' && !model.takeawayOnly;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', padding: '64px 56px 48px', animation: 'kfade .28s ease' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, minHeight: 96 }}>
        <KioskLogoPlate logoUrl={brandLogoUrl} brandName={brandName} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {showLanguage ? <KioskLanguagePill lang={lang} onClick={onOpenLanguage} /> : null}
          {showCancel ? <KioskCancelPill onClick={onCancel} /> : null}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        {/* Centred between the top row and the footer (README 1). With the table panel the block
            may shrink to the free height (minHeight 0 down the chain) so the panel scrolls
            inside itself rather than running past the screen. */}
        <div style={{ margin: 'auto 0', display: 'flex', flexDirection: 'column', gap: 48, padding: '32px 0', minHeight: showTables ? 0 : undefined }}>
          <div style={{ flex: 'none', fontSize: 76, fontWeight: 800, lineHeight: 1.02, letterSpacing: '-0.03em', color: 'var(--k2Ink)', textWrap: 'balance' }}>
            {t(kioskStartTitleKey(model, showTables ? 'table' : 'mode'))}
          </div>

          {!showTables && (
            <div style={{ display: 'grid', gridTemplateColumns: model.takeawayOnly ? '1fr' : '1fr 1fr', gap: 28 }}>
              {!model.takeawayOnly && (
                <ModeTile
                  icon={<CutleryIcon size={92} color="var(--k2PrimaryInk)" />}
                  label={t('k2.start.eatIn')}
                  sub={t(model.eatInSubKey)}
                  onClick={onEatIn}
                />
              )}
              <ModeTile
                icon={<BagIcon size={92} color="var(--k2PrimaryInk)" />}
                label={t('k2.start.takeaway')}
                sub={t('k2.start.takeawaySub')}
                onClick={onTakeaway}
              />
            </div>
          )}

          {showTables && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 24, minHeight: 0, flex: '0 1 auto' }}>
              <KioskTablePanel tables={tables} selected={tableNumber} onPick={onPickTable} onChangeMode={onChangeMode} entry={model.tableEntry || 'plan'} numberKind={model.numberKind || 'table'} />
              {model.allowNoTable ? (
                <button type="button" onClick={onNoTable} style={{ ...secondaryButton(), flex: 'none' }}>{t('k2.start.noTable')}</button>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {showBackToOrder ? (
        <button type="button" onClick={onBackToOrder} style={{ ...secondaryButton(), marginBottom: 28 }}>
          {t('k2.start.backToOrder')}
        </button>
      ) : null}

      {footerKey ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, color: 'var(--k2InkSubtle)', fontSize: 21, textAlign: 'center' }}>
          <StarIcon size={26} />
          <span>{t(footerKey)}</span>
        </div>
      ) : null}
    </div>
  );
}

function ModeTile({ icon, label, sub, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none', border: 0, background: '#FFFFFF', borderRadius: 32, padding: '56px 40px 44px',
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 120, textAlign: 'left',
        cursor: 'pointer', boxShadow: '0 6px 18px rgba(0,0,0,.06)', minWidth: 0,
      }}
    >
      {icon}
      <div>
        <div style={{ fontSize: 44, fontWeight: 800, color: 'var(--k2Ink)', lineHeight: 1.1 }}>{label}</div>
        <div style={{ fontSize: 22, color: 'var(--k2InkSubtle)', marginTop: 6 }}>{sub}</div>
      </div>
    </button>
  );
}

function secondaryButton() {
  return {
    border: '2px solid var(--k2Hairline)', background: '#FFFFFF', borderRadius: 26, height: 104,
    fontSize: 26, fontWeight: 700, color: 'var(--k2InkBody)', cursor: 'pointer', width: '100%', padding: '0 24px',
  };
}
