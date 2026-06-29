// ManagerKitchen — stock to order (below par/reorder, grouped by supplier) + incoming deliveries
// (open POs awaiting goods-in) + batch cooks today (scheduled prep, tap to Record). Reads the shared
// snapshot; the pure decisions live in src/lib/manager/kitchen.js. Recording a cook writes prep_log
// (training-gated, RLS-fenced). The goods-in CHECK stays in the Ops tab → Deliveries. NOT the KDS rail.
import { useState } from 'react';
import { belowPar, bySupplier, groupBatches } from '../../lib/manager/kitchen';
import { recordPrep } from '../../lib/prep';
import { Header, Stat, SectionTitle, mono } from './ui';
import { Icon } from '../../components/ServOSIcons';

const DEL_PILL = { pending: ['Expected', 'var(--orn)'], accepted: ['Arrived', 'var(--grn)'], rejected: ['Rejected', 'var(--red)'] };
const shortDate = (s) => { if (!s) return null; const d = new Date(s); return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : null; };
const timeOf = (ms) => (ms ? new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
const qtyLbl = (b) => [b.plannedQty != null ? b.plannedQty : null, b.unit].filter((x) => x != null && x !== '').join('');

export default function ManagerKitchen({ ctx }) {
  const { snap, snapErr: err, loc, operator, refreshSnap } = ctx;
  const [recording, setRecording] = useState(null);
  const [recErr, setRecErr] = useState('');

  const items = snap?.kitchen?.items || [];
  const incoming = snap?.kitchen?.deliveries || [];
  const short = belowPar(items);
  const groups = bySupplier(items);
  const supplierNames = Object.keys(groups).sort((a, b) => (a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b)));

  // Batch cooks: snapshot passes raw dueDate+dueTime; build dueAtMs in the device's (venue-local) tz.
  const batches = (snap?.kitchen?.batches || []).map((b) => ({ ...b, dueAtMs: b.dueTime ? Date.parse(`${b.dueDate}T${b.dueTime}`) : null }));
  const grp = groupBatches(batches);
  const batchTotal = grp.counts.done + grp.counts.overdue + grp.counts.due;

  const doRecord = async (b) => {
    setRecording(b.id); setRecErr('');
    const r = await recordPrep({ scheduleId: b.scheduleId, name: b.name, prepDate: b.dueDate, actualQty: b.plannedQty, unit: b.unit, operator }, loc);
    setRecording(null);
    if (r?.ok) refreshSnap?.(); else setRecErr(r?.error || 'Could not record');
  };

  const batchRow = (b, state) => {
    const busy = recording === b.id;
    const tone = state === 'overdue' ? 'var(--red)' : state === 'done' ? 'var(--grn)' : 'var(--t3)';
    const sub = state === 'done'
      ? `✓ logged ${timeOf(b.completedAtMs)}${b.assignee ? ` · ${b.assignee}` : ''}`
      : state === 'overdue'
      ? `overdue${b.dueTime ? ` · due ${b.dueTime}` : ''}`
      : (b.dueTime ? `due ${b.dueTime}` : 'today');
    return (
      <div key={b.id} className="sv-glass" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14, border: state === 'overdue' ? '1px solid var(--red-b)' : '1px solid var(--bdr)' }}>
        {state === 'done'
          ? <span style={{ width: 22, height: 22, borderRadius: 6, background: 'var(--grn)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="check" size={14} style={{ color: '#06130C' }} /></span>
          : <Icon name="fire" size={16} style={{ color: tone, flexShrink: 0 }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{b.name}{qtyLbl(b) ? <span style={{ color: 'var(--t3)', fontWeight: 600 }}> · {qtyLbl(b)}</span> : null}</div>
          <div style={{ fontSize: 11, color: tone, ...mono }}>{sub}</div>
        </div>
        {state !== 'done' && (
          <button onClick={() => doRecord(b)} disabled={busy} className="sv-glass"
            style={{ padding: '8px 14px', borderRadius: 999, border: '1px solid var(--grn-b)', cursor: busy ? 'default' : 'pointer', color: 'var(--grn)', fontWeight: 800, fontSize: 12.5, fontFamily: 'inherit', flexShrink: 0 }}>
            {busy ? '…' : 'Record'}
          </button>
        )}
      </div>
    );
  };

  return (
    <div>
      <Header title="Kitchen" sub="Stock · deliveries · prep" />
      {!snap && !err && <div style={{ color: 'var(--t3)', padding: 16, ...mono }}>Loading…</div>}
      {err && <div className="sv-glass" style={{ padding: 16, marginTop: 12, color: 'var(--t3)', fontSize: 13 }}>Couldn’t load stock ({err}).</div>}

      {snap && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
            <Stat label="To order" value={short.length} tone={short.length ? 'var(--red)' : 'var(--grn)'} />
            <Stat label="Incoming" value={incoming.length} tone={incoming.length ? 'var(--orn)' : 'var(--t1)'} />
          </div>

          {short.length === 0 && (
            <div className="sv-glass" style={{ padding: 20, marginTop: 12, textAlign: 'center' }}>
              <Icon name="check" size={24} style={{ color: 'var(--grn)' }} />
              <div style={{ fontSize: 14, fontWeight: 700, marginTop: 6 }}>Everything’s at par</div>
              <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>No tracked item is below par or its reorder point.</div>
            </div>
          )}

          {supplierNames.map((sup) => (
            <div key={sup}>
              <SectionTitle right={`${groups[sup].length} item${groups[sup].length === 1 ? '' : 's'}`}>{sup}</SectionTitle>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {groups[sup].map((i) => (
                  <div key={i.itemId} className="sv-glass" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14, border: i.belowReorder ? '1px solid var(--red-b)' : '1px solid var(--bdr)' }}>
                    <Icon name="inventory" size={16} style={{ color: i.belowReorder ? 'var(--red)' : 'var(--t3)', flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700 }}>{i.name}</div>
                      <div style={{ fontSize: 11, color: i.belowReorder ? 'var(--red)' : 'var(--t3)', ...mono }}>
                        {i.onHand} on hand · par {i.par ?? '—'}{i.belowReorder ? ' · below reorder' : ''}
                      </div>
                    </div>
                    {i.shortfall > 0 && <span style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--orn)', ...mono }}>+{i.shortfall}</span>}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {incoming.length > 0 && (
            <>
              <SectionTitle right={`${incoming.length} ${incoming.length === 1 ? 'order' : 'orders'}`}>On order · incoming</SectionTitle>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {incoming.map((d) => {
                  const [pillLabel, pillCol] = DEL_PILL[d.status] || DEL_PILL.pending;
                  const eta = shortDate(d.expectedDate);
                  return (
                    <div key={d.id} className="sv-glass" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14 }}>
                      <Icon name="delivery" size={16} style={{ color: 'var(--t3)', flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 700 }}>{d.supplier || d.reference || 'Purchase order'}</div>
                        <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>
                          {d.lines} line{d.lines === 1 ? '' : 's'}{eta ? ` · ETA ${eta}` : ''}
                        </div>
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 700, color: pillCol, ...mono }}>{pillLabel}</span>
                    </div>
                  );
                })}
              </div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 8, lineHeight: 1.5, ...mono }}>Check goods in from the Ops tab → Deliveries.</div>
            </>
          )}

          {batchTotal > 0 && (
            <>
              <SectionTitle right={`${grp.counts.done}/${batchTotal} done`}>Batch cooks · today</SectionTitle>
              {recErr && <div className="sv-glass" style={{ padding: '10px 14px', marginBottom: 8, color: 'var(--red)', fontSize: 12.5, border: '1px solid var(--red-b)' }}>{recErr}</div>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {grp.overdue.map((b) => batchRow(b, 'overdue'))}
                {grp.due.map((b) => batchRow(b, 'due'))}
                {grp.done.map((b) => batchRow(b, 'done'))}
              </div>
            </>
          )}

          <div className="sv-glass" style={{ padding: 16, marginTop: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 800 }}>Raise PO — next</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 }}>
              Sending a purchase order per supplier lands next — it writes to stock, so it goes through the secure write path. Set up the prep list in Back Office → Operations → Prep schedule.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
