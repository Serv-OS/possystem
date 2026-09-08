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
import MBottomSheet from './MBottomSheet';

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

export default function MOrderActions({ onClose }) {
  const {
    activeTableId, tables, walkInOrder, staff,
    addCheckDiscount, removeCheckDiscount, addWalkInDiscount, removeWalkInDiscount,
    fireCourse, transferTable, setOrderNote, showToast,
  } = useStore();
  const [view, setView] = useState('main'); // main | discount | fire | transfer | note
  // v5.8.21: the venue's OWN discounts from Back Office (discounts table, loaded
  // into store.discountPresets by SyncBridge), the same list the POS DiscountModal
  // shows. The ladder above was a hard-coded demo set, so anything a venue set up
  // in Back Office never appeared on the handset. Demo ladder stays as fallback.
  const venuePresets = useStore(s => s.discountPresets);
  const ladder = (venuePresets || []).filter(d => d && d.active !== false && Number(d.value) > 0).length
    ? [...venuePresets].filter(d => d && d.active !== false && Number(d.value) > 0)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
        .map(d => ({ id: d.id, label: d.label || d.name, type: d.type || 'percent', value: Number(d.value), requiresManager: !!d.requiresManager, scope: d.scope, categoryIds: d.categoryIds }))
    : DISCOUNTS;
  const [pendingManagerDiscount, setPendingManagerDiscount] = useState(null);

  const isTable = !!activeTableId;
  const session = isTable ? tables.find(t => t.id === activeTableId)?.session : null;
  const orderDiscounts = isTable ? (session?.discounts || []) : (walkInOrder?.discounts || []);

  // v5.5.961: profile can hide course management on this device
  const hideCourses = useStore(s => (s.deviceConfig?.hiddenFeatures || []).includes('courses'));

  // Held courses (sessions only — walk-ins fire everything on send)
  const heldCourses = (() => {
    if (!session || hideCourses) return [];
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
    <>
    <MBottomSheet onClose={close} maxHeight="88vh">
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
                <ActionRow icon="↔" label="Transfer to another table" sub="Move this session and its items to a different table" onClick={() => setView('transfer')} />
              )}
              <ActionRow icon="📝" label={isTable && session?.orderNote ? 'Edit order note' : 'Add order note'} sub={isTable && session?.orderNote ? session.orderNote : 'Kitchen-bound note for the whole order'} onClick={() => setView('note')} />
              <button onClick={close} style={{ ...Sx.btnGhost, marginTop:6 }}>Cancel</button>
            </div>
          </>
        )}

        {view === 'discount' && (
          <div>
            <div style={{ fontSize:13, fontWeight:800, color:'var(--t1)', marginBottom:8 }}>Apply discount to the whole order</div>
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {ladder.map(d => (
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

        {view === 'transfer' && (
          <TransferTableView
            currentTableId={activeTableId}
            tables={tables}
            onTransfer={(toId) => {
              transferTable(activeTableId, toId);
              showToast?.(`Transferred to Table ${tables.find(t => t.id === toId)?.label || toId}`, 'success');
              close();
            }}
            onBack={() => setView('main')}
          />
        )}

        {view === 'note' && (
          <NoteEditorView
            initialValue={isTable ? (session?.orderNote || '') : (walkInOrder?.orderNote || '')}
            onSave={(text) => { setOrderNote(text); close(); }}
            onBack={() => setView('main')}
          />
        )}
    </MBottomSheet>

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
    </>
  );
}

// Transfer-table view — list every available table at the location and let
// the server pick one. Excludes the current table and any with active sessions.
function TransferTableView({ currentTableId, tables, onTransfer, onBack }) {
  const targets = (tables || []).filter(t =>
    t.id !== currentTableId && t.status === 'available' && !t.session
  );
  return (
    <div>
      <div style={{ fontSize:13, fontWeight:800, color:'var(--t1)', marginBottom:4 }}>Transfer to another table</div>
      <div style={{ fontSize:12, color:'var(--t3)', marginBottom:10, lineHeight:1.4 }}>
        Move this open session and all items to an available table.
      </div>
      {targets.length === 0 ? (
        <div style={{ padding:'18px 8px', textAlign:'center', fontSize:12, color:'var(--t4)' }}>
          No available tables to transfer to. All tables are occupied or reserved.
        </div>
      ) : (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:6, maxHeight:'40svh', overflowY:'auto' }}>
          {targets.map(t => (
            <button key={t.id} onClick={() => onTransfer(t.id)} style={{
              padding:'14px 6px', borderRadius:11, fontFamily:'inherit', cursor:'pointer',
              border:'1.5px solid var(--bdr)', background:'var(--bg2)',
              display:'flex', flexDirection:'column', alignItems:'center', gap:2, minHeight:64,
            }}>
              <div style={{ fontSize:14, fontWeight:800, color:'var(--t1)' }}>{t.label}</div>
              {t.section && <div style={{ fontSize:10, color:'var(--t4)', textTransform:'capitalize' }}>{t.section}</div>}
            </button>
          ))}
        </div>
      )}
      <button onClick={onBack} style={{ ...Sx.btnGhost, marginTop:10 }}>← Back</button>
    </div>
  );
}

// Note editor view — edits the active order's orderNote (table session OR
// walk-in). 240-char cap, multi-line.
function NoteEditorView({ initialValue, onSave, onBack }) {
  const [text, setText] = useState(initialValue || '');
  return (
    <div>
      <div style={{ fontSize:13, fontWeight:800, color:'var(--t1)', marginBottom:4 }}>Order note</div>
      <div style={{ fontSize:12, color:'var(--t3)', marginBottom:10, lineHeight:1.4 }}>
        Visible to the kitchen on the docket. Use for allergy alerts, urgency, special arrangements.
      </div>
      <textarea
        value={text} onChange={(e) => setText(e.target.value.slice(0, 240))}
        placeholder="e.g. Allergy in party — gluten free; child's birthday, surprise dessert"
        autoFocus
        style={{
          width:'100%', padding:'12px 14px', borderRadius:11, border:'1px solid var(--bdr2)',
          background:'var(--bg2)', color:'var(--t1)', fontSize:14, fontFamily:'inherit', outline:'none', boxSizing:'border-box',
          minHeight:96, resize:'vertical',
        }}/>
      <div style={{ fontSize:10, color:'var(--t4)', textAlign:'right', marginTop:4 }}>{text.length}/240</div>
      <button onClick={() => onSave(text.trim())} style={Sx.btnPrim}>Save note</button>
      <button onClick={onBack} style={{ ...Sx.btnGhost, marginTop:8 }}>← Back</button>
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
