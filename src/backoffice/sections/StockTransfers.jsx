/**
 * StockTransfers (Inventory, Transfers), 16 Oct 2026. Stock moving between areas of one venue
 * and between venues (supabase/migrations/20261016_OPS_stock_areas.sql: stock_transfers,
 * stock_transfer_lines, post_stock_transfer_leg).
 *
 * THIS BUILD: the list of transfers either end of this venue (the moves recorded when an item's
 * area changed, and the moves a count approval recorded). The Move stock form (from area, to
 * area, items), Send to another venue and the Receive view with SKU matching are the next build
 * on this branch (builder B). The data layer they use is in src/lib/stock/areas.js
 * (moveHoldingBetweenAreas, fetchTransfers, fetchTransfer) and the pure rules in areaRules.js
 * (transferPlan, matchTransferLines, canReceive).
 */

import { useState, useEffect, useCallback } from 'react';
import { getActiveLocationSync, getLocationId } from '../../lib/supabase';
import { getLocationConfig } from '../../lib/locationTime';
import { fmtVenueDateTime } from '../../lib/venueDate';
import { areasReady, fetchAreas, fetchTransfers } from '../../lib/stock/areas';
import { NEEDS_UPDATE_TEXT } from './StockAreas';

const STATUS_WORDS = { DRAFT: 'Draft', SENT: 'Sent', RECEIVED: 'Received', CANCELLED: 'Cancelled', DONE: 'Done' };

export default function StockTransfers() {
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [ready, setReady] = useState(null);
  const [rows, setRows] = useState([]);
  const [areas, setAreas] = useState([]);
  const [venueTz, setVenueTz] = useState(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    const ok = await areasReady(loc);
    if (loc && loc !== locId) setLocId(loc);
    getLocationConfig(loc).then(c => setVenueTz(c?.timezone || null)).catch(() => {});
    setReady(ok);
    if (ok) {
      const [{ data: ts }, { data: as }] = await Promise.all([fetchTransfers(loc), fetchAreas(loc, { includeArchived: true })]);
      setRows(ts || []); setAreas(as || []);
    }
    setLoading(false);
  }, [locId]);
  // the first load runs after this render settles (never a setState straight inside the effect)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(reload, 0); return () => clearTimeout(t); }, []);

  const areaName = (id) => areas.find(a => a.id === id)?.name || (id ? 'Area' : '');

  if (loading) return <div style={{ padding: 26, color: 'var(--t3)' }}>Loading...</div>;
  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px', maxWidth: 760 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--t1)' }}>Transfers</h1>
      <div style={{ fontSize: 13, color: 'var(--t3)', margin: '4px 0 18px' }}>
        Stock moved between areas (cellar to fridge) or to another venue. Every move is two ledger rows, out of one place and into the other, so each area's holding stays right.
      </div>
      {ready === false && <div style={{ fontSize: 13, color: 'var(--t3)' }}>{NEEDS_UPDATE_TEXT}</div>}
      {ready && (
        <>
          <div style={{ fontSize: 12.5, color: 'var(--t3)', marginBottom: 14, padding: '10px 12px', borderRadius: 10, background: 'var(--bg1)', border: '1px solid var(--bdr)' }}>
            Moving stock by hand (Move stock), sending to another venue and receiving arrive in the next build. Until then a move is recorded when an item's area is changed on Stock items or Stock areas, and when a count approval says an item was moved.
          </div>
          {rows.length === 0 && <div style={{ fontSize: 13, color: 'var(--t3)' }}>No transfers yet.</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rows.map(t => {
              const within = !t.toLocationId || t.toLocationId === t.locationId;
              const incoming = !within && t.toLocationId === locId;
              return (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 10, padding: '12px 16px' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, color: 'var(--t1)' }}>
                      {t.reference || 'Transfer'} · {within ? `${areaName(t.fromAreaId) || 'No area'} to ${areaName(t.toAreaId) || 'No area'}` : (incoming ? 'Incoming from another venue' : 'Sent to another venue')}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>
                      {fmtVenueDateTime(t.createdAt, venueTz)}{t.sentByName ? ` · ${t.sentByName}` : t.createdByName ? ` · ${t.createdByName}` : ''}{t.note ? ` · ${t.note}` : ''}
                    </div>
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, color: t.status === 'DONE' || t.status === 'RECEIVED' ? 'var(--grn, #16a34a)' : 'var(--t3)' }}>{STATUS_WORDS[t.status] || t.status}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
