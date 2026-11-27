// src/backoffice/sections/ComboStepsTab.jsx
//
// THE STEPS TAB OF A COMBO PRODUCT (site Menu Manager, 5.12.123, stage 1).
//
// Peter, 27 Nov 2026: "composite product - Step 1 - name = Pic a product add the products for this
// step set rules around it like you can anyway with modifers same logic etc. But we would need to
// say - keeps price or is part of set price".
//
// A Combo is one product at a set price (its own price, on Details) built from REAL products.
// Here: add, name, reorder and remove steps; the kind of choice and how many (the same three kinds
// and the same words an option group has); part of the set price or keeps its price; the products
// of each step (found from the menu, never typed), their order and an optional price bump; and
// what is wrong, in words. Every rule is lib/combo.js: this file only draws the form and saves
// { combo } through the editor's own onUpdate (one column, lib/menuItemWrite.js).
import { useState, useMemo } from 'react';
import { Icon } from '../../components/ServOSIcons';
import { money, currencySymbol } from '../../lib/currency';
import { selectOnFocus } from '../../lib/selectOnFocus';
import { beginDrag, dragOver } from '../../lib/dragReorder';
import { compareMenuItems } from '../../lib/menuItemOrder.js';
import { resolveItemPrice, hasNoSellPrice, variantFromPrice } from '../../lib/menuPricing';
import { optionHiddenOn } from '../../lib/soldAs.js';
import {
  comboSteps, comboHasSteps, comboColumnValue, newStep, stepForm, stepWithForm, stepSentence, stepProductBlock,
  stepsEditBlock, comboWarnings, STEP_KIND_WORDS, PRICING_WORDS, PRICING_SET, PRICING_OWN, UNLIMITED, COMBO_WORDS,
} from '../../lib/combo.js';

const inp = { background:'var(--bg3)', border:'1.5px solid var(--bdr2)', borderRadius:9, padding:'8px 11px', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', width:'100%', boxSizing:'border-box' };
const lbl = { fontSize:10, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', display:'block', marginBottom:5 };
const KINDS = [
  { id: 'single', hint: 'Pick one, like a drink' },
  { id: 'multiple', hint: 'Pick a few, like sides' },
  { id: 'quantity', hint: 'A set number, like 5 pizzas' },
];
const nameOf = (r) => r?.menuName || r?.menu_name || r?.name || 'Product';
// Every name a product goes by (POS button, full name, receipt, kitchen): the find box matches any of them.
const namesOf = (r) => [r?.menuName, r?.menu_name, r?.name, r?.receiptName, r?.kitchenName].filter(Boolean).join(' ').toLowerCase();
const newId = () => `st-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// A number box that saves when it is left (or on Enter), so a half typed number never becomes the rule.
function NumBox({ value, min = 1, max = 98, onCommit, label, width = 58 }) {
  const [draft, setDraft] = useState(null);
  const commit = () => {
    if (draft == null) return;
    const n = Math.round(Number(draft));
    setDraft(null);
    if (Number.isFinite(n)) onCommit(Math.max(min, Math.min(max, n)));
  };
  return (
    <input type="number" inputMode="numeric" min={min} max={max} aria-label={label} {...selectOnFocus}
      style={{ ...inp, width, padding:'6px 8px', textAlign:'center', fontWeight:700 }}
      value={draft ?? value} onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
  );
}

// 5.12.124 (stage 2, the Multi site menu):
//   readOnly    the steps are head office's here (a product the group menu manages, and the site
//               does not keep its own steps): everything shows, nothing can be changed or dragged.
//               MenuManager wraps the tab in the usual lock (MsmLocked) that says why.
//   keptSteps   the site keeps its own steps (msm_product_sites.kept.combo): editable, and said.
//   posOnlyNote false hides the "POS only" note (the group menu says where a Combo sells itself).
//   needsUpdateWords, priceWhere   the group menu's own words for the SQL it needs and its price.
// The group menu uses this same tab through a small adapter (msm/MsmComboSteps.jsx): its products
// are shaped like the store's menu rows, so the rules and the words are the same in both places.
export default function ComboStepsTab({ item, menuItems = [], categories = [], onUpdate, markBOChange, columnReady = true, eightySixIds = [], readOnly = false, keptSteps = false, posOnlyNote = true, needsUpdateWords = COMBO_WORDS.needsUpdate, priceWhere = '(the price on Details)', noPriceWhere = 'on Details' }) {
  const steps = comboSteps(item);
  const [open, setOpen] = useState(() => (steps.length === 1 ? steps[0].id : null));   // the step whose form is open
  const [nameDraft, setNameDraft] = useState({});       // step id -> the name being typed
  const [bumpDraft, setBumpDraft] = useState({});       // step id + product id -> the bump being typed
  const [search, setSearch] = useState('');
  const [dragStep, setDragStep] = useState(null);
  const [overStep, setOverStep] = useState(null);
  const [dragProd, setDragProd] = useState(null);
  const [overProd, setOverProd] = useState(null);

  const rowsById = useMemo(() => new Map((menuItems || []).filter(Boolean).map(r => [r.id, r])), [menuItems]);
  const sizesOf = useMemo(() => {
    const m = new Map();
    for (const r of (menuItems || [])) {
      if (!r || r.archived || !r.parentId) continue;
      if (!m.has(r.parentId)) m.set(r.parentId, []);
      m.get(r.parentId).push(r);
    }
    for (const list of m.values()) list.sort(compareMenuItems);
    return m;
  }, [menuItems]);
  const catName = useMemo(() => new Map((categories || []).map(c => [c.id, c.label || c.name || ''])), [categories]);

  const block = stepsEditBlock(item, { sizes: (sizesOf.get(item.id) || []).length });
  const warnings = comboWarnings(item, {
    rowsById, eightySix: eightySixIds, hiddenHere: (row) => optionHiddenOn(row, 'pos'), noPrice: hasNoSellPrice(item), priceWhere: noPriceWhere,
    // A step that keeps prices sells the product at its own price: a product with sizes has one
    // when any of its sizes does.
    noPriceRow: (row) => { const kids = sizesOf.get(row.id) || []; return kids.length ? kids.every(k => hasNoSellPrice(k)) : hasNoSellPrice(row); },
  });
  const setPrice = resolveItemPrice(item);

  const save = (next) => { if (readOnly) return; onUpdate({ combo: comboColumnValue(next) }); markBOChange?.(); };
  // The editor is hidden (the product got sizes, was shared, or is managed) but its steps are
  // still there and the POS still asks them: the one thing that can still be done is take them off.
  const takeStepsOff = () => {
    if (!window.confirm(`Take the ${steps.length === 1 ? 'step' : `${steps.length} steps`} off ${nameOf(item)}? It then sells as a plain product at its price. The products in the steps stay on the menu.`)) return;
    save([]);
  };
  const setStep = (id, fn) => save(steps.map(s => (s.id === id ? fn(s) : s)));
  // One step is open at a time, and the find box starts empty in each (it only narrows the list).
  const openStep = (id) => { setOpen(id); setSearch(''); };
  const addStep = () => { const s = newStep(steps, newId()); save([...steps, s]); openStep(s.id); };
  // A step that keeps prices has no price bumps (the product's own price is what it adds). Switching
  // one over takes its bumps off for good, so it is asked first, with how many go.
  const keepPricesOk = (s, to) => {
    if (to !== PRICING_OWN) return true;
    const n = s.products.filter(p => Number(p.bump) > 0).length;
    return !n || window.confirm(`"${s.name}" has a price bump on ${n} product${n === 1 ? '' : 's'}. Keeping each product's own price takes ${n === 1 ? 'it' : 'them'} off. Go on?`);
  };
  const removeStep = (s) => {
    if (!window.confirm(`Remove the step "${s.name}"? Its products stay on the menu.`)) return;
    save(steps.filter(x => x.id !== s.id));
    if (open === s.id) setOpen(null);
  };
  const moveStep = (from, to) => {
    if (from === to || to < 0 || to >= steps.length) return;
    const arr = [...steps]; const [m] = arr.splice(from, 1); arr.splice(to, 0, m); save(arr);
  };
  const moveProduct = (step, from, to) => {
    if (from === to || to < 0 || to >= step.products.length) return;
    const arr = [...step.products]; const [m] = arr.splice(from, 1); arr.splice(to, 0, m);
    setStep(step.id, s => ({ ...s, products: arr }));
  };
  const commitName = (s) => {
    const v = nameDraft[s.id];
    if (v == null) return;
    setNameDraft(d => { const n = { ...d }; delete n[s.id]; return n; });
    if (v.trim() && v.trim() !== s.name) setStep(s.id, x => ({ ...x, name: v.trim() }));
  };
  const commitBump = (s, itemId) => {
    const key = `${s.id}|${itemId}`;
    const v = bumpDraft[key];
    if (v == null) return;
    setBumpDraft(d => { const n = { ...d }; delete n[key]; return n; });
    const bump = Math.max(0, Math.round((parseFloat(v) || 0) * 100) / 100);
    setStep(s.id, x => ({ ...x, products: x.products.map(p => (p.itemId === itemId ? { ...p, bump } : p)) }));
  };

  // The products a step can take, found from the menu: every sold product, and under a product
  // with sizes each of its sizes (the product itself = any size, asked on the POS).
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    const tops = (menuItems || []).filter(r => r && !r.archived && !r.parentId && !stepProductBlock(r, { comboId: item.id }))
      .sort((a, b) => (catName.get(a.cat) || '').localeCompare(catName.get(b.cat) || '') || compareMenuItems(a, b));
    const out = [];
    for (const r of tops) {
      const kids = sizesOf.get(r.id) || [];
      const hit = !q || namesOf(r).includes(q) || (catName.get(r.cat) || '').toLowerCase().includes(q) || kids.some(k => namesOf(k).includes(q));
      if (!hit) continue;
      out.push({ row: r, size: false });
      for (const k of kids) out.push({ row: k, size: true, parent: r });
    }
    return out;
  }, [menuItems, search, sizesOf, catName, item.id]);

  const priceWords = (row) => {
    const kids = sizesOf.get(row.id) || [];
    return kids.length ? `from ${money(variantFromPrice(row, kids) ?? 0)}` : money(resolveItemPrice(row));
  };

  const note = (tone, words, key) => (
    <div key={key} style={{ fontSize:11.5, lineHeight:1.45, fontWeight:600, padding:'7px 10px', borderRadius:8, marginBottom:6,
      color: tone === 'stop' ? 'var(--red)' : tone === 'note' ? 'var(--amber, #F5A623)' : 'var(--t2)',
      background: tone === 'stop' ? 'var(--red-d)' : tone === 'note' ? 'rgba(245,166,35,.10)' : 'var(--bg3)',
      border:`1px solid ${tone === 'stop' ? 'var(--red-b)' : tone === 'note' ? 'rgba(245,166,35,.35)' : 'var(--bdr)'}` }}>{words}</div>
  );

  return (
    <div data-testid="combo-steps-tab" style={{ display:'flex', flexDirection:'column', gap:12 }}>
      <div style={{ padding:'9px 12px', background:'var(--bg3)', borderRadius:10, fontSize:11.5, color:'var(--t3)', lineHeight:1.5 }}>
        A Combo is <strong style={{ color:'var(--t1)' }}>one product at a set price</strong>, built from real products in steps.
        Each pick goes to the kitchen as its own item, at its own station, with its own options. The Combo itself never prints in the kitchen.
        <div style={{ marginTop:5 }}>Set price: <strong style={{ color:'var(--acc)', fontFamily:'var(--font-mono)' }}>{money(setPrice)}</strong> <span style={{ color:'var(--t4)' }}>{priceWhere}</span></div>
      </div>

      {!columnReady && note('stop', needsUpdateWords, 'col')}
      {block && note('info', block, 'block')}
      {readOnly && columnReady && note('info', 'Head office sets these steps in the Multi site menu. Each product in them is this site\'s own item of that product, and each pick still goes to its own station here.', 'ro')}
      {keptSteps && !readOnly && columnReady && note('info', 'This site keeps its own steps: they stay editable here, and the group menu leaves them as they are.', 'kept')}
      {block && !readOnly && columnReady && comboHasSteps(item) && (
        <div data-testid="combo-steps-still-live">
          {note('stop', `This product still has ${steps.length === 1 ? '1 step' : `${steps.length} steps`}, and the POS still asks ${steps.length === 1 ? 'it' : 'them'}. Undo what is said above to edit ${steps.length === 1 ? 'it' : 'them'}, or take ${steps.length === 1 ? 'it' : 'them'} off.`, 'live')}
          <button className="btn btn-ghost" data-testid="combo-steps-take-off" style={{ height:38, padding:'0 14px', fontSize:12.5, fontWeight:700 }} onClick={takeStepsOff}>Take the steps off</button>
        </div>
      )}

      {!block && columnReady && (
        <>
          {posOnlyNote && note('info', COMBO_WORDS.posOnly + ' It is left off the kiosk, online ordering, QR, catering, the phone POS and the delivery apps until they learn it.', 'pos')}
          {steps.length > 0 && note((item.assignedModifierGroups || []).length ? 'note' : 'info', COMBO_WORDS.noOwnOptions + ((item.assignedModifierGroups || []).length ? ` This product still has ${(item.assignedModifierGroups || []).length} option group${(item.assignedModifierGroups || []).length === 1 ? '' : 's'} from before: they are not asked while it has steps.` : ''), 'opts')}
          {warnings.filter(w => !w.stepId).map((w, i) => note(w.level, w.words, `w${i}`))}

          {steps.length === 0 && (
            <div style={{ padding:'18px 12px', textAlign:'center', border:'1.5px dashed var(--bdr2)', borderRadius:12, color:'var(--t3)', fontSize:12 }}>
              No steps yet. With no steps this product sells exactly as it does today.
            </div>
          )}

          {steps.map((s, si) => {
            const f = stepForm(s);
            // Switching kind keeps sensible numbers: a box starts at 2 or what it had, one choice is 1.
            const toKind = (id) => (id === 'quantity' ? { choice: id, mustChoose: true, max: Math.max(2, f.max >= UNLIMITED ? 2 : f.max) }
              : id === 'single' ? { choice: id, max: 1 }
              : { choice: id, max: Math.max(2, f.max) });
            const isOpen = open === s.id;
            const mine = warnings.filter(w => w.stepId === s.id);
            const stops = mine.filter(w => w.level === 'stop').length;
            return (
              <div key={s.id} data-testid="combo-step" draggable={!isOpen && !readOnly}
                onDragStart={e => { setDragStep(si); beginDrag(e, si); }} onDragOver={e => dragOver(e, si, overStep, setOverStep)}
                onDrop={e => { e.preventDefault(); if (dragStep !== null) moveStep(dragStep, si); setDragStep(null); setOverStep(null); }}
                onDragEnd={() => { setDragStep(null); setOverStep(null); }}
                style={{ border:`1.5px solid ${overStep === si && dragStep !== null ? 'var(--acc)' : stops ? 'var(--red-b)' : 'var(--bdr)'}`, borderRadius:12, background:'var(--bg2)', opacity: dragStep === si ? .4 : 1 }}>

                {/* The step's head: its number, name and rule in words. Tap to open. */}
                <div style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 12px', cursor:'pointer' }} onClick={() => openStep(isOpen ? null : s.id)}>
                  <span style={{ fontSize:10, color:'var(--t4)', cursor:'grab', flexShrink:0 }} title="Drag to reorder">⠿</span>
                  <span style={{ width:22, height:22, borderRadius:'50%', background:'var(--acc)', color:'#0b0c10', fontSize:11, fontWeight:800, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>{si + 1}</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.name}</div>
                    <div style={{ fontSize:10.5, color:'var(--t4)', marginTop:1 }}>{STEP_KIND_WORDS[s.selectionType]} · {s.products.length} product{s.products.length === 1 ? '' : 's'} · {PRICING_WORDS[s.pricing]}</div>
                  </div>
                  <div style={{ display:'flex', gap:3, flexShrink:0 }} onClick={e => e.stopPropagation()}>
                    <button onClick={() => moveStep(si, si - 1)} disabled={si === 0} aria-label="Move this step up" style={{ width:26, height:26, borderRadius:6, border:'1px solid var(--bdr)', background:'var(--bg3)', color: si === 0 ? 'var(--t4)' : 'var(--t2)', cursor: si === 0 ? 'default' : 'pointer', fontSize:11, opacity: si === 0 ? .4 : 1 }}>▲</button>
                    <button onClick={() => moveStep(si, si + 1)} disabled={si === steps.length - 1} aria-label="Move this step down" style={{ width:26, height:26, borderRadius:6, border:'1px solid var(--bdr)', background:'var(--bg3)', color: si === steps.length - 1 ? 'var(--t4)' : 'var(--t2)', cursor: si === steps.length - 1 ? 'default' : 'pointer', fontSize:11, opacity: si === steps.length - 1 ? .4 : 1 }}>▼</button>
                    <button onClick={() => removeStep(s)} aria-label="Remove this step" style={{ width:26, height:26, borderRadius:6, border:'1px solid var(--red-b)', background:'var(--red-d)', color:'var(--red)', cursor:'pointer', fontSize:13 }}>×</button>
                  </div>
                </div>
                {!isOpen && mine.length > 0 && <div style={{ padding:'0 12px 8px' }}>{mine.map((w, i) => note(w.level, w.words, i))}</div>}

                {isOpen && (
                  <div style={{ padding:'0 12px 12px', borderTop:'1px solid var(--bdr)' }}>
                    <div style={{ marginTop:10 }}>
                      <span style={lbl}>Step name</span>
                      <input style={inp} aria-label="Step name" maxLength={60} value={nameDraft[s.id] ?? s.name}
                        onChange={e => setNameDraft(d => ({ ...d, [s.id]: e.target.value }))} onBlur={() => commitName(s)}
                        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} placeholder="Like Pick 5 pizzas" />
                    </div>

                    {/* How customers choose: the three kinds an option group has, in the same words */}
                    <div style={{ marginTop:12 }}>
                      <span style={lbl}>How customers choose</span>
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6 }}>
                        {KINDS.map(k => {
                          const on = f.choice === k.id;
                          return (
                            <button key={k.id} type="button" data-testid={`combo-kind-${k.id}`}
                              onClick={() => { if (!on) setStep(s.id, x => stepWithForm(x, { ...f, ...toKind(k.id) })); }}
                              style={{ padding:'8px 8px 7px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', textAlign:'left', border:`2px solid ${on ? 'var(--acc)' : 'var(--bdr)'}`, background: on ? 'var(--acc-d)' : 'var(--bg3)' }}>
                              <div style={{ fontSize:11, fontWeight:700, color: on ? 'var(--acc)' : 'var(--t2)', lineHeight:1.25 }}>{STEP_KIND_WORDS[k.id]}</div>
                              <div style={{ fontSize:9.5, color:'var(--t4)', lineHeight:1.35, marginTop:2 }}>{k.hint}</div>
                            </button>
                          );
                        })}
                      </div>
                      <div style={{ display:'flex', gap:14, flexWrap:'wrap', alignItems:'flex-end', marginTop:10 }}>
                        {f.choice !== 'quantity' && (
                          <label style={{ display:'flex', alignItems:'center', gap:7, fontSize:12, color:'var(--t1)', cursor:'pointer', minHeight:32 }}>
                            <input type="checkbox" data-testid="combo-must-choose" checked={f.mustChoose} onChange={e => setStep(s.id, x => stepWithForm(x, { ...f, mustChoose: e.target.checked, min: e.target.checked ? Math.max(1, f.min) : 0 }))} />
                            Customers must choose
                          </label>
                        )}
                        {f.choice === 'multiple' && f.mustChoose && (
                          <div><span style={lbl}>At least</span><NumBox label="At least" value={f.min || 1} min={1} max={f.max >= UNLIMITED ? 98 : f.max} onCommit={v => setStep(s.id, x => stepWithForm(x, { ...f, min: v }))} /></div>
                        )}
                        {f.choice === 'multiple' && f.max < UNLIMITED && (
                          <div><span style={lbl}>Up to</span><NumBox label="Up to" value={f.max} min={1} max={98} onCommit={v => setStep(s.id, x => stepWithForm(x, { ...f, max: v }))} /></div>
                        )}
                        {f.choice === 'multiple' && (
                          <label style={{ display:'flex', alignItems:'center', gap:7, fontSize:12, color:'var(--t1)', cursor:'pointer', minHeight:32 }}>
                            <input type="checkbox" data-testid="combo-no-limit" checked={f.max >= UNLIMITED} onChange={e => setStep(s.id, x => stepWithForm(x, { ...f, max: e.target.checked ? UNLIMITED : 3 }))} /> As many as they like
                          </label>
                        )}
                        {f.choice === 'quantity' && (
                          <div><span style={lbl}>How many</span><NumBox label="How many" value={f.max} min={1} max={98} onCommit={v => setStep(s.id, x => stepWithForm(x, { ...f, max: v }))} /></div>
                        )}
                      </div>
                      {f.choice === 'multiple' && (
                        <label style={{ display:'flex', alignItems:'center', gap:7, fontSize:12, color:'var(--t1)', cursor:'pointer', marginTop:8, minHeight:28 }}>
                          <input type="checkbox" data-testid="combo-once-each" checked={f.onceEach} onChange={e => setStep(s.id, x => stepWithForm(x, { ...f, onceEach: e.target.checked }))} />
                          Each product only once
                        </label>
                      )}
                      <div data-testid="combo-step-sentence" style={{ marginTop:8, fontSize:12.5, fontWeight:700, color:'var(--t1)' }}>{stepSentence(s)}</div>
                    </div>

                    {/* Part of the set price, or keeps its price */}
                    <div style={{ marginTop:12 }}>
                      <span style={lbl}>What a pick costs</span>
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
                        {[[PRICING_SET, 'Nothing more. A product can carry a price bump.'], [PRICING_OWN, 'Its own menu price, on top of the set price.']].map(([id, hint]) => {
                          const on = s.pricing === id;
                          return (
                            <button key={id} type="button" data-testid={`combo-pricing-${id}`} onClick={() => { if (!on && keepPricesOk(s, id)) setStep(s.id, x => ({ ...x, pricing: id })); }}
                              style={{ padding:'8px 9px 7px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', textAlign:'left', border:`2px solid ${on ? 'var(--acc)' : 'var(--bdr)'}`, background: on ? 'var(--acc-d)' : 'var(--bg3)' }}>
                              <div style={{ fontSize:11.5, fontWeight:700, color: on ? 'var(--acc)' : 'var(--t2)' }}>{PRICING_WORDS[id]}</div>
                              <div style={{ fontSize:9.5, color:'var(--t4)', lineHeight:1.35, marginTop:2 }}>{hint}</div>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* The products of this step */}
                    <div style={{ marginTop:12 }}>
                      <span style={lbl}>Products in this step ({s.products.length})</span>
                      {mine.map((w, i) => note(w.level, w.words, i))}
                      {s.products.map((p, pi) => {
                        const row = rowsById.get(p.itemId);
                        const parent = row ? rowsById.get(row.parentId) : null;
                        const key = `${s.id}|${p.itemId}`;
                        const gone = !row || row.archived;
                        return (
                          <div key={p.itemId} data-testid="combo-step-product" draggable={!readOnly}
                            onDragStart={e => { e.stopPropagation(); setDragProd({ step: s.id, i: pi }); beginDrag(e, pi); }}
                            onDragOver={e => { e.stopPropagation(); dragOver(e, pi, overProd, setOverProd); }}
                            onDrop={e => { e.preventDefault(); e.stopPropagation(); if (dragProd && dragProd.step === s.id) moveProduct(s, dragProd.i, pi); setDragProd(null); setOverProd(null); }}
                            onDragEnd={() => { setDragProd(null); setOverProd(null); }}
                            style={{ display:'grid', gridTemplateColumns: s.pricing === PRICING_SET ? '14px 1fr 86px 26px' : '14px 1fr auto 26px', gap:6, alignItems:'center', padding:'6px 8px', marginBottom:4, borderRadius:8,
                              border:`1px solid ${overProd === pi && dragProd?.step === s.id ? 'var(--acc)' : 'var(--bdr)'}`, background:'var(--bg3)', opacity: gone ? .6 : 1 }}>
                            <span style={{ fontSize:10, color:'var(--t4)', cursor:'grab' }}>⠿</span>
                            <div style={{ minWidth:0 }}>
                              <div style={{ fontSize:12, fontWeight:600, color: gone ? 'var(--red)' : 'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', textDecoration: gone ? 'line-through' : 'none' }}>
                                {row ? (parent ? `${nameOf(parent)}, ${nameOf(row)}` : nameOf(row)) : 'Not on the menu any more'}
                              </div>
                              {row && !gone && <div style={{ fontSize:10, color:'var(--t4)' }}>{(sizesOf.get(row.id) || []).length ? 'Any size, asked on the POS · ' : ''}{priceWords(row)} on its own</div>}
                            </div>
                            {s.pricing === PRICING_SET ? (
                              <div style={{ position:'relative' }} title="Price bump: added to the set price when this product is picked. Blank = none.">
                                <span style={{ position:'absolute', left:7, top:'50%', transform:'translateY(-50%)', fontSize:10.5, color:'var(--t4)', fontWeight:700 }}>+{currencySymbol()}</span>
                                <input type="number" step="0.01" min="0" aria-label={`Price bump for ${nameOf(row)}`} {...selectOnFocus}
                                  style={{ ...inp, paddingLeft:24, padding:'5px 6px 5px 24px', fontSize:12, color:'var(--acc)' }} placeholder="0.00"
                                  value={bumpDraft[key] ?? (p.bump || '')} onChange={e => setBumpDraft(d => ({ ...d, [key]: e.target.value }))}
                                  onBlur={() => commitBump(s, p.itemId)} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
                              </div>
                            ) : (
                              <span style={{ fontSize:11, fontWeight:700, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>{row && !gone ? priceWords(row) : ''}</span>
                            )}
                            <button onClick={() => setStep(s.id, x => ({ ...x, products: x.products.filter(q => q.itemId !== p.itemId) }))} aria-label={`Take ${nameOf(row)} out of this step`}
                              style={{ width:26, height:28, borderRadius:6, border:'1px solid var(--red-b)', background:'var(--red-d)', color:'var(--red)', cursor:'pointer', fontSize:13 }}>×</button>
                          </div>
                        );
                      })}

                      {/* Add products: found from the menu, one button each. The box only narrows the list. */}
                      <div style={{ marginTop:8, border:'1px solid var(--bdr)', borderRadius:10, overflow:'hidden' }}>
                        <div style={{ position:'relative', borderBottom:'1px solid var(--bdr)' }}>
                          <span style={{ position:'absolute', left:9, top:'50%', transform:'translateY(-50%)', color:'var(--t4)', display:'flex' }}><Icon name="search" size={13} /></span>
                          <input style={{ ...inp, border:'none', borderRadius:0, paddingLeft:28, fontSize:12 }} value={search} onChange={e => setSearch(e.target.value)} placeholder="Add products: find by name or category" aria-label="Find products to add" autoComplete="off" />
                        </div>
                        <div data-testid="combo-product-list" style={{ maxHeight:210, overflowY:'auto', padding:4 }}>
                          {candidates.length === 0 && <div style={{ padding:'14px 8px', textAlign:'center', fontSize:11, color:'var(--t4)' }}>Nothing matches “{search}”.</div>}
                          {candidates.map(c => {
                            const has = s.products.some(p => p.itemId === c.row.id);
                            return (
                              <div key={c.row.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 8px', paddingLeft: c.size ? 22 : 8, borderRadius:7 }}>
                                <div style={{ flex:1, minWidth:0 }}>
                                  <div style={{ fontSize:12, fontWeight: c.size ? 500 : 600, color:'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.size ? `↳ ${nameOf(c.row)} only` : nameOf(c.row)}</div>
                                  {!c.size && <div style={{ fontSize:10, color:'var(--t4)' }}>{catName.get(c.row.cat) || 'No category'} · {priceWords(c.row)}{(sizesOf.get(c.row.id) || []).length ? ' · any size' : ''}</div>}
                                </div>
                                <button disabled={has} data-testid="combo-add-product" onClick={() => setStep(s.id, x => ({ ...x, products: [...x.products, { itemId: c.row.id, bump: 0 }] }))}
                                  style={{ height:28, padding:'0 12px', borderRadius:7, cursor: has ? 'default' : 'pointer', fontFamily:'inherit', fontSize:11, fontWeight:800, flexShrink:0,
                                    border:`1px solid ${has ? 'var(--bdr)' : 'var(--acc-b)'}`, background: has ? 'transparent' : 'var(--acc-d)', color: has ? 'var(--t4)' : 'var(--acc)' }}>{has ? 'In this step' : '+ Add'}</button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {!readOnly && <button onClick={addStep} data-testid="combo-add-step" style={{ height:40, borderRadius:10, cursor:'pointer', fontFamily:'inherit', fontSize:13, fontWeight:800, border:'1.5px dashed var(--acc-b)', background:'var(--acc-d)', color:'var(--acc)' }}>+ Add a step</button>}
        </>
      )}
    </div>
  );
}
