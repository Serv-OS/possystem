/**
 * KioskMenuScreen: README 2 menu for the new kiosk design.
 *
 *   header : back, the mode block (eat in with the table, or take away), the allergen chip
 *            (decision 11: replaces the old full width button), Cancel
 *   rail   : top level categories only, as design tiles (decision 19; photos or the brand
 *            colour block, decisions 2 and 3)
 *   items  : the tile's own items, then each sub category under its own heading
 *   order bar while the basket has items
 *
 * Every rule is in lib/kioskMenu.js; this file only draws and calls back.
 * Sizes are design px (the canvas scales them). No vw, vh or clamp.
 */
import { useMemo } from 'react';
import { t, tf, tn } from '../../lib/i18n';
import { resolveItemPrice, variantFromPrice, variantChildren } from '../../lib/menuPricing';
import { railTileMode } from '../../lib/categoryPhoto';
import { kioskModeLabels } from '../../lib/kioskFlow';
import {
  kioskRailRoots, kioskActiveRoot, kioskMenuSections, kioskSectionItemCount, kioskAddMode,
  kioskAvailableSizes, kioskLowStock, kioskCardButton,
} from '../../lib/kioskMenu';
import { isUnsafe } from '../../lib/kioskAllergens';
import { KioskBackButton, KioskCancelPill } from './KioskChrome';
import { WarningIcon } from './KioskIcons';
import KioskCategoryTile from './KioskCategoryTile';
import KioskItemCard from './KioskItemCard';
import KioskOrderBar from './KioskOrderBar';

export default function KioskMenuScreen({
  engine, primary, instructionDefs, groupRules,
  onBack, onCancel, onOpenAllergens, onOpenItem, onQuickAdd, onOpenBasket, onReview,
}) {
  const {
    items, visibleCategories, railCategories, activeMenuId, eightySixIds, dailyCounts,
    orderType, tableNumber, selectedCategoryId, setSelectedCategoryId, allergenFilter,
    cartItemCount, subtotal, categoryPhotos, categoryPhotoOrigin,
  } = engine;

  const roots = useMemo(() => kioskRailRoots(visibleCategories, items), [visibleCategories, items]);
  // Only the venue's top level categories decide photo or text tiles, so photos on sub
  // categories never switch the rail to photo tiles with every slot blank.
  const tileMode = useMemo(
    () => railTileMode(categoryPhotos, kioskRailRoots(railCategories), categoryPhotoOrigin),
    [categoryPhotos, railCategories, categoryPhotoOrigin],
  );
  const rootId = kioskActiveRoot(roots, visibleCategories, selectedCategoryId);
  const root = roots.find(r => r.id === rootId) || null;
  const sections = useMemo(
    () => kioskMenuSections({ rootId, visibleCategories, items }),
    [rootId, visibleCategories, items],
  );
  const count = kioskSectionItemCount(sections);

  const labels = kioskModeLabels({ orderType, tableNumber });
  const marked = allergenFilter instanceof Set ? allergenFilter.size : 0;
  const addCtx = { items, eightySixIds, dailyCounts, allergenFilter, instructionDefs, groupRules };

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '26px 28px', background: '#FFFFFF', borderBottom: '1px solid rgba(0,0,0,.07)', flex: 'none' }}>
        <KioskBackButton onClick={onBack} />
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--k2Ink)' }}>{t(labels.titleKey)}</div>
          <div style={{ fontSize: 17, color: 'var(--k2InkSubtle)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tf(labels.subKey, labels.vars)}</div>
        </div>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onOpenAllergens}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, borderRadius: 999, padding: '16px 24px', fontSize: 20, fontWeight: 700,
            border: `2px solid ${marked ? 'var(--k2PrimaryLine)' : 'var(--k2WarnBorder)'}`,
            background: marked ? 'var(--k2PrimaryTint)' : 'var(--k2WarnFill)',
            color: marked ? 'var(--k2PrimaryInk)' : 'var(--k2WarnInk)', cursor: 'pointer', flex: 'none', minHeight: 64,
          }}
        >
          <WarningIcon size={24} />
          <span>{marked ? tn('k2.menu.allergensMarked', marked) : t('k2.menu.allergens')}</span>
        </button>
        <KioskCancelPill onClick={onCancel} />
      </div>

      {roots.length === 0 ? (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 56, textAlign: 'center', fontSize: 30, fontWeight: 700, color: 'var(--k2InkMuted)' }}>
          {t('k2.menu.noCategories')}
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ width: 286, flex: 'none', overflowY: 'auto', padding: '22px 18px 220px', display: 'flex', flexDirection: 'column', gap: 14, borderRight: '1px solid rgba(0,0,0,.07)' }}>
            {roots.map(c => (
              <KioskCategoryTile
                key={c.id}
                look="design"
                cat={c}
                active={c.id === rootId}
                mode={tileMode}
                brandColor={primary}
                photoOrigin={categoryPhotoOrigin}
                onSelect={() => setSelectedCategoryId(c.id)}
              />
            ))}
          </div>

          {/* keyed on the tile, so a new category starts scrolled to the top */}
          <div key={rootId || 'none'} style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '26px 28px 220px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 22, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 40, fontWeight: 800, color: 'var(--k2Ink)', lineHeight: 1.1 }}>{root?.label || ''}</div>
              <div style={{ fontSize: 19, color: 'var(--k2InkSubtle)' }}>{tn('k2.items', count)}</div>
            </div>
            {sections.length === 0 ? (
              <div style={{ padding: '60px 0', textAlign: 'center', fontSize: 24, color: 'var(--k2InkSubtle)' }}>{t('k2.menu.empty')}</div>
            ) : sections.map((sec, si) => (
              <div key={sec.category.id}>
                {sec.heading ? (
                  <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--k2Ink)', margin: si === 0 ? '0 0 16px' : '34px 0 16px' }}>{sec.heading}</div>
                ) : null}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 22 }}>
                  {sec.items.map(it => {
                    const addMode = kioskAddMode(it, addCtx);
                    const button = kioskCardButton(addMode, addMode.reason === 'unsafe' ? kioskAddMode(it, { ...addCtx, allergenFilter: null }) : null);
                    const sizes = addMode.reason === 'sizes' ? kioskAvailableSizes(it, items, eightySixIds, dailyCounts) : null;
                    return (
                      <KioskItemCard
                        key={it.id}
                        item={it}
                        addMode={addMode}
                        button={button}
                        price={resolveItemPrice(it, orderType, activeMenuId)}
                        fromPrice={sizes ? variantFromPrice(it, sizes, orderType, activeMenuId) : null}
                        unsafe={isUnsafe(it, allergenFilter, variantChildren(it, items))}
                        lowStock={kioskLowStock(it, dailyCounts)}
                        primary={primary}
                        onOpen={() => onOpenItem(it)}
                        onQuickAdd={() => onQuickAdd(it)}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {cartItemCount > 0 ? (
        <KioskOrderBar cartItemCount={cartItemCount} subtotal={subtotal} onOpenBasket={onOpenBasket} onReview={onReview} />
      ) : null}
    </div>
  );
}
