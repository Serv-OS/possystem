/**
 * KioskLoyaltyRows: the phone based rows on Review and pay.
 *
 *   Points row (README 5.4): add a mobile number to collect points. No code (decision 5).
 *   Reward row: use a reward. Spending needs the text code (decision 7).
 *   Text row (README 5.5): "Text me when it's ready", for orders the customer collects (take
 *   away, or eat in with no table), its own setting (decision 9).
 *
 * PRIVACY (README, non negotiable): the number only ever shows masked, and nothing about
 * the customer's account (name, email, balance, history) is shown.
 */
import { t, tf } from '../../lib/i18n';
import { money } from '../../lib/currency';
import { KioskCheckBox } from './KioskChrome';
import { ChevronRightIcon, StarIcon, TickIcon } from './KioskIcons';

// flex none: these rows sit in the Review and pay scroll column, where a flex item with a
// set minHeight would otherwise shrink to it and cut off the sub line.
const rowStyle = (active) => ({
  width: '100%', flex: 'none', display: 'flex', alignItems: 'center', gap: 18, padding: '24px 28px', borderRadius: 26,
  background: active ? 'var(--k2PrimaryTint)' : '#FFFFFF', border: active ? '2px solid var(--k2PrimaryLine)' : '2px solid transparent',
  textAlign: 'left', cursor: 'pointer', color: 'var(--k2Ink)', minHeight: 64,
});

// strong: the rewards rows' title (800 26px in the prototype); the text row keeps 700 25px.
function RowText({ title, sub, strong = false }) {
  return (
    <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: strong ? 26 : 25, fontWeight: strong ? 800 : 700, color: 'var(--k2Ink)' }}>{title}</span>
      {sub ? <span style={{ fontSize: 19, color: 'var(--k2InkSubtle)' }}>{sub}</span> : null}
    </span>
  );
}

export function KioskPointsRow({ masked, onOpen }) {
  const added = !!masked;
  return (
    <button type="button" onClick={onOpen} style={rowStyle(added)}>
      <span style={{ display: 'grid', placeItems: 'center', width: 40 }}><StarIcon size={34} /></span>
      <RowText
        strong
        title={t(added ? 'k2.points.addedTitle' : 'k2.points.title')}
        sub={added ? tf('k2.points.addedSub', { masked }) : t('k2.points.sub')}
      />
      <span style={{ color: 'var(--k2InkSubtle)', flex: 'none' }}>
        {added ? <TickIcon size={30} /> : <ChevronRightIcon size={28} />}
      </span>
    </button>
  );
}

export function KioskRewardRow({ redemption, credit, onOpen, onRemove }) {
  if (redemption) {
    return (
      <div style={{ ...rowStyle(true), cursor: 'default' }}>
        <span style={{ display: 'grid', placeItems: 'center', width: 40 }}><StarIcon size={34} /></span>
        <RowText strong title={tf('k2.reward.appliedTitle', { name: redemption.reward_name || '' })} />
        <span style={{ fontSize: 24, fontWeight: 800, color: 'var(--k2PrimaryInk)', fontVariantNumeric: 'tabular-nums', flex: 'none' }}>{`−${money(credit)}`}</span>
        <button
          type="button"
          onClick={onRemove}
          style={{ border: 0, background: '#FFFFFF', borderRadius: 999, padding: '13px 22px', fontSize: 19, fontWeight: 700, color: 'var(--k2Ink)', cursor: 'pointer', minHeight: 64, flex: 'none' }}
        >{t('k2.common.remove')}</button>
      </div>
    );
  }
  return (
    <button type="button" onClick={onOpen} style={rowStyle(false)}>
      <span style={{ display: 'grid', placeItems: 'center', width: 40 }}><StarIcon size={34} /></span>
      <RowText strong title={t('k2.reward.title')} sub={t('k2.reward.sub')} />
      <span style={{ color: 'var(--k2InkSubtle)', flex: 'none' }}><ChevronRightIcon size={28} /></span>
    </button>
  );
}

export function KioskTextRow({ masked, on, onToggle, onAddNumber }) {
  const hasNumber = !!masked;
  const sub = !hasNumber ? t('k2.sms.subNoNumber') : on ? tf('k2.sms.subOn', { masked }) : t('k2.sms.subOff');
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={hasNumber && on}
      onClick={hasNumber ? onToggle : onAddNumber}
      style={rowStyle(false)}
    >
      <KioskCheckBox checked={hasNumber && on} />
      <RowText title={t('k2.sms.title')} sub={sub} />
    </button>
  );
}
