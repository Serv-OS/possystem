// v4.6.18: Tips report with embedded tip pool calculator (US-market feature).
//
// Three sections:
//   1. Summary tiles — total tips, tip %, cash vs card tip split, hourly peak
//   2. Per-server tips table — gross tips, % of revenue, tip count
//   3. Tip pool calculator — interactive, three modes:
//        - None:   raw tips per person
//        - Tip-out: servers contribute X% of their tips to a shared support pool;
//                   pool distributed equally (or by hours) to support staff (non-server roles)
//        - Shared: all tips pooled and distributed by hours worked, weighted by role
//
// Roles come from staffMembers (already captured — Manager/Server/Bartender/Cashier/Kitchen).
// Hours are derived from shift session (first-check-to-last-check per day, summed).
// Export CSV for payroll with net tips per person.

import { useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { StatTile, ExportBtn, EmptyState, HourBar, BarRow } from './_charts';
import { toCsv, downloadCsv } from './_csv';
import { currencySymbol } from '../../../lib/currency';

// Aggregate checks to per-server tip stats + hours derivation.
// Groups by server NAME (since that's the field that's always present on historical
// rows). Also captures the first staffId seen for that server so pool role lookup
// can prefer FK match (v4.6.19) and fall back to name match for legacy rows.
function serverTips(checks) {
  const map = {};
  checks.filter(c => c.status !== 'voided').forEach(c => {
    const s = c.server || c.staff || 'Unknown';
    if (!map[s]) map[s] = { server: s, staffId: c.staffId || null, tipsCash: 0, tipsCard: 0, tipCount: 0, revenue: 0, checkCount: 0, byDay: {} };
    if (!map[s].staffId && c.staffId) map[s].staffId = c.staffId;
    const tip = c.tip || 0;
    const isCash = (c.method || '').toLowerCase() === 'cash';
    if (isCash) map[s].tipsCash += tip;
    else        map[s].tipsCard += tip;
    if (tip > 0) map[s].tipCount += 1;
    map[s].revenue    += c.total || 0;
    map[s].checkCount += 1;
    if (c.closedAt) {
      const d = new Date(c.closedAt);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!map[s].byDay[key]) map[s].byDay[key] = { first: c.closedAt, last: c.closedAt };
      if (c.closedAt < map[s].byDay[key].first) map[s].byDay[key].first = c.closedAt;
      if (c.closedAt > map[s].byDay[key].last)  map[s].byDay[key].last  = c.closedAt;
    }
  });
  return Object.values(map).map(r => ({
    ...r,
    tips: r.tipsCash + r.tipsCard,
    hoursMs: Object.values(r.byDay).reduce((s, d) => s + Math.max(0, d.last - d.first), 0),
    byDay: undefined,
  })).sort((a, b) => b.tips - a.tips);
}

function formatHours(ms) {
  if (!ms || ms < 60000) return '—';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const POOL_MODES = [
  { id:'none',   label:'No pooling',  blurb:'Show raw tips per server.' },
  { id:'tipout', label:'Server tip-out', blurb:'Servers contribute a % of tips to support.' },
  { id:'shared', label:'Shared pool',  blurb:'All tips pooled, split by hours worked.' },
];

export default function Tips({ checks, fmt, fmtN }) {
  const { staffMembers = [] } = useStore();

  const servers = useMemo(() => serverTips(checks), [checks]);

  // Role lookup: prefer staff_id FK match (v4.6.19), fall back to name match
  // for legacy checks closed before the schema hardening.
  const { roleById, roleByName } = useMemo(() => {
    const byId = {}, byName = {};
    staffMembers.forEach(s => {
      if (s.id)   byId[s.id]     = s.role;
      if (s.name) byName[s.name] = s.role;
    });
    return { roleById: byId, roleByName: byName };
  }, [staffMembers]);

  // Totals + hourly distribution
  const headline = useMemo(() => {
    const cashTips = servers.reduce((s, r) => s + r.tipsCash, 0);
    const cardTips = servers.reduce((s, r) => s + r.tipsCard, 0);
    const revenue  = servers.reduce((s, r) => s + r.revenue, 0);
    const byHour = Array(24).fill(0);
    checks.filter(c => c.status !== 'voided' && c.closedAt).forEach(c => {
      const h = new Date(c.closedAt).getHours();
      byHour[h] += c.tip || 0;
    });
    return { cashTips, cardTips, total: cashTips + cardTips, revenue, byHour };
  }, [servers, checks]);

  // -------- Pool state --------
  const [mode, setMode]            = useState('none');
  const [tipoutPct, setTipoutPct]  = useState(3.0);  // % of server tips contributed
  const [byHours, setByHours]      = useState(true); // distribute pool by hours (vs equally)
  const [serverRoles, setServerRoles] = useState(() => new Set(['Server','Bartender']));
  const [supportRoles, setSupportRoles] = useState(() => new Set(['Kitchen','Cashier']));

  const toggleRole = (which, role) => {
    const setter = which === 'server' ? setServerRoles : setSupportRoles;
    setter(prev => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role); else next.add(role);
      return next;
    });
  };

  // Pool calculation
  const distribution = useMemo(() => {
    // Default: each person keeps their own tips
    const rows = servers.map(r => ({
      server: r.server,
      role: (r.staffId && roleById[r.staffId]) || roleByName[r.server] || 'Unknown',
      hoursMs: r.hoursMs,
      gross: r.tips,
      contribution: 0,
      received: 0,
      net: r.tips,
    }));

    if (mode === 'tipout') {
      // Servers contribute tipoutPct% of their tips to a pool, pool goes to support staff
      const pool = rows.reduce((s, r) => {
        if (serverRoles.has(r.role)) {
          const contrib = r.gross * (tipoutPct / 100);
          r.contribution = contrib;
          r.net -= contrib;
          return s + contrib;
        }
        return s;
      }, 0);
      const recipients = rows.filter(r => supportRoles.has(r.role));
      if (recipients.length > 0 && pool > 0) {
        if (byHours) {
          const totalHours = recipients.reduce((s, r) => s + r.hoursMs, 0);
          if (totalHours > 0) recipients.forEach(r => { r.received = pool * (r.hoursMs / totalHours); r.net += r.received; });
          else recipients.forEach(r => { r.received = pool / recipients.length; r.net += r.received; });
        } else {
          recipients.forEach(r => { r.received = pool / recipients.length; r.net += r.received; });
        }
      }
    } else if (mode === 'shared') {
      // All tips pool together, distribute by hours (all rows, not just recipients)
      const pool = rows.reduce((s, r) => { r.contribution = r.gross; return s + r.gross; }, 0);
      const totalHours = rows.reduce((s, r) => s + r.hoursMs, 0);
      if (pool > 0) {
        if (byHours && totalHours > 0) {
          rows.forEach(r => { r.received = pool * (r.hoursMs / totalHours); r.net = r.received - r.contribution + r.gross - r.contribution + r.received; });
          // simpler: gross goes to pool, they receive distribution. net = received.
          rows.forEach(r => { r.net = r.received; });
        } else {
          rows.forEach(r => { r.received = pool / rows.length; r.net = r.received; });
        }
      }
    }

    return { rows, pool: rows.reduce((s, r) => s + r.contribution, 0) };
  }, [servers, roleById, roleByName, mode, tipoutPct, byHours, serverRoles, supportRoles]);

  const onExport = () => {
    const csv = toCsv(distribution.rows, [
      { label:'Server',       key:'server' },
      { label:'Role',         key:'role' },
      { label:'Hours',        key: r => formatHours(r.hoursMs) },
      { label:'Gross tips',   key: r => r.gross.toFixed(2) },
      { label:'Contribution', key: r => r.contribution.toFixed(2) },
      { label:'Received',     key: r => r.received.toFixed(2) },
      { label:'Net payout',   key: r => r.net.toFixed(2) },
      { label:'Pool mode',    key: () => POOL_MODES.find(m => m.id === mode).label },
    ]);
    downloadCsv(`tips-${mode === 'none' ? 'raw' : 'pool'}-${new Date().toISOString().slice(0,10)}.csv`, csv);
  };

  const peakHour = headline.byHour.indexOf(Math.max(...headline.byHour));
  const nowHour  = new Date().getHours();

  if (servers.length === 0) return <EmptyState icon="🙏" message="No tips captured in this period."/>;

  const allRoles = ['Manager','Server','Bartender','Cashier','Kitchen'];

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}><ExportBtn onClick={onExport}/></div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:18 }}>
        <StatTile label="Total tips"     value={fmt(headline.total)}     sub={headline.revenue ? `${((headline.total/headline.revenue)*100).toFixed(1)}% of revenue` : null} color="var(--grn)"/>
        <StatTile label="Card tips"      value={fmt(headline.cardTips)}  sub={headline.total ? `${((headline.cardTips/headline.total)*100).toFixed(0)}% of tips` : null}  color="#3b82f6"/>
        <StatTile label="Cash tips"      value={fmt(headline.cashTips)}  sub={headline.total ? `${((headline.cashTips/headline.total)*100).toFixed(0)}% of tips` : null}  color="var(--grn)"/>
        <StatTile label="Peak tip hour"  value={peakHour >= 0 ? `${peakHour}:00` : '—'} sub={fmt(Math.max(...headline.byHour))}/>
      </div>

      {/* Tip pool calculator */}
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'14px 16px', marginBottom:18 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:10 }}>
          <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em' }}>Tip pool calculator</div>
          <div style={{ fontSize:11, color:'var(--t4)' }}>{POOL_MODES.find(m => m.id === mode).blurb}</div>
        </div>

        {/* Mode pills */}
        <div style={{ display:'flex', gap:6, marginBottom:12, flexWrap:'wrap' }}>
          {POOL_MODES.map(m => (
            <button key={m.id} onClick={() => setMode(m.id)} style={{
              padding:'6px 14px', borderRadius:8,
              border:`1px solid ${mode === m.id ? 'var(--acc-b)' : 'var(--bdr)'}`,
              background: mode === m.id ? 'var(--acc-d)' : 'var(--bg3)',
              color: mode === m.id ? 'var(--acc)' : 'var(--t3)',
              fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'inherit',
            }}>{m.label}</button>
          ))}
        </div>

        {mode === 'tipout' && (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:14, marginBottom:12 }}>
            <div>
              <div style={{ fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:6 }}>Contribution rate</div>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <input type="range" min="0" max="15" step="0.5" value={tipoutPct} onChange={e => setTipoutPct(parseFloat(e.target.value))} style={{ flex:1 }}/>
                <span style={{ fontSize:13, fontFamily:'var(--font-mono)', fontWeight:700, color:'var(--acc)', minWidth:46, textAlign:'right' }}>{tipoutPct.toFixed(1)}%</span>
              </div>
              <div style={{ fontSize:10, color:'var(--t4)', marginTop:4 }}>of tipping staff's tips goes to the pool</div>
            </div>
            <RoleCheckboxes label="Contributing roles" selected={serverRoles} roles={allRoles} onToggle={r => toggleRole('server', r)}/>
            <RoleCheckboxes label="Receiving roles"    selected={supportRoles} roles={allRoles} onToggle={r => toggleRole('support', r)}/>
          </div>
        )}

        {(mode === 'tipout' || mode === 'shared') && (
          <div style={{ marginBottom:10 }}>
            <label style={{ display:'inline-flex', alignItems:'center', gap:8, fontSize:12, color:'var(--t2)', cursor:'pointer' }}>
              <input type="checkbox" checked={byHours} onChange={e => setByHours(e.target.checked)}/>
              Distribute pool by hours worked {byHours ? '(weighted)' : '(equally)'}
            </label>
          </div>
        )}

        {/* Distribution table */}
        <div style={{ background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:8, overflow:'hidden', marginTop:10 }}>
          <div style={{ display:'grid', gridTemplateColumns:'1.3fr 90px 70px 90px 90px 90px 100px', padding:'8px 12px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', letterSpacing:'.05em', textTransform:'uppercase', gap:8 }}>
            <span>Server</span>
            <span>Role</span>
            <span style={{ textAlign:'right' }}>Hours</span>
            <span style={{ textAlign:'right' }}>Gross</span>
            <span style={{ textAlign:'right' }}>Contrib</span>
            <span style={{ textAlign:'right' }}>Received</span>
            <span style={{ textAlign:'right' }}>Net payout</span>
          </div>
          {distribution.rows.map((r, i) => (
            <div key={r.server} style={{ display:'grid', gridTemplateColumns:'1.3fr 90px 70px 90px 90px 90px 100px', padding:'9px 12px', borderBottom: i === distribution.rows.length - 1 ? 'none' : '1px solid var(--bdr)', fontSize:12, alignItems:'center', gap:8 }}>
              <span style={{ color:'var(--t1)', fontWeight:600 }}>{r.server}</span>
              <span style={{ color:'var(--t3)', fontSize:11 }}>{r.role}</span>
              <span style={{ textAlign:'right', color:'var(--t3)', fontFamily:'var(--font-mono)' }}>{formatHours(r.hoursMs)}</span>
              <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{fmt(r.gross)}</span>
              <span style={{ textAlign:'right', color: r.contribution > 0 ? 'var(--red)' : 'var(--t4)', fontFamily:'var(--font-mono)' }}>{r.contribution > 0 ? `−${fmt(r.contribution)}` : '—'}</span>
              <span style={{ textAlign:'right', color: r.received > 0 ? 'var(--grn)' : 'var(--t4)', fontFamily:'var(--font-mono)' }}>{r.received > 0 ? `+${fmt(r.received)}` : '—'}</span>
              <span style={{ textAlign:'right', color:'var(--acc)', fontFamily:'var(--font-mono)', fontWeight:700 }}>{fmt(r.net)}</span>
            </div>
          ))}
          {mode !== 'none' && (
            <div style={{ padding:'8px 12px', background:'var(--bg3)', fontSize:11, color:'var(--t4)', textAlign:'right' }}>
              Pool total: <strong style={{ color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{fmt(distribution.pool)}</strong>
            </div>
          )}
        </div>

        {mode !== 'none' && (
          <div style={{ marginTop:10, padding:'9px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)', lineHeight:1.7 }}>
            ⓘ Pool math is a preview — export CSV to hand to payroll. Roles come from Staff manager; unrecognised names show "Unknown" role and are treated as non-participants.
          </div>
        )}
      </div>

      {/* Tips by hour */}
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'16px', marginBottom:14 }}>
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:14 }}>Tips by hour</div>
        <HourBar values={headline.byHour} maxLabel={v => `${currencySymbol()}${Math.round(v)}`} nowHour={nowHour}/>
      </div>

      {/* Per-server tips table */}
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'hidden' }}>
        <div style={{ padding:'10px 14px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em' }}>Tips by server (before pooling)</div>
        <div style={{ display:'grid', gridTemplateColumns:'1.3fr 90px 90px 90px 70px 1fr', padding:'8px 14px', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', letterSpacing:'.05em', textTransform:'uppercase', gap:8 }}>
          <span>Server</span>
          <span style={{ textAlign:'right' }}>Card tips</span>
          <span style={{ textAlign:'right' }}>Cash tips</span>
          <span style={{ textAlign:'right' }}>Total tips</span>
          <span style={{ textAlign:'right' }}>Tip %</span>
          <span>Split</span>
        </div>
        {servers.map((r, i) => {
          const tipPct = r.revenue ? (r.tips / r.revenue) * 100 : 0;
          const cashPct = r.tips ? (r.tipsCash / r.tips) * 100 : 0;
          return (
            <div key={r.server} style={{ display:'grid', gridTemplateColumns:'1.3fr 90px 90px 90px 70px 1fr', padding:'10px 14px', borderBottom:'1px solid var(--bdr)', fontSize:12, alignItems:'center', gap:8, background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
              <span style={{ color:'var(--t1)', fontWeight:600 }}>{r.server}</span>
              <span style={{ textAlign:'right', color:'#3b82f6', fontFamily:'var(--font-mono)' }}>{fmt(r.tipsCard)}</span>
              <span style={{ textAlign:'right', color:'var(--grn)', fontFamily:'var(--font-mono)' }}>{fmt(r.tipsCash)}</span>
              <span style={{ textAlign:'right', color:'var(--t1)', fontFamily:'var(--font-mono)', fontWeight:700 }}>{fmt(r.tips)}</span>
              <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{tipPct.toFixed(1)}%</span>
              <div style={{ display:'flex', height:8, borderRadius:4, overflow:'hidden', background:'var(--bg3)' }}>
                <div style={{ width:`${100 - cashPct}%`, background:'#3b82f6' }}/>
                <div style={{ width:`${cashPct}%`, background:'var(--grn)' }}/>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RoleCheckboxes({ label, selected, roles, onToggle }) {
  return (
    <div>
      <div style={{ fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:6 }}>{label}</div>
      <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
        {roles.map(r => (
          <label key={r} style={{
            padding:'4px 9px', borderRadius:6, cursor:'pointer',
            border:`1px solid ${selected.has(r) ? 'var(--acc-b)' : 'var(--bdr)'}`,
            background: selected.has(r) ? 'var(--acc-d)' : 'var(--bg3)',
            color:      selected.has(r) ? 'var(--acc)' : 'var(--t3)',
            fontSize:11, display:'inline-flex', alignItems:'center', gap:5,
          }}>
            <input type="checkbox" checked={selected.has(r)} onChange={() => onToggle(r)} style={{ margin:0 }}/>
            {r}
          </label>
        ))}
      </div>
    </div>
  );
}
