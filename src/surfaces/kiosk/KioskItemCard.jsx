/**
 * KioskItemCard: README 2 item card for the new kiosk design.
 *
 *   top area (photo, name, description, hint): opens the item sheet, unless sold out
 *   the button: one tap add, or open the sheet, as kioskAddMode decides (lib/kioskMenu.js)
 *
 * Badges on the photo: Sold out (top left), Unsafe (top right, decision 11: the item is
 * marked and dimmed, never hidden, and stays tappable), and Only N left.
 * Sizes are design px (the canvas scales them). No vw, vh or clamp.
 */
import { t, tf } from '../../lib/i18n';
import { money } from '../../lib/currency';
import { displayName } from '../../lib/itemDisplay';
import { kioskCardLabelSize } from '../../lib/kioskFlow';
import { KioskPhoto } from './KioskChrome';
import { PlusIcon } from './KioskIcons';

/**
 * addMode   : kioskAddMode result (what a tap on the button does)
 * button    : kioskCardButton result (what the button says)
 * price     : the item's own price for the order type and menu
 * fromPrice : the cheapest size still on sale (sized items), else null
 * unsafe    : the item has an allergen the customer asked to avoid
 * lowStock  : number left for the low stock badge, or null
 */
export default function KioskItemCard({ item, addMode, button, price, fromPrice = null, unsafe = false, lowStock = null, primary, onOpen, onQuickAdd }) {
  const soldOut = addMode.mode === 'soldout';
  const quick = addMode.mode === 'quick';

  let label;
  if (button === 'soldOut') label = t('k2.menu.soldOut');
  else if (button === 'chooseSize') label = fromPrice > 0 ? tf('k2.menu.chooseSize', { price: money(fromPrice) }) : t('k2.menu.chooseSizeOnly');
  else if (button === 'add') label = tf('k2.menu.add', { price: money(price) });
  else label = tf('k2.menu.choose', { price: money(price) });
  const showPlus = button === 'add';

  // Dim the photo, the text and the button, never the card itself: the badges stay at full
  // opacity so Unsafe (white on the danger red) always reads.
  const opacity = soldOut ? 0.5 : (unsafe ? 0.45 : 1);
  const onTop = soldOut ? undefined : onOpen;
  const onButton = soldOut ? undefined : (quick ? onQuickAdd : onOpen);

  return (
    <div style={{ background: '#FFFFFF', borderRadius: 26, padding: '18px 18px 20px', display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <button
        type="button"
        onClick={onTop}
        disabled={soldOut}
        aria-label={displayName(item)}
        style={{ border: 0, background: 'transparent', padding: 0, textAlign: 'left', cursor: soldOut ? 'default' : 'pointer', display: 'flex', flexDirection: 'column', gap: 12, color: 'inherit', flex: 1 }}
      >
        <KioskPhoto image={item.image} color={primary} width="100%" height={210} radius={20} dim={opacity}>
          {soldOut ? <Badge side="left" bg="var(--k2Ink)" fg="#FFFFFF">{t('k2.menu.soldOut')}</Badge> : null}
          {!soldOut && unsafe ? <Badge side="right" bg="var(--k2Danger)" fg="#FFFFFF">{t('k2.menu.unsafe')}</Badge> : null}
          {!soldOut && !unsafe && lowStock !== null ? (
            <Badge side="right" bg="var(--k2WarnFill)" fg="var(--k2WarnInk)" border="2px solid var(--k2WarnBorder)">{tf('k2.menu.onlyLeft', { n: lowStock })}</Badge>
          ) : null}
        </KioskPhoto>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%', opacity }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--k2Ink)', lineHeight: 1.15, overflowWrap: 'anywhere' }}>{displayName(item)}</div>
          <div style={{
            fontSize: 18, color: 'var(--k2InkSubtle)', lineHeight: 1.35, minHeight: 48,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>{item.description || ''}</div>
          {quick && addMode.hasExtras ? (
            <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--k2AccentInk, var(--k2PrimaryInk))', marginTop: 2 }}>{t('k2.menu.tapForExtras')}</div>
          ) : null}
        </div>
      </button>
      <button
        type="button"
        onClick={onButton}
        disabled={soldOut}
        style={{
          border: 0, borderRadius: 999, height: 84, fontSize: 26, fontWeight: 700, padding: '0 20px',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, cursor: soldOut ? 'default' : 'pointer',
          background: soldOut ? 'var(--k2Disabled)' : 'var(--k2Primary)',
          color: soldOut ? 'var(--k2InkOnDark)' : 'var(--k2OnPrimary)', flex: 'none', lineHeight: 1.1, textAlign: 'center', opacity,
        }}
      >
        {showPlus ? <PlusIcon size={26} /> : null}
        {/* One line at 26px/700 in the 358px card ("Options · £12.00", "Sizes from £3.20"). A longer
            translation is set smaller (kioskCardLabelSize); only an extreme one wraps to a second line. */}
        <span style={{ overflow: 'hidden', maxHeight: 60, fontSize: kioskCardLabelSize(label, { withIcon: showPlus }) }}>{label}</span>
      </button>
    </div>
  );
}

function Badge({ side, bg, fg, border, children }) {
  return (
    <span style={{
      position: 'absolute', top: 14, [side]: 14, background: bg, color: fg, border: border || 0,
      borderRadius: 999, padding: '8px 16px', fontSize: 17, fontWeight: 800, lineHeight: 1.2,
    }}>{children}</span>
  );
}
