import { useEffect, useMemo } from 'react';
import { useStore } from '../../store';
import { money } from '../../lib/currency';

/**
 * Shift section (v4.6.37).
 *
 * Shows the current shift + history. Only a manager or admin can close
 * a shift, and only when every drawer is idle (i.e. already cashed up
 * via EOD close). Auto-open/auto-close is handled by useSupabaseInit
 * at app mount — this page is where staff can see what's going on and
 * where the manager drives a manual close.
 */

const STATUS_BADGE = {
  open:        { label: 'Open',        bg: 'var(--grn-d)',                color: 'var(--grn)' },
  closing:     { label: 'Closing',     bg: 'rgba(232,160,32,.12)',         color: 'var(--amb,#e8a020)' },
  closed:      { label: 'Closed',      bg: 'var(--bg3)',                   color: 'var(--t3)' },
  auto_closed: { label: 'Auto-closed', bg: 'var(--bg3)',                   color: 'var(--t4)' },
};

const fmtDur = (openedAt, closedAt) => {
  const start = new Date(openedAt).getTime();
  const end = closedAt ? new Date(closedAt).getTime() : Date.now();
  const hrs = (end - start) / 3600000;
  if (hrs < 1) return `${Math.round(hrs * 60)}m`;
  return `${Math.floor(hrs)}h ${Math.round((hrs % 1) * 60)}m`;
};

const fmtTime = (ts) => new Date(ts).toLocaleString('en-GB', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
});

export default function Shift() {
  const currentShift = useStore(s => s.currentShift);
  const history = useStore(s => s.shiftHistory) || [];
  const cashDrawers = useStore(s => s.cashDrawers) || [];
  const closedChecks = useStore(s => s.closedChecks) || [];
  const cashMovements = useStore(s => s.cashMovements) || []; // optional, may be empty in current build
  const staff = useStore(s => s.staff);
  const loadCurrentShift = useStore(s => s.loadCurrentShift);
  const loadShiftHistory = useStore(s => s.loadShiftHistory);
  const closeShift = useStore(s => s.closeShift);
  const openShift = useStore(s => s.openShift);

  useEffect(() => {
    loadCurrentShift?.();
    loadShiftHistory?.();
  }, [loadCurrentShift, loadShiftHistory]);

  const canClose = useMemo(() => {
    const role = staff?.role;
    const hasPerm = Array.isArray(staff?.permissions) && (staff.permissions.includes('cashup') || staff.permissions.includes('eod'));
    return role === 'Manager' || role === 'Admin' || hasPerm;
  }, [staff]);

  const allDrawersIdle = cashDrawers.every(d => !d.status || d.status === 'idle');

  // Compute current-shift totals from closed_checks + drawer statuses
  const currentTotals = useMemo(() => {
    if (!currentShift) return null;
    const mine = closedChecks.filter(c => c.shiftId === currentShift.id);
    const revenue = mine.reduce((s, c) => s + (c.total || 0), 0);
    const cash = mine.filter(c => c.method === 'cash').reduce((s, c) => s + (c.total || 0), 0);
    const card = mine.filter(c => c.method !== 'cash').reduce((s, c) => s + (c.total || 0), 0);
    return { revenue, cash, card, checks: mine.length };
  }, [currentShift, closedChecks]);

  const handleClose = async () => {
    if (!canClose) return;
    if (!allDrawersIdle) return;
    if (!confirm('Close this shift? This finalises today\'s reporting window. All drawers must already be cashed up.')) return;
    await closeShift?.({ notes: '' });
  };

  const handleOpen = async () => {
    await openShift?.();
  };

  return (
    <div style={{ padding: '22px 28px', maxWidth: 1100 }}>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize:22, fontWeight:800, color:'var(--t1)' }}>Shift</div>
        <div style={{ fontSize:13, color:'var(--t3)', marginTop:4 }}>
          Current shift state + history. Shifts open automatically at app mount and auto-close at the business day boundary.
        </div>
      </div>

      {/* Current shift card */}
      {currentShift ? (
        <div style={{ background:'var(--bg1)', border:'1.5px solid var(--grn-b)', borderRadius:14, padding:'16px 18px', marginBottom:20 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:12 }}>
            <div>
              <div style={{ display:'flex', gap:10, alignItems:'center', marginBottom:4 }}>
                <div style={{ fontSize:16, fontWeight:800, color:'var(--t1)' }}>Current shift</div>
                <div style={{ fontSize:10, fontWeight:800, padding:'3px 9px', borderRadius:6, background:STATUS_BADGE.open.bg, color:STATUS_BADGE.open.color }}>OPEN</div>
              </div>
              <div style={{ fontSize:12, color:'var(--t3)' }}>
                Opened {fmtTime(currentShift.openedAt)} · running {fmtDur(currentShift.openedAt)}
              </div>
            </div>
            <button
              onClick={handleClose}
              disabled={!canClose || !allDrawersIdle}
              title={!canClose ? 'Manager/admin only' : !allDrawersIdle ? 'Close all drawers first' : 'Finalise this shift'}
              style={{
                padding:'10px 18px', borderRadius:10, border:'none',
                background: (canClose && allDrawersIdle) ? 'var(--red)' : 'var(--bg3)',
                color: (canClose && allDrawersIdle) ? '#fff' : 'var(--t4)',
                fontWeight:800, fontFamily:'inherit', cursor: (canClose && allDrawersIdle) ? 'pointer' : 'not-allowed', fontSize:13,
              }}>
              Close shift
            </button>
          </div>

          {/* Totals */}
          {currentTotals && (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:10, marginBottom:14 }}>
              {[
                ['Revenue',  money(currentTotals.revenue), 'var(--acc)'],
                ['Cash',     money(currentTotals.cash),    'var(--grn)'],
                ['Card',     money(currentTotals.card),    '#3b82f6'],
                ['Checks',   String(currentTotals.checks),            'var(--t1)'],
              ].map(([label, value, color]) => (
                <div key={label} style={{ background:'var(--bg2)', borderRadius:10, padding:'10px 12px' }}>
                  <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:4 }}>{label}</div>
                  <div style={{ fontSize:18, fontWeight:900, color, fontFamily:'var(--font-mono)' }}>{value}</div>
                </div>
              ))}
            </div>
          )}

          {/* Drawer status grid */}
          <div style={{ fontSize:11, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>Drawer status</div>
          {cashDrawers.length === 0 ? (
            <div style={{ fontSize:12, color:'var(--t4)', padding:'10px 12px', background:'var(--bg2)', borderRadius:8 }}>
              No drawers configured. Go to Back Office &gt; Devices &gt; Cash drawers to set one up.
            </div>
          ) : (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(170px, 1fr))', gap:8 }}>
              {cashDrawers.map(d => {
                const status = d.status || 'idle';
                const bg = status === 'idle' ? 'var(--bg2)' : status === 'open' ? 'var(--grn-d)' : 'rgba(232,160,32,.12)';
                const color = status === 'idle' ? 'var(--t3)' : status === 'open' ? 'var(--grn)' : 'var(--amb,#e8a020)';
                return (
                  <div key={d.id} style={{ background:bg, border:`1px solid ${color}`, borderRadius:8, padding:'8px 10px' }}>
                    <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>{d.name}</div>
                    <div style={{ fontSize:10, fontWeight:700, color, textTransform:'uppercase', letterSpacing:'.07em', marginTop:2 }}>{status}</div>
                    <div style={{ fontSize:11, color:'var(--t3)', marginTop:3, fontFamily:'var(--font-mono)' }}>{money(Number(d.currentFloat || 0))}</div>
                  </div>
                );
              })}
            </div>
          )}

          {!allDrawersIdle && (
            <div style={{ fontSize:11, color:'var(--amb,#e8a020)', marginTop:12, padding:'8px 10px', background:'rgba(232,160,32,.08)', borderRadius:6 }}>
              ⚠ One or more drawers are still open or counting. Close shift is blocked until every drawer is idle. Cash up from EOD Close.
            </div>
          )}
        </div>
      ) : (
        <div style={{ background:'var(--bg1)', border:'1px dashed var(--bdr2)', borderRadius:14, padding:'28px 20px', textAlign:'center', marginBottom:20 }}>
          <div style={{ fontSize:36, marginBottom:8, opacity:.35 }}>⏸</div>
          <div style={{ fontSize:14, fontWeight:700, color:'var(--t3)' }}>No shift is currently open</div>
          <div style={{ fontSize:12, color:'var(--t4)', marginTop:4 }}>Normally the shift opens automatically at app mount. If you need to start one manually, click below.</div>
          <button onClick={handleOpen}
            style={{ marginTop:14, padding:'10px 20px', borderRadius:10, background:'var(--acc)', border:'none', color:'#fff', fontWeight:700, fontFamily:'inherit', cursor:'pointer', fontSize:13 }}>
            Open shift
          </button>
        </div>
      )}

      {/* History */}
      <div style={{ fontSize:14, fontWeight:800, color:'var(--t1)', marginBottom:10 }}>Recent shifts</div>
      {history.length === 0 ? (
        <div style={{ fontSize:12, color:'var(--t4)', padding:'16px', background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:10 }}>
          No past shifts yet.
        </div>
      ) : (
        <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:10, overflow:'hidden' }}>
          {history.map((h, i) => {
            const badge = STATUS_BADGE[h.status] || STATUS_BADGE.closed;
            return (
              <div key={h.id} style={{ display:'flex', alignItems:'center', gap:14, padding:'10px 14px', borderBottom: i < history.length - 1 ? '1px solid var(--bdr)' : 'none' }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>
                    {new Date(h.opened_at).toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' })}
                  </div>
                  <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>
                    {fmtTime(h.opened_at)} → {h.closed_at ? fmtTime(h.closed_at) : '—'} · {h.closed_at ? fmtDur(h.opened_at, h.closed_at) : 'still open'}
                  </div>
                </div>
                <div style={{ fontSize:10, fontWeight:800, padding:'3px 9px', borderRadius:6, background:badge.bg, color:badge.color, textTransform:'uppercase', letterSpacing:'.07em' }}>{badge.label}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
