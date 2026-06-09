// src/backoffice/sections/workforce/WfTronc.jsx
//
// TRONC / TIPS (UK Tipping Act 2023). Distributes the weekly tip pool (card
// tips + service charge) across staff by published-shift hours × role points,
// reconciled to the penny server-side via the workforce-compute edge function.

import { useState, useEffect, useMemo } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { Card, EmptyState, Badge, money, th, td, inputStyle, labelStyle, LoadingCard } from '../../../staff/wfUi';
import * as wf from '../../../staff/wfData';
import { weekRangeLabel } from '../../../staff/wfWeek';

const STATUS_TONE = { draft: 'grey', run: 'blue', exported: 'green' };
const STATUS_LBL = { draft: 'Draft', run: 'Run', exported: 'Exported' };

export default function WfTronc({ ctx, staff = [], roles, sections, settings, week, showToast }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pool, setPool] = useState('');
  const [running, setRunning] = useState(false);

  const nameOf = useMemo(() => {
    const m = {};
    staff.forEach(s => { m[s.id] = s.name; });
    return id => m[id] || 'Unknown';
  }, [staff]);

  async function reload() {
    try {
      const rows = await wf.loadTroncRuns(ctx.locationId);
      setRuns(rows || []);
    } catch (e) {
      showToast(e.message || 'Could not load tronc runs', 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    wf.loadTroncRuns(ctx.locationId)
      .then(rows => { if (alive) setRuns(rows || []); })
      .catch(e => showToast(e.message || 'Could not load tronc runs', 'error'))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [ctx.locationId]);

  async function runDistribution() {
    const amount = Number(pool);
    if (!amount || amount <= 0) { showToast('Enter the tip pool amount first', 'error'); return; }
    setRunning(true);
    try {
      const res = await wf.invokeCompute('tronc.run', { location_id: ctx.locationId, week_start: week.startIso, pool: amount });
      showToast(`Tronc distributed — ${money(res.total_paid ?? amount, 2)} across the team`, 'success');
      setPool('');
      await reload();
    } catch (e) {
      showToast(e.message || 'Distribution failed', 'error');
    } finally {
      setRunning(false);
    }
  }

  if (loading) return <LoadingCard label="Loading tronc…" />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* New weekly run */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 700 }}>
              <Icon name="tag" size={15} /> New weekly run
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 6, lineHeight: 1.6, maxWidth: 460 }}>
              Pool split by published-shift hours × role points, reconciled to the penny. Enter the card tips + service charge collected for{' '}
              <span style={{ color: 'var(--t1)', fontWeight: 600 }}>{weekRangeLabel(week)}</span>.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
            <div style={{ width: 170 }}>
              <label style={labelStyle}>Tip pool (£)</label>
              <input
                style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                placeholder="0.00"
                value={pool}
                onChange={e => setPool(e.target.value)}
                disabled={running}
              />
            </div>
            <button
              className="btn btn-acc"
              style={{ height: 42, whiteSpace: 'nowrap' }}
              onClick={runDistribution}
              disabled={running || !Number(pool)}
            >
              <Icon name={running ? 'clock' : 'sparkle'} size={14} /> {running ? 'Running…' : 'Run distribution'}
            </button>
          </div>
        </div>
      </Card>

      {/* Runs */}
      {runs.length === 0 ? (
        <EmptyState
          icon="tag"
          title="No tronc runs yet"
          body="Tips and service charge are pooled and shared fairly across the team each week. Publish this week’s rota, then enter the pool above and run the distribution — every payout will appear here, reconciled to the penny."
        />
      ) : (
        runs.map(run => <RunCard key={run.id} run={run} nameOf={nameOf} showToast={showToast} />)
      )}
    </div>
  );
}

function RunCard({ run, nameOf, showToast }) {
  const [lines, setLines] = useState(Array.isArray(run.lines) ? run.lines : []);
  const [loadingLines, setLoadingLines] = useState(false);
  const balanced = Number(run.residual || 0) === 0;

  // Snapshot lines may use staff_id (jsonb) or staffId (mapped). Normalise.
  const normLines = useMemo(
    () => (lines || []).map(l => ({
      staffId: l.staffId ?? l.staff_id,
      hours: Number(l.hours ?? 0),
      points: Number(l.points ?? 0),
      units: Number(l.units ?? 0),
      sharePct: Number(l.sharePct ?? l.share_pct ?? 0),
      payout: Number(l.payout ?? 0),
    })),
    [lines]
  );

  useEffect(() => {
    if (normLines.length) return; // snapshot already present
    let alive = true;
    setLoadingLines(true);
    wf.loadTroncLines(run.id)
      .then(rows => { if (alive) setLines(rows || []); })
      .catch(e => showToast(e.message || 'Could not load tronc lines', 'error'))
      .finally(() => { if (alive) setLoadingLines(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{weekRangeLabel({ startIso: run.weekStart, endIso: weekEnd(run.weekStart) })}</div>
          <Badge tone={STATUS_TONE[run.status] || 'grey'}>{STATUS_LBL[run.status] || run.status || '—'}</Badge>
        </div>
        <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
          <Metric label="Pool" value={money(run.pool, 2)} />
          <Metric label="Point value" value={money(run.pointValue || 0, 4)} />
          <Metric label="Total paid" value={money(run.totalPaid, 2)} />
          <div>
            <div style={labelStyle}>Residual</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700, color: balanced ? 'var(--grn)' : 'var(--red)' }}>
              <Icon name={balanced ? 'check' : 'warn'} size={14} /> {money(run.residual || 0, 2)}
            </div>
          </div>
        </div>
      </div>

      {loadingLines ? (
        <div style={{ padding: '14px 0', color: 'var(--t3)', fontSize: 13 }}>Loading payouts…</div>
      ) : normLines.length === 0 ? (
        <div style={{ padding: '14px 0', color: 'var(--t3)', fontSize: 13 }}>No payout lines recorded for this run.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Team member</th>
                <th style={{ ...th, textAlign: 'right' }}>Hours</th>
                <th style={{ ...th, textAlign: 'right' }}>Points</th>
                <th style={{ ...th, textAlign: 'right' }}>Units</th>
                <th style={{ ...th, textAlign: 'right' }}>Share %</th>
                <th style={{ ...th, textAlign: 'right' }}>Payout</th>
              </tr>
            </thead>
            <tbody>
              {normLines.map((l, i) => (
                <tr key={l.staffId || i}>
                  <td style={td}>{nameOf(l.staffId)}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--t2)' }}>{l.hours.toFixed(2)}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--t2)' }}>{l.points.toFixed(2)}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--t2)' }}>{l.units.toFixed(2)}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--t3)' }}>{(l.sharePct * (l.sharePct <= 1 ? 100 : 1)).toFixed(1)}%</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{money(l.payout, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Metric({ label, value }) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>{value}</div>
    </div>
  );
}

/** End date (Sunday) of a Monday week-start ISO, for the range label. */
function weekEnd(startIso) {
  if (!startIso) return startIso;
  const d = new Date(startIso + 'T00:00:00');
  d.setDate(d.getDate() + 6);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
