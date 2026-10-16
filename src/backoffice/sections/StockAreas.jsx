/**
 * StockAreas (Inventory, Stock areas), 16 Oct 2026. Peter: "the storage locations need to be set
 * ahead of time, then on the products there should be a drop down."
 *
 * The venue's list of areas: add, rename inline, kind, Up and Down, archive (refused while the
 * area holds stock or items), the receiving tick (one area at most; deliveries land there), "Add
 * the usual six" when the venue has none, and Bulk assign (pick an area, tick items, Assign) in a
 * right hand panel. Needs the 16 Oct migration (supabase/migrations/20261016_OPS_stock_areas.sql);
 * before it runs the screen says so and does nothing else.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store';
import { getActiveLocationSync, getLocationId } from '../../lib/supabase';
import { money } from '../../lib/currency';
import { fetchInventoryItems, fetchSuppliers } from '../../lib/stock/data';
import { areasReady, fetchAreas, saveArea, archiveArea, setReceivingArea, reorderAreas, addUsualSix, fetchAreaHoldings, bulkAssignItemArea } from '../../lib/stock/areas';
import { AREA_KINDS, kindLabel, RECEIVING_HELP, archiveRefusal, bulkAssignText, areasBelowZero } from '../../lib/stock/areaRules';
import { lineValue } from '../../lib/stock/valuation';
import { reportSave } from '../../lib/saveHealth';
import StockItemPicker from '../../components/StockItemPicker';

const fieldStyle = { background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const btn = { padding: '8px 14px', borderRadius: 8, cursor: 'pointer', background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit' };
const accBtn = { ...btn, background: 'var(--acc)', color: '#fff', border: 0, fontWeight: 700 };
const small = { ...btn, padding: '4px 9px', fontSize: 11, color: 'var(--t3)' };
const card = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 16 };

export const NEEDS_UPDATE_TEXT = 'Stock areas need the 16 Oct database update. Ask ServOS to run it, then open this screen again.';

export default function StockAreas({ orgCtx = null }) {
  const showToast = useStore(s => s.showToast);
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [ready, setReady] = useState(null);
  const [areas, setAreas] = useState([]);
  const [items, setItems] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [holdings, setHoldings] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState('other');
  const [editing, setEditing] = useState(null);   // { id, name, kind }
  const [assignArea, setAssignArea] = useState('');
  const [picked, setPicked] = useState([]);
  const [moveHoldings, setMoveHoldings] = useState(true);
  const byName = orgCtx?.userName || null;

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    const ok = await areasReady(loc);
    if (loc && loc !== locId) setLocId(loc);
    setReady(ok);
    if (!ok) { setLoading(false); return; }
    const [{ data: as, error }, { data: its }, { data: sups }, { data: hold }] = await Promise.all([fetchAreas(loc), fetchInventoryItems(loc), fetchSuppliers(loc), fetchAreaHoldings(loc)]);
    if (error) showToast?.(`Could not read the areas: ${error.message || error}`, 'error');
    setAreas(as || []); setItems(its || []); setSuppliers(sups || []); setHoldings(hold || {});
    setLoading(false);
  }, [locId, showToast]);
  // the first load runs after this render settles (never a setState straight inside the effect)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(reload, 0); return () => clearTimeout(t); }, []);

  const liveItems = useMemo(() => items.filter(i => !i.archivedAt), [items]);
  const itemsById = useMemo(() => { const m = {}; items.forEach(i => { m[i.id] = i; }); return m; }, [items]);
  const usage = useMemo(() => {
    const u = {};
    areas.forEach(a => { u[a.id] = { items: 0, holdings: 0, value: 0, below: 0 }; });
    liveItems.forEach(i => { if (i.areaId && u[i.areaId]) u[i.areaId].items += 1; });
    for (const [itemId, per] of Object.entries(holdings)) {
      for (const [areaId, qty] of Object.entries(per)) {
        if (!u[areaId]) continue;
        if (qty !== 0) u[areaId].holdings += 1;
        if (qty < 0) u[areaId].below += 1;
        u[areaId].value += lineValue(qty, itemsById[itemId]?.currentCost);
      }
    }
    return u;
  }, [areas, liveItems, holdings, itemsById]);
  const below = useMemo(() => areasBelowZero(holdings).length, [holdings]);

  const run = async (label, fn, okText) => {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    reportSave(label, res?.error);
    if (res?.error) { showToast?.(res.error.message || `${label} failed`, 'error'); return false; }
    if (okText) showToast?.(okText, 'success');
    await reload();
    return true;
  };

  const add = async () => {
    const name = newName.trim();
    if (!name) { showToast?.('Give the area a name', 'error'); return; }
    const ok = await run('stock area', () => saveArea({ name, kind: newKind, sortOrder: (areas.length + 1) * 10 }, locId), `${name} added`);
    if (ok) { setNewName(''); setNewKind('other'); }
  };
  const saveEdit = async () => {
    if (!editing) return;
    const ok = await run('stock area', () => saveArea({ id: editing.id, name: editing.name, kind: editing.kind, sortOrder: areas.find(a => a.id === editing.id)?.sortOrder ?? 0 }, locId), 'Saved');
    if (ok) setEditing(null);
  };
  const move = async (idx, dir) => {
    const ids = areas.map(a => a.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    await run('stock area order', () => reorderAreas(ids, locId));
  };
  const archive = async (a) => {
    const u = usage[a.id] || { items: 0, holdings: 0 };
    const refusal = archiveRefusal(u.items, u.holdings);
    if (refusal) {
      showToast?.(`${a.name}: ${refusal}`, 'error');
      setAssignArea(''); setPicked(liveItems.filter(i => i.areaId === a.id).map(i => i.id));
      return;
    }
    if (!window.confirm(`Archive ${a.name}? It holds nothing and no item lives there, so nothing moves.`)) return;
    await run('stock area archive', () => archiveArea(a.id, locId), `${a.name} archived`);
  };
  const toggleReceiving = async (a) => {
    const next = a.isReceiving ? null : a.id;
    await run('receiving area', () => setReceivingArea(next, locId), next ? `Deliveries will land in ${a.name}` : 'No receiving area: deliveries land in each item\'s own area');
  };
  const usualSix = async () => {
    await run('stock areas', () => addUsualSix(locId), 'The usual six areas added. Tick the one deliveries land in when you are ready.');
  };
  const assign = async () => {
    if (!picked.length) { showToast?.('Tick the items to move first', 'error'); return; }
    const target = assignArea === 'none' ? null : assignArea;
    if (!assignArea) { showToast?.('Pick the area they move to', 'error'); return; }
    const areaName = target ? (areas.find(a => a.id === target)?.name || 'that area') : 'No area';
    setBusy(true);
    const { data, error } = await bulkAssignItemArea(picked, target, { moveHolding: moveHoldings, byName, itemsById }, locId);
    setBusy(false);
    reportSave('bulk assign areas', error || (data?.failed ? new Error(data.failures[0]?.message) : null));
    if (error) { showToast?.(error.message, 'error'); return; }
    showToast?.(bulkAssignText({ moved: data.moved, holdings: data.holdings, failed: data.failed, areaName }), data.failed ? 'error' : 'success');
    if (data.failed) console.warn('[stock areas] bulk assign failures', data.failures);
    setPicked([]);
    await reload();
  };

  if (loading) return <div style={{ padding: 26, color: 'var(--t3)' }}>Loading...</div>;
  if (ready === false) {
    return (
      <div style={{ padding: '22px 26px', background: 'var(--bg0)', height: '100%', overflowY: 'auto' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 8px', color: 'var(--t1)' }}>Stock areas</h1>
        <div style={{ fontSize: 13, color: 'var(--t3)' }}>{NEEDS_UPDATE_TEXT}</div>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--t1)' }}>Stock areas</h1>
      <div style={{ fontSize: 13, color: 'var(--t3)', margin: '4px 0 18px' }}>
        Where stock lives: cellar, fridges, freezer, dry store, bar. Set them up first, then give each item its area on Stock items. Each area holds its own quantity of every item, counts can be done area by area, and deliveries land in the receiving area.
        {below > 0 && <span style={{ color: 'var(--red, #ef4444)' }}> {below} holding{below === 1 ? ' is' : 's are'} below zero: a transfer or a count puts it right.</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(320px, 1fr)', gap: 18, alignItems: 'start' }}>
        {/* ── the list ── */}
        <div style={card}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 10 }}>Areas</div>
          {areas.length === 0 && (
            <div style={{ padding: '12px 0 16px', fontSize: 13, color: 'var(--t3)' }}>
              No areas yet. Start with the usual six and rename what does not fit.
              <div style={{ marginTop: 10 }}><button onClick={usualSix} disabled={busy} style={accBtn}>Add the usual six</button></div>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {areas.map((a, idx) => {
              const u = usage[a.id] || { items: 0, holdings: 0, value: 0, below: 0 };
              const isEditing = editing?.id === a.id;
              return (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: 'var(--bg2)', border: '1px solid ' + (a.isReceiving ? 'var(--acc)' : 'var(--bdr)'), flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <button onClick={() => move(idx, -1)} disabled={busy || idx === 0} title="Move up" style={{ ...small, padding: '1px 6px', opacity: idx === 0 ? 0.4 : 1 }}>▲</button>
                    <button onClick={() => move(idx, 1)} disabled={busy || idx === areas.length - 1} title="Move down" style={{ ...small, padding: '1px 6px', opacity: idx === areas.length - 1 ? 0.4 : 1 }}>▼</button>
                  </div>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    {isEditing ? (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <input value={editing.name} onChange={e => setEditing(x => ({ ...x, name: e.target.value }))} style={{ ...fieldStyle, width: 180 }} autoFocus />
                        <select value={editing.kind} onChange={e => setEditing(x => ({ ...x, kind: e.target.value }))} style={fieldStyle}>
                          {AREA_KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
                        </select>
                        <button onClick={saveEdit} disabled={busy} style={accBtn}>Save</button>
                        <button onClick={() => setEditing(null)} style={btn}>Cancel</button>
                      </div>
                    ) : (
                      <>
                        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)' }}>
                          {a.name} {a.isReceiving && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--acc)', padding: '2px 7px', borderRadius: 20, background: 'var(--acc-d, rgba(249,115,22,0.12))', marginLeft: 6 }}>Receiving</span>}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>
                          {kindLabel(a.kind)} · {u.items} item{u.items === 1 ? '' : 's'} · {u.holdings} holding{u.holdings === 1 ? '' : 's'} · {money(u.value)}
                          {u.below > 0 && <span style={{ color: 'var(--red, #ef4444)' }}> · {u.below} below zero</span>}
                        </div>
                      </>
                    )}
                  </div>
                  {!isEditing && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 11, color: 'var(--t2)', cursor: 'pointer' }} title={RECEIVING_HELP}>
                        <input type="checkbox" checked={a.isReceiving} disabled={busy} onChange={() => toggleReceiving(a)} /> Deliveries land here
                      </label>
                      <button onClick={() => setEditing({ id: a.id, name: a.name, kind: a.kind })} style={small}>Rename</button>
                      <button onClick={() => archive(a)} disabled={busy} style={small} title={archiveRefusal(u.items, u.holdings) || 'Archive this area'}>Archive</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {areas.some(a => a.isReceiving) ? (
            <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 10 }}>{RECEIVING_HELP}</div>
          ) : areas.length > 0 && (
            <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 10 }}>No receiving area: a delivery lands in each item's own area, which suits a venue with one store room. Tick an area to have every delivery land there instead. {RECEIVING_HELP}</div>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 160 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 }}>Add an area</div>
              <input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add(); }} placeholder="e.g. Back bar" style={{ ...fieldStyle, width: '100%' }} />
            </div>
            <select value={newKind} onChange={e => setNewKind(e.target.value)} style={fieldStyle}>
              {AREA_KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
            <button onClick={add} disabled={busy} style={accBtn}>Add</button>
            {areas.length > 0 && areas.length < 6 && <button onClick={usualSix} disabled={busy} style={btn} title="Adds any of Cellar, Walk in fridge, Freezer, Dry store, Bar, Kitchen that are missing">Add the usual six</button>}
          </div>
        </div>

        {/* ── bulk assign ── */}
        <div style={card}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 4 }}>Bulk assign</div>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 10 }}>Tick items, pick the area they live in, Assign. An item's holding in its old area moves with it unless you untick that below.</div>
          {areas.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>Add areas first.</div>
          ) : (
            <>
              <StockItemPicker items={liveItems} areas={areas} suppliers={suppliers} selected={picked} onChange={setPicked} height={320} />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                <select value={assignArea} onChange={e => setAssignArea(e.target.value)} style={{ ...fieldStyle, flex: 1, minWidth: 160 }}>
                  <option value="">Move to...</option>
                  {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  <option value="none">No area</option>
                </select>
                <button onClick={assign} disabled={busy || !picked.length || !assignArea} style={{ ...accBtn, opacity: (busy || !picked.length || !assignArea) ? 0.6 : 1 }}>{busy ? 'Assigning...' : `Assign ${picked.length || ''}`}</button>
              </div>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--t2)', marginTop: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={moveHoldings} onChange={e => setMoveHoldings(e.target.checked)} /> Also move each item's stock from its old area (a transfer is recorded)
              </label>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
