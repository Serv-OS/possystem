import { useState, useRef, useCallback, useEffect } from 'react';
import { useStore } from '../../store';
import { supabase, isMock, getLocationId, getActiveLocationSync } from '../../lib/supabase';
import { saveFloorTableChecked, insertTableTombstone, fetchTableOpenOrders, saveLocationSections } from '../../lib/db';
import { removeSectionRefusal, sectionsSignature, OTHER_SECTION, MIGRATION_TEXT, TILLS_TEXT } from '../../lib/sectionPlan';
import { deleteRefusalReason, writeRefusal, loadPlanState, normaliseFloorRow, pickDef, num, nextSeq, baseOfRow, floorRowOf } from '../../lib/tablePlan';
import { isSessionClosed } from '../../sync/sessionClosure';
import { reportSave } from '../../lib/saveHealth';

const SHAPES = [{ id:'sq', label:'Square/Rect' }, { id:'rd', label:'Round' }];
const SECTION_PALETTE = ['#3b82f6','#e8a020','#22c55e','#a855f7','#ef4444','#22d3ee','#f97316','#ec4899'];

// v5.9.4: one write at a time per table. A second edit waits for the first, so it is checked
// against the updated_at (or columns) the first one produced, never against a stale base.
const _writeChains = new Map();
// Floor plan sections are saved straight away, the venue's WHOLE list each time (lib/sectionPlan.js).
const SECTION_FAIL_TEXT = {
  migration: MIGRATION_TEXT,
  changed: 'Sections were changed on another screen, so your change was NOT saved. The latest sections are shown now, make your change again',
  read: 'Could not check the saved sections, so your change was NOT saved. Check the connection and try again',
  empty: 'Must keep at least one section',
};
const CONFLICT_TEXT = {
  changed: 'was changed on another screen, so your change was NOT saved. Reload Back Office to see the latest floor plan',
  deleted: 'was deleted on another screen, so your change was NOT saved. Reload Back Office to see the latest floor plan',
  exists: 'already exists in the database, so it was NOT added again. Reload Back Office to see the latest floor plan',
  removed: 'is not on the floor plan any more (it still has an open order on a till), so it cannot be edited',
  'no-base': 'has no saved copy in this tab, so your change was NOT saved. Reload Back Office first',
  child: 'is a split check, not a table on the plan',
  missing: 'is not in this tab any more',
};

export default function FloorPlanBuilder() {
  const {
    tables, updateTableLayout, addTableToLayout, removeTableFromLayout,
    locationSections,
    showToast, bookingRules, updateBookingRules,
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
  const sectionChain = useRef(Promise.resolve());   // one section save at a time
  const [sectionNote, setSectionNote] = useState(null);   // a failed section save, until the next one works
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

  // Table mutations are applied to the store first (the canvas has to feel instant); this is the
  // ONLY writer, and what is on screen must be what the database accepted (INVARIANTS.md, tables
  // must never be lost).
  // v5.9.4 review: the write is COMPARE-AND-SET (db.saveFloorTableChecked): a new table is
  // inserted (never upserted over an existing id), an existing one is updated only if the row
  // still has the updated_at (or, before migration 20260918b, the columns) this tab last read.
  // An out of date tab can therefore never put back an old name, a moved table or a deleted
  // table: the save is refused, the canvas is put back and the operator is asked to reload.
  // A retired table (planRemoved, still holding an order on a till) or a tombstoned one is refused
  // before any request goes out. Writes to one table are serialised.
  const confirmTable = useCallback((id, undo) => {
    const prev = _writeChains.get(id) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      setSaveStatus('saving');
      markBOChange();
      clearTimeout(saveTimer.current);
      const table = useStore.getState().tables.find(t => t.id === id);
      const locId = table?.locationId || activeLocationId || null;
      const why = writeRefusal(table, loadPlanState(locId).tombs);
      const clearPending = () => useStore.setState(s => ({ tables: s.tables.map(t => (t.id === id && t._pending) ? { ...t, _pending: false } : t) }));
      if (why) {
        undo?.();
        clearPending();
        setSaveStatus('failed');
        if (table) showToast(`“${table.label}” ${CONFLICT_TEXT[why] || 'was NOT saved'}`, 'error');
        return false;
      }
      const sent = pickDef(table);
      // What the database will hold if the write goes through (raw columns, nulls kept), the base
      // for the next compare when the response carries no row.
      const sentBase = baseOfRow(floorRowOf(table, locId));
      const res = await saveFloorTableChecked(table, locId);
      reportSave('floor plan table', res.ok ? null : (res.error || new Error('not saved')));
      if (!res.ok) {
        undo?.();
        clearPending();
        setSaveStatus('failed');
        showToast(`“${table.label}” ${res.conflict ? (CONFLICT_TEXT[res.conflict] || 'was NOT saved') : 'was NOT saved, the floor plan has been put back'}`, 'error');
        return false;
      }
      // Saved: the database copy is now this tab's base (and its updated_at the next compare).
      const saved = res.row ? normaliseFloorRow(res.row, { locationId: locId }) : null;
      // Observed now: a plan read that started before this write landed cannot put the old copy
      // back (before migration 20260918b there is no updated_at to tell them apart).
      const seq = nextSeq();
      useStore.setState(s => ({ tables: s.tables.map(t => {
        if (t.id !== id) return t;
        const base = saved ? saved._base : sentBase;
        const stillEditing = Object.keys(sent).some(k => t[k] !== sent[k]);
        const { _isNew: _n, ...rest } = t;
        return {
          ...rest,
          _base: base,
          srvAt: saved ? saved.srvAt : num(t.srvAt),
          srvIso: saved ? saved.srvIso : (t.srvIso || null),
          _seq: Math.max(num(t._seq), seq),
          _pending: stillEditing,
        };
      }) }));
      setSaveStatus('pushed');
      saveTimer.current = setTimeout(() => setSaveStatus('saved'), 2500);
      return true;
    });
    _writeChains.set(id, run);
    run.finally(() => { if (_writeChains.get(id) === run) _writeChains.delete(id); }).catch(() => {});
    return run;
  }, [markBOChange, showToast, activeLocationId]);

  // Sections: every add, rename, colour or icon change, hide, reorder and remove writes the venue's
  // WHOLE list to public.sections at once (db.saveLocationSections, checked against the list this
  // tab last read). The screen changes first; a refused save puts it back and says why in plain
  // words. The first save for a venue that only had the built in defaults writes every section on
  // screen, so none of them vanish on reload and no table drops out of a section view.
  const saveSections = useCallback((next, prev, doneText) => {
    useStore.getState().setLocationSections(next);
    const run = sectionChain.current.catch(() => {}).then(async () => {
      setSaveStatus('saving');
      markBOChange();
      clearTimeout(saveTimer.current);
      const loc = activeLocationId || getActiveLocationSync() || null;
      const b = useStore.getState()._sectionsBase;
      const base = b && b.loc === loc ? b.sig : undefined;
      const res = await saveLocationSections(next, loc, { base }).catch(e => ({ ok: false, reason: 'error', error: e }));
      reportSave('floor plan sections', res.ok ? null : (res.error || new Error('not saved')));
      if (!res.ok) {
        if (res.reason === 'changed' && res.latest) {
          useStore.getState().applySavedSections(loc, res.latest);
        } else if (sectionsSignature(useStore.getState().locationSections) === sectionsSignature(next)) {
          useStore.getState().setLocationSections(prev);   // put back, unless a newer edit is on screen
        }
        const msg = SECTION_FAIL_TEXT[res.reason] || 'The section change was NOT saved, it has been put back';
        setSectionNote(msg);
        setSaveStatus('failed');
        showToast(msg, 'error');
        return false;
      }
      useStore.getState().markSectionsSaved(loc, next);
      setSectionNote(null);
      setSaveStatus('pushed');
      saveTimer.current = setTimeout(() => setSaveStatus('saved'), 2500);
      showToast(`${doneText}. ${TILLS_TEXT}`, 'success');
      return true;
    });
    sectionChain.current = run;
    return run;
  }, [markBOChange, showToast, activeLocationId]);

  // v5.5.2: only show tables that belong to the active location. A table without a locationId
  // is a freshly-added one (stamped on save) and is OK to show. Pre-v5.5.2 data lacks
  // locationId entirely — those will appear at every location, but the cross-location guard
  // in upsertFloorTable still prevents corruption.
  const tablesAtThisLocation = tables.filter(t =>
    !t.locationId || !activeLocationId || t.locationId === activeLocationId
  );
  // v5.9.4 review: a table that is off the plan but still holds an open order on a till
  // (planRemoved) is NOT on the editable canvas: dragging or renaming it used to upsert it straight
  // back into floor_tables. It is listed read only below the canvas instead.
  const tablesForThisLocation = tablesAtThisLocation.filter(t => !t.planRemoved);
  const retiredTables = tablesAtThisLocation.filter(t => t.planRemoved && !t.parentId);
  // A table filed under a section that is not in the list (or none) is listed under Other, so it
  // can always be reached and moved into a real section.
  const sectionIds = new Set(locationSections.map(s => s.id));
  const orphanTables = tablesForThisLocation.filter(t => !t.parentId && !sectionIds.has(t.section));
  const displayTables = tablesForThisLocation.filter(t =>
    !t.parentId && (viewSection === 'all' || (viewSection === OTHER_SECTION ? !sectionIds.has(t.section) : t.section === viewSection))
  );

  const addSectionSaved = (sec) => {
    const prev = useStore.getState().locationSections || [];
    const label = String(sec.label || '').trim();
    return saveSections([...prev, { id: `sec-${Date.now()}`, ...sec, label }], prev, `Section “${label}” added`);
  };
  const updateSectionSaved = (id, patch) => {
    const prev = useStore.getState().locationSections || [];
    const label = String(patch.label || '').trim();
    return saveSections(prev.map(x => (x.id === id ? { ...x, ...patch, label, hidden: !!patch.hidden } : x)), prev, `Section “${label}” saved`);
  };
  const moveSectionSaved = (id, direction) => {
    const prev = useStore.getState().locationSections || [];
    const i = prev.findIndex(x => x.id === id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= prev.length) return;
    const next = [...prev];
    [next[i], next[j]] = [next[j], next[i]];
    return saveSections(next, prev, 'Section order saved');
  };
  // Never hide a table: a section that still has tables (on the canvas, or off the plan with an
  // open order on a till) cannot be removed. The person moves them first.
  const removeSectionSaved = (sec) => {
    const prev = useStore.getState().locationSections || [];
    const why = removeSectionRefusal(sec, { tables: tablesAtThisLocation, sections: prev, locationId: activeLocationId });
    if (why) { showToast(why, 'error'); return false; }
    saveSections(prev.filter(x => x.id !== sec.id), prev, `Section “${sec.label}” removed`);
    return true;
  };
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
    if (!now || (from && from.id === id && from.x === now.x && from.y === now.y)) {
      // Nothing moved: no write, and the table is no longer "being edited".
      if (now?._pending) useStore.setState(s => ({ tables: s.tables.map(t => t.id === id ? { ...t, _pending: false } : t) }));
      return;
    }
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
  //
  // v5.9.4: a table with an OPEN ORDER cannot be deleted. Checked against the database, not just
  // this browser (the order is usually on a till), and every leg must RUN or the delete is refused:
  //   - this browser: the table's session and its split child checks (T1 closed, T1.2 open);
  //   - active_sessions: the table AND its split children (id-n);
  //   - order_queue: open QR tabs at the table (customer jsonb, never bar_tabs);
  //   - active_sessions again 1.5 s later: a till's order can still be in its 600 ms write
  //     debounce when the first look runs.
  // A closed session (isSessionClosed) never blocks. What cannot be seen from here: an order on a
  // till that is OFFLINE and has not synced. The till keeps that order reachable (planRemoved),
  // and SessionReconciler rebuilds its table on every other till once it syncs.
  // After the row is gone the delete is a TOMBSTONE (floor_table_tombstones with the database's
  // deleted_at, and on this machine), and the store is told the row is already deleted, so a
  // second delete can never fail on a network blip and put the table back.
  const removeSelectedTable = async () => {
    const table = tablesForThisLocation.find(t => t.id === selected);
    if (!table) return;
    const locId = table.locationId || activeLocationId || null;
    const refuse = (g) => deleteRefusalReason(table, {
      tables: useStore.getState().tables, dbRows: g.dbRows, qrRows: g.qrRows, failed: g.failed, isClosed: isSessionClosed,
    });
    if (!isMock && supabase) {
      if (!locId) { showToast(refuse({ dbRows: [], qrRows: [], failed: ['location'] }), 'error'); return; }
      setSaveStatus('saving');
      let g = await fetchTableOpenOrders(locId, table.id);
      let reason = refuse(g);
      if (!reason) {
        await new Promise(r => setTimeout(r, 1500));
        const g2 = await fetchTableOpenOrders(locId, table.id);
        g = { dbRows: [...g.dbRows, ...g2.dbRows], qrRows: [...g.qrRows, ...g2.qrRows], failed: g2.failed };
        reason = refuse(g);
      }
      if (reason) { setSaveStatus('saved'); showToast(reason, 'error'); return; }
    } else {
      const reason = refuse({ dbRows: [], qrRows: [], failed: [] });
      if (reason) { showToast(reason, 'error'); return; }
    }
    let tomb = null;
    if (!isMock && supabase) {
      let q = supabase.from('floor_tables').delete().eq('id', table.id);
      if (locId) q = q.eq('location_id', locId);   // same tenant scoping as db.deleteFloorTable
      const { data, error } = await q.select('id');
      // Zero rows is what an RLS-filtered delete looks like, and also what a table that never
      // reached the DB looks like. Probe before refusing, or a phantom becomes undeletable.
      let blocked = null;
      if (error) blocked = error;
      else if (!data || data.length === 0) {
        const { data: still, error: probeErr } = await supabase.from('floor_tables').select('id').eq('id', table.id).maybeSingle();
        if (still) blocked = new Error('Table delete matched 0 rows, RLS blocked it');
        else if (probeErr) blocked = probeErr;
      }
      reportSave('floor plan table delete', blocked);
      if (blocked) {
        setSaveStatus('failed');
        showToast(`“${table.label}” was NOT deleted, it is still on the floor plan`, 'error');
        return;
      }
      // The database's own record of the delete (deleted_at from the database clock). Until
      // 20260918_OPS_floor_table_tombstones.sql runs this is skipped and the tombstone travels on
      // this machine and in the next Push to POS instead.
      const tr = await insertTableTombstone(locId, table.id, table.label).catch(() => ({ row: null }));
      const at = num(tr?.row?.deleted_at);
      if (at > 0) tomb = { at, srv: true };
    }
    removeTableFromLayout(table.id, { dbDeleted: true, tomb });
    setSelected(null);
    markChanged();
    showToast(`Table “${table.label}” removed`, 'info');
  };

  const sectionColor = (id) => locationSections.find(s => s.id === id)?.color || '#888780';
  const sectionLabel = (id) => locationSections.find(s => s.id === id)?.label || id;

  // ── Booking join groups (Table Bookings, v5.6.25) ────────────────────────────
  // An ORDERED run of adjacent tables the optimiser may combine. Order IS
  // adjacency: only consecutive members join, so ordering two tables apart is
  // how a manager says "these can never be pushed together". Lives on
  // booking_rules.join_groups (per location), NOT on floor_tables — no new
  // column, no upsert-whitelist/SyncBridge-mapping landmine.
  const joinGroups = bookingRules?.joinGroups || [];
  const groupOf = (tableId) => joinGroups.find(g => (g.tableIds || []).includes(tableId));
  const setJoinGroups = (groups) => {
    updateBookingRules?.({ joinGroups: groups.filter(g => (g.tableIds || []).length) });
    markChanged();
  };
  const assignToGroup = (tableId, groupId) => {
    let groups = joinGroups.map(g => ({ ...g, tableIds: (g.tableIds || []).filter(id => id !== tableId) }));
    if (groupId === '__new__') {
      const sec = selectedTable?.section || 'run';
      groups.push({
        id: `jg-${Date.now().toString(36)}`,
        label: `${sectionLabel(sec)} run`,
        tableIds: [tableId],
        kind: sec === 'bar' ? 'bar' : 'tables',
      });
    } else if (groupId) {
      groups = groups.map(g => (g.id === groupId ? { ...g, tableIds: [...g.tableIds, tableId] } : g));
    }
    setJoinGroups(groups);
  };
  const nudgeInGroup = (tableId, dir) => {
    setJoinGroups(joinGroups.map(g => {
      const i = (g.tableIds || []).indexOf(tableId);
      if (i < 0) return g;
      const j = i + dir;
      if (j < 0 || j >= g.tableIds.length) return g;
      const ids = [...g.tableIds];
      [ids[i], ids[j]] = [ids[j], ids[i]];
      return { ...g, tableIds: ids };
    }));
  };
  const tableLabel = (id) => tablesForThisLocation.find(t => t.id === id)?.label || id;

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

          <div style={{ fontSize:10, color:'var(--t4)', lineHeight:1.4, margin:'2px 0 6px' }}>
            Section changes save straight away. {TILLS_TEXT}.
          </div>
          {sectionNote && (
            <div style={{ fontSize:11, color:'var(--red)', lineHeight:1.4, margin:'0 0 6px', fontWeight:700 }}>{sectionNote}</div>
          )}

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
                <button onClick={(e) => { e.stopPropagation(); moveSectionSaved(sec.id, 'up'); }} style={{
                  width:18, height:22, borderRadius:5, border:'none', background:'transparent',
                  color:'var(--t4)', cursor:'pointer', fontFamily:'inherit', fontSize:11, padding:0,
                  display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0,
                }} title="Move up">▲</button>
                <button onClick={(e) => { e.stopPropagation(); moveSectionSaved(sec.id, 'down'); }} style={{
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
          {orphanTables.length > 0 && (
            <button onClick={() => setViewSection(OTHER_SECTION)} style={{
              width:'100%', marginTop:2, padding:'6px 8px', borderRadius:8, cursor:'pointer', fontFamily:'inherit',
              fontSize:12, fontWeight: viewSection === OTHER_SECTION ? 700 : 400, border:'none',
              background: viewSection === OTHER_SECTION ? 'var(--acc-d)' : 'transparent',
              color: viewSection === OTHER_SECTION ? 'var(--acc)' : 'var(--t2)', textAlign:'left',
              display:'flex', alignItems:'center', justifyContent:'space-between',
            }} title="Tables whose section is not in the list. Pick a section for each one.">
              <span>Other (no section)</span>
              <span style={{ fontSize:10, color:'var(--t4)' }}>{orphanTables.length}</span>
            </button>
          )}
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
                  {!sectionIds.has(selectedTable.section) && (
                    <option value={selectedTable.section ?? ''}>{selectedTable.section ? `${selectedTable.section} (not in the list)` : 'No section'}</option>
                  )}
                  {locationSections.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </div>

              {(() => {
                const grp = groupOf(selectedTable.id);
                return (
                  <div style={{ marginBottom:9, padding:'8px 9px', background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:8 }}>
                    <label style={{ display:'block', fontSize:10, color:'var(--t4)', marginBottom:4 }}>Booking join group</label>
                    <select value={grp?.id || ''} onChange={e => assignToGroup(selectedTable.id, e.target.value)} style={{
                      width:'100%', background:'var(--bg3)', border:'1px solid var(--bdr2)',
                      borderRadius:8, padding:'6px 9px', color:'var(--t1)', fontSize:12,
                      fontFamily:'inherit', outline:'none', cursor:'pointer', boxSizing:'border-box',
                    }}>
                      <option value="">None — never combined</option>
                      {joinGroups.map(g => <option key={g.id} value={g.id}>{g.label} ({g.tableIds.length})</option>)}
                      <option value="__new__">+ New run…</option>
                    </select>
                    {grp && (
                      <>
                        <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginTop:7 }}>
                          {grp.tableIds.map(id => (
                            <span key={id} style={{
                              display:'inline-flex', alignItems:'center', gap:3, padding:'2px 6px', borderRadius:6,
                              fontSize:10, fontWeight:700,
                              background: id === selectedTable.id ? 'var(--acc-d)' : 'var(--bg3)',
                              border:`1px solid ${id === selectedTable.id ? 'var(--acc-b)' : 'var(--bdr)'}`,
                              color: id === selectedTable.id ? 'var(--acc)' : 'var(--t2)',
                            }}>{tableLabel(id)}</span>
                          ))}
                        </div>
                        <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:7 }}>
                          <button onClick={() => nudgeInGroup(selectedTable.id, -1)} title="Move earlier in the run" style={{ width:26, height:24, borderRadius:6, border:'1px solid var(--bdr2)', background:'var(--bg3)', color:'var(--t1)', cursor:'pointer', fontFamily:'inherit', fontSize:11 }}>◀</button>
                          <button onClick={() => nudgeInGroup(selectedTable.id, 1)} title="Move later in the run" style={{ width:26, height:24, borderRadius:6, border:'1px solid var(--bdr2)', background:'var(--bg3)', color:'var(--t1)', cursor:'pointer', fontFamily:'inherit', fontSize:11 }}>▶</button>
                          <label style={{ display:'flex', alignItems:'center', gap:5, fontSize:10, color:'var(--t3)', marginLeft:'auto', cursor:'pointer' }}>
                            <input type="checkbox" checked={grp.kind === 'bar'} onChange={e => setJoinGroups(joinGroups.map(g => g.id === grp.id ? { ...g, kind: e.target.checked ? 'bar' : 'tables' } : g))} />
                            Bar stools
                          </label>
                        </div>
                        <div style={{ fontSize:9.5, color:'var(--t4)', marginTop:6, lineHeight:1.4 }}>
                          Only tables NEXT TO each other in the run can be pushed together. Order = physical adjacency.
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}

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
                Saving…
              </span>
            )}
            {saveStatus === 'pushed' && (
              <span style={{ display:'flex', alignItems:'center', gap:5, color:'var(--acc)', fontWeight:700 }}>
                <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--acc)' }}/>
                ✓ Saved. Tills update on Push to POS or their next plan read
              </span>
            )}
            {saveStatus === 'failed' && (
              <span style={{ display:'flex', alignItems:'center', gap:5, color:'var(--red)', fontWeight:700 }}>
                <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--red)' }}/>
                ✕ Not saved — the change was undone
              </span>
            )}
            {saveStatus === 'saved' && (
              <span style={{ color:'var(--t4)' }}>Changes save straight away. Push to POS updates tills now</span>
            )}
            <span style={{ color:'var(--bdr2)' }}>·</span>
            <span>{displayTables.length} table{displayTables.length !== 1 ? 's' : ''}</span>
          </span>
        </div>

        {/* v5.9.4: tables deleted from the plan that still hold an open order on a till. Read only:
            they are not on the canvas and nothing here can write them back into the plan. */}
        {retiredTables.length > 0 && (
          <div style={{ margin:'12px 20px 0', padding:'8px 12px', borderRadius:10, border:'1px solid var(--bdr)', background:'var(--bg2)', fontSize:12, color:'var(--t2)' }}>
            <div style={{ fontWeight:700, marginBottom:4 }}>Deleted, still has an open order</div>
            <div style={{ color:'var(--t3)' }}>
              {retiredTables.map(t => t.label || t.id).join(', ')}. Close or move the order on the till and the table goes by itself.
            </div>
          </div>
        )}

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
          defaultSection={(viewSection === 'all' || viewSection === OTHER_SECTION) ? locationSections[0]?.id : viewSection}
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
          onSave={sec => { addSectionSaved(sec); setShowAddSection(false); }}
          onClose={() => setShowAddSection(false)}
        />
      )}

      {/* ── Edit section modal ── */}
      {editingSection && (
        <SectionModal
          section={editingSection}
          onSave={sec => { updateSectionSaved(editingSection.id, sec); setEditingSection(null); }}
          onDelete={() => {
            if (!removeSectionSaved(editingSection)) return;
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
