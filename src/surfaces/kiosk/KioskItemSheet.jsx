/**
 * KioskItemSheet: README 3 item sheet for the new kiosk design (decision 10, and "the item
 * sheet keeps notes, allergens, nested choices, quantity groups and stock limits").
 *
 * View only. KioskProductModal (look="sheet") owns every rule: loading the groups, the
 * size group, min and max, stock and 86 gates, prices, validation and the add path. It
 * hands this component its state and handlers, so the sheet can never price or validate
 * differently from the item screen today's kiosk uses.
 *
 * The one rule drawn here: when the venue makes the customer acknowledge allergens
 * (ackRequired) and the item, its size or a picked option has one they asked to avoid, Add
 * stays disabled until the box is ticked (a new pick with another allergen clears the tick),
 * and only then calls the modal's tryAdd. Just before tryAdd it hands the picked options'
 * own allergens to onPickAllergens, so Review and pay can count them on the basket line.
 *
 * Sizes are design px (the canvas scales them). No vw, vh or clamp.
 */
import { useMemo, useState } from 'react';
import { t, tf } from '../../lib/i18n';
import { money } from '../../lib/currency';
import { itemName, itemDescription, groupName, optionName, useMenuText } from '../../lib/menuText';
import { itemAllergenIds, kioskAllergenLabels, allergenIdsOfLists, sheetUnsafeIds } from '../../lib/kioskAllergens';
import { KioskCloseButton, KioskPhoto } from './KioskChrome';
import { MinusIcon, PlusIcon, TickIcon, WarningIcon } from './KioskIcons';

export default function KioskItemSheet(props) {
  const {
    item, loading, error, groups, qty, setQty, lineMaxQty, instructions, setInstructions,
    validation, isValid, variantGroup, pickedVariantOpt, totalPrice, basePrice, brandColor,
    stockErr, tryAdd, onCancel, showError, allItems = [], avoidAllergens = null, ackRequired = false, onPickAllergens,
    selections, nestedSelections, subGroupsCache, resolveOpt,
  } = props;

  // The picked options' own allergens (options, nested picks), as the modal resolves them.
  const optionIds = useMemo(() => {
    const lists = [];
    for (const g of (groups || [])) {
      if (g.__isVariantGroup) continue;
      const picked = selections?.[g.id] || [];
      const seen = {};
      for (const optId of picked) {
        const opt = (g.options || []).find(o => o.id === optId);
        if (!opt) continue;
        lists.push(resolveOpt(opt).allergens);
        const occ = seen[optId] || 0;
        seen[optId] = occ + 1;
        const sub = opt.subGroupId ? subGroupsCache?.[opt.subGroupId] : null;
        if (!sub) continue;
        const subSel = nestedSelections?.[g.id + ':' + optId + ':' + occ]?.[sub.id] || [];
        for (const subId of subSel) {
          const subOpt = (sub.options || []).find(o => o.id === subId);
          if (subOpt) lists.push(resolveOpt(subOpt).allergens);
        }
      }
    }
    return allergenIdsOfLists(lists);
  }, [groups, selections, nestedSelections, subGroupsCache, resolveOpt]);

  const byId = useMemo(() => new Map((allItems || []).filter(Boolean).map(i => [i.id, i])), [allItems]);
  const unsafeIds = sheetUnsafeIds({
    item,
    pickedSize: pickedVariantOpt ? byId.get(pickedVariantOpt.id) || null : null,
    sizes: variantGroup ? (variantGroup.options || []).map(o => byId.get(o.id)).filter(Boolean) : [],
    optionIds,
    filter: avoidAllergens,
  });
  const unsafeNames = kioskAllergenLabels(unsafeIds, t);
  const unsafeList = unsafeNames.join(', ');
  const requireAck = ackRequired === true && unsafeNames.length > 0;
  // The tick belongs to the list it was given for; a pick that adds an allergen asks again.
  const [ackFor, setAckFor] = useState(null);
  const ack = requireAck && ackFor === unsafeList;
  const setAck = (fn) => setAckFor(fn(ack) ? unsafeList : null);
  const ackBlocked = requireAck && !ack;

  const add = () => {
    if (typeof onPickAllergens === 'function') onPickAllergens(optionIds);
    tryAdd();
  };

  const allergenLabels = kioskAllergenLabels(itemAllergenIds(item), t);

  let priceLine;
  if (variantGroup) {
    priceLine = pickedVariantOpt
      ? money(Number(pickedVariantOpt.__absolutePrice ?? 0))
      : `${t('menu.from')} ${money(Number(variantGroup.__cheapestPrice ?? 0))}`;
  } else {
    priceLine = money(Number(basePrice ?? 0));
  }

  const soldOut = !loading && lineMaxQty === 0;
  let cta;
  if (loading) cta = { label: t('product.loading'), disabled: true, muted: true };
  else if (soldOut) cta = { label: t('k2.sheet.soldOut'), disabled: true, muted: true };
  // Still tappable (tryAdd scrolls to the missing choice), so it stays primary. The reason
  // shows above the footer instead of a grey button that reads as not available.
  else if (!isValid) cta = { label: tf('k2.sheet.add', { price: money(totalPrice) }), disabled: false, muted: false };
  else if (ackBlocked) cta = { label: tf('k2.sheet.add', { price: money(totalPrice) }), disabled: true, muted: true };
  else cta = { label: tf('k2.sheet.add', { price: money(totalPrice) }), disabled: false, muted: false };

  const canLess = qty > 1;
  const canMore = !loading && qty < lineMaxQty;

  return (
    <div style={{ position: 'absolute', inset: 0, background: 'var(--k2Scrim)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', zIndex: 30 }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={itemName(item)}
        style={{
          background: '#FFFFFF', borderRadius: '40px 40px 0 0', padding: '40px 40px 44px', display: 'flex',
          flexDirection: 'column', gap: 26, maxHeight: 'calc(100% - 140px)', animation: 'kfade .22s ease', minHeight: 0,
        }}
      >
        {/* Head */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 24, flex: 'none' }}>
          <KioskPhoto image={item?.image} color={brandColor} width={150} height={150} radius={24} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 42, fontWeight: 800, color: 'var(--k2Ink)', lineHeight: 1.1, overflowWrap: 'anywhere' }}>{itemName(item)}</div>
            {itemDescription(item) ? (
              <div style={{ fontSize: 21, color: 'var(--k2InkSubtle)', marginTop: 6, lineHeight: 1.35 }}>{itemDescription(item)}</div>
            ) : null}
            <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--k2AccentInk, var(--k2PrimaryInk))', marginTop: 10, fontVariantNumeric: 'tabular-nums' }}>{priceLine}</div>
            {allergenLabels.length > 0 ? (
              <div style={{ fontSize: 21, color: 'var(--k2InkBody)', marginTop: 8, lineHeight: 1.35 }}>
                {tf('k2.sheet.allergens', { list: allergenLabels.join(', ') })}
              </div>
            ) : null}
          </div>
          <KioskCloseButton onClick={onCancel} />
        </div>

        {/* Scrolling body. The 6px padding, taken back by a -6px margin so nothing moves, is
            room for the keyboard focus ring (globals.css): a scroller clips an outline drawn
            outside a tile at its edge. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 30, padding: 6, margin: -6 }}>
          {unsafeNames.length > 0 && !requireAck ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, background: 'var(--k2DangerFill)', borderRadius: 18, padding: 20, fontSize: 21, color: 'var(--k2Danger)', fontWeight: 600 }}>
              <WarningIcon size={30} />
              <span>{tf('k2.sheet.unsafeWarn', { list: unsafeList })}</span>
            </div>
          ) : null}
          {unsafeNames.length > 0 && requireAck ? (
            <button
              type="button"
              role="checkbox"
              aria-checked={ack}
              onClick={() => setAck(a => !a)}
              style={{
                display: 'flex', alignItems: 'center', gap: 18, background: 'var(--k2DangerFill)', borderRadius: 18, padding: 20,
                border: 0, textAlign: 'left', cursor: 'pointer', fontSize: 21, color: 'var(--k2Danger)', fontWeight: 700, width: '100%',
              }}
            >
              <span style={{
                width: 48, height: 48, borderRadius: 14, flex: 'none', display: 'grid', placeItems: 'center',
                background: ack ? 'var(--k2Primary)' : '#FFFFFF', border: ack ? '0' : '2px solid var(--k2Danger)', color: 'var(--k2OnPrimary)',
              }}>{ack ? <TickIcon size={30} /> : null}</span>
              <span>{tf('k2.sheet.unsafeAck', { list: unsafeList })}</span>
            </button>
          ) : null}

          {error ? (
            <div style={{ fontSize: 21, color: 'var(--k2Danger)', fontWeight: 600 }}>{t('k2.sheet.loadFailed')}</div>
          ) : null}

          {loading ? <LoadingRows /> : groups.map(g => <GroupBlock key={g.id} g={g} {...props} />)}

          {!loading ? (
            <div>
              <label htmlFor="k2-item-note" style={{ display: 'block', fontSize: 22, fontWeight: 700, color: 'var(--k2InkMuted)', marginBottom: 12 }}>
                {t('product.anythingElse')}
              </label>
              <textarea
                id="k2-item-note"
                value={instructions}
                onChange={e => setInstructions(e.target.value)}
                placeholder={t('product.anythingElse.placeholder')}
                maxLength={140}
                rows={2}
                style={{
                  width: '100%', background: 'var(--k2Sunken)', border: '2px solid var(--k2Hairline)', borderRadius: 18,
                  padding: 22, fontSize: 22, color: 'var(--k2Ink)', resize: 'none', outline: 'none', display: 'block',
                }}
              />
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {stockErr ? <div style={{ fontSize: 19, color: 'var(--k2Danger)', fontWeight: 700 }}>{stockErr}</div> : null}
          {!loading && !soldOut && !isValid && validation ? (
            <div style={{ fontSize: 21, fontWeight: 700, color: showError ? 'var(--k2Danger)' : 'var(--k2InkMuted)' }}>{validation}</div>
          ) : null}
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--k2Muted)', borderRadius: 999, padding: 8, flex: 'none' }}>
              <button
                type="button"
                aria-label={t('k2.common.less')}
                disabled={!canLess}
                onClick={() => setQty(q => Math.max(1, q - 1))}
                style={roundButton(72, false, !canLess)}
              ><MinusIcon size={30} /></button>
              <div style={{ width: 56, textAlign: 'center', fontSize: 32, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{qty}</div>
              <button
                type="button"
                aria-label={t('k2.common.more')}
                disabled={!canMore}
                onClick={() => setQty(q => Math.min(q + 1, lineMaxQty))}
                style={roundButton(72, true, !canMore)}
              ><PlusIcon size={30} /></button>
            </div>
            <button
              type="button"
              disabled={cta.disabled}
              onClick={add}
              style={{
                flex: 1, minWidth: 0, border: 0, borderRadius: 26, height: 112, padding: '0 24px',
                background: cta.disabled ? 'var(--k2Disabled)' : 'var(--k2Primary)',
                color: cta.disabled ? 'var(--k2InkOnDark)' : 'var(--k2OnPrimary)',
                fontSize: 32, fontWeight: 800, lineHeight: 1.15, cursor: cta.disabled ? 'default' : 'pointer',
              }}
            >{cta.label}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LoadingRows() {
  return (
    <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
      {[0, 1, 2].map(i => (
        <div key={i}>
          <div style={{ width: 200, height: 22, borderRadius: 8, background: 'var(--k2Neutral)', marginBottom: 14 }} />
          <div style={{ display: 'flex', gap: 12 }}>
            {[0, 1, 2].map(j => (
              <div key={j} style={{ width: 200, height: 76, borderRadius: 999, background: 'var(--k2Sunken)', border: '2px solid var(--k2Hairline)' }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function priceText(opt, isSize) {
  if (isSize) return money(Number(opt.__absolutePrice ?? 0));
  const p = Number(opt.price);
  if (p > 0) return `+${money(p)}`;
  if (p < 0) return `−${money(Math.abs(p))}`;
  return '';
}

// Everything the sheet shows about one option's stock and selection.
function optionState(g, opt, props) {
  const { selections, resolveOptItemId, getOptionStock, eightySixIds = [], dailyCounts = {} } = props;
  const picked = selections[g.id] || [];
  const count = picked.filter(id => id === opt.id).length;
  const isSelected = count > 0;
  const optItemId = resolveOptItemId(opt);
  const left = getOptionStock(optItemId);
  const is86 = !!optItemId && (eightySixIds.includes(optItemId) || (dailyCounts[optItemId] && dailyCounts[optItemId].remaining <= 0));
  const soldOut = is86 || left <= 0;
  const atCap = picked.length >= g._max && !g._isSingle;
  const blocked = soldOut || (atCap && !isSelected);
  const low = !soldOut && !!optItemId && left < Infinity && left <= 3 ? left : null;
  return { picked, count, isSelected, soldOut, atCap, blocked, low };
}

function GroupBlock({ g, ...props }) {
  useMenuText();   // venue text in the customer's language
  const { showError, buildHint, resolveOpt, subGroupsCache, nestedSelections, setNestedPick } = props;
  const picked = props.selections[g.id] || [];
  const invalid = showError && (picked.length < g._min || picked.length > g._max);
  const isSize = !!g.__isVariantGroup;
  const hasImages = !isSize && (g.options || []).some(o => resolveOpt(o).image);

  let body;
  if (isSize) {
    const cols = Math.min(3, Math.max(1, (g.options || []).length));
    body = (
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 12 }}>
        {(g.options || []).map(opt => {
          const st = optionState(g, opt, props);
          return (
            <button
              key={opt.id}
              type="button"
              aria-pressed={st.isSelected}
              disabled={st.blocked}
              onClick={() => props.incOption(g, opt.id)}
              style={{
                ...pillBase(st.isSelected, st.blocked), height: 104, justifyContent: 'center', flexDirection: 'column', gap: 2, padding: '0 16px',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, fontSize: 28, fontWeight: 700, lineHeight: 1.1 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{optionName(g, opt)}</span>
                <span style={{ fontSize: 20, fontWeight: 600, color: 'var(--k2InkSubtle)', flex: 'none' }}>{priceText(opt, true)}</span>
              </span>
              <StockNote st={st} />
            </button>
          );
        })}
      </div>
    );
  } else if (hasImages) {
    body = (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
        {(g.options || []).map(opt => <OptionCard key={opt.id} g={g} opt={opt} {...props} />)}
      </div>
    );
  } else {
    body = (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {(g.options || []).map(opt => <OptionPill key={opt.id} g={g} opt={opt} {...props} />)}
      </div>
    );
  }

  // Nested choices: one panel per picked occurrence of an option that has a sub group.
  const nested = [];
  if (!isSize) {
    for (const opt of (g.options || [])) {
      const sub = opt.subGroupId ? subGroupsCache[opt.subGroupId] : null;
      if (!sub) continue;
      const count = picked.filter(id => id === opt.id).length;
      for (let occ = 0; occ < count; occ++) {
        const parentKey = g.id + ':' + opt.id + ':' + occ;
        const subSel = (nestedSelections[parentKey] && nestedSelections[parentKey][sub.id]) || [];
        const subInvalid = showError && (subSel.length < sub._min || subSel.length > sub._max);
        nested.push(
          <div key={parentKey} style={{ background: 'var(--k2PrimaryTint)', borderLeft: '3px solid var(--k2PrimaryLine)', borderRadius: 20, padding: 20 }}>
            <div style={{ fontSize: 21, fontWeight: 700, color: 'var(--k2Ink)' }}>
              {optionName(g, opt)}{count > 1 ? ` #${occ + 1}` : ''} · {groupName(sub)}
            </div>
            <div style={{ fontSize: 19, color: subInvalid ? 'var(--k2Danger)' : 'var(--k2InkSubtle)', fontWeight: subInvalid ? 700 : 500, margin: '4px 0 14px' }}>
              {buildHint(sub._min, sub._max)}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              {(sub.options || []).map(subOpt => {
                const on = subSel.includes(subOpt.id);
                const eff = resolveOpt(subOpt);
                const price = priceText(subOpt, false);
                return (
                  <button
                    key={subOpt.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setNestedPick(parentKey, sub, subOpt.id)}
                    style={{ ...pillBase(on, false), padding: '18px 26px', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}
                  >
                    <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, fontSize: 22, fontWeight: 600 }}>
                      <span>{subOpt.name}</span>
                      {price ? <span style={{ fontSize: 20, color: 'var(--k2InkSubtle)' }}>{price}</span> : null}
                    </span>
                    <AllergenNote list={eff.allergens} />
                  </button>
                );
              })}
            </div>
          </div>,
        );
      }
    }
  }

  return (
    <div data-mod-group={g.id}>
      <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '4px 14px', marginBottom: 12 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--k2InkMuted)' }}>{isSize ? t('k2.sheet.size') : groupName(g)}</div>
        <div style={{ fontSize: 19, color: invalid ? 'var(--k2Danger)' : 'var(--k2InkSubtle)', fontWeight: invalid ? 700 : 500 }}>
          {buildHint(g._min, g._max)}
        </div>
      </div>
      {body}
      {nested.length ? <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 }}>{nested}</div> : null}
    </div>
  );
}

function OptionPill({ g, opt, ...props }) {
  const st = optionState(g, opt, props);
  const eff = props.resolveOpt(opt);
  const price = priceText(opt, false);
  const text = (
    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, minWidth: 0, textAlign: 'left' }}>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span>{optionName(g, opt)}</span>
        {price ? <span style={{ fontSize: 20, fontWeight: 600, color: 'var(--k2InkSubtle)' }}>{price}</span> : null}
      </span>
      <AllergenNote list={eff.allergens} />
      <StockNote st={st} />
    </span>
  );

  // Several picks allowed and at least one made: the pill becomes a stepper chip.
  if (!g._isSingle && st.count > 0) {
    return (
      <div style={{ ...pillBase(true, false), padding: '4px 6px', gap: 14, cursor: 'default' }}>
        <SmallStep label={`${t('k2.common.less')}: ${optionName(g, opt)}`} onClick={() => props.decOption(g, opt.id)}>
          <MinusIcon size={24} />
        </SmallStep>
        {text}
        <span style={{ fontSize: 24, fontWeight: 800, minWidth: 28, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{st.count}</span>
        <SmallStep label={`${t('k2.common.more')}: ${optionName(g, opt)}`} primary disabled={st.atCap || st.soldOut} onClick={() => props.incOption(g, opt.id)}>
          <PlusIcon size={24} />
        </SmallStep>
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={st.isSelected}
      disabled={st.blocked}
      onClick={() => props.incOption(g, opt.id)}
      style={{ ...pillBase(st.isSelected, st.blocked), padding: '22px 30px' }}
    >{text}</button>
  );
}

function OptionCard({ g, opt, ...props }) {
  const st = optionState(g, opt, props);
  const eff = props.resolveOpt(opt);
  const price = priceText(opt, false);
  const stepper = !g._isSingle && st.count > 0;
  const tap = st.blocked || stepper ? undefined : () => props.incOption(g, opt.id);
  return (
    <div
      role={stepper ? undefined : 'button'}
      aria-pressed={stepper ? undefined : st.isSelected}
      aria-disabled={st.blocked || undefined}
      tabIndex={stepper || st.blocked ? -1 : 0}
      onClick={tap}
      onKeyDown={tap ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tap(); } } : undefined}
      style={{
        border: `2px solid ${st.isSelected ? 'var(--k2PrimaryLine)' : 'var(--k2Hairline)'}`,
        background: st.isSelected ? 'var(--k2PrimaryTint)' : '#FFFFFF', borderRadius: 20, padding: 12,
        display: 'flex', flexDirection: 'column', gap: 10, cursor: tap ? 'pointer' : 'default', opacity: st.blocked ? 0.45 : 1,
      }}
    >
      <div style={{ aspectRatio: '4 / 3', maxWidth: '100%', borderRadius: 16, overflow: 'hidden', background: 'var(--k2Neutral)' }}>
        {eff.image ? <img src={eff.image} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /> : null}
      </div>
      <div style={{ padding: '0 4px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--k2Ink)', lineHeight: 1.2 }}>{optionName(g, opt)}</div>
        {price ? <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--k2InkSubtle)' }}>{price}</div> : null}
        <AllergenNote list={eff.allergens} />
        <StockNote st={st} />
      </div>
      {stepper ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--k2Muted)', borderRadius: 999, padding: 0 }}>
          <SmallStep label={`${t('k2.common.less')}: ${optionName(g, opt)}`} onClick={() => props.decOption(g, opt.id)}>
            <MinusIcon size={24} />
          </SmallStep>
          <span style={{ fontSize: 24, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{st.count}</span>
          <SmallStep label={`${t('k2.common.more')}: ${optionName(g, opt)}`} primary disabled={st.atCap || st.soldOut} onClick={() => props.incOption(g, opt.id)}>
            <PlusIcon size={24} />
          </SmallStep>
        </div>
      ) : null}
    </div>
  );
}

function AllergenNote({ list }) {
  const labels = kioskAllergenLabels(itemAllergenIds({ allergens: list }), t);
  if (!labels.length) return null;
  return <span style={{ fontSize: 18, fontWeight: 600, color: 'var(--k2WarnInk)', lineHeight: 1.3 }}>{labels.join(', ')}</span>;
}

function StockNote({ st }) {
  if (st.soldOut) return <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--k2Danger)' }}>{t('k2.sheet.soldOut')}</span>;
  if (st.low !== null) return <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--k2WarnInk)' }}>{tf('k2.sheet.onlyLeft', { n: st.low })}</span>;
  return null;
}

function pillBase(selected, blocked) {
  return {
    display: 'flex', alignItems: 'center', gap: 10, borderRadius: 999, fontSize: 22, fontWeight: 600,
    border: `2px solid ${selected ? 'var(--k2PrimaryLine)' : 'var(--k2Hairline)'}`,
    background: selected ? 'var(--k2PrimaryTint)' : '#FFFFFF', color: 'var(--k2Ink)',
    cursor: blocked ? 'default' : 'pointer', opacity: blocked ? 0.45 : 1, minWidth: 0,
  };
}

// A 52px step circle inside a 64px transparent tap area (the kiosk touch minimum).
function SmallStep({ label, primary = false, disabled = false, onClick, children }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      style={{ width: 64, height: 64, border: 0, padding: 0, background: 'transparent', display: 'grid', placeItems: 'center', flex: 'none', cursor: disabled ? 'default' : 'pointer' }}
    >
      <span style={{ ...roundButton(52, primary, disabled), cursor: 'inherit' }}>{children}</span>
    </button>
  );
}

function roundButton(size, primary, disabled) {
  return {
    width: size, height: size, borderRadius: 999, border: 0, flex: 'none', display: 'grid', placeItems: 'center',
    background: primary ? 'var(--k2Primary)' : '#FFFFFF', color: primary ? 'var(--k2OnPrimary)' : 'var(--k2Ink)',
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.35 : 1,
  };
}
