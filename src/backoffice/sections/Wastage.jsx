/**
 * Wastage — log waste against stock items (Inventory → Wastage). Slice 5.
 * Logging posts a WASTE movement (valued at cost) + an audit row. Requires the
 * wastage migration (20260622b_wastage.sql).
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useStore } from '../../store';
import { getActiveLocationSync, getLocationId } from '../../lib/supabase';
import { getLocationConfig } from '../../lib/locationTime';
import { money } from '../../lib/currency';
import { fmtVenueDateTime, daysAgoYmd, venueRangeIso } from '../../lib/venueDate';
import { UNITS, DIMENSIONS } from '../../lib/stock/units';
import { fetchInventoryItems } from '../../lib/stock/data';
import PosWasteModal from '../../components/PosWasteModal';
import { logWaste, fetchWaste, fetchWasteLedger, WASTE_REASONS } from '../../lib/stock/waste';
// v5.11.99 (Reports align): waste at cost is the stock ledger's figure (one source for every report)
import { wasteFromLedger } from '../../lib/stock/wasteLedger.js';
import { DEMO_NOTE } from '../../../supabase/functions/_shared/demoHistory.js';
import { countLiveStockItems } from '../../lib/stock/menuWaste';
import { useWasteReasons, startReason } from '../../lib/stock/wasteReasons'; // d3 multi
import { stockApi } from '../../lib/stock/stockApi'; // d3 multi
import ManagerPinPrompt from '../../components/ManagerPinPrompt'; // d3 multi
import FreshCloseDown from './stock/FreshCloseDown'; // d3 multi
import { useStockScope } from '../StockScope'; // d3 multi

const field = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const lbl = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 };
const UNIT_OPTS = Object.entries(UNITS).map(([code, u]) => ({ code, ...u }));
const DIM_ORDER = [DIMENSIONS.COUNT, DIMENSIONS.WEIGHT, DIMENSIONS.VOLUME];

// v5.11.89 (multi site stock Drop 1): siteId is the picker's site (the signed in venue for a one site company).
export default function Wastage({ siteId = null } = {}) {
  const showToast = useStore(s => s.showToast);
  const { openReport, canOpenReports } = useStockScope();
  const [locId, setLocId] = useState(siteId || getActiveLocationSync());
  const [items, setItems] = useState([]);
  // 26 Sep 2026: a failed items read must not read as "no stock items are set up".
  const [itemsError, setItemsError] = useState(false);
  const [showProductWaste, setShowProductWaste] = useState(false);
  const [log, setLog] = useState([]);
  const [ledger, setLedger] = useState(null);   // v5.11.99: the window's WASTE movements (null: not read)
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [row, setRow] = useState({ item: null, qty: '', unit: 'each', reason: WASTE_REASONS[0], note: '' });
  const [busy, setBusy] = useState(false);
  const [venueTz, setVenueTz] = useState(null);
  // v5.11.96 (multi site stock Drop 3): the company's waste reasons (today's list for a one site company and // d3 multi
  // before the database update), the manager PIN asked for only when the database says so (no limit is set // d3 multi
  // anywhere today), and the End of day fresh close down for a multi site company. // d3 multi
  const sc = useStockScope(); // d3 multi
  const { reasons } = useWasteReasons(sc.multi ? locId : null, stockApi); // d3 multi
  const reasonNow = reasons.includes(row.reason) ? row.reason : startReason(reasons); // d3 multi
  const pinNow = useRef(null); // d3 multi
  const [pinAsk, setPinAsk] = useState(null); // d3 multi
  const [closeDown, setCloseDown] = useState(false); // d3 multi

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    // v5.11.65: "last 30 days" starts at the venue's business day 30 days back, not the device's midnight
    const cfg = await getLocationConfig(loc).catch(() => null);
    const tz = cfg?.timezone || null; setVenueTz(tz);
    const since = venueRangeIso(daysAgoYmd(30, tz), daysAgoYmd(0, tz), tz, cfg?.businessDayStart)?.fromIso || new Date(Date.now() - 30 * 86400000).toISOString();
    const [its, { data: w }, mv] = await Promise.all([fetchInventoryItems(loc), fetchWaste(since, null, loc), fetchWasteLedger(since, null, loc)]);
    setItems(its?.data || []); setItemsError(!!its?.error); setLog(w || []); setLedger(mv?.error ? null : (mv?.data || [])); setLoading(false);
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return items.filter(i => !i.archivedAt && i.name.toLowerCase().includes(s)).slice(0, 8);
  }, [q, items]);
  // v5.11.99 (Reports align): every row's cost and the total are the stock ledger's (the figure Daily
  // trading, Stock and GP and the Owner app show), demo history left out. A row with no movement
  // behind it (nothing came off stock) costs nothing. A failed ledger read shows no total, never a guess.
  const wl = useMemo(() => wasteFromLedger({ events: log, movements: ledger || [] }), [log, ledger]);
  const shown = wl.rows;
  const total = ledger == null ? null : wl.total;
  const lostSaleTotal = useMemo(() => shown.reduce((s, w) => s + (w.saleValue || 0), 0), [shown]);

  const pick = (it) => { setRow(r => ({ ...r, item: it, unit: it.baseUnit })); setQ(''); };
  const submit = async () => {
    if (!row.item) { showToast?.('Pick an item', 'error'); return; }
    if (!(Number(row.qty) > 0)) { showToast?.('Enter a quantity', 'error'); return; }
    setBusy(true);
    const { error, training, pin: pinState } = await logWaste({ inventoryItemId: row.item.id, qty: row.qty, unit: row.unit, reason: reasonNow, note: row.note, pin: pinNow.current }, locId);
    setBusy(false);
    pinNow.current = null; // d3 multi
    if (pinState) { setPinAsk({ words: error?.message || '', error: pinState === 'needed' ? null : error?.message || null }); return; } // d3 multi
    setPinAsk(null); // d3 multi
    if (error) { showToast?.(error.message, 'error'); return; }
    // 26 Sep 2026: on a Training Mode device logWaste writes nothing; never say "Waste logged".
    showToast?.(training ? 'Training mode: waste not recorded' : 'Waste logged', training ? 'info' : 'success');
    setRow({ item: null, qty: '', unit: 'each', reason: startReason(reasons), note: '' });
    await reload();
  };

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px', maxWidth: 900 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 4px', color: 'var(--t1)' }}>Wastage</h1>
      {/* v5.11.92 (Drop 4a, contract 2.4): the link renders nothing for a one site company (canOpenReports false), so its HTML is today's. */}
      {canOpenReports && locId && (
        <button type="button" onClick={() => openReport({ report: 'stock_waste', sites: { kind: 'sites', ids: [locId] }, period: 'last-week' })}
          style={{ background: 'transparent', border: 'none', padding: '0 0 6px', color: 'var(--acc)', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>See the report</button>
      )}
      <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 18 }}>Record spoilage, breakage, over-production etc. It comes off stock and is valued at cost — and counts as explained loss, so it doesn’t show up as a mystery in “The Gap”.</div>

      {/* Log form */}
      <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 18, marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', marginRight: 'auto' }}>Log waste</div>
          {/* v5.5.927: BO could only waste STOCK items. Wasting a SELLING item (a dropped
              burger) goes through the same modal the POS uses — recipe explosion deducts
              the patty, records cost AND the lost sale. One behaviour everywhere. */}
          <button onClick={() => setShowProductWaste(true)} style={{ padding: '7px 13px', borderRadius: 8, background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t1)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
            Waste a menu item…
          </button>
          {sc.multi && <button onClick={() => setCloseDown(true)} style={{ marginLeft: 8, padding: '7px 13px', borderRadius: 8, background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t1)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>End of day</button>}{/* d3 multi */}
        </div>
        {!row.item ? (
          // 26 Sep 2026, Peter: "should be able to waste without stock". With no stock items
          // the search box below could never match anything; point at the product path instead.
          // Only when the read succeeded: a failed read keeps the search box, never this line.
          // Archived items do not count: the search below never offers them either.
          !loading && !itemsError && countLiveStockItems(items) === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.5 }}>No stock items are set up, so waste is recorded by menu item: tap <b>Waste a menu item…</b> above. Each record keeps the product, how many, the reason, a note and the lost sale. Add stock items to waste raw stock too.</div>
          ) : (
            <div style={{ position: 'relative', maxWidth: 360 }}>
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search a stock item…" style={field} />
              {matches.length > 0 && (
                <div style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8, marginTop: 4, overflow: 'hidden', boxShadow: '0 10px 30px rgba(0,0,0,0.3)' }}>
                  {matches.map(i => <div key={i.id} onClick={() => pick(i)} style={{ padding: '9px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--t1)' }}>{i.name}</div>)}
                </div>
              )}
            </div>
          )
        ) : (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 160 }}><label style={lbl}>Item</label><div style={{ ...field, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>{row.item.name}<button onClick={() => setRow(r => ({ ...r, item: null }))} style={{ background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer' }}>×</button></div></div>
            <div><label style={lbl}>Qty</label><input type="number" min="0" step="any" value={row.qty} onChange={e => setRow(r => ({ ...r, qty: e.target.value }))} style={{ ...field, width: 90 }} /></div>
            <div><label style={lbl}>Unit</label>
              <select value={row.unit} onChange={e => setRow(r => ({ ...r, unit: e.target.value }))} style={{ ...field, width: 120 }}>
                {DIM_ORDER.map(dim => <optgroup key={dim} label={dim[0] + dim.slice(1).toLowerCase()}>{UNIT_OPTS.filter(u => u.dimension === dim).map(u => <option key={u.code} value={u.code}>{u.code}</option>)}</optgroup>)}
              </select>
            </div>
            <div><label style={lbl}>Reason</label>
              <select value={reasonNow} onChange={e => setRow(r => ({ ...r, reason: e.target.value }))} style={{ ...field, width: 160 }}>
                {reasons.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 140 }}><label style={lbl}>Note</label><input value={row.note} onChange={e => setRow(r => ({ ...r, note: e.target.value }))} style={field} placeholder="optional" /></div>
            <button onClick={submit} disabled={busy} style={{ padding: '9px 18px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 0, fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>Log waste</button>
          </div>
        )}
      </div>

      {/* Log */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>Last 30 days</div>
        <div style={{ fontSize: 14, color: 'var(--t1)' }}>Waste at cost: <b style={{ color: 'var(--red, #ef4444)' }}>{total == null ? 'not read' : money(total)}</b>{lostSaleTotal > 0 && <span> · lost sales: <b style={{ color: 'var(--red, #ef4444)' }}>{money(lostSaleTotal)}</b></span>}</div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--t4)', marginBottom: 8 }}>Valued from the stock ledger, the same figure as Daily trading and Stock and GP. A row that took nothing off stock costs nothing.{wl.demoLeft > 0 ? ` ${DEMO_NOTE}.` : ''}</div>
      {loading && <div style={{ fontSize: 12, color: 'var(--t3)' }}>Loading…</div>}
      {!loading && shown.length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>No waste logged yet.</div>}
      {shown.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead><tr style={{ color: 'var(--t3)', textAlign: 'left' }}>{['Date', 'Item', 'Qty', 'Reason', 'Cost', 'Lost sale', 'Note'].map(h => <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid var(--bdr)', fontWeight: 600 }}>{h}</th>)}</tr></thead>
          <tbody>{shown.map(w => (
            <tr key={w.id} style={{ color: 'var(--t1)' }}>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', color: 'var(--t3)' }}>{fmtVenueDateTime(w.occurredAt, venueTz)}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)' }}>{w.itemName}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)' }}>{w.qty} {w.unit}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', color: 'var(--t3)' }}>{w.reason}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)' }} title={w.onLedger ? undefined : 'Nothing came off stock'}>{ledger == null ? (w.costValue == null ? '—' : money(w.costValue)) : w.ledgerCost == null ? '—' : money(w.ledgerCost)}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', color: 'var(--t3)' }}>{w.saleValue == null ? '—' : money(w.saleValue)}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', color: 'var(--t3)' }}>{w.note || ''}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <PosWasteModal open={showProductWaste} onClose={() => { setShowProductWaste(false); reload(); }} locationId={locId} showToast={showToast} />
      {pinAsk && <ManagerPinPrompt words={pinAsk.words} error={pinAsk.error} busy={busy} onCancel={() => setPinAsk(null)} onPin={(pin) => { pinNow.current = pin; submit(); }} />}{/* d3 multi */}
      {closeDown && <FreshCloseDown siteId={locId} onClose={() => setCloseDown(false)} onDone={() => { setCloseDown(false); reload(); }} />}{/* d3 multi */}
    </div>
  );
}
