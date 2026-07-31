// MItemActions — bottom sheet shown when a cart line is tapped. Surfaces the
// per-line actions Peter listed (course change, discount, void) without the
// swipe-left gesture work that lands in 1D. Sent items show only "Void"
// (manager-PIN gate is 1D — for now we trust the server until that ships).

import { useState } from 'react';
import { useStore } from '../../store';
import { Sx, money } from './MShellStyles';
import MManagerPin, { getCachedManagerAuth } from './MManagerPin';
import MBottomSheet from './MBottomSheet';

const COURSES = [
  { id:0, label:'Immediate' },
  { id:1, label:'Course 1' },
  { id:2, label:'Course 2' },
  { id:3, label:'Course 3' },
];

// Same preset ladder used by the desktop POS DiscountModal (compatible).
const DISCOUNTS = [
  { id:'staff50', label:'Staff meal',     type:'percent', value:50 },
  { id:'staff_d', label:'Staff drinks',   type:'percent', value:50 },
  { id:'loyalty', label:'Loyalty 10%',    type:'percent', value:10 },
  { id:'nhs',     label:'NHS / Blue Light', type:'percent', value:10 },
  { id:'happy',   label:'Happy hour 20%', type:'percent', value:20 },
  { id:'comp',    label:'Comp (100%)',    type:'percent', value:100, requiresManager:true },
];

export default function MItemActions({ item, onClose }) {
  const { activeTableId, staff, updateItemCourse, updateItemNote, addItemDiscount, removeItemDiscount, voidItem, removeItem } = useStore();
  // v5.5.961: profile can hide course management on this device
  const hideCourses = useStore(s => (s.deviceConfig?.hiddenFeatures || []).includes('courses'));
  const sent = item?.status === 'sent';
  const [view, setView] = useState('main'); // main | course | discount | note
  // Pending discount waiting on a manager PIN
  const [pendingManagerDiscount, setPendingManagerDiscount] = useState(null);
  // Editable copy of the item's note when the user enters the Edit notes view
  const [draftNote, setDraftNote] = useState(item?.notes || '');

  if (!item) return null;

  const close = () => onClose?.();

  // ── Action: change course ────────────────────────────────────────────────
  const pickCourse = (c) => {
    updateItemCourse?.(item.uid, c);
    close();
  };

  // ── Action: apply discount ───────────────────────────────────────────────
  const commitDiscount = (d) => {
    addItemDiscount(activeTableId || null, item.uid, { id:d.id, label:d.label, type:d.type, value:d.value });
    close();
  };
  const applyDiscount = (d) => {
    if (d.requiresManager) {
      // 90s grace window — fast-path if a manager has already approved recently
      const cached = getCachedManagerAuth();
      if (cached) { commitDiscount(d); return; }
      setPendingManagerDiscount(d);
      return;
    }
    commitDiscount(d);
  };

  const clearDiscount = () => {
    removeItemDiscount(activeTableId || null, item.uid);
    close();
  };

  // ── Action: void / remove ────────────────────────────────────────────────
  const doVoid = () => {
    if (!sent) {
      // Pending item — just remove it from the order. No void log needed.
      removeItem?.(item.uid);
      close();
      return;
    }
    // Sent item — must go through voidItem so the void log gets a row and the
    // KDS / printer pick up the void. The desktop POS gates this behind a
    // manager-PIN modal; until 1D ships, we use the current staff as the
    // approving party so the void doesn't crash on null.manager.
    if (!activeTableId) {
      // Walk-in items don't truly hit voidItem — the desktop POS only voids
      // table sessions. For walk-ins we fall back to remove (which still
      // restores the daily count via the existing branch in removeItem).
      removeItem?.(item.uid);
      close();
      return;
    }
    voidItem?.(activeTableId, item.uid, {
      manager: staff || { id:'mpos-system', name:'MPOS' },
      reason: 'voided from MPOS',
    });
    close();
  };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <>
    <MBottomSheet onClose={close} maxHeight="88vh">
      <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:11, color:'var(--t4)', fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em' }}>Item</div>
          <div style={{ fontSize:16, fontWeight:800, color:'var(--t1)', marginTop:2 }}>{item.qty} × {item.name}</div>
          {item.discount && (
            <div style={{ marginTop:6, fontSize:11, fontWeight:700, color:'var(--grn)', display:'inline-block', padding:'2px 8px', borderRadius:99, background:'var(--grn-d)', border:'1px solid var(--grn-b)' }}>
              {item.discount.label} · −{item.discount.value}%
            </div>
          )}
        </div>

        {view === 'main' && (
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {!sent && !hideCourses && <ActionRow icon="⏱" label="Change course" sub={`Currently course ${item.course ?? 1}`} onClick={() => setView('course')} />}
            <ActionRow icon="📝" label={item.notes ? 'Edit note' : 'Add note'} sub={item.notes || 'Special instruction for this item'} onClick={() => { setDraftNote(item.notes || ''); setView('note'); }} />
            <ActionRow icon="💸" label={item.discount ? 'Change discount' : 'Apply discount'} sub={item.discount ? `${item.discount.label} active` : 'Pick from preset list'} onClick={() => setView('discount')} />
            {item.discount && <ActionRow icon="✕" label="Remove discount" onClick={clearDiscount} />}
            <ActionRow icon={sent ? '🗑' : '−'} label={sent ? 'Void item' : 'Remove from order'} sub={sent ? 'Already sent — kitchen will be notified' : 'Pending only'} dangerous onClick={doVoid} />
            <button onClick={close} style={{ ...Sx.btnGhost, marginTop:8 }}>Cancel</button>
          </div>
        )}

        {view === 'course' && (
          <div>
            <div style={{ fontSize:13, fontWeight:800, color:'var(--t1)', marginBottom:8 }}>Move to course</div>
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {COURSES.map(c => {
                const active = (item.course ?? 1) === c.id;
                return (
                  <button key={c.id} onClick={() => pickCourse(c.id)} style={{
                    padding:'12px 14px', borderRadius:11, fontFamily:'inherit', cursor:'pointer',
                    border:`1.5px solid ${active ? 'var(--acc)' : 'var(--bdr)'}`,
                    background: active ? 'var(--acc-d)' : 'var(--bg2)',
                    color: active ? 'var(--acc)' : 'var(--t1)',
                    display:'flex', alignItems:'center', gap:10, textAlign:'left', minHeight:48,
                  }}>
                    <div style={{ width:28, textAlign:'center', fontWeight:800, fontFamily:'var(--font-mono)' }}>{c.id}</div>
                    <div style={{ flex:1, fontSize:13, fontWeight:700 }}>{c.label}</div>
                    {active && <span style={{ color:'var(--acc)' }}>✓</span>}
                  </button>
                );
              })}
            </div>
            <button onClick={() => setView('main')} style={{ ...Sx.btnGhost, marginTop:10 }}>← Back</button>
          </div>
        )}

        {view === 'note' && (
          <div>
            <div style={{ fontSize:13, fontWeight:800, color:'var(--t1)', marginBottom:4 }}>Note for {item.name}</div>
            <div style={{ fontSize:12, color:'var(--t3)', marginBottom:10, lineHeight:1.4 }}>
              Visible to the kitchen on the docket. Saving updates the line in the cart immediately.
            </div>
            <textarea
              value={draftNote} onChange={(e) => setDraftNote(e.target.value.slice(0, 200))}
              placeholder="e.g. no onion, well done, gluten-free"
              autoFocus
              style={{
                width:'100%', padding:'12px 14px', borderRadius:11, border:'1px solid var(--bdr2)',
                background:'var(--bg2)', color:'var(--t1)', fontSize:14, fontFamily:'inherit', outline:'none', boxSizing:'border-box',
                minHeight:96, resize:'vertical',
              }}/>
            <div style={{ fontSize:10, color:'var(--t4)', textAlign:'right', marginTop:4 }}>{draftNote.length}/200</div>
            <button
              onClick={() => { updateItemNote?.(item.uid, draftNote.trim()); close(); }}
              style={Sx.btnPrim}>
              Save note
            </button>
            <button onClick={() => setView('main')} style={{ ...Sx.btnGhost, marginTop:8 }}>← Back</button>
          </div>
        )}

        {view === 'discount' && (
          <div>
            <div style={{ fontSize:13, fontWeight:800, color:'var(--t1)', marginBottom:8 }}>Apply discount to this item</div>
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
      </MBottomSheet>

      {/* Manager-PIN gate when a discount needs approval */}
      {pendingManagerDiscount && (
        <MManagerPin
          reason={`Approve ${pendingManagerDiscount.label} on ${item.name}`}
          onApprove={() => {
            const d = pendingManagerDiscount;
            setPendingManagerDiscount(null);
            commitDiscount(d);
          }}
          onCancel={() => setPendingManagerDiscount(null)}
        />
      )}
    </>
  );
}

function ActionRow({ icon, label, sub, onClick, dangerous }) {
  return (
    <button onClick={onClick} style={{
      width:'100%', padding:'12px 14px', borderRadius:11,
      border:`1px solid ${dangerous ? 'var(--red-b)' : 'var(--bdr)'}`,
      background: dangerous ? 'var(--red-d)' : 'var(--bg2)',
      cursor:'pointer', fontFamily:'inherit', textAlign:'left',
      display:'flex', alignItems:'center', gap:12, minHeight:54,
    }}>
      <div style={{ fontSize:20, width:32, textAlign:'center', flexShrink:0 }}>{icon}</div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:14, fontWeight:700, color: dangerous ? 'var(--red)' : 'var(--t1)' }}>{label}</div>
        {sub && <div style={{ fontSize:11, color:'var(--t3)', marginTop:1 }}>{sub}</div>}
      </div>
      <div style={{ fontSize:18, color:'var(--t4)' }}>›</div>
    </button>
  );
}
