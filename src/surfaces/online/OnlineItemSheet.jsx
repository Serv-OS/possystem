// v5.5.112 — Online ordering item detail sheet (UI overhaul).
// Full-screen on mobile, side-panel on desktop. DoorDash-style: hero image
// at top, name + description, variant picker if applicable, modifier groups
// with clear required/optional labels, qty stepper, sticky bottom CTA.

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';

export default function OnlineItemSheet({ item, theme, allItems, onClose, onAdd }) {
  const [qty, setQty]               = useState(1);
  const [modGroups, setModGroups]   = useState([]);
  const [instGroups, setInstGroups] = useState([]); // cooking prefs etc — no price impact
  const [selections, setSelections] = useState({});
  const [instSelections, setInstSelections] = useState({}); // { instGroupId: optionLabel }
  const [loading, setLoading]       = useState(false);
  const [errors, setErrors]         = useState([]);

  const variants = useMemo(
    () => (allItems || []).filter(i => i.parent_id === item.id),
    [allItems, item.id]
  );
  const isParentVariant = variants.length > 0;
  const [selectedVariant, setSelectedVariant] = useState(null);
  useEffect(() => {
    if (isParentVariant && variants.length && !selectedVariant) setSelectedVariant(variants[0]);
  }, [isParentVariant, variants, selectedVariant]);

  const effectiveItem = selectedVariant || item;

  // Modifier + instruction groups assigned to this item (inheriting from
  // parent for child variants when child doesn't override).
  const modGroupIds = useMemo(() => {
    const own = effectiveItem.assigned_modifier_groups || [];
    if (own.length === 0 && effectiveItem.parent_id) {
      const parent = (allItems || []).find(i => i.id === effectiveItem.parent_id);
      return parent?.assigned_modifier_groups || [];
    }
    return own;
  }, [effectiveItem, allItems]);

  const instGroupIds = useMemo(() => {
    const own = effectiveItem.assigned_instruction_groups || [];
    if (own.length === 0 && effectiveItem.parent_id) {
      const parent = (allItems || []).find(i => i.id === effectiveItem.parent_id);
      return parent?.assigned_instruction_groups || [];
    }
    return own;
  }, [effectiveItem, allItems]);

  useEffect(() => {
    let alive = true;
    if (!supabase || (modGroupIds.length === 0 && instGroupIds.length === 0)) {
      setModGroups([]); setInstGroups([]); setSelections({}); setInstSelections({}); return;
    }
    setLoading(true);
    (async () => {
      try {
        const [mRes, iRes] = await Promise.all([
          modGroupIds.length
            ? supabase.from('modifier_groups')
                .select('id, name, min, max, selection_type, options, sort_order')
                .in('id', modGroupIds)
            : Promise.resolve({ data: [] }),
          instGroupIds.length
            ? supabase.from('instruction_groups')
                .select('id, name, options, sort_order, required')
                .in('id', instGroupIds)
            : Promise.resolve({ data: [] }),
        ]);
        if (!alive) return;
        const mSorted = (mRes.data || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
        const iSorted = (iRes.data || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
        setModGroups(mSorted);
        setInstGroups(iSorted);
        // Pre-fill required single-pick mod groups with the first option
        const init = {};
        mSorted.forEach(g => {
          if ((g.min ?? 0) >= 1 && (g.max ?? 1) === 1 && Array.isArray(g.options) && g.options.length) {
            init[g.id] = g.options[0];
          }
        });
        setSelections(init);
        setInstSelections({});
      } catch (e) {
        console.warn('[OnlineItemSheet] group load failed:', e?.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [modGroupIds.join(','), instGroupIds.join(',')]);

  const basePrice = Number(effectiveItem.pricing?.base ?? effectiveItem.price ?? 0);
  const modsTotal = Object.entries(selections).reduce((sum, [, val]) => {
    if (!val) return sum;
    const arr = Array.isArray(val) ? val : [val];
    return sum + arr.reduce((s, o) => s + (Number(o?.price) || 0), 0);
  }, 0);
  const lineTotal = (basePrice + modsTotal) * qty;

  const validationErrors = useMemo(() => {
    const errs = [];
    for (const g of modGroups) {
      const min = g.min ?? 0;
      if (min === 0) continue;
      const v = selections[g.id];
      if (!v || (Array.isArray(v) && v.length < min)) errs.push(g.id);
    }
    return errs;
  }, [modGroups, selections]);
  const canAdd = validationErrors.length === 0;

  const handleAdd = () => {
    if (!canAdd) { setErrors(validationErrors); return; }
    const flatMods = [];
    Object.entries(selections).forEach(([gid, val]) => {
      const grp = modGroups.find(g => g.id === gid);
      const arr = Array.isArray(val) ? val : (val ? [val] : []);
      arr.forEach(o => flatMods.push({
        id: o?.id || null,
        name: o?.name || o?.label || '',
        label: o?.name || o?.label || '',
        groupLabel: grp?.name || '',
        price: Number(o?.price) || 0,
      }));
    });
    // Instruction picks — flagged as instruction so kitchen ticket renders
    // them but no surcharge applies.
    Object.entries(instSelections).forEach(([gid, val]) => {
      if (!val) return;
      const grp = instGroups.find(g => g.id === gid);
      flatMods.push({
        id: `ig-${gid}-${val}`,
        name: val,
        label: val,
        groupLabel: grp?.name || '',
        price: 0,
        _instruction: true,
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

  const muted    = theme.isLight ? '#6b6b70' : '#a0a0a8';
  const cardBdr  = theme.isLight ? '#ececef' : '#2a2a30';
  const inputBg  = theme.isLight ? '#f5f5f7' : '#1f1f24';
  const display  = effectiveItem.menu_name || effectiveItem.name;
  const heroImg  = item.image || effectiveItem.image;

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 30,
      background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      animation: 'fadeIn .15s ease',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 600,
        maxHeight: '94vh', overflowY: 'auto',
        background: theme.bg, color: theme.fg,
        borderRadius: '18px 18px 0 0',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 -10px 40px rgba(0,0,0,0.3)',
      }}>
        {/* Drag handle */}
        <div style={{ padding: '10px 0 6px', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
          <div style={{ width: 44, height: 5, borderRadius: 3, background: cardBdr }}/>
        </div>

        {/* Close (X) — floats over hero on mobile, top-right */}
        <button onClick={onClose} style={{
          position: 'absolute', top: 12, right: 16, zIndex: 5,
          width: 36, height: 36, borderRadius: '50%', border: 'none',
          background: 'rgba(0,0,0,0.55)', color: '#fff',
          fontSize: 18, fontWeight: 900, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>×</button>

        {/* Hero image */}
        {heroImg && (
          <div style={{
            width: '100%', height: 240,
            backgroundImage: `url(${heroImg})`, backgroundSize: 'cover', backgroundPosition: 'center',
            flexShrink: 0,
          }}/>
        )}

        <div style={{ padding: '20px 22px 12px', flex: 1 }}>
          <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 6 }}>
            {display}
          </div>
          {item.description && (
            <div style={{ fontSize: 14, color: muted, lineHeight: 1.55, marginBottom: 18 }}>
              {item.description}
            </div>
          )}

          {/* Variant picker */}
          {isParentVariant && (
            <Section title="Choose size" required>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {variants.map(v => {
                  const active = v.id === selectedVariant?.id;
                  const vPrice = Number(v.pricing?.base ?? v.price ?? 0);
                  return (
                    <OptionRow key={v.id}
                      label={v.menu_name || v.name}
                      priceDelta={vPrice - basePrice}
                      checked={active}
                      onClick={() => setSelectedVariant(v)}
                      mode="single" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
                  );
                })}
              </div>
            </Section>
          )}

          {/* Allergen warning chips — surfaced upfront so customers can see
              before they get to the modifier flow. */}
          {(item.allergens || []).length > 0 && (
            <div style={{
              padding: '12px 14px', borderRadius: 12,
              background: '#fde6e6', border: '1px solid #fcaeae',
              marginBottom: 18, display: 'flex', alignItems: 'flex-start', gap: 10,
            }}>
              <div style={{ fontSize: 18, lineHeight: 1 }}>⚠️</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: '#991b1b', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                  Contains
                </div>
                <div style={{ fontSize: 13, color: '#7f1d1d', textTransform: 'capitalize', lineHeight: 1.5 }}>
                  {(item.allergens || []).join(' · ')}
                </div>
                <div style={{ fontSize: 11, color: '#991b1b', opacity: 0.8, marginTop: 4 }}>
                  If you have a severe allergy, please confirm with the venue before ordering.
                </div>
              </div>
            </div>
          )}

          {/* Modifier groups */}
          {loading && <div style={{ padding: 12, color: muted, fontSize: 13 }}>Loading options…</div>}
          {modGroups.map(g => {
            const min = g.min ?? 0;
            const max = g.max ?? 1;
            const isSingle = max === 1;
            const required = min >= 1;
            const erroring = errors.includes(g.id);
            const value = selections[g.id];
            return (
              <Section key={g.id}
                title={g.name}
                meta={required ? `Required${max > 1 ? ` · pick up to ${max}` : ''}` : (max > 1 ? `Pick up to ${max}` : 'Optional')}
                required={required}
                erroring={erroring}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {(g.options || []).map(opt => {
                    const checked = isSingle
                      ? value?.id === opt.id
                      : Array.isArray(value) && value.some(o => o.id === opt.id);
                    const onClick = () => {
                      setErrors([]);
                      setSelections(s => {
                        const cur = s[g.id];
                        if (isSingle) return { ...s, [g.id]: cur?.id === opt.id ? null : opt };
                        const arr = Array.isArray(cur) ? cur : [];
                        const has = arr.some(o => o.id === opt.id);
                        if (has) return { ...s, [g.id]: arr.filter(o => o.id !== opt.id) };
                        if (arr.length >= max) return s;
                        return { ...s, [g.id]: [...arr, opt] };
                      });
                    };
                    return (
                      <OptionRow key={opt.id || opt.name}
                        label={opt.name || opt.label}
                        priceDelta={Number(opt.price) || 0}
                        checked={checked}
                        onClick={onClick}
                        mode={isSingle ? 'single' : 'multi'}
                        theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
                    );
                  })}
                </div>
              </Section>
            );
          })}

          {/* Instruction groups — kitchen instructions (cooking prefs etc).
              No price impact, single-pick per group. */}
          {instGroups.map(g => {
            const value = instSelections[g.id];
            const required = !!g.required;
            return (
              <Section key={g.id} title={g.name} meta={required ? 'Required' : 'Optional'} required={required}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {(g.options || []).map(opt => {
                    const label = typeof opt === 'string' ? opt : (opt.label || opt.name);
                    const checked = value === label;
                    return (
                      <OptionRow key={label}
                        label={label}
                        priceDelta={0}
                        checked={checked}
                        onClick={() => setInstSelections(s => ({
                          ...s, [g.id]: checked ? null : label,
                        }))}
                        mode="single"
                        theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
                    );
                  })}
                </div>
              </Section>
            );
          })}

          {/* Quantity */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '20px 0 8px',
          }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Quantity</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <button onClick={() => setQty(q => Math.max(1, q - 1))} style={{
                ...stepBtn, background: inputBg, color: theme.fg, opacity: qty <= 1 ? .4 : 1,
              }}>−</button>
              <span style={{ fontSize: 18, fontWeight: 800, minWidth: 28, textAlign: 'center' }}>{qty}</span>
              <button onClick={() => setQty(q => q + 1)} style={{
                ...stepBtn, background: inputBg, color: theme.fg,
              }}>+</button>
            </div>
          </div>
        </div>

        {/* Sticky bottom CTA */}
        <div style={{
          position: 'sticky', bottom: 0,
          padding: '14px 22px calc(14px + env(safe-area-inset-bottom)) 22px',
          background: theme.bg, borderTop: `1px solid ${cardBdr}`, flexShrink: 0,
        }}>
          <button onClick={handleAdd} style={{
            width: '100%', padding: '16px 22px', borderRadius: 14,
            background: canAdd ? theme.accent : `${theme.fg}20`,
            color: canAdd ? contrastFg(theme.accent) : `${theme.fg}60`,
            border: 'none', fontSize: 16, fontWeight: 800, cursor: canAdd ? 'pointer' : 'not-allowed',
            fontFamily: 'inherit',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>Add {qty} to basket</span>
            <span>£{lineTotal.toFixed(2)}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function Section({ title, meta, required, erroring, children }) {
  return (
    <div style={{ paddingTop: 16, borderTop: '1px solid transparent', marginBottom: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontSize: 16, fontWeight: 800 }}>{title}</div>
        {meta && (
          <div style={{
            fontSize: 11, fontWeight: 700,
            padding: '2px 8px', borderRadius: 99,
            background: erroring ? 'rgba(239,68,68,0.15)' : (required ? 'rgba(232,160,32,0.15)' : 'transparent'),
            color: erroring ? '#ef4444' : (required ? '#a16500' : '#9a9aa1'),
            textTransform: 'uppercase', letterSpacing: '0.04em',
          }}>{meta}</div>
        )}
      </div>
      {children}
    </div>
  );
}

function OptionRow({ label, priceDelta, checked, onClick, mode, theme, cardBdr, inputBg }) {
  return (
    <button onClick={onClick} style={{
      width: '100%', display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 14px', borderRadius: 12,
      background: checked ? `${theme.accent}15` : inputBg,
      border: `1.5px solid ${checked ? theme.accent : cardBdr}`,
      color: theme.fg, fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left',
      transition: 'all .12s ease',
    }}>
      <Indicator checked={checked} mode={mode} accent={theme.accent} cardBdr={cardBdr}/>
      <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{label}</span>
      {priceDelta !== 0 && (
        <span style={{ fontSize: 13, fontWeight: 700, color: priceDelta > 0 ? theme.fg : '#22c55e' }}>
          {priceDelta > 0 ? `+£${priceDelta.toFixed(2)}` : `−£${Math.abs(priceDelta).toFixed(2)}`}
        </span>
      )}
    </button>
  );
}

function Indicator({ checked, mode, accent, cardBdr }) {
  const isCircle = mode === 'single';
  return (
    <div style={{
      width: 22, height: 22, borderRadius: isCircle ? '50%' : 6,
      border: `2px solid ${checked ? accent : cardBdr}`,
      background: checked ? accent : 'transparent',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
    }}>
      {checked && (
        isCircle
          ? <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#fff' }}/>
          : <span style={{ color: '#fff', fontSize: 14, lineHeight: 1, fontWeight: 900 }}>✓</span>
      )}
    </div>
  );
}

function contrastFg(hex) {
  if (!hex) return '#fff';
  const c = hex.replace('#', '');
  const n = c.length === 3 ? c.split('').map(x => x + x).join('') : c;
  if (n.length !== 6) return '#fff';
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 128 ? '#0b0c10' : '#ffffff';
}

const stepBtn = {
  width: 38, height: 38, borderRadius: '50%',
  border: 'none', fontSize: 20, fontWeight: 800,
  cursor: 'pointer', fontFamily: 'inherit',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
