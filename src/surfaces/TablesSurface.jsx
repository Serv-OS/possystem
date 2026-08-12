import { useCompact } from '../lib/useCompact';
import { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useStore } from '../store';
import { toMin } from '../lib/bookings/optimiser.js';
import { resolveServiceCharge } from '../lib/serviceCharge';
import CheckSelectorModal from '../components/CheckSelectorModal';
import CustomerModal from '../components/CustomerModal';
import { money, currencySymbol } from '../lib/currency';

const STATUS = {
  available: { color:'#22c55e', bg:'rgba(34,197,94,.12)',  border:'rgba(34,197,94,.35)', label:'Available' },
  open:      { color:'#3b82f6', bg:'rgba(59,130,246,.12)', border:'rgba(59,130,246,.35)', label:'Open'      },
  seated:    { color:'#60a5fa', bg:'rgba(96,165,250,.10)', border:'rgba(96,165,250,.3)',  label:'Seated'    },
  occupied:  { color:'#e8a020', bg:'rgba(232,160,32,.14)', border:'rgba(232,160,32,.4)',  label:'Occupied'  },
  reserved:  { color:'#a855f7', bg:'rgba(168,85,247,.12)', border:'rgba(168,85,247,.35)', label:'Reserved'  },
};

function mins(ts) {
  if (!ts) return 0;
  const t = ts instanceof Date ? ts.getTime() : typeof ts === 'string' ? new Date(ts).getTime() : ts;
  return Math.floor((Date.now() - t) / 60000);
}
function fmt(ts) {
  const m = mins(ts);
  if (m < 0) return '0m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m/60)}h ${m%60}m`;
}

// ─── Seat Guests Modal ────────────────────────────────────────────────────────
function SeatModal({ table, onConfirm, onCancel }) {
  const { staff } = useStore();
  const [covers, setCovers]   = useState(Math.min(2, table.maxCovers));
  const [server, setServer]   = useState(staff?.name || '');
  const [note, setNote]       = useState('');
  return (
    <div className="modal-back">
      <div style={{ background:'var(--bg2)', border:'1px solid var(--bdr2)', borderRadius:20, width:'100%', maxWidth:380, padding:24, boxShadow:'var(--sh3)' }}>
        <div style={{ fontSize:17, fontWeight:700, marginBottom:4, color:'var(--t1)' }}>Seat guests · {table.label}</div>
        <div style={{ fontSize:12, color:'var(--t3)', marginBottom:20 }}>{table.maxCovers} cover max · {table.section} section</div>

        <div style={{ marginBottom:14 }}>
          <label style={L}>Covers</label>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <button onClick={()=>setCovers(c=>Math.max(1,c-1))} style={QB}>−</button>
            <span style={{ fontSize:22, fontWeight:700, minWidth:36, textAlign:'center', color:'var(--t1)' }}>{covers}</span>
            <button onClick={()=>setCovers(c=>Math.min(table.maxCovers,c+1))} style={QB}>+</button>
            <span style={{ fontSize:12, color:'var(--t3)', marginLeft:4 }}>of {table.maxCovers} max</span>
          </div>
        </div>

        <div style={{ marginBottom:14 }}>
          <label style={L}>Server</label>
          <input className="input" value={server} onChange={e=>setServer(e.target.value)} placeholder="Server name"/>
        </div>

        <div style={{ marginBottom:22 }}>
          <label style={L}>Table note <span style={{fontWeight:400,fontSize:10,color:'var(--t4)'}}>(optional)</span></label>
          <input className="input" value={note} onChange={e=>setNote(e.target.value)} placeholder="Birthday, allergy, VIP…"/>
        </div>

        <div style={{ display:'flex', gap:8 }}>
          <button className="btn btn-ghost" style={{ flex:1 }} onClick={onCancel}>Cancel</button>
          <button className="btn btn-acc" style={{ flex:2, height:46 }}
            onClick={()=>onConfirm({ covers, server:server||staff?.name||'Staff', note })}>
            Seat & open order →
          </button>
        </div>
      </div>
    </div>
  );
}
const L = { display:'block', fontSize:11, fontWeight:700, color:'var(--t2)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:8 };
const QB = { width:34, height:34, borderRadius:8, border:'1px solid var(--bdr2)', background:'var(--bg3)', color:'var(--t1)', fontSize:20, cursor:'pointer', fontFamily:'inherit', display:'flex', alignItems:'center', justifyContent:'center' };

// ─── Reservation Modal ────────────────────────────────────────────────────────
const TIME_SLOTS = [];
for (let h=11; h<=23; h++) {
  for (let m=0; m<60; m+=15) {
    const hh = h.toString().padStart(2,'0');
    const mm = m.toString().padStart(2,'0');
    TIME_SLOTS.push(`${hh}:${mm}`);
  }
}

function ReservationModal({ table, existing, onConfirm, onCancel }) {
  // v5.5.10: customer search + allergen auto-populate. When the operator types a
  // name or phone, the modal searches the customer DB live and shows matches.
  // Selecting a match fills name + phone AND prepends an allergen line to notes
  // (e.g. "⚠ ALLERGENS: dairy, nuts") so the kitchen sees it on the reservation
  // ticket. Same pattern as CustomerModal's search dropdown.
  const { searchCustomers, searchCustomersLive } = useStore();
  const now = new Date();
  const nearestSlot = TIME_SLOTS.find(t => {
    const [h,m] = t.split(':').map(Number);
    return h * 60 + m >= now.getHours() * 60 + now.getMinutes() + 15;
  }) || TIME_SLOTS[TIME_SLOTS.length - 1];

  const [name,      setName]     = useState(existing?.name      || '');
  const [phone,     setPhone]    = useState(existing?.phone     || '');
  const [partySize, setParty]    = useState(existing?.partySize || Math.min(2, table.maxCovers));
  const [time,      setTime]     = useState(existing?.time      || nearestSlot);
  const [notes,     setNotes]    = useState(existing?.notes     || '');
  const [date,      setDate]     = useState(existing?.date      || new Date().toLocaleDateString('en-CA')); // YYYY-MM-DD
  // v5.5.10: track if a customer was matched from search — passes through to
  // onConfirm so the callsite can skip the upsert+refetch dance (we already
  // have the full record including allergens + opt-in flag).
  const [selectedCustomer, setSelectedCustomer] = useState(existing?.customer || null);
  const [results,  setResults]  = useState([]);
  const [searched, setSearched] = useState(false);

  const ALLERGEN_MARKER = '⚠ ALLERGENS: ';
  const stripAllergenLine = (text) => (text || '')
    .split('\n').filter(l => !l.startsWith(ALLERGEN_MARKER)).join('\n').replace(/^\n+/, '');

  // Live search — mirrors CustomerModal's pattern. Triggers on 3+ chars in
  // either name or phone field. Local cache renders instantly, Supabase live
  // result merges in 250ms later.
  useEffect(() => {
    // Skip search if a customer is already locked in and the displayed values match
    if (selectedCustomer
        && selectedCustomer.name === name
        && (selectedCustomer.phone === phone || selectedCustomer.phone_raw === phone)) {
      setResults([]);
      setSearched(false);
      return;
    }
    const q = phone.length >= 3 ? phone : name.length >= 3 ? name : '';
    if (!q) { setResults([]); setSearched(false); return; }
    setResults(searchCustomers(q));
    setSearched(true);
    const t = setTimeout(async () => {
      try {
        const live = typeof searchCustomersLive === 'function' ? await searchCustomersLive(q) : [];
        if (live && live.length) {
          const seen = new Set();
          const merged = [...live, ...searchCustomers(q)].filter(c => {
            const k = c.phone || c.email || c.id;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          }).slice(0, 6);
          setResults(merged);
        }
      } catch (e) { void e; }
    }, 250);
    return () => clearTimeout(t);
  }, [name, phone, selectedCustomer, searchCustomers, searchCustomersLive]);

  const selectCustomer = (c) => {
    setName(c.name || '');
    setPhone(c.phone_raw || c.phone || '');
    setSelectedCustomer(c);
    setResults([]);
    setSearched(false);
    // v5.5.10: prepend allergen line to notes. Strip any old auto-line first
    // so changing customer doesn't accumulate stale allergen entries.
    if (Array.isArray(c.allergens) && c.allergens.length > 0) {
      const allergenLine = ALLERGEN_MARKER + c.allergens.join(', ');
      const cleaned = stripAllergenLine(notes);
      setNotes(cleaned ? allergenLine + '\n\n' + cleaned : allergenLine);
    } else {
      // Clear any previous auto-allergen line if the new customer has none
      const cleaned = stripAllergenLine(notes);
      if (cleaned !== notes) setNotes(cleaned);
    }
  };

  const handleNameChange = (v) => {
    setName(v);
    if (selectedCustomer && selectedCustomer.name !== v) setSelectedCustomer(null);
  };
  const handlePhoneChange = (v) => {
    setPhone(v);
    if (selectedCustomer && selectedCustomer.phone_raw !== v && selectedCustomer.phone !== v) setSelectedCustomer(null);
  };

  const canSave = name.trim().length > 0;

  return (
    <div className="modal-back" onClick={e=>e.target===e.currentTarget&&onCancel()}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--bdr2)', borderRadius:22, width:'100%', maxWidth:400, maxHeight:'88vh', overflow:'auto', boxShadow:'var(--sh3)' }}>
        {/* Header */}
        <div style={{ padding:'16px 20px 12px', borderBottom:'1px solid var(--bdr)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div>
            <div style={{ fontSize:16, fontWeight:800, color:'var(--t1)' }}>{existing ? 'Edit reservation' : 'New reservation'}</div>
            <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>{table.label} · max {table.maxCovers} covers</div>
          </div>
          <button onClick={onCancel} style={{ background:'none', border:'none', color:'var(--t3)', cursor:'pointer', fontSize:22 }}>×</button>
        </div>

        <div style={{ padding:'16px 20px' }}>
          {/* Guest name */}
          <div style={{ marginBottom:14 }}>
            <label style={L}>Guest name <span style={{ color:'var(--red)', fontWeight:400 }}>*</span></label>
            <input className="input" placeholder="Start typing to find returning guests…" value={name} onChange={e=>handleNameChange(e.target.value)} autoFocus/>
          </div>

          {/* Phone */}
          <div style={{ marginBottom:14 }}>
            <label style={L}>Phone number</label>
            <input className="input" type="tel" placeholder="+44 7700 000000" value={phone} onChange={e=>handlePhoneChange(e.target.value)}/>
          </div>

          {/* v5.5.10: customer search results */}
          {results.length > 0 && (
            <div style={{ marginBottom: 14, background: 'var(--bg3)', borderRadius: 10, border: '1px solid var(--bdr2)', overflow: 'hidden' }}>
              <div style={{ padding: '8px 12px', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', borderBottom: '1px solid var(--bdr)' }}>
                Returning guests
              </div>
              {results.map(c => (
                <div key={c.id || c.phone} onClick={() => selectCustomer(c)} style={{
                  padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12,
                  borderBottom: '1px solid var(--bdr)', transition: 'background .1s',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg4)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--acc-d)', border: '1px solid var(--acc-b)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: 'var(--acc)', flexShrink: 0 }}>
                    {(c.name || '?').split(' ').map(n => n[0]).join('').slice(0,2)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {c.phone_raw || c.phone}
                      {Array.isArray(c.allergens) && c.allergens.length > 0 && (
                        <span style={{ marginLeft: 6, color:'#e8a020' }}>· ⚠ {c.allergens.join(', ')}</span>
                      )}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--acc)', fontWeight: 600 }}>Select →</div>
                </div>
              ))}
            </div>
          )}
          {searched && results.length === 0 && (
            <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--t3)', padding: '4px 0' }}>
              No matching guest — booking as a new customer
            </div>
          )}
          {selectedCustomer && (
            <div style={{ marginBottom: 14, padding: '8px 12px', background: 'rgba(34,197,94,.10)', border: '1px solid rgba(34,197,94,.35)', borderRadius: 10, display:'flex', alignItems:'center', justifyContent:'space-between', gap: 8 }}>
              <div style={{ fontSize: 12, color: '#22c55e', fontWeight: 600 }}>
                ✓ {selectedCustomer.name} — returning guest
                {Array.isArray(selectedCustomer.allergens) && selectedCustomer.allergens.length > 0 && (
                  <span style={{ marginLeft: 4, color:'#e8a020', fontWeight: 500 }}> · allergens added to notes</span>
                )}
              </div>
              <button onClick={()=>{ setSelectedCustomer(null); setNotes(stripAllergenLine(notes)); }}
                style={{ background:'none', border:0, color:'var(--t3)', fontSize:11, cursor:'pointer' }}>Clear</button>
            </div>
          )}

          {/* Date + time row */}
          <div style={{ display:'flex', gap:10, marginBottom:14 }}>
            <div style={{ flex:1.2 }}>
              <label style={L}>Date</label>
              <input className="input" type="date" value={date} onChange={e=>setDate(e.target.value)}/>
            </div>
            <div style={{ flex:1 }}>
              <label style={L}>Time</label>
              <select value={time} onChange={e=>setTime(e.target.value)} style={{ width:'100%', background:'var(--bg3)', border:'1.5px solid var(--bdr2)', borderRadius:11, padding:'0 12px', height:42, fontSize:13, color:'var(--t1)', fontFamily:'inherit', outline:'none', cursor:'pointer' }}>
                {/* v5.6.27: a booking edited here may sit off the 15-min grid — keep its time selectable */}
                {time && !TIME_SLOTS.includes(time) && <option value={time}>{time}</option>}
                {TIME_SLOTS.map(t=><option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>

          {/* Party size */}
          <div style={{ marginBottom:14 }}>
            <label style={L}>Party size</label>
            <div style={{ display:'flex', alignItems:'center', gap:12 }}>
              <button onClick={()=>setParty(p=>Math.max(1,p-1))} style={QB}>−</button>
              <span style={{ fontSize:22, fontWeight:800, minWidth:36, textAlign:'center', color:'var(--t1)' }}>{partySize}</span>
              <button onClick={()=>setParty(p=>Math.min(table.maxCovers,p+1))} style={QB}>+</button>
              {partySize > table.maxCovers && (
                <span style={{ fontSize:11, color:'var(--red)', fontWeight:600 }}>Exceeds table max ({table.maxCovers})</span>
              )}
            </div>
          </div>

          {/* Notes */}
          <div style={{ marginBottom:20 }}>
            <label style={L}>Notes <span style={{ fontWeight:400, color:'var(--t4)', textTransform:'none', letterSpacing:0 }}>optional</span></label>
            <textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Birthday, dietary requirements, VIP, high chair needed…" rows={3}
              style={{ width:'100%', background:'var(--bg3)', border:'1.5px solid var(--bdr2)', borderRadius:11, padding:'10px 12px', color:'var(--t1)', fontSize:13, fontFamily:'inherit', resize:'none', outline:'none', lineHeight:1.5, display:'block', transition:'border-color .15s' }}
              onFocus={e=>e.target.style.borderColor='var(--acc-b)'}
              onBlur={e=>e.target.style.borderColor='var(--bdr2)'}/>
          </div>

          {/* Actions */}
          <div style={{ display:'flex', gap:8 }}>
            <button className="btn btn-ghost" style={{ flex:1 }} onClick={onCancel}>Cancel</button>
            <button className="btn btn-acc" style={{ flex:2, height:46 }} disabled={!canSave}
              onClick={()=>onConfirm({ name:name.trim(), phone, partySize, time, date, notes, customer: selectedCustomer })}>
              {existing ? 'Update reservation' : 'Confirm reservation'} →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Table Node ───────────────────────────────────────────────────────────────
function TableNode({ table, onClick }) {
  const { tables, upcomingBookingForTable } = useStore();
  const session = table.session;
  // v5.6.27: "reserved" is DISPLAY-DERIVED from the Table Bookings module —
  // the next live booking claiming this table today (upcomingBookingForTable).
  // table.reservation / persisted status 'reserved' are dead.
  const bk = !session ? upcomingBookingForTable?.(table.id) : null;
  // Derive display status: seated = session exists but no items yet
  const displayStatus = (table.status === 'occupied' && session && session.items?.filter(i=>!i.voided).length === 0)
    ? 'seated'
    : bk ? 'reserved'
    : (table.status === 'reserved' && !session) ? 'available'  // stale persisted status, no live booking
    : table.status;
  const sm = STATUS[displayStatus] || STATUS.available;
  const timeSeated = session?.seatedAt ? fmt(session.seatedAt) : null;
  const isRound = table.shape === 'rd';
  const childCount = tables.filter(t => t.parentId === table.id).length;

  return (
    <div onClick={onClick} style={{
      position:'absolute',
      left: table.x, top: table.y, width: table.w, height: table.h,
      borderRadius: isRound ? '50%' : 12,
      background: sm.bg,
      border: `2px solid ${sm.border}`,
      cursor: 'pointer',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: 6, textAlign: 'center',
      transition: 'all .15s',
      userSelect: 'none',
    }}>
      {/* Table label */}
      <div style={{ fontSize: table.w > 80 ? 13 : 11, fontWeight: 800, color: sm.color, lineHeight:1.2 }}>
        {table.label}
      </div>

      {/* Status / session info */}
      {displayStatus === 'available' && (
        <div style={{ fontSize:9, color:sm.color, marginTop:2, fontWeight:600 }}>
          {table.maxCovers} covers
        </div>
      )}

      {displayStatus === 'seated' && session && (
        <div style={{ fontSize:9, color:sm.color, marginTop:2, fontWeight:600 }}>
          {session.covers} cvr · seated
        </div>
      )}

      {(table.status === 'open' || (table.status === 'occupied' && displayStatus !== 'seated')) && session && (
        <>
          <div style={{ fontSize:9, color:'var(--t2)', marginTop:2, lineHeight:1.3 }}>
            {session.covers} cvr · {session.server?.split(' ')[0]}
          </div>
          {timeSeated && (
            <div style={{ fontSize:9, color:'var(--t3)', marginTop:1 }}>{timeSeated}</div>
          )}
          {session.subtotal > 0 && (
            <div style={{ fontSize:10, fontWeight:700, color:sm.color, marginTop:2, fontFamily:'DM Mono,monospace' }}>
              {currencySymbol()}{session.subtotal.toFixed(0)}
            </div>
          )}
        </>
      )}

      {bk && !session && (
        <>
          <div style={{ fontSize:9, color:sm.color, marginTop:2, lineHeight:1.3, fontWeight:600 }}>
            {bk.startTime}
          </div>
          <div style={{ fontSize:9, color:'var(--t3)', marginTop:1 }}>
            {(bk.customer?.name || 'Guest').split(' ')[0]}
          </div>
        </>
      )}

      {/* Status dot */}
      <div style={{ width:6, height:6, borderRadius:'50%', background:sm.color, position:'absolute', top:5, right:5 }}/>
      {/* Split checks badge */}
      {childCount > 0 && (
        <div style={{ position:'absolute', top:4, left:5, fontSize:9, fontWeight:800, padding:'1px 5px', borderRadius:8, background:'var(--acc)', color:'#0b0c10', lineHeight:1.4 }}>
          {childCount+1} checks
        </div>
      )}
    </div>
  );
}

// ─── Main Tables Surface ─────────────────────────────────────────────────────
export default function TablesSurface() {
  const compact = useCompact();
  const { tables, seatTable, openTableInPOS, clearTable, setReservation, setSurface, showToast, staff, locationSections, deviceConfig, setSessionCustomer,
    // v5.6.27: Table Bookings seams — "reserved" is derived from live bookings
    bookings, upcomingBookingForTable, seatBooking, updateBooking, cancelBooking, packages } = useStore();
  const [selected, setSelected]   = useState(null);
  const [showSeat, setShowSeat]   = useState(false);
  const [showReservation, setShowReservation] = useState(false);
  // v5.6.27: booking being edited via ReservationModal (distinct from the
  // new-reservation path — edit patches the booking, never setReservation)
  const [editBooking, setEditBooking] = useState(null);
  const [showCheckSelector, setShowCheckSelector] = useState(false);
  // v4.4.9: guest attach UI for seated tables. Opens CustomerModal which lets staff
  // search by phone (exact) or name (loose match) via searchCustomersLive in store.
  const [showCustomer, setShowCustomer] = useState(false);
  const [checkSelectorTable, setCheckSelectorTable] = useState(null);
  // Auto-filter to assigned section from device profile (e.g. bar terminal shows bar section by default)
  const [section, setSection] = useState(deviceConfig?.assignedSection || 'all');
  const [view, setView]           = useState('floor');  // floor | mine | all
  const [, setTick] = useState(0);
  // v4.6.57: zoom + auto-fit
  const _viewportRef = useRef(null);
  const [zoom, setZoom] = useState(1);          // current zoom (0.4-1.6)
  const [autoFit, setAutoFit] = useState(true); // when true, zoom auto-recomputes on viewport resize
  const [vp, setVp] = useState({ w: 0, h: 0 }); // viewport size
  useEffect(() => {
    if (!_viewportRef.current) return;
    const el = _viewportRef.current;
    const update = () => setVp({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-render every 30s so urgency colours stay live AND the time-derived
  // booking "reserved" display flips as bookings enter/leave their 3h
  // lookahead window (v5.6.27 — finer than the 60s minimum needed).
  useEffect(() => {
    const id = setInterval(() => setTick(t => t+1), 30000);
    return () => clearInterval(id);
  }, []);

  const selectedTable = tables.find(t => t.id === selected);
  // v5.6.27: the next live booking claiming the selected table (display-derived;
  // only meaningful while the table has no session)
  const selectedBk = selectedTable && !selectedTable.session
    ? upcomingBookingForTable?.(selectedTable.id) : null;

  // v4.6.56: filter hidden sections from the tab list. Hidden flag set in Back Office.
  const visibleSections = (locationSections || []).filter(s => !s.hidden);
  const hiddenSectionIds = new Set((locationSections || []).filter(s => s.hidden).map(s => s.id));
  const sections = [
    { id:'all', label:'All' },
    ...visibleSections,
  ];

  // v5.6.27: reserved = tables claimed by an upcoming live booking (no session),
  // never the dead persisted status. Booked tables leave the available count so
  // the legend buckets stay mutually exclusive.
  const reservedIds = new Set(
    tables.filter(t => !t.parentId && !t.session && upcomingBookingForTable?.(t.id)).map(t => t.id)
  );
  const counts = {
    // stale persisted 'reserved' (no session, no live booking) reads as available
    available: tables.filter(t=>(t.status==='available' || (t.status==='reserved' && !t.session)) && !reservedIds.has(t.id)).length,
    open:      tables.filter(t=>t.status==='open').length,
    occupied:  tables.filter(t=>t.status==='occupied').length,
    reserved:  reservedIds.size,
  };

  // Helper — open a table, showing check selector if it has splits
  const openTable = (table) => {
    const hasChildren = tables.some(t => t.parentId === table.id);
    if (hasChildren) {
      setCheckSelectorTable(table);
      setShowCheckSelector(true);
    } else {
      openTableInPOS(table.id);
    }
  };

  const handleTableClick = (table) => {
    setSelected(table.id);
  };

  const handleAction = (action) => {
    if (!selectedTable) return;
    switch (action) {
      case 'seat':
        setShowSeat(true);
        break;
      case 'open_pos':
        openTable(selectedTable);
        break;
      case 'close':
        clearTable(selectedTable.id);
        showToast(`${selectedTable.label} cleared`, 'success');
        setSelected(null);
        break;
      case 'reserve':
        setShowReservation(true);
        break;
      case 'cancel_reserve': {
        // v5.6.27: cancel the claiming booking directly (bookings replaced the
        // thin per-table reservation; setReservation(id, null) does the same).
        const bk = upcomingBookingForTable?.(selectedTable.id);
        if (bk) cancelBooking(bk.id, { reason: 'cancelled at the table' });
        showToast(`Reservation cancelled`, 'info');
        setSelected(null);
        break;
      }
    }
  };

  // v4.6.56: in 'all' view exclude tables whose section is hidden.
  const filteredTables = (section === 'all'
      ? tables.filter(t => !hiddenSectionIds.has(t.section))
      : tables.filter(t => t.section === section))
    .filter(t => !t.parentId);  // never render child tables (T1.2) on the floor plan
  // v4.6.56: per-section auto-fit. When a single section is selected, shift
  // tables to top-left of the canvas (subtract section's min-x/min-y) so the
  // user sees just that section filling the viewport. 'All' view keeps absolute
  // positions so multi-section layouts retain their relative geometry.
  const _tbls = filteredTables.length ? filteredTables : tables;
  const _minX = section === 'all' ? 0 : Math.min(..._tbls.map(t => t.x || 0));
  const _minY = section === 'all' ? 0 : Math.min(..._tbls.map(t => t.y || 0));
  const _offX = section === 'all' ? 0 : Math.max(0, _minX - 20);
  const _offY = section === 'all' ? 0 : Math.max(0, _minY - 40);
  const canvasW = (_tbls.length ? Math.max(..._tbls.map(t => (t.x || 0) + (t.w || 80))) : 0) - _offX + 40;
  const canvasH = (_tbls.length ? Math.max(..._tbls.map(t => (t.y || 0) + (t.h || 64))) : 0) - _offY + 40;
  // v4.6.57: derive fit zoom from viewport + canvas. Cap zoom at 1 (don't enlarge,
  // only shrink). User can override via manual zoom controls (autoFit becomes false).
  const _padding = 32;
  const _fitZoom = (vp.w > 0 && vp.h > 0 && canvasW > 0 && canvasH > 0)
    ? Math.min(1, (vp.w - _padding) / canvasW, (vp.h - _padding) / canvasH)
    : 1;
  const _effectiveZoom = autoFit ? Math.max(0.3, _fitZoom) : zoom;

  return (
    <div style={{ display:'flex', flex:1, overflow:'hidden', background:'var(--bg)' }}>

      {/* ── Floor plan ─────────────────────────────── */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>

        {/* Header */}
        <div style={{ padding:'0 18px', borderBottom:'1px solid var(--bdr2)', background:'var(--bg1)', display:'flex', alignItems:'center', gap:0, flexShrink:0 }}>
          {/* View tabs */}
          {[
            { id:'floor', label:'Floor plan' },
            { id:'mine',  label:`My orders${staff?.name?' ('+staff.name+')':''}` },
            { id:'all',   label:'All open orders' },
          ].map(v => (
            <button key={v.id} onClick={()=>setView(v.id)} style={{
              padding:'12px 16px', cursor:'pointer', fontFamily:'inherit', border:'none',
              borderBottom:`2px solid ${view===v.id?'var(--acc)':'transparent'}`,
              background:'transparent', color:view===v.id?'var(--acc)':'var(--t3)',
              fontSize:13, fontWeight:view===v.id?700:500, whiteSpace:'nowrap',
            }}>{v.label}</button>
          ))}

          {/* Status legend + section filter — only on floor view */}
          {view==='floor' && (
            <>
              <div style={{ display:'flex', gap:10, marginLeft:16 }}>
                {Object.entries(STATUS).map(([s,m])=>(
                  <div key={s} style={{ display:'flex', alignItems:'center', gap:5, fontSize:11, color:'var(--t3)' }}>
                    <div style={{ width:8, height:8, borderRadius:'50%', background:m.color }}/>
                    <span style={{ color:'var(--t2)' }}>{counts[s]}</span> {m.label}
                  </div>
                ))}
              </div>
              <div style={{ marginLeft:'auto', display:'flex', gap:4 }}>
                {sections.map(s=>(
                  <button key={s.id} onClick={()=>setSection(s.id)} style={{
                    padding:'4px 12px', borderRadius:20, fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'inherit',
                    border:`1px solid ${section===s.id?'var(--acc-b)':'var(--bdr)'}`,
                    background:section===s.id?'var(--acc-d)':'transparent',
                    color:section===s.id?'var(--acc)':'var(--t3)',
                  }}>{s.label}</button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* ── Orders list view ─────────────────────────────── */}
        {(view==='mine' || view==='all') && (() => {
          const now = Date.now();
          const activeTables = tables.filter(t =>
            (t.status==='open'||t.status==='occupied') && t.session && !t.parentId
          ).filter(t =>
            view==='all' || t.session.server===staff?.name
          ).sort((a,b) => (b.session.seatedAt||0) - (a.session.seatedAt||0));

          const urgency = (session) => {
            // Use sentAt if order has been sent, else seatedAt
            const lastActivity = session.sentAt ? new Date(session.sentAt).getTime() : (session.seatedAt||now);
            const idleMins = (now - lastActivity) / 60000;
            if (idleMins >= 20) return 'red';
            if (idleMins >= 10) return 'amber';
            return 'green';
          };
          const urgencyStyle = {
            green: { border:'1px solid var(--grn-b)', bg:'var(--bg2)', dot:'var(--grn)' },
            amber: { border:'1px solid var(--acc-b)', bg:'rgba(232,160,32,.06)', dot:'var(--acc)' },
            red:   { border:'1px solid var(--red-b)', bg:'rgba(220,40,40,.06)',  dot:'var(--red)' },
          };

          return (
            <div style={{ flex:1, overflowY:'auto', padding:16 }}>
              {activeTables.length === 0 && (
                <div style={{ textAlign:'center', padding:'60px 0', color:'var(--t3)' }}>
                  <div style={{ fontSize:40, marginBottom:12, opacity:.4 }}>⬚</div>
                  <div style={{ fontSize:14, fontWeight:600, color:'var(--t2)', marginBottom:6 }}>
                    {view==='mine' ? 'No open tables assigned to you' : 'No open tables'}
                  </div>
                </div>
              )}

              {/* Urgency legend */}
              {activeTables.length > 0 && (
                <div style={{ display:'flex', gap:12, marginBottom:14, fontSize:11, color:'var(--t3)' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:5 }}>
                    <div style={{ width:8,height:8,borderRadius:'50%',background:'var(--grn)' }}/>Active
                  </div>
                  <div style={{ display:'flex', alignItems:'center', gap:5 }}>
                    <div style={{ width:8,height:8,borderRadius:'50%',background:'var(--acc)' }}/>10+ mins idle
                  </div>
                  <div style={{ display:'flex', alignItems:'center', gap:5 }}>
                    <div style={{ width:8,height:8,borderRadius:'50%',background:'var(--red)' }}/>20+ mins idle
                  </div>
                </div>
              )}

              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {activeTables.map(table => {
                  const session = table.session;
                  const urg = urgency(session);
                  const us = urgencyStyle[urg];
                  const seatedMins = Math.floor((now - (session.seatedAt||now)) / 60000);
                  const lastActivity = session.sentAt ? new Date(session.sentAt).getTime() : (session.seatedAt||now);
                  const idleMins = Math.floor((now - lastActivity) / 60000);
                  const childChecks = tables.filter(t => t.parentId === table.id);
                  const hasChildren = childChecks.length > 0;
                  // Combined total across all checks
                  const allChecks = [table, ...childChecks];
                  const combinedTotal = allChecks.reduce((s,t) => s+(t.session?.subtotal||0), 0);

                  return (
                    <div key={table.id}>
                    <div onClick={()=>openTable(table)} style={{
                      display:'flex', alignItems:'center', gap:16, padding:'14px 18px',
                      borderRadius:hasChildren?'14px 14px 0 0':14, cursor:'pointer', border:us.border, background:us.bg,
                      transition:'all .15s', borderBottom:hasChildren?'none':us.border,
                    }}>
                      {/* Urgency dot */}
                      <div style={{ width:10, height:10, borderRadius:'50%', background:us.dot, flexShrink:0, boxShadow:`0 0 6px ${us.dot}` }}/>

                      {/* Table label */}
                      <div style={{ width:80, flexShrink:0 }}>
                        <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)' }}>{table.label}</div>
                        <div style={{ fontSize:11, color:'var(--t3)', marginTop:1 }}>{table.section}</div>
                      </div>

                      {/* Covers */}
                      <div style={{ width:70, flexShrink:0 }}>
                        <div style={{ fontSize:13, fontWeight:600, color:'var(--t2)' }}>🪑 {session.covers}</div>
                        <div style={{ fontSize:11, color:'var(--t3)' }}>covers</div>
                      </div>

                      {/* Server */}
                      {view==='all' && (
                        <div style={{ width:90, flexShrink:0 }}>
                          <div style={{ fontSize:13, fontWeight:600, color:'var(--t2)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{session.server}</div>
                          <div style={{ fontSize:11, color:'var(--t3)' }}>server</div>
                        </div>
                      )}

                      {/* Time seated */}
                      <div style={{ width:70, flexShrink:0 }}>
                        <div style={{ fontSize:13, fontWeight:600, color:'var(--t2)' }}>⏱ {seatedMins < 60 ? `${seatedMins}m` : `${Math.floor(seatedMins/60)}h${seatedMins%60}m`}</div>
                        <div style={{ fontSize:11, color:'var(--t3)' }}>seated</div>
                      </div>

                      {/* Idle time */}
                      <div style={{ width:80, flexShrink:0 }}>
                        <div style={{ fontSize:13, fontWeight:600, color:urg==='green'?'var(--t2)':urg==='amber'?'var(--acc)':'var(--red)' }}>
                          {idleMins < 1 ? 'Just now' : `${idleMins}m ago`}
                        </div>
                        <div style={{ fontSize:11, color:'var(--t3)' }}>last activity</div>
                      </div>

                      {/* Check total */}
                      <div style={{ marginLeft:'auto', textAlign:'right', flexShrink:0 }}>
                        <div style={{ fontSize:20, fontWeight:800, color:'var(--acc)', fontFamily:'DM Mono,monospace' }}>
                          {money(combinedTotal)}
                        </div>
                        <div style={{ fontSize:11, color:'var(--t3)' }}>
                          {hasChildren ? `${allChecks.length} checks` : `${session.items?.filter(i=>!i.voided).length||0} items`}
                        </div>
                      </div>

                      {/* Arrow */}
                      <div style={{ color:'var(--t4)', fontSize:18, flexShrink:0 }}>›</div>
                    </div>

                    {/* Child check sub-rows */}
                    {hasChildren && childChecks.map((child, ci) => {
                      const childSub = child.session?.subtotal || 0;
                      const childItems = child.session?.items?.filter(i=>!i.voided).length || 0;
                      return (
                        <div key={child.id} onClick={()=>openTableInPOS(child.id)} style={{
                          display:'flex', alignItems:'center', gap:16, padding:'10px 18px',
                          cursor:'pointer', background:us.bg, borderLeft:`3px solid var(--acc)`,
                          border:us.border, borderTop:'none',
                          borderRadius:ci===childChecks.length-1?'0 0 14px 14px':'0',
                          transition:'all .15s',
                        }}>
                          <div style={{ width:10, height:10, borderRadius:'50%', background:'var(--acc)', flexShrink:0 }}/>
                          <div style={{ width:80, flexShrink:0 }}>
                            <div style={{ fontSize:15, fontWeight:700, color:'var(--acc)' }}>{child.label}</div>
                            <div style={{ fontSize:10, color:'var(--t4)' }}>Check {ci+2}</div>
                          </div>
                          <div style={{ fontSize:12, color:'var(--t3)', flex:1 }}>
                            {child.session?.server} · {childItems} items
                          </div>
                          <div style={{ fontSize:16, fontWeight:800, color:'var(--acc)', fontFamily:'DM Mono,monospace' }}>
                            {money(childSub)}
                          </div>
                          <div style={{ color:'var(--t4)', fontSize:16 }}>›</div>
                        </div>
                      );
                    })}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* ── Floor plan canvas ─────────────────────────────── */}
        {view==='floor' && (
          <div ref={_viewportRef} style={{ flex:1, overflow:'auto', padding:24, position:'relative' }}>
            {/* v4.6.57: zoom controls */}
            <div style={{ position:'sticky', top:0, zIndex:10, display:'flex', gap:6, alignItems:'center', justifyContent:'flex-end', padding:'4px 0', pointerEvents:'none' }}>
              <div style={{ display:'flex', gap:4, alignItems:'center', background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:8, padding:'4px 8px', boxShadow:'var(--sh1, 0 1px 3px rgba(0,0,0,.1))', pointerEvents:'auto' }}>
                <button onClick={() => { setAutoFit(false); setZoom(z => Math.max(0.4, +(z - 0.1).toFixed(2))); }} style={{ width:24, height:24, borderRadius:6, border:'none', background:'var(--bg3)', color:'var(--t1)', fontSize:14, fontWeight:700, cursor:'pointer', fontFamily:'inherit' }} title="Zoom out">−</button>
                <span style={{ fontSize:11, color:'var(--t3)', fontFamily:'var(--font-mono)', minWidth:38, textAlign:'center' }}>{Math.round(_effectiveZoom * 100)}%</span>
                <button onClick={() => { setAutoFit(false); setZoom(z => Math.min(1.6, +(z + 0.1).toFixed(2))); }} style={{ width:24, height:24, borderRadius:6, border:'none', background:'var(--bg3)', color:'var(--t1)', fontSize:14, fontWeight:700, cursor:'pointer', fontFamily:'inherit' }} title="Zoom in">+</button>
                <button onClick={() => { setAutoFit(true); setZoom(1); }} style={{ height:24, padding:'0 8px', borderRadius:6, border:'none', background: autoFit ? 'var(--acc-d)' : 'var(--bg3)', color: autoFit ? 'var(--acc)' : 'var(--t2)', fontSize:10, fontWeight:700, cursor:'pointer', fontFamily:'inherit', textTransform:'uppercase', letterSpacing:'.07em' }} title="Auto-fit to viewport">Fit</button>
              </div>
            </div>
          <div style={{ position:'relative', width:canvasW * _effectiveZoom, height:canvasH * _effectiveZoom }}>
          <div style={{ position:'absolute', top:0, left:0, width:canvasW, height:canvasH, transform:`scale(${_effectiveZoom})`, transformOrigin:'top left' }}>
            {/* v4.6.55: Dynamic section labels. Position each label at its section's
                min-x (matches FloorPlanBuilder back-office rendering). Previously
                hardcoded label positions assumed fixed lane widths and broke when
                tables were placed past the Bar lane's hardcoded x=488 boundary. */}
            {(() => {
              const sectionSet = new Set(filteredTables.map(t => t.section).filter(Boolean));
              const SECTION_LABELS = { main: 'Main dining', bar: 'Bar', patio: 'Patio' };
              return [...sectionSet].map(secKey => {
                const secTables = filteredTables.filter(t => t.section === secKey);
                if (!secTables.length) return null;
                const minX = Math.min(...secTables.map(t => t.x || 0));
                const label = SECTION_LABELS[secKey] || secKey;
                return (
                  <div key={secKey} style={{ position:'absolute', top:Math.max(4, 8 - _offY), left:Math.max(8, minX - _offX), fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em' }}>
                    {label}
                  </div>
                );
              });
            })()}

            {/* v5.6.27: dashed amber join outline around member tables of any
                active multi-table booking — same visual approach as
                bookings/FloorScreen. Active = live booking inside its
                [start−15, start+turn) window, which covers dining/seated too. */}
            {(() => {
              const now = new Date();
              const nowMin = now.getHours() * 60 + now.getMinutes();
              const today = now.toLocaleDateString('en-CA');
              return (bookings || []).filter(b => {
                if ((b.tables || []).length < 2) return false;
                if (b.date && b.date !== today) return false;
                if (['cancelled', 'no_show', 'departed'].includes(b.status)) return false;
                const s = toMin(b.startTime);
                return nowMin >= s - 15 && nowMin < s + (b.turnMinutes || 90);
              }).map(b => {
                const members = (b.tables || []).map(id => filteredTables.find(t => t.id === id)).filter(Boolean);
                if (members.length < 2) return null;
                const x1 = Math.min(...members.map(t => (t.x || 0) - _offX));
                const y1 = Math.min(...members.map(t => (t.y || 0) - _offY));
                const x2 = Math.max(...members.map(t => (t.x || 0) - _offX + (t.w || 80)));
                const y2 = Math.max(...members.map(t => (t.y || 0) - _offY + (t.h || 64)));
                return (
                  <div key={`join-${b.id}`} style={{
                    position:'absolute', pointerEvents:'none', borderRadius:16,
                    left:x1 - 7, top:y1 - 7, width:x2 - x1 + 14, height:y2 - y1 + 14,
                    border:'1.5px dashed rgba(232,160,32,.55)',
                  }}/>
                );
              });
            })()}

            {filteredTables.map(table=>(
              <div key={table.id}>
                <TableNode table={{ ...table, x: (table.x || 0) - _offX, y: (table.y || 0) - _offY }} onClick={()=>handleTableClick(table)}/>
                {/* Highlight ring when selected */}
                {selected===table.id && (
                  <div style={{
                    position:'absolute', left:(table.x || 0) - _offX - 4, top:(table.y || 0) - _offY - 4, width:table.w+8, height:table.h+8,
                    borderRadius:table.shape==='rd'?'50%':16,
                    border:'2px solid var(--acc)', pointerEvents:'none',
                    boxShadow:'0 0 0 3px rgba(232,160,32,.2)',
                  }}/>
                )}
              </div>
            ))}
          </div>
          </div>
          </div>  /* scroll wrapper */
        )}  {/* end floor view */}
      </div>

      {/* ── Detail panel ───────────────────────────── */}
      <div style={{ width:280, flexShrink:0, background:'var(--bg1)', borderLeft:'1px solid var(--bdr2)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        {!selectedTable ? (
          <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', color:'var(--t3)', padding:24, textAlign:'center' }}>
            <div style={{ fontSize:40, marginBottom:12, opacity:.4 }}>⬚</div>
            <div style={{ fontSize:14, fontWeight:600, color:'var(--t2)', marginBottom:6 }}>No table selected</div>
            <div style={{ fontSize:12, lineHeight:1.6 }}>Tap a table on the floor plan to see details and actions</div>
          </div>
        ) : (
          <>
            {/* Table header */}
            <div style={{ padding:'18px 18px 14px', borderBottom:'1px solid var(--bdr)' }}>
              {(() => {
                const session = selectedTable.session;
                // v5.6.27: a live booking claiming a session-less table shows
                // as Reserved regardless of the persisted status
                const sm = (selectedBk && !session)
                  ? STATUS.reserved
                  : (selectedTable.status === 'reserved' && !session)
                  ? STATUS.available   // stale persisted status, no live booking
                  : (STATUS[selectedTable.status] || STATUS.available);
                return (
                  <>
                    <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
                      <div style={{ width:40, height:40, borderRadius:selectedTable.shape==='rd'?'50%':10, background:sm.bg, border:`2px solid ${sm.border}`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:13, fontWeight:800, color:sm.color }}>{selectedTable.label}</div>
                      <div>
                        <div style={{ fontSize:15, fontWeight:700, color:'var(--t1)' }}>{selectedTable.label}</div>
                        <div style={{ fontSize:11, color:'var(--t3)', marginTop:1 }}>{selectedTable.maxCovers} covers · {selectedTable.section}</div>
                      </div>
                      <span style={{ marginLeft:'auto', fontSize:11, fontWeight:700, padding:'3px 8px', borderRadius:20, background:sm.bg, color:sm.color, border:`1px solid ${sm.border}` }}>{sm.label}</span>
                    </div>

                    {session && (
                      <div style={{ background:'var(--bg3)', borderRadius:10, padding:'10px 12px' }}>
                        <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:4 }}>
                          <span style={{ color:'var(--t3)' }}>Server</span><span style={{ color:'var(--t1)', fontWeight:600 }}>{session.server}</span>
                        </div>
                        <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:4 }}>
                          <span style={{ color:'var(--t3)' }}>Covers</span><span style={{ color:'var(--t1)', fontWeight:600 }}>{session.covers}</span>
                        </div>
                        <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:4 }}>
                          <span style={{ color:'var(--t3)' }}>Time seated</span><span style={{ color:'var(--t1)', fontWeight:600 }}>{fmt(session.seatedAt)}</span>
                        </div>
                        {session.sentAt && <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:4 }}>
                          <span style={{ color:'var(--t3)' }}>Order sent</span><span style={{ color:'var(--t1)', fontWeight:600 }}>{fmt(session.sentAt)} ago</span>
                        </div>}
                        <div style={{ height:1, background:'var(--bdr)', margin:'8px 0' }}/>
                        {(() => {
                          // Compute service charge using device profile config
                          const sub = session.subtotal || 0;
                          let scRate = 0;
                          try {
                            scRate = resolveServiceCharge({
                              deviceConfig,
                              orderType: 'dine-in',
                              covers: session.covers || 1,
                              waived: session.serviceChargeWaived || false,
                            });
                          } catch {}
                          const scAmt = sub * scRate;
                          const totalWithSC = sub + scAmt;
                          return (
                            <>
                              <div style={{ display:'flex', justifyContent:'space-between', fontSize:14, fontWeight:700 }}>
                                <span style={{ color:'var(--t2)' }}>Running total</span>
                                <span style={{ color:'var(--acc)', fontFamily:'DM Mono,monospace' }}>{money(sub)}</span>
                              </div>
                              {scAmt > 0 && (
                                <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'var(--t3)', marginTop:3 }}>
                                  <span>inc. service ({deviceConfig?.serviceCharge?.rate ?? 12.5}%)</span>
                                  <span style={{ fontFamily:'DM Mono,monospace' }}>{money(totalWithSC)}</span>
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    )}

                    {selectedBk && !session && (
                      <div style={{ background:'var(--bg3)', borderRadius:10, padding:'10px 12px' }}>
                        <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:3 }}>
                          <span style={{ color:'var(--t3)' }}>Name</span><span style={{ color:'var(--t1)', fontWeight:600 }}>{selectedBk.customer?.name || 'Guest'}</span>
                        </div>
                        <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:3 }}>
                          <span style={{ color:'var(--t3)' }}>Time</span><span style={{ color:'var(--t1)', fontWeight:600 }}>{selectedBk.startTime}</span>
                        </div>
                        <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:3 }}>
                          <span style={{ color:'var(--t3)' }}>Party</span><span style={{ color:'var(--t1)', fontWeight:600 }}>{selectedBk.covers} guests</span>
                        </div>
                        {selectedBk.customer?.phone && (
                          <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:3 }}>
                            <span style={{ color:'var(--t3)' }}>Phone</span><span style={{ color:'var(--t1)', fontWeight:600 }}>{selectedBk.customer.phone}</span>
                          </div>
                        )}
                        {selectedBk.packageId && (
                          <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:3 }}>
                            <span style={{ color:'var(--t3)' }}>Package</span><span style={{ color:'var(--t1)', fontWeight:600 }}>📦 {(packages || []).find(p => p.id === selectedBk.packageId)?.name || 'Package'}</span>
                          </div>
                        )}
                        {selectedBk.note && (
                          <div style={{ marginTop:4, fontSize:11, color:'var(--orn)', fontStyle:'italic', padding:'5px 8px', background:'rgba(249,115,22,.08)', borderRadius:6 }}>
                            📝 {selectedBk.note}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>

            {/* v4.4.9: Guest (optional, post-seating) */}
            {selectedTable.session && (
              <div style={{ padding:16, borderBottom:'1px solid var(--bdr)' }}>
                <div style={{ fontSize:11, fontWeight:600, color:'var(--t3)', textTransform:'uppercase', letterSpacing:0.5, marginBottom:8 }}>
                  Guest
                </div>
                {selectedTable.session.customer?.phone ? (
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:14, fontWeight:600, color:'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {selectedTable.session.customer.name || 'Guest'}
                      </div>
                      <div style={{ fontSize:12, color:'var(--t3)' }}>
                        {selectedTable.session.customer.phone}
                      </div>
                      {Array.isArray(selectedTable.session.customer.allergens) && selectedTable.session.customer.allergens.length > 0 && (
                        <div style={{ fontSize:11, color:'var(--orn)', marginTop:4 }}>
                          {selectedTable.session.customer.allergens.length} allergen filter{selectedTable.session.customer.allergens.length === 1 ? '' : 's'} active
                        </div>
                      )}
                    </div>
                    <button className="btn btn-ghost" style={{ height:32, padding:'0 10px', fontSize:12 }} onClick={()=>setShowCustomer(true)}>Edit</button>
                  </div>
                ) : (
                  <button className="btn btn-ghost" style={{ width:'100%', height:36, fontSize:13 }} onClick={()=>setShowCustomer(true)}>+ Add guest</button>
                )}
              </div>
            )}

            {/* Current items */}
            {selectedTable.session?.items?.length > 0 && (
              <div style={{ padding:'10px 16px', borderBottom:'1px solid var(--bdr)', flexShrink:0, maxHeight:200, overflowY:'auto' }}>
                <div style={{ fontSize:10, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>
                  Order · {selectedTable.session.items.reduce((s,i)=>s+i.qty,0)} items
                </div>
                {selectedTable.session.items.map(item=>(
                  <div key={item.uid} style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:4 }}>
                    <div style={{ flex:1, color:'var(--t2)' }}>
                      {item.qty>1&&<span style={{ color:'var(--t3)', marginRight:3 }}>{item.qty}×</span>}
                      {item.name}
                      {item.status==='sent'&&<span style={{ marginLeft:5, fontSize:9, color:'var(--grn)', fontWeight:700 }}>sent</span>}
                    </div>
                    <span style={{ color:'var(--t3)', fontFamily:'DM Mono,monospace', flexShrink:0 }}>{money((item.price*item.qty))}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Actions */}
            <div style={{ padding:16, display:'flex', flexDirection:'column', gap:8 }}>
              {!selectedTable.session && !selectedBk && (selectedTable.status==='available' || selectedTable.status==='reserved') && (
                <>
                  <button className="btn btn-acc btn-full" onClick={()=>handleAction('seat')} style={{ height:44, fontSize:14 }}>Seat guests →</button>
                  <button className="btn btn-ghost btn-full" onClick={()=>setShowReservation(true)}>Reserve table</button>
                </>
              )}
              {!selectedTable.session && selectedBk && (
                <>
                  {/* v5.6.27: seat THROUGH the booking — opens the session on the
                      primary table, carries guest + allergens, pre-loads package lines */}
                  <button className="btn btn-acc btn-full" onClick={async ()=>{
                    const primary = tables.find(t => t.id === selectedBk.primaryTableId);
                    const r = await seatBooking(selectedBk.id);
                    if (r?.ok) showToast(`${primary?.label || selectedTable.label} seated — ${selectedBk.covers} covers`, 'success');
                    else showToast(r?.error || 'Could not seat the booking', 'error');
                    setSelected(null);
                  }} style={{ height:44, fontSize:14 }}>Seat guests →</button>
                  <button className="btn btn-ghost btn-full" onClick={()=>setEditBooking(selectedBk)}>✏ Edit reservation</button>
                  <button className="btn btn-red btn-sm btn-full" style={{ height:32 }} onClick={()=>handleAction('cancel_reserve')}>Cancel reservation</button>
                </>
              )}
              {selectedTable.status==='open' && (
                <>
                  <button className="btn btn-acc btn-full" onClick={()=>handleAction('open_pos')} style={{ height:44, fontSize:14 }}>Open order →</button>
                  <button className="btn btn-ghost btn-full" onClick={()=>handleAction('close')}>Close table</button>
                </>
              )}
              {selectedTable.status==='occupied' && (() => {
                const childChecks = tables.filter(t => t.parentId === selectedTable.id);
                const hasChildren = childChecks.length > 0;
                return (
                  <>
                    {hasChildren ? (
                      <button className="btn btn-acc btn-full" onClick={()=>{
                        setCheckSelectorTable(selectedTable);
                        setShowCheckSelector(true);
                      }} style={{ height:44, fontSize:14 }}>
                        Select check ({childChecks.length+1} open) →
                      </button>
                    ) : (
                      <button className="btn btn-acc btn-full" onClick={()=>handleAction('open_pos')} style={{ height:44, fontSize:14 }}>Add to order →</button>
                    )}
                    <button className="btn btn-ghost btn-full" style={{ borderColor:'var(--grn-b)', color:'var(--grn)' }}
                      onClick={()=>handleAction('open_pos')}>Take payment</button>
                    {/* v5.5.644: "Force close" removed — it called clearTable with no
                        payment, wiping an occupied table's whole order (lost tables &
                        orders). To clear an occupied table go through Take payment →
                        checkout (comp/void there is auditable). 'close' stays for the
                        empty-seated ('open') table path only. */}
                  </>
                );
              })()}
            </div>
          </>
        )}
      </div>

      {/* Seat modal */}
      {showSeat && selectedTable && (
        <SeatModal
          table={selectedTable}
          onConfirm={(opts)=>{ seatTable(selectedTable.id, opts); setShowSeat(false); setSelected(null); showToast(`${selectedTable.label} seated — ${opts.covers} covers`,'success'); }}
          onCancel={()=>setShowSeat(false)}
        />
      )}

      {showCheckSelector && checkSelectorTable && (
        <CheckSelectorModal
          parentTable={checkSelectorTable}
          onSelect={(tableId)=>{
            openTableInPOS(tableId);
            setShowCheckSelector(false);
            setCheckSelectorTable(null);
          }}
          onClose={()=>{ setShowCheckSelector(false); setCheckSelectorTable(null); }}
        />
      )}

      {showCustomer && selectedTable && selectedTable.session && (
        <CustomerModal
          orderType="dine-in"
          existing={selectedTable.session.customer || null}
          onConfirm={(c)=>{
            // Write customer onto the table session. POSSurface's v4.4.9 hydrate-on-mount
            // useEffect picks up customer + allergens next time staff enters POS.
            setSessionCustomer(selectedTable.id, c);
            setShowCustomer(false);
            showToast(c?.name ? `Guest "${c.name}" attached` : 'Guest attached', 'success');
          }}
          onCancel={()=>setShowCustomer(false)}
        />
      )}
      {showReservation && selectedTable && (
        <ReservationModal
          table={selectedTable}
          existing={null}
          onConfirm={async (res)=>{
            // v5.5.10: if the operator picked a returning guest from search, the
            // modal already passed the full customer record (with id + allergens
            // + opt-in flag). Skip the upsert+refetch dance in that case.
            // For new guests OR operator-edited fields, fall through to the
            // existing v4.6.67 upsert flow.
            let customerObj = res.customer || null;
            const fieldsMatchSelected = customerObj
              && customerObj.name === res.name
              && (customerObj.phone === res.phone || customerObj.phone_raw === res.phone);

            if (!fieldsMatchSelected && res.phone) {
              // Either no customer was selected, or operator edited away from the
              // selected one — upsert the typed-in fields, then refetch with allergens.
              try {
                const { upsertCustomer, _normalisePhone, _cachedOrgId } = useStore.getState();
                await upsertCustomer({ name: res.name, phone: res.phone });
                const phoneN = _normalisePhone(res.phone);
                if (phoneN && _cachedOrgId) {
                  const { data } = await supabase.from('customers')
                    .select('id, name, phone, phone_raw, email, allergens, marketing_opt_in, notes')
                    .eq('org_id', _cachedOrgId).eq('phone', phoneN).is('deleted_at', null).maybeSingle();
                  if (data) customerObj = data;
                }
              } catch (err) {
                console.warn('[reservation customer upsert]', err?.message || err);
              }
            }
            // Strip our internal `customer` shape off res before saving — it goes
            // back as the explicit customer field on the reservation object.
            const { customer: _cust, ...resCore } = res;
            void _cust;
            const reservationWithCustomer = customerObj ? { ...resCore, customer: customerObj } : resCore;
            setReservation(selectedTable.id, reservationWithCustomer);
            setShowReservation(false);
            showToast(`${selectedTable.label} reserved for ${res.name} at ${res.time}`, 'success');
          }}
          onCancel={()=>setShowReservation(false)}
        />
      )}
      {/* v5.6.27: EDIT mode — prefilled from the claiming booking; confirms via
          updateBooking (partySize→covers, time→startTime, notes→note; the
          booking's tables + date stay as booked). Distinct path so
          setReservation stays create-only. */}
      {editBooking && selectedTable && (
        <ReservationModal
          table={selectedTable}
          existing={{
            name:      editBooking.customer?.name  || '',
            phone:     editBooking.customer?.phone || '',
            partySize: editBooking.covers,
            time:      editBooking.startTime,
            notes:     editBooking.note || '',
            customer:  editBooking.customer || null,
          }}
          onConfirm={(res)=>{
            const customer = res.customer
              ? { ...res.customer, name: res.customer.name || res.name, phone: res.customer.phone || res.phone }
              : { ...(editBooking.customer || {}), name: res.name, phone: res.phone || null };
            updateBooking(editBooking.id, { covers: res.partySize, startTime: res.time, note: res.notes, customer });
            setEditBooking(null);
            showToast(`Booking updated — ${res.name} at ${res.time}`, 'success');
          }}
          onCancel={()=>setEditBooking(null)}
        />
      )}
    </div>
  );
}
