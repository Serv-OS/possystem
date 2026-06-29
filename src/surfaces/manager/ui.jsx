// src/surfaces/manager/ui.jsx — shared presentational bits for the Manager tabs (glass system).
import { Icon } from '../../components/ServOSIcons';

export const mono = { fontFamily: 'var(--font-mono)' };
export const syne = { fontFamily: 'Syne, Space Grotesk, sans-serif' };

export function SectionTitle({ children, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '18px 2px 10px' }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.1em', ...mono }}>{children}</span>
      {right != null && <span style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>{right}</span>}
    </div>
  );
}

/** Big hero number (Syne) with an eyebrow label — the §6 expressive read. */
export function Hero({ label, value, sub, accent = 'var(--acc)' }) {
  return (
    <div className="sv-glass" style={{ padding: '18px 20px' }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.1em', ...mono }}>{label}</div>
      <div style={{ fontSize: 34, fontWeight: 800, color: accent, lineHeight: 1.1, margin: '6px 0 2px', ...syne }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--t3)', ...mono }}>{sub}</div>}
    </div>
  );
}

/** Compact stat tile for a grid. */
export function Stat({ label, value, tone = 'var(--t1)' }) {
  return (
    <div className="sv-glass" style={{ padding: '14px 16px' }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: tone, ...mono }}>{value}</div>
      <div style={{ fontSize: 10.5, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginTop: 2, ...mono }}>{label}</div>
    </div>
  );
}

export function NavCard({ icon, title, sub, onClick, accent = 'var(--acc)' }) {
  return (
    <button onClick={onClick} className="sv-glass" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 18px', borderRadius: 16, width: '100%', textAlign: 'left', cursor: 'pointer', color: 'var(--t1)', border: '1px solid var(--bdr)', fontFamily: 'inherit' }}>
      <div style={{ width: 40, height: 40, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'var(--acc-d)', color: accent, flexShrink: 0 }}><Icon name={icon} size={20} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 800 }}>{title}</div>
        {sub && <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 1 }}>{sub}</div>}
      </div>
      <span style={{ color: 'var(--t4)', fontSize: 20 }}>›</span>
    </button>
  );
}

export function Header({ title, sub }) {
  return (
    <div style={{ padding: '4px 2px 4px' }}>
      <div style={{ fontSize: 22, fontWeight: 800, ...syne }}>{title}</div>
      {sub && <div style={{ fontSize: 10.5, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', marginTop: 2, ...mono }}>{sub}</div>}
    </div>
  );
}

/** Honest placeholder for a tab whose live data lands in a following slice. */
export function SoonPanel({ icon, title, points = [] }) {
  return (
    <div className="sv-glass" style={{ padding: 22, marginTop: 14, textAlign: 'center' }}>
      <div style={{ width: 48, height: 48, borderRadius: 14, display: 'grid', placeItems: 'center', background: 'var(--acc-d)', color: 'var(--acc)', margin: '0 auto 12px' }}><Icon name={icon} size={24} /></div>
      <div style={{ fontSize: 16, fontWeight: 800 }}>{title}</div>
      <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 6, lineHeight: 1.5 }}>Live data is wiring up in the next update.</div>
      {points.length > 0 && (
        <div style={{ textAlign: 'left', display: 'inline-block', marginTop: 14 }}>
          {points.map((p, i) => (
            <div key={i} style={{ fontSize: 12.5, color: 'var(--t2)', display: 'flex', gap: 8, marginBottom: 6 }}>
              <span style={{ color: 'var(--acc)' }}>•</span><span>{p}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
