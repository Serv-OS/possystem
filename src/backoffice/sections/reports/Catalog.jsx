// v4.6.16: Reports catalog landing page.
// Replaces the tab bar with a category-grouped card layout — like the reference
// design. Clicking a report opens it as a dedicated view with a back link.

export const CATEGORIES = [
  {
    id: 'sales', label: 'Sales reports', icon: '📈',
    description: 'Net and gross sales, products, performance by channel and time.',
    reports: [
      { id:'summary',     label:'Business summary', desc:'Period stats with compare chips + net/gross ladder' },
      { id:'daily_trend', label:'Daily trend',      desc:'Revenue / covers / avg check / tips per day with vs-prev compare', badge:'new' },
      { id:'item_trend',  label:'Item sales trend', desc:'Items × days matrix with category + day-of-week filters', badge:'new' },
      { id:'items',       label:'Product mix',      desc:'Items, categories, modifiers and 86\'d — with time of day' },
      { id:'menu_eng',    label:'Menu engineering', desc:'Stars / Plow Horses / Puzzles / Dogs 2×2 matrix' },
      { id:'order_types', label:'Order types',      desc:'Channel mix over time with period compare' },
      { id:'daypart',     label:'Daypart',          desc:'Hour × day-of-week revenue heatmap' },
    ],
  },
  {
    id: 'staff', label: 'Staff reports', icon: '👥',
    description: 'Per-server performance, shifts and tip pooling.',
    reports: [
      { id:'servers', label:'Server scorecard', desc:'Full perf — tip %, discount rate, void rate, peer rank', badge:'new' },
      { id:'tips',    label:'Tips & pooling',   desc:'Per-server tips + configurable tip-pool calculator', badge:'new' },
      { id:'shifts',  label:'Shifts',           desc:'Business-day shifts with per-server sessions' },
    ],
  },
  {
    id: 'exceptions', label: 'Exceptions & discounts', icon: '🛡',
    description: 'Voids, discounts and refunds with full audit trail.',
    reports: [
      { id:'exceptions', label:'Exceptions audit', desc:'Every void / discount / refund event, sortable by staff' },
    ],
  },
  {
    id: 'fiscal', label: 'Fiscal reports', icon: '💰',
    description: 'Tax summaries, cash reconciliation and end-of-day close.',
    reports: [
      { id:'zreport',  label:'Z-report',         desc:'Printable end-of-day snapshot — thermal 80mm or PDF', badge:'new' },
      { id:'tax',      label:'Tax summary',      desc:'Per-rate + per-order-type breakdown, reuses POS tax engine', badge:'updated' },
      { id:'payments', label:'Payments & cash',  desc:'Method breakdown + drawer reconciliation' },
      { id:'cash_drawer', label:'Cash drawer sessions', desc:'Every cash-in / cash-out with opening float, expected, declared, variance', badge:'new' },
      { id:'ryft_payouts', label:'Card payments & payouts', desc:'Live Ryft balance, payout history and settlement to your bank', badge:'new' },
    ],
  },
  {
    id: 'orders', label: 'Order reports', icon: '📦',
    description: 'Live floor and order activity, per-table performance.',
    reports: [
      { id:'transactions', label:'Transactions & refunds', desc:'All closed checks with search, item details, and full or item-level refunds', badge:'new' },
      { id:'open',   label:'Open orders', desc:'Tables still on the floor, not yet paid' },
      { id:'tables', label:'Tables',      desc:'Revenue, turns, covers and avg check by table', badge:'new' },
    ],
  },
  {
    id: 'kitchen', label: 'Kitchen reports', icon: '👨‍🍳',
    description: 'KDS bump times, station throughput and kitchen pressure.',
    reports: [
      { id:'kds_perf', label:'KDS performance', desc:'Avg / p50 / p90 bump time by station and by hour', badge:'new' },
    ],
  },
  {
    id: 'loyalty', label: 'Loyalty reports', icon: '💎',
    description: 'Member engagement, stamp cards, points circulation and reward redemptions.',
    reports: [
      { id:'loyalty_overview',      label:'Loyalty overview',   desc:'KPIs, tier distribution, stamp card summaries and period activity', badge:'new' },
      { id:'loyalty_members',       label:'Member leaderboard', desc:'Top 50 members ranked by spend, points or visits', badge:'new' },
      { id:'loyalty_stamps',        label:'Stamp cards',        desc:'Per-program active cards, completions and top stampers', badge:'new' },
      { id:'loyalty_transactions',  label:'Transactions',       desc:'Filterable log of all points earned, redeemed and stamp activity', badge:'new' },
    ],
  },
  {
    id: 'location', label: 'Multi-location reports', icon: '📍',
    description: 'Compare performance across all your sites side by side.',
    reports: [
      { id:'location_compare', label:'Location compare', desc:'Side-by-side performance across every site you manage, with outlier alerts', badge:'new' },
    ],
  },
];

// Flat lookup — { reportId -> categoryId } for breadcrumb building
export const REPORT_INDEX = (() => {
  const idx = {};
  CATEGORIES.forEach(cat => cat.reports.forEach(r => { idx[r.id] = { category: cat.id, label: r.label }; }));
  return idx;
})();

export default function Catalog({ onOpen, counts = {} }) {
  return (
    <div style={{ maxWidth: 1100 }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 700 }}>Reports</div>
        <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--t1)', marginTop: 2, letterSpacing: '-.01em' }}>Catalog</div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4 }}>
          Pick a report to set its period, filters and export.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 14 }}>
        {CATEGORIES.map(cat => (
          <div key={cat.id} style={{
            background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12,
            padding: '16px 18px', display: 'flex', flexDirection: 'column',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <span style={{ fontSize: 18 }}>{cat.icon}</span>
              <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)' }}>{cat.label}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--t4)', marginBottom: 12, lineHeight: 1.5 }}>{cat.description}</div>

            {cat.comingSoon ? (
              <div style={{
                marginTop: 4, padding: '10px 12px', background: 'var(--bg3)',
                border: '1px dashed var(--bdr)', borderRadius: 8,
                fontSize: 11, color: 'var(--t4)', lineHeight: 1.5,
              }}>
                {cat.comingSoon}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 'auto' }}>
                {cat.reports.map(r => (
                  <button
                    key={r.id}
                    onClick={() => onOpen(r.id)}
                    style={{
                      textAlign: 'left', padding: '8px 10px', marginLeft: -10, marginRight: -10,
                      borderRadius: 8, border: 'none', background: 'transparent',
                      cursor: 'pointer', fontFamily: 'inherit',
                      display: 'flex', alignItems: 'center', gap: 10,
                      transition: 'background .15s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg3)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--acc)', display: 'flex', alignItems: 'center', gap: 6 }}>
                        {r.label}
                        {r.badge && (
                          <span style={{
                            padding: '1px 6px', fontSize: 9, fontWeight: 800,
                            background: 'var(--acc)', color: '#0b0c10', borderRadius: 4,
                            letterSpacing: '.05em', textTransform: 'uppercase',
                          }}>{r.badge}</span>
                        )}
                        {counts[r.id] !== undefined && counts[r.id] !== null && (
                          <span style={{ fontSize: 10, color: 'var(--t4)', fontFamily: 'var(--font-mono)' }}>
                            {counts[r.id]}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 1 }}>{r.desc}</div>
                    </div>
                    <span style={{ color: 'var(--t4)', fontSize: 14 }}>→</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
