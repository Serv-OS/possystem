/**
 * StockTransfers (Inventory, Transfers), 16 Oct 2026. Peter: "transfers between locations and
 * stock areas, so then each stock area should have its own holding of said item."
 *
 * Three views on one route:
 *   The list      every transfer either end of this venue (within the venue, sent, incoming),
 *                 status, lines, value, who and when. Filter by status. Open any.
 *   New transfer  Within this venue: from area, to area, items (the shared picker: search and
 *                 filters at 1,000 items), a quantity per line in the item's count unit, Move
 *                 stock. To another venue: pick the venue, from area here, Send.
 *   One transfer  the head and its lines. An incoming transfer that is SENT shows the receive
 *                 view: each line matched to one of this venue's items by SKU then name (green),
 *                 unmatched lines in amber with a search to match by hand or Drop line, quantity
 *                 received (defaults to sent), the area it lands in (defaults to receiving),
 *                 Receive. The sender of a SENT transfer can cancel it (stock goes back).
 *
 * Every move is posted by post_stock_transfer_leg in ONE transaction (both legs within a venue;
 * out at send, in at receive, back at cancel), so no line is ever stock that exists nowhere.
 * Data: src/lib/stock/transfers.js and areas.js. Rules: transferRules.js and areaRules.js.
 * Needs the 16 Oct migration; before it runs the screen says so and does nothing else.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store';
import { getActiveLocationSync, getLocationId } from '../../lib/supabase';
import { getLocationConfig } from '../../lib/locationTime';
import { fmtVenueDateTime } from '../../lib/venueDate';
import { money } from '../../lib/currency';
import { fetchInventoryItems, fetchSuppliers } from '../../lib/stock/data';
import { areasReady, fetchAreas, fetchAreaHoldings, fetchTransfers, fetchTransfer } from '../../lib/stock/areas';
import { fetchVenueChoices, fetchTransferLineSummary, moveStock, sendTransfer, retryTransfer, saveReceiveMatches, receiveTransfer, cancelTransfer } from '../../lib/stock/transfers';
import {
  TRANSFER_STATUS_WORDS, TRANSFER_FILTERS, uomCtxOf, transferUnitsFor, defaultTokenOf, fmtQtyOf,
  transferDirection, transferHeadline, transferMatchesFilter, validateTransferDraft, buildTransferLines,
  lineWarnings, transferValue, receivePlan, matchCandidates, receiveLineUpdates, linesText, cancelText, movedText,
} from '../../lib/stock/transferRules';
import { fromBase, toBase } from '../../lib/stock/uom';
import { reportSave } from '../../lib/saveHealth';
import { NEEDS_UPDATE_TEXT } from './StockAreas';
import StockItemPicker from '../../components/StockItemPicker';
import NumberField from '../../components/NumberField';

const fieldStyle = { background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' };
const btn = { padding: '8px 14px', borderRadius: 8, cursor: 'pointer', background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit' };
const accBtn = { ...btn, background: 'var(--acc)', color: '#fff', border: 0, fontWeight: 700 };
const quiet = { ...btn, background: 'transparent', color: 'var(--t3)' };
const small = { ...btn, padding: '4px 9px', fontSize: 11, color: 'var(--t3)' };
const card = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 16 };
const lbl = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 };
const chip = (on) => ({ fontSize: 11, padding: '4px 9px', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit', background: on ? 'var(--bg3)' : 'transparent', color: on ? 'var(--t1)' : 'var(--t3)', border: '1px solid ' + (on ? 'var(--bg3)' : 'var(--bdr)') });
const statusColor = (s) => (s === 'DONE' || s === 'RECEIVED' ? 'var(--grn, #16a34a)' : s === 'CANCELLED' ? 'var(--t4)' : s === 'SENT' ? 'var(--amber, #F5A623)' : 'var(--t3)');
const r3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;

export default function StockTransfers({ orgCtx = null }) {
  const showToast = useStore(s => s.showToast);
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [ready, setReady] = useState(null);
  const [loading, setLoading] = useState(true);
  const [areas, setAreas] = useState([]);
  const [items, setItems] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [holdings, setHoldings] = useState({});
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({});
  const [venues, setVenues] = useState({ venues: [], namesById: {} });
  const [venueTz, setVenueTz] = useState(null);
  const [view, setView] = useState({ kind: 'list' });
  const [filter, setFilter] = useState('all');
  const byName = orgCtx?.userName || null;

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    const ok = await areasReady(loc);
    if (loc && loc !== locId) setLocId(loc);
    getLocationConfig(loc).then(c => setVenueTz(c?.timezone || null)).catch(() => {});
    setReady(ok);
    if (ok) {
      const [ts, as, its, sups, hold, sum, ven] = await Promise.all([
        fetchTransfers(loc), fetchAreas(loc, { includeArchived: true }), fetchInventoryItems(loc), fetchSuppliers(loc),
        fetchAreaHoldings(loc), fetchTransferLineSummary(loc), fetchVenueChoices(loc),
      ]);
      const err = ts.error || as.error || its.error || hold.error || sum.error;
      if (err) showToast?.(`Could not read the transfers: ${err.message || err}`, 'error');
      setRows(ts.data || []); setAreas(as.data || []); setItems(its.data || []); setSuppliers(sups.data || []);
      setHoldings(hold.data || {}); setSummary(sum.data || {}); setVenues(ven.data || { venues: [], namesById: {} });
    }
    setLoading(false);
  }, [locId, showToast]);
  // the first load runs after this render settles (never a setState straight inside the effect)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(reload, 0); return () => clearTimeout(t); }, []);

  const liveAreas = useMemo(() => areas.filter(a => !a.archivedAt), [areas]);
  const itemsById = useMemo(() => { const m = {}; items.forEach(i => { m[i.id] = i; }); return m; }, [items]);
  const areaName = useCallback((id) => areas.find(a => a.id === id)?.name || '', [areas]);
  const venueName = useCallback((id) => venues.namesById[String(id)] || '', [venues]);
  const shown = useMemo(() => rows.filter(t => transferMatchesFilter(t, filter)), [rows, filter]);
  const incomingOpen = rows.filter(t => transferDirection(t, locId) === 'incoming' && t.status === 'SENT').length;

  if (loading) return <div style={{ padding: 26, color: 'var(--t3)' }}>Loading...</div>;
  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px', maxWidth: 1040 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--t1)' }}>Transfers</h1>
          <div style={{ fontSize: 13, color: 'var(--t3)', margin: '4px 0 18px' }}>
            Stock moved between areas (cellar to fridge) or to another venue. Every move is two ledger rows, out of one place and into the other, so each area's holding stays right.
          </div>
        </div>
        {ready && view.kind === 'list' && <button style={accBtn} onClick={() => setView({ kind: 'new' })}>+ New transfer</button>}
        {ready && view.kind !== 'list' && <button style={quiet} onClick={() => setView({ kind: 'list' })}>Back to the list</button>}
      </div>
      {ready === false && <div style={{ fontSize: 13, color: 'var(--t3)' }}>{NEEDS_UPDATE_TEXT}</div>}
      {ready && view.kind === 'new' && (
        <NewTransfer locId={locId} areas={liveAreas} items={items} itemsById={itemsById} suppliers={suppliers} holdings={holdings} venues={venues.venues} byName={byName}
          onDone={async (text) => { showToast?.(text, 'success'); setView({ kind: 'list' }); await reload(); }}
          onError={(text) => showToast?.(text, 'error')} />
      )}
      {ready && view.kind === 'open' && (
        <TransferDetail id={view.id} locId={locId} areas={liveAreas} areaName={areaName} venueName={venueName} items={items} itemsById={itemsById} byName={byName} venueTz={venueTz}
          onChanged={async (text, tone = 'success') => { if (text) showToast?.(text, tone); await reload(); }} />
      )}
      {ready && view.kind === 'list' && (
        <>
          {incomingOpen > 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--t1)', marginBottom: 12, padding: '10px 12px', borderRadius: 10, background: 'var(--bg1)', border: '1px solid var(--amber, #F5A623)' }}>
              {incomingOpen} incoming transfer{incomingOpen === 1 ? '' : 's'} waiting to be received. Open {incomingOpen === 1 ? 'it' : 'one'} below to match the lines and receive.
            </div>
          )}
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 12 }}>
            {TRANSFER_FILTERS.map(f => <button key={f.id} style={chip(filter === f.id)} onClick={() => setFilter(f.id)}>{f.label}</button>)}
            <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t3)', alignSelf: 'center' }}>{shown.length} of {rows.length}</span>
          </div>
          {shown.length === 0 && <div style={{ fontSize: 13, color: 'var(--t3)' }}>{rows.length ? 'No transfers match this filter.' : 'No transfers yet. New transfer moves stock from one area to another, or sends it to another venue.'}</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {shown.map(t => {
              const dir = transferDirection(t, locId);
              const s = summary[t.id] || { lines: 0, dropped: 0, value: 0 };
              const who = t.status === 'RECEIVED' ? t.receivedByName : t.status === 'CANCELLED' ? t.cancelledByName : (t.sentByName || t.createdByName);
              const when = t.status === 'RECEIVED' ? t.receivedAt : t.status === 'CANCELLED' ? t.cancelledAt : (t.sentAt || t.createdAt);
              const attention = dir === 'incoming' && t.status === 'SENT';
              return (
                <button key={t.id} onClick={() => setView({ kind: 'open', id: t.id })}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', background: 'var(--bg1)', border: `1px solid ${attention ? 'var(--amber, #F5A623)' : 'var(--bdr)'}`, borderRadius: 10, padding: '12px 16px' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, color: 'var(--t1)' }}>
                      {t.reference || 'Transfer'} · {transferHeadline(t, { homeId: locId, areaName, venueName })}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>
                      {s.lines} line{s.lines === 1 ? '' : 's'}{s.dropped ? `, ${s.dropped} dropped` : ''} · {money(s.value)} · {fmtVenueDateTime(when, venueTz)}{who ? ` · ${who}` : ''}{t.note ? ` · ${t.note}` : ''}
                    </div>
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, color: statusColor(t.status), whiteSpace: 'nowrap' }}>{attention ? 'Receive' : (TRANSFER_STATUS_WORDS[t.status] || t.status)}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ── New transfer ──────────────────────────────────────────────────────────────
function NewTransfer({ locId, areas, items, itemsById, suppliers, holdings, venues, byName, onDone, onError }) {
  const receiving = areas.find(a => a.isReceiving)?.id || '';
  const [mode, setMode] = useState('within');
  const [fromAreaId, setFromAreaId] = useState(receiving || areas[0]?.id || '');
  const [toAreaId, setToAreaId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [note, setNote] = useState('');
  const [picks, setPicks] = useState({});   // itemId -> { qty, token }
  const [busy, setBusy] = useState(false);
  const liveItems = useMemo(() => items.filter(i => !i.archivedAt && i.isTracked !== false), [items]);
  const selected = useMemo(() => Object.keys(picks), [picks]);
  const built = useMemo(() => buildTransferLines(picks, itemsById), [picks, itemsById]);
  const fromName = areas.find(a => a.id === fromAreaId)?.name || '';
  const toName = areas.find(a => a.id === toAreaId)?.name || '';
  const warnings = useMemo(() => lineWarnings(built.lines, fromAreaId, { holdings, itemsById, areaName: fromName || 'This area', fmt: (q, it) => (it ? fmtQtyOf(q, it) : String(r3(q))) }), [built.lines, fromAreaId, holdings, itemsById, fromName]);
  const warnById = useMemo(() => { const m = {}; warnings.forEach(w => { m[w.itemId] = w.text; }); return m; }, [warnings]);
  const costById = useMemo(() => { const m = {}; items.forEach(i => { m[i.id] = i.currentCost || 0; }); return m; }, [items]);
  const value = transferValue(built.lines, costById);
  const holdingIn = (item, areaId) => fmtQtyOf(holdings?.[item.id]?.[areaId] || 0, item);

  const onPick = (ids) => {
    setPicks(prev => {
      const next = {};
      ids.forEach(id => { next[id] = prev[id] || { qty: '', token: defaultTokenOf(itemsById[id]) }; });
      return next;
    });
  };
  const setQty = (id, qty) => setPicks(p => ({ ...p, [id]: { ...p[id], qty } }));
  const setToken = (id, token) => setPicks(p => ({ ...p, [id]: { ...p[id], token } }));
  const drop = (id) => setPicks(p => { const n = { ...p }; delete n[id]; return n; });

  const submit = async () => {
    if (built.errors.length) { onError(built.errors[0].message); return; }
    const draft = { mode, fromAreaId: fromAreaId || null, toAreaId: mode === 'within' ? (toAreaId || null) : null, toLocationId: mode === 'venue' ? toLocationId : null, note, byName, lines: built.lines };
    const refusal = validateTransferDraft(draft, { homeId: locId, hasAreas: areas.length > 0 });
    if (refusal) { onError(refusal); return; }
    setBusy(true);
    const res = mode === 'within' ? await moveStock(draft, locId) : await sendTransfer(draft, locId);
    setBusy(false);
    reportSave('stock transfer', res.error);
    if (res.error) { onError(res.error.message || 'The transfer failed'); return; }
    const venue = venues.find(v => v.id === toLocationId)?.name || 'the other venue';
    onDone(mode === 'within' ? movedText(built.lines, fromName, toName, itemsById) : `${res.data.reference} sent to ${venue}: ${built.lines.length} line${built.lines.length === 1 ? '' : 's'} left ${fromName || 'this venue'}. They receive it on their Transfers screen.`);
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) minmax(360px, 1fr)', gap: 16, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={card}>
          <div style={{ display: 'flex', gap: 5, marginBottom: 12 }}>
            <button style={chip(mode === 'within')} onClick={() => setMode('within')}>Within this venue</button>
            <button style={chip(mode === 'venue')} onClick={() => setMode('venue')} disabled={!venues.length} title={venues.length ? '' : 'No other venue of your company is open to this login'}>To another venue</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <span style={lbl}>From area</span>
              <select value={fromAreaId} onChange={e => setFromAreaId(e.target.value)} style={{ ...fieldStyle, width: '100%' }}>
                {areas.length === 0 && <option value="">No areas yet</option>}
                {areas.map(a => <option key={a.id} value={a.id}>{a.name}{a.isReceiving ? ' (receiving)' : ''}</option>)}
              </select>
            </div>
            {mode === 'within' ? (
              <div>
                <span style={lbl}>To area</span>
                <select value={toAreaId} onChange={e => setToAreaId(e.target.value)} style={{ ...fieldStyle, width: '100%' }}>
                  <option value="">Pick an area</option>
                  {areas.filter(a => a.id !== fromAreaId).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
            ) : (
              <div>
                <span style={lbl}>To venue</span>
                <select value={toLocationId} onChange={e => setToLocationId(e.target.value)} style={{ ...fieldStyle, width: '100%' }}>
                  <option value="">Pick a venue</option>
                  {venues.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </div>
            )}
          </div>
          {mode === 'venue' && <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 8 }}>The stock leaves {fromName || 'this venue'} when you send. The other venue matches the lines to its own items (by SKU, then name) and picks the area it lands in when it receives.</div>}
          <div style={{ marginTop: 10 }}>
            <span style={lbl}>Note (optional)</span>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="Why, or what to look out for" style={{ ...fieldStyle, width: '100%' }} />
          </div>
        </div>
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', marginBottom: 8 }}>Items</div>
          <StockItemPicker items={liveItems} areas={areas} suppliers={suppliers} selected={selected} onChange={onPick} height={380}
            rowRight={(it) => fromAreaId ? <span style={{ fontSize: 11, color: (holdings?.[it.id]?.[fromAreaId] || 0) < 0 ? 'var(--red, #ef4444)' : 'var(--t3)', whiteSpace: 'nowrap' }}>{holdingIn(it, fromAreaId)} in {fromName}</span> : null} />
        </div>
      </div>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{selected.length ? `${selected.length} line${selected.length === 1 ? '' : 's'}` : 'Lines'}</div>
          <div style={{ fontSize: 12, color: 'var(--t3)' }}>Value at cost: {money(value)}</div>
        </div>
        {selected.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>Tick items on the left, then type how much moves.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {selected.map(id => {
            const it = itemsById[id];
            if (!it) return null;
            const p = picks[id];
            const units = transferUnitsFor(it);
            const warn = warnById[id];
            const have = holdings?.[id]?.[fromAreaId] || 0;
            return (
              <div key={id} style={{ border: `1px solid ${warn ? 'var(--amber, #F5A623)' : 'var(--bdr)'}`, borderRadius: 10, padding: '10px 12px', background: 'var(--bg2)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <div style={{ fontSize: 13.5, color: 'var(--t1)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</div>
                  <button onClick={() => drop(id)} style={small} title="Take this line off">×</button>
                </div>
                <div style={{ fontSize: 11, color: have < 0 ? 'var(--red, #ef4444)' : 'var(--t3)', marginTop: 2 }}>{fromAreaId ? `${fmtQtyOf(have, it)} in ${fromName}` : `${fmtQtyOf(it.onHand, it)} at the venue`}{it.sku ? ` · ${it.sku}` : ''}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                  <NumberField width={120} unit={units.find(u => u.token === p.token)?.label || ''} value={p.qty} onChange={v => setQty(id, v)} tone={warn ? 'warn' : undefined} inputStyle={{ fontSize: 16 }} />
                  {units.length > 1 && (
                    <select value={p.token} onChange={e => setToken(id, e.target.value)} style={{ ...fieldStyle, padding: '6px 8px', fontSize: 12 }}>
                      {units.map(u => <option key={u.token} value={u.token}>{u.label}</option>)}
                    </select>
                  )}
                </div>
                {warn && <div style={{ fontSize: 11, color: 'var(--amber, #F5A623)', marginTop: 6 }}>{warn}. Allowed: the area will show below zero until a count or another transfer puts it right.</div>}
              </div>
            );
          })}
        </div>
        {built.errors.length > 0 && <div style={{ fontSize: 12, color: 'var(--red, #ef4444)', marginTop: 10 }}>{built.errors[0].message}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button style={{ ...accBtn, opacity: busy || !built.lines.length ? 0.6 : 1 }} disabled={busy || !built.lines.length} onClick={submit}>
            {busy ? 'Posting...' : mode === 'within' ? `Move stock${toName ? ` to ${toName}` : ''}` : `Send${toLocationId ? ` to ${venues.find(v => v.id === toLocationId)?.name || 'venue'}` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── One transfer (and the receive view) ───────────────────────────────────────
function TransferDetail({ id, locId, areas, areaName, venueName, items, itemsById, byName, venueTz, onChanged }) {
  const [t, setT] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState(null);       // receive view: { lines, unmatched, canReceive }
  const [landArea, setLandArea] = useState('');
  const [search, setSearch] = useState({});     // lineId -> text

  const load = useCallback(async () => {
    const { data, error } = await fetchTransfer(id, locId);
    if (error) onChanged(`Could not read the transfer: ${error.message || error}`, 'error');
    setT(data || null);
    setLoading(false);
  }, [id, locId, onChanged]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { const h = setTimeout(load, 0); return () => clearTimeout(h); }, [id]);

  const dir = t ? transferDirection(t, locId) : 'within';
  const receiving = dir === 'incoming' && t?.status === 'SENT';
  useEffect(() => {
    if (!t || !receiving) { setPlan(null); return; }
    setPlan(receivePlan(t.lines, items));
    setLandArea(t.toAreaId || areas.find(a => a.isReceiving)?.id || '');
  }, [t, receiving, items, areas]);

  if (loading) return <div style={{ padding: 20, color: 'var(--t3)' }}>Loading...</div>;
  if (!t) return <div style={{ padding: 20, color: 'var(--t3)' }}>This transfer could not be found, or this login cannot open its venue.</div>;

  const lines = plan ? plan.lines : t.lines;
  const mine = dir !== 'incoming';
  const costById = {}; items.forEach(i => { costById[i.id] = i.currentCost || 0; });
  const value = transferValue(lines, costById);
  const sentQty = (l) => {
    const it = itemsById[l.inventoryItemId];
    return it ? fmtQtyOf(l.qtyBase, it) : `${r3(l.qtyBase)} ${l.baseUnit || ''}`.trim();
  };
  const recvItem = (l) => (l.toInventoryItemId ? itemsById[l.toInventoryItemId] : null);
  const setLine = (lineId, patch) => setPlan(p => {
    const next = p.lines.map(l => (l.id === lineId ? { ...l, ...patch } : l));
    return { ...p, lines: next, unmatched: next.filter(l => !l.dropped && !l.toInventoryItemId).map(l => l.id), canReceive: next.length > 0 && next.every(l => l.dropped || l.toInventoryItemId) };
  });

  const doReceive = async () => {
    if (!plan?.canReceive) { onChanged('Match every line to one of your items, or drop it, before you receive', 'error'); return; }
    setBusy(true);
    const saved = await saveReceiveMatches(t.id, receiveLineUpdates(plan.lines), landArea || null);
    reportSave('stock transfer receive', saved.error);
    if (saved.error) { setBusy(false); onChanged(`The matches were not saved: ${saved.error.message || saved.error}`, 'error'); return; }
    const res = await receiveTransfer(t.id, byName);
    setBusy(false);
    reportSave('stock transfer receive', res.error);
    if (res.error) { onChanged(res.error.message || 'Receive failed', 'error'); return; }
    const kept = plan.lines.filter(l => !l.dropped).length;
    await onChanged(`${t.reference || 'Transfer'} received: ${kept} line${kept === 1 ? '' : 's'} into ${areaName(landArea) || 'each item\'s own area'}`);
    await load();
  };
  const doCancel = async () => {
    if (!window.confirm(cancelText(t, t.lines.filter(l => !l.dropped).length, areaName(t.fromAreaId)))) return;
    setBusy(true);
    const res = await cancelTransfer(t.id, byName);
    setBusy(false);
    reportSave('stock transfer cancel', res.error);
    if (res.error) { onChanged(res.error.message || 'Cancel failed', 'error'); return; }
    await onChanged(`${t.reference || 'Transfer'} cancelled${t.status === 'SENT' ? `: the stock is back in ${areaName(t.fromAreaId) || 'its area'}` : ''}`);
    await load();
  };
  const doRetry = async () => {
    setBusy(true);
    const res = await retryTransfer(t.id, byName, locId);
    setBusy(false);
    reportSave('stock transfer', res.error);
    if (res.error) { onChanged(res.error.message || 'The transfer failed', 'error'); return; }
    await onChanged(`${t.reference || 'Transfer'} ${res.data?.status === 'DONE' ? 'moved' : 'sent'}`);
    await load();
  };

  const when = (ts) => (ts ? fmtVenueDateTime(ts, venueTz) : '');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--t1)' }}>{t.reference || 'Transfer'} · {transferHeadline(t, { homeId: locId, areaName, venueName })}</div>
          <span style={{ fontSize: 12, fontWeight: 700, color: statusColor(t.status) }}>{TRANSFER_STATUS_WORDS[t.status] || t.status}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 6, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <span>Made {when(t.createdAt)}{t.createdByName ? ` by ${t.createdByName}` : ''}</span>
          {t.sentAt && <span>{dir === 'within' ? 'Moved' : 'Sent'} {when(t.sentAt)}{t.sentByName ? ` by ${t.sentByName}` : ''}</span>}
          {t.receivedAt && dir !== 'within' && <span>Received {when(t.receivedAt)}{t.receivedByName ? ` by ${t.receivedByName}` : ''}</span>}
          {t.cancelledAt && <span>Cancelled {when(t.cancelledAt)}{t.cancelledByName ? ` by ${t.cancelledByName}` : ''}</span>}
          <span>{linesText(lines)} · {money(value)}</span>
        </div>
        {t.note && <div style={{ fontSize: 12.5, color: 'var(--t2)', marginTop: 6 }}>{t.note}</div>}
        {t.status === 'DRAFT' && mine && (
          <div style={{ fontSize: 12.5, color: 'var(--amber, #F5A623)', marginTop: 8 }}>Saved but not posted: nothing has moved yet. {dir === 'within' ? 'Move' : 'Send'} it now, or cancel it.</div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {t.status === 'DRAFT' && mine && <button style={accBtn} disabled={busy} onClick={doRetry}>{dir === 'within' ? 'Move stock now' : 'Send now'}</button>}
          {(t.status === 'DRAFT' || t.status === 'SENT') && mine && <button style={quiet} disabled={busy} onClick={doCancel}>{t.status === 'SENT' ? 'Cancel and take the stock back' : 'Cancel'}</button>}
        </div>
      </div>

      {receiving && plan && (
        <div style={{ ...card, border: '1px solid var(--amber, #F5A623)' }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--t1)' }}>Receive into {venueName(locId) || 'this venue'}</div>
          <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 4 }}>
            Each line is matched to one of your items by SKU, then by name. Amber lines need a match by hand, or Drop line (recorded, no stock). Correct any quantity that differs from what arrived. The cost comes with the stock.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t3)' }}>Lands in</span>
            <select value={landArea} onChange={e => setLandArea(e.target.value)} style={{ ...fieldStyle, minWidth: 180 }}>
              <option value="">Each item's own area</option>
              {areas.map(a => <option key={a.id} value={a.id}>{a.name}{a.isReceiving ? ' (receiving)' : ''}</option>)}
            </select>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: plan.canReceive ? 'var(--grn, #16a34a)' : 'var(--amber, #F5A623)' }}>
              {plan.canReceive ? 'Every line matched or dropped' : `${plan.unmatched.length} line${plan.unmatched.length === 1 ? '' : 's'} still to match`}
            </span>
            <button style={{ ...accBtn, opacity: busy || !plan.canReceive ? 0.6 : 1 }} disabled={busy || !plan.canReceive} onClick={doReceive}>{busy ? 'Receiving...' : 'Receive'}</button>
          </div>
        </div>
      )}

      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--bg2)', color: 'var(--t3)', fontSize: 11.5 }}>
              <th style={{ textAlign: 'left', padding: '10px 14px' }}>Line</th>
              <th style={{ textAlign: 'right', padding: '10px 14px' }}>Sent</th>
              {receiving && <th style={{ textAlign: 'left', padding: '10px 14px' }}>Your item</th>}
              {(receiving || t.status === 'RECEIVED') && <th style={{ textAlign: 'right', padding: '10px 14px' }}>Received</th>}
              <th style={{ textAlign: 'right', padding: '10px 14px' }}>Cost</th>
              <th style={{ textAlign: 'right', padding: '10px 14px' }}>Value</th>
            </tr>
          </thead>
          <tbody>
            {lines.map(l => {
              const ri = recvItem(l);
              const cost = l.unitCost != null ? l.unitCost : (costById[l.inventoryItemId] || 0);
              const tone = l.dropped ? 'var(--t4)' : receiving ? (l.toInventoryItemId ? 'var(--grn, #16a34a)' : 'var(--amber, #F5A623)') : 'var(--t1)';
              const recvTok = ri ? defaultTokenOf(ri) : null;
              const recvShown = ri && recvTok ? fromBase(l.qtyReceivedBase ?? l.qtyBase, recvTok, uomCtxOf(ri)) : null;
              return (
                <tr key={l.id} style={{ borderTop: '1px solid var(--bdr)', opacity: l.dropped ? 0.55 : 1 }}>
                  <td style={{ padding: '10px 14px', color: tone }}>
                    <div>{l.nameSnapshot || itemsById[l.inventoryItemId]?.name || 'Item'}</div>
                    <div style={{ fontSize: 11, color: 'var(--t3)' }}>{[l.skuSnapshot, l.dropped ? 'dropped' : receiving ? (l.matchedBy === 'sku' ? 'matched by SKU' : l.matchedBy === 'name' ? 'matched by name' : l.matchedBy === 'kept' ? 'matched' : l.toInventoryItemId ? 'matched by hand' : 'no match yet') : null].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td style={{ padding: '10px 14px', textAlign: 'right', color: 'var(--t2)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{sentQty(l)}</td>
                  {receiving && (
                    <td style={{ padding: '10px 14px', minWidth: 220 }}>
                      {l.dropped ? (
                        <button style={small} onClick={() => setLine(l.id, { dropped: false })}>Undo drop</button>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {ri ? (
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                              <span style={{ color: 'var(--t1)' }}>{ri.name}</span>
                              <button style={small} onClick={() => setLine(l.id, { toInventoryItemId: null, matchedBy: null })}>Change</button>
                              <button style={small} onClick={() => setLine(l.id, { dropped: true })}>Drop line</button>
                            </div>
                          ) : (
                            <>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <input value={search[l.id] ?? (l.nameSnapshot || '')} onChange={e => setSearch(s => ({ ...s, [l.id]: e.target.value }))} placeholder="Search your items" style={{ ...fieldStyle, padding: '5px 8px', fontSize: 12, flex: 1 }} />
                                <button style={small} onClick={() => setLine(l.id, { dropped: true })}>Drop line</button>
                              </div>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                {matchCandidates(search[l.id] ?? (l.nameSnapshot || ''), items, 6).map(c => (
                                  <button key={c.id} style={chip(false)} onClick={() => { setLine(l.id, { toInventoryItemId: c.id, matchedBy: 'hand' }); }}>{c.name}{c.sku ? ` · ${c.sku}` : ''}</button>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </td>
                  )}
                  {receiving && (
                    <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                      {ri && !l.dropped ? (
                        <NumberField width={120} unit={transferUnitsFor(ri).find(u => u.token === recvTok)?.label || ri.baseUnit}
                          value={l.recvText ?? (recvShown == null ? '' : String(Math.round(recvShown * 1e6) / 1e6))}
                          onChange={v => { const n = Number(v); if (v === '' || !Number.isFinite(n)) { setLine(l.id, { qtyReceivedBase: 0, recvText: v }); return; } try { setLine(l.id, { qtyReceivedBase: toBase(n, recvTok, uomCtxOf(ri)), recvText: v }); } catch { setLine(l.id, { recvText: v }); } }} />
                      ) : <span style={{ color: 'var(--t4)' }}>{l.dropped ? 'none' : ''}</span>}
                    </td>
                  )}
                  {!receiving && t.status === 'RECEIVED' && (
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: 'var(--t2)', whiteSpace: 'nowrap' }}>{l.dropped ? 'dropped' : (ri ? fmtQtyOf(l.qtyReceivedBase ?? l.qtyBase, ri) : `${r3(l.qtyReceivedBase ?? l.qtyBase)} ${l.baseUnit || ''}`)}</td>
                  )}
                  <td style={{ padding: '10px 14px', textAlign: 'right', color: 'var(--t3)', whiteSpace: 'nowrap' }}>{money(cost)} a {l.baseUnit || 'unit'}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right', color: 'var(--t2)', whiteSpace: 'nowrap' }}>{l.dropped ? '' : money(Math.max(0, Number(l.qtyReceivedBase ?? l.qtyBase)) * cost)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--t4)' }}>Both legs show on Stock reports, Movements as Transfer out and Transfer in with the reference {t.reference || ''} in the note.</div>
    </div>
  );
}
