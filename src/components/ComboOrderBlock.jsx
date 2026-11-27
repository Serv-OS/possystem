import { useState } from 'react';
import { money } from '../lib/currency';
import { ALLERGENS } from '../data/seed';
import { Icon } from './ServOSIcons';
import { COMBO_WORDS } from '../lib/combo';

// ══════════════════════════════════════════════════════════════════════════════
// ComboOrderBlock: a Combo in the POS order panel (5.12.123, stage 1). ONE block: the Combo
// and what it comes to, its picks under it (no price unless a pick adds something), and the
// actions that exist for a Combo: Remove or Void the whole thing, move it to a seat, take its
// discount off, another the same. There is no quantity stepper (every unit is its own pick) and
// no way to void, discount or move one pick: lib/combo.js, and the store, treat it as one.
// A pick can still be changed while the Combo has not gone to the kitchen: its own options
// (Change), its note, and its course (kitchen timing only).
// ══════════════════════════════════════════════════════════════════════════════

const COURSES = {
  0: { label: 'Immediate', color: '#22d3ee', bg: 'rgba(34,211,238,.1)' },
  1: { label: 'Course 1', color: '#22c55e', bg: 'rgba(34,197,94,.1)' },
  2: { label: 'Course 2', color: '#3b82f6', bg: 'rgba(59,130,246,.1)' },
  3: { label: 'Course 3', color: '#e8a020', bg: 'rgba(232,160,32,.1)' },
};

// What a line charges after its own discount (the same maths as the order panel's other lines).
const charged = (l) => {
  const base = (Number(l.price) || 0) * (Number(l.qty) || 1);
  const d = l.discount;
  if (!d) return base;
  return d.type === 'percent' ? base * (1 - d.value / 100) : Math.max(0, base - d.value);
};

export default function ComboOrderBlock({
  block, namesOnly = false, hideCourses = false, flash = false, compact = false,
  orderType, covers = 1, seatList = [],
  canChange = () => false,
  onRemove, onVoid, onDuplicate, onSeat, onRemoveDiscount, onChangePick, onPickNote, onPickCourse,
}) {
  const { parent, picks } = block;
  const [showSeats, setShowSeats] = useState(false);
  const [noteFor, setNoteFor] = useState(null);       // the uid of the pick whose note is open
  const [noteVal, setNoteVal] = useState('');
  const [courseFor, setCourseFor] = useState(null);   // the uid of the pick whose course picker is open

  const all = [parent, ...picks];
  const live = all.filter(l => !l.voided);
  const voided = block.voided;
  const sent = block.sent;
  const full = live.reduce((s, l) => s + (Number(l.price) || 0) * (Number(l.qty) || 1), 0);
  const total = live.reduce((s, l) => s + charged(l), 0);
  const extras = full - (parent.voided ? 0 : (Number(parent.price) || 0));
  const discount = parent.discount || null;
  const showSeat = orderType === 'dine-in' && covers > 1;

  if (namesOnly) {
    return (
      <div data-line-uid={parent.uid} data-combo-id={block.comboId} className={flash ? 'line-flash' : undefined} style={{ padding:'4px 10px', borderBottom:'1px solid var(--bdr)', opacity: voided ? 0.4 : 1 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:8 }}>
          <span style={{ fontSize:11, fontWeight:700, color:'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flex:1 }}>
            {parent.menuName || parent.name}{voided && <span style={{ color:'var(--red)', marginLeft:4, fontSize:9 }}>VOID</span>}
          </span>
          <span style={{ fontSize:11, fontWeight:700, color:'var(--t2)', fontFamily:'var(--font-mono)', flexShrink:0 }}>{money(total)}</span>
        </div>
        {picks.map(p => (
          <div key={p.uid} data-line-uid={p.uid} style={{ fontSize:10.5, color:'var(--t3)', paddingLeft:10, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.name}</div>
        ))}
      </div>
    );
  }

  return (
    <div data-line-uid={parent.uid} data-combo-id={block.comboId} data-testid="combo-block" className={flash ? 'line-flash' : undefined} style={{
      background: voided ? 'rgba(239,68,68,.04)' : 'var(--bg2)',
      border:`1.5px solid ${voided ? 'var(--red-b)' : sent ? 'rgba(34,197,94,.2)' : 'var(--bdr)'}`,
      borderRadius:12, marginBottom:5, opacity: voided ? .55 : 1, overflow:'hidden', position:'relative',
    }}>
      <div style={{ position:'absolute', left:0, top:0, bottom:0, width:3, background: voided ? 'var(--red)' : sent ? 'var(--grn)' : 'var(--acc)', borderRadius:'12px 0 0 12px' }}/>

      <div style={{ padding: compact ? '6px 8px 6px 10px' : '9px 10px 9px 14px' }}>
        {/* The Combo and what it comes to */}
        <div style={{ display:'flex', justifyContent:'space-between', gap:8, alignItems:'flex-start' }}>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:13, fontWeight:700, lineHeight:1.3, color: voided ? 'var(--red)' : 'var(--t1)', textDecoration: voided ? 'line-through' : 'none', display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
              {parent.name}
              <span style={{ fontSize:9, fontWeight:800, padding:'1px 5px', borderRadius:4, background:'var(--acc-d)', color:'var(--acc)', border:'1px solid var(--acc-b)', letterSpacing:.04 }}>COMBO</span>
              {voided && <span style={{ fontSize:9, fontWeight:800, padding:'1px 5px', borderRadius:4, background:'var(--red-d)', color:'var(--red)', letterSpacing:.04 }}>VOIDED</span>}
            </div>
            {!voided && extras > 0.004 && (
              <div data-testid="combo-block-extras" style={{ fontSize:10.5, color:'var(--t4)', marginTop:1, fontFamily:'var(--font-mono)' }}>{money(parent.price)} + {money(extras)} extras</div>
            )}
          </div>
          <div style={{ textAlign:'right', flexShrink:0 }}>
            <div data-testid="combo-block-total" style={{ fontSize:15, fontWeight:800, color: voided ? 'var(--red)' : discount ? 'var(--grn)' : 'var(--t1)', fontFamily:'var(--font-mono)', textDecoration: voided ? 'line-through' : 'none' }}>{money(voided ? all.reduce((s, l) => s + (Number(l.price) || 0) * (Number(l.qty) || 1), 0) : total)}</div>
            {discount && !voided && <div style={{ fontSize:10, color:'var(--t4)', textDecoration:'line-through', fontFamily:'var(--font-mono)' }}>{money(full)}</div>}
          </div>
        </div>

        {/* Its picks, each a real product on its own kitchen line */}
        <div style={{ marginTop:6, display:'flex', flexDirection:'column', gap:3 }}>
          {picks.map(p => {
            const pickVoided = p.voided || p.status === 'voided';
            const pickSent = p.status === 'sent';
            const editable = !voided && !sent && !pickVoided;
            const cc = COURSES[p.course] || COURSES[1];
            return (
              <div key={p.uid} data-line-uid={p.uid} data-testid="combo-block-pick" style={{ padding:'5px 8px', borderRadius:8, background:'var(--bg3)', border:'1px solid var(--bdr)' }}>
                <div style={{ display:'flex', alignItems:'flex-start', gap:6 }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:12, fontWeight:600, color: pickVoided ? 'var(--red)' : 'var(--t1)', lineHeight:1.3, textDecoration: pickVoided ? 'line-through' : 'none' }}>{p.name}</div>
                    {(p.mods || []).map((m, i) => (
                      <div key={i} style={{ fontSize:11, color:'var(--t3)', marginTop:1, display:'flex', justifyContent:'space-between', gap:6, fontStyle: m._instruction ? 'italic' : 'normal' }}>
                        <span>{m.label}</span>
                        {m.price > 0 && <span style={{ color:'var(--acc)', fontFamily:'var(--font-mono)' }}>+{money(m.price)}</span>}
                      </div>
                    ))}
                    {p.notes && noteFor !== p.uid && (
                      <div style={{ fontSize:11, color:'#f97316', marginTop:1, fontStyle:'italic' }}><Icon name="note" size={11} style={{ display:'inline-block', verticalAlign:'-2px', marginRight:4 }}/>{p.notes}</div>
                    )}
                    {p.allergens?.length > 0 && !pickVoided && (
                      <div style={{ fontSize:10, color:'var(--red)', marginTop:2, fontWeight:600, display:'flex', alignItems:'center', gap:4 }}><Icon name="warn" size={10}/>{p.allergens.map(a => ALLERGENS.find(x => x.id === a)?.label).filter(Boolean).join(' · ')}</div>
                    )}
                  </div>
                  {/* A pick shows a price only when it adds one: a bump, an option, or its own kept price. */}
                  {(Number(p.price) || 0) > 0 && (
                    <div style={{ fontSize:12, fontWeight:700, fontFamily:'var(--font-mono)', color:'var(--acc)', flexShrink:0 }}>{p.comboKeepsPrice ? money(p.price) : `+${money(p.price)}`}</div>
                  )}
                </div>
                {editable && (
                  <div style={{ display:'flex', gap:4, marginTop:4, flexWrap:'wrap', alignItems:'center' }}>
                    {canChange(p) && (
                      <button onClick={() => onChangePick?.(p)} data-testid="combo-block-change" style={{ height:26, padding:'0 9px', borderRadius:6, cursor:'pointer', fontFamily:'inherit', fontSize:10.5, fontWeight:800, background:'rgba(245,166,35,.14)', border:'1px solid rgba(245,166,35,.45)', color:'var(--amber, #F5A623)' }}>Change</button>
                    )}
                    <button onClick={() => { setNoteVal(p.notes || ''); setNoteFor(noteFor === p.uid ? null : p.uid); }} style={{ height:26, padding:'0 9px', borderRadius:6, cursor:'pointer', fontFamily:'inherit', fontSize:10.5, fontWeight:700, background:'transparent', border:'1px dashed var(--bdr2)', color:'var(--t3)', display:'inline-flex', alignItems:'center', gap:4 }}>
                      <Icon name="note" size={11}/>{p.notes ? 'Note' : 'Add note'}
                    </button>
                    {!hideCourses && (
                      <button onClick={() => setCourseFor(courseFor === p.uid ? null : p.uid)} style={{ height:26, padding:'0 9px', borderRadius:6, cursor:'pointer', fontFamily:'inherit', fontSize:10.5, fontWeight:700, background:cc.bg, border:`1px solid ${cc.color}44`, color:cc.color }}>{cc.label}</button>
                    )}
                  </div>
                )}
                {!editable && pickSent && !pickVoided && !hideCourses && (
                  <div style={{ marginTop:3 }}><span style={{ fontSize:9.5, fontWeight:700, padding:'1px 6px', borderRadius:5, background:cc.bg, border:`1px solid ${cc.color}44`, color:cc.color }}>{p.fired ? cc.label : `${cc.label} · held`}</span></div>
                )}
                {editable && noteFor === p.uid && (
                  <div style={{ marginTop:5 }}>
                    <input autoFocus value={noteVal} onChange={e => setNoteVal(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { onPickNote?.(p, noteVal); setNoteFor(null); } if (e.key === 'Escape') setNoteFor(null); }}
                      placeholder="No basil, well done, allergy note…"
                      style={{ width:'100%', background:'var(--bg4)', border:'1.5px solid var(--acc-b)', borderRadius:7, padding:'5px 9px', color:'var(--t1)', fontSize:12, fontFamily:'inherit', outline:'none' }}/>
                    <div style={{ display:'flex', gap:5, marginTop:4 }}>
                      <button onClick={() => { onPickNote?.(p, noteVal); setNoteFor(null); }} style={{ flex:1, height:26, borderRadius:6, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:11, fontWeight:800 }}>Save</button>
                      <button onClick={() => setNoteFor(null)} style={{ flex:1, height:26, borderRadius:6, cursor:'pointer', fontFamily:'inherit', background:'var(--bg4)', border:'1px solid var(--bdr)', color:'var(--t3)', fontSize:11 }}>Cancel</button>
                    </div>
                  </div>
                )}
                {editable && courseFor === p.uid && !hideCourses && (
                  <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginTop:5 }}>
                    {Object.entries(COURSES).map(([c, v]) => (
                      <button key={c} onClick={() => { onPickCourse?.(p, parseInt(c)); setCourseFor(null); }} style={{ padding:'4px 10px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', fontSize:11, fontWeight:700, background: p.course === parseInt(c) ? v.bg : 'var(--bg4)', border:`1.5px solid ${p.course === parseInt(c) ? v.color : 'var(--bdr)'}`, color: p.course === parseInt(c) ? v.color : 'var(--t3)' }}>{v.label}</button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* The Combo's discount (it covers the whole Combo) */}
        {discount && !voided && (
          <div style={{ display:'flex', alignItems:'center', gap:5, marginTop:6 }}>
            <span style={{ fontSize:11, color:'var(--grn)', fontWeight:600, display:'inline-flex', alignItems:'center', gap:4 }}><Icon name="tag" size={11}/>{discount.label}</span>
            <span style={{ fontSize:11, color:'var(--grn)', fontFamily:'var(--font-mono)' }}>−{money(full - total)}</span>
            <button onClick={onRemoveDiscount} aria-label="Take the discount off this Combo" style={{ fontSize:11, color:'var(--t4)', background:'none', border:'none', cursor:'pointer', fontFamily:'inherit', lineHeight:1 }}>✕</button>
          </div>
        )}

        {/* Tags: the seat the whole Combo sits at, and sent */}
        {!voided && (showSeat || sent) && (
          <div style={{ display:'flex', gap:4, marginTop:6, flexWrap:'wrap' }}>
            {showSeat && (
              <button onClick={() => setShowSeats(s => !s)} style={{ fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:5, background:'var(--acc-d)', border:'1px solid var(--acc-b)', color:'var(--acc)', cursor:'pointer', fontFamily:'inherit' }}>
                {parent.seat === 'shared' || parent.seat == null ? 'Shared' : `Seat ${parent.seat}`}
              </button>
            )}
            {sent && <span style={{ fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:5, background:'var(--grn-d)', border:'1px solid var(--grn-b)', color:'var(--grn)' }}>✓ Sent</span>}
          </div>
        )}
        {showSeats && !voided && showSeat && (
          <div style={{ marginTop:8, padding:10, background:'var(--bg3)', borderRadius:10, border:'1px solid var(--bdr)' }}>
            <div style={{ fontSize:9, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:6 }}>Move the whole Combo to seat</div>
            <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
              {seatList.map(s => (
                <button key={s} onClick={() => { onSeat?.(s); setShowSeats(false); }} style={{ padding:'4px 10px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', fontSize:11, fontWeight:700, background: parent.seat === s ? 'var(--acc-d)' : 'var(--bg4)', border:`1.5px solid ${parent.seat === s ? 'var(--acc)' : 'var(--bdr)'}`, color: parent.seat === s ? 'var(--acc)' : 'var(--t3)' }}>
                  {s === 'shared' ? 'Shared' : `S${s}`}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* The whole Combo: another the same, and Remove (not sent) or Void (sent, needs a manager) */}
        {!voided && (
          <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:8 }}>
            <button onClick={onDuplicate} title={COMBO_WORDS.qty} data-testid="combo-block-again" style={{ height:28, padding:'0 10px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', fontSize:11, fontWeight:700, background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t2)', display:'inline-flex', alignItems:'center', gap:5 }}>
              <Icon name="plus" size={11}/>Another the same
            </button>
            <div style={{ marginLeft:'auto', display:'flex', gap:6 }}>
              {sent ? (
                <button onClick={onVoid} data-testid="combo-block-void" style={{ height:28, padding:'0 10px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', fontSize:11, fontWeight:700, background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)' }}>Void Combo</button>
              ) : (
                <button onClick={onRemove} data-testid="combo-block-remove" style={{ height:28, padding:'0 10px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', fontSize:11, fontWeight:700, background:'var(--bg4)', border:'1px solid var(--bdr)', color:'var(--t3)' }}>Remove Combo</button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
