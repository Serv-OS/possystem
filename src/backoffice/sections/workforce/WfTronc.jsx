// src/backoffice/sections/workforce/WfTronc.jsx
//
// TRONC / TIPS (UK Tipping Act 2023). Distributes the weekly tip pool (card
// tips + service charge) across staff by published-shift hours × role points,
// reconciled to the penny server-side via the workforce-compute edge function.

import { useState, useEffect, useMemo } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { Card, EmptyState, Badge, money, th, td, inputStyle, labelStyle, LoadingCard } from '../../../staff/wfUi';
import * as wf from '../../../staff/wfData';
import { buildWeek, addWeeks, weekRangeLabel } from '../../../staff/wfWeek';

const STATUS_TONE = { draft: 'grey', run: 'blue', exported: 'green' };
const STATUS_LBL = { draft: 'Draft', run: 'Run', exported: 'Exported' };

export default function WfTronc({ ctx, staff = [], roles, sections, settings, week, showToast }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pool, setPool] = useState('');
  const [running, setRunning] = useState(false);
  const [tipInfo, setTipInfo] = useState(null); // real POS tips for the selected week
  // Week being distributed — navigable, so past weeks' tips (the usual case:
  // you run tronc AFTER the week ends) pull through. Was locked to the
  // current week, which made the system look like it found no tips.
  const [wk, setWk] = useState(() => buildWeek());

  // Venue tipping policy decides how much of the till's card tips are POOLED:
  // 'pool' → all of them; 'hybrid' → (100 − directPct)%; 'direct' → none
  // (sellers keep their own — paid via Payroll's direct-tips column instead).
  // Service charge is always pooled. The pool stays editable (e.g. pooled cash).
  const policy = settings?.settings || {};
  const tipMode = ['pool', 'direct', 'hybrid'].includes(policy.tipMode) ? policy.tipMode : 'pool';
  const pooledShare = tipMode === 'pool' ? 1 : tipMode === 'hybrid' ? 1 - Math.min(100, Math.max(0, Number(policy.directPct) || 0)) / 100 : 0;

  useEffect(() => {
    let alive = true;
    setTipInfo(null);
    wf.loadTipPool(ctx.locationId, wk.startIso, wk.endIso)
      .then(info => {
        if (!alive) return;
        const r2 = n => Math.round(n * 100) / 100;
        const suggested = r2(info.serviceCharge + info.cardTips * pooledShare);
        setTipInfo({ ...info, suggestedPool: suggested, pooledCardTips: r2(info.cardTips * pooledShare) });
        setPool(suggested > 0 ? suggested.toFixed(2) : '');
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [ctx.locationId, wk.startIso, wk.endIso, pooledShare]);

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

  // A non-draft run already exists for the selected week → it's immutable.
  const existingRun = useMemo(() => runs.find(r => r.weekStart === wk.startIso && r.status !== 'draft'), [runs, wk.startIso]);

  async function runDistribution() {
    const amount = Number(pool);
    if (!amount || amount <= 0) { showToast('Enter the tip pool amount first', 'error'); return; }
    setRunning(true);
    try {
      const res = await wf.invokeCompute('tronc.run', { location_id: ctx.locationId, week_start: wk.startIso, pool: amount });
      showToast(`Tronc distributed — ${money(res.total_paid ?? amount, 2)} across the team`, 'success');
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
          <div style={{ flex: 1, minWidth: 280 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 700 }}>
                <Icon name="tag" size={15} /> Weekly run
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button className="btn btn-ghost btn-xs" disabled={running} onClick={() => setWk(addWeeks(wk.startIso, -1))} title="Previous week"><Icon name="chevron" size={13} style={{ transform: 'rotate(180deg)' }} /></button>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, minWidth: 86, textAlign: 'center' }}>{weekRangeLabel(wk)}</span>
                <button className="btn btn-ghost btn-xs" disabled={running} onClick={() => setWk(addWeeks(wk.startIso, 1))} title="Next week"><Icon name="chevron" size={13} /></button>
                <button className="btn btn-ghost btn-xs" disabled={running} onClick={() => setWk(buildWeek())}>This week</button>
              </div>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 6, lineHeight: 1.6, maxWidth: 520 }}>
              How it works: tips taken on the till (card tips + service charge) during the selected week make the pool — pulled in automatically below. The pool is split by published-shift hours × role tronc weights, penny-exact, and the payouts feed Payroll for that period. You'd normally run a week once it's finished.
            </div>
            {/* Real tip pool pulled from the POS for the selected week */}
            <div style={{ marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '9px 13px', borderRadius: 11, background: 'var(--inset)', border: '1px solid var(--inset-border)', fontSize: 12 }}>
              {!tipInfo ? (
                <span style={{ color: 'var(--t3)' }}>Reading tips from the till…</span>
              ) : tipInfo.suggestedPool > 0 ? (<>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--acc)' }}>{money(tipInfo.suggestedPool, 2)}</span>
                <span style={{ color: 'var(--t3)' }}>to pool this week</span>
                <span style={{ color: 'var(--t4)' }}>
                  · {tipMode === 'pool' ? `card tips ${money(tipInfo.cardTips, 2)}` : tipMode === 'hybrid' ? `pooled share of card tips ${money(tipInfo.pooledCardTips, 2)} (sellers keep ${policy.directPct || 0}%)` : `card tips go direct to sellers`} + service {money(tipInfo.serviceCharge, 2)}{tipInfo.cashTips > 0 ? ` · cash ${money(tipInfo.cashTips, 2)} not pooled` : ''}
                </span>
              </>) : tipInfo.cardTips > 0 && tipMode === 'direct' ? (
                <span style={{ color: 'var(--t3)' }}>Card tips ({money(tipInfo.cardTips, 2)}) go direct to sellers under your tipping policy — they appear in Payroll's direct-tips column. Nothing to pool this week.</span>
              ) : (
                <span style={{ color: 'var(--t3)' }}>No card tips or service charge on the till for this week — use ‹ to pick the week you want to distribute.</span>
              )}
            </div>
            {existingRun && (
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--amber)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name="warn" size={13} /> This week has already been distributed ({money(existingRun.totalPaid, 2)} paid) — runs are immutable. See it below.
              </div>
            )}
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
                disabled={running || !!existingRun}
              />
            </div>
            <button
              className="btn btn-acc"
              style={{ height: 42, whiteSpace: 'nowrap' }}
              onClick={runDistribution}
              disabled={running || !Number(pool) || !!existingRun}
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
