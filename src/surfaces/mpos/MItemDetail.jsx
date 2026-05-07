// MItemDetail — full-screen modifier flow + qty stepper.
//
// Two important behaviours that were broken in the first cut and are correct here:
//   • NESTED MODIFIERS — when an option has a subGroupId, the linked group is
//     revealed conditionally underneath that option (e.g. picking "Peppercorn"
//     surfaces "Sauce preference: Hot / On the side"). Picks in the sub-group
//     attach to the parent option's mods array so they fire to the kitchen with
//     the parent line.
//   • MULTI-PICK SAME OPTION — for groups with max > 1 the user can tap the
//     same option multiple times to add quantity (e.g. "Extra cheese × 3"). A
//     +/- counter appears next to picked options. Single-select groups (max=1)
//     keep radio behaviour.

import { useState, useMemo } from 'react';
import { useStore } from '../../store';
import { Sx, money } from './MShellStyles';

export default function MItemDetail({ item, onClose, onAdded }) {
  const { addItem, modifierGroupDefs = [] } = useStore();
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState('');
  // selectedMods shape: { [groupId]: [{ id, name, price, qty, groupLabel, subPicks: [...] }] }
  // qty allows the same option to be picked multiple times in multi-select groups.
  // subPicks holds picks made in the option's nested sub-group (if any).
  const [selectedMods, setSelectedMods] = useState({});

  const basePrice = item?.pricing?.base ?? item?.price ?? 0;

  const groups = useMemo(() => {
    const assigned = item?.assignedModifierGroups || [];
    return assigned.map(a => {
      const def = modifierGroupDefs.find(g => g.id === a.groupId);
      if (!def) return null;
      return {
        id: def.id,
        name: def.name,
        min: a.min ?? def.min ?? 0,
        max: a.max ?? def.max ?? 99,
        options: def.options || [],
      };
    }).filter(Boolean);
  }, [item, modifierGroupDefs]);

  // Total picks in a group (sum of qtys across options) — counts toward max
  const groupPickCount = (groupId) =>
    (selectedMods[groupId] || []).reduce((s, m) => s + (m.qty || 0), 0);

  // Add 1 to an option's qty (or insert it). Honours group.max across all picks.
  const addPick = (group, opt) => {
    setSelectedMods(prev => {
      const current = prev[group.id] || [];
      const existing = current.find(m => m.id === opt.id);
      const totalNow = current.reduce((s, m) => s + (m.qty || 0), 0);
      // Single-select: replace
      if (group.max === 1) {
        return { ...prev, [group.id]: [{ ...opt, qty:1, groupLabel:group.name, subPicks:[] }] };
      }
      // Multi-select: hit the cap?
      if (totalNow >= group.max) return prev;
      if (existing) {
        return {
          ...prev,
          [group.id]: current.map(m => m.id === opt.id ? { ...m, qty: (m.qty || 0) + 1 } : m),
        };
      }
      return {
        ...prev,
        [group.id]: [...current, { ...opt, qty:1, groupLabel:group.name, subPicks:[] }],
      };
    });
  };

  const removePick = (group, optId) => {
    setSelectedMods(prev => {
      const current = prev[group.id] || [];
      const existing = current.find(m => m.id === optId);
      if (!existing) return prev;
      if ((existing.qty || 0) > 1) {
        return {
          ...prev,
          [group.id]: current.map(m => m.id === optId ? { ...m, qty: m.qty - 1 } : m),
        };
      }
      return { ...prev, [group.id]: current.filter(m => m.id !== optId) };
    });
  };

  // Toggle a sub-group pick on an already-picked parent option
  const toggleSubPick = (groupId, parentOptId, subGroupDef, subOpt) => {
    setSelectedMods(prev => {
      const current = prev[groupId] || [];
      return {
        ...prev,
        [groupId]: current.map(m => {
          if (m.id !== parentOptId) return m;
          const subPicks = m.subPicks || [];
          const exists = subPicks.find(s => s.id === subOpt.id);
          if (subGroupDef.max === 1) {
            // radio for single-select sub-group
            return { ...m, subPicks: [{ ...subOpt, groupLabel: subGroupDef.name }] };
          }
          if (exists) return { ...m, subPicks: subPicks.filter(s => s.id !== subOpt.id) };
          if (subPicks.length >= subGroupDef.max) return m;
          return { ...m, subPicks: [...subPicks, { ...subOpt, groupLabel: subGroupDef.name }] };
        }),
      };
    });
  };

  // Sum modifier surcharges (option price × qty + sub-pick prices, all multiplied across picks)
  const modSurcharge = useMemo(() => {
    let total = 0;
    Object.values(selectedMods).flat().forEach(m => {
      const optPrice = Number(m.price) || 0;
      const subTotal = (m.subPicks || []).reduce((s, sp) => s + (Number(sp.price) || 0), 0);
      total += (optPrice + subTotal) * (m.qty || 0);
    });
    return total;
  }, [selectedMods]);

  const linePrice = (basePrice + modSurcharge) * qty;

  // Required-group validation
  const missingRequired = useMemo(() => {
    return groups.filter(g => g.min > 0 && groupPickCount(g.id) < g.min);
  }, [groups, selectedMods]);

  const canAdd = missingRequired.length === 0 && qty > 0;

  const handleAdd = () => {
    if (!canAdd) return;
    // Expand picks into a flat mods array for the store. Each "qty" of an option
    // becomes that many entries (so kitchen tickets show "× 3 Extra cheese"
    // correctly, and the line surcharge calculation stays right).
    const flatMods = [];
    Object.values(selectedMods).flat().forEach(m => {
      const subPickEntries = (m.subPicks || []).map(s => ({
        id: s.id, name: s.name, price: s.price || 0, label: s.name, groupLabel: s.groupLabel,
      }));
      const baseEntry = { id: m.id, name: m.name, price: m.price || 0, label: m.name, groupLabel: m.groupLabel };
      for (let i = 0; i < (m.qty || 1); i++) {
        flatMods.push(baseEntry);
        // Sub-picks attached once per parent-pick instance
        flatMods.push(...subPickEntries);
      }
    });
    addItem(item, flatMods, null, { qty, notes: notes.trim() || undefined });
    onAdded?.();
  };

  return (
    <div style={Sx.shell}>
      {/* Header */}
      <div style={Sx.header}>
        <button onClick={onClose} style={Sx.iconBtn} aria-label="Back">←</button>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={Sx.hTitle}>{item?.name}</div>
          {item?.allergens?.length > 0 && (
            <div style={{ ...Sx.hSub, color:'var(--red)' }}>⚠ {item.allergens.map(a => a.toUpperCase()).join(' · ')}</div>
          )}
        </div>
        <div style={{ fontSize:14, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>
          {money(basePrice)}
        </div>
      </div>

      {/* Body */}
      <div style={Sx.scroller}>
        {item?.description && (
          <div style={{ padding:'12px 16px', fontSize:13, color:'var(--t3)', lineHeight:1.5 }}>
            {item.description}
          </div>
        )}

        {groups.map(group => {
          const totalPicked = groupPickCount(group.id);
          const minMet = totalPicked >= group.min;
          const atMax = totalPicked >= group.max;
          const picks = selectedMods[group.id] || [];
          return (
            <div key={group.id} style={{ padding:'14px 14px 4px' }}>
              <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:8 }}>
                <div style={{ fontSize:13, fontWeight:800, color:'var(--t1)', flex:1 }}>{group.name}</div>
                <div style={{
                  fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:99, letterSpacing:'.05em',
                  background: group.min > 0 && !minMet ? 'var(--red-d)' : 'var(--bg3)',
                  color: group.min > 0 && !minMet ? 'var(--red)' : 'var(--t4)',
                  border: `1px solid ${group.min > 0 && !minMet ? 'var(--red-b)' : 'var(--bdr)'}`,
                }}>
                  {group.min > 0
                    ? (group.min === group.max ? `Pick ${group.min}` : `Pick ${group.min}–${group.max}`)
                    : (group.max > 1 ? `Up to ${group.max}` : 'Optional')}
                </div>
              </div>

              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                {group.options.map(opt => {
                  const pickedEntry = picks.find(m => m.id === opt.id);
                  const optQty = pickedEntry?.qty || 0;
                  const isSelected = optQty > 0;
                  const subGroupDef = opt.subGroupId
                    ? modifierGroupDefs.find(g => g.id === opt.subGroupId)
                    : null;
                  const isMultiSelect = group.max > 1;

                  return (
                    <div key={opt.id} style={{ display:'flex', flexDirection:'column' }}>
                      <button onClick={() => addPick(group, opt)} disabled={atMax && !isSelected && isMultiSelect} style={{
                        width:'100%', padding:'12px 14px', borderRadius:11, fontFamily:'inherit',
                        cursor: (atMax && !isSelected && isMultiSelect) ? 'not-allowed' : 'pointer',
                        border:`1.5px solid ${isSelected ? 'var(--acc)' : 'var(--bdr)'}`,
                        background: isSelected ? 'var(--acc-d)' : 'var(--bg2)',
                        color:'var(--t1)', opacity: (atMax && !isSelected && isMultiSelect) ? .5 : 1,
                        display:'flex', alignItems:'center', gap:10, textAlign:'left', minHeight:48,
                      }}>
                        {/* Indicator: radio for single-select, qty badge for multi */}
                        {isMultiSelect ? (
                          <div style={{
                            width:30, height:30, borderRadius:8,
                            border:`2px solid ${isSelected ? 'var(--acc)' : 'var(--bdr2)'}`,
                            background: isSelected ? 'var(--acc)' : 'transparent',
                            display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0,
                            color: isSelected ? '#0b0c10' : 'var(--t4)',
                            fontSize:13, fontWeight:800, fontFamily:'var(--font-mono)',
                          }}>
                            {optQty || '+'}
                          </div>
                        ) : (
                          <div style={{
                            width:20, height:20, borderRadius:'50%',
                            border:`2px solid ${isSelected ? 'var(--acc)' : 'var(--bdr2)'}`,
                            background: isSelected ? 'var(--acc)' : 'transparent',
                            display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0,
                          }}>
                            {isSelected && <span style={{ color:'#0b0c10', fontSize:14, fontWeight:800, lineHeight:1 }}>✓</span>}
                          </div>
                        )}
                        <span style={{ flex:1, fontSize:13, fontWeight:600 }}>
                          {opt.name}
                          {isMultiSelect && optQty > 1 && <span style={{ color:'var(--acc)', marginLeft:8, fontWeight:800 }}>× {optQty}</span>}
                        </span>
                        {opt.price > 0 && (
                          <span style={{ fontSize:12, color:'var(--t3)', fontFamily:'var(--font-mono)', flexShrink:0 }}>+{money(opt.price)}</span>
                        )}
                        {/* Decrement button — only on multi-select with picks */}
                        {isMultiSelect && isSelected && (
                          <span
                            role="button"
                            onClick={(e) => { e.stopPropagation(); removePick(group, opt.id); }}
                            style={{
                              width:30, height:30, borderRadius:8, border:'1px solid var(--red-b)',
                              background:'var(--red-d)', color:'var(--red)', display:'flex',
                              alignItems:'center', justifyContent:'center', flexShrink:0, fontWeight:800, fontSize:18,
                              cursor:'pointer', marginLeft:6,
                            }}>−</span>
                        )}
                      </button>

                      {/* Nested sub-group — revealed only when this option is picked */}
                      {isSelected && subGroupDef && (
                        <NestedSubGroup
                          parentName={opt.name}
                          subGroupDef={subGroupDef}
                          picks={pickedEntry?.subPicks || []}
                          onToggle={(subOpt) => toggleSubPick(group.id, opt.id, subGroupDef, subOpt)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Item-level note (different from order-level note) */}
        <div style={{ padding:'18px 14px 4px' }}>
          <div style={{ fontSize:13, fontWeight:800, color:'var(--t1)', marginBottom:6 }}>Special instructions</div>
          <textarea
            value={notes} onChange={(e) => setNotes(e.target.value.slice(0, 200))}
            placeholder="e.g. no onion, well done…"
            style={{
              width:'100%', padding:'10px 12px', borderRadius:10, border:'1px solid var(--bdr2)',
              background:'var(--bg2)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box',
              minHeight:64, resize:'vertical',
            }}/>
          <div style={{ fontSize:10, color:'var(--t4)', textAlign:'right', marginTop:2 }}>{notes.length}/200</div>
        </div>

        {/* Qty stepper */}
        <div style={{ padding:'14px 14px 24px' }}>
          <div style={{ fontSize:13, fontWeight:800, color:'var(--t1)', marginBottom:8 }}>Quantity</div>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:18 }}>
            <button onClick={() => setQty(q => Math.max(1, q - 1))} style={{ ...Sx.iconBtn, width:52, height:52, fontSize:24, fontWeight:800 }}>−</button>
            <div style={{ fontSize:34, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)', minWidth:64, textAlign:'center' }}>{qty}</div>
            <button onClick={() => setQty(q => Math.min(99, q + 1))} style={{ ...Sx.iconBtn, width:52, height:52, fontSize:24, fontWeight:800, background:'var(--acc-d)', color:'var(--acc)', borderColor:'var(--acc-b)' }}>+</button>
          </div>
        </div>

        <div style={{ height:120 }}/>
      </div>

      {/* Sticky add bar */}
      <div style={Sx.bottom}>
        {missingRequired.length > 0 && (
          <div style={{ padding:'8px 12px', marginBottom:8, borderRadius:10, background:'var(--red-d)', color:'var(--red)', fontSize:12, fontWeight:700, border:'1px solid var(--red-b)', textAlign:'center' }}>
            Pick {missingRequired.map(g => g.name).join(', ')} to continue
          </div>
        )}
        <button onClick={handleAdd} disabled={!canAdd} style={{
          ...Sx.btnPrim,
          opacity: canAdd ? 1 : .5, cursor: canAdd ? 'pointer' : 'not-allowed',
        }}>
          Add to order · {money(linePrice)}
        </button>
      </div>
    </div>
  );
}

// Nested sub-group (rendered inside a parent option when that option is picked).
// Indented and styled distinctly so the user knows it's tied to the parent.
function NestedSubGroup({ parentName, subGroupDef, picks, onToggle }) {
  return (
    <div style={{
      margin:'4px 0 0 16px', padding:'10px 12px',
      borderLeft:'2px solid var(--acc)', borderRadius:'0 11px 11px 0',
      background:'rgba(212,136,28,0.06)',
    }}>
      <div style={{ fontSize:11, fontWeight:700, color:'var(--acc)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:8 }}>
        {subGroupDef.name} · for {parentName}
      </div>
      <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
        {(subGroupDef.options || []).map(subOpt => {
          const selected = picks.some(p => p.id === subOpt.id);
          return (
            <button key={subOpt.id} onClick={() => onToggle(subOpt)} style={{
              width:'100%', padding:'8px 10px', borderRadius:8, fontFamily:'inherit',
              border:`1.5px solid ${selected ? 'var(--acc)' : 'var(--bdr2)'}`,
              background: selected ? 'var(--acc-d)' : 'var(--bg2)',
              cursor:'pointer', display:'flex', alignItems:'center', gap:8, textAlign:'left',
            }}>
              <div style={{
                width:16, height:16, borderRadius: subGroupDef.max === 1 ? '50%' : 4,
                border:`2px solid ${selected ? 'var(--acc)' : 'var(--bdr2)'}`,
                background: selected ? 'var(--acc)' : 'transparent', flexShrink:0,
                display:'flex', alignItems:'center', justifyContent:'center',
              }}>
                {selected && <span style={{ color:'#0b0c10', fontSize:11, fontWeight:800, lineHeight:1 }}>✓</span>}
              </div>
              <span style={{ flex:1, fontSize:12, color:'var(--t1)', fontWeight:600 }}>{subOpt.name}</span>
              {subOpt.price > 0 && (
                <span style={{ fontSize:11, color:'var(--t3)', fontFamily:'var(--font-mono)' }}>+{money(subOpt.price)}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
