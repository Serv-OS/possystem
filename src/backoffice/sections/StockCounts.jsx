/**
 * StockCounts: par levels + physical stock counts (Inventory, Stock counts).
 * Mobile friendly: start a count, walk the shelf entering what you actually have,
 * see live variance vs the system, then Approve to reconcile on hand (posts
 * STOCK_COUNT_ADJ). Requires the par/counts migration (20260622_par_counts.sql).
 *
 * 16 Oct 2026 (stock areas, Peter: "you need to count by location then complete as whole, or
 * count via supplier, or just do a spot check"): New count offers Full, By area, By supplier and
 * Spot check; the sheet is grouped by area with a subtotal per area and the item's total across
 * areas; each area is marked complete by its counter (by name); Approve re reads the count first,
 * asks about areas not marked complete, lists items whose OTHER areas still hold stock (with a
 * one tap "It was moved from Cellar" that records a transfer instead of a count adjustment), and
 * posts through a pool with "Posting 240 of 1,100" on the button. Search and filters run over
 * the whole sheet in memory; rows render 50 at a time per area, so a Full count at a 1,000 item
 * venue opens as a list of areas. Until the 16 Oct migration has run (areasReady false) the
 * screen is exactly the 15 Oct one: one New count button, one flat sheet.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useStore } from '../../store';
import { supabase, getActiveLocationSync, getLocationId } from '../../lib/supabase';
import { getLocationConfig } from '../../lib/locationTime';
import { signedMoney } from '../../lib/currency';
import { fetchInventoryItems, fetchSuppliers } from '../../lib/stock/data';
import { fetchCounts, fetchCount, createCount, saveCountLine, approveCount, deleteCount, removeCountLine, markAreaComplete } from '../../lib/stock/counts';
import { openingCosts } from '../../lib/stock/phase0Rules';
import { approvalOutcomeText } from '../../lib/stock/countRules';
import { areasReady, fetchAreas, fetchAreaHoldings, moveHoldingBetweenAreas } from '../../lib/stock/areas';
import {
  COUNT_TYPES, countNameFor, countStatusText, groupLinesByArea, areaSubtotal, rollUpLinesPerItem, filterLines, categoriesOf,
  approvalGate, otherAreaWarnings, visibleRows, RENDER_STEP, COLLAPSE_OVER, postingText,
} from '../../lib/stock/areaRules';
import { toBase, fromBase, formatToken } from '../../lib/stock/uom';
import { countName, fmtVenueDateTime } from '../../lib/venueDate';
import { reportSave } from '../../lib/saveHealth';
import NumberField from '../../components/NumberField';
import StockItemPicker from '../../components/StockItemPicker';

// v5.11.65 (15 Oct 2026 audit): the quantity boxes are the shared NumberField (wide enough for
// "12.55", unit inside the box, no spinner); every date is the venue's, in words; a reopened
// sheet saves only lines the operator touched; and Approve refuses an empty sheet.
const r3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
const NAME_KEY = 'rpos-stock-counter-name';
const readName = (fallback) => { try { return localStorage.getItem(NAME_KEY) || fallback || ''; } catch { return fallback || ''; } };
const keepName = (name) => { try { if (name) localStorage.setItem(NAME_KEY, name); } catch { /* a convenience only */ } };
const fieldStyle = { background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const chip = (on) => ({ fontSize: 11, padding: '4px 9px', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit', background: on ? 'var(--bg3)' : 'transparent', color: on ? 'var(--t1)' : 'var(--t3)', border: '1px solid ' + (on ? 'var(--bg3)' : 'var(--bdr2, var(--bdr))') });
const ghost = { padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t1)', fontSize: 12 };

export default function StockCounts({ orgCtx = null }) {
  const showToast = useStore(s => s.showToast);
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState([]);
  const [active, setActive] = useState(null);   // { ...count, lines, areas }
  const [edits, setEdits] = useState({});       // lineId -> { token: value } (local)
  const [dirty, setDirty] = useState({});       // lineId -> true once the operator typed in it
  const [venueTz, setVenueTz] = useState(null);
  const [busy, setBusy] = useState(false);
  const [posting, setPosting] = useState(null); // { done, total } while approving
  const [loading, setLoading] = useState(true);
  // 16 Oct 2026
  const [areasOn, setAreasOn] = useState(false);
  const [areas, setAreas] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [holdings, setHoldings] = useState({});
  const [starting, setStarting] = useState(false);   // the New count flow is open
  const [collapsed, setCollapsed] = useState({});    // areaKey -> true
  const [chunks, setChunks] = useState({});          // areaKey -> chunks shown
  const [sheetFilter, setSheetFilter] = useState({ q: '', areaId: 'any', category: '', uncountedOnly: false, varianceOnly: false });
  const [review, setReview] = useState(null);        // the pre approval panel
  const loginName = orgCtx?.userName || null;

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    getLocationConfig(loc).then(c => setVenueTz(c?.timezone || null)).catch(() => {});
    const ready = await areasReady(loc);
    setAreasOn(ready);
    const [{ data: its }, { data: cs }, areaRes, supRes, holdRes] = await Promise.all([
      fetchInventoryItems(loc), fetchCounts(loc),
      ready ? fetchAreas(loc) : Promise.resolve({ data: [] }),
      ready ? fetchSuppliers(loc) : Promise.resolve({ data: [] }),
      ready ? fetchAreaHoldings(loc) : Promise.resolve({ data: {} }),
    ]);
    setItems(its || []); setCounts(cs || []); setAreas(areaRes.data || []); setSuppliers(supRes.data || []); setHoldings(holdRes.data || {});
    setLoading(false);
  }, [locId]);
  // the first load runs after this render settles (never a setState straight inside the effect)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(reload, 0); return () => clearTimeout(t); }, []);

  const itemsById = useMemo(() => { const m = {}; (items || []).forEach(i => { m[i.id] = i; }); return m; }, [items]);
  const itemName = useCallback((id) => itemsById[id]?.name || '(item)', [itemsById]);
  const areaNameOf = (id) => areas.find(a => a.id === id)?.name || 'Unassigned';

  // Unit helpers: count in the item's friendly units (Keg / Case / Bottle / base), mixed allowed.
  const uomFor = (id) => { const i = itemsById[id]; return i ? { baseUnit: i.baseUnit, itemConversions: (i.conversions || []).map(c => ({ fromQty: c.fromQty, fromUnit: c.fromUnit, toQty: c.toQty, toUnit: c.toUnit })), formats: (i.packaging || []).map(f => ({ id: f.id, name: f.name, qtyInBase: f.qtyInBase })) } : { baseUnit: 'each', itemConversions: [], formats: [] }; };
  // Count ONLY in the item's named units (Bottle/Case) when it has them: the base
  // unit (ml/g) is maths only and never shown for counting. Fall back to base unit
  // for loose items with no packs defined.
  const countUnitsFor = (id) => { const u = uomFor(id); const fmts = [...u.formats].sort((a, b) => b.qtyInBase - a.qtyInBase).map(f => ({ token: formatToken(f.id), label: f.name })); return fmts.length ? fmts : [{ token: u.baseUnit, label: u.baseUnit }]; };
  const defaultTokenFor = (id) => { const i = itemsById[id]; const cd = (i?.packaging || []).find(f => f.isCountDefault); return cd ? formatToken(cd.id) : (i?.baseUnit || 'each'); };
  const countedBase = (line) => {
    const e = edits[line.id]; if (!e) return null;
    const u = uomFor(line.inventoryItemId);
    let any = false, sum = 0;
    for (const [tok, v] of Object.entries(e)) { if (v === '' || v == null) continue; const n = Number(v); if (!Number.isFinite(n)) continue; any = true; try { sum += toBase(n, tok, u); } catch { /* skip bad unit */ } }
    return any ? sum : null;
  };
  /** The figure the screen holds for a line: typed, else saved. */
  const countedOf = (line) => { const b = countedBase(line); if (b != null) return b; return edits[line.id] ? null : line.countedQty; };
  const fmtQty = (base, itemId) => { const tok = defaultTokenFor(itemId); const u = uomFor(itemId); const units = countUnitsFor(itemId); const label = units.find(x => x.token === tok)?.label || u.baseUnit; const d = fromBase(base, tok, u); return `${r3(d == null ? base : d)} ${label}`; };

  // v5.5.823: counts were create only: an unwanted sheet could never be cleared.
  // Both paths refuse APPROVED counts server side too, because approving posts
  // STOCK_COUNT_ADJ movements that The Gap measures against.
  const removeCount = async (e, c) => {
    e.stopPropagation();
    if (!window.confirm(`Delete "${c.name}"? This count hasn't been approved, so no stock will change.`)) return;
    setBusy(true);
    const { error } = await deleteCount(c.id, locId);
    setBusy(false);
    reportSave('stock count delete', error);
    if (error) { showToast(error.message || 'Could not delete the count', 'error'); return; }
    if (active?.id === c.id) setActive(null);
    showToast(`"${c.name}" deleted`, 'info');
    reload();
  };

  const removeLine = async (line) => {
    const name = itemName(line.inventoryItemId);
    if (!window.confirm(`Remove ${name} from this count?`)) return;
    const { error } = await removeCountLine(line.id, locId);
    reportSave('stock count line delete', error);
    if (error) { showToast(error.message || 'Could not remove that item', 'error'); return; }
    setActive(a => a ? { ...a, lines: a.lines.filter(l => l.id !== line.id) } : a);
    setEdits(prev => { const n = { ...prev }; delete n[line.id]; return n; });
    showToast(`${name} removed`, 'info');
  };

  const seedEdits = (data) => {
    // Seed any previously counted lines into their default unit so editing resumes.
    const init = {};
    data.lines.forEach(l => {
      // full precision, and nothing is written back until the operator edits the line: the old
      // 3dp seed plus save on blur re saved 29.552 l as 29.55 l on every reopen (2 ml of drift a time)
      if (l.countedQty != null) { const tok = defaultTokenFor(l.inventoryItemId); const inU = fromBase(l.countedQty, tok, uomFor(l.inventoryItemId)); init[l.id] = { [tok]: inU == null ? '' : String(Math.round(inU * 1e6) / 1e6) }; }
    });
    return init;
  };
  const openCount = async (id) => {
    const { data, error } = await fetchCount(id, locId);
    if (error) { showToast?.(`Could not open the count: ${error.message || error}`, 'error'); return; }
    if (!data) return;
    setActive(data); setEdits(seedEdits(data)); setDirty({}); setReview(null);
    setCollapsed(data.lines.length > COLLAPSE_OVER ? Object.fromEntries(groupLinesByArea(data.lines, areas).map(g => [g.key, true])) : {});
    setChunks({});
    setSheetFilter({ q: '', areaId: 'any', category: '', uncountedOnly: false, varianceOnly: false });
  };
  /**
   * Re read the count (head, area rows, lines) and merge: lines the operator has typed into
   * keep their typed figure; everything else is what the database has now (review finding 3:
   * the freezer counter's figures saved after the manager opened the sheet).
   */
  const refreshActive = useCallback(async () => {
    if (!active) return null;
    const { data } = await fetchCount(active.id, locId);
    if (!data) return null;
    setActive(data);
    setEdits(prev => {
      const fresh = seedEdits(data);
      for (const id of Object.keys(prev)) if (dirty[id]) fresh[id] = prev[id];
      return fresh;
    });
    return data;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, locId, dirty, itemsById]);

  // The manager watches areas turn complete: a realtime channel on this count's area rows, and a
  // re read when the tab comes back into view.
  const refreshRef = useRef(refreshActive);
  refreshRef.current = refreshActive;
  useEffect(() => {
    if (!active?.id || !areasOn || !supabase) return undefined;
    let timer = null;
    const bump = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { refreshRef.current?.(); }, 400); };
    const ch = supabase.channel(`stock-count-areas-${active.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_count_areas', filter: `count_id=eq.${active.id}` }, bump)
      .subscribe();
    const onFocus = () => { if (document.visibilityState === 'visible') bump(); };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
      try { supabase.removeChannel(ch); } catch { /* already gone */ }
    };
  }, [active?.id, areasOn]);

  // ── starting a count ──
  const startLegacy = async () => {
    // A sheet already open is the one to walk: two identical drafts side by side is how
    // "Count 10/15/2026" came to appear twice at the demo venue.
    const open = counts.find(c => c.status !== 'APPROVED');
    if (open && window.confirm(`"${open.name}" is still open. Carry on with that count instead of starting another?`)) { openCount(open.id); return; }
    setBusy(true);
    const { data, error } = await createCount({ name: countName(new Date(), venueTz, 'FULL'), countType: 'FULL' }, locId);
    setBusy(false);
    reportSave('stock count', error);
    if (error) { showToast?.(error.message, 'error'); return; }
    await reload();
    if (data) openCount(data.id);
  };
  const startWithScope = async ({ type, areaIds, supplierId, itemIds, name, startedByName }) => {
    // the open sheet guard: same type AND same scope is the one to carry on with; a different
    // scope may run alongside (the cellar team and the bar team count at the same time)
    const sameScope = (c) => {
      if (c.status === 'APPROVED' || c.countType !== type) return false;
      if (type === 'AREA') { const have = new Set((c.areas || []).map(a => a.areaId)); return areaIds.length === have.size && areaIds.every(id => have.has(id)); }
      if (type === 'SUPPLIER') return c.supplierId === supplierId;
      return type === 'FULL';
    };
    const open = counts.find(sameScope);
    if (open && window.confirm(`"${open.name}" is still open. Carry on with that count instead of starting another?`)) { setStarting(false); openCount(open.id); return; }
    setBusy(true);
    keepName(startedByName);
    const { data, error } = await createCount({ name, countType: type, areaIds, supplierId, itemIds, startedByName, items, tz: venueTz }, locId);
    setBusy(false);
    reportSave('stock count', error);
    if (error) { showToast?.(error.message, 'error'); if (!data) return; }
    setStarting(false);
    await reload();
    if (data) openCount(data.id);
  };

  // ── editing ──
  const onEdit = (lineId, token, v) => { setEdits(e => ({ ...e, [lineId]: { ...(e[lineId] || {}), [token]: v } })); setDirty(d => ({ ...d, [lineId]: true })); };
  const clearDirty = (ids) => setDirty(d => { const n = { ...d }; ids.forEach(id => { delete n[id]; }); return n; });
  const onBlur = async (line) => {
    if (!edits[line.id] || !dirty[line.id]) return;   // only a line the operator changed is written
    const base = countedBase(line);
    const { error } = await saveCountLine(line.id, base == null ? '' : base, locId);
    reportSave('stock count line', error);
    // The typed figure stays in `edits` so the shelf walk isn't lost: Save progress retries it.
    if (error) showToast?.(`${itemName(line.inventoryItemId)} count NOT saved`, 'error');
    else clearDirty([line.id]);
  };
  /** Push every changed line (or the lines given); returns how many the database refused. */
  const flush = async (lines = active?.lines || []) => {
    let failed = 0; const saved = [];
    for (const line of lines) {
      if (!edits[line.id] || !dirty[line.id]) continue;
      const base = countedBase(line);
      const { error } = await saveCountLine(line.id, base == null ? '' : base, locId);
      reportSave('stock count line', error);
      if (error) failed++; else saved.push(line.id);
    }
    if (saved.length) clearDirty(saved);
    return failed;
  };
  const countedLines = (lines = active?.lines || []) => lines.filter(l => countedOf(l) != null).length;
  const saveProgress = async () => {
    const failed = await flush();
    if (failed) { showToast?.(`${failed} line${failed === 1 ? '' : 's'} NOT saved. Check the connection`, 'error'); return; }
    showToast?.('Progress saved', 'success');
  };

  // ── areas complete ──
  const askName = (what) => {
    const name = window.prompt(`${what}. Counted by:`, readName(loginName));
    if (name == null) return null;
    const n = name.trim() || loginName || '';
    keepName(n);
    return n;
  };
  const completeArea = async (group, complete) => {
    if (complete) {
      const failed = await flush(group.lines);
      if (failed) { showToast?.(`${failed} line${failed === 1 ? '' : 's'} in ${group.name} could not be saved, so it is not marked complete`, 'error'); return; }
      const name = askName(`Mark ${group.name} complete`);
      if (name == null) return;
      const { error } = await markAreaComplete(active.id, group.areaId, { complete: true, byName: name }, locId);
      reportSave('stock count area', error);
      if (error) { showToast?.(error.message, 'error'); return; }
      showToast?.(`${group.name} marked complete`, 'success');
    } else {
      const { error } = await markAreaComplete(active.id, group.areaId, { complete: false }, locId);
      reportSave('stock count area', error);
      if (error) { showToast?.(error.message, 'error'); return; }
    }
    await refreshActive();
  };

  // ── approval ──
  const approve = async () => {
    const counted = countedLines();
    if (counted === 0) { showToast?.('Nothing has been counted yet. Enter at least one figure before approving.', 'error'); return; }
    setBusy(true);
    // Approving reconciles stock to what is STORED on the lines, so a line that
    // failed to save would silently reconcile stock to the old figure.
    const failed = await flush();
    if (failed) {
      setBusy(false);
      showToast?.(`${failed} line${failed === 1 ? '' : 's'} could not be saved. Not approved, so no stock was changed`, 'error');
      return;
    }
    // Re read before any words are shown, with or without areas: the other counters' figures and
    // completions since this sheet was opened are part of what the manager is approving, and the
    // figures typed on this screen are saved by flush() but never written back into active.lines.
    const fresh = await refreshActive();
    let liveHoldings = holdings;
    if (areasOn) { const { data: h } = await fetchAreaHoldings(locId); liveHoldings = h || {}; setHoldings(liveHoldings); }
    setBusy(false);
    if (!fresh) { showToast?.('Could not re read the count. Try again.', 'error'); return; }
    const lines = fresh.lines;
    const countedNow = lines.filter(l => l.countedQty != null).length;
    const uncounted = lines.length - countedNow;
    const gate = approvalGate(fresh.areas || []);
    const receiving = areas.find(a => a.isReceiving)?.id || null;
    const warnings = (areasOn && fresh.countType !== 'FULL') ? otherAreaWarnings(lines, liveHoldings, areas, receiving, (l) => l.countedQty) : [];
    setReview({
      fresh, countedNow, uncounted, gate, warnings,
      moves: Object.fromEntries(warnings.filter(w => w.moveFrom).map(w => [w.lineId, true])),
      confirmIncomplete: false,
    });
  };
  const runApproval = async () => {
    const r = review;
    if (!r) return;
    if (!r.gate.ok && !r.confirmIncomplete) { showToast?.('Tick "Approve anyway" or mark the areas complete first', 'error'); return; }
    setBusy(true);
    // the transfers the manager agreed to: posted first, so the count adjustment for those lines is 0
    let movedCount = r.movedCount || 0;
    for (const w of (r.movesDone ? [] : r.warnings)) {
      if (!w.moveFrom || !r.moves[w.lineId]) continue;
      const mv = await moveHoldingBetweenAreas({ inventoryItemId: w.itemId, fromAreaId: w.moveFrom.areaId, toAreaId: w.areaId, qtyBase: w.moveFrom.qty, note: `Found by count ${r.fresh.name}`, byName: loginName, item: itemsById[w.itemId] }, locId);
      reportSave('stock transfer', mv.error);
      if (mv.error) { setBusy(false); showToast?.(`${itemName(w.itemId)}: the move from ${w.moveFrom.name} was refused (${mv.error.message || mv.error}). Not approved, nothing posted.`, 'error'); return; }
      movedCount++;
    }
    setPosting({ done: 0, total: 0 });
    // v5.11.79: the costs the manager typed for items counted for the first time (opening stock is
    // never valued at 0), plus what the screen already knows for them (openingCosts, tested).
    const { costs } = openingCosts(r.needsCost || [], itemsById, r.typedCosts || {});
    const { error, data: outcome, needsCost, pinRefused } = await approveCount(active.id, locId, {
      approvedByName: loginName, approvalNote: r.gate.ok ? null : r.gate.note,
      onProgress: (p) => setPosting(p), costs, pin: r.pin || '',
    });
    setPosting(null); setBusy(false);
    if (pinRefused) {
      // Nothing was written: the PIN was not a manager's here (or too many wrong ones).
      setReview(prev => ({ ...(prev || r), movesDone: true, movedCount, pin: '' }));
      showToast?.(error?.message || 'That PIN is not a manager at this venue.', 'error');
      return;
    }
    if (needsCost && needsCost.length) {
      // Nothing was written. Ask for a cost per item, keep the moves already recorded.
      const known = openingCosts(needsCost, itemsById, r.typedCosts || {});
      setReview(prev => ({ ...(prev || r), needsCost, movesDone: true, movedCount, typedCosts: { ...Object.fromEntries(Object.entries(known.costs).map(([k, v]) => [k, String(v)])), ...(prev?.typedCosts || {}) } }));
      showToast?.(error?.message || 'Enter a cost for the items counted for the first time', 'error');
      return;
    }
    reportSave('stock count approval', error);
    if (error) { showToast?.(error.message, 'error'); await refreshActive(); return; }
    setReview(null);
    const words = outcome?.oneCall ? outcome.text : approvalOutcomeText({ posted: outcome?.posted ?? 0, total: outcome?.total ?? 0 });
    showToast?.(words + (movedCount ? ` ${movedCount} transfer${movedCount === 1 ? '' : 's'} recorded.` : ''), 'success');
    const { data } = await fetchCount(active.id, locId);
    setActive(data); setEdits({}); await reload();
  };

  if (loading) return <div style={{ padding: 26, color: 'var(--t3)' }}>Loading...</div>;

  // ── Count sheet ──
  if (active) {
    const approved = active.status === 'APPROVED';
    const countedNum = countedLines();
    const shownLines = filterLines(active.lines, sheetFilter, { itemsById, countedOf });
    const groups = groupLinesByArea(shownLines, areas);
    const rollUp = rollUpLinesPerItem(active.lines, countedOf);
    const areaRowOf = (areaId) => (active.areas || []).find(a => a.areaId === areaId) || null;
    const status = countStatusText(active.areas);
    const categories = categoriesOf(active.lines.map(l => itemsById[l.inventoryItemId]).filter(Boolean));
    const filtersOn = sheetFilter.q || sheetFilter.areaId !== 'any' || sheetFilter.category || sheetFilter.uncountedOnly || sheetFilter.varianceOnly;
    const hasAreas = areasOn && active.lines.some(l => l.areaId);
    return (
      <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '18px 20px', maxWidth: 760, margin: '0 auto' }}>
        <button onClick={() => { setActive(null); setReview(null); reload(); }} style={{ background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer', fontSize: 13, marginBottom: 10 }}>← All counts</button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4, gap: 10 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: 'var(--t1)' }}>{active.name}</h1>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {areasOn && !approved && <button onClick={() => refreshActive()} title="Re read the sheet: other counters' figures and completed areas" style={ghost}>Refresh</button>}
            <span style={{ fontSize: 11, fontWeight: 700, color: approved ? 'var(--grn, #16a34a)' : 'var(--t3)' }}>{active.status}</span>
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 10 }}>
          {countedNum}/{active.lines.length} counted{approved ? ` · variance ${signedMoney(active.varianceValue || 0)}` : ''}
          {status.text && <span style={{ color: status.ready ? 'var(--grn, #16a34a)' : 'var(--t3)' }}> · {status.text}</span>}
          {active.startedByName && <span> · started by {active.startedByName}</span>}
          {approved && active.approvedByName && <span> · approved by {active.approvedByName}</span>}
          {approved && active.approvalNote && <span style={{ color: 'var(--amber, #F5A623)' }}> · {active.approvalNote}</span>}
        </div>

        {/* search and filters over the whole sheet (in memory) */}
        {(active.lines.length > 12 || hasAreas) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            <input value={sheetFilter.q} onChange={e => setSheetFilter(f => ({ ...f, q: e.target.value }))} placeholder="Search by name, SKU or supplier code" style={{ ...fieldStyle, width: '100%' }} />
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
              {hasAreas && (
                <>
                  <button onClick={() => setSheetFilter(f => ({ ...f, areaId: 'any' }))} style={chip(sheetFilter.areaId === 'any')}>All areas</button>
                  {groupLinesByArea(active.lines, areas).map(g => <button key={g.key} onClick={() => setSheetFilter(f => ({ ...f, areaId: g.areaId || 'none' }))} style={chip(sheetFilter.areaId === (g.areaId || 'none'))}>{g.name}</button>)}
                </>
              )}
              {categories.length > 1 && (
                <select value={sheetFilter.category} onChange={e => setSheetFilter(f => ({ ...f, category: e.target.value }))} style={{ ...fieldStyle, padding: '4px 8px', fontSize: 11 }}>
                  <option value="">Any category</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              )}
              <button onClick={() => setSheetFilter(f => ({ ...f, uncountedOnly: !f.uncountedOnly }))} style={chip(sheetFilter.uncountedOnly)}>Uncounted only</button>
              <button onClick={() => setSheetFilter(f => ({ ...f, varianceOnly: !f.varianceOnly }))} style={chip(sheetFilter.varianceOnly)}>Variance only</button>
              {filtersOn && <span style={{ fontSize: 11, color: 'var(--t3)' }}>{shownLines.length} of {active.lines.length} lines</span>}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 80 }}>
          {groups.length === 0 && <div style={{ fontSize: 13, color: 'var(--t3)' }}>No lines match.</div>}
          {groups.map(group => {
            const showHeader = hasAreas || group.areaId;
            const sub = areaSubtotal(group.lines, countedOf);
            const row = group.areaId ? areaRowOf(group.areaId) : null;
            const isCollapsed = !!collapsed[group.key];
            const shown = visibleRows(group.lines.length, chunks[group.key] || 1, RENDER_STEP);
            return (
              <div key={group.key}>
                {showHeader && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 10, background: 'var(--bg2)', border: '1px solid ' + (row?.status === 'complete' ? 'var(--grn, #16a34a)' : 'var(--bdr)'), marginBottom: 8, flexWrap: 'wrap' }}>
                    <button onClick={() => setCollapsed(c => ({ ...c, [group.key]: !isCollapsed }))} style={{ background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer', fontSize: 12, padding: 0 }} title={isCollapsed ? 'Show the lines' : 'Hide the lines'}>{isCollapsed ? '▸' : '▾'}</button>
                    <div style={{ flex: 1, minWidth: 140 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>{group.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--t3)' }}>
                        {sub.counted}/{sub.total} counted{sub.counted ? ` · ${signedMoney(sub.varianceValue)} variance` : ''}
                        {row?.status === 'complete' && <span style={{ color: 'var(--grn, #16a34a)' }}> · Complete{row.completedByName ? ` · ${row.completedByName}` : ''}{row.completedAt ? ` · ${fmtVenueDateTime(row.completedAt, venueTz)}` : ''}</span>}
                      </div>
                    </div>
                    {row && !approved && (row.status === 'complete'
                      ? <button onClick={() => completeArea(group, false)} style={ghost}>Reopen</button>
                      : <button onClick={() => completeArea(group, true)} style={{ ...ghost, background: 'var(--grn, #16a34a)', color: '#fff', border: 0, fontWeight: 700 }}>Mark {group.name} complete</button>)}
                  </div>
                )}
                {!isCollapsed && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {group.lines.slice(0, shown).map(line => {
                      const u = uomFor(line.inventoryItemId);
                      const units = countUnitsFor(line.inventoryItemId);
                      const dToken = defaultTokenFor(line.inventoryItemId);
                      const dLabel = units.find(x => x.token === dToken)?.label || u.baseUnit;
                      const expDisp = fromBase(line.expectedQty, dToken, u);
                      const base = countedBase(line);
                      const variance = base == null ? null : base - line.expectedQty;
                      const roll = rollUp[line.inventoryItemId];
                      const pieces = roll && roll.pieces.length > 1 ? roll.pieces : null;
                      return (
                        <div key={line.id} style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 10, padding: '10px 14px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                            <div style={{ fontSize: 14, color: 'var(--t1)' }}>{itemName(line.inventoryItemId)}</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <div style={{ fontSize: 11, color: line.expectedQty < 0 ? 'var(--red, #ef4444)' : 'var(--t3)' }} title={line.expectedQty < 0 ? 'The system has this below zero: more was sold or used than was ever received' : undefined}>system: {r3(expDisp == null ? line.expectedQty : expDisp)} {dLabel}</div>
                              {/* drop a single item off the sheet without binning the whole count */}
                              {!approved && (
                                <button onClick={() => removeLine(line)} title={`Remove ${itemName(line.inventoryItemId)} from this count`}
                                  style={{ width: 24, height: 24, flexShrink: 0, borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit',
                                    border: '1px solid var(--bdr)', background: 'var(--bg1)', color: 'var(--t3)', fontSize: 12, lineHeight: 1 }}>×</button>
                              )}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                            {units.map(uo => (
                              <NumberField key={uo.token} width={112} unit={uo.label} disabled={approved} value={edits[line.id]?.[uo.token] ?? ''}
                                onChange={v => onEdit(line.id, uo.token, v)} onBlur={() => onBlur(line)} inputStyle={{ fontSize: 16 }} />
                            ))}
                          </div>
                          {base != null && (() => {
                            const cDisp = fromBase(base, dToken, u);
                            const vDisp = (cDisp != null && expDisp != null) ? cDisp - expDisp : null;
                            return (
                              <div style={{ fontSize: 11, marginTop: 6, color: variance < 0 ? 'var(--red, #ef4444)' : variance > 0 ? 'var(--grn, #16a34a)' : 'var(--t3)' }}>
                                counted = {r3(cDisp == null ? base : cDisp)} {dLabel}{vDisp != null && vDisp !== 0 ? ` · ${vDisp > 0 ? '+' : ''}${r3(vDisp)} vs system` : ' · matches'}
                              </div>
                            );
                          })()}
                          {pieces && (
                            <div style={{ fontSize: 11, marginTop: 4, color: roll.movedBetweenAreas ? 'var(--grn, #16a34a)' : 'var(--t4)' }}>
                              {pieces.map(p => `${p.counted == null ? '?' : fmtQty(p.counted, line.inventoryItemId)} in ${areaNameOf(p.areaId)}`).join(', ')}
                              {roll.allCounted ? `: ${fmtQty(roll.counted, line.inventoryItemId)} total` : ''}
                              {roll.movedBetweenAreas ? ' · moved between areas, total matches' : ''}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {shown < group.lines.length && (
                      <button onClick={() => setChunks(c => ({ ...c, [group.key]: (c[group.key] || 1) + 1 }))} style={{ ...ghost, alignSelf: 'center' }}>
                        Show {Math.min(RENDER_STEP, group.lines.length - shown)} more of {group.lines.length - shown} in {group.name}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* the pre approval review (gate, other areas, the moves) */}
        {review && !approved && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'grid', placeItems: 'center', zIndex: 50, padding: 16 }} onClick={() => !busy && setReview(null)}>
            <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 18, maxWidth: 560, width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--t1)', marginBottom: 6 }}>Approve this count?</div>
              <div style={{ fontSize: 13, color: 'var(--t2)', marginBottom: 10 }}>
                {review.countedNow} counted line{review.countedNow === 1 ? '' : 's'} will adjust stock to your figures and post the differences to the ledger.
                {review.uncounted ? ` ${review.uncounted} uncounted line${review.uncounted === 1 ? '' : 's'} will be left as the system has them.` : ''}
              </div>
              {!review.gate.ok && (
                <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--amber, #F5A623)', marginBottom: 10 }}>
                  <div style={{ fontSize: 13, color: 'var(--t1)' }}>{review.gate.confirmText}</div>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--t2)', marginTop: 6, cursor: 'pointer' }}>
                    <input type="checkbox" checked={review.confirmIncomplete} onChange={e => setReview(r => ({ ...r, confirmIncomplete: e.target.checked }))} /> Approve anyway (the count will say so)
                  </label>
                </div>
              )}
              {review.warnings.length > 0 && (
                <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--bdr)', marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 6 }}>These items still hold stock in an area this count did not cover. Approving as counted ADDS to the item total; tick "it was moved" to record a transfer instead.</div>
                  {review.warnings.map(w => (
                    <div key={w.lineId} style={{ fontSize: 12.5, color: 'var(--t1)', padding: '6px 0', borderTop: '1px solid var(--bg3)' }}>
                      <b>{itemName(w.itemId)}</b>: {areaNameOf(w.areaId)} {fmtQty(w.counted, w.itemId)}, {w.others.map(o => `${o.name} still ${fmtQty(o.qty, w.itemId)}`).join(', ')}, total {fmtQty(w.totalAfter, w.itemId)}
                      {w.moveFrom && (
                        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--t2)', marginTop: 4, cursor: 'pointer' }}>
                          <input type="checkbox" checked={!!review.moves[w.lineId]} onChange={e => setReview(r => ({ ...r, moves: { ...r.moves, [w.lineId]: e.target.checked } }))} />
                          It was moved from {w.moveFrom.name} ({fmtQty(w.moveFrom.qty, w.itemId)}): record the transfer, total stays {fmtQty(w.totalAfter - w.moveFrom.qty, w.itemId)}
                        </label>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {review.needsCost && review.needsCost.length > 0 && (
                <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--amber, #F5A623)', marginBottom: 10 }}>
                  <div style={{ fontSize: 12.5, color: 'var(--t1)', marginBottom: 6 }}>Counted here for the first time with no cost yet. Opening stock is never valued at 0: enter a cost per {'base unit'} for each (from an invoice or the supplier price list).</div>
                  {review.needsCost.map(n => {
                    const iid = n.item_id || n.itemId;
                    return (
                      <label key={iid} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'var(--t1)', padding: '4px 0', borderTop: '1px solid var(--bg3)' }}>
                        <span>{n.name || itemName(iid)} <span style={{ color: 'var(--t3)' }}>per {itemsById[iid]?.baseUnit || 'unit'}</span></span>
                        <input inputMode="decimal" value={review.typedCosts?.[iid] ?? ''} placeholder="0.00"
                          onChange={e => { const v = e.target.value; setReview(r => ({ ...r, typedCosts: { ...(r.typedCosts || {}), [iid]: v } })); }}
                          style={{ width: 110, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--bg1)', color: 'var(--t1)', fontFamily: 'var(--font-mono)' }} />
                      </label>
                    );
                  })}
                </div>
              )}
              {/* v5.11.84 (multi site stock Drop 0, plan 4.17): a manager PIN approves a count. */}
              <label style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'var(--t1)', marginBottom: 10 }}>
                Manager PIN
                <input type="password" inputMode="numeric" autoComplete="off" value={review.pin || ''} placeholder="PIN"
                  onChange={e => { const v = e.target.value.replace(/\D/g, '').slice(0, 8); setReview(r => ({ ...r, pin: v })); }}
                  style={{ width: 110, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--bg1)', color: 'var(--t1)', fontFamily: 'var(--font-mono)' }} />
              </label>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button onClick={() => setReview(null)} disabled={busy} style={ghost}>Not yet</button>
                {/* an empty or short PIN never reaches the database (it is not a wrong try) */}
                <button onClick={runApproval} disabled={busy || (!review.gate.ok && !review.confirmIncomplete) || String(review.pin || '').length < 4} style={{ ...ghost, background: 'var(--grn, #16a34a)', color: '#fff', border: 0, fontWeight: 700, opacity: (busy || (!review.gate.ok && !review.confirmIncomplete) || String(review.pin || '').length < 4) ? 0.6 : 1 }}>
                  {posting ? postingText(posting.done, posting.total) : busy ? 'Approving...' : 'Approve and reconcile stock'}
                </button>
              </div>
            </div>
          </div>
        )}

        {!approved && (
          <div style={{ position: 'sticky', bottom: 0, background: 'var(--bg0)', padding: '12px 0', borderTop: '1px solid var(--bdr)', display: 'flex', gap: 10 }}>
            <button onClick={saveProgress} style={{ flex: 1, padding: '12px', borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t1)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Save progress</button>
            <button onClick={approve} disabled={busy} style={{ flex: 2, padding: '12px', borderRadius: 10, background: 'var(--grn, #16a34a)', color: '#fff', border: 0, fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>{posting ? postingText(posting.done, posting.total) : busy ? 'Approving...' : 'Approve & reconcile stock'}</button>
          </div>
        )}
      </div>
    );
  }

  // ── Count list ──
  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px', maxWidth: 760 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--t1)' }}>Stock counts</h1>
        <button onClick={() => (areasOn ? setStarting(s => !s) : startLegacy())} disabled={busy || items.length === 0} style={{ padding: '10px 18px', borderRadius: 9, background: 'var(--acc)', color: '#fff', border: 0, fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: (busy || !items.length) ? 0.6 : 1 }}>{starting ? 'Close' : '+ New count'}</button>
      </div>
      <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 18 }}>Count what you physically have; Approve reconciles the system to your count and records the variance (feeds “The Gap” report).{areasOn && areas.length > 0 ? ' Count area by area, by supplier, or spot check a few items; each area is marked complete by whoever counted it, then the whole count is approved.' : ''}</div>
      {items.length === 0 && <div style={{ fontSize: 13, color: 'var(--t3)' }}>Add some stock items first (Inventory, Stock items).</div>}
      {starting && areasOn && (
        <NewCountPanel areas={areas} suppliers={suppliers} items={items.filter(i => !i.archivedAt)} holdings={holdings} venueTz={venueTz} busy={busy}
          loginName={loginName} onStart={startWithScope} onCancel={() => setStarting(false)} />
      )}
      {counts.length === 0 && items.length > 0 && <div style={{ fontSize: 13, color: 'var(--t3)' }}>No counts yet. Press “New count” to walk the shelves.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {counts.map(c => {
          const st = countStatusText(c.areas);
          return (
            <div key={c.id} onClick={() => openCount(c.id)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 10, padding: '12px 16px', cursor: 'pointer' }}>
              <div>
                <div style={{ fontSize: 14, color: 'var(--t1)' }}>{c.name}</div>
                <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>
                  {fmtVenueDateTime(c.createdAt, venueTz)}
                  {c.status !== 'APPROVED' && st.text && <span style={{ color: st.ready ? 'var(--grn, #16a34a)' : 'var(--t3)', fontWeight: st.ready ? 700 : 400 }}> · {st.text}</span>}
                  {c.startedByName && <span> · {c.startedByName}</span>}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: c.status === 'APPROVED' ? 'var(--grn)' : 'var(--t3)' }}>{c.status}</div>
                  {c.varianceValue != null && <div style={{ fontSize: 12, color: c.varianceValue < 0 ? 'var(--red)' : 'var(--t2)', marginTop: 2 }}>{signedMoney(c.varianceValue)}</div>}
                </div>
                {/* v5.5.823: an approved count has already adjusted stock and is the
                    evidence behind those movements, so only unapproved sheets can go. */}
                {c.status !== 'APPROVED' ? (
                  <button onClick={e => removeCount(e, c)} title="Delete this count"
                    style={{ width: 30, height: 30, flexShrink: 0, borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                      border: '1px solid var(--bdr)', background: 'var(--bg1)', color: 'var(--t3)', fontSize: 14 }}>×</button>
                ) : (
                  <span title="Approved counts have already adjusted your stock and cannot be deleted"
                    style={{ width: 30, textAlign: 'center', color: 'var(--t4)', fontSize: 12 }}>🔒</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The New count flow: type, scope, name, Start. */
function NewCountPanel({ areas, suppliers, items, holdings, venueTz, busy, loginName, onStart, onCancel }) {
  const [type, setType] = useState('FULL');
  const [areaIds, setAreaIds] = useState([]);
  const [supplierId, setSupplierId] = useState('');
  const [itemIds, setItemIds] = useState([]);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [by, setBy] = useState(() => readName(loginName));
  const noAreas = areas.length === 0;
  const tracked = items.filter(i => i.isTracked !== false);
  const itemsInArea = (areaId) => tracked.filter(i => i.areaId === areaId || Math.abs(Number(holdings?.[i.id]?.[areaId] || 0)) > 1e-9).length;
  const itemsOfSupplier = (sid) => tracked.filter(i => (i.supplierProducts || []).some(sp => sp.supplierId === sid)).length;
  const supplierName = suppliers.find(s => s.id === supplierId)?.name || null;
  const autoName = countNameFor({ ts: new Date(), tz: venueTz, type, areaNames: areaIds.map(id => areas.find(a => a.id === id)?.name).filter(Boolean), supplierName });
  const shownName = nameTouched ? name : autoName;
  const canStart = !busy && (type === 'FULL' || (type === 'AREA' && areaIds.length > 0) || (type === 'SUPPLIER' && supplierId) || (type === 'SPOT' && itemIds.length > 0));
  const start = () => onStart({ type, areaIds, supplierId: supplierId || null, itemIds, name: shownName.trim() || autoName, startedByName: by.trim() || loginName || null });
  const cardStyle = (on, off) => ({ textAlign: 'left', padding: '10px 12px', borderRadius: 10, cursor: off ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: off ? 0.5 : 1,
    background: on ? 'var(--acc-d, rgba(249,115,22,0.10))' : 'var(--bg2)', border: '1.5px solid ' + (on ? 'var(--acc)' : 'var(--bdr)') });
  return (
    <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 10 }}>New count</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 14 }}>
        {COUNT_TYPES.map(t => {
          const off = t.id === 'AREA' && noAreas;
          return (
            <button key={t.id} onClick={() => !off && setType(t.id)} disabled={off} style={cardStyle(type === t.id, off)} title={off ? 'Set up stock areas first (Inventory, Stock areas)' : t.desc}>
              <div style={{ fontSize: 13, fontWeight: 700, color: type === t.id ? 'var(--acc)' : 'var(--t1)' }}>{t.label}</div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>{off ? 'Set up stock areas first' : t.desc}</div>
            </button>
          );
        })}
      </div>
      {type === 'AREA' && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>Which areas</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {areas.map(a => {
              const on = areaIds.includes(a.id);
              return (
                <label key={a.id} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 10px', borderRadius: 8, border: '1px solid ' + (on ? 'var(--acc)' : 'var(--bdr)'), background: on ? 'var(--acc-d, rgba(249,115,22,0.10))' : 'var(--bg2)', fontSize: 13, color: 'var(--t1)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={on} onChange={e => setAreaIds(ids => e.target.checked ? [...ids, a.id] : ids.filter(x => x !== a.id))} />
                  {a.name} <span style={{ fontSize: 11, color: 'var(--t3)' }}>({itemsInArea(a.id)})</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
      {type === 'SUPPLIER' && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>Which supplier</div>
          <select value={supplierId} onChange={e => setSupplierId(e.target.value)} style={{ ...fieldStyle, minWidth: 240 }}>
            <option value="">Pick a supplier</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name} ({itemsOfSupplier(s.id)} item{itemsOfSupplier(s.id) === 1 ? '' : 's'})</option>)}
          </select>
        </div>
      )}
      {type === 'SPOT' && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>Which items</div>
          <StockItemPicker items={tracked} areas={areas} suppliers={suppliers} selected={itemIds} onChange={setItemIds} height={280} />
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: 2, minWidth: 220 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>Name</div>
          <input value={shownName} onChange={e => { setName(e.target.value); setNameTouched(true); }} style={{ ...fieldStyle, width: '100%' }} />
        </div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>Started by</div>
          <input value={by} onChange={e => setBy(e.target.value)} placeholder="Your name" style={{ ...fieldStyle, width: '100%' }} />
        </div>
        <button onClick={onCancel} style={ghost}>Cancel</button>
        <button onClick={start} disabled={!canStart} style={{ padding: '9px 18px', borderRadius: 9, background: 'var(--acc)', color: '#fff', border: 0, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: canStart ? 1 : 0.6 }}>{busy ? 'Starting...' : 'Start'}</button>
      </div>
    </div>
  );
}
