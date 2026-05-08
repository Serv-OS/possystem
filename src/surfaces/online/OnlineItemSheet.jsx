// v5.5.108 — Online ordering item detail sheet.
// Slide-up bottom sheet that opens when a customer taps a menu row.
// Shows item name + description + image, modifier groups (if any),
// quantity stepper, and "Add to cart" CTA. Mirrors MItemDetail.jsx
// shape so cart line items have the same { id, name, price, qty, mods }
// schema downstream surfaces (kitchen ticket, receipt) already expect.

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';

export default function OnlineItemSheet({ item, theme, allItems, orderType, onClose, onAdd }) {
  const [qty, setQty] = useState(1);
  const [modGroups, setModGroups] = useState([]);
  const [selections, setSelections] = useState({}); // { groupId: option | option[] }
  const [loading, setLoading] = useState(false);

  // Variant detection — children of this item via parent_id
  const variants = useMemo(
    () => (allItems || []).filter(i => i.parent_id === item.id),
    [allItems, item.id]
  );
  const isParentVariant = variants.length > 0;
  const [selectedVariant, setSelectedVariant] = useState(null);

  useEffect(() => {
    if (isParentVariant && variants.length && !selectedVariant) {
      setSelectedVariant(variants[0]);
    }
  }, [isParentVariant, variants, selectedVariant]);

  const effectiveItem = selectedVariant || item;

  // Load modifier group definitions for THIS item's assigned groups (if any).
  // assigned_modifier_groups is an array of group IDs on the item row.
  const groupIds = useMemo(() => {
    const own = effectiveItem.assigned_modifier_groups || [];
    // Fall back to parent's assigned groups when child doesn't override
    if (own.length === 0 && effectiveItem.parent_id) {
      const parent = (allItems || []).find(i => i.id === effectiveItem.parent_id);
      return parent?.assigned_modifier_groups || [];
    }
    return own;
  }, [effectiveItem, allItems]);

  useEffect(() => {
    let alive = true;
    if (!groupIds.length || !supabase) { setModGroups([]); return; }
    setLoading(true);
    (async () => {
      try {
        const { data } = await supabase
          .from('modifier_groups')
          .select('id, name, min, max, selection_type, options, sort_order')
          .in('id', groupIds);
        if (!alive) return;
        const sorted = (data || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
        setModGroups(sorted);
        // Pre-fill required single-pick groups with first option to satisfy validation
        const init = {};
        sorted.forEach(g => {
          if ((g.min ?? 0) >= 1 && (g.max ?? 1) === 1 && Array.isArray(g.options) && g.options.length) {
            init[g.id] = g.options[0];
          }
        });
        setSelections(init);
      } catch (e) {
        console.warn('[OnlineItemSheet] mod load failed:', e?.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [groupIds]);

  const basePrice = Number(effectiveItem.pricing?.base ?? effectiveItem.price ?? 0);
  const modsTotal = Object.entries(selections).reduce((sum, [, val]) => {
    if (!val) return sum;
    const arr = Array.isArray(val) ? val : [val];
    return sum + arr.reduce((s, o) => s + (Number(o?.price) || 0), 0);
  }, 0);
  const lineTotal = (basePrice + modsTotal) * qty;

  const canAdd = useMemo(() => {
    for (const g of modGroups) {
      const min = g.min ?? 0;
      if (min === 0) continue;
      const v = selections[g.id];
      if (!v) return false;
      if (Array.isArray(v) && v.length < min) return false;
    }
    return true;
  }, [modGroups, selections]);

  const handleAdd = () => {
    const flatMods = [];
    Object.entries(selections).forEach(([gid, val]) => {
      const grp = modGroups.find(g => g.id === gid);
      const arr = Array.isArray(val) ? val : (val ? [val] : []);
      arr.forEach(o => {
        flatMods.push({
          id: o?.id || null,
          name: o?.name || o?.label || '',
          label: o?.name || o?.label || '',
          groupLabel: grp?.name || '',
          price: Number(o?.price) || 0,
        });
      });
    });
    const finalItem = {
      ...effectiveItem,
      menu_name: selectedVariant
        ? `${item.menu_name || item.name} — ${selectedVariant.menu_name || selectedVariant.name}`
        : (effectiveItem.menu_name || effectiveItem.name),
    };
    onAdd(finalItem, flatMods, qty);
  };

  const display = effectiveItem.menu_name || effectiveItem.name;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 30,
      background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 540,
        maxHeight: '90vh', overflowY: 'auto',
        background: theme.bg, color: theme.fg, borderRadius: '16px 16px 0 0',
        borderTop: `1px solid ${theme.fg}20`,
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Drag handle */}
        <div style={{ padding: '10px 0 4px', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
          <div style={{ width: 40, height: 4, borderRadius: 2, background: `${theme.fg}30` }}/>
        </div>

        {/* Hero / image */}
        {item.image && (
          <img src={item.image} alt={item.name}
            style={{ width: '100%', maxHeight: 220, objectFit: 'cover', flexShrink: 0 }}/>
        )}

        <div style={{ padding: 18, flex: 1 }}>
          <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>{display}</div>
          {item.description && <div style={{ fontSize: 13, opacity: 0.7, lineHeight: 1.5, marginBottom: 12 }}>{item.description}</div>}

          {/* Variant picker */}
          {isParentVariant && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Choose size</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {variants.map(v => {
                  const active = v.id === selectedVariant?.id;
                  const vPrice = Number(v.pricing?.base ?? v.price ?? 0);
                  return (
                    <button key={v.id} onClick={() => setSelectedVariant(v)} style={{
                      padding: '10px 14px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
                      background: active ? theme.accent : `${theme.fg}10`,
                      color: active ? '#0b0c10' : theme.fg,
                      border: active ? 'none' : `1px solid ${theme.fg}25`,
                      fontSize: 12, fontWeight: 700,
                    }}>
                      {v.menu_name || v.name} · £{vPrice.toFixed(2)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Modifier groups */}
          {loading && <div style={{ opacity: 0.6, fontSize: 12, padding: '8px 0' }}>Loading options…</div>}
          {modGroups.map(g => (
            <ModGroup key={g.id} group={g} value={selections[g.id]} theme={theme}
              onChange={(v) => setSelections(s => ({ ...s, [g.id]: v }))}/>
          ))}

          {/* Quantity */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '20px 0' }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Quantity</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <button onClick={() => setQty(q => Math.max(1, q - 1))}
                style={{ ...stepBtn(theme), opacity: qty <= 1 ? 0.4 : 1 }}>−</button>
              <span style={{ fontSize: 16, fontWeight: 800, minWidth: 24, textAlign: 'center' }}>{qty}</span>
              <button onClick={() => setQty(q => q + 1)} style={stepBtn(theme)}>+</button>
            </div>
          </div>
        </div>

        {/* Sticky CTA */}
        <div style={{
          padding: '12px 18px calc(12px + env(safe-area-inset-bottom)) 18px',
          background: theme.bg, borderTop: `1px solid ${theme.fg}15`, flexShrink: 0,
          display: 'flex', gap: 10,
        }}>
          <button onClick={onClose} style={{
            padding: '14px 18px', borderRadius: 12,
            background: 'transparent', color: theme.fg,
            border: `1px solid ${theme.fg}30`,
            fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
          }}>Cancel</button>
          <button onClick={handleAdd} disabled={!canAdd} style={{
            flex: 1, padding: '14px 18px', borderRadius: 12,
            background: canAdd ? theme.accent : `${theme.fg}20`,
            color: canAdd ? '#0b0c10' : `${theme.fg}60`,
            border: 'none', fontSize: 14, fontWeight: 800, cursor: canAdd ? 'pointer' : 'not-allowed',
            fontFamily: 'inherit',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
          }}>
            <span>Add to cart</span>
            <span>£{lineTotal.toFixed(2)}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function ModGroup({ group, value, theme, onChange }) {
  const min = group.min ?? 0;
  const max = group.max ?? 1;
  const isSingle = max === 1;
  const required = min >= 1;
  const optionPicked = (opt) => {
    if (isSingle) return value?.id === opt.id;
    return Array.isArray(value) && value.some(o => o.id === opt.id);
  };
  const togglePick = (opt) => {
    if (isSingle) {
      onChange(value?.id === opt.id ? null : opt);
      return;
    }
    const arr = Array.isArray(value) ? value : [];
    const isOn = arr.some(o => o.id === opt.id);
    if (isOn) onChange(arr.filter(o => o.id !== opt.id));
    else if (arr.length < max) onChange([...arr, opt]);
  };
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>{group.name}</div>
        <div style={{ fontSize: 11, opacity: 0.6 }}>
          {required ? <>Required{max > 1 ? ` · pick up to ${max}` : ''}</> : (max > 1 ? `Pick up to ${max}` : 'Optional')}
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {(group.options || []).map(opt => {
          const picked = optionPicked(opt);
          const px = Number(opt.price) || 0;
          return (
            <button key={opt.id || opt.name} onClick={() => togglePick(opt)} style={{
              padding: '8px 12px', borderRadius: 99, cursor: 'pointer', fontFamily: 'inherit',
              background: picked ? theme.accent : `${theme.fg}10`,
              color:      picked ? '#0b0c10' : theme.fg,
              border:     picked ? 'none' : `1px solid ${theme.fg}25`,
              fontSize: 12, fontWeight: 700,
            }}>
              {opt.name || opt.label}
              {px > 0 && <span style={{ marginLeft: 6, opacity: 0.7 }}>+£{px.toFixed(2)}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function stepBtn(theme) {
  return {
    width: 36, height: 36, borderRadius: '50%',
    background: `${theme.fg}15`, color: theme.fg, border: 'none',
    fontSize: 18, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
}
