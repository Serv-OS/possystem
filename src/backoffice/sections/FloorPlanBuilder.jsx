import { useState, useRef, useCallback, useEffect } from 'react';
import { useStore } from '../../store';
import { supabase, isMock, getLocationId } from '../../lib/supabase';
import { upsertFloorTable } from '../../lib/db';
import { reportSave } from '../../lib/saveHealth';

const SHAPES = [{ id:'sq', label:'Square/Rect' }, { id:'rd', label:'Round' }];
const SECTION_PALETTE = ['#3b82f6','#e8a020','#22c55e','#a855f7','#ef4444','#22d3ee','#f97316','#ec4899'];

export default function FloorPlanBuilder() {
  const {
    tables, updateTableLayout, addTableToLayout, removeTableFromLayout,
    locationSections, addSection, updateSection, removeSection, moveSection,
    showToast,
  } = useStore();

  // v5.5.2: resolve the active location once on mount and use it as a render-time filter so
  // any stale cross-location data leaked into store.tables (e.g., from a previous location's
  // CONFIG_PUSH still cached in localStorage) doesn't appear on Loc 2's canvas where dragging
  // it would silently rewrite its location_id.
  const [activeLocationId, setActiveLocationId] = useState(null);
  useEffect(() => {
    let alive = true;
    getLocationId().then(id => { if (alive) setActiveLocationId(id); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const [selected, setSelected]   = useState(null);
  const [dragging, setDragging]   = useState(null);
  const [dragOffset, setDragOffset] = useState({ x:0, y:0 });
  const [viewSection, setViewSection] = useState('all');
  const [showAddTable, setShowAddTable] = useState(false);
  const [showAddSection, setShowAddSection] = useState(false);
  const [editingSection, setEditingSection] = useState(null);
  const [saveStatus, setSaveStatus] = useState('saved'); // 'saved' | 'saving' | 'pushed' | 'failed'
  const saveTimer = useRef(null);
  const canvasRef  = useRef(null);
  const dragStart  = useRef(null);   // pre-drag position, for reverting a rejected move

  const { markBOChange } = useStore();

  // Called on every floor plan mutation — shows save status + marks BO as having pending changes
  const markChanged = useCallback(() => {
    setSaveStatus('saving');
    markBOChange();
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      setSaveStatus('pushed');
      setTimeout(() => setSaveStatus('saved'), 2500);
    }, 300);
  }, [markBOChange]);

  // Table mutations are applied to the store first (the canvas has to feel instant) and the
  // store's own write is fire-and-forget — it reported nothing, so a rejected save still
  // showed "✓ Staged" and the table was simply gone at the next boot. Re-issue the SAME row
  // as an awaited, checked upsert and UNDO the canvas when it fails: what is on screen must
  // be what the database accepted (INVARIANTS.md — tables must never be lost).
  const confirmTable = useCallback(async (id, undo) => {
    setSaveStatus('saving');
    markBOChange();
    clearTimeout(saveTimer.current);
    const table = useStore.getState().tables.find(t => t.id === id);
    if (!table) { setSaveStatus('saved'); return false; }
    const { error } = await upsertFloorTable(table);
    reportSave('floor plan table', error);
    if (error) {
      undo?.();
      setSaveStatus('failed');
      showToast(`“${table.label}” was NOT saved — the floor plan has been put back`, 'error');
      return false;
    }
    setSaveStatus('pushed');
    saveTimer.current = setTimeout(() => setSaveStatus('saved'), 2500);
    return true;
  }, [markBOChange, showToast]);

  // v5.5.2: only show tables that belong to the active location. A table without a locationId
  // is a freshly-added one (stamped on save) and is OK to show. Pre-v5.5.2 data lacks
  // locationId entirely — those will appear at every location, but the cross-location guard
  // in upsertFloorTable still prevents corruption.
  const tablesForThisLocation = tables.filter(t =>
    !t.locationId || !activeLocationId || t.locationId === activeLocationId
  );
  const displayTables = tablesForThisLocation.filter(t =>
    !t.parentId && (viewSection === 'all' || t.section === viewSection)
  );
  const selectedTable = tablesForThisLocation.find(t => t.id === selected);

  // Drag handlers
  const handleMouseDown = useCallback((e, tableId) => {
    e.preventDefault();
    const rect = canvasRef.current.getBoundingClientRect();
    const table = tables.find(t => t.id === tableId);
    if (!table) return;
    setDragging(tableId);
    setSelected(tableId);
    dragStart.current = { id: tableId, x: table.x, y: table.y };
    setDragOffset({ x: e.clientX - rect.left - table.x, y: e.clientY - rect.top - table.y });
  }, [tables]);

  const handleMouseMove = useCallback((e) => {
    if (!dragging || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.round((e.clientX - rect.left - dragOffset.x) / 8) * 8);
    const y = Math.max(28, Math.round((e.clientY - rect.top - dragOffset.y) / 8) * 8);
    updateTableLayout(dragging, { x, y });
  }, [dragging, dragOffset, updateTableLayout]);

  const handleMouseUp = useCallback(() => {
    if (!dragging) return;
    const id = dragging;
    const from = dragStart.current;
    setDragging(null);
    dragStart.current = null;
    const now = useStore.getState().tables.find(t => t.id === id);
    // A plain click to select isn't a change — don't write, and don't claim a save either.
    if (!now || (from && from.id === id && from.x === now.x && from.y === now.y)) return;
    confirmTable(id, from && from.id === id ? () => updateTableLayout(id, { x: from.x, y: from.y }) : undefined);
  }, [dragging, confirmTable, updateTableLayout]);

  const upd = (key, val) => {
    if (!selected) return;
    const before = useStore.getState().tables.find(t => t.id === selected)?.[key];
    updateTableLayout(selected, { [key]: val });
    confirmTable(selected, () => updateTableLayout(selected, { [key]: before }));
  };

  // v5.5.739: table labels must be unique per location (a duplicate "number" breaks seating,
  // session sync and reports). Compare case-insensitively against this location's non-child tables.
  const labelTaken = (label, exceptId) => {
    const n = String(label || '').trim().toLowerCase();
    if (!n) return false;
    return tablesForThisLocation.some(t => t.id !== exceptId && !t.parentId
      && String(t.label || '').trim().toLowerCase() === n);
  };
  // The Label edit is a draft committed on blur — blocking per-keystroke would stop you typing
  // "T10" just because "T1" exists. Duplicates are rejected only on commit.
  const [labelDraft, setLabelDraft] = useState('');
  useEffect(() => { setLabelDraft(selectedTable?.label || ''); }, [selected, selectedTable?.label]);
  // Width/height commit on blur, like the label above. upd() reverts to a snapshot when
  // the write is refused, and firing it per keystroke means one request per digit — each
  // holding its own stale "before", so a single refusal mid-type would snap the table back
  // to a size from several keystrokes ago.
  const [sizeDraft, setSizeDraft] = useState({});
  useEffect(() => { setSizeDraft({}); }, [selected]);
  const commitSize = (key) => {
    const raw = sizeDraft[key];
    setSizeDraft(d => { const n = { ...d }; delete n[key]; return n; });
    if (raw == null || !selectedTable) return;
    const v = Math.min(200, Math.max(40, parseInt(raw, 10) || 64));
    if (v !== selectedTable[key]) upd(key, v);
  };

  const commitLabel = () => {
    if (!selectedTable) return;
    const v = labelDraft.trim();
    if (!v || v === selectedTable.label) { setLabelDraft(selectedTable.label); return; }
    if (labelTaken(v, selectedTable.id)) {
      showToast(`Table “${v}” already exists`, 'error');
      setLabelDraft(selectedTable.label);
      return;
    }
    upd('label', v);
  };

  // Delete DB-first: the store's remover drops the table from state and fires a delete whose
  // .catch() can never run (PostgREST resolves with { error }, it never rejects), so a blocked
  // delete looked done and the table walked back in on the next boot.
  const removeSelectedTable = async () => {
    const table = tablesForThisLocation.find(t => t.id === selected);
    if (!table) return;
    if (!isMock && supabase) {
      setSaveStatus('saving');
      const locId = table.locationId || activeLocationId || null;
      let q = supabase.from('floor_tables').delete().eq('id', table.id);
      if (locId) q = q.eq('location_id', locId);   // same tenant scoping as db.deleteFloorTable
      const { data, error } = await q.select('id');
      // Zero rows is what an RLS-filtered delete looks like — and also what a table that never
      // reached the DB looks like. Probe before refusing, or a phantom becomes undeletable.
      let blocked = null;
      if (error) blocked = error;
      else if (!data || data.length === 0) {
        const { data: still } = await supabase.from('floor_tables').select('id').eq('id', table.id).maybeSingle();
        if (still) blocked = new Error('Table delete matched 0 rows — RLS blocked it');
      }
      reportSave('floor plan table delete', blocked);
      if (blocked) {
        setSaveStatus('failed');
        showToast(`“${table.label}” was NOT deleted — it is still on the floor plan`, 'error');
        return;
      }
    }
    removeTableFromLayout(table.id);
    setSelected(null);
    markChanged();
    showToast(`Table “${table.label}” removed`, 'info');
  };

  const sectionColor = (id) => locationSections.find(s => s.id === id)?.color || '#888780';
  const sectionLabel = (id) => locationSections.find(s => s.id === id)?.label || id;

  return (
    <div style={{ display:'flex', height:'100%', overflow:'hidden' }}>

      {/* ── Left panel ── */}
      <div style={{ width:240, borderRight:'1px solid var(--bdr)', display:'flex', flexDirection:'column', background:'var(--bg1)', flexShrink:0, overflow:'hidden' }}>

        {/* Sections management */}
        <div style={{ padding:'12px 12px 8px', borderBottom:'1px solid var(--bdr)' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
            <span style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.1em' }}>Sections</span>
            <button onClick={() => setShowAddSection(true)} style={{ fontSize:11, fontWeight:700, color:'var(--acc)', background:'none', border:'none', cursor:'pointer', fontFamily:'inherit', padding:0 }}>+ Add</button>
          </div>

          <button onClick={() => setViewSection('all')} style={{
            width:'100%', marginBottom:3, padding:'6px 8px', borderRadius:8,
            cursor:'pointer', fontFamily:'inherit', fontSize:12,
            fontWeight: viewSection==='all' ? 700 : 400, border:'none',
            background: viewSection==='all' ? 'var(--acc-d)' : 'transparent',
            color: viewSection==='all' ? 'var(--acc)' : 'var(--t2)',
            textAlign:'left', borderLeft:`2px solid ${viewSection==='all' ? 'var(--acc)' : 'transparent'}`,
          }}>All sections</button>

          {locationSections.map(sec => {
            const active = viewSection === sec.id;
            const count = tablesForThisLocation.filter(t => t.section === sec.id && !t.parentId).length;
            return (
              <div key={sec.id} style={{ display:'flex', alignItems:'center', marginBottom:2 }}>
                <button onClick={() => setViewSection(sec.id)} style={{
                  flex:1, padding:'6px 8px', borderRadius:8, cursor:'pointer', fontFamily:'inherit',
                  fontSize:12, fontWeight: active ? 700 : 400, border:'none',
                  background: active ? `${sec.color}22` : 'transparent',
                  color: active ? sec.color : 'var(--t2)', textAlign:'left',
                  borderLeft:`2px solid ${active ? sec.color : 'transparent'}`,
                  display:'flex', alignItems:'center', justifyContent:'space-between',
                }}>
                  <span>{sec.icon} {sec.label}</span>
                  {sec.hidden ? (
                    <span style={{ fontSize:9, color:'var(--amb,#e8a020)', background:'rgba(232,160,32,.12)', padding:'2px 6px', borderRadius:4, fontWeight:700, textTransform:'uppercase', letterSpacing:'.05em' }}>hidden</span>
                  ) : (
                    <span style={{ fontSize:10, color:'var(--t4)' }}>{count}</span>
                  )}
                </button>
                {/* v4.6.56: reorder buttons */}
                <button onClick={(e) => { e.stopPropagation(); moveSection(sec.id, 'up'); }} style={{
                  width:18, height:22, borderRadius:5, border:'none', background:'transparent',
                  color:'var(--t4)', cursor:'pointer', fontFamily:'inherit', fontSize:11, padding:0,
                  display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0,
                }} title="Move up">▲</button>
                <button onClick={(e) => { e.stopPropagation(); moveSection(sec.id, 'down'); }} style={{
                  width:18, height:22, borderRadius:5, border:'none', background:'transparent',
                  color:'var(--t4)', cursor:'pointer', fontFamily:'inherit', fontSize:11, padding:0,
                  display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0,
                }} title="Move down">▼</button>
                <button onClick={() => setEditingSection(sec)} style={{
                  width:22, height:22, borderRadius:6, border:'none', background:'transparent',
                  color:'var(--t4)', cursor:'pointer', fontFamily:'inherit', fontSize:13,
                  display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0,
                }}
                onMouseEnter={e => e.currentTarget.style.color = 'var(--t1)'}
                onMouseLeave={e => e.currentTarget.style.color = 'var(--t4)'}>✎</button>
              </div>
            );
          })}
        </div>

        {/* Add table button */}
        <div style={{ padding:'10px 12px', borderBottom:'1px solid var(--bdr)' }}>
          <button onClick={() => setShowAddTable(true)} style={{
            width:'100%', padding:'8px', borderRadius:9, cursor:'pointer', fontFamily:'inherit',
            background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:12, fontWeight:700,
          }}>+ Add table</button>
        </div>

        {/* Selected table editor */}
        <div style={{ flex:1, overflowY:'auto', padding:'10px 12px' }}>
          {selected && selectedTable ? (
            <>
              <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.1em', marginBottom:10 }}>
                Edit — {selectedTable.label}
              </div>

              <div style={{ marginBottom:9 }}>
                <label style={{ display:'block', fontSize:10, color:'var(--t4)', marginBottom:4 }}>Label</label>
                <input style={{ width:'100%', background:'var(--bg3)', border:`1px solid ${labelDraft.trim() && labelTaken(labelDraft, selectedTable.id) ? 'var(--red)' : 'var(--bdr2)'}`, borderRadius:8, padding:'6px 9px', color:'var(--t1)', fontSize:12, fontFamily:'inherit', outline:'none', boxSizing:'border-box' }}
                  value={labelDraft} onChange={e => setLabelDraft(e.target.value)} onBlur={commitLabel}
                  onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}/>
                {labelDraft.trim() && labelTaken(labelDraft, selectedTable.id) && (
                  <div style={{ fontSize:10, color:'var(--red)', marginTop:3 }}>⚠ “{labelDraft.trim()}” is already used</div>
                )}
              </div>

              <div style={{ marginBottom:9 }}>
                <label style={{ display:'block', fontSize:10, color:'var(--t4)', marginBottom:4 }}>Max covers</label>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <button onClick={() => upd('maxCovers', Math.max(1, selectedTable.maxCovers - 1))} style={{ width:28, height:28, borderRadius:7, border:'1px solid var(--bdr2)', background:'var(--bg3)', color:'var(--t1)', fontSize:16, cursor:'pointer', fontFamily:'inherit' }}>−</button>
                  <span style={{ fontSize:16, fontWeight:800, minWidth:24, textAlign:'center' }}>{selectedTable.maxCovers}</span>
                  <button onClick={() => upd('maxCovers', Math.min(20, selectedTable.maxCovers + 1))} style={{ width:28, height:28, borderRadius:7, border:'1px solid var(--bdr2)', background:'var(--bg3)', color:'var(--t1)', fontSize:16, cursor:'pointer', fontFamily:'inherit' }}>+</button>
                </div>
              </div>

              <div style={{ marginBottom:9 }}>
                <label style={{ display:'block', fontSize:10, color:'var(--t4)', marginBottom:4 }}>Shape</label>
                <div style={{ display:'flex', gap:5 }}>
                  {SHAPES.map(sh => (
                    <button key={sh.id} onClick={() => upd('shape', sh.id)} style={{
                      flex:1, padding:'5px', borderRadius:7, cursor:'pointer', fontFamily:'inherit',
                      fontSize:10, fontWeight:700,
                      border:`1px solid ${selectedTable.shape===sh.id?'var(--acc)':'var(--bdr)'}`,
                      background: selectedTable.shape===sh.id ? 'var(--acc-d)' : 'var(--bg3)',
                      color: selectedTable.shape===sh.id ? 'var(--acc)' : 'var(--t2)',
                    }}>{sh.label}</button>
                  ))}
                </div>
              </div>

              <div style={{ marginBottom:9 }}>
                <label style={{ display:'block', fontSize:10, color:'var(--t4)', marginBottom:4 }}>Section</label>
                <select value={selectedTable.section} onChange={e => upd('section', e.target.value)} style={{
                  width:'100%', background:'var(--bg3)', border:'1px solid var(--bdr2)',
                  borderRadius:8, padding:'6px 9px', color:'var(--t1)', fontSize:12,
                  fontFamily:'inherit', outline:'none', cursor:'pointer',
                }}>
                  {locationSections.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </div>

              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginBottom:12 }}>
                {[['Width','w'],['Height','h']].map(([label, key]) => (
                  <div key={key}>
                    <label style={{ display:'block', fontSize:10, color:'var(--t4)', marginBottom:4 }}>{label}px</label>
                    <input type="number" min="40" max="200" step="8"
                      style={{ width:'100%', background:'var(--bg3)', border:'1px solid var(--bdr2)', borderRadius:8, padding:'6px 9px', color:'var(--t1)', fontSize:12, fontFamily:'inherit', outline:'none', boxSizing:'border-box' }}
                      value={sizeDraft[key] ?? selectedTable[key]}
                      onChange={e => setSizeDraft(d => ({ ...d, [key]: e.target.value }))}
                      onBlur={() => commitSize(key)}
                      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}/>
                  </div>
                ))}
              </div>

              <button onClick={removeSelectedTable} style={{
                width:'100%', padding:'7px', borderRadius:8, cursor:'pointer', fontFamily:'inherit',
                background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)', fontSize:12, fontWeight:700,
              }}>Remove table</button>
            </>
          ) : (
            <div style={{ textAlign:'center', padding:'30px 0', color:'var(--t4)' }}>
              <div style={{ fontSize:28, marginBottom:8, opacity:.3 }}>⬚</div>
              <div style={{ fontSize:12 }}>Click a table to edit</div>
            </div>
          )}
        </div>
      </div>

      {/* ── Canvas ── */}
      <div style={{ flex:1, overflow:'auto', background:'var(--bg)' }}>
        <div style={{ padding:'8px 14px', borderBottom:'1px solid var(--bdr)', fontSize:11, color:'var(--t4)', background:'var(--bg1)', display:'flex', gap:16, alignItems:'center', flexShrink:0 }}>
          <span>Drag tables to reposition · click to select</span>
          {selected && <span style={{ color:'var(--acc)', fontWeight:700 }}>Editing: {selectedTable?.label}</span>}
          <span style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:6 }}>
            {saveStatus === 'saving' && (
              <span style={{ display:'flex', alignItems:'center', gap:5, color:'var(--t3)' }}>
                <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--acc)', animation:'pulse 1s ease-in-out infinite' }}/>
                Staging…
              </span>
            )}
            {saveStatus === 'pushed' && (
              <span style={{ display:'flex', alignItems:'center', gap:5, color:'var(--acc)', fontWeight:700 }}>
                <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--acc)' }}/>
                ✓ Staged — hit "Push to POS" to go live
              </span>
            )}
            {saveStatus === 'failed' && (
              <span style={{ display:'flex', alignItems:'center', gap:5, color:'var(--red)', fontWeight:700 }}>
                <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--red)' }}/>
                ✕ Not saved — the change was undone
              </span>
            )}
            {saveStatus === 'saved' && (
              <span style={{ color:'var(--t4)' }}>Changes staged until you Push to POS</span>
            )}
            <span style={{ color:'var(--bdr2)' }}>·</span>
            <span>{displayTables.length} table{displayTables.length !== 1 ? 's' : ''}</span>
          </span>
        </div>

        <div
          ref={canvasRef}
          style={{
            position:'relative', minWidth:700, minHeight:600,
            margin:20, background:'var(--bg1)',
            border:'1px solid var(--bdr)', borderRadius:16,
            userSelect:'none', cursor: dragging ? 'grabbing' : 'default',
          }}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onClick={e => { if (e.target === canvasRef.current) setSelected(null); }}
        >
          {/* Section dividers */}
          {locationSections.map((sec, i) => {
            const secTables = displayTables.filter(t => t.section === sec.id);
            if (!secTables.length && viewSection !== 'all') return null;
            const minX = secTables.length ? Math.min(...secTables.map(t => t.x)) - 20 : 20 + i * 160;
            return (
              <div key={sec.id} style={{
                position:'absolute', top:8, left:Math.max(8, minX),
                fontSize:9, fontWeight:800, color:sec.color,
                textTransform:'uppercase', letterSpacing:'.1em', opacity:.7,
              }}>{sec.icon} {sec.label}</div>
            );
          })}

          {/* Tables */}
          {displayTables.map(table => {
            const isSelected = selected === table.id;
            const sColor = sectionColor(table.section);
            const isRound = table.shape === 'rd';
            const isActive = table.status === 'open' || table.status === 'occupied';

            return (
              <div
                key={table.id}
                onMouseDown={e => handleMouseDown(e, table.id)}
                style={{
                  position:'absolute', left:table.x, top:table.y,
                  width:table.w, height:table.h,
                  borderRadius: isRound ? '50%' : 12,
                  background: isSelected ? `${sColor}30` : isActive ? `${sColor}18` : 'var(--bg3)',
                  border:`${isSelected ? 2.5 : 1.5}px solid ${isSelected ? sColor : sColor + '55'}`,
                  boxShadow: isSelected ? `0 0 0 4px ${sColor}28, 0 2px 8px rgba(0,0,0,.1)` : '0 1px 3px rgba(0,0,0,.05)',
                  cursor: dragging === table.id ? 'grabbing' : 'grab',
                  display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
                  gap:2, transition:'box-shadow .1s, background .1s', userSelect:'none',
                }}
              >
                <div style={{ fontSize: table.w > 80 ? 13 : 10, fontWeight:800, color:sColor, letterSpacing:'-.01em' }}>{table.label}</div>
                <div style={{ fontSize:9, color:sColor, opacity:.7 }}>{table.maxCovers} cvr</div>
                {isActive && <div style={{ width:6, height:6, borderRadius:'50%', background:sColor, position:'absolute', top:4, right:4 }}/>}
                {isSelected && <div style={{ position:'absolute', top:-8, right:-8, width:16, height:16, borderRadius:'50%', background:sColor, display:'flex', alignItems:'center', justifyContent:'center', fontSize:9, color:'#fff', fontWeight:800 }}>✓</div>}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Add table modal ── */}
      {showAddTable && (
        <AddTableModal
          sections={locationSections}
          defaultSection={viewSection === 'all' ? locationSections[0]?.id : viewSection}
          labelTaken={labelTaken}
          onClose={() => setShowAddTable(false)}
          onAdd={async table => {
            if (labelTaken(table.label)) { showToast(`Table “${String(table.label).trim()}” already exists`, 'error'); return; }
            const before = new Set(useStore.getState().tables.map(t => t.id));
            await addTableToLayout(table);
            setShowAddTable(false);
            // The store may have refused it (duplicate label) — then there is nothing to confirm.
            const created = useStore.getState().tables.find(t => !before.has(t.id));
            if (!created) return;
            // Revert on failure so a table the DB rejected can't sit on the canvas all evening
            // and "vanish" on refresh — same phantom-create bug as DeviceProfiles v5.5.961.
            // The rollback drops the row from local state ONLY. It must not call
            // removeTableFromLayout: that is now a checked DB writer which would fire a
            // delete for a row that was never inserted, put the table back when that delete
            // found nothing, and clear the red banner confirmTable had just raised.
            await confirmTable(created.id, () =>
              useStore.setState(s => ({ tables: s.tables.filter(t => t.id !== created.id) })));
          }}
        />
      )}

      {/* ── Add section modal ── */}
      {showAddSection && (
        <SectionModal
          section={null}
          onSave={sec => { addSection(sec); markChanged(); setShowAddSection(false); }}
          onClose={() => setShowAddSection(false)}
        />
      )}

      {/* ── Edit section modal ── */}
      {editingSection && (
        <SectionModal
          section={editingSection}
          onSave={sec => { updateSection(editingSection.id, sec); markChanged(); setEditingSection(null); }}
          onDelete={() => {
            if (locationSections.length <= 1) { showToast('Must keep at least one section', 'error'); return; }
            removeSection(editingSection.id);
            markChanged();
            setEditingSection(null);
            setViewSection('all');
          }}
          onClose={() => setEditingSection(null)}
        />
      )}
    </div>
  );
}

// ── Add table modal ───────────────────────────────────────────────────────────
function AddTableModal({ sections, defaultSection, labelTaken, onAdd, onClose }) {
  const [label, setLabel]       = useState('');
  const [maxCovers, setMaxCovers] = useState(4);
  const [shape, setShape]       = useState('sq');
  const [section, setSection]   = useState(defaultSection || sections[0]?.id);

  const dup = !!label.trim() && typeof labelTaken === 'function' && labelTaken(label);
  const inp = { width:'100%', background:'var(--bg3)', border:`1.5px solid ${dup ? 'var(--red)' : 'var(--bdr2)'}`, borderRadius:10, padding:'9px 12px', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', display:'block', boxSizing:'border-box' };

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:20, width:'100%', maxWidth:380, boxShadow:'var(--sh3)', overflow:'hidden' }}>
        <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--bdr)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div style={{ fontSize:16, fontWeight:800 }}>Add table</div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--t3)', cursor:'pointer', fontSize:20 }}>×</button>
        </div>
        <div style={{ padding:'18px 20px' }}>
          <div style={{ marginBottom:14 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:6 }}>Label</label>
            <input style={inp} placeholder="T11, Bar stool 1, Banquette…" value={label} onChange={e => setLabel(e.target.value)} autoFocus/>
            {dup && <div style={{ fontSize:11, color:'var(--red)', marginTop:5 }}>⚠ A table called “{label.trim()}” already exists at this location</div>}
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Max covers</label>
            <div style={{ display:'flex', alignItems:'center', gap:14 }}>
              <button onClick={() => setMaxCovers(c => Math.max(1,c-1))} style={{ width:36, height:36, borderRadius:9, border:'1px solid var(--bdr2)', background:'var(--bg3)', color:'var(--t1)', fontSize:22, cursor:'pointer', fontFamily:'inherit' }}>−</button>
              <span style={{ fontSize:24, fontWeight:800, minWidth:30, textAlign:'center' }}>{maxCovers}</span>
              <button onClick={() => setMaxCovers(c => Math.min(20,c+1))} style={{ width:36, height:36, borderRadius:9, border:'1px solid var(--bdr2)', background:'var(--bg3)', color:'var(--t1)', fontSize:22, cursor:'pointer', fontFamily:'inherit' }}>+</button>
            </div>
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Shape</label>
            <div style={{ display:'flex', gap:8 }}>
              {SHAPES.map(s => <button key={s.id} onClick={() => setShape(s.id)} style={{ flex:1, padding:'9px', borderRadius:10, cursor:'pointer', fontFamily:'inherit', fontSize:12, fontWeight:700, border:`1.5px solid ${shape===s.id?'var(--acc)':'var(--bdr)'}`, background:shape===s.id?'var(--acc-d)':'var(--bg3)', color:shape===s.id?'var(--acc)':'var(--t2)' }}>{s.label}</button>)}
            </div>
          </div>
          <div style={{ marginBottom:20 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Section</label>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
              {sections.map(s => <button key={s.id} onClick={() => setSection(s.id)} style={{ padding:'7px 14px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', fontSize:12, fontWeight:700, border:`1.5px solid ${section===s.id?s.color:'var(--bdr)'}`, background:section===s.id?`${s.color}22`:'var(--bg3)', color:section===s.id?s.color:'var(--t2)' }}>{s.icon} {s.label}</button>)}
            </div>
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button className="btn btn-ghost" style={{ flex:1 }} onClick={onClose}>Cancel</button>
            <button className="btn btn-acc" style={{ flex:2, height:42 }} disabled={!label.trim() || dup} onClick={() => onAdd({ label: label.trim(), maxCovers, shape, section, x:40, y:40, w:shape==='rd'?72:80, h:shape==='rd'?72:64 })}>Add to floor plan</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Section modal (add/edit) ──────────────────────────────────────────────────
function SectionModal({ section, onSave, onDelete, onClose }) {
  const [label, setLabel] = useState(section?.label || '');
  const [color, setColor] = useState(section?.color || '#3b82f6');
  const [icon, setIcon]   = useState(section?.icon  || '🍽');
  const [hidden, setHidden] = useState(!!section?.hidden);  // v4.6.56
  const ICONS = ['🍽','🍸','🌿','☕','🍕','🎭','🌅','🏖','🏠','⬚'];

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:20, width:'100%', maxWidth:360, boxShadow:'var(--sh3)', overflow:'hidden' }}>
        <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--bdr)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div style={{ fontSize:16, fontWeight:800 }}>{section ? 'Edit section' : 'New section'}</div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--t3)', cursor:'pointer', fontSize:20 }}>×</button>
        </div>
        <div style={{ padding:'18px 20px' }}>
          <div style={{ marginBottom:14 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:6 }}>Name</label>
            <input style={{ width:'100%', background:'var(--bg3)', border:'1.5px solid var(--bdr2)', borderRadius:10, padding:'9px 12px', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box' }} value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Rooftop, Garden, Private dining" autoFocus/>
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Colour</label>
            <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
              {SECTION_PALETTE.map(c => <button key={c} onClick={() => setColor(c)} style={{ width:28, height:28, borderRadius:'50%', background:c, border:'none', cursor:'pointer', outline:color===c?'3px solid var(--t1)':'3px solid transparent', outlineOffset:2 }}/>)}
            </div>
          </div>
          <div style={{ marginBottom:20 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Icon</label>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
              {ICONS.map(ic => <button key={ic} onClick={() => setIcon(ic)} style={{ width:36, height:36, borderRadius:9, border:`1.5px solid ${icon===ic?'var(--acc)':'var(--bdr)'}`, background:icon===ic?'var(--acc-d)':'var(--bg3)', cursor:'pointer', fontSize:18 }}>{ic}</button>)}
            </div>
          </div>
          {/* v4.6.56: Hide on POS toggle (only on Edit) */}
          {section && (
            <div style={{ marginBottom:14, padding:'10px 12px', borderRadius:10, background:'var(--bg3)', border:'1px solid var(--bdr)' }}>
              <label style={{ display:'flex', alignItems:'center', gap:10, cursor:'pointer' }}>
                <input type="checkbox" checked={hidden} onChange={e => setHidden(e.target.checked)} style={{ width:16, height:16, cursor:'pointer', accentColor:'var(--acc)' }}/>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, fontWeight:700, color: hidden ? 'var(--amb,#e8a020)' : 'var(--t1)' }}>Hide on POS</div>
                  <div style={{ fontSize:11, color:'var(--t3)', marginTop:2, lineHeight:1.4 }}>Section disappears from POS tabs and the All view. Tables stay in place; you can unhide anytime.</div>
                </div>
              </label>
            </div>
          )}
          <div style={{ display:'flex', gap:8 }}>
            {section && onDelete && <button onClick={onDelete} style={{ padding:'8px 12px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)', fontSize:12, fontWeight:700 }}>Remove</button>}
            <button className="btn btn-ghost" style={{ flex:1 }} onClick={onClose}>Cancel</button>
            <button className="btn btn-acc" style={{ flex:2, height:40 }} disabled={!label.trim()} onClick={() => onSave({ label, color, icon, hidden })}>
              {section ? 'Save' : 'Add section'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
