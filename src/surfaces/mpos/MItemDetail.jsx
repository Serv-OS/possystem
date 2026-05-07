// MItemDetail — full-screen modifier flow + qty stepper.
// Maps the item's assignedModifierGroups to the location's modifierGroupDefs
// and walks the user through each group. Min/max constraints enforce required
// picks before "Add to order" enables.
//
// Notes field at the bottom captures special instructions ("no onion", "extra
// crispy"). On add: calls store.addItem(item, modsArray, null, { qty, notes })
// — the existing helper routes to walkInOrder or activeTableId automatically.

import { useState, useMemo } from 'react';
import { useStore } from '../../store';
import { Sx, money } from './MShellStyles';

export default function MItemDetail({ item, onClose, onAdded }) {
  const { addItem, modifierGroupDefs = [] } = useStore();
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState('');
  // selectedMods: { [groupId]: [{ id, name, price, groupLabel, ... }] }
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

  // Sum of selected modifier surcharges (base of all selected options × qty)
  const modSurcharge = useMemo(() => {
    return Object.values(selectedMods).flat().reduce((s, m) => s + (Number(m.price) || 0), 0);
  }, [selectedMods]);

  const linePrice = (basePrice + modSurcharge) * qty;

  const togglePick = (group, opt) => {
    setSelectedMods(prev => {
      const current = prev[group.id] || [];
      const exists = current.find(m => m.id === opt.id);
      if (exists) {
        // Tapping a selected option removes it (only if min isn't already breached)
        return { ...prev, [group.id]: current.filter(m => m.id !== opt.id) };
      }
      // Single-select group → replace
      if (group.max === 1) {
        return { ...prev, [group.id]: [{ ...opt, groupLabel: group.name }] };
      }
      // Multi-select up to max
      if (current.length >= group.max) return prev;
      return { ...prev, [group.id]: [...current, { ...opt, groupLabel: group.name }] };
    });
  };

  // Required-group validation
  const missingRequired = useMemo(() => {
    return groups.filter(g => g.min > 0 && (selectedMods[g.id] || []).length < g.min);
  }, [groups, selectedMods]);

  const canAdd = missingRequired.length === 0 && qty > 0;

  const handleAdd = () => {
    if (!canAdd) return;
    const flatMods = Object.values(selectedMods).flat();
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

        {/* Modifier groups */}
        {groups.map(group => {
          const picks = selectedMods[group.id] || [];
          const minMet = picks.length >= group.min;
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
                  {group.min > 0 ? (group.min === group.max ? `Pick ${group.min}` : `Pick ${group.min}–${group.max}`) : (group.max > 1 ? `Up to ${group.max}` : 'Optional')}
                </div>
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                {group.options.map(opt => {
                  const selected = picks.some(m => m.id === opt.id);
                  return (
                    <button key={opt.id} onClick={() => togglePick(group, opt)} style={{
                      width:'100%', padding:'12px 14px', borderRadius:11, fontFamily:'inherit', cursor:'pointer',
                      border:`1.5px solid ${selected ? 'var(--acc)' : 'var(--bdr)'}`,
                      background: selected ? 'var(--acc-d)' : 'var(--bg2)',
                      color:'var(--t1)',
                      display:'flex', alignItems:'center', gap:10, textAlign:'left', minHeight:48,
                    }}>
                      <div style={{
                        width:20, height:20, borderRadius: group.max === 1 ? '50%' : 5,
                        border:`2px solid ${selected ? 'var(--acc)' : 'var(--bdr2)'}`,
                        background: selected ? 'var(--acc)' : 'transparent',
                        display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0,
                      }}>
                        {selected && <span style={{ color:'#0b0c10', fontSize:14, fontWeight:800, lineHeight:1 }}>✓</span>}
                      </div>
                      <span style={{ flex:1, fontSize:13, fontWeight:600 }}>{opt.name}</span>
                      {opt.price > 0 && (
                        <span style={{ fontSize:12, color:'var(--t3)', fontFamily:'var(--font-mono)', flexShrink:0 }}>+{money(opt.price)}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Notes */}
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

        <div style={{ height:120 }}/> {/* bottom-bar spacer */}
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
