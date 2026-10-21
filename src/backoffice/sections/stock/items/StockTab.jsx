// src/backoffice/sections/stock/items/StockTab.jsx
//
// MULTI SITE STOCK Drop 1: today's Stock tab (src/backoffice/sections/StockItems.jsx StockTab on
// main, now in stock/items/StockItemsSplit.jsx) copied for the company item page, where it opens in
// a side panel from the Sites tab's On hand cell for ONE site. Nothing today's Stock tab does is
// lost: set a count, the holdings by area, par and reorder in the unit people count in, and the
// movement history on the venue's clock.
//
// The copy changes only what the house rules need: no em or en dash in the words, and money in the
// site's own currency (the optional `currency` prop). `draft` is that site's row in today's item
// shape (id = the site's inventory_items id), built by ItemSitesTab from the item detail read.
// One site companies never see this file: their Stock tab is the one inside StockItemsSplit.

import { useState, useEffect, useCallback } from 'react';
import { getLocationConfig } from '../../../../lib/locationTime';
import { money, currencySymbol, signedMoney } from '../../../../lib/currency';
import { fmtVenueDateTime } from '../../../../lib/venueDate';
import { setInventoryOnHand, fetchItemMovements, movementLabel } from '../../../../lib/stock/data';
import { fetchParLevels, upsertParLevel } from '../../../../lib/stock/counts';
import { reportSave } from '../../../../lib/saveHealth';
import { toBase, fromBase, formatToken, displayInUnits } from '../../../../lib/stock/uom';

const INV = Object.freeze({ section: 'inventory' });

const fieldStyle = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const labelStyle = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 };

function Field({ label, children }) {
  return <div style={{ marginBottom: 14 }}><label style={labelStyle}>{label}</label>{children}</div>;
}

function NeedSaveFirst() {
  return <div style={{ fontSize: 13, color: 'var(--t3)', padding: '8px 0' }}>This site has no row for the item yet. Tick it on the <b>Sites</b> tab first.</div>;
}

/** A per unit cost with up to 4 places (unit costs are often fractions of a penny). */
function fmtUnitCost(v, currency) {
  if (v == null || !Number.isFinite(Number(v))) return '';
  return currencySymbol(currency) + Number(v).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

export default function StockTab({ draft, locId, onChanged, showToast, areas = null, holdings = {}, currency = null }) {
  const [moves, setMoves] = useState(null);
  const [count, setCount] = useState('');
  const [busy, setBusy] = useState(false);
  // par and reorder are STORED in base units (the Order pad maths and the low stock alert depend on
  // that) but EDITED in the unit people count in. parBase mirrors the server; parEdit is the boxes.
  const [parBase, setParBase] = useState({ parLevel: '', reorderPoint: '' });
  const [parEdit, setParEdit] = useState({ parLevel: '', reorderPoint: '' });
  const [countUnit, setCountUnit] = useState(() => { const fmts = draft.packaging || []; const cd = fmts.find(f => f.isCountDefault) || fmts[0]; return cd ? formatToken(cd.id) : draft.baseUnit; });
  // the movement history is dated on the venue's clock and shown in the count unit
  const [venueTz, setVenueTz] = useState(null);
  useEffect(() => { getLocationConfig(locId).then(c => setVenueTz(c?.timezone || null)).catch(() => {}); }, [locId]);

  const loadMoves = useCallback(async () => {
    if (!draft.id) return;
    const { data } = await fetchItemMovements(draft.id, locId);
    setMoves(data || []);
  }, [draft.id, locId]);
  const loadPar = useCallback(async () => {
    if (!draft.id) return;
    const { data } = await fetchParLevels(locId);
    const p = data?.[draft.id];
    setParBase({ parLevel: p?.parLevel ?? '', reorderPoint: p?.reorderPoint ?? '' });
  }, [draft.id, locId]);
  useEffect(() => { loadMoves(); loadPar(); }, [loadMoves, loadPar]);

  // Count in whatever unit people pick (Keg, Case, base): converted to base.
  const uomItem = {
    baseUnit: draft.baseUnit,
    itemConversions: (draft.conversions || []).map(c => ({ fromQty: c.fromQty, fromUnit: c.fromUnit, toQty: c.toQty, toUnit: c.toUnit })),
    formats: (draft.packaging || []).map(f => ({ id: f.id, name: f.name, qtyInBase: f.qtyInBase })),
  };
  // Par shown in the unit people count in (Bottle, Case), never raw ml or g. Stored values stay in
  // base units (above).
  const parToEdit = (base) => {
    if (base === '' || base == null) return '';
    const v = fromBase(Number(base), countUnit, uomItem);
    return v == null ? String(base) : String(Math.round(v * 1000) / 1000);
  };
  // Every hook sits above the `!draft.id` early return below, so the hook order never changes.
  useEffect(() => {
    setParEdit({ parLevel: parToEdit(parBase.parLevel), reorderPoint: parToEdit(parBase.reorderPoint) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parBase.parLevel, parBase.reorderPoint, countUnit]);

  if (!draft.id) return <NeedSaveFirst />;

  const onHand = Number(draft.onHand || 0);
  const cost = draft.currentCost;
  const belowReorder = parBase.reorderPoint !== '' && onHand <= Number(parBase.reorderPoint);

  // Count only in the item's named units when it has them; ml and base stay hidden.
  const countOpts = uomItem.formats.length
    ? [...uomItem.formats].sort((a, b) => b.qtyInBase - a.qtyInBase).map(f => ({ token: formatToken(f.id), label: f.name }))
    : [{ token: uomItem.baseUnit, label: uomItem.baseUnit }];
  let countBase = null;
  if (count !== '' && Number(count) >= 0) { try { countBase = toBase(Number(count), countUnit, uomItem); } catch { countBase = null; } }
  const savePar = async (edit) => {
    const conv = (v) => {
      if (v === '' || v == null) return '';
      try { const b = toBase(Number(v), countUnit, uomItem); return Number.isFinite(b) ? b : ''; } catch { return ''; }
    };
    const nextBase = { parLevel: conv(edit.parLevel), reorderPoint: conv(edit.reorderPoint) };
    const prevBase = parBase;
    setParBase(nextBase);
    const { error } = await upsertParLevel(draft.id, nextBase, locId, INV);
    reportSave('par level', error);
    // Par and reorder drive suggested ordering and the low stock alert: a refused value left in the
    // box would have staff ordering to a number the system does not hold.
    if (error) { setParBase(prevBase); showToast?.('Par / reorder point NOT saved', 'error'); return; }
    onChanged?.();
  };
  const parUnitLabel = (countOpts.find(o => o.token === countUnit)?.label) || draft.baseUnit;

  const applyCount = async () => {
    if (countBase == null || !(countBase >= 0)) { showToast?.('Enter a count', 'error'); return; }
    setBusy(true);
    const { error } = await setInventoryOnHand(draft.id, countBase, 'Set via Stock items', locId);
    setBusy(false);
    reportSave('stock on-hand', error);
    if (error) { showToast?.(error.message, 'error'); return; }
    setCount(''); showToast?.('Stock updated', 'success');
    onChanged?.(); await loadMoves();
  };

  // Running balance, from newest to oldest (the balance after the newest is the on hand).
  let running = onHand;
  const rows = (moves || []).map((m) => { const r = { ...m, balanceAfter: running }; running -= m.qtyBase; return r; });

  return (
    <div style={{ maxWidth: 820 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <Field label="Set count (how much you have now)">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="number" min="0" step="any" value={count} onChange={e => setCount(e.target.value)} placeholder="0" style={{ ...fieldStyle, width: 100 }} />
            <select value={countUnit} onChange={e => setCountUnit(e.target.value)} style={{ ...fieldStyle, width: 150 }}>
              {countOpts.map(o => <option key={o.token} value={o.token}>{o.label}</option>)}
            </select>
            <button onClick={applyCount} disabled={busy} style={{ padding: '8px 16px', borderRadius: 7, background: 'var(--acc)', color: '#fff', border: 0, cursor: 'pointer', fontSize: 13, fontWeight: 700, opacity: busy ? 0.6 : 1 }}>Update stock</button>
            {countBase != null && countUnit !== draft.baseUnit && <span style={{ fontSize: 11, color: 'var(--t4)' }}>= {Math.round(countBase * 1000) / 1000} {draft.baseUnit}</span>}
          </div>
        </Field>
        <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t3)' }}>
          Stock value: <b style={{ color: 'var(--t1)', fontSize: 14 }}>{cost != null ? money(Math.max(0, onHand) * cost, currency) : 'None'}</b>
        </div>
      </div>

      {/* where the stock sits, area by area. Below zero is shown red, never hidden. */}
      {Array.isArray(areas) && areas.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>By area</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {areas.filter(a => a.id === draft.areaId || Number(holdings[a.id] || 0) !== 0).map(a => {
              const q = Number(holdings[a.id] || 0);
              const d = displayInUnits(q, { baseUnit: draft.baseUnit, formats: draft.packaging || [], itemConversions: uomItem.itemConversions });
              return (
                <div key={a.id} style={{ padding: '8px 12px', borderRadius: 8, background: 'var(--bg1)', border: '1px solid ' + (q < 0 ? 'var(--red, #ef4444)' : 'var(--bdr)'), minWidth: 120 }}>
                  <div style={{ fontSize: 11, color: 'var(--t3)' }}>{a.name}{a.id === draft.areaId ? ' · lives here' : ''}</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: q < 0 ? 'var(--red, #ef4444)' : 'var(--t1)' }}>{d.qty} <span style={{ fontSize: 11, color: 'var(--t3)' }}>{d.label}</span></div>
                </div>
              );
            })}
            {(() => { const sum = Object.values(holdings).reduce((s, q) => s + (Number(q) || 0), 0); const un = Math.round((onHand - sum) * 10000) / 10000; if (Math.abs(un) < 1e-9) return null; const d = displayInUnits(un, { baseUnit: draft.baseUnit, formats: draft.packaging || [], itemConversions: uomItem.itemConversions }); return (
              <div style={{ padding: '8px 12px', borderRadius: 8, background: 'var(--bg1)', border: '1px solid var(--bdr)', minWidth: 120 }}>
                <div style={{ fontSize: 11, color: 'var(--t3)' }}>Unassigned</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>{d.qty} <span style={{ fontSize: 11, color: 'var(--t3)' }}>{d.label}</span></div>
              </div>
            ); })()}
          </div>
        </div>
      )}

      {/* Par and reorder (drives low stock and suggested ordering) */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <Field label={`Par level (${parUnitLabel})`}>
          <input type="number" min="0" step="any" value={parEdit.parLevel} onChange={e => setParEdit(p => ({ ...p, parLevel: e.target.value }))} onBlur={() => savePar(parEdit)} placeholder="target" style={{ ...fieldStyle, width: 120 }} />
        </Field>
        <Field label={draft.kind === 'MADE' ? `Make more when below (${parUnitLabel})` : `Reorder at (${parUnitLabel})`}>
          <input type="number" min="0" step="any" value={parEdit.reorderPoint} onChange={e => setParEdit(p => ({ ...p, reorderPoint: e.target.value }))} onBlur={() => savePar(parEdit)} placeholder="min before reorder" style={{ ...fieldStyle, width: 140 }} />
        </Field>
        {countUnit !== draft.baseUnit && parBase.parLevel !== '' && (
          <div style={{ fontSize: 11, color: 'var(--t4)', paddingBottom: 10 }}>
            = {Math.round(Number(parBase.parLevel) * 1000) / 1000} {draft.baseUnit} par
            {parBase.reorderPoint !== '' && <> · reorder at {Math.round(Number(parBase.reorderPoint) * 1000) / 1000} {draft.baseUnit}</>}
          </div>
        )}
        {belowReorder && <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--red, #ef4444)', paddingBottom: 8 }}>{draft.kind === 'MADE' ? '⚠ below the make more level: a batch is needed' : '⚠ at or below the reorder point: time to order'}</div>}
      </div>

      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>
        Movement history
      </div>
      {moves == null && <div style={{ fontSize: 12, color: 'var(--t3)' }}>Loading…</div>}
      {moves && moves.length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>No movements yet. Set a count above to start the ledger. Deliveries, production, waste and sales will appear here.</div>}
      {moves && moves.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ color: 'var(--t3)', textAlign: 'left' }}>
                {['Date', 'Type', 'Qty', 'Unit cost', 'Value', 'Balance', 'Note'].map((h, i) => (
                  <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid var(--bdr)', textAlign: i >= 2 && i <= 5 ? 'right' : 'left', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(m => {
                const pos = m.qtyBase >= 0;
                // the count unit with its label, three places
                const dispItem = { baseUnit: draft.baseUnit, formats: draft.packaging || [], itemConversions: uomItem.itemConversions };
                const q = displayInUnits(m.qtyBase, dispItem);
                const bal = displayInUnits(m.balanceAfter, dispItem);
                return (
                  <tr key={m.id} style={{ color: 'var(--t1)' }}>
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', color: 'var(--t3)' }}>{fmtVenueDateTime(m.occurredAt, venueTz)}</td>
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)' }}>{movementLabel(m.movementType)}</td>
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: pos ? 'var(--grn, #16a34a)' : 'var(--red, #ef4444)' }}>{pos ? '+' : ''}{q.qty} {q.label}</td>
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', textAlign: 'right', color: 'var(--t3)' }}>{fmtUnitCost(m.unitCost, currency)}</td>
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', textAlign: 'right' }}>{m.valueDelta == null ? '' : signedMoney(m.valueDelta, currency)}</td>
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: m.balanceAfter < 0 ? 'var(--red, #ef4444)' : 'var(--t2)' }}>{bal.qty} {bal.label}</td>
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', color: 'var(--t3)' }}>{m.notes || ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
