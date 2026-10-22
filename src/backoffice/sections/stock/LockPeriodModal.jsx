// src/backoffice/sections/stock/LockPeriodModal.jsx
//
// MULTI SITE STOCK (v5.11.96, Drop 3, contract 3.3 and 4.3): Lock period for head office. Locking
// stores a closing snapshot of the period at this site (stock_lock_period), so a locked month never
// changes: a count inside it is refused and a back dated waste is booked today. Unlock needs a
// reason (stock_unlock_period); the snapshot rows stay. The database decides who may.

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../../store';
import { money } from '../../../lib/currency';
import { stockApi } from '../../../lib/stock/stockApi';
import { lockProblem, periodWords, snapshotRows, dayMonWords } from '../../../lib/stock/countPlanRules';
import { Modal, Btn, Field, Notice, Pill, ui, ErrorLine, EmptyLine } from './stockUi';

const localYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function Figures({ metrics }) {
  const rows = snapshotRows(metrics);
  if (!rows.length) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8, marginTop: 8 }}>
      {rows.map((r) => (
        <div key={r.key} style={{ background: 'var(--bg2)', borderRadius: 8, padding: '8px 10px' }}>
          <div style={{ fontSize: 11, color: 'var(--t3)' }}>{r.label}</div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{r.pct ? `${r.value.toFixed(1)}%` : money(r.value)}</div>
        </div>
      ))}
    </div>
  );
}

export default function LockPeriodModal({ siteId, onClose }) {
  const showToast = useStore((s) => s.showToast);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(null);      // the answer of the lock just made
  const [periods, setPeriods] = useState(null);
  const [error, setError] = useState(null);
  const [unlocking, setUnlocking] = useState(null); // { id, reason }

  const load = useCallback(async () => {
    const r = await stockApi.periods(siteId);
    if (r.error) { setError(r.error); setPeriods([]); return; }
    setError(null); setPeriods(r.data || []);
  }, [siteId]);
  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t); }, [load]);

  const problem = lockProblem(from, to, localYmd());
  const lock = async () => {
    if (problem) { showToast?.(problem, 'error'); return; }
    setBusy(true);
    const r = await stockApi.lockPeriod(siteId, from, to);
    setBusy(false);
    if (r.error) { showToast?.(r.error.message, 'error'); return; }
    setLocked(r.data || {});
    showToast?.('Period locked.', 'success');
    await load();
  };
  const unlock = async () => {
    if (!String(unlocking?.reason || '').trim()) { showToast?.('Say why you are unlocking it.', 'error'); return; }
    setBusy(true);
    const r = await stockApi.unlockPeriod(unlocking.id, unlocking.reason.trim());
    setBusy(false);
    if (r.error) { showToast?.(r.error.message, 'error'); return; }
    setUnlocking(null);
    showToast?.('Period unlocked.', 'success');
    await load();
  };

  return (
    <Modal title="Lock period" sub="Locking stores a closing snapshot, so a locked month never changes." width={640} onClose={onClose}
      footer={<><Btn onClick={onClose} style={{ marginLeft: 'auto' }}>Close</Btn></>}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="From" style={{ marginBottom: 0 }}><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ ...ui.input, width: 170 }} /></Field>
        <Field label="To" style={{ marginBottom: 0 }}><input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ ...ui.input, width: 170 }} /></Field>
        <Btn kind="primary" disabled={busy || !!problem} onClick={lock}>{busy && !unlocking ? 'Locking...' : 'Lock period'}</Btn>
      </div>
      {from && to && problem && <div style={{ ...ui.err, marginTop: 8 }}>{problem}</div>}
      {locked && (
        <div style={{ marginTop: 14 }}>
          <Notice tone="good"><b>Locked.</b> The closing figures are stored.</Notice>
          <Figures metrics={locked.metrics} />
        </div>
      )}
      <div style={{ ...ui.label, marginTop: 20 }}>Periods</div>
      <ErrorLine error={error} />
      {periods === null && <div style={{ fontSize: 13, color: 'var(--t3)' }}>Loading…</div>}
      {periods && periods.length === 0 && !error && <EmptyLine>No locked periods at this site.</EmptyLine>}
      {(periods || []).map((p) => {
        const snap = (p.stock_period_snapshots || [])[0];
        const isLocked = !!p.locked_at && !p.unlocked_at;
        return (
          <div key={p.id} style={{ border: '1px solid var(--bdr)', borderRadius: 10, padding: 12, marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <b>{dayMonWords(p.from_day)} to {dayMonWords(p.to_day)}</b>
              <Pill tone={isLocked ? 'neutral' : 'warn'}>{isLocked ? 'Locked' : 'Unlocked'}</Pill>
              <span style={{ fontSize: 12.5, color: 'var(--t3)' }}>{periodWords(p)}</span>
              {isLocked && unlocking?.id !== p.id && <Btn small style={{ marginLeft: 'auto' }} onClick={() => setUnlocking({ id: p.id, reason: '' })}>Unlock</Btn>}
            </div>
            {snap?.metrics && <Figures metrics={snap.metrics} />}
            {unlocking?.id === p.id && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <Field label="Why are you unlocking it?" style={{ marginBottom: 0, flex: '1 1 260px' }}>
                  <input value={unlocking.reason} onChange={(e) => setUnlocking((u) => ({ ...u, reason: e.target.value }))} style={ui.input} />
                </Field>
                <Btn onClick={() => setUnlocking(null)} disabled={busy}>Cancel</Btn>
                <Btn kind="danger" onClick={unlock} disabled={busy || !unlocking.reason.trim()}>{busy ? 'Unlocking...' : 'Unlock'}</Btn>
              </div>
            )}
          </div>
        );
      })}
    </Modal>
  );
}
