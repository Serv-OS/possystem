// v5.5.112 — Online ordering item detail sheet (UI overhaul).
// Full-screen on mobile, side-panel on desktop. DoorDash-style: hero image
// at top, name + description, variant picker if applicable, modifier groups
// with clear required/optional labels, qty stepper, sticky bottom CTA.

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';

export default function OnlineItemSheet({ item, theme, allItems, instGroupDefs = [], eightySixIds = [], onClose, onAdd }) {
  const [qty, setQty]               = useState(1);
  const [modGroups, setModGroups]   = useState([]);  // top-level groups assigned to item
  const [allModGroups, setAllModGroups] = useState([]); // includes nested sub-groups (lookup)
  const [instGroups, setInstGroups] = useState([]); // cooking prefs etc — no price impact
  const [selections, setSelections] = useState({});
  // Sub-picks for nested modifiers. Key: `${parentGroupId}:${parentOptionId}`,
  // value: option object (single) — sub-groups are single-pick by convention.
  const [subPicks, setSubPicks]     = useState({});
  // Quantity-mode picks. For groups where selection_type='quantity', pick
  // counts per option are tracked here. Key: groupId, value: { optionId: qty }.
  const [qtyPicks, setQtyPicks]     = useState({});
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
    // v5.5.141: auto-pick the first AVAILABLE (not 86'd) variant. If every
    // size is 86'd, leave selectedVariant null — the add button stays
    // disabled because effectiveItem will be the parent which is also 86'd
    // by inheritance (the operator typically 86s the parent, or all kids).
    if (isParentVariant && variants.length && !selectedVariant) {
      const firstAvailable = variants.find(v => !eightySixIds.includes(v.id));
      setSelectedVariant(firstAvailable || variants[0]);
    }
  }, [isParentVariant, variants, selectedVariant, eightySixIds]);

  const effectiveItem = selectedVariant || item;
  // v5.5.141: is the customer's currently-selected variant (or the base
  // item, if no variants) actually orderable right now?
  const effectiveIs86 = eightySixIds.includes(effectiveItem.id)
    || (effectiveItem.parent_id && eightySixIds.includes(effectiveItem.parent_id))
    || (item.id !== effectiveItem.id && eightySixIds.includes(item.id));

  // v5.5.313: resolve a modifier option to its menu item id (by explicit link
  // or name-match against sold-alone sub-items) — ported from the kiosk. Needed
  // so an 86'd item can't be ordered online via a modifier group, and so the
  // modifier's stock actually decrements (decrementOnlineStock keys on itemId).
  const subitemByName = useMemo(() => {
    const map = new Map();
    for (const it of (allItems || [])) {
      if (!it || it.archived) continue;
      if (it.type !== 'subitem') continue;
      const soldAlone = it.soldAlone ?? it.sold_alone;
      if (!soldAlone) continue;
      for (const raw of [it.name, it.menuName, it.menu_name, it.receiptName, it.receipt_name, it.kitchenName, it.kitchen_name]) {
        if (!raw) continue;
        const key = String(raw).trim().toLowerCase();
        if (key && !map.has(key)) map.set(key, it);
      }
    }
    return map;
  }, [allItems]);
  const resolveOptItemId = (opt) => {
    if (opt?.itemId || opt?.item_id) return opt.itemId || opt.item_id;
    const key = String(opt?.name || opt?.label || '').trim().toLowerCase();
    return (key ? subitemByName.get(key)?.id : null) || null;
  };
  const optIs86 = (opt) => {
    const id = resolveOptItemId(opt);
    return !!id && eightySixIds.includes(id);
  };

  // assigned_modifier_groups + assigned_instruction_groups can be EITHER
  // an array of bare ids ['mgd-123', ...] OR an array of objects with
  // overrides like [{groupId: 'mgd-123', min: 0, max: 1}]. The operator
  // app stores them as objects (so it can override min/max per item);
  // `.in('id', ...)` needs flat strings. Normalise here.
  const extractIds = (arr) => (arr || [])
    .map(g => typeof g === 'string' ? g : (g?.groupId || g?.id))
    .filter(Boolean);

  const modGroupIds = useMemo(() => {
    const own = extractIds(effectiveItem.assigned_modifier_groups);
    if (own.length === 0 && effectiveItem.parent_id) {
      const parent = (allItems || []).find(i => i.id === effectiveItem.parent_id);
      return extractIds(parent?.assigned_modifier_groups);
    }
    return own;
  }, [effectiveItem, allItems]);

  const instGroupIds = useMemo(() => {
    const own = extractIds(effectiveItem.assigned_instruction_groups);
    if (own.length === 0 && effectiveItem.parent_id) {
      const parent = (allItems || []).find(i => i.id === effectiveItem.parent_id);
      return extractIds(parent?.assigned_instruction_groups);
    }
    return own;
  }, [effectiveItem, allItems]);

  useEffect(() => {
    let alive = true;
    // Resolve instruction groups from the config_pushes snapshot the parent
    // surface fetched at mount time — there's no `instruction_groups` DB
    // table in this schema; defs live client-side only.
    const resolvedInst = instGroupIds
      .map(id => (instGroupDefs || []).find(g => g.id === id))
      .filter(Boolean);
    setInstGroups(resolvedInst);

    if (!supabase || modGroupIds.length === 0) {
      setModGroups([]); setAllModGroups([]); setSelections({}); setInstSelections({}); setSubPicks({}); setQtyPicks({});
      return;
    }
    setLoading(true);
    (async () => {
      try {
        // Fetch the assigned groups, then scan their options for subGroupIds
        // and fetch those too. Sub-groups can chain (rare but allowed) so
        // loop until we've resolved every referenced group.
        const fetched = new Map();
        const queue = [...modGroupIds];
        while (queue.length) {
          const batch = queue.filter(id => !fetched.has(id));
          if (!batch.length) break;
          const { data, error } = await supabase
            .from('modifier_groups')
            .select('id, name, min, max, selection_type, options, sort_order')
            .in('id', batch);
          if (error) console.warn('[OnlineItemSheet] modifier load error:', error.message);
          (data || []).forEach(g => fetched.set(g.id, g));
          queue.length = 0;
          (data || []).forEach(g => (g.options || []).forEach(o => {
            if (o?.subGroupId && !fetched.has(o.subGroupId)) queue.push(o.subGroupId);
          }));
        }
        if (!alive) return;
        const all = [...fetched.values()].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
        const subGroupIds = new Set();
        all.forEach(g => (g.options || []).forEach(o => o?.subGroupId && subGroupIds.add(o.subGroupId)));
        // Top-level groups are the ones in modGroupIds that aren't sub-groups
        // (we still keep sub-groups in `all` so render can find them).
        const topMod = all.filter(g => modGroupIds.includes(g.id));
        console.log('[OnlineItemSheet] groups loaded', {
          top: topMod.length, totalIncludingSubs: all.length, inst: resolvedInst.length,
        });
        setModGroups(topMod);
        setAllModGroups(all); // includes nested sub-groups for lookup on render

        // Pre-fill required single-pick mod groups with the first option
        const init = {};
        topMod.forEach(g => {
          if ((g.min ?? 0) >= 1 && (g.max ?? 1) === 1 && Array.isArray(g.options) && g.options.length) {
            init[g.id] = g.options[0];
          }
        });
        setSelections(init);
        setInstSelections({});
        setSubPicks({});
        setQtyPicks({});
      } catch (e) {
        console.warn('[OnlineItemSheet] modifier load failed:', e?.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [modGroupIds.join(','), instGroupIds.join(',')]);

  const basePrice = Number(effectiveItem.pricing?.base ?? effectiveItem.price ?? 0);

  // Standard mod totals (single + multi-pick groups)
  const modsTotal = Object.entries(selections).reduce((sum, [, val]) => {
    if (!val) return sum;
    const arr = Array.isArray(val) ? val : [val];
    return sum + arr.reduce((s, o) => s + (Number(o?.price) || 0), 0);
  }, 0);
  // Quantity-mode totals: each picked option × its qty
  const qtyModsTotal = Object.entries(qtyPicks).reduce((sum, [gid, picks]) => {
    const grp = (allModGroups || modGroups).find(g => g.id === gid);
    return sum + Object.entries(picks).reduce((s, [optId, q]) => {
      const opt = grp?.options?.find(o => (o.id || o.name) === optId);
      return s + ((Number(opt?.price) || 0) * (Number(q) || 0));
    }, 0);
  }, 0);
  // Sub-pick totals (nested options always single-pick)
  const subTotal = Object.values(subPicks).reduce((sum, opt) => sum + (Number(opt?.price) || 0), 0);

  const lineTotal = (basePrice + modsTotal + qtyModsTotal + subTotal) * qty;

  // Quantity-mode total picks for a group
  const qtyTotalForGroup = (gid) => Object.values(qtyPicks[gid] || {}).reduce((s, n) => s + (Number(n) || 0), 0);

  const validationErrors = useMemo(() => {
    const errs = [];
    for (const g of modGroups) {
      const min = g.min ?? 0;
      const max = g.max ?? 1;
      if (g.selection_type === 'quantity') {
        // Quantity-mode: total picks across all options must satisfy min/max
        const total = qtyTotalForGroup(g.id);
        if (total < min) errs.push(g.id);
        // Max enforcement happens at click-time, but flag if exceeded too
        if (max && total > max) errs.push(g.id);
        continue;
      }
      if (min === 0) continue;
      const v = selections[g.id];
      if (!v || (Array.isArray(v) && v.length < min)) errs.push(g.id);
    }
    return errs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modGroups, selections, qtyPicks]);
  // v5.5.313: block Add when any SELECTED modifier option resolves to an 86'd
  // item (prevents ordering a sold-out item through a modifier group online).
  const has86Selection = useMemo(() => {
    const sel = [];
    Object.values(selections).forEach(val => {
      (Array.isArray(val) ? val : (val ? [val] : [])).forEach(o => sel.push(o));
    });
    Object.values(subPicks).forEach(o => o && sel.push(o));
    Object.entries(qtyPicks).forEach(([gid, picks]) => {
      const grp = (allModGroups || modGroups).find(g => g.id === gid);
      Object.entries(picks || {}).forEach(([optId, count]) => {
        if (!count) return;
        const opt = grp?.options?.find(o => (o.id || o.name) === optId);
        if (opt) sel.push(opt);
      });
    });
    return sel.some(optIs86);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selections, subPicks, qtyPicks, eightySixIds, subitemByName, modGroups, allModGroups]);

  // v5.5.141: block Add when the resolved item (variant or base) is 86'd.
  const canAdd = validationErrors.length === 0 && !effectiveIs86 && !has86Selection;

  const handleAdd = () => {
    if (!canAdd) { setErrors(validationErrors); return; }
    const flatMods = [];
    Object.entries(selections).forEach(([gid, val]) => {
      const grp = modGroups.find(g => g.id === gid);
      const arr = Array.isArray(val) ? val : (val ? [val] : []);
      arr.forEach(o => {
        flatMods.push({
          id: o?.id || null,
          itemId: resolveOptItemId(o),  // v5.5.313: enable online stock decrement + 86
          name: o?.name || o?.label || '',
          label: o?.name || o?.label || '',
          groupLabel: grp?.name || '',
          price: Number(o?.price) || 0,
        });
        // Nested sub-pick (e.g. Peppercorn sauce → Served hot / On the side).
        const subKey = `${gid}:${o?.id || o?.name}`;
        const subPick = subPicks[subKey];
        const subGroup = subPick && allModGroups.find(g => g.id === o?.subGroupId);
        if (subPick && subGroup) {
          flatMods.push({
            id: subPick?.id || null,
            itemId: resolveOptItemId(subPick),  // v5.5.313
            name: subPick?.name || subPick?.label || '',
            label: subPick?.name || subPick?.label || '',
            groupLabel: subGroup.name || '',
            price: Number(subPick?.price) || 0,
          });
        }
      });
    });
    // Quantity-mode picks: emit one entry per pick (so a Box of 3 with 3
    // Bueno Filled emits three separate Bueno Filled entries — same shape
    // MItemDetail produces, which the kitchen ticket / reports / receipts
    // already understand).
    Object.entries(qtyPicks).forEach(([gid, picks]) => {
      const grp = (allModGroups || modGroups).find(g => g.id === gid);
      Object.entries(picks).forEach(([optId, count]) => {
        const opt = grp?.options?.find(o => (o.id || o.name) === optId);
        if (!opt || !count) return;
        for (let i = 0; i < count; i++) {
          flatMods.push({
            id: opt.id || null,
            itemId: resolveOptItemId(opt),  // v5.5.313
            name: opt.name || opt.label || '',
            label: opt.name || opt.label || '',
            groupLabel: grp?.name || '',
            price: Number(opt.price) || 0,
          });
        }
      });
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

          {/* Variant picker — full rich rows: image, name, description,
              allergen pill, absolute price. Each variant IS its own product. */}
          {isParentVariant && (
            <Section title="Choose size" required>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {variants.map(v => {
                  const active = v.id === selectedVariant?.id;
                  const vPrice = Number(v.pricing?.base ?? v.price ?? 0);
                  // v5.5.141: 86'd variants are visible but not selectable
                  // so the customer can SEE the size exists but knows it's
                  // out — same pattern as the menu cards.
                  const v86 = eightySixIds.includes(v.id);
                  return (
                    <VariantRow key={v.id}
                      variant={v} active={active} price={vPrice} is86={v86}
                      onClick={() => v86 ? null : setSelectedVariant(v)}
                      theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
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
            const isQty = g.selection_type === 'quantity';
            const isSingle = !isQty && max === 1;
            const required = min >= 1;
            const erroring = errors.includes(g.id);
            const value = selections[g.id];

            // Quantity-mode: render +/- steppers per option, total picks ≤ max
            if (isQty) {
              const totalPicked = qtyTotalForGroup(g.id);
              return (
                <Section key={g.id}
                  title={g.name}
                  meta={`Pick ${min === max ? `${min}` : `${min}-${max}`} · ${totalPicked}/${max} chosen`}
                  required={required}
                  erroring={erroring}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {(g.options || []).map(opt => {
                      const optKey = opt.id || opt.name;
                      const count = qtyPicks[g.id]?.[optKey] || 0;
                      const canAdd = totalPicked < max;
                      return (
                        <QtyOptionRow key={optKey}
                          option={opt} count={count} canAdd={canAdd}
                          onInc={() => { setErrors([]); setQtyPicks(s => ({ ...s, [g.id]: { ...(s[g.id] || {}), [optKey]: count + 1 } })); }}
                          onDec={() => { setErrors([]); setQtyPicks(s => ({ ...s, [g.id]: { ...(s[g.id] || {}), [optKey]: Math.max(0, count - 1) } })); }}
                          theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
                      );
                    })}
                  </div>
                </Section>
              );
            }

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
                    // Nested sub-group: revealed when this option is the
                    // currently-picked one in a single-pick group AND has
                    // a subGroupId. Multi-pick + sub-groups get complex —
                    // out of scope for now.
                    const subGroup = checked && isSingle && opt.subGroupId
                      ? allModGroups.find(sg => sg.id === opt.subGroupId)
                      : null;
                    const subKey = `${g.id}:${opt.id || opt.name}`;
                    const subPick = subPicks[subKey];
                    return (
                      <div key={opt.id || opt.name}>
                        <OptionRow
                          label={opt.name || opt.label}
                          priceDelta={Number(opt.price) || 0}
                          checked={checked}
                          onClick={onClick}
                          mode={isSingle ? 'single' : 'multi'}
                          theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
                        {subGroup && (
                          <div style={{
                            marginTop: 8, marginLeft: 18,
                            paddingLeft: 12, borderLeft: `2px solid ${theme.accent}55`,
                          }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: theme.fg, marginBottom: 6 }}>
                              {subGroup.name}
                            </div>
                            {(subGroup.options || []).map(sopt => {
                              const sChecked = subPick?.id === sopt.id;
                              return (
                                <div key={sopt.id || sopt.name} style={{ marginBottom: 6 }}>
                                  <OptionRow
                                    label={sopt.name || sopt.label}
                                    priceDelta={Number(sopt.price) || 0}
                                    checked={sChecked}
                                    onClick={() => setSubPicks(s => ({ ...s, [subKey]: sChecked ? null : sopt }))}
                                    mode="single"
                                    theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
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
          <button onClick={handleAdd} disabled={!canAdd} style={{
            width: '100%', padding: '16px 22px', borderRadius: 14,
            background: canAdd ? theme.accent : `${theme.fg}20`,
            color: canAdd ? contrastFg(theme.accent) : `${theme.fg}60`,
            border: 'none', fontSize: 16, fontWeight: 800, cursor: canAdd ? 'pointer' : 'not-allowed',
            fontFamily: 'inherit',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>{effectiveIs86 ? 'Out of stock' : has86Selection ? 'Option out of stock' : `Add ${qty} to basket`}</span>
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

function OptionRow({ label, priceDelta, absolutePrice, checked, onClick, mode, theme, cardBdr, inputBg }) {
  // Two pricing modes:
  //   • absolutePrice (used for variants): "£2.50" — variants ARE their own price
  //   • priceDelta (used for modifiers):   "+£0.50" / "−£0.50" — modifies base
  let priceLabel = null;
  let priceColor = theme.fg;
  if (typeof absolutePrice === 'number') {
    priceLabel = `£${absolutePrice.toFixed(2)}`;
  } else if (typeof priceDelta === 'number' && priceDelta !== 0) {
    priceLabel = priceDelta > 0 ? `+£${priceDelta.toFixed(2)}` : `−£${Math.abs(priceDelta).toFixed(2)}`;
    if (priceDelta < 0) priceColor = '#22c55e';
  }
  return (
    <button onClick={onClick} className="op-btn" style={{
      width: '100%', display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 14px', borderRadius: 12,
      background: checked ? `${theme.accent}28` : inputBg,
      border: `${checked ? 3 : 1.5}px solid ${checked ? theme.accent : cardBdr}`,
      boxShadow: checked ? `0 4px 14px ${theme.accent}40` : 'none',
      color: theme.fg, fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left',
      transition: 'all .12s ease',
      fontWeight: checked ? 800 : 600,
    }}>
      <Indicator checked={checked} mode={mode} accent={theme.accent} cardBdr={cardBdr}/>
      <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{label}</span>
      {priceLabel && (
        <span style={{ fontSize: 13, fontWeight: 700, color: priceColor }}>{priceLabel}</span>
      )}
    </button>
  );
}

// Rich variant row — image, name, description, allergen pill, absolute price.
function VariantRow({ variant, active, price, onClick, theme, cardBdr, inputBg, is86 = false }) {
  const allergens = variant.allergens || [];
  return (
    <button onClick={is86 ? undefined : onClick} disabled={is86}
      className={is86 ? undefined : 'op-btn'}
      style={{
      width: '100%', display: 'flex', alignItems: 'stretch', gap: 0,
      padding: 0, borderRadius: 12, overflow: 'hidden',
      background: active ? `${theme.accent}28` : inputBg,
      border: `${active ? 3 : 1.5}px solid ${active ? theme.accent : cardBdr}`,
      boxShadow: active ? `0 4px 14px ${theme.accent}40` : 'none',
      color: theme.fg, fontFamily: 'inherit',
      cursor: is86 ? 'not-allowed' : 'pointer',
      opacity: is86 ? 0.5 : 1,
      filter: is86 ? 'grayscale(0.6)' : undefined,
      textAlign: 'left',
      transition: 'all .12s ease',
      position: 'relative',
    }}>
      {is86 && (
        <div style={{
          position: 'absolute', top: 8, right: 10, zIndex: 2,
          padding: '3px 8px', borderRadius: 99,
          background: '#1a1a1ad9', color: '#fff',
          fontSize: 9, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>Out of stock</div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 0 12px 14px' }}>
        <Indicator checked={active} mode="single" accent={theme.accent} cardBdr={cardBdr}/>
      </div>
      <div style={{ flex: 1, minWidth: 0, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, flex: 1, minWidth: 0 }}>{variant.menu_name || variant.name}</span>
          <span style={{ fontSize: 14, fontWeight: 800 }}>£{price.toFixed(2)}</span>
        </div>
        {variant.description && (
          <div style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.45,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>
            {variant.description}
          </div>
        )}
        {allergens.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
            <span style={{
              padding: '1px 7px', borderRadius: 99,
              background: '#fde6e6', color: '#991b1b',
              fontSize: 10, fontWeight: 700, textTransform: 'capitalize',
            }}>⚠ {allergens.length === 1 ? allergens[0] : `${allergens.length} allergens`}</span>
          </div>
        )}
      </div>
      {variant.image && (
        <div style={{
          width: 92, flexShrink: 0,
          backgroundImage: `url(${variant.image})`,
          backgroundSize: 'cover', backgroundPosition: 'center',
        }}/>
      )}
    </button>
  );
}

// Quantity-mode option row — +/- stepper, current count.
function QtyOptionRow({ option, count, canAdd, onInc, onDec, theme, cardBdr, inputBg }) {
  const px = Number(option.price) || 0;
  return (
    <div style={{
      width: '100%', display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 14px', borderRadius: 12,
      background: count > 0 ? `${theme.accent}28` : inputBg,
      border: `${count > 0 ? 3 : 1.5}px solid ${count > 0 ? theme.accent : cardBdr}`,
      boxShadow: count > 0 ? `0 4px 14px ${theme.accent}40` : 'none',
      color: theme.fg, fontFamily: 'inherit',
    }}>
      <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{option.name || option.label}</span>
      {px > 0 && (
        <span style={{ fontSize: 12, fontWeight: 700, opacity: 0.7 }}>+£{px.toFixed(2)}</span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={onDec} disabled={count === 0} style={{
          width: 30, height: 30, borderRadius: '50%', border: 'none',
          background: count === 0 ? `${theme.fg}10` : theme.fg,
          color: count === 0 ? `${theme.fg}40` : theme.bg,
          fontSize: 18, fontWeight: 800, cursor: count === 0 ? 'not-allowed' : 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'inherit',
        }}>−</button>
        <span style={{ minWidth: 16, textAlign: 'center', fontSize: 14, fontWeight: 800 }}>{count}</span>
        <button onClick={onInc} disabled={!canAdd} style={{
          width: 30, height: 30, borderRadius: '50%', border: 'none',
          background: canAdd ? theme.accent : `${theme.fg}10`,
          color: canAdd ? '#0b0c10' : `${theme.fg}40`,
          fontSize: 18, fontWeight: 800, cursor: canAdd ? 'pointer' : 'not-allowed',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'inherit',
        }}>+</button>
      </div>
    </div>
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
