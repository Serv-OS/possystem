// ManagerHome — the balanced four-pillar read + quick nav. Role-adaptive (cards gate on flags).
import { Header, NavCard, syne, mono } from './ui';

export default function ManagerHome({ ctx }) {
  const { operator, flags, setTab } = ctx;
  const h = new Date().getHours();
  const greeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const first = operator?.name ? operator.name.split(' ')[0] : '';
  const cards = [
    flags.reports_view && { icon: 'reports', title: 'Reports', sub: 'Takings, tables & live floor', tab: 'reports' },
    flags.team_live && { icon: 'team', title: 'Team', sub: "Who's on, no-shows, approvals", tab: 'team' },
    flags.ops_checks && { icon: 'clipboard', title: 'Ops checks', sub: 'Temps, opening & closing', tab: 'ops' },
    flags.kitchen && { icon: 'fire', title: 'Kitchen', sub: 'Stock to order & batch cooks', tab: 'kitchen' },
  ].filter(Boolean);

  return (
    <div>
      <div className="sv-glass" style={{ padding: '20px 22px', marginBottom: 6 }}>
        <div style={{ fontSize: 22, fontWeight: 800, ...syne }}>{greeting}{first ? `, ${first}` : ''}</div>
        <div style={{ fontSize: 10.5, color: 'var(--t3)', marginTop: 4, textTransform: 'uppercase', letterSpacing: '.08em', ...mono }}>
          {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short' }).toUpperCase()} · {new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--t2)', marginTop: 10, lineHeight: 1.5 }}>
          {ctx.venueName || 'Your venue'} — the floor, the pass and the books, in your pocket.
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
        {cards.map((c) => <NavCard key={c.tab} icon={c.icon} title={c.title} sub={c.sub} onClick={() => setTab(c.tab)} />)}
      </div>
    </div>
  );
}
