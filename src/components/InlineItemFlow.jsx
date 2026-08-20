import { useState, useMemo, useEffect, useRef } from 'react';
import { useStore } from '../store';
import { ALLERGENS } from '../data/seed';
import { money } from '../lib/currency';
import { orderOptionFlow, flowOrderedMods } from '../lib/optionFlow';

// ══════════════════════════════════════════════════════════════════════════════
// InlineItemFlow — replaces ProductModal for POS
// Shows variants as big tap-buttons in the center panel, then modifiers below
// Animates between steps with a slide transition
// ══════════════════════════════════════════════════════════════════════════════

// v5.5.189: resolve the menu item ID for a modifier option.
// Options created from sub-items after v5.5.189 carry an explicit `itemId`.
// For older options or manually-created ones, fall back to name matching.
function resolveOptItemId(opt, menuItems) {
  if (!opt || !menuItems) return null;
  if (opt.itemId) return opt.itemId;
  const name = (opt.name || opt.label || '').toLowerCase();
  if (!name) return null;
  const match = menuItems.find(i =>
    i.type === 'subitem' && !i.archived &&
    (i.menuName || i.name || '').toLowerCase() === name
  );
  return match?.id || null;
}

// v5.7.27 — edit mode: the SAME flow reconfigures an EXISTING order line
// (booking pre-order lines seated bare, e.g. a steak with no cooking temp).
// mode='edit' + basePriceOverride (the line's own unit price — 0.00 on prepay
// package lines, so only modifier prices show as +extras) + lockedQty (the
// line's qty; the stepper hides — edit never changes quantity). onConfirm gets
// the same (targetItem, mods, cfg, opts) shape; the caller replaces the line
// in place instead of adding.
export default function InlineItemFlow({ item, menuItems, activeAllergens = [], onConfirm, onCancel, mode = 'add', basePriceOverride = null, lockedQty = null }) {
  const { modifierGroupDefs, instructionGroupDefs, eightySixIds, dailyCounts } = useStore();

  // ── Resolve variant children from menuItems ──────────────────────────────
  const variantChildren = useMemo(() =>
    (menuItems || []).filter(v => v.parentId === item.id && !v.archived)
      .sort((a,b) => (a.sortOrder??999) - (b.sortOrder??999)),
    [item.id, menuItems]
  );
  const isVariant = item.type === 'variants' || variantChildren.length > 0;

  // ── Modifier groups resolution ────────────────────────────────────────────
  const buildModGroups = (targetItem) => {
    const all = [];
    if (targetItem?.assignedModifierGroups?.length) {
      targetItem.assignedModifierGroups.forEach(ag => {
        const def = modifierGroupDefs?.find(d => d.id === ag.groupId);
        if (def) {
          // Rule: inherit min/max from group definition only — no per-item override
          // This keeps one source of truth: the Modifier Groups editor
          all.push({ ...def, required: (def.min ?? 0) > 0 });
        }
      });
    }
    if (targetItem?.modifierGroups?.length) {
      targetItem.modifierGroups.forEach(g => {
        if (g.options?.length) all.push({ ...g, label: g.name || g.label });
      });
    }
    return all;
  };

  const buildInstGroups = (targetItem) =>
    (targetItem?.assignedInstructionGroups || [])
      .map(e => typeof e === 'string' ? { groupId: e } : e)
      .map(a => {
        const def = instructionGroupDefs?.find(g => g.id === a.groupId);
        return def ? { ...def, min: a.min ?? def.min ?? 0 } : null;
      })
      .filter(Boolean);

  // ── State ─────────────────────────────────────────────────────────────────
  const [step, setStep]               = useState(isVariant ? 'variant' : 'modifiers');
  const [selectedVariant, setSelectedVariant] = useState(null);
  const [selections, setSelections]   = useState({});    // modifierId → option/[options]
  const [instSelections, setInstSel]  = useState({});    // instructionGroupId → string
  const [requireErr, setRequireErr] = useState(false);
  const [qty, setQty]                 = useState(lockedQty || 1);
  const [notes, setNotes]             = useState('');
  const [animDir, setAnimDir]         = useState('in');  // 'in' | 'out'
  const prevStep = useRef(null);

  // When variant is picked, transition to modifiers step
  const pickVariant = (variant) => {
    setAnimDir('out');
    setTimeout(() => {
      setSelectedVariant(variant);
      setSelections({});
      setInstSel({});
      // variant IS the full child item — check its own mods AND parent mods
      const hasMods = buildModGroups(variant).length > 0 || buildInstGroups(variant).length > 0
                   || buildModGroups(item).length > 0    || buildInstGroups(item).length > 0;
      if (!hasMods) {
        const displayName = `${item.menuName || item.menu_name || item.name} — ${variant.menuName || variant.menu_name || variant.name || variant.label}`;
        onConfirm(variant, [], null, {
          notes: '', qty, linePrice: (variant.pricing?.base ?? variant.price ?? 0) * qty, displayName
        });
        return;
      }
      setStep('modifiers');
      setAnimDir('in');
    }, 180);
  };

  // After picking a variant, selectedVariant IS the full child menu item.
  // _childItem is a legacy field that doesn't exist — use selectedVariant directly.
  const activeItem = selectedVariant || (step === 'modifiers' && !isVariant ? item : null);
  const modGroups = useMemo(() => {
    if (!activeItem) return buildModGroups(item);
    const childMods = buildModGroups(activeItem);
    // Child variant has its own modifier groups — use those
    // Otherwise fall back to parent item's modifier groups
    return childMods.length > 0 ? childMods : buildModGroups(item);
  }, [activeItem, item, modifierGroupDefs]);
  const instGroups = useMemo(() => {
    if (!activeItem) return buildInstGroups(item);
    const childInst = buildInstGroups(activeItem);
    return childInst.length > 0 ? childInst : buildInstGroups(item);
  }, [activeItem, item, instructionGroupDefs]);

  const missingRequired = useMemo(() => {
    const missing = [];
    // Required instruction groups must have a pick
    instGroups.forEach(g => {
      const isReq = g.required || (g.min || 0) > 0;
      if (isReq && !instSelections[g.id]) missing.push({ ...g, _isInst: true });
    });
    modGroups.forEach(g => {
      const isRequired = g.required || (g.min || 0) > 0;
      const sel = selections[g.id];
      if (isRequired) {
        // Quantity mode: sel is { optionId: qty }, count total qty
        if (g.selectionType === 'quantity') {
          const totalQty = Object.values(sel || {}).reduce((s, n) => s + (n || 0), 0);
          if (totalQty < (g.min || 1)) { missing.push(g); return; }
        } else if (Array.isArray(sel) ? sel.length < (g.min || 1) : !sel) {
          missing.push(g); return;
        }
      }
      // Check required nested sub-group
      const selOpt = !Array.isArray(sel) && g.selectionType !== 'quantity' ? sel : null;
      if (selOpt?.subGroupId) {
        const subDef = modifierGroupDefs?.find(d => d.id === selOpt.subGroupId);
        if (subDef && ((subDef.min || 0) > 0)) {
          const subSel = selections[subDef.id];
          const subFilled = Array.isArray(subSel) ? subSel.length >= (subDef.min || 1) : !!subSel;
          if (!subFilled) missing.push({ ...subDef, required: true, _isNested: true });
        }
      }
    });
    return missing;
  }, [modGroups, selections, modifierGroupDefs, instGroups, instSelections]);

  const canAdd = step === 'variant' ? false : missingRequired.length === 0;

  // v5.6.69 — NUMERIC stock gate for modifier options (the "Box of 3" oversell:
  // an option whose linked item had 1 remaining could be added 3× — the option
  // checks were 86-boolean only, so nothing blocked until remaining hit 0).
  // Aggregate this line's need per RESOLVED item id (box picks × line qty) and
  // refuse the add when it exceeds what's left. dailyCounts.remaining is
  // already net of lines in the open check (the store decrements at add).
  const stockShort = useMemo(() => {
    const need = {};   // resolved itemId → units this line consumes
    modGroups.forEach(g => {
      const sel = selections[g.id];
      if (!sel) return;
      if (g.selectionType === 'quantity') {
        Object.entries(sel).forEach(([id, q]) => {
          if (!(q > 0)) return;
          const opt = (g.options || []).find(o => (o.id || o.name) === id);
          const rid = opt?.itemId || resolveOptItemId(opt, menuItems);
          if (rid) need[rid] = (need[rid] || 0) + q;
        });
      } else {
        (Array.isArray(sel) ? sel : [sel]).filter(Boolean).forEach(m => {
          const rid = m.itemId || resolveOptItemId(m, menuItems);
          if (rid) need[rid] = (need[rid] || 0) + 1;
        });
      }
    });
    for (const [rid, units] of Object.entries(need)) {
      const stock = dailyCounts?.[rid];
      const banned = (eightySixIds || []).includes(rid);
      const want = units * qty;
      if (banned || (stock && Number.isFinite(Number(stock.remaining)) && want > Number(stock.remaining))) {
        const mi = (menuItems || []).find(i => i.id === rid);
        return { name: mi?.menuName || mi?.name || 'that option', have: banned ? 0 : Number(stock.remaining), want };
      }
    }
    return null;
  }, [modGroups, selections, qty, dailyCounts, eightySixIds, menuItems]);

  const extraCost = modGroups.reduce((total, group) => {
    const cur = selections[group.id];
    if (!cur) return total;
    if (group.selectionType === 'quantity') {
      // cur is { optionId: qty }
      return total + Object.entries(cur).reduce((s, [id, qty]) => {
        const opt = (group.options||[]).find(o => (o.id||o.name) === id);
        return s + (opt?.price || 0) * (qty || 0);
      }, 0);
    }
    const arr = Array.isArray(cur) ? cur : (cur ? [cur] : []);
    return total + arr.reduce((s, m) => s + (m?.price || 0), 0);
  }, 0);
  // v5.7.27 edit mode: the LINE's unit price is the base (prepay pre-order
  // lines are 0.00 — food already paid), never the menu item's price, and a
  // variant pick doesn't reprice the base either.
  const basePrice = basePriceOverride != null
    ? basePriceOverride
    : selectedVariant
      ? (selectedVariant.pricing?.base ?? selectedVariant.price ?? 0)
      : (item.pricing?.base ?? item.price ?? 0);
  const total = (basePrice + extraCost) * qty;

  const handleAdd = () => {
    if (!canAdd) { setRequireErr(true); setTimeout(() => setRequireErr(false), 3000); return; }
    if (stockShort) return;   // v5.6.69 — the button already says what's short
    // v5.5.964: the line's mods commit in FLOW order (same order the panel shows),
    // so the check rail / KDS / receipts / kitchen tickets follow the Back Office
    // flow instead of always printing cooking preferences last.
    const buildGroupMods = (gid) => {
      const val = selections[gid];
      if (!val) return [];
      const group = modGroups.find(g => g.id === gid);
      // Quantity mode: { optionId: qty } → expand to flat mods with qty label
      if (group?.selectionType === 'quantity') {
        return Object.entries(val).filter(([,q]) => q > 0).map(([id, qty]) => {
          const opt = (group.options||[]).find(o => (o.id||o.name) === id);
          const label = opt?.name || opt?.label || id;
          // v5.5.189: resolve itemId so daily count decrements for sub-items
          const resolvedItemId = opt?.itemId || resolveOptItemId(opt, menuItems);
          return {
            // id + name preserved so reports can attribute this option back to
            // its menu_item row (e.g. count "Bueno Filled" sales when sold as
            // part of "Box of 3"). label is what kitchen tickets / receipts
            // print; id/name are the audit trail.
            id: opt?.id || id,
            name: opt?.name || label,
            itemId: resolvedItemId,
            groupLabel: group.name || group.label,
            label: qty > 1 ? `${label} ×${qty}` : label,
            price: (opt?.price || 0) * qty,
            qty,
          };
        });
      }
      const arr = Array.isArray(val) ? val : [val];
      return arr.filter(Boolean).map(m => {
        // v5.5.189: resolve itemId so daily count decrements for sub-items
        const resolvedItemId = m.itemId || resolveOptItemId(m, menuItems);
        return {
          // Same audit-trail fields as quantity mode above.
          id: m.id || null,
          name: m.name || m.label || '',
          itemId: resolvedItemId,
          groupLabel: group?.name || group?.label,
          label: m.name || m.label || '',
          price: m.price || 0,
        };
      });
    };
    const buildInst = (gid) => {
      const val = instSelections[gid];
      if (!val) return null;
      const g = instGroups.find(ig => ig.id === gid);
      return { groupLabel: g?.name, label: val, price: 0, _instruction: true };
    };
    const mods = flowOrderedMods({
      order: item?.optionGroupOrder || item?.option_group_order || null,
      modGroups, instGroups,
      modKeys: Object.keys(selections), instKeys: Object.keys(instSelections),
      buildModGroup: buildGroupMods, buildInst,
    });
    const variantPart = selectedVariant
      ? ` — ${selectedVariant.menuName || selectedVariant.name || selectedVariant.label}`
      : '';
    const displayName = `${item.menuName || item.menu_name || item.name}${variantPart}`;
    const targetItem = selectedVariant || item;
    onConfirm(targetItem, mods, null, { notes: notes.trim(), qty, linePrice: total, displayName });
  };

  const toggleSingle = (gid, opt) =>
    setSelections(s => ({ ...s, [gid]: s[gid]?.id === opt.id ? null : opt }));
  const addMulti    = (gid, opt, max) =>
    setSelections(s => { const cur = s[gid] || []; return cur.length >= max ? s : { ...s, [gid]: [...cur, { ...opt, _uid: Date.now() + Math.random() }] }; });
  const removeMulti = (gid, uid) =>
    setSelections(s => ({ ...s, [gid]: (s[gid] || []).filter(o => o._uid !== uid) }));
  const toggleInst  = (gid, val) =>
    setInstSel(s => ({ ...s, [gid]: s[gid] === val ? null : val }));

  const flagged = (item.allergens || []).filter(a => activeAllergens.includes(a));

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden', background:'var(--bg)' }}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{ padding:'14px 18px 12px', borderBottom:'1px solid var(--bdr)', background:'var(--bg1)', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'flex-start', gap:10 }}>
          <button onClick={onCancel} style={{ width:34, height:34, borderRadius:10, border:'1px solid var(--bdr2)', background:'var(--bg3)', color:'var(--t2)', cursor:'pointer', fontSize:16, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>←</button>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:17, fontWeight:800, color:'var(--t1)', letterSpacing:'-.01em' }}>{item.menuName || item.name}</div>
            {item.description && <div style={{ fontSize:12, color:'var(--t3)', marginTop:2, lineHeight:1.4 }}>{item.description}</div>}
          </div>
          {step === 'modifiers' && (
            <div style={{ fontFamily:'var(--font-mono)', fontSize:16, fontWeight:800, color:'var(--acc)', flexShrink:0 }}>
              {money(total)}
            </div>
          )}
        </div>

        {/* Allergen flags */}
        {(item.allergens?.length > 0 || flagged.length > 0) && (
          <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginTop:8 }}>
            {(item.allergens || []).map(a => {
              const al = ALLERGENS.find(x => x.id === a);
              const isActive = activeAllergens.includes(a);
              return (
                <span key={a} style={{ fontSize:10, padding:'2px 7px', borderRadius:6, fontWeight:500,
                  background: isActive ? 'var(--red-d)' : 'var(--bg3)',
                  border: `1px solid ${isActive ? 'var(--red-b)' : 'var(--bdr)'}`,
                  color: isActive ? 'var(--red)' : 'var(--t4)' }}>
                  {al?.icon} {al?.label}
                </span>
              );
            })}
          </div>
        )}

        {/* Step breadcrumb */}
        {isVariant && step === 'modifiers' && (
          <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:10 }}>
            <button onClick={() => { setAnimDir('out'); setTimeout(() => { setStep('variant'); setSelectedVariant(null); setSelections({}); setInstSel({}); setAnimDir('in'); }, 180); }}
              style={{ display:'flex', alignItems:'center', gap:5, padding:'4px 10px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg3)', cursor:'pointer', fontFamily:'inherit' }}>
              <span style={{ fontSize:11, color:'var(--t4)' }}>←</span>
              <span style={{ fontSize:11, fontWeight:600, color:'var(--grn)' }}>
                {selectedVariant?.menuName || selectedVariant?.name || selectedVariant?.label}
              </span>
            </button>
            <span style={{ fontSize:11, color:'var(--t4)' }}>→ Choose options</span>
          </div>
        )}
      </div>

      {/* ── Content ────────────────────────────────────────────────────── */}
      <div style={{ flex:1, overflowY:'auto', padding:'16px' }}>
        {step === 'variant' && (
          <VariantStep
            item={item}
            variantChildren={variantChildren}
            onPick={pickVariant}
          />
        )}
        {step === 'modifiers' && (
          <ModifierStep
            modGroups={modGroups}
            instGroups={instGroups}
            flowOrder={item?.optionGroupOrder || item?.option_group_order || null}
            allModDefs={modifierGroupDefs}
            menuItems={menuItems}
            eightySixIds={eightySixIds}
            dailyCounts={dailyCounts}
            selections={selections}
            instSelections={instSelections}
            qty={qty}
            notes={notes}
            missingRequired={requireErr ? missingRequired.map(g => g.id) : []}
            onToggleSingle={toggleSingle}
            onAddMulti={addMulti}
            onRemoveMulti={removeMulti}
            onQtyChange={(gid, id, delta) => setSelections(s => {
              const prev = (s[gid] || {})[id] || 0;
              const next = Math.max(0, prev + delta);
              const updated = { ...(s[gid] || {}), [id]: next };
              if (next === 0) delete updated[id];
              return { ...s, [gid]: updated };
            })}
            onToggleInst={toggleInst}
            onQty={setQty}
            onNotes={setNotes}
          />
        )}
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      {step === 'modifiers' && (
        <div style={{ padding:'12px 16px', borderTop:'1px solid var(--bdr)', background:'var(--bg1)', flexShrink:0 }}>
          {/* Required field error */}
          {requireErr && missingRequired.length > 0 && (
            <div style={{ marginBottom:10, padding:'10px 12px', background:'var(--red-d)', border:'1px solid var(--red-b)', borderRadius:10, display:'flex', alignItems:'flex-start', gap:8 }}>
              <span style={{ fontSize:16, flexShrink:0 }}>⚠</span>
              <div>
                <div style={{ fontSize:12, fontWeight:700, color:'var(--red)', marginBottom:2 }}>Required options needed</div>
                <div style={{ fontSize:11, color:'var(--red)', opacity:.85 }}>
                  Please choose: {missingRequired.map(g => g.name || g.label).join(', ')}
                </div>
              </div>
            </div>
          )}
          {/* v5.7.27: edit mode never changes quantity — the stepper hides */}
          {lockedQty == null && (
            <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:10 }}>
              <span style={{ fontSize:12, color:'var(--t3)' }}>Qty</span>
              <div style={{ display:'flex', gap:8, alignItems:'center', marginLeft:'auto' }}>
                <button onClick={() => setQty(q => Math.max(1, q-1))} style={{ width:32, height:32, borderRadius:'50%', border:'1px solid var(--bdr2)', background:'transparent', color:'var(--t2)', fontSize:18, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}>−</button>
                <span style={{ fontSize:16, fontWeight:700, minWidth:24, textAlign:'center' }}>{qty}</span>
                <button onClick={() => setQty(q => q+1)} style={{ width:32, height:32, borderRadius:'50%', border:'1px solid var(--bdr2)', background:'transparent', color:'var(--t2)', fontSize:18, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}>+</button>
              </div>
            </div>
          )}
          <button
            onClick={handleAdd}
            className="btn btn-acc"
            style={{ width:'100%', height:52, fontSize:16, fontWeight:800, borderRadius:14,
              background: (canAdd && !stockShort) ? 'var(--acc)' : 'var(--red)',
              opacity: 1, cursor: 'pointer' }}>
            {!canAdd ? `Choose required options first`
              : stockShort ? `Only ${stockShort.have} × ${stockShort.name} left`
              : mode === 'edit'
                ? (extraCost > 0 ? `Set options · +${money(extraCost * qty)}` : 'Set options')
                : `Add to order · ${money(total)}`}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Variant step: large tap-friendly buttons ──────────────────────────────────
function VariantStep({ item, variantChildren, onPick }) {
  const label = item.variantLabel || 'Size';
  return (
    <div>
      <div style={{ fontSize:12, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:12 }}>
        Choose {label}
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(140px,1fr))', gap:10 }}>
        {variantChildren.map(v => {
          const price = v.pricing?.base ?? v.price ?? 0;
          return (
            <button key={v.id} onClick={() => onPick(v)}
              style={{ display:'flex', flexDirection:'column', alignItems:'flex-start', padding:'16px 16px 14px',
                borderRadius:16, border:'2px solid var(--bdr)', background:'var(--bg2)',
                cursor:'pointer', fontFamily:'inherit', transition:'all .12s',
                minHeight:90, position:'relative', overflow:'hidden' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor='var(--acc)'; e.currentTarget.style.background='var(--acc-d)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor='var(--bdr)'; e.currentTarget.style.background='var(--bg2)'; }}
            >
              <div style={{ fontSize:15, fontWeight:700, color:'var(--t1)', marginBottom:6 }}>
                {v.menuName || v.name}
              </div>
              <div style={{ fontSize:18, fontWeight:900, color:'var(--acc)', fontFamily:'var(--font-mono)', marginTop:'auto' }}>
                {money(price)}
              </div>
              {v.allergens?.length > 0 && (
                <div style={{ fontSize:10, color:'var(--t4)', marginTop:4 }}>
                  ⚠ {v.allergens.join(', ')}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Modifier step: sequential groups ─────────────────────────────────────────
function ModifierStep({ modGroups, instGroups, flowOrder = null, allModDefs, menuItems, eightySixIds = [], dailyCounts = {}, selections, instSelections, qty, notes, missingRequired = [], onToggleSingle, onAddMulti, onRemoveMulti, onQtyChange, onToggleInst, onQty, onNotes }) {
  // Resolve image for a modifier option: option's own image > matching sub-item image
  const resolveOptImage = (opt) => {
    if (opt.image) return opt.image;
    if (!menuItems) return null;
    const name = opt.name || opt.label || '';
    const match = menuItems.find(i =>
      i.type === 'subitem' &&
      !i.archived &&
      (i.menuName || i.name || '').toLowerCase() === name.toLowerCase()
    );
    return match?.image || null;
  };
  const hasContent = modGroups.length > 0 || instGroups.length > 0;
  if (!hasContent) {
    return (
      <div style={{ textAlign:'center', padding:'32px 0', color:'var(--t3)', fontSize:13 }}>
        No options for this item — use the Add to order button below.
      </div>
    );
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:20 }}>
      {/* v5.5.948 — ONE ordered flow (lib/optionFlow.js): the Back Office Flow tab's
          drag order interleaves instruction + modifier groups; with no saved order,
          instructions come first (the v5.5.915/947 rule). */}
      {orderOptionFlow(flowOrder, modGroups, instGroups).map(entry => {
        if (entry.kind === 'inst') {
          const g = entry.g;
          const sel = instSelections[g.id];
          return (
            <div key={g.id}>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
                <span style={{ fontSize:12, fontWeight:800, color:'var(--t1)', textTransform:'uppercase', letterSpacing:'.06em' }}>{g.name}</span>
                <span style={{ fontSize:10, color:'var(--t4)' }}>Preparation · no charge</span>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))', gap:8 }}>
                {(g.options || []).map(opt => (
                  <button key={opt} onClick={() => onToggleInst(g.id, opt)}
                    style={{ display:'flex', alignItems:'center', gap:10, padding:'12px 14px', borderRadius:12, cursor:'pointer', fontFamily:'inherit', textAlign:'left', transition:'all .1s',
                      border:`2px solid ${sel===opt ? 'var(--grn)' : 'var(--bdr)'}`,
                      background: sel===opt ? 'var(--grn-d)' : 'var(--bg2)' }}>
                    <div style={{ width:18, height:18, borderRadius:'50%', border:`2px solid ${sel===opt ? 'var(--grn)' : 'var(--bdr2)'}`, background: sel===opt ? 'var(--grn)' : 'transparent', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      {sel===opt && <div style={{ width:6, height:6, borderRadius:'50%', background:'#0b0c10' }}/>}
                    </div>
                    <span style={{ fontSize:13, fontWeight: sel===opt ? 700 : 400, color: sel===opt ? 'var(--grn)' : 'var(--t1)' }}>{opt}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        }
        const group = entry.g;
        const isRequired    = group.required || (group.min || 0) > 0;
        const isMissing     = missingRequired.includes(group.id);
        const maxPicks      = group.max >= 99 || !group.max ? 999 : group.max;
        const minPicks      = group.min || 0;
        const isQuantityMode = group.selectionType === 'quantity'; // same option multiple times
        const isMulti        = maxPicks > 1;
        const cur            = selections[group.id];
        // Total picks across all options
        const totalPicked    = isQuantityMode
          ? Object.values(cur || {}).reduce((s, n) => s + (n || 0), 0)
          : Array.isArray(cur) ? cur.length : (cur ? 1 : 0);
        const atMax          = isMulti && totalPicked >= maxPicks;

        return (
          <div key={group.id} style={{ padding: isMissing ? '10px 12px' : 0, borderRadius: isMissing ? 12 : 0, border: isMissing ? '2px solid var(--red-b)' : 'none', background: isMissing ? 'var(--red-d)' : 'transparent', transition: 'all .2s' }}>
            {/* Header */}
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
              <span style={{ fontSize:12, fontWeight:800, color:'var(--t1)', textTransform:'uppercase', letterSpacing:'.06em' }}>
                {group.name || group.label}
              </span>
              {isRequired ? (
                <span style={{ fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:6, background:'var(--red-d)', color:'var(--red)', border:'1px solid var(--red-b)' }}>
                  {/* Show exactly what's required */}
                  {minPicks > 0 && minPicks === maxPicks
                    ? `Pick exactly ${minPicks}`
                    : minPicks > 1
                      ? `Min ${minPicks}${maxPicks < 999 ? `, max ${maxPicks}` : ''}`
                      : 'Required'}
                </span>
              ) : (
                <span style={{ fontSize:10, color:'var(--t4)' }}>Optional</span>
              )}
              {!isRequired && isMulti && maxPicks < 999 && (
                <span style={{ fontSize:10, color:'var(--t4)' }}>· up to {maxPicks}</span>
              )}
              {/* Running tally */}
              {totalPicked > 0 && (
                <span style={{ fontSize:10, fontWeight:700, marginLeft:'auto',
                  color: minPicks > 0 && totalPicked >= minPicks && (totalPicked >= maxPicks || maxPicks >= 999) ? 'var(--grn)'
                       : minPicks > 0 && totalPicked >= minPicks ? 'var(--grn)'
                       : 'var(--acc)' }}>
                  {totalPicked}{maxPicks < 999 ? `/${maxPicks}` : ''} picked
                  {minPicks > 0 && totalPicked >= minPicks && ' ✓'}
                </span>
              )}
            </div>

            {/* QUANTITY MODE: +/- counter per option */}
            {isQuantityMode ? (
              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                {(group.options || []).map(opt => {
                  const id = opt.id || opt.label || opt.name;
                  const optQty = (cur || {})[id] || 0;
                  // v5.5.189: resolve sub-item and check 86'd / stock
                  const optItemId = resolveOptItemId(opt, menuItems);
                  const opt86 = optItemId && eightySixIds.includes(optItemId);
                  const optStock = optItemId && dailyCounts[optItemId];
                  // v5.6.69 — numeric cap: one more pick of this option costs
                  // (optQty+1) × line qty units of the linked item's stock.
                  const optFull = !!(optStock && Number.isFinite(Number(optStock.remaining))
                    && (optQty + 1) * qty > Number(optStock.remaining));
                  const canAdd = !opt86 && !optFull && (!atMax || optQty > 0); // can always reduce; add only under max, stock and not 86'd
                  const plusOff = atMax || opt86 || optFull;
                  const optImage = resolveOptImage(opt);

                  return (
                    <div key={id} style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', borderRadius:12, border:`2px solid ${opt86 ? 'var(--red-b)' : optQty > 0 ? 'var(--acc)' : 'var(--bdr)'}`, background: opt86 ? 'var(--bg5)' : optQty > 0 ? 'var(--acc-d)' : 'var(--bg2)', transition:'all .1s', opacity: opt86 ? 0.5 : 1 }}>
                      {/* Image — from option directly or inherited from matching sub-item */}
                      {optImage && (
                        <div style={{ width:40, height:40, borderRadius:8, overflow:'hidden', flexShrink:0 }}>
                          <img src={optImage} alt={opt.name||opt.label} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                        </div>
                      )}
                      {/* Name + price */}
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                          <span style={{ fontSize:13, fontWeight: optQty > 0 ? 700 : 400, color: opt86 ? 'var(--t4)' : optQty > 0 ? 'var(--acc)' : 'var(--t1)' }}>
                            {opt.name || opt.label}
                          </span>
                          {opt86 && <span style={{ fontSize:9, fontWeight:800, padding:'2px 5px', borderRadius:4, background:'var(--red-d)', color:'var(--red)', border:'1px solid var(--red-b)' }}>86'd</span>}
                          {optStock && !opt86 && optStock.remaining <= 3 && (
                            <span style={{ fontSize:9, fontWeight:700, padding:'2px 5px', borderRadius:4, background:'var(--wrn-d,#fff3cd)', color:'var(--wrn,#856404)', border:'1px solid var(--wrn-b,#ffc107)' }}>{optStock.remaining} left</span>
                          )}
                        </div>
                        {(opt.price || 0) > 0 && (
                          <div style={{ fontSize:11, color:'var(--t3)', fontFamily:'var(--font-mono)' }}>+{money(opt.price)} each</div>
                        )}
                      </div>
                      {/* Qty controls */}
                      <div style={{ display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
                        <button
                          onClick={() => onQtyChange(group.id, id, -1)}
                          disabled={optQty === 0}
                          style={{ width:32, height:32, borderRadius:8, border:`1.5px solid ${optQty>0?'var(--acc)':'var(--bdr)'}`, background:optQty>0?'var(--acc-d)':'var(--bg3)', color:optQty>0?'var(--acc)':'var(--t4)', cursor:optQty>0?'pointer':'default', fontSize:18, fontWeight:800, display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'inherit' }}>
                          −
                        </button>
                        <span style={{ fontSize:18, fontWeight:900, color: optQty > 0 ? 'var(--acc)' : 'var(--t4)', minWidth:24, textAlign:'center', fontFamily:'var(--font-mono)' }}>
                          {optQty}
                        </span>
                        <button
                          onClick={() => { if (canAdd && !atMax) onQtyChange(group.id, id, +1); }}
                          disabled={plusOff}
                          style={{ width:32, height:32, borderRadius:8, border:`1.5px solid ${plusOff?'var(--bdr)':'var(--acc)'}`, background:plusOff?'var(--bg3)':'var(--acc)', color:plusOff?'var(--t4)':'#0b0c10', cursor:plusOff?'not-allowed':'pointer', fontSize:18, fontWeight:800, display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'inherit', opacity:plusOff?0.4:1 }}>
                          +
                        </button>
                      </div>
                    </div>
                  );
                })}
                {/* Summary chips */}
                {totalPicked > 0 && (
                  <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginTop:4 }}>
                    {Object.entries(cur || {}).filter(([,q])=>q>0).map(([id, q]) => {
                      const opt = (group.options||[]).find(o=>(o.id||o.name)===id);
                      const label = opt?.name || opt?.label || id;
                      return <span key={id} style={{ fontSize:11, fontWeight:600, padding:'3px 10px', borderRadius:12, background:'var(--acc)', color:'#0b0c10' }}>{q > 1 ? `${label} ×${q}` : label}</span>;
                    })}
                  </div>
                )}
              </div>
            ) : (
              /* STANDARD MODE: checkbox (multi) or radio (single) */
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(172px,1fr))', gap:8 }}>
                {(group.options || []).map(opt => {
                  const id = opt.id || opt.label || opt.name;
                  const optQty = isMulti
                    ? (cur || []).filter(o => (o.id || o.label) === id).length
                    : (cur?.id === id || cur?.label === id ? 1 : 0);
                  const isSel = optQty > 0;
                  const optImage = resolveOptImage(opt);
                  // v5.5.189: resolve sub-item and check 86'd / stock
                  const optItemId = resolveOptItemId(opt, menuItems);
                  const opt86 = optItemId && eightySixIds.includes(optItemId);
                  const optStock = optItemId && dailyCounts[optItemId];
                  // v5.6.69 — numeric cap. Multi: every tap adds a pick, so the
                  // next one costs (optQty+1) × line qty units; single: switching
                  // here costs qty units (only when not already selected).
                  const optFull = !!(optStock && Number.isFinite(Number(optStock.remaining))
                    && (isMulti || !isSel)
                    && ((isMulti ? optQty + 1 : 1) * qty > Number(optStock.remaining)));
                  const optDisabled = opt86 || optFull || (atMax && !isSel);

                  return (
                    <div key={id} style={{ position:'relative' }}>
                      <button
                        onClick={() => {
                          if (opt86 || optFull) return; // 86'd or no stock left for another pick
                          if (isMulti) {
                            if (!atMax) onAddMulti(group.id, { ...opt, id, label: opt.name || opt.label || id }, maxPicks);
                          } else {
                            onToggleSingle(group.id, { ...opt, id, label: opt.name || opt.label || id });
                          }
                        }}
                        style={{
                          width:'100%', display:'flex', alignItems:'center', gap:10,
                          padding: optImage ? '8px 14px' : '10px 14px',
                          // reserve the right edge for the absolute qty stepper so a long name never runs under it
                          paddingRight: isSel && isMulti ? 56 : 14,
                          borderRadius:12,
                          cursor: optDisabled ? 'not-allowed' : 'pointer',
                          fontFamily:'inherit', textAlign:'left', transition:'all .1s',
                          border:`2px solid ${opt86 ? 'var(--red-b)' : isSel ? 'var(--acc)' : 'var(--bdr)'}`,
                          background: opt86 ? 'var(--bg5)' : isSel ? 'var(--acc-d)' : 'var(--bg2)',
                          opacity: optDisabled ? 0.4 : 1,
                        }}>
                        {optImage && (
                          <div style={{ width:40, height:40, borderRadius:8, overflow:'hidden', flexShrink:0, border:`1px solid ${isSel?'var(--acc)':'var(--bdr)'}` }}>
                            <img src={optImage} alt={opt.name||opt.label} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                          </div>
                        )}
                        <div style={{ width:18, height:18, borderRadius: isMulti ? 4 : '50%', border:`2px solid ${opt86 ? 'var(--red-b)' : isSel ? 'var(--acc)' : 'var(--bdr2)'}`, background: opt86 ? 'var(--red-d)' : isSel ? 'var(--acc)' : 'transparent', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                          {opt86 ? <span style={{ fontSize:10, lineHeight:1 }}>🚫</span> : isSel && <div style={{ width:6, height:6, borderRadius: isMulti ? 2 : '50%', background:'#0b0c10' }}/>}
                        </div>
                        {/* Name + price stacked; flex:1 + minWidth:0 lets a long name wrap instead of colliding */}
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ display:'flex', alignItems:'center', gap:5, flexWrap:'wrap' }}>
                            <span style={{ fontSize:13, fontWeight: isSel ? 700 : 400, lineHeight:1.25, wordBreak:'break-word', color: opt86 ? 'var(--t4)' : isSel ? 'var(--acc)' : 'var(--t1)', textDecoration: opt86 ? 'line-through' : 'none' }}>
                              {opt.name || opt.label}
                            </span>
                            {opt86 && <span style={{ fontSize:9, fontWeight:800, padding:'1px 5px', borderRadius:4, background:'var(--red-d)', color:'var(--red)', border:'1px solid var(--red-b)' }}>86'd</span>}
                            {optStock && !opt86 && optStock.remaining <= 3 && (
                              <span style={{ fontSize:9, fontWeight:700, padding:'1px 5px', borderRadius:4, background:'var(--wrn-d,#fff3cd)', color:'var(--wrn,#856404)', border:'1px solid var(--wrn-b,#ffc107)' }}>{optStock.remaining} left</span>
                            )}
                          </div>
                          {(opt.price || 0) > 0 && (
                            <div style={{ fontSize:11, fontWeight:600, marginTop:2, color: isSel ? 'var(--acc)' : 'var(--t3)', fontFamily:'var(--font-mono)' }}>+{money(opt.price)}</div>
                          )}
                        </div>
                      </button>
                      {/* Qty badge + minus for multi — absolute, with paddingRight above keeping content clear */}
                      {isSel && isMulti && (
                        <div style={{ position:'absolute', right:8, top:'50%', transform:'translateY(-50%)', display:'flex', alignItems:'center', gap:3 }}>
                          <button
                            onClick={e => { e.stopPropagation(); const all=(cur||[]).filter(o=>(o.id||o.label)===id); onRemoveMulti(group.id, all[all.length-1]?._uid); }}
                            style={{ width:24, height:24, borderRadius:6, border:'1.5px solid var(--acc)', background:'var(--acc-d)', color:'var(--acc)', cursor:'pointer', fontFamily:'inherit', fontSize:15, fontWeight:800, display:'flex', alignItems:'center', justifyContent:'center', lineHeight:1, flexShrink:0 }}>−</button>
                          <span style={{ fontSize:13, fontWeight:900, color:'var(--acc)', minWidth:16, textAlign:'center' }}>{optQty}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Nested sub-group for single-select */}
            {!isQuantityMode && (() => {
              const selOpt = !isMulti ? cur : null;
              if (!selOpt?.subGroupId) return null;
              const subDef = allModDefs?.find(d => d.id === selOpt.subGroupId);
              if (!subDef) return null;
              const subMissing = missingRequired.some(m => m.id === subDef.id);
              return (
                <SubModifierGroup key={subDef.id} group={subDef}
                  isMissing={subMissing}
                  selections={selections} onToggleSingle={onToggleSingle}
                  onAddMulti={onAddMulti} onRemoveMulti={onRemoveMulti}/>
              );
            })()}
          </div>
        );
      })}

      {/* Notes */}
      <div>
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6 }}>Note (optional)</div>
        <input value={notes} onChange={e => onNotes(e.target.value)} placeholder="Allergy note, special request…" className="input" style={{ width:'100%', fontSize:13, boxSizing:'border-box' }}/>
      </div>
    </div>
  );
}

// ── SubModifierGroup: nested modifier group shown inline ─────────────────────
function SubModifierGroup({ group, selections, onToggleSingle, onAddMulti, onRemoveMulti, isMissing = false }) {
  const cur = selections[group.id];
  const max = group.max >= 99 || !group.max ? 999 : group.max;
  const isMulti = max > 1;
  return (
    <div style={{ marginTop:8, padding:'10px 12px', background: isMissing ? 'var(--red-d)' : 'var(--bg3)', borderRadius:10,
      border: isMissing ? '2px solid var(--red-b)' : '1px solid var(--bdr)',
      borderLeft: isMissing ? '3px solid var(--red)' : '3px solid var(--acc)' }}>
      <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8 }}>
        <div style={{ fontSize:10, fontWeight:700, color: isMissing ? 'var(--red)' : 'var(--acc)', textTransform:'uppercase', letterSpacing:'.07em' }}>
          ↳ {group.name || group.label}
        </div>
        {(group.min || 0) > 0 && <span style={{ fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:5, background: isMissing ? 'var(--red)' : 'var(--acc)', color:'#fff' }}>Required</span>}
      </div>
      <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
        {(group.options||[]).map(opt => {
          const id = opt.id || opt.name;
          const isSel = isMulti
            ? (cur||[]).some(o => (o.id||o.name||o.label) === id)
            : cur?.id === id || cur?.name === id || cur?.label === id;
          return (
            <button key={id} onClick={() => {
              if (isMulti) {
                if (isSel) onRemoveMulti(group.id, (cur||[]).find(o=>(o.id||o.name)===id)?._uid);
                else onAddMulti(group.id, {...opt, id}, max);
              } else {
                onToggleSingle(group.id, {...opt, id, label: opt.name||opt.label||id});
              }
            }} style={{ padding:'7px 12px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', fontSize:12,
              border:`1.5px solid ${isSel?'var(--acc)':'var(--bdr)'}`,
              background:isSel?'var(--acc-d)':'var(--bg2)',
              color:isSel?'var(--acc)':'var(--t1)', fontWeight:isSel?700:400 }}>
              {opt.name||opt.label}
              {(opt.price||0) > 0 && <span style={{ color:'var(--t4)', marginLeft:4 }}>+{money(opt.price)}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
// v3.9.3 Fri Apr 17 21:38:43 UTC 2026
