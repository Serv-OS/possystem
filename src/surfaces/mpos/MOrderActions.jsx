// MOrderActions — bottom sheet ⋯ menu on the cart for actions that apply to
// the whole order rather than a single line. Mirrors the desktop POS:
//   • Apply order-level discount (Staff meal, Loyalty, NHS, Happy hour, Comp)
//   • Fire a held course (course 2 / 3) to the kitchen now
//   • Transfer table → another table (dine-in only)
//   • Edit order note
//   • Print docket (re-fires the kitchen ticket)
//
// Comp / large discounts and table transfers will gate behind MManagerPin
// when 1D ships that. For now they fall back to the current staff (same
// pattern as MItemActions void).

import { useState } from 'react';
import { useStore } from '../../store';
import { Sx, money } from './MShellStyles';
import MManagerPin, { getCachedManagerAuth } from './MManagerPin';

// Same preset ladder as MItemActions / DiscountModal. Keeps line / order
// discount UI consistent.
const DISCOUNTS = [
  { id:'staff50', label:'Staff meal',     type:'percent', value:50 },
  { id:'staff_d', label:'Staff drinks',   type:'percent', value:50 },
  { id:'loyalty', label:'Loyalty 10%',    type:'percent', value:10 },
  { id:'nhs',     label:'NHS / Blue Light', type:'percent', value:10 },
  { id:'happy',   label:'Happy hour 20%', type:'percent', value:20 },
  { id:'comp',    label:'Comp (100%)',    type:'percent', value:100, requiresManager:true },
];

export default function MOrderActions({ onClose, onTransferTable, onEditNote }) {
  const {
    activeTableId, tables, walkInOrder, staff,
    addCheckDiscount, removeCheckDiscount, addWalkInDiscount, removeWalkInDiscount,
    fireCourse,
  } = useStore();
  const [view, setView] = useState('main'); // main | discount | fire
  const [pendingManagerDiscount, setPendingManagerDiscount] = useState(null);

  const isTable = !!activeTableId;
  const session = isTable ? tables.find(t => t.id === activeTableId)?.session : null;
  const orderDiscounts = isTable ? (session?.discounts || []) : (walkInOrder?.discounts || []);

  // Held courses (sessions only — walk-ins fire everything on send)
  const heldCourses = (() => {
    if (!session) return [];
    const fired = new Set(session.firedCourses || []);
    const all = new Set((session.items || []).filter(i => !i.voided).map(i => i.course ?? 1));
    return [...all].filter(c => !fired.has(c)).sort((a, b) => a - b);
  })();

  const close = () => onClose?.();

  // ── Apply / remove order-level discount ──────────────────────────────────
  const commitDiscount = (d, manager) => {
    const entry = {
      id: `${d.id}-${Date.now()}`,
      label: d.label, type: d.type, value: d.value,
      appliedBy: manager?.name || staff?.name || 'MPOS',
    };
    if (isTable) addCheckDiscount(activeTableId, entry);
    else addWalkInDiscount(entry);
    close();
  };
  const applyDiscount = (d) => {
    if (d.requiresManager) {
      const cached = getCachedManagerAuth();
      if (cached) { commitDiscount(d, cached); return; }
      setPendingManagerDiscount(d);
      return;
    }
    commitDiscount(d);
  };
  const clearDiscount = (id) => {
    if (isTable) removeCheckDiscount(activeTableId, id);
    else removeWalkInDiscount(id);
  };

  // ── Fire course (table only) ─────────────────────────────────────────────
  const doFireCourse = (courseNum) => {
    fireCourse?.(courseNum);
    close();
  };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.55)', zIndex:60, display:'flex', alignItems:'flex-end' }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width:'100%', maxWidth:540, margin:'0 auto', background:'var(--bg1)', borderRadius:'18px 18px 0 0',
        padding:'14px 14px calc(18px + env(safe-area-inset-bottom)) 14px',
        boxShadow:'0 -10px 32px rgba(0,0,0,.45)', maxHeight:'88svh', overflowY:'auto',
      }}>
        <div style={{ width:36, height:4, borderRadius:2, background:'var(--bdr2)', margin:'0 auto 14px' }}/>

        {view === 'main' && (
          <>
            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:11, color:'var(--t4)', fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em' }}>Order actions</div>
              <div style={{ fontSize:16, fontWeight:800, color:'var(--t1)', marginTop:2 }}>
                {isTable ? `Table ${tables.find(t => t.id === activeTableId)?.label}` : 'Walk-in order'}
              </div>
            </div>

            {/* Active order-level discounts */}
            {orderDiscounts.length > 0 && (
              <div style={{ marginBottom:14, padding:'10px 12px', borderRadius:11, background:'var(--grn-d)', border:'1px solid var(--grn-b)' }}>
                <div style={{ fontSize:11, color:'var(--grn)', fontWeight:800, textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6 }}>
                  Active discounts
                </div>
                {orderDiscounts.map(d => (
                  <div key={d.id} style={{ display:'flex', alignItems:'center', gap:8, marginTop:4 }}>
                    <span style={{ flex:1, fontSize:13, color:'var(--t1)', fontWeight:700 }}>{d.label} · −{d.value}%</span>
                    <button onClick={() => clearDiscount(d.id)} style={{
                      padding:'4px 8px', borderRadius:7, border:'1px solid var(--red-b)', background:'transparent',
                      color:'var(--red)', fontSize:11, fontWeight:700, fontFamily:'inherit', cursor:'pointer',
                    }}>Remove</button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              <ActionRow icon="💸" label="Apply order discount" sub="Discount the whole order, not a single item" onClick={() => setView('discount')} />
              {isTable && heldCourses.length > 0 && (
                <ActionRow icon="🔥" label={`Fire course ${heldCourses[0]}`} sub={`${heldCourses.length} course${heldCourses.length === 1 ? '' : 's'} held — tap to fire`} onClick={() => setView('fire')} />
              )}
              {isTable && (
                <ActionRow icon="↔" label="Transfer to another table" sub="Move this session and its items to a different table" onClick={() => { close(); onTransferTable?.(); }} />
              )}
              <ActionRow icon="📝" label="Edit order note" sub="Kitchen-bound note for the whole order" onClick={() => { close(); onEditNote?.(); }} />
              <button onClick={close} style={{ ...Sx.btnGhost, marginTop:6 }}>Cancel</button>
            </div>
          </>
        )}

        {view === 'discount' && (
          <div>
            <div style={{ fontSize:13, fontWeight:800, color:'var(--t1)', marginBottom:8 }}>Apply discount to the whole order</div>
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {DISCOUNTS.map(d => (
                <button key={d.id} onClick={() => applyDiscount(d)} style={{
                  padding:'12px 14px', borderRadius:11, fontFamily:'inherit', cursor:'pointer',
                  border:'1.5px solid var(--bdr)', background:'var(--bg2)',
                  display:'flex', alignItems:'center', gap:10, textAlign:'left', minHeight:48,
                }}>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>{d.label}</div>
                    {d.requiresManager && (
                      <div style={{ fontSize:10, color:'var(--acc)', fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em', marginTop:2 }}>
                        Manager PIN required
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize:13, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>−{d.value}%</div>
                </button>
              ))}
            </div>
            <button onClick={() => setView('main')} style={{ ...Sx.btnGhost, marginTop:10 }}>← Back</button>
          </div>
        )}

        {view === 'fire' && (
          <div>
            <div style={{ fontSize:13, fontWeight:800, color:'var(--t1)', marginBottom:8 }}>Fire a held course</div>
            <div style={{ fontSize:12, color:'var(--t3)', marginBottom:10, lineHeight:1.4 }}>
              Sends a "FIRE COURSE N" marker docket to every production centre that has items in that course.
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {heldCourses.map(c => (
                <button key={c} onClick={() => doFireCourse(c)} style={{
                  padding:'14px 14px', borderRadius:11, fontFamily:'inherit', cursor:'pointer',
                  border:'1.5px solid var(--acc-b)', background:'var(--acc-d)',
                  display:'flex', alignItems:'center', gap:10, textAlign:'left',
                }}>
                  <div style={{ width:32, textAlign:'center', fontWeight:800, fontSize:14, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>{c}</div>
                  <div style={{ flex:1, fontSize:13, fontWeight:700, color:'var(--acc)' }}>Fire course {c} now</div>
                  <span style={{ fontSize:18, color:'var(--acc)' }}>🔥</span>
                </button>
              ))}
              {heldCourses.length === 0 && (
                <div style={{ padding:'14px 0', textAlign:'center', fontSize:12, color:'var(--t4)' }}>
                  No held courses — everything on this table is already fired.
                </div>
              )}
            </div>
            <button onClick={() => setView('main')} style={{ ...Sx.btnGhost, marginTop:10 }}>← Back</button>
          </div>
        )}
      </div>

      {pendingManagerDiscount && (
        <MManagerPin
          reason={`Approve ${pendingManagerDiscount.label} on ${isTable ? `Table ${tables.find(t => t.id === activeTableId)?.label}` : 'this order'}`}
          onApprove={(manager) => {
            const d = pendingManagerDiscount;
            setPendingManagerDiscount(null);
            commitDiscount(d, manager);
          }}
          onCancel={() => setPendingManagerDiscount(null)}
        />
      )}
    </div>
  );
}

function ActionRow({ icon, label, sub, onClick }) {
  return (
    <button onClick={onClick} style={{
      width:'100%', padding:'12px 14px', borderRadius:11,
      border:'1px solid var(--bdr)', background:'var(--bg2)',
      cursor:'pointer', fontFamily:'inherit', textAlign:'left',
      display:'flex', alignItems:'center', gap:12, minHeight:54,
    }}>
      <div style={{ fontSize:20, width:32, textAlign:'center', flexShrink:0 }}>{icon}</div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>{label}</div>
        {sub && <div style={{ fontSize:11, color:'var(--t3)', marginTop:1 }}>{sub}</div>}
      </div>
      <div style={{ fontSize:18, color:'var(--t4)' }}>›</div>
    </button>
  );
}
