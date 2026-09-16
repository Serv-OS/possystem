/**
 * KioskLineRow: one basket line, shared by the basket sheet (README 4, size "sheet") and
 * the review and pay order card (README 5.1, size "card").
 *
 * Minus at 1 removes the line (KioskApp's updateCartQty drops a line at 0). Plus is
 * disabled when the line's stock has no room left across the whole basket.
 * line.mods already holds the size, the choices and an English "Note: ..." (it goes to the
 * kitchen too); the note is shown in the customer's language (kioskLineDetailParts).
 */
import { t, tf } from '../../lib/i18n';
import { money } from '../../lib/currency';
import { kioskLineDetailParts } from '../../lib/kioskFlow';
import { KioskPhoto } from './KioskChrome';
import { MinusIcon, PlusIcon } from './KioskIcons';

// button: the visible circle. The tap area around it is button + 12 (68px sheet, 64px card),
// so every step button meets the 64px touch minimum without changing the README look.
const SIZES = {
  sheet: { name: 26, detail: 19, button: 56, count: 26, countBox: 44, price: 26, priceBox: 130, icon: 26, rowPad: '16px 0' },
  card: { name: 24, detail: 18, button: 52, count: 24, countBox: 40, price: 24, priceBox: 120, icon: 24, rowPad: '14px 0' },
};

export default function KioskLineRow({ line, size = 'sheet', primary, canAdd = true, onLess, onMore, first = false }) {
  const s = SIZES[size] || SIZES.sheet;
  const { choices, note } = kioskLineDetailParts(line);
  const detail = [choices, note ? tf('k2.line.note', { note }) : ''].filter(Boolean).join(' · ');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18, padding: s.rowPad, borderTop: first ? 0 : '1px solid var(--k2Divider)' }}>
      <KioskPhoto image={line.item?.image} color={primary} width={72} height={72} radius={16} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: s.name, fontWeight: 700, color: 'var(--k2Ink)', lineHeight: 1.2, overflowWrap: 'anywhere' }}>{line.name}</div>
        {detail ? (
          <div style={{ fontSize: s.detail, color: 'var(--k2InkSubtle)', lineHeight: 1.3, overflowWrap: 'anywhere' }}>{detail}</div>
        ) : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 0, background: 'var(--k2Muted)', borderRadius: 999, padding: 0, flex: 'none' }}>
        <button type="button" aria-label={`${t('k2.common.less')}: ${line.name}`} onClick={onLess} style={stepTap(s.button)}>
          <span style={stepCircle(s.button, false, false)}><MinusIcon size={s.icon} /></span>
        </button>
        <div style={{ width: s.countBox, textAlign: 'center', fontSize: s.count, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{line.qty}</div>
        <button type="button" aria-label={`${t('k2.common.more')}: ${line.name}`} onClick={onMore} disabled={!canAdd} style={stepTap(s.button, !canAdd)}>
          <span style={stepCircle(s.button, true, !canAdd)}><PlusIcon size={s.icon} /></span>
        </button>
      </div>
      <div style={{ width: s.priceBox, flex: 'none', textAlign: 'right', fontSize: s.price, fontWeight: 800, color: 'var(--k2Ink)', fontVariantNumeric: 'tabular-nums' }}>
        {money(line.lineTotal)}
      </div>
    </div>
  );
}

// The transparent tap area (circle + 12px).
function stepTap(size, disabled = false) {
  return {
    width: size + 12, height: size + 12, background: 'transparent', border: 0, padding: 0, display: 'grid', placeItems: 'center',
    flex: 'none', cursor: disabled ? 'default' : 'pointer',
  };
}

// The visible circle inside it.
function stepCircle(size, primary, disabled) {
  return {
    width: size, height: size, borderRadius: 999, display: 'grid', placeItems: 'center',
    background: primary ? 'var(--k2Primary)' : '#FFFFFF', color: primary ? 'var(--k2OnPrimary)' : 'var(--k2Ink)',
    opacity: disabled ? 0.35 : 1,
  };
}
