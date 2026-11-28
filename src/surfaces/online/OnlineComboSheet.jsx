// OnlineComboSheet: a Combo built from steps, on the online page and the catering link (5.12.125,
// stage 3). Peter, 27 Nov 2026: YES to customers building a Combo there, "this is just a combo
// product so yes is the answer thats what we are building these features for".
//
// The same steps, rules and words as the POS (lib/combo.js; the POS draws them in
// components/ComboFlow.jsx): every step on one page, the count against each rule, what is still
// missing, then Add. A product with a size to pick or an option that must be answered opens its own
// sheet (OnlineItemSheet, the one every product uses here), with the sizes cut down to the ones that
// can be picked and its prices read as the step prices them ("Included", "+£1.50", or its own
// price). The venue's theme throughout (sheetTheme.js), as every customer sheet.
//
// The page builds the basket lines (lib/online/comboCart.js comboCartLines); the server values them
// with the same rules (SQL 20261217a).

import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { money } from '../../lib/currency';
import { productImage } from '../../lib/productImage';
import { useMenuText, itemName as tItemName, itemDescription as tItemDescription } from '../../lib/menuText';
import { unsafeAllergenIds } from '../../lib/kioskAllergens';
import { groupsShownOn } from '../../lib/soldAs';
import AllergenChips, { allergenPaletteFromTheme, allergenChipLabels } from '../../components/AllergenChips.js';
import {
  comboSteps, stepEntries, stepStatus, stepNeedWords, stepCountWords, stepRule, ruleWords,
  tapEntry, untapEntry, canPick, startingPicks, fixedAnswer, pickPrice, comboTotal,
  comboMissing, pickLineName, picksOfStep, PRICING_OWN, stepPickNeeds, stepOpensOptions, stepAsIs,
} from '../../lib/combo';
import { pickFlowSetup } from '../../lib/comboLines';
import { customerComboContext, stepGroupIds, comboOwnStock, guestWords } from '../../lib/online/comboCart';
import OnlineItemSheet from './OnlineItemSheet';

let pickSeq = 0;
const pickKey = () => `ck-${Date.now().toString(36)}-${++pickSeq}`;

function contrastFg(hex) {
  const c = String(hex || '').replace('#', '');
  const n = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
  if (n.length !== 6) return '#fff';
  const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 128 ? '#0b0c10' : '#ffffff';
}

export default function OnlineComboSheet({
  item, theme, rows = [], priceFor = (r) => Number(r?.pricing?.base ?? 0), eightySixIds = [], stockLevels = {},
  basket = [], orderType = null, fulfilment = null, instGroupDefs = [], defaultImage = null, avoidAllergens = [],
  showCalories = false, initialPicks = null, addLabel = 'Add to basket', noPrice = null, onClose, onAdd,
  // 5.12.128: the kiosk (size "kiosk": a wider sheet and big touch targets; screen "kiosk": its Shows on).
  size = null, screen = 'online',
}) {
  useMenuText();
  const steps = useMemo(() => comboSteps(item), [item]);
  // The option groups of the step products: whether a product has an option that MUST be answered
  // (then its sheet opens as it is picked). Until they load, any product with a group is asked.
  const [groupDefs, setGroupDefs] = useState(null);
  const groupIds = useMemo(() => stepGroupIds(item, rows), [item, rows]);
  useEffect(() => {
    let alive = true;
    if (!groupIds.length) { setGroupDefs([]); return undefined; }
    if (!supabase) return undefined;
    supabase.from('modifier_groups').select('id, name, min, max, selection_type, options, sort_order').in('id', groupIds)
      .then(({ data, error }) => { if (alive && !error && Array.isArray(data)) setGroupDefs(groupsShownOn(data, rows, 'online', fulfilment)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [groupIds.join(','), fulfilment]);   // eslint-disable-line react-hooks/exhaustive-deps

  const ctx = useMemo(() => customerComboContext({
    item, rows, eightySixIds, stockLevels, basket, orderType, fulfilment,
    modifierGroupDefs: groupDefs, instructionGroupDefs: instGroupDefs, noPrice, screen,
  }), [item, rows, eightySixIds, stockLevels, basket, orderType, fulfilment, groupDefs, instGroupDefs, noPrice, screen]);

  const newPick = (stepId, entryId) => ({
    key: pickKey(), stepId, entryId,
    itemId: ctx.sizesOf(entryId).length ? null : entryId,   // a product with sizes waits for its size
    mods: [], notes: '', answers: null, configured: false,
  });
  const [picks, setPicks] = useState(() => initialPicks || startingPicks(steps, ctx, newPick));
  const [configuring, setConfiguring] = useState(null);   // { key, fresh, before } while a pick's own sheet is open
  const [say, setSay] = useState(null);
  const [tried, setTried] = useState(false);               // the guest tapped Add once: show what is missing in red
  const stepRefs = useRef([]);

  const setPrice = priceFor(item);
  const rowOfPick = (p) => ctx.rowsById.get(p.itemId ?? p.entryId) || ctx.rowsById.get(p.entryId) || null;
  const stepById = (id) => steps.find((s) => s.id === id) || null;
  const totals = comboTotal({ setPrice, steps, picks, rowsById: ctx.rowsById, priceOf: priceFor });
  // The Combo's own 86 and daily count first (the POS checks it too), then the steps; a guest never
  // reads the POS's staff words (review of 27 Nov 2026).
  const missing = guestWords(comboOwnStock(item, ctx) || comboMissing(steps, picks, ctx));
  // A step that keeps prices never offers a product with no price set (it would sell for 0.00).
  const unpriced = (step, e) => step.pricing === PRICING_OWN && typeof noPrice === 'function' && !e.sizes.length && !!noPrice(e.row);

  const muted = theme.isLight ? '#6b6b70' : '#a0a0a8';
  const cardBdr = theme.isLight ? '#ececef' : '#2a2a30';
  const inputBg = theme.isLight ? '#f5f5f7' : '#1f1f24';
  const palette = allergenPaletteFromTheme(theme);

  // ── A pick's own sheet: its size and its options, priced as its step prices them ──
  const cfgPick = configuring ? picks.find((p) => p.key === configuring.key) || null : null;
  if (cfgPick) {
    const step = stepById(cfgPick.stepId);
    const setup = step ? pickFlowSetup({
      entryId: cfgPick.entryId, itemId: cfgPick.itemId, step, ctx,
      picks: picks.filter((p) => p.key !== cfgPick.key), menuItems: rows, priceOf: priceFor, money,
    }) : null;
    const close = () => {
      // 5.12.127: backing out of a product just tapped never leaves it picked (it was never confirmed).
      if (configuring.fresh) setPicks(configuring.before || picks.filter((p) => p.key !== cfgPick.key));
      setConfiguring(null);
    };
    if (setup) {
      // What the stock caps in that sheet count: the basket, and the other picks of this Combo.
      const held = [...basket, ...picks.filter((p) => p.key !== cfgPick.key && (p.itemId || p.entryId)).map((p) => ({ itemId: p.itemId ?? p.entryId, qty: 1, mods: p.mods || [] }))];
      return (
        <OnlineItemSheet
          key={`pick-${cfgPick.key}`}
          item={setup.flowItem} theme={theme} allItems={setup.flowMenu} instGroupDefs={instGroupDefs}
          eightySixIds={eightySixIds} stockLevels={stockLevels} cart={held}
          priceFor={setup.baseOf} lockQty strictRequired extraPrices={step.pricing !== PRICING_OWN}
          addLabel="Continue" contextTitle={tItemName(item) || item.menu_name || item.name} defaultImage={defaultImage}
          avoidAllergens={avoidAllergens} showCalories={showCalories} fulfilment={fulfilment}
          onClose={close}
          onAdd={(finalItem, mods, _qty, notes) => {
            setPicks(picks.map((p) => (p.key === cfgPick.key ? { ...p, itemId: finalItem.id, mods: mods || [], notes: notes || '', configured: true } : p)));
            setConfiguring(null);
          }}
        />
      );
    }
  }

  const flash = (words) => setSay(words);
  const tap = (step, e) => {
    const already = picksOfStep(picks, step.id).some((p) => p.entryId === e.entry.itemId) && !stepRule(step).repeat;
    if (unpriced(step, e) && !already) { flash(`${pickLineName(e.row, ctx.rowsById)} is not available right now.`); return; }
    if (e.state !== 'ok' && !already) {
      flash(e.state === 'type' ? (e.words || 'Not available for this order.') : `${pickLineName(e.row, ctx.rowsById)}: ${e.words || 'cannot be picked'}`);
      return;
    }
    let made = null;
    const next = tapEntry(step, picks, e.entry.itemId, (entryId) => (made = newPick(step.id, entryId)));
    if (next === picks) {
      const st = stepStatus(step, picks);
      flash(st.full ? `${step.name}: ${st.max} picked already. Take one off to change it.` : 'Each one only once here.');
      return;
    }
    setSay(null);
    setPicks(next);
    // 5.12.127 (Peter, with Toast's catering package): a product with options, in a step customers can
    // change, opens them the moment it is tapped, as a size to pick does in any step.
    if (made && (stepOpensOptions(step, e.row, ctx) || stepPickNeeds(step, made, ctx))) setConfiguring({ key: made.key, fresh: true, before: picks });
  };
  const untap = (step, entryId) => { setSay(null); setPicks(untapEntry(step, picks, entryId)); };
  const removePick = (p) => { setSay(null); setPicks(picks.filter((x) => x.key !== p.key)); };

  const add = () => {
    if (missing) {
      setTried(true);
      flash(missing);
      const short = steps.findIndex((s) => !stepStatus(s, picks).done);
      const need = picks.find((p) => stepPickNeeds(stepById(p.stepId), p, ctx));
      if (short >= 0) stepRefs.current[short]?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      else if (need) setConfiguring({ key: need.key, fresh: false });
      return;
    }
    onAdd(picks);
  };

  const display = tItemName(item) || item.menu_name || item.name;
  const desc = tItemDescription(item);
  const hero = productImage(item, defaultImage);
  const wordsFor = (step, e) => {
    if (step.pricing === PRICING_OWN) return e.sizes.length ? `from ${money(Math.min(...e.sizes.map((s) => priceFor(s))))}` : money(priceFor(e.row));
    return e.entry.bump > 0 ? `+${money(e.entry.bump)}` : 'Included';
  };

  return (
    <div onClick={onClose} data-testid="online-combo" style={{ position: 'fixed', inset: 0, zIndex: 30, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', animation: 'fadeIn .15s ease' }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: '100%', maxWidth: size === 'kiosk' ? 980 : 600, maxHeight: 'min(94vh, calc(100% - 12px))', overflowY: 'auto', zoom: size === 'kiosk' ? 1.35 : undefined,
        background: theme.bg, color: theme.fg, borderRadius: '18px 18px 0 0',
        display: 'flex', flexDirection: 'column', boxShadow: '0 -10px 40px rgba(0,0,0,0.3)',
      }}>
        {/* The handle and Close in one bar at the top (Close never floats over a pick's own buttons). */}
        <div style={{ padding: '8px 12px 4px', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          <div style={{ width: 36 }}/>
          <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}><div style={{ width: 44, height: 5, borderRadius: 3, background: cardBdr }}/></div>
          <button onClick={onClose} aria-label="Close" style={{ width: 36, height: 36, borderRadius: '50%', border: 'none', background: `${theme.fg}14`, color: theme.fg, fontSize: 18, cursor: 'pointer', fontFamily: 'inherit' }}>×</button>
        </div>
        {hero && <img src={hero} alt="" style={{ width: '100%', maxHeight: 220, objectFit: 'cover', flexShrink: 0 }}/>}

        <div style={{ padding: '14px 22px 8px' }}>
          <div style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.2, paddingRight: 36 }}>{display}</div>
          {desc && <div style={{ fontSize: 14, color: muted, marginTop: 6, lineHeight: 1.5 }}>{desc}</div>}
          <div style={{ fontSize: 14, fontWeight: 700, marginTop: 8 }}>{money(totals.setPrice)}</div>
          <AllergenChips ids={item.allergens} size="card" palette={palette} style={{ marginTop: 6 }}/>
          {say && (
            <div data-testid="online-combo-say" role="alert" style={{ marginTop: 10, padding: '10px 12px', borderRadius: 12, background: 'rgba(239,68,68,0.12)', color: '#dc2626', fontSize: 13, fontWeight: 700 }}>{say}</div>
          )}
        </div>

        <div style={{ padding: '0 22px 12px' }}>
          {steps.map((step, i) => {
            const rule = stepRule(step);
            const st = stepStatus(step, picks);
            const mine = picksOfStep(picks, step.id);
            const shown = stepEntries(step, ctx, picks);
            const fixed = !!fixedAnswer(step, ctx);
            const short = tried && !st.done;
            // The picks listed under the step: any whose product has a size or options (so each can be
            // changed on its own), or any that still needs an answer.
            // 5.12.127: only the picks that open again (options in a step customers can change, or a size).
            const listed = mine.filter((p) => { const er = ctx.rowsById.get(p.entryId); return stepPickNeeds(step, p, ctx) || (er && (stepOpensOptions(step, er, ctx) || ctx.sizesOf(er.id).length > 0)); });
            return (
              <div key={step.id} ref={(el) => { stepRefs.current[i] = el; }} data-testid="online-combo-step" style={{ paddingTop: 18 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 16, fontWeight: 800, flex: 1, minWidth: 0 }}>{step.name}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 99, textTransform: 'uppercase', letterSpacing: '0.04em',
                    background: short ? 'rgba(239,68,68,0.15)' : (rule.min > 0 ? 'rgba(232,160,32,0.15)' : 'transparent'),
                    color: short ? '#ef4444' : (rule.min > 0 ? '#a16500' : '#9a9aa1') }}>{ruleWords(rule.min, rule.max)}</div>
                  <div data-testid="online-combo-count" style={{ fontSize: 13, fontWeight: 800, color: st.need > 0 ? theme.fg : '#16a34a' }}>{stepCountWords(step, picks)}</div>
                </div>
                <div style={{ fontSize: 13, color: short ? '#dc2626' : muted, fontWeight: short ? 700 : 500, margin: '2px 0 10px' }}>
                  {stepNeedWords(step, picks)}{step.pricing === PRICING_OWN ? ' · each at its own price' : ''}{stepAsIs(step) ? ' · each as it comes' : ''}
                </div>
                {shown.length === 0 && <div style={{ fontSize: 13, color: muted, padding: '8px 0' }}>Nothing here can be picked right now.</div>}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {shown.map((e) => {
                    const id = e.entry.itemId;
                    const count = mine.filter((p) => p.entryId === id).length;
                    const sel = count > 0;
                    const blocked = e.state !== 'ok' || unpriced(step, e);
                    const room = canPick(step, picks, id);
                    const dim = (blocked && !sel) || (!room && !sel && step.selectionType !== 'single');
                    const avoid = allergenChipLabels(unsafeAllergenIds(e.row, avoidAllergens, e.sizes)).map((r) => r.label);
                    const img = productImage(e.row, null);
                    const counter = rule.repeat;
                    return (
                      <div key={id} data-testid="online-combo-product" data-state={e.state} style={{
                        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 12,
                        background: sel ? `${theme.accent}28` : inputBg,
                        border: `${sel ? 3 : 1.5}px solid ${sel ? theme.accent : cardBdr}`,
                        opacity: dim ? 0.5 : 1, filter: blocked && !sel ? 'grayscale(0.6)' : undefined, transition: 'all .12s ease',
                      }}>
                        <button onClick={() => tap(step, e)} aria-pressed={sel} disabled={fixed} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12, background: 'none', border: 'none', padding: 0, color: theme.fg, fontFamily: 'inherit', textAlign: 'left', cursor: fixed ? 'default' : 'pointer' }}>
                          {!counter && <Indicator checked={sel} round={step.selectionType === 'single'} accent={theme.accent} cardBdr={cardBdr}/>}
                          {img && <img src={img} alt="" loading="lazy" style={{ width: 46, height: 46, borderRadius: 9, objectFit: 'cover', flexShrink: 0 }}/>}
                          <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                            <span style={{ fontSize: 14, fontWeight: sel ? 800 : 600, overflowWrap: 'anywhere', textDecoration: e.state === 'out' && !sel ? 'line-through' : 'none' }}>{tItemName(e.row) || pickLineName(e.row, ctx.rowsById)}{stepOpensOptions(step, e.row, ctx) && <span data-testid="online-combo-opens" aria-hidden="true" style={{ marginLeft: 6, opacity: 0.6 }}>›</span>}</span>
                            <AllergenChips ids={e.row.allergens} size="card" palette={palette}/>
                            {avoid.length > 0 && <span style={{ fontSize: 11, fontWeight: 800, color: '#dc2626' }}>Contains {avoid.join(', ')}</span>}
                          </span>
                          <span style={{ fontSize: 13, fontWeight: 700, flexShrink: 0, color: blocked ? '#dc2626' : theme.fg }}>
                            {blocked ? (e.state === 'type' ? ctx.notSoldShort() : e.state === 'ok' ? 'Not available' : (e.words === "86'd" ? 'Sold out' : e.words)) : `${wordsFor(step, e)}${e.words ? ` · ${e.words}` : ''}`}
                          </span>
                        </button>
                        {counter && !fixed && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                            <button onClick={() => untap(step, id)} disabled={!sel} aria-label={`One less ${e.row.menu_name || e.row.name}`} style={roundBtn(!sel ? `${theme.fg}10` : theme.fg, !sel ? `${theme.fg}40` : theme.bg, !sel)}>−</button>
                            <span data-testid="online-combo-product-count" style={{ minWidth: 16, textAlign: 'center', fontSize: 14, fontWeight: 800 }}>{count}</span>
                            <button onClick={() => tap(step, e)} disabled={blocked || !room} aria-label={`One more ${e.row.menu_name || e.row.name}`} style={roundBtn(!blocked && room ? theme.accent : `${theme.fg}10`, !blocked && room ? contrastFg(theme.accent) : `${theme.fg}40`, blocked || !room)}>+</button>
                          </div>
                        )}
                        {counter && fixed && <span style={{ fontSize: 14, fontWeight: 800 }}>{count}</span>}
                      </div>
                    );
                  })}
                </div>
                {listed.length > 0 && (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {listed.map((p, n) => {
                      const row = rowOfPick(p);
                      const needs = stepPickNeeds(step, p, ctx);
                      const price = row ? pickPrice({ step, entryId: p.entryId, mods: p.mods, ownPrice: priceFor(row) }) : { total: 0, base: 0 };
                      return (
                        <div key={p.key} data-testid="online-combo-pick" onClick={() => setConfiguring({ key: p.key, fresh: false })} style={{ cursor: 'pointer', display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 12px', borderRadius: 10, border: `1.5px solid ${needs ? '#ef4444' : cardBdr}`, background: needs ? 'rgba(239,68,68,0.08)' : 'transparent' }}>
                          <span style={{ fontSize: 12, fontWeight: 800, color: muted, minWidth: 14, paddingTop: 2 }}>{n + 1}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 700 }}>{row ? pickLineName(row, ctx.rowsById) : ''}</div>
                            {(p.mods || []).map((m, k) => <div key={k} style={{ fontSize: 12, color: muted }}>{m.label || m.name}{Number(m.price) > 0 ? ` +${money(m.price)}` : ''}</div>)}
                            {p.notes && <div style={{ fontSize: 12, color: muted, fontStyle: 'italic' }}>{p.notes}</div>}
                            {needs && <div style={{ fontSize: 12, fontWeight: 700, color: '#dc2626' }}>{needs === 'size' ? 'Choose a size' : 'Choose its options'}</div>}
                          </div>
                          <span style={{ fontSize: 13, fontWeight: 700, color: muted, paddingTop: 1 }}>{price.total > 0 ? (price.base > 0 ? money(price.total) : `+${money(price.total)}`) : 'Included'}</span>
                          <span aria-hidden="true" style={{ fontSize: 18, fontWeight: 800, color: needs ? '#dc2626' : muted, lineHeight: 1.1 }}>›</span>
                          {!fixed && <button onClick={(ev) => { ev.stopPropagation(); removePick(p); }} aria-label="Take this one off" style={{ width: 30, height: 30, borderRadius: 8, border: `1px solid ${cardBdr}`, background: inputBg, color: muted, fontSize: 16, cursor: 'pointer', fontFamily: 'inherit' }}>×</button>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ position: 'sticky', bottom: 0, padding: '14px 22px calc(14px + env(safe-area-inset-bottom)) 22px', background: theme.bg, borderTop: `1px solid ${cardBdr}`, flexShrink: 0 }}>
          {totals.extras > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: muted, marginBottom: 8 }}><span>{money(totals.setPrice)} + extras</span><span>+{money(totals.extras)}</span></div>}
          <button onClick={add} data-testid="online-combo-add" data-ready={missing ? 'no' : 'yes'} style={{
            width: '100%', padding: '16px 22px', borderRadius: 14, border: 'none', fontSize: 16, fontWeight: 800, fontFamily: 'inherit', cursor: 'pointer',
            background: missing ? `${theme.fg}20` : theme.accent, color: missing ? theme.fg : contrastFg(theme.accent),
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
          }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{missing || addLabel}</span>
            <span style={{ flexShrink: 0 }}>{money(totals.total)}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

const roundBtn = (bg, fg, off) => ({
  width: 30, height: 30, borderRadius: '50%', border: 'none', background: bg, color: fg, fontSize: 18, fontWeight: 800,
  cursor: off ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit',
});

function Indicator({ checked, round, accent, cardBdr }) {
  return (
    <div style={{ width: 22, height: 22, borderRadius: round ? '50%' : 6, border: `2px solid ${checked ? accent : cardBdr}`, background: checked ? accent : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      {checked && (round ? <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#fff' }}/> : <span style={{ color: '#fff', fontSize: 14, lineHeight: 1, fontWeight: 900 }}>✓</span>)}
    </div>
  );
}
