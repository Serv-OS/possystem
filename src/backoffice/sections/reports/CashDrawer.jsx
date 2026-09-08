// v4.6.42: Cash drawer report — every cash-in → cash-out session with
// opening float, expected, declared, variance, and full movement breakdown.
// Groups by drawer, then by session within the selected period.

import { useEffect, useState, useMemo } from 'react';
import { useStore } from '../../../store';
import { supabase, isMock, getLocationId } from '../../../lib/supabase';
import { StatTile, EmptyState, ExportBtn } from './_charts';
import { toCsv, downloadCsv } from './_csv';
import { money } from '../../../lib/currency';  // v5.5.326: multi-currency

const TYPE_META = {
  float_in:           { label: 'Opening float',    sign: +1, color: 'var(--acc)' },
  cash_sale:          { label: 'Cash sale',        sign: +1, color: 'var(--grn)' },
  adjustment:         { label: 'Adjustment',       sign: +1, color: 'var(--acc)' },
  downlift_from_safe: { label: 'From safe',        sign: +1, color: 'var(--acc)' },
  cash_drop:          { label: 'Cash drop',        sign: -1, color: 'var(--amb,#e8a020)' },
  drop:               { label: 'Cash drop',        sign: -1, color: 'var(--amb,#e8a020)' },
  expense:            { label: 'Expense',          sign: -1, color: 'var(--red)' },
  uplift_to_safe:     { label: 'To safe',          sign: -1, color: 'var(--amb,#e8a020)' },
  drawer_open:        { label: 'No-sale open',     sign:  0, color: 'var(--t4)' },
};

const fmt = (n) => money(n);
const fmtS = (n) => (n >= 0 ? '+' : '−') + money(Math.abs(n || 0));
const fmtTime = (ts) => new Date(ts).toLocaleString('en-GB', {
  day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit',
});
const fmtDur = (from, to) => {
  if (!to) return 'still open';
  const ms = new Date(to).getTime() - new Date(from).getTime();
  const hrs = ms / 3600000;
  if (hrs < 1) return Math.round(hrs * 60) + 'm';
  return Math.floor(hrs) + 'h ' + Math.round((hrs % 1) * 60) + 'm';
};

export default function CashDrawer({ fromMs, toMs }) {
  const drawers = useStore(s => s.cashDrawers) || [];
  const [sessions, setSessions] = useState([]);
  const [movements, setMovements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedDrawer, setSelectedDrawer] = useState('all');

  useEffect(() => {
    (async () => {
      if (isMock || !supabase) { setLoading(false); return; }
      try {
        setLoading(true);
        const locId = await getLocationId();
        if (!locId) return;
        const fromISO = new Date(fromMs).toISOString();
        const toISO = new Date(toMs).toISOString();
        // Sessions that either opened OR closed within the window
        const { data: s } = await supabase
          .from('drawer_sessions')
          .select('*')
          .eq('location_id', locId)
          .gte('cash_in_at', fromISO)
          .lte('cash_in_at', toISO)
          .order('cash_in_at', { ascending: false });
        setSessions(s || []);
        // All movements in the same window, we'll attach by session_id
        const { data: m } = await supabase
          .from('cash_movements')
          .select('*')
          .eq('location_id', locId)
          .gte('timestamp', fromISO)
          .lte('timestamp', toISO)
          .order('timestamp', { ascending: true });
        setMovements(m || []);
      } catch (err) {
        console.warn('[CashDrawer report] failed:', err?.message || err);
      } finally {
        setLoading(false);
      }
    })();
  }, [fromMs, toMs]);

  // Attach movements to sessions, compute per-session totals
  const rows = useMemo(() => {
    const bySession = {};
    (movements || []).forEach(m => {
      if (!m.session_id) return;
      if (!bySession[m.session_id]) bySession[m.session_id] = [];
      bySession[m.session_id].push(m);
    });
    return (sessions || []).map(s => {
      const ms = bySession[s.id] || [];
      const byType = {};
      ms.forEach(m => {
        if (!byType[m.type]) byType[m.type] = { count: 0, amount: 0 };
        byType[m.type].count++;
        byType[m.type].amount += Number(m.amount) || 0;
      });
      const drawer = drawers.find(d => d.id === s.drawer_id);
      return {
        ...s,
        drawer,
        drawerName: drawer?.name || s.drawer_id,
        movements: ms,
        byType,
        cashSales:  byType.cash_sale?.amount   || 0,
        drops:      (byType.cash_drop?.amount || byType.drop?.amount || 0),
        expenses:   byType.expense?.amount     || 0,
        openingFloat: Number(s.opening_float) || 0,
        // Computed expected (from movements, same formula as cashOutDrawer)
        computedExpected: ms.reduce((sum, m) => {
          const meta = TYPE_META[m.type];
          if (!meta) return sum;
          return sum + meta.sign * (Number(m.amount) || 0);
        }, 0),
      };
    });
  }, [sessions, movements, drawers]);

  const filtered = useMemo(() => {
    if (selectedDrawer === 'all') return rows;
    return rows.filter(r => r.drawer_id === selectedDrawer);
  }, [rows, selectedDrawer]);

  // Rollup across all filtered sessions
  const roll = useMemo(() => {
    const r = { sessions: filtered.length, cashSales: 0, floats: 0, drops: 0, expenses: 0, variance: 0, closed: 0, open: 0 };
    filtered.forEach(row => {
      r.cashSales += row.cashSales;
      r.floats    += row.openingFloat;
      r.drops     += row.drops;
      r.expenses  += row.expenses;
      if (row.status === 'closed') {
        r.closed++;
        r.variance += Number(row.variance) || 0;
      } else {
        r.open++;
      }
    });
    return r;
  }, [filtered]);

  const onExport = () => {
    const cols = [
      { label:'Drawer',           key: r => r.drawerName },
      { label:'Opened',           key: r => fmtTime(r.cash_in_at) },
      { label:'Closed',           key: r => r.cash_out_at ? fmtTime(r.cash_out_at) : '—' },
      { label:'Duration',         key: r => fmtDur(r.cash_in_at, r.cash_out_at) },
      { label:'Opening float',    key: r => r.openingFloat.toFixed(2) },
      { label:'Cash sales',       key: r => r.cashSales.toFixed(2) },
      { label:'Drops',            key: r => r.drops.toFixed(2) },
      { label:'Expenses',         key: r => r.expenses.toFixed(2) },
      { label:'Expected',         key: r => (r.expected_cash != null ? Number(r.expected_cash) : r.computedExpected).toFixed(2) },
      { label:'Declared',         key: r => r.declared_cash != null ? Number(r.declared_cash).toFixed(2) : '' },
      { label:'Variance',         key: r => r.variance != null ? Number(r.variance).toFixed(2) : '' },
      { label:'Status',           key: r => r.status },
      { label:'Notes',            key: r => r.notes || '' },
    ];
    const csv = toCsv(filtered, cols);
    downloadCsv(`cash-drawer-${new Date().toISOString().slice(0,10)}.csv`, csv);
  };

  if (loading) {
    return <div style={{ padding:'40px 20px', textAlign:'center', color:'var(--t4)' }}>Loading drawer sessions…</div>;
  }
  if (filtered.length === 0) {
    return <EmptyState icon="💰" message="No drawer sessions in this period. Cash in a drawer from Back Office > Cash drawers to start recording."/>;
  }

  return (
    <div>
      {/* Top controls */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12, gap:10 }}>
        <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
          <FilterChip label="All drawers" active={selectedDrawer === 'all'} onClick={() => setSelectedDrawer('all')}/>
          {drawers.map(d => (
            <FilterChip key={d.id} label={d.name} active={selectedDrawer === d.id} onClick={() => setSelectedDrawer(d.id)}/>
          ))}
        </div>
        <ExportBtn onClick={onExport}/>
      </div>

      {/* Rollup stats */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(150px, 1fr))', gap:10, marginBottom:16 }}>
        <StatTile label="Sessions"    value={roll.sessions}                sub={`${roll.closed} closed · ${roll.open} open`} color="var(--t1)"/>
        <StatTile label="Cash sales"  value={fmt(roll.cashSales)}          color="var(--grn)"/>
        <StatTile label="Floats"      value={fmt(roll.floats)}             color="var(--acc)"/>
        <StatTile label="Drops"       value={fmt(roll.drops)}              color="var(--amb,#e8a020)"/>
        <StatTile label="Expenses"    value={fmt(roll.expenses)}           color="var(--red)"/>
        <StatTile label="Net variance"
          value={Math.abs(roll.variance) < 0.01 ? '✓ Balanced' : fmtS(roll.variance)}
          color={Math.abs(roll.variance) < 0.01 ? 'var(--grn)' : roll.variance > 0 ? 'var(--acc)' : 'var(--red)'}/>
      </div>

      {/* Session cards */}
      <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
        {filtered.map(row => <SessionCard key={row.id} row={row}/>)}
      </div>
    </div>
  );
}

function FilterChip({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding:'5px 11px', fontSize:12, borderRadius:6, fontFamily:'inherit', cursor:'pointer', fontWeight:600,
      background: active ? 'var(--acc-d)' : 'var(--bg3)',
      border: `1px solid ${active ? 'var(--acc)' : 'var(--bdr)'}`,
      color: active ? 'var(--acc)' : 'var(--t3)',
    }}>{label}</button>
  );
}

function SessionCard({ row }) {
  const [expanded, setExpanded] = useState(false);
  const isClosed = row.status === 'closed';
  const variance = Number(row.variance) || 0;
  const varBalanced = isClosed && Math.abs(variance) < 0.01;

  const expected = row.expected_cash != null ? Number(row.expected_cash) : row.computedExpected;
  const declared = row.declared_cash != null ? Number(row.declared_cash) : null;

  return (
    <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'hidden' }}>
      {/* Header */}
      <div onClick={() => setExpanded(x => !x)}
        style={{ padding:'14px 16px', cursor:'pointer', display:'grid', gridTemplateColumns:'1fr auto', gap:10, alignItems:'center' }}>
        <div>
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:4 }}>
            <span style={{ fontSize:15, fontWeight:800, color:'var(--t1)' }}>{row.drawerName}</span>
            <StatusBadge status={row.status}/>
          </div>
          <div style={{ fontSize:11, color:'var(--t3)' }}>
            {fmtTime(row.cash_in_at)} → {row.cash_out_at ? fmtTime(row.cash_out_at) : 'still open'}
            {' · '}{fmtDur(row.cash_in_at, row.cash_out_at)}
            {row.movements.length ? ` · ${row.movements.length} movements` : ''}
          </div>
        </div>
        <div style={{ textAlign:'right' }}>
          {isClosed ? (
            <>
              <div style={{ fontSize:15, fontWeight:800, fontFamily:'var(--font-mono)',
                            color: varBalanced ? 'var(--grn)' : variance > 0 ? 'var(--acc)' : 'var(--red)' }}>
                {varBalanced ? '✓ Balanced' : fmtS(variance)}
              </div>
              <div style={{ fontSize:11, color:'var(--t4)', fontFamily:'var(--font-mono)', marginTop:2 }}>
                {fmt(declared)} vs {fmt(expected)}
              </div>
            </>
          ) : (
            <div style={{ fontSize:13, color:'var(--t3)', fontFamily:'var(--font-mono)' }}>
              Running: {fmt(expected)}
            </div>
          )}
        </div>
      </div>

      {/* Breakdown */}
      {expanded && (
        <div style={{ borderTop:'1px solid var(--bdr)', padding:'12px 16px', background:'var(--bg2)' }}>
          {/* Summary rows */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(110px, 1fr))', gap:8, marginBottom:14 }}>
            <MiniStat label="Opening float" value={fmt(row.openingFloat)}/>
            <MiniStat label="Cash sales"    value={fmt(row.cashSales)} color="var(--grn)"/>
            {row.drops > 0    && <MiniStat label="Drops"    value={fmt(row.drops)}    color="var(--amb,#e8a020)"/>}
            {row.expenses > 0 && <MiniStat label="Expenses" value={fmt(row.expenses)} color="var(--red)"/>}
            <MiniStat label="Expected" value={fmt(expected)} color="var(--t1)"/>
            {isClosed && <MiniStat label="Declared" value={fmt(declared)} color="var(--t1)"/>}
          </div>

          {/* Movement log */}
          {row.movements.length === 0 ? (
            <div style={{ fontSize:11, color:'var(--t4)', fontStyle:'italic' }}>No movements recorded.</div>
          ) : (
            <div>
              <div style={{ fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:6 }}>Movements</div>
              {row.movements.map(m => {
                const meta = TYPE_META[m.type] || { label: m.type, sign: 0, color: 'var(--t3)' };
                return (
                  <div key={m.id} style={{ display:'grid', gridTemplateColumns:'90px 1fr auto', gap:10, padding:'3px 0', fontSize:12, alignItems:'baseline' }}>
                    <span style={{ color:'var(--t4)', fontFamily:'var(--font-mono)' }}>{new Date(m.timestamp).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' })}</span>
                    <span style={{ color: meta.color, fontWeight:600 }}>
                      {meta.label}
                      {m.reason && <span style={{ color:'var(--t4)', fontWeight:400, marginLeft:6 }}>· {m.reason}</span>}
                    </span>
                    <span style={{ color: meta.color, fontFamily:'var(--font-mono)', fontWeight:700 }}>
                      {meta.sign === 0 ? '—' : fmtS(meta.sign * (Number(m.amount) || 0))}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {row.notes && (
            <div style={{ marginTop:12, padding:'8px 10px', background:'var(--bg3)', borderRadius:6, fontSize:12, color:'var(--t3)' }}>
              <span style={{ color:'var(--t4)', fontWeight:700 }}>Notes: </span>{row.notes}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    open:    { bg:'var(--grn-d)', color:'var(--grn)', label:'Open' },
    closing: { bg:'rgba(232,160,32,.12)', color:'var(--amb,#e8a020)', label:'Closing' },
    closed:  { bg:'var(--bg3)', color:'var(--t3)', label:'Closed' },
  };
  const m = map[status] || map.closed;
  return (
    <span style={{ fontSize:10, fontWeight:800, padding:'2px 8px', borderRadius:5, background:m.bg, color:m.color, textTransform:'uppercase', letterSpacing:'.07em' }}>
      {m.label}
    </span>
  );
}

function MiniStat({ label, value, color = 'var(--t2)' }) {
  return (
    <div>
      <div style={{ fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em' }}>{label}</div>
      <div style={{ fontSize:13, fontWeight:700, color, fontFamily:'var(--font-mono)', marginTop:2 }}>{value}</div>
    </div>
  );
}
