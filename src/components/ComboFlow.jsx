import { useState, useMemo } from 'react';
import { useStore } from '../store';
import { money } from '../lib/currency';
import { ALLERGENS } from '../data/seed';
import { Icon } from './ServOSIcons';
import InlineItemFlow from './InlineItemFlow';
import { AllergenModal } from './ProductModal';
import {
  comboSteps, stepEntries, stepStatus, stepNeedWords, stepCountWords, stepRule, ruleWords,
  tapEntry, untapEntry, canPick, startingPicks, fixedAnswer, pickNeeds, pickPrice, comboTotal,
  comboMissing, pickLineName, picksOfStep, PRICING_OWN,
} from '../lib/combo';
import { comboPosContext, pickFlowSetup } from '../lib/comboLines';

// ══════════════════════════════════════════════════════════════════════════════
// ComboFlow: a Combo on the POS (5.12.123, stage 1). The same centre panel frame as
// InlineItemFlow: tap the Combo, walk its steps, see the count against each rule and what is
// still missing, then Add. Every unit picked is its own pick; a pick's own options are the
// product's real ones, asked in the very same option flow (InlineItemFlow) and charged on top.
// The rules are lib/combo.js; this file only draws them. The store has the last word (addCombo).
// ══════════════════════════════════════════════════════════════════════════════

let _pickSeq = 0;
const pickKey = () => `pk-${Date.now().toString(36)}-${++_pickSeq}`;

export default function ComboFlow({ item, menuItems, activeAllergens = [], initialPicks = null, giveBack = null, addLabel = 'Add to order', onAdd, onCancel }) {
  const storeRows = useStore(s => s.menuItems);
  const eightySixIds = useStore(s => s.eightySixIds);
  const dailyCounts = useStore(s => s.dailyCounts);
  const orderType = useStore(s => s.orderType);
  const activeTableId = useStore(s => s.activeTableId);
  const activeMenuId = useStore(s => s.activeMenuId);
  const modifierGroupDefs = useStore(s => s.modifierGroupDefs);
  const instructionGroupDefs = useStore(s => s.instructionGroupDefs);
  const getItemPrice = useStore(s => s.getItemPrice);

  const steps = useMemo(() => comboSteps(item), [item]);
  // What can be picked right now: the store's own context (86, daily counts, Sold as, hidden by
  // head office, required options), so this screen and addCombo can never disagree.
  const ctx = useMemo(() => comboPosContext({
    item, menuItems: storeRows || [], eightySixIds: eightySixIds || [], dailyCounts: dailyCounts || {},
    orderType: activeTableId ? 'dine-in' : orderType,
    modifierGroupDefs: modifierGroupDefs || [], instructionGroupDefs: instructionGroupDefs || [], giveBack,
  }), [item, storeRows, eightySixIds, dailyCounts, orderType, activeTableId, modifierGroupDefs, instructionGroupDefs, giveBack]);
  const priceOf = (row) => (getItemPrice ? getItemPrice(row, orderType, activeMenuId) : (row?.pricing?.base ?? row?.price ?? 0));
  const setPrice = priceOf(item);

  const newPick = (stepId, entryId) => ({
    key: pickKey(), stepId, entryId,
    itemId: ctx.sizesOf(entryId).length ? null : entryId,   // a product with sizes waits for its size
    mods: [], notes: '', answers: null, configured: false,
  });

  // A step that fills itself (one product, an exact number) starts filled.
  const [picks, setPicks] = useState(() => initialPicks || startingPicks(steps, ctx, newPick));
  const firstOpen = (list) => { const i = steps.findIndex(s => !stepStatus(s, list).done || picksOfStep(list, s.id).some(p => pickNeeds(p, ctx))); return i < 0 ? 'summary' : i; };
  const [view, setView] = useState(() => firstOpen(initialPicks || startingPicks(steps, ctx, newPick)));
  const [configuring, setConfiguring] = useState(null);     // { key, fresh } while a pick's own options are open
  const [pendingAllergen, setPendingAllergen] = useState(null);
  const [say, setSay] = useState(null);                     // one line of words under the header (why a tap did nothing)
  // Leaving loses the picks, so once staff have picked anything the back arrow asks for a second tap.
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const leave = () => {
    if (dirty && !leaving) { setLeaving(true); setSay('Tap back again to leave this Combo. Its picks will be lost.'); return; }
    onCancel();
  };

  const rowOfPick = (p) => ctx.rowsById.get(p.itemId ?? p.entryId) || ctx.rowsById.get(p.entryId) || null;
  const stepById = (id) => steps.find(s => s.id === id) || null;
  const priceOfPick = (p) => {
    const step = stepById(p.stepId);
    const row = rowOfPick(p);
    return step && row ? pickPrice({ step, entryId: p.entryId, mods: p.mods, ownPrice: priceOf(row) }) : { base: 0, bump: 0, extras: 0, total: 0 };
  };
  const totals = comboTotal({ setPrice, steps, picks, rowsById: ctx.rowsById, priceOf });
  const missing = comboMissing(steps, picks, ctx);

  const flash = (words) => { setLeaving(false); setSay(words); };
  const goTo = (v) => { setLeaving(false); setSay(null); setView(v); };

  // After a step fills up, walk on to the next step that still has something to choose.
  const advanceFrom = (index, list) => {
    for (let i = index + 1; i < steps.length; i++) {
      const done = stepStatus(steps[i], list);
      const needsAnswer = picksOfStep(list, steps[i].id).some(p => pickNeeds(p, ctx));
      if (!(fixedAnswer(steps[i], ctx) && done.done && !needsAnswer)) { goTo(i); return; }
    }
    goTo('summary');
  };
  const settle = (step, list) => {
    const index = steps.indexOf(step);
    const st = stepStatus(step, list);
    if (st.full && !picksOfStep(list, step.id).some(p => pickNeeds(p, ctx)) && view === index) advanceFrom(index, list);
  };

  const doTap = (step, e) => {
    let made = null;
    const next = tapEntry(step, picks, e.entry.itemId, (entryId) => (made = newPick(step.id, entryId)));
    if (next === picks) {
      const st = stepStatus(step, picks);
      flash(st.full ? `${step.name}: ${st.max} picked already. Take one off to change it.` : 'Each product only once in this step.');
      return;
    }
    setSay(null); setLeaving(false); setDirty(true);
    setPicks(next);
    // A size to pick, or an option that must be answered: ask it now, in the product's own flow.
    if (made && pickNeeds(made, ctx)) { setConfiguring({ key: made.key, fresh: true }); return; }
    settle(step, next);
  };
  const tap = (step, e) => {
    // Tapping a product already picked in a "one choice" or "each only once" step takes it off:
    // that always works, whatever has run out since, and needs no allergen warning.
    const already = picksOfStep(picks, step.id).some(p => p.entryId === e.entry.itemId) && !stepRule(step).repeat;
    if (e.state !== 'ok' && !already) {
      const name = e.row?.menuName || e.row?.name || 'That';
      flash(e.state === 'type' ? (e.words || `${name} is not available for this order type.`) : `${name}: ${e.words || 'cannot be picked'}`);
      return;
    }
    const flagged = (e.row.allergens || []).some(a => activeAllergens.includes(a));
    if (flagged && !already) { setPendingAllergen({ step, e }); return; }
    doTap(step, e);
  };
  const untap = (step, entryId) => { setSay(null); setLeaving(false); setDirty(true); setPicks(untapEntry(step, picks, entryId)); };
  const removePick = (p) => { setSay(null); setLeaving(false); setDirty(true); setPicks(picks.filter(x => x.key !== p.key)); };

  // ── A pick's own options: the product's real option flow ────────────────────
  const cfgPick = configuring ? picks.find(p => p.key === configuring.key) || null : null;
  if (cfgPick) {
    const step = stepById(cfgPick.stepId);
    // The same set up the order panel uses to change a pick (lib/comboLines.js pickFlowSetup).
    const setup = pickFlowSetup({
      entryId: cfgPick.entryId, itemId: cfgPick.itemId, answers: cfgPick.answers, step, ctx,
      picks: picks.filter(p => p.key !== cfgPick.key), menuItems, priceOf, money,
    });
    const close = (cancelled) => {
      // A fresh pick that still needs its size or a required answer cannot stay half made.
      if (cancelled && configuring.fresh && pickNeeds(cfgPick, ctx)) setPicks(picks.filter(p => p.key !== cfgPick.key));
      setConfiguring(null);
    };
    if (!setup) {
      // Its product left the menu under the screen: say so, and go back to the steps.
      return (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:14, height:'100%', padding:24, background:'var(--bg)' }}>
          <div style={{ fontSize:14, fontWeight:700, color:'var(--t2)', textAlign:'center' }}>That product is not on the menu any more.</div>
          <button className="btn btn-ghost" style={{ height:44, padding:'0 20px' }} onClick={() => { setPicks(picks.filter(p => p.key !== cfgPick.key)); setConfiguring(null); }}>Back to the steps</button>
        </div>
      );
    }
    return (
      <InlineItemFlow
        key={`cfg-${cfgPick.key}`}
        item={setup.flowItem}
        menuItems={setup.flowMenu}
        activeAllergens={activeAllergens}
        mode="edit"
        lockedQty={1}
        basePriceOf={setup.baseOf}
        sizePriceWords={setup.sizeWords}
        initialAnswers={setup.answers}
        onConfirm={(target, mods, _cfg, opts) => {
          const next = picks.map(p => (p.key === cfgPick.key ? { ...p, itemId: target.id, mods: mods || [], notes: opts?.notes || '', answers: opts?.answers || null, configured: true } : p));
          setPicks(next);
          setDirty(true);
          setConfiguring(null);
          if (step) settle(step, next);
        }}
        onCancel={() => close(true)}
      />
    );
  }

  const handleAdd = () => {
    if (missing) {
      flash(missing);
      // Jump to where it is missing: the first step that is short, else the first pick that needs an answer.
      const short = steps.findIndex(s => !stepStatus(s, picks).done);
      if (short >= 0) { setView(short); return; }
      const need = picks.find(p => pickNeeds(p, ctx));
      if (need) setConfiguring({ key: need.key, fresh: false });
      return;
    }
    onAdd(picks);
  };

  const step = typeof view === 'number' ? steps[view] : null;
  const chip = (label, sub, state, onClick, key) => (
    <button key={key} onClick={onClick} data-testid={`combo-chip-${key}`}
      style={{ display:'flex', flexDirection:'column', alignItems:'flex-start', gap:1, padding:'7px 12px', borderRadius:10, cursor:'pointer', fontFamily:'inherit', flexShrink:0, minHeight:44, textAlign:'left',
        border:`1.5px solid ${state === 'on' ? 'var(--acc)' : state === 'done' ? 'var(--grn-b)' : 'var(--bdr)'}`,
        background: state === 'on' ? 'var(--acc-d)' : 'var(--bg2)' }}>
      <span style={{ fontSize:12, fontWeight:700, color: state === 'on' ? 'var(--acc)' : 'var(--t1)', whiteSpace:'nowrap', maxWidth:170, overflow:'hidden', textOverflow:'ellipsis' }}>{label}</span>
      <span style={{ fontSize:10, fontWeight:600, color: state === 'done' ? 'var(--grn)' : 'var(--t3)', whiteSpace:'nowrap' }}>{sub}</span>
    </button>
  );

  // One pick as a row: its name, what it adds, its own options, Change and take off.
  const pickRow = (p, { number = null, fixed = false } = {}) => {
    const row = rowOfPick(p);
    const price = priceOfPick(p);
    const needs = pickNeeds(p, ctx);
    const entryRow = ctx.rowsById.get(p.entryId);
    const canChange = !!entryRow && (ctx.hasOptions(entryRow) || (row && ctx.hasOptions(row)));
    return (
      <div key={p.key} data-testid="combo-pick" style={{ display:'flex', alignItems:'flex-start', gap:10, padding:'9px 12px', borderRadius:10, border:`1.5px solid ${needs ? 'var(--red-b)' : 'var(--bdr)'}`, background: needs ? 'var(--red-d)' : 'var(--bg2)' }}>
        {number != null && <span style={{ fontSize:11, fontWeight:800, color:'var(--t4)', fontFamily:'var(--font-mono)', minWidth:16, paddingTop:2 }}>{number}</span>}
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)', lineHeight:1.3 }}>{row ? pickLineName(row, ctx.rowsById) : 'Gone from the menu'}</div>
          {(p.mods || []).map((m, i) => (
            <div key={i} style={{ fontSize:11, color:'var(--t3)', marginTop:1, display:'flex', justifyContent:'space-between', gap:8, fontStyle: m._instruction ? 'italic' : 'normal' }}>
              <span>{m.label}</span>
              {m.price > 0 && <span style={{ color:'var(--acc)', fontFamily:'var(--font-mono)' }}>+{money(m.price)}</span>}
            </div>
          ))}
          {p.notes && <div style={{ fontSize:11, color:'var(--t3)', marginTop:1, fontStyle:'italic' }}><Icon name="note" size={11} style={{ display:'inline-block', verticalAlign:'-2px', marginRight:4 }}/>{p.notes}</div>}
          {needs && <div style={{ fontSize:11, fontWeight:700, color:'var(--red)', marginTop:3 }}>{needs === 'size' ? 'Choose a size' : 'Choose its options'}</div>}
        </div>
        <div style={{ fontSize:13, fontWeight:800, fontFamily:'var(--font-mono)', color: price.total > 0 ? 'var(--acc)' : 'var(--t4)', flexShrink:0, paddingTop:1 }}>
          {price.total > 0 ? (price.base > 0 ? money(price.total) : `+${money(price.total)}`) : 'Included'}
        </div>
        {/* Every pick can still be changed: its options where it has some, a note where it has none. */}
        {!!entryRow && (
          <button onClick={() => setConfiguring({ key: p.key, fresh: false })} data-testid="combo-pick-change"
            style={{ height:32, padding:'0 12px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', fontSize:12, fontWeight:700, flexShrink:0,
              border:`1px solid ${needs ? 'var(--red-b)' : 'var(--bdr2)'}`, background: needs ? 'var(--red)' : 'var(--bg3)', color: needs ? '#fff' : 'var(--t1)' }}>
            {needs ? 'Choose' : canChange ? 'Change' : 'Note'}
          </button>
        )}
        {!fixed && (
          <button onClick={() => removePick(p)} aria-label="Take this pick off" title="Take this pick off"
            style={{ width:32, height:32, borderRadius:8, cursor:'pointer', fontFamily:'inherit', fontSize:16, flexShrink:0, border:'1px solid var(--bdr)', background:'var(--bg3)', color:'var(--t3)', display:'flex', alignItems:'center', justifyContent:'center' }}>×</button>
        )}
      </div>
    );
  };

  return (
    <div data-testid="combo-flow" style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden', background:'var(--bg)' }}>

      {/* ── Header: the Combo, the running total, the steps ───────────────── */}
      <div style={{ padding:'14px 18px 10px', borderBottom:'1px solid var(--bdr)', background:'var(--bg1)', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'flex-start', gap:10 }}>
          <button onClick={leave} aria-label="Back to the menu" data-testid="combo-back" style={{ width:34, height:34, borderRadius:10, border:'1px solid var(--bdr2)', background:'var(--bg3)', color:'var(--t2)', cursor:'pointer', fontSize:16, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>←</button>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:17, fontWeight:800, color:'var(--t1)', letterSpacing:'-.01em' }}>{item.menuName || item.name}</div>
            <div style={{ fontSize:12, color:'var(--t3)', marginTop:2 }}>Combo · set price {money(totals.setPrice)}{totals.extras > 0 ? ` · extras +${money(totals.extras)}` : ''}</div>
          </div>
          <div data-testid="combo-total" style={{ fontFamily:'var(--font-mono)', fontSize:18, fontWeight:800, color:'var(--acc)', flexShrink:0 }}>{money(totals.total)}</div>
        </div>
        <div style={{ display:'flex', gap:6, marginTop:10, overflowX:'auto', paddingBottom:2 }}>
          {steps.map((s, i) => {
            const st = stepStatus(s, picks);
            const needsAnswer = picksOfStep(picks, s.id).some(p => pickNeeds(p, ctx));
            const done = st.done && !needsAnswer && st.count > 0;
            return chip(`${i + 1}. ${s.name}`, needsAnswer ? 'Choose options' : stepCountWords(s, picks), view === i ? 'on' : done ? 'done' : 'idle', () => goTo(i), i);
          })}
          {chip('Summary', missing ? 'Not ready' : 'Ready', view === 'summary' ? 'on' : 'idle', () => goTo('summary'), 'summary')}
        </div>
        {say && (
          <div data-testid="combo-say" style={{ marginTop:8, padding:'8px 12px', background:'var(--red-d)', border:'1px solid var(--red-b)', borderRadius:10, fontSize:12, fontWeight:700, color:'var(--red)', display:'flex', gap:8, alignItems:'center' }}>
            <Icon name="warn" size={14}/><span>{say}</span>
          </div>
        )}
      </div>

      {/* ── Content: one step, or the summary ─────────────────────────────── */}
      <div style={{ flex:1, overflowY:'auto', padding:16 }}>
        {step && (() => {
          const rule = stepRule(step);
          const st = stepStatus(step, picks);
          const mine = picksOfStep(picks, step.id);
          const shown = stepEntries(step, ctx, picks);
          const fixed = !!fixedAnswer(step, ctx);
          return (
            <div>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4, flexWrap:'wrap' }}>
                <span style={{ fontSize:13, fontWeight:800, color:'var(--t1)', textTransform:'uppercase', letterSpacing:'.06em' }}>{step.name}</span>
                <span style={{ fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:6, background: st.need > 0 ? 'var(--red-d)' : 'var(--bg3)', color: st.need > 0 ? 'var(--red)' : 'var(--t3)', border:`1px solid ${st.need > 0 ? 'var(--red-b)' : 'var(--bdr)'}` }}>{ruleWords(rule.min, rule.max)}</span>
                <span style={{ fontSize:10, color:'var(--t4)' }}>{step.pricing === PRICING_OWN ? 'Each keeps its own price' : 'Part of the set price'}</span>
                <span data-testid="combo-step-count" style={{ fontSize:12, fontWeight:800, marginLeft:'auto', color: st.need > 0 ? 'var(--acc)' : 'var(--grn)', fontFamily:'var(--font-mono)' }}>{stepCountWords(step, picks)}</span>
              </div>
              <div data-testid="combo-step-need" style={{ fontSize:12, fontWeight:600, color: st.need > 0 ? 'var(--t2)' : 'var(--grn)', marginBottom:12 }}>{stepNeedWords(step, picks)}</div>

              {shown.length === 0 && <div style={{ padding:'24px 0', textAlign:'center', color:'var(--t3)', fontSize:13 }}>Nothing in this step can be picked right now.</div>}
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(168px,1fr))', gap:8 }}>
                {shown.map(e => {
                  const id = e.entry.itemId;
                  const count = mine.filter(p => p.entryId === id).length;
                  const sel = count > 0;
                  const blocked = e.state !== 'ok';
                  const room = canPick(step, picks, id);
                  // A tile that is picked stays live (a tap takes it off, or the minus does) even when no more can be added.
                  const dim = (blocked && !sel) || (!room && !sel && step.selectionType !== 'single');
                  const flagged = (e.row.allergens || []).filter(a => activeAllergens.includes(a));
                  const own = step.pricing === PRICING_OWN;
                  const words = own
                    ? (e.sizes.length ? `from ${money(Math.min(...e.sizes.map(s => priceOf(s))))}` : money(priceOf(e.row)))
                    : (e.entry.bump > 0 ? `+${money(e.entry.bump)}` : '');
                  return (
                    <div key={id} style={{ position:'relative', display:'flex' }}>
                      <button onClick={() => tap(step, e)} data-testid="combo-tile" data-state={e.state} aria-pressed={sel}
                        style={{ width:'100%', minHeight:76, display:'flex', flexDirection:'column', alignItems:'flex-start', justifyContent:'space-between', gap:6,
                          padding:'12px 14px', paddingRight: sel && rule.repeat ? 64 : 14, borderRadius:14, cursor: dim ? 'not-allowed' : 'pointer', fontFamily:'inherit', textAlign:'left', transition:'all .1s',
                          border:`2px solid ${blocked && !sel ? 'var(--red-b)' : sel ? 'var(--acc)' : 'var(--bdr)'}`,
                          background: blocked && !sel ? 'var(--bg5)' : sel ? 'var(--acc-d)' : 'var(--bg2)', opacity: dim ? 0.45 : 1 }}>
                        <span style={{ fontSize:14, fontWeight:700, lineHeight:1.25, wordBreak:'break-word', color: sel ? 'var(--acc)' : 'var(--t1)', textDecoration: e.state === 'out' && !sel ? 'line-through' : 'none' }}>{e.row.menuName || e.row.name}</span>
                        <span style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
                          {words && <span style={{ fontSize:12, fontWeight:700, fontFamily:'var(--font-mono)', color: sel ? 'var(--acc)' : 'var(--t3)' }}>{words}</span>}
                          {e.words && <span data-testid="combo-tile-words" style={{ fontSize:10, fontWeight:800, padding:'1px 6px', borderRadius:5, background: blocked ? 'var(--red-d)' : 'var(--wrn-d,#fff3cd)', color: blocked ? 'var(--red)' : 'var(--wrn,#856404)', border:`1px solid ${blocked ? 'var(--red-b)' : 'var(--wrn-b,#ffc107)'}` }}>{e.state === 'type' ? ctx.notSoldShort() : e.words}</span>}
                          {flagged.length > 0 && <span style={{ fontSize:10, fontWeight:800, padding:'1px 6px', borderRadius:5, background:'var(--red-d)', color:'var(--red)', border:'1px solid var(--red-b)', display:'inline-flex', alignItems:'center', gap:3 }}><Icon name="warn" size={10}/>{flagged.map(a => ALLERGENS.find(x => x.id === a)?.label || a).join(', ')}</span>}
                        </span>
                      </button>
                      {sel && rule.repeat && (
                        <div style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%)', display:'flex', alignItems:'center', gap:5 }}>
                          <button onClick={(ev) => { ev.stopPropagation(); untap(step, id); }} aria-label={`One less ${e.row.menuName || e.row.name}`}
                            style={{ width:30, height:30, borderRadius:8, border:'1.5px solid var(--acc)', background:'var(--acc-d)', color:'var(--acc)', cursor:'pointer', fontFamily:'inherit', fontSize:17, fontWeight:800, display:'flex', alignItems:'center', justifyContent:'center', lineHeight:1 }}>−</button>
                          <span data-testid="combo-tile-count" style={{ fontSize:15, fontWeight:900, color:'var(--acc)', minWidth:14, textAlign:'center', fontFamily:'var(--font-mono)' }}>{count}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {mine.length > 0 && (
                <div style={{ marginTop:16 }}>
                  <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6 }}>Picked</div>
                  <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                    {mine.map((p, i) => pickRow(p, { number: i + 1, fixed }))}
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {view === 'summary' && (
          <div data-testid="combo-summary">
            {steps.map((s, i) => {
              const mine = picksOfStep(picks, s.id);
              const st = stepStatus(s, picks);
              return (
                <div key={s.id} style={{ marginBottom:14 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                    <span style={{ fontSize:12, fontWeight:800, color:'var(--t1)', textTransform:'uppercase', letterSpacing:'.06em' }}>{s.name}</span>
                    <span style={{ fontSize:11, fontWeight:700, color: st.need > 0 ? 'var(--red)' : 'var(--t3)' }}>{st.need > 0 ? stepNeedWords(s, picks) : stepCountWords(s, picks)}</span>
                    {!fixedAnswer(s, ctx) && <button onClick={() => goTo(i)} style={{ marginLeft:'auto', fontSize:12, fontWeight:700, color:'var(--acc)', background:'none', border:'none', cursor:'pointer', fontFamily:'inherit', padding:'6px 0', minHeight:32 }}>Change picks</button>}
                  </div>
                  {mine.length === 0 && <div style={{ fontSize:12, color:'var(--t4)', padding:'2px 0 0' }}>{st.min > 0 ? 'Nothing picked yet' : 'None'}</div>}
                  <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                    {mine.map(p => pickRow(p, { fixed: !!fixedAnswer(s, ctx) }))}
                  </div>
                </div>
              );
            })}
            <div style={{ marginTop:8, padding:'12px 14px', borderRadius:12, border:'1px solid var(--bdr)', background:'var(--bg2)' }}>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, color:'var(--t2)', marginBottom:4 }}><span>Set price</span><span style={{ fontFamily:'var(--font-mono)' }}>{money(totals.setPrice)}</span></div>
              {totals.extras > 0 && <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, color:'var(--t2)', marginBottom:4 }}><span>Extras</span><span style={{ fontFamily:'var(--font-mono)' }}>+{money(totals.extras)}</span></div>}
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:17, fontWeight:800, color:'var(--t1)', paddingTop:6, borderTop:'1px solid var(--bdr)' }}><span>Total</span><span style={{ fontFamily:'var(--font-mono)', color:'var(--acc)' }}>{money(totals.total)}</span></div>
            </div>
          </div>
        )}
      </div>

      {/* ── Footer: what is missing, or Add ───────────────────────────────── */}
      <div style={{ padding:'12px 16px', borderTop:'1px solid var(--bdr)', background:'var(--bg1)', flexShrink:0, display:'flex', gap:8 }}>
        {typeof view === 'number' && (
          <button onClick={() => goTo(view + 1 < steps.length ? view + 1 : 'summary')} className="btn btn-ghost" data-testid="combo-next"
            style={{ height:52, padding:'0 18px', fontSize:14, fontWeight:700, borderRadius:14, flexShrink:0 }}>
            {view + 1 < steps.length ? 'Next step →' : 'Summary →'}
          </button>
        )}
        <button onClick={handleAdd} className="btn btn-acc" data-testid="combo-add" data-ready={missing ? 'no' : 'yes'}
          style={{ flex:1, height:52, fontSize:16, fontWeight:800, borderRadius:14, background: missing ? 'var(--red)' : 'var(--acc)', opacity:1, cursor:'pointer', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
          {missing ? missing : `${addLabel} · ${money(totals.total)}`}
        </button>
      </div>

      {pendingAllergen && (
        <AllergenModal item={{ ...pendingAllergen.e.row, name: pendingAllergen.e.row.menuName || pendingAllergen.e.row.name }} activeAllergens={activeAllergens}
          onConfirm={() => { const { step: s, e } = pendingAllergen; setPendingAllergen(null); doTap(s, e); }}
          onCancel={() => setPendingAllergen(null)} />
      )}
    </div>
  );
}
