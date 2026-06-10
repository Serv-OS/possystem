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

import { useMemo, useState, useEffect, useRef } from 'react';
import { useStore } from '../../../store';
import { StatTile, ExportBtn, EmptyState, HourBar, BarRow } from './_charts';
import { toCsv, downloadCsv } from './_csv';
import { currencySymbol } from '../../../lib/currency';
import { loadSettings, saveSettings } from '../../../staff/wfData';
import { getLocationId } from '../../../lib/supabase';

// The LIVE tipping policy (Workforce settings) ↔ this calculator's modes.
// One rule set, two vocabularies — keep them mapped so the report can never
// silently disagree with what payroll actually pays.
const POLICY_TO_MODE = { pool: 'shared', direct: 'none', hybrid: 'tipout' };
const MODE_TO_POLICY = { shared: 'pool', none: 'direct', tipout: 'hybrid' };

// Aggregate checks to per-server tip stats + hours derivation.
// Groups by server NAME (since that's the field that's always present on historical
// rows). Also captures the first staffId seen for that server so pool role lookup
// can prefer FK match (v4.6.19) and fall back to name match for legacy rows.
// v5.5.335/336: kiosk, online + QR orders are customer-self-ordered — there's no
// single server who earned the tip — so their tips must NOT be parked under a
// phantom "server" who then keeps/excludes them. They go into a "house" bucket
// that always feeds the pool (contributes 100%, never receives).
const HOUSE_SOURCES = new Set(['kiosk', 'online', 'qr']);

function serverTips(checks) {
  const map = {};
  const house = { tipsCash: 0, tipsCard: 0, tipCount: 0, revenue: 0, checkCount: 0 };
  checks.filter(c => c.status !== 'voided').forEach(c => {
    const tip = c.tip || 0;
    const isCash = (c.method || '').toLowerCase() === 'cash';
    // Unattended source → house bucket, not a server row.
    if (HOUSE_SOURCES.has((c.source || 'pos').toLowerCase())) {
      if (isCash) house.tipsCash += tip; else house.tipsCard += tip;
      if (tip > 0) house.tipCount += 1;
      house.revenue += c.total || 0;
      house.checkCount += 1;
      return;
    }
    const s = c.server || c.staff || 'Unknown';
    if (!map[s]) map[s] = { server: s, staffId: c.staffId || null, tipsCash: 0, tipsCard: 0, tipCount: 0, revenue: 0, checkCount: 0, byDay: {} };
    if (!map[s].staffId && c.staffId) map[s].staffId = c.staffId;
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
  const servers = Object.values(map).map(r => ({
    ...r,
    tips: r.tipsCash + r.tipsCard,
    hoursMs: Object.values(r.byDay).reduce((s, d) => s + Math.max(0, d.last - d.first), 0),
    byDay: undefined,
  })).sort((a, b) => b.tips - a.tips);
  return { servers, house: { ...house, tips: house.tipsCash + house.tipsCard } };
}

function formatHours(ms) {
  if (!ms || ms < 60000) return '—';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const POOL_MODES = [
  { id:'none',   label:'No pooling',  blurb:'Everyone keeps the tips they collected.' },
  { id:'tipout', label:'Tip-out',     blurb:'Tipped staff give a % of their tips to a support pool.' },
  { id:'shared', label:'Shared pool', blurb:'Pooled roles combine all their tips and split by hours worked.' },
];

export default function Tips({ checks, fmt, fmtN }) {
  const { staffMembers = [] } = useStore();

  const { servers, house } = useMemo(() => serverTips(checks), [checks]);

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
    // v5.5.335: include house (kiosk/online) tips in the headline totals.
    const cashTips = servers.reduce((s, r) => s + r.tipsCash, 0) + house.tipsCash;
    const cardTips = servers.reduce((s, r) => s + r.tipsCard, 0) + house.tipsCard;
    const revenue  = servers.reduce((s, r) => s + r.revenue, 0) + house.revenue;
    const byHour = Array(24).fill(0);
    checks.filter(c => c.status !== 'voided' && c.closedAt).forEach(c => {
      const h = new Date(c.closedAt).getHours();
      byHour[h] += c.tip || 0;
    });
    return { cashTips, cardTips, total: cashTips + cardTips, revenue, byHour };
  }, [servers, house, checks]);

  // -------- Pool state --------
  const [mode, setMode]            = useState('none');
  const [tipoutPct, setTipoutPct]  = useState(3.0);  // % of tips contributed (tip-out mode)
  const [byHours, setByHours]      = useState(true); // distribute pool by hours (vs equally)

  // -------- Live tipping policy (Workforce settings) --------
  // The calculator OPENS on the live policy so this report shows what payroll
  // will actually pay. Changing the controls is an explicit what-if (banner
  // appears); "Set as live policy" writes the rule back to settings.
  const [venue, setVenue] = useState(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const seededFromLive = useRef(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const locId = await getLocationId();
        const s = await loadSettings(locId);
        if (!alive || !s) return;
        setVenue({ ...s, _locId: locId });
        if (!seededFromLive.current) {
          seededFromLive.current = true;
          const sj = s.settings || {};
          const liveMode = POLICY_TO_MODE[sj.tipMode] || 'shared';
          setMode(liveMode);
          if (liveMode === 'tipout') setTipoutPct(Math.min(100, Math.max(0, 100 - (Number(sj.directPct) || 0))));
        }
      } catch { /* report still works without settings */ }
    })();
    return () => { alive = false; };
  }, []);

  const livePolicy = useMemo(() => {
    const sj = venue?.settings || {};
    const liveMode = POLICY_TO_MODE[sj.tipMode] || 'shared';
    const liveTipout = liveMode === 'tipout' ? Math.min(100, Math.max(0, 100 - (Number(sj.directPct) || 0))) : null;
    return { mode: liveMode, tipout: liveTipout };
  }, [venue]);
  const matchesLive = venue != null && mode === livePolicy.mode && (mode !== 'tipout' || Math.abs(tipoutPct - (livePolicy.tipout ?? 0)) < 0.05);

  async function makeLivePolicy() {
    if (!venue) return;
    setSavingPolicy(true);
    try {
      const patch = {
        ...venue,
        settings: {
          ...(venue.settings || {}),
          tipMode: MODE_TO_POLICY[mode] || 'pool',
          ...(mode === 'tipout' ? { directPct: Math.round(100 - tipoutPct) } : {}),
        },
      };
      const saved = await saveSettings(patch, venue._locId, null);
      setVenue({ ...(saved || patch), _locId: venue._locId });
    } catch { /* leave banner showing */ }
    finally { setSavingPolicy(false); }
  }
  // Tip-out: contributingRoles give a %, receivingRoles get the pool.
  // Shared:  contributingRoles ARE the pool (contribute 100% + share it back by hours).
  // A role in NEITHER set (e.g. Manager by default) is excluded and keeps the
  // tips it personally collected — never draws from the pool. Managers are
  // off by default but can be ticked (US FLSA: managers/supervisors generally
  // can't receive pooled tips).
  const [contributingRoles, setContributingRoles] = useState(() => new Set(['Server','Bartender']));
  const [receivingRoles, setReceivingRoles]       = useState(() => new Set(['Kitchen','Cashier']));

  const toggleRole = (which, role) => {
    const setter = which === 'contrib' ? setContributingRoles : setReceivingRoles;
    setter(prev => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role); else next.add(role);
      return next;
    });
  };

  // Pool calculation.
  // Unified model for both modes: contributors put a fraction of their tips into
  // a pool (tip-out = tipoutPct%, shared = 100%), then it's paid out to the
  // receiving set by hours (or equally). Anyone in NEITHER set is excluded and
  // keeps their own tips (net = gross) — that's how a manager keeps tips they
  // personally collected without ever drawing from the pool.
  const distribution = useMemo(() => {
    const rows = servers.map(r => ({
      server: r.server,
      role: (r.staffId && roleById[r.staffId]) || roleByName[r.server] || 'Unknown',
      hoursMs: r.hoursMs,
      gross: r.tips,
      contribution: 0,
      received: 0,
      net: r.tips,
      inPool: false,
      isHouse: false,
    }));
    // v5.5.335: kiosk/online tips have no server — a House row always feeds the
    // pool (contributes 100%, never receives) so those tips reach real staff.
    if (house.tips > 0) {
      rows.push({ server: 'Kiosk, online & QR', role: 'House', hoursMs: 0, gross: house.tips, contribution: 0, received: 0, net: house.tips, inPool: false, isHouse: true });
    }

    if (mode === 'tipout' || mode === 'shared') {
      const rate = mode === 'shared' ? 1 : Math.max(0, tipoutPct / 100);
      const contributes = r => contributingRoles.has(r.role);
      // Shared pays back to the pooled roles themselves; tip-out pays the support set.
      const receives = r => (mode === 'shared' ? contributingRoles : receivingRoles).has(r.role);

      let pool = 0;
      rows.forEach(r => {
        if (r.isHouse) {
          // Unattended tips always go 100% into the pool — nobody earned them.
          r.contribution = r.gross;
          r.net = 0;
          r.inPool = true;
          pool += r.contribution;
        } else if (contributes(r)) {
          r.contribution = +(r.gross * rate).toFixed(2);
          r.net = +(r.net - r.contribution).toFixed(2);
          r.inPool = true;
          pool += r.contribution;
        }
      });
      pool = +pool.toFixed(2);

      const recipients = rows.filter(r => !r.isHouse && receives(r));
      recipients.forEach(r => { r.inPool = true; });
      if (recipients.length > 0 && pool > 0) {
        const totalHours = recipients.reduce((s, r) => s + r.hoursMs, 0);
        const useHours = byHours && totalHours > 0;
        recipients.forEach(r => {
          r.received = useHours ? +(pool * (r.hoursMs / totalHours)).toFixed(2) : +(pool / recipients.length).toFixed(2);
          r.net = +(r.net + r.received).toFixed(2);
        });
      }
    }

    return { rows, pool: +rows.reduce((s, r) => s + r.contribution, 0).toFixed(2) };
  }, [servers, house, roleById, roleByName, mode, tipoutPct, byHours, contributingRoles, receivingRoles]);

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

  if (servers.length === 0 && house.tips === 0) return <EmptyState icon="🙏" message="No tips captured in this period."/>;

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
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:10, gap:10, flexWrap:'wrap' }}>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em' }}>Tip pool calculator</div>
            {venue != null && matchesLive && (
              <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:999, background:'var(--grn-d)', border:'1px solid var(--grn-b)', color:'var(--grn)' }}>LIVE POLICY</span>
            )}
          </div>
          <div style={{ fontSize:11, color:'var(--t4)' }}>{POOL_MODES.find(m => m.id === mode).blurb}</div>
        </div>

        {venue != null && !matchesLive && (
          <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', padding:'8px 12px', borderRadius:8, background:'rgba(245,166,35,.10)', border:'1px solid var(--amber)', marginBottom:12 }}>
            <span style={{ fontSize:12, color:'var(--t2)', flex:1, minWidth:220 }}>
              <b>What-if preview</b> — your live policy is “{POOL_MODES.find(m => m.id === livePolicy.mode)?.label}{livePolicy.tipout != null ? ` ${livePolicy.tipout}%` : ''}”, and Payroll keeps using it until you change it.
            </span>
            <button onClick={() => { setMode(livePolicy.mode); if (livePolicy.tipout != null) setTipoutPct(livePolicy.tipout); }} style={{ padding:'5px 12px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg3)', color:'var(--t2)', fontSize:11.5, fontWeight:600, cursor:'pointer', fontFamily:'inherit' }}>Back to live</button>
            <button onClick={makeLivePolicy} disabled={savingPolicy} style={{ padding:'5px 12px', borderRadius:8, border:'1px solid var(--acc-b)', background:'var(--acc-d)', color:'var(--acc)', fontSize:11.5, fontWeight:700, cursor:'pointer', fontFamily:'inherit' }}>{savingPolicy ? 'Saving…' : 'Set as live policy'}</button>
          </div>
        )}

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
                <input type="range" min="0" max="60" step="0.5" value={tipoutPct} onChange={e => setTipoutPct(parseFloat(e.target.value))} style={{ flex:1 }}/>
                <span style={{ fontSize:13, fontFamily:'var(--font-mono)', fontWeight:700, color:'var(--acc)', minWidth:46, textAlign:'right' }}>{tipoutPct.toFixed(1)}%</span>
              </div>
              <div style={{ fontSize:10, color:'var(--t4)', marginTop:4 }}>of each tipped-out person's tips goes to the pool</div>
            </div>
            <RoleCheckboxes label="Who tips out" selected={contributingRoles} roles={allRoles} onToggle={r => toggleRole('contrib', r)}/>
            <RoleCheckboxes label="Who receives" selected={receivingRoles} roles={allRoles} onToggle={r => toggleRole('receive', r)}/>
          </div>
        )}

        {mode === 'shared' && (
          <div style={{ marginBottom:12 }}>
            <RoleCheckboxes label="Roles in the pool — contribute all tips, share back by hours" selected={contributingRoles} roles={allRoles} onToggle={r => toggleRole('contrib', r)}/>
          </div>
        )}

        {(mode === 'tipout' || mode === 'shared') && (
          <>
            <div style={{ marginBottom:8 }}>
              <label style={{ display:'inline-flex', alignItems:'center', gap:8, fontSize:12, color:'var(--t2)', cursor:'pointer' }}>
                <input type="checkbox" checked={byHours} onChange={e => setByHours(e.target.checked)}/>
                Distribute pool by hours worked {byHours ? '(weighted)' : '(split equally)'}
              </label>
            </div>
            <div style={{ marginBottom:10, fontSize:11, color:'var(--t4)', lineHeight:1.6 }}>
              ⚖️ Managers are excluded by default — under US tip law (FLSA) managers and supervisors generally can't receive pooled tips. Only tick a manager role for a genuinely tip-eligible working supervisor. Anyone left out of the pool keeps the tips they personally collected.
            </div>
          </>
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
          {distribution.rows.map((r, i) => {
            const excluded = mode !== 'none' && !r.inPool;
            return (
            <div key={r.server} style={{ display:'grid', gridTemplateColumns:'1.3fr 90px 70px 90px 90px 90px 100px', padding:'9px 12px', borderBottom: i === distribution.rows.length - 1 ? 'none' : '1px solid var(--bdr)', fontSize:12, alignItems:'center', gap:8, opacity: excluded ? 0.5 : 1 }}>
              <span style={{ color:'var(--t1)', fontWeight:600 }}>{r.server}</span>
              <span style={{ color:'var(--t3)', fontSize:11 }}>{r.role}{excluded ? ' · not in pool' : ''}</span>
              <span style={{ textAlign:'right', color:'var(--t3)', fontFamily:'var(--font-mono)' }}>{formatHours(r.hoursMs)}</span>
              <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{fmt(r.gross)}</span>
              <span style={{ textAlign:'right', color: r.contribution > 0 ? 'var(--red)' : 'var(--t4)', fontFamily:'var(--font-mono)' }}>{r.contribution > 0 ? `−${fmt(r.contribution)}` : '—'}</span>
              <span style={{ textAlign:'right', color: r.received > 0 ? 'var(--grn)' : 'var(--t4)', fontFamily:'var(--font-mono)' }}>{r.received > 0 ? `+${fmt(r.received)}` : '—'}</span>
              <span style={{ textAlign:'right', color:'var(--acc)', fontFamily:'var(--font-mono)', fontWeight:700 }}>{fmt(r.net)}</span>
            </div>
          );})}
          {mode !== 'none' && (
            <div style={{ padding:'8px 12px', background:'var(--bg3)', fontSize:11, color:'var(--t4)', textAlign:'right' }}>
              Pool total: <strong style={{ color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{fmt(distribution.pool)}</strong>
            </div>
          )}
        </div>

        {mode !== 'none' && (
          <div style={{ marginTop:10, padding:'9px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)', lineHeight:1.7 }}>
            ⓘ Pool math is a preview — export CSV to hand to payroll. Roles come from Staff manager; unrecognised names show "Unknown" and are treated as non-participants. Kiosk, online &amp; QR tips have no single server, so they always flow 100% into the pool.
            <br/><br/>🇬🇧 For the official <strong style={{ color:'var(--t2)' }}>weekly tronc payout</strong> (UK Tipping Act — split by published-shift hours × role points, reconciled to the penny, recorded and audited), use <strong style={{ color:'var(--t2)' }}>Workforce → Tronc</strong>. It pulls this same pool automatically (card tips + service charge for the week), so this report and the payout always agree.
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
        {/* v5.5.335: unattended (kiosk/online) tips — shown so totals reconcile */}
        {house.tips > 0 && (() => {
          const cashPct = house.tips ? (house.tipsCash / house.tips) * 100 : 0;
          return (
            <div style={{ display:'grid', gridTemplateColumns:'1.3fr 90px 90px 90px 70px 1fr', padding:'10px 14px', borderTop:'1px solid var(--bdr)', fontSize:12, alignItems:'center', gap:8, background:'var(--bg2)' }}>
              <span style={{ color:'var(--t2)', fontWeight:600 }}>Kiosk, online &amp; QR <span style={{ fontSize:10, color:'var(--t4)', fontWeight:600 }}>· auto-pooled</span></span>
              <span style={{ textAlign:'right', color:'#3b82f6', fontFamily:'var(--font-mono)' }}>{fmt(house.tipsCard)}</span>
              <span style={{ textAlign:'right', color:'var(--grn)', fontFamily:'var(--font-mono)' }}>{fmt(house.tipsCash)}</span>
              <span style={{ textAlign:'right', color:'var(--t1)', fontFamily:'var(--font-mono)', fontWeight:700 }}>{fmt(house.tips)}</span>
              <span style={{ textAlign:'right', color:'var(--t4)', fontFamily:'var(--font-mono)' }}>—</span>
              <div style={{ display:'flex', height:8, borderRadius:4, overflow:'hidden', background:'var(--bg3)' }}>
                <div style={{ width:`${100 - cashPct}%`, background:'#3b82f6' }}/>
                <div style={{ width:`${cashPct}%`, background:'var(--grn)' }}/>
              </div>
            </div>
          );
        })()}
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
