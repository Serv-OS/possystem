// v5.5.812: Reports catalog — two-pane redesign (design handoff "Reports Catalog").
//
// Replaces the whitespace-heavy masonry of category cards with:
//   • a persistent category rail (All / Pinned / Recent + one row per category)
//   • a prominent sticky search ("/" to focus, Esc to clear)
//   • Pinned + Recently-viewed bands on the default view
//   • dense one-line-per-report rows with a pin star and live signal chips
//
// Deliberate deviations from the handoff, and why:
//   • Colours are mapped to the existing theme tokens (var(--acc), var(--bg1)…)
//     instead of the handoff's hardcoded light hex, so the screen still works in
//     dark mode. The `servos` skin accent is already the same green.
//   • The handoff's 270px rail carried a "ServOS / REPORTS" brand block and a
//     100vh app shell. The Back Office already supplies both, so the brand row is
//     dropped and the pane fills its container instead of the viewport.
//   • The handoff's 28-report list predates Inventory + Marketing reports, which
//     are kept here (30 reports / 10 categories).
//   • All NEW / UPDATED badges removed (badge fatigue — 18 of 28 carried one).
//   • Signal chips are driven by real `counts`; a report with no live number
//     simply renders no chip rather than a fabricated one.
//
// Report ids are UNCHANGED — they drive `view` in BOReports and the section
// navigation for reports that live in their own Back Office group.

import { useState, useEffect, useRef, useMemo } from 'react';
import { getActiveLocationSync } from '../../../lib/supabase';

/* ── Icons ───────────────────────────────────────────────────────────────── */
const svg = (size, sw, kids) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">{kids}</svg>
);
export const ICONS = {
  sales:      s => svg(s, 1.7, <><polyline points="3 16 9 10 13 14 21 6"/><polyline points="15 6 21 6 21 12"/></>),
  staff:      s => svg(s, 1.7, <><circle cx="9" cy="8" r="3.1"/><path d="M3.5 19.5a5.6 5.6 0 0 1 11 0"/><path d="M16.2 5.5a3 3 0 0 1 0 5.7"/><path d="M18 13.7a5 5 0 0 1 3 4.6"/></>),
  exceptions: s => svg(s, 1.7, <><path d="M12 3l7 2.6v5.1c0 4.3-3 7-7 8.3-4-1.3-7-4-7-8.3V5.6z"/><path d="M12 8.4v3.4"/><path d="M12 15.1v.05"/></>),
  fiscal:     s => svg(s, 1.7, <><rect x="2.5" y="6" width="19" height="12" rx="2.2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9.6v4.8"/><path d="M18 9.6v4.8"/></>),
  order:      s => svg(s, 1.7, <><path d="M12 3l8 4.3v9.4L12 21l-8-4.3V7.3z"/><path d="M4 7.4 12 11.6 20 7.4"/><path d="M12 11.6V21"/></>),
  kitchen:    s => svg(s, 1.7, <><path d="M6.5 17h11v2.2a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/><path d="M7 17a4.6 4.6 0 0 1-1-8.9 4.2 4.2 0 0 1 8-1.6 4.2 4.2 0 0 1 4 5.6A4.6 4.6 0 0 1 17 17"/></>),
  loyalty:    s => svg(s, 1.6, <><path d="M6 4h12l3 5-9 11L3 9z"/><path d="M3 9h18"/><path d="M9 4 7.5 9 12 20"/><path d="M15 4 16.5 9 12 20"/></>),
  multi:      s => svg(s, 1.7, <><path d="M12 21c4.6-4.3 6.7-7.4 6.7-10.6a6.7 6.7 0 1 0-13.4 0C5.3 13.6 7.4 16.7 12 21z"/><circle cx="12" cy="10.4" r="2.4"/></>),
  inventory:  s => svg(s, 1.7, <><rect x="3" y="7.5" width="18" height="13" rx="2"/><path d="M3 11h18"/><path d="M6.5 3.5h11l1.8 4H4.7z"/><path d="M10.5 15h3"/></>),
  marketing:  s => svg(s, 1.7, <><path d="M4 9.5v5a1.5 1.5 0 0 0 1.5 1.5H8l7 4.2V5.3L8 9.5H5.5A1.5 1.5 0 0 0 4 11z"/><path d="M18.5 9a4 4 0 0 1 0 6"/></>),
  search:     s => svg(s, 1.7, <><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></>),
  star:       s => svg(s, 1.6, <path d="M12 3.6l2.5 5.1 5.6.8-4.05 3.95 1 5.55L12 16.4l-5.05 2.6 1-5.55L3.9 9.5l5.6-.8z"/>),
  clock:      s => svg(s, 1.7, <><circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3 1.9"/></>),
  grid:       s => svg(s, 1.7, <><rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/></>),
  arrow:      s => svg(s, 1.8, <><path d="M5 12h13"/><path d="M13 6l6 6-6 6"/></>),
  close:      s => svg(s, 2,   <path d="M6 6l12 12M18 6L6 18"/>),
};
const StarFilled = ({ size = 17 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M12 3.6l2.5 5.1 5.6.8-4.05 3.95 1 5.55L12 16.4l-5.05 2.6 1-5.55L3.9 9.5l5.6-.8z"/>
  </svg>
);
const icon = (name, size) => (ICONS[name] ? ICONS[name](size || 18) : null);

/* ── Catalog data ────────────────────────────────────────────────────────────
   `label` + `icon` (emoji) are kept because BOReports renders them in the
   report breadcrumb. `short` + `glyph` are additive, for the rail + sections. */
export const CATEGORIES = [
  {
    id: 'sales', label: 'Sales reports', short: 'Sales', icon: '📈', glyph: 'sales',
    description: 'Net and gross sales, products, performance by channel and time.',
    reports: [
      { id:'daily_trading', label:'Daily trading (P&L)', desc:'Set a forecast per day (learns from last year), then sales vs theoretical vs actual costs → real operating profit' },
      { id:'summary',     label:'Business summary', desc:'Period stats with compare chips + net/gross ladder' },
      { id:'daily_trend', label:'Daily trend',      desc:'Revenue / covers / avg check / tips per day with vs-prev compare' },
      { id:'item_trend',  label:'Item sales trend', desc:'Items × days matrix with category + day-of-week filters' },
      { id:'items',       label:'Product mix',      desc:'Items, categories, modifiers and 86\'d — with time of day' },
      { id:'menu_eng',    label:'Menu engineering', desc:'Stars / Plow Horses / Puzzles / Dogs 2×2 matrix' },
      { id:'order_types', label:'Order types',      desc:'Channel mix over time with period compare' },
      { id:'order_sources', label:'Order sources',  desc:'Sales by till/surface and each delivery platform (Deliveroo, Uber Eats…)' },
      { id:'daypart',     label:'Daypart',          desc:'Hour × day-of-week revenue heatmap' },
    ],
  },
  {
    id: 'staff', label: 'Staff reports', short: 'Staff', icon: '👥', glyph: 'staff',
    description: 'Per-server performance, shifts and tip pooling.',
    reports: [
      { id:'servers', label:'Server scorecard', desc:'Full perf — tip %, discount rate, void rate, peer rank' },
      { id:'tips',    label:'Tips & pooling',   desc:'Per-server tips + configurable tip-pool calculator' },
      { id:'payroll', label:'Payroll',          desc:'Closed pay runs — wages + tips per period, per-staff breakdown and BACS CSV' },
      { id:'shifts',  label:'Shifts',           desc:'Business-day shifts with per-server sessions' },
    ],
  },
  {
    id: 'exceptions', label: 'Exceptions & discounts', short: 'Exceptions', icon: '🛡', glyph: 'exceptions',
    description: 'Voids, discounts and refunds with full audit trail.',
    reports: [
      { id:'exceptions', label:'Exceptions audit', desc:'Every void / discount / refund event, sortable by staff' },
    ],
  },
  {
    id: 'fiscal', label: 'Fiscal reports', short: 'Fiscal', icon: '💰', glyph: 'fiscal',
    description: 'Tax summaries, cash reconciliation and end-of-day close.',
    reports: [
      { id:'zreport',  label:'Z-report',         desc:'Printable end-of-day snapshot — thermal 80mm or PDF' },
      { id:'tax',      label:'Tax summary',      desc:'Per-rate + per-order-type breakdown, reuses POS tax engine' },
      { id:'payments', label:'Payments & cash',  desc:'Method breakdown + drawer reconciliation' },
      { id:'cash_drawer', label:'Cash drawer sessions', desc:'Every cash-in / cash-out with opening float, expected, declared, variance', signalKey:'cash_drawer', signalWord:'open' },
      { id:'ryft_payouts', label:'Card payments & payouts', desc:'Live Ryft balance, payout history and settlement to your bank' },
      { id:'ryft_disputes', label:'Disputes & chargebacks', desc:'Card disputes with a respond-by deadline — accept or challenge', signalKey:'disputes', signalWord:'due', tone:'warn' },
      { id:'adyen_payments', label:'Card Payments (Adyen)', desc:'Every Adyen card payment for this venue — amounts, refunds and status' },
      { id:'adyen_disputes', label:'Disputes (Adyen)', desc:'Adyen chargebacks with their respond-by deadlines' },
    ],
  },
  {
    id: 'orders', label: 'Order reports', short: 'Orders', icon: '📦', glyph: 'order',
    description: 'Live floor and order activity, per-table performance.',
    reports: [
      { id:'transactions', label:'Transactions & refunds', desc:'All closed checks with search, item details, and full or item-level refunds' },
      { id:'open',   label:'Open orders', desc:'Tables still on the floor, not yet paid', signalKey:'open', signalWord:'live' },
      { id:'tables', label:'Tables',      desc:'Revenue, turns, covers and avg check by table' },
      { id:'bookings', label:'Bookings',  desc:'Booking volume, covers, no-shows, sources and peak times for the period' },
    ],
  },
  {
    id: 'kitchen', label: 'Kitchen reports', short: 'Kitchen', icon: '👨‍🍳', glyph: 'kitchen',
    description: 'KDS bump times, station throughput and kitchen pressure.',
    reports: [
      { id:'kds_perf', label:'KDS performance', desc:'Avg / p50 / p90 bump time by station and by hour' },
    ],
  },
  {
    id: 'inventory', label: 'Inventory reports', short: 'Inventory', icon: '🗃', glyph: 'inventory',
    description: 'Stock valuation, recipe margins and the variance gap.',
    // Opens the full Inventory → Reports screen (its own section), not an in-shell report.
    reports: [
      { id:'stock_reports', label:'Inventory reports', section:'stock-reports',
        desc:'Valuation · recipe GP / food-cost % · movements ledger · theoretical-vs-actual gap' },
    ],
  },
  {
    id: 'loyalty', label: 'Loyalty reports', short: 'Loyalty', icon: '💎', glyph: 'loyalty',
    description: 'Member engagement, stamp cards, points circulation and reward redemptions.',
    reports: [
      { id:'loyalty_overview',      label:'Loyalty overview',   desc:'KPIs, tier distribution, stamp card summaries and period activity' },
      { id:'loyalty_members',       label:'Member leaderboard', desc:'Top 50 members ranked by spend, points or visits' },
      { id:'loyalty_stamps',        label:'Stamp cards',        desc:'Per-program active cards, completions and top stampers' },
      { id:'loyalty_transactions',  label:'Transactions',       desc:'Filterable log of all points earned, redeemed and stamp activity' },
    ],
  },
  {
    id: 'marketing', label: 'Marketing reports', short: 'Marketing', icon: '📣', glyph: 'marketing',
    description: 'Campaign and offer attribution.',
    // Opens the full Customers → Marketing report screen (its own section).
    reports: [
      { id:'marketing_reports', label:'Marketing report', section:'marketing-reports',
        desc:'Redemptions, attributed revenue, channel split and message delivery stats' },
    ],
  },
  {
    id: 'location', label: 'Multi-location reports', short: 'Multi-location', icon: '📍', glyph: 'multi',
    description: 'Compare performance across all your sites side by side.',
    reports: [
      { id:'location_compare', label:'Location compare', desc:'Side-by-side performance across every site you manage, with outlier alerts' },
    ],
  },
];

// Flat lookup — { reportId -> { category, label } } for breadcrumb building.
export const REPORT_INDEX = (() => {
  const idx = {};
  CATEGORIES.forEach(cat => cat.reports.forEach(r => { idx[r.id] = { category: cat.id, label: r.label }; }));
  return idx;
})();

const ALL_REPORTS = CATEGORIES.flatMap(c => c.reports.map(r => ({ ...r, cat: c.id, catLabel: c.label })));
const REPORT_BY_ID = Object.fromEntries(ALL_REPORTS.map(r => [r.id, r]));
const GLYPH_BY_CAT = Object.fromEntries(CATEGORIES.map(c => [c.id, c.glyph]));

/* ── Pins + recents (per venue, localStorage; UI preference only) ─────────── */
const lsKey = (kind) => `rpos-reports-${kind}:${getActiveLocationSync() || 'default'}`;
const lsRead = (kind) => {
  try { const v = JSON.parse(localStorage.getItem(lsKey(kind)) || '[]'); return Array.isArray(v) ? v.filter(x => REPORT_BY_ID[x]) : []; }
  catch { return []; }
};
const lsWrite = (kind, val) => { try { localStorage.setItem(lsKey(kind), JSON.stringify(val)); } catch {} };

/* ── Small pieces ────────────────────────────────────────────────────────── */
function SignalChip({ n, word, tone }) {
  if (!n) return null;
  const warn = tone === 'warn';
  return (
    <span style={{
      display:'inline-flex', alignItems:'center', gap:6, padding:'2.5px 9px 2.5px 8px', borderRadius:999,
      background: warn ? 'color-mix(in srgb, var(--amber, #F5A623) 15%, transparent)' : 'var(--acc-d)',
      color: warn ? 'var(--amber, #F5A623)' : 'var(--acc)',
      fontSize:11.5, fontWeight:700, whiteSpace:'nowrap',
    }}>
      <span style={{ width:6, height:6, borderRadius:'50%', flexShrink:0,
        background: warn ? 'var(--amber, #F5A623)' : 'var(--acc)',
        animation: warn ? 'none' : 'rcpulse 1.9s ease-in-out infinite' }}/>
      {n} {word}
    </span>
  );
}

function Highlight({ text, q }) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark style={{ background:'var(--acc-d)', color:'var(--acc)', borderRadius:3, padding:'0 1px' }}>
        {text.slice(i, i + q.length)}
      </mark>
      {text.slice(i + q.length)}
    </>
  );
}

function RailItem({ active, glyph, label, count, onClick }) {
  const [hov, setHov] = useState(false);
  return (
    <button onClick={onClick} onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)} style={{
      display:'flex', alignItems:'center', gap:10, width:'100%',
      padding: active ? '8px 10px 8px 12px' : '8px 10px',
      border:'none', borderRadius:10, cursor:'pointer', textAlign:'left', fontFamily:'inherit',
      fontSize:13, fontWeight: active ? 700 : 500,
      background: active ? 'var(--acc-d)' : (hov ? 'var(--bg3)' : 'transparent'),
      color: active ? 'var(--acc)' : (hov ? 'var(--t1)' : 'var(--t3)'),
      boxShadow: active ? 'inset 3px 0 0 var(--acc)' : 'none',
      transition:'background .12s, color .12s',
    }}>
      <span style={{ display:'flex', flexShrink:0 }}>{icon(glyph, 17)}</span>
      <span style={{ flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{label}</span>
      {count != null && (
        <span style={{ fontSize:11.5, fontWeight:700, color: active ? 'var(--acc)' : 'var(--t4)' }}>{count}</span>
      )}
    </button>
  );
}

function BandChip({ r, tone, onOpen }) {
  const [hov, setHov] = useState(false);
  return (
    <button onClick={()=>onOpen(r)} onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)} style={{
      display:'flex', alignItems:'center', gap:12, padding:'12px 14px', flex:'1 1 240px', minWidth:240, maxWidth:330,
      background:'var(--bg1)', border:`1px solid ${hov ? 'var(--acc-b)' : 'var(--bdr)'}`, borderRadius:14,
      cursor:'pointer', textAlign:'left', fontFamily:'inherit',
      boxShadow: hov ? '0 10px 24px -16px rgba(0,0,0,.55)' : 'none', transition:'border-color .13s, box-shadow .13s',
    }}>
      <span style={{
        width:34, height:34, flex:'none', borderRadius:9, display:'flex', alignItems:'center', justifyContent:'center',
        background: tone === 'pin' ? 'var(--acc-d)' : 'var(--bg3)',
        color: tone === 'pin' ? 'var(--acc)' : 'var(--t3)',
      }}>{icon(GLYPH_BY_CAT[r.cat], 18)}</span>
      <span style={{ display:'flex', flexDirection:'column', minWidth:0, flex:1 }}>
        <span style={{ fontSize:13.5, fontWeight:700, color:'var(--t1)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{r.label}</span>
        <span style={{ fontSize:11.5, color:'var(--t4)' }}>{r.catLabel}</span>
      </span>
      <span style={{ display:'flex', color:'var(--t4)', flex:'none' }}>{icon('arrow', 17)}</span>
    </button>
  );
}

function ReportRow({ r, q, showCat, pinned, counts, onOpen, onTogglePin }) {
  const [hov, setHov] = useState(false);
  const [pinHov, setPinHov] = useState(false);
  const n = r.signalKey ? counts[r.signalKey] : 0;
  return (
    <div
      role="button" tabIndex={0}
      onClick={()=>onOpen(r)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(r); } }}
      onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)}
      style={{
        display:'flex', alignItems:'center', gap:13, padding:'15px 15px',
        background: hov ? 'var(--bg2)' : 'var(--bg1)',
        border:`1px solid ${hov ? 'var(--acc-b)' : 'var(--bdr)'}`, borderRadius:14, cursor:'pointer',
        boxShadow: hov ? '0 10px 24px -16px rgba(0,0,0,.6)' : 'none',
        transition:'border-color .13s, box-shadow .13s, background .13s',
      }}>
      <div style={{ display:'flex', flexDirection:'column', minWidth:0, flex:1, gap:3 }}>
        <div style={{ display:'flex', alignItems:'center', gap:9, flexWrap:'wrap' }}>
          <span style={{ fontSize:14.5, fontWeight:700, color:'var(--t1)', lineHeight:1.2 }}>
            <Highlight text={r.label} q={q}/>
          </span>
          {showCat && (
            <span style={{ fontSize:11, fontWeight:500, color:'var(--t4)', background:'var(--bg3)', borderRadius:6, padding:'2px 7px' }}>
              {r.catLabel}
            </span>
          )}
          <SignalChip n={n} word={r.signalWord} tone={r.tone}/>
        </div>
        <div style={{ fontSize:12.5, color:'var(--t3)', fontWeight:400, lineHeight:1.4 }}>{r.desc}</div>
      </div>
      <button
        onClick={e => { e.stopPropagation(); onTogglePin(r.id); }}
        onMouseEnter={()=>setPinHov(true)} onMouseLeave={()=>setPinHov(false)}
        aria-label={pinned ? 'Unpin' : 'Pin'} title={pinned ? 'Unpin' : 'Pin'}
        style={{
          width:32, height:32, flex:'none', border:'none', borderRadius:9, cursor:'pointer',
          display:'flex', alignItems:'center', justifyContent:'center',
          background: pinHov ? (pinned ? 'var(--acc-d)' : 'var(--bg3)') : 'transparent',
          color: pinned ? 'var(--acc)' : (pinHov ? 'var(--t2)' : 'var(--t4)'),
          opacity: pinned || pinHov ? 1 : .75, transition:'background .12s, color .12s',
        }}>
        {pinned ? <StarFilled size={17}/> : icon('star', 17)}
      </button>
      <span style={{ display:'flex', color:'var(--t4)', flex:'none' }}>{icon('arrow', 18)}</span>
    </div>
  );
}

/* ── Catalog ─────────────────────────────────────────────────────────────── */
export default function Catalog({ onOpen, counts = {} }) {
  const [query, setQuery]   = useState('');
  const [active, setActive] = useState('all');
  const [pinned, setPinned] = useState(() => lsRead('pins'));
  const [recent, setRecent] = useState(() => lsRead('recent'));
  const inputRef = useRef(null);
  const mainRef  = useRef(null);

  // "/" focuses search; Esc clears it (or blurs when already empty).
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === '/' && !typing) { e.preventDefault(); inputRef.current?.focus(); }
      else if (e.key === 'Escape') {
        if (query) setQuery('');
        else if (document.activeElement === inputRef.current) inputRef.current.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [query]);

  const selectRail = (id) => { setActive(id); setQuery(''); if (mainRef.current) mainRef.current.scrollTop = 0; };

  const togglePin = (id) => setPinned(prev => {
    const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
    lsWrite('pins', next);
    return next;
  });

  const open = (r) => {
    setRecent(prev => { const next = [r.id, ...prev.filter(x => x !== r.id)].slice(0, 6); lsWrite('recent', next); return next; });
    onOpen(r);
  };

  const q = query.trim().toLowerCase();
  const isSearch = q.length > 0;

  const pinnedReports = useMemo(() => pinned.map(id => REPORT_BY_ID[id]).filter(Boolean), [pinned]);
  const recentReports = useMemo(() => recent.map(id => REPORT_BY_ID[id]).filter(Boolean), [recent]);

  const { sections, mode } = useMemo(() => {
    if (isSearch) {
      const matches = ALL_REPORTS.filter(r => `${r.label} ${r.desc} ${r.catLabel}`.toLowerCase().includes(q));
      return { mode:'search', sections:[{ id:'results', name:'Results', desc:'', glyph:'search', reports:matches, showCat:true }] };
    }
    if (active === 'pinned') {
      return { mode:'pinned', sections:[{ id:'pinned', name:'Pinned reports', desc:'Your starred reports, in the order you pinned them.', glyph:'star', reports:pinnedReports, showCat:true }] };
    }
    if (active === 'recent') {
      return { mode:'recent', sections:[{ id:'recent', name:'Recently viewed', desc:'The last reports you opened.', glyph:'clock', reports:recentReports, showCat:true }] };
    }
    if (active !== 'all') {
      const c = CATEGORIES.find(c => c.id === active);
      if (!c) return { mode:'all', sections:[] };
      return { mode:'category', sections:[{ id:c.id, name:c.label, desc:c.description, glyph:c.glyph, reports:ALL_REPORTS.filter(r => r.cat === c.id), showCat:false }] };
    }
    return {
      mode:'all',
      sections: CATEGORIES.map(c => ({
        id:c.id, name:c.label, desc:c.description, glyph:c.glyph,
        reports: ALL_REPORTS.filter(r => r.cat === c.id), showCat:false,
      })),
    };
  }, [isSearch, q, active, pinnedReports, recentReports]);

  const resultCount = isSearch ? sections[0].reports.length : 0;
  const hasResults  = sections.some(s => s.reports.length > 0);

  const empty = !hasResults && (
    mode === 'search' ? { glyph:'search', title:`No reports match “${query.trim()}”`, desc:'Try a different term — search covers report names and descriptions.', label:'Clear search', act:()=>{ setQuery(''); inputRef.current?.focus(); } }
    : mode === 'pinned' ? { glyph:'star', title:'No pinned reports yet', desc:'Star any report to pin it here for one-click access.', label:'Browse all reports', act:()=>selectRail('all') }
    : mode === 'recent' ? { glyph:'clock', title:'Nothing viewed yet', desc:'Reports you open will show up here for quick return.', label:'Browse all reports', act:()=>selectRail('all') }
    : { glyph:'search', title:'Nothing here', desc:'This category has no reports.', label:'Browse all reports', act:()=>selectRail('all') }
  );

  return (
    <div style={{ display:'flex', flex:1, minHeight:0, gap:0, margin:'-4px 0' }}>
      <style>{`@keyframes rcpulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.82)}}`}</style>

      {/* ── Rail ───────────────────────────────────────────────────────── */}
      <aside style={{
        width:212, flex:'none', overflowY:'auto', paddingRight:14, marginRight:16,
        borderRight:'1px solid var(--bdr)', display:'flex', flexDirection:'column', gap:2,
      }}>
        <RailItem active={active==='all' && !isSearch}    glyph="grid"  label="All reports" count={ALL_REPORTS.length} onClick={()=>selectRail('all')}/>
        <RailItem active={active==='pinned' && !isSearch} glyph="star"  label="Pinned"      count={pinnedReports.length} onClick={()=>selectRail('pinned')}/>
        <RailItem active={active==='recent' && !isSearch} glyph="clock" label="Recent"      count={recentReports.length || null} onClick={()=>selectRail('recent')}/>

        <div style={{ fontSize:10.5, fontWeight:700, letterSpacing:'.7px', color:'var(--t4)', padding:'18px 10px 7px' }}>CATEGORIES</div>

        {CATEGORIES.map(c => (
          <RailItem key={c.id} active={active===c.id && !isSearch} glyph={c.glyph} label={c.short}
                    count={c.reports.length} onClick={()=>selectRail(c.id)}/>
        ))}
      </aside>

      {/* ── Main ───────────────────────────────────────────────────────── */}
      <div ref={mainRef} style={{ flex:1, minWidth:0, overflowY:'auto', paddingRight:4 }}>
        <div style={{ fontSize:11, fontWeight:700, letterSpacing:'1.4px', color:'var(--t4)' }}>REPORTS</div>
        <h1 style={{ margin:'6px 0 6px', fontSize:30, lineHeight:1.05, fontWeight:800, letterSpacing:'-.8px', color:'var(--t1)' }}>Catalog</h1>
        <p style={{ margin:0, fontSize:14, color:'var(--t3)', fontWeight:400 }}>
          {ALL_REPORTS.length} reports across {CATEGORIES.length} categories — pick one to set its period, filters and export.
        </p>

        {/* Sticky search */}
        <div style={{ position:'sticky', top:0, zIndex:20, margin:'20px 0 0', padding:'10px 0 12px', background:'var(--bg, var(--bg1))' }}>
          <div style={{ position:'relative', maxWidth:640 }}>
            <span style={{ position:'absolute', left:16, top:'50%', transform:'translateY(-50%)', display:'flex', color:'var(--t4)', pointerEvents:'none' }}>
              {icon('search', 19)}
            </span>
            <input
              ref={inputRef} value={query} onChange={e=>setQuery(e.target.value)}
              placeholder="Search reports…" spellCheck={false} aria-label="Search reports"
              style={{
                width:'100%', height:48, padding:'0 46px', borderRadius:14, border:'1.5px solid var(--bdr2)',
                background:'var(--bg1)', fontFamily:'inherit', fontSize:15, color:'var(--t1)', outline:'none',
              }}
              onFocus={e => { e.target.style.borderColor = 'var(--acc)'; e.target.style.boxShadow = '0 0 0 4px var(--acc-d)'; }}
              onBlur={e => { e.target.style.borderColor = 'var(--bdr2)'; e.target.style.boxShadow = 'none'; }}
            />
            {query ? (
              <button onClick={()=>{ setQuery(''); inputRef.current?.focus(); }} aria-label="Clear search" style={{
                position:'absolute', right:10, top:'50%', transform:'translateY(-50%)', width:30, height:30,
                border:'none', borderRadius:8, background:'var(--bg3)', color:'var(--t2)', cursor:'pointer',
                display:'flex', alignItems:'center', justifyContent:'center',
              }}>{icon('close', 15)}</button>
            ) : (
              <span style={{ position:'absolute', right:14, top:'50%', transform:'translateY(-50%)', display:'flex', alignItems:'center', gap:5, color:'var(--t4)', fontSize:12, pointerEvents:'none' }}>
                <kbd style={{ fontFamily:'inherit', fontSize:11, fontWeight:700, color:'var(--t3)', background:'var(--bg3)', border:'1px solid var(--bdr)', borderRadius:6, padding:'2px 7px' }}>/</kbd>
                <span>to search</span>
              </span>
            )}
          </div>
          {isSearch && (
            <div style={{ marginTop:11, fontSize:13, color:'var(--t3)' }}>
              {resultCount === 1 ? '1 report found' : `${resultCount} reports found`}
            </div>
          )}
        </div>

        <div style={{ marginTop:20, paddingBottom:60 }}>
          {/* Pinned band */}
          {mode === 'all' && pinnedReports.length > 0 && (
            <div style={{ marginBottom:30 }}>
              <div style={{ display:'flex', alignItems:'center', gap:9, marginBottom:12, color:'var(--acc)' }}>
                <StarFilled size={15}/>
                <span style={{ fontSize:13, fontWeight:700, letterSpacing:'.2px', color:'var(--t2)' }}>Pinned</span>
              </div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:11 }}>
                {pinnedReports.map(r => <BandChip key={r.id} r={r} tone="pin" onOpen={open}/>)}
              </div>
            </div>
          )}

          {/* Recently viewed band */}
          {mode === 'all' && recentReports.length > 0 && (
            <div style={{ marginBottom:34 }}>
              <div style={{ display:'flex', alignItems:'center', gap:9, marginBottom:12, color:'var(--t3)' }}>
                {icon('clock', 15)}
                <span style={{ fontSize:13, fontWeight:700, letterSpacing:'.2px', color:'var(--t2)' }}>Recently viewed</span>
              </div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:11 }}>
                {recentReports.map(r => <BandChip key={r.id} r={r} tone="recent" onOpen={open}/>)}
              </div>
            </div>
          )}

          {/* Sections */}
          {hasResults ? (
            <div style={{ display:'flex', flexDirection:'column', gap:34 }}>
              {sections.filter(s => s.reports.length > 0).map(sec => (
                <section key={sec.id}>
                  <div style={{ display:'flex', alignItems:'flex-start', gap:12, marginBottom:15 }}>
                    <span style={{
                      width:38, height:38, flex:'none', borderRadius:11, display:'flex', alignItems:'center', justifyContent:'center',
                      background:'var(--acc-d)', color:'var(--acc)',
                    }}>{icon(sec.glyph, 20)}</span>
                    <div style={{ display:'flex', flexDirection:'column', gap:2, paddingTop:1 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:9 }}>
                        <h2 style={{ margin:0, fontSize:18, fontWeight:700, letterSpacing:'-.3px', color:'var(--t1)' }}>{sec.name}</h2>
                        <span style={{ fontSize:12, fontWeight:700, color:'var(--t4)', background:'var(--bg3)', borderRadius:20, padding:'2px 9px' }}>
                          {sec.reports.length}
                        </span>
                      </div>
                      {sec.desc && <p style={{ margin:0, fontSize:13, color:'var(--t3)', fontWeight:400 }}>{sec.desc}</p>}
                    </div>
                  </div>

                  <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(342px, 1fr))', gap:10 }}>
                    {sec.reports.map(r => (
                      <ReportRow key={r.id} r={r} q={q} showCat={sec.showCat} pinned={pinned.includes(r.id)}
                                 counts={counts} onOpen={open} onTogglePin={togglePin}/>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', textAlign:'center', padding:'70px 20px 40px' }}>
              <span style={{
                width:64, height:64, borderRadius:18, display:'flex', alignItems:'center', justifyContent:'center',
                background:'var(--bg1)', border:'1px solid var(--bdr)', color:'var(--t4)', marginBottom:20,
              }}>{icon(empty.glyph, 26)}</span>
              <div style={{ fontSize:18, fontWeight:700, color:'var(--t1)', marginBottom:6 }}>{empty.title}</div>
              <p style={{ margin:'0 0 20px', fontSize:14, color:'var(--t3)', fontWeight:400, maxWidth:380, lineHeight:1.5 }}>{empty.desc}</p>
              <button onClick={empty.act} style={{
                border:'none', borderRadius:11, padding:'11px 18px', background:'var(--acc)', color:'#fff',
                fontFamily:'inherit', fontSize:13.5, fontWeight:700, cursor:'pointer',
              }}>{empty.label}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
