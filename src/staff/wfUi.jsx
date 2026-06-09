// src/staff/wfUi.jsx
//
// Shared Workforce UI primitives (ServOS skin). Every Workforce section file
// imports from here so the look stays consistent and there is one source of
// truth for cards, badges, table styles, colours and empty states.

import { Icon } from '../components/ServOSIcons';
import { ROLES } from './seed';

export const money = (n, dp = 0) => '£' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const HUE = { mgmt: 250, bar: 200, floor: 150, kitchen: 38, door: 285 };
export const groupColor = grp => `oklch(var(--cat-l) var(--cat-c) ${HUE[grp] ?? 250})`;
export const cellTint = (col, a) => `color-mix(in oklch, ${col} ${a}%, transparent)`;
export const GRP_SECTION = { bar: 'Bar', floor: 'Floor', kitchen: 'Kitchen', door: 'Door', mgmt: 'Management' };
export const initials = n => (n || '').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';

export const inputStyle = { width: '100%', background: 'var(--bg3)', border: '1.5px solid var(--bdr2)', borderRadius: 10, padding: '10px 12px', height: 42, fontSize: 13, color: 'var(--t1)', fontFamily: 'inherit', outline: 'none' };
export const labelStyle = { display: 'block', fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 6 };
export const th = { padding: '11px 10px', textAlign: 'left', fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--glass-border)' };
export const td = { padding: '10px 10px', borderBottom: '1px solid var(--bdr)', verticalAlign: 'middle', fontSize: 13 };

export function Card({ children, style }) {
  return <div style={{ background: 'var(--glass-bg)', backdropFilter: 'blur(22px) saturate(150%)', WebkitBackdropFilter: 'blur(22px) saturate(150%)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow), var(--glass-hi)', borderRadius: 16, padding: 18, ...style }}>{children}</div>;
}

export function RoleChip({ role, roles = ROLES }) {
  const r = roles[role];
  if (!r) return <span style={{ color: 'var(--t3)' }}>{role || '—'}</span>;
  const col = groupColor(r.grp);
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: col }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: col }} />{r.lbl}</span>;
}

const BADGE = {
  green: ['var(--grn-d)', 'var(--grn-b)', 'var(--grn)'],
  amber: ['rgba(245,166,35,.13)', 'rgba(245,166,35,.30)', 'var(--amber)'],
  red: ['var(--red-d)', 'var(--red-b)', 'var(--red)'],
  blue: ['var(--blu-d)', 'var(--blu-b)', 'var(--blu)'],
  grey: ['var(--inset)', 'var(--inset-border)', 'var(--t3)'],
};
export function Badge({ tone = 'green', children }) {
  const [bg, bd, fg] = BADGE[tone] || BADGE.green;
  return <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: bg, border: `1px solid ${bd}`, color: fg, whiteSpace: 'nowrap' }}>{children}</span>;
}

export function EmptyState({ icon = 'sparkle', title, body, cta, onCta }) {
  return (
    <Card style={{ textAlign: 'center', padding: 44, maxWidth: 560, margin: '0 auto' }}>
      <div style={{ width: 52, height: 52, borderRadius: 14, margin: '0 auto 14px', background: 'var(--inset)', border: '1px solid var(--inset-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t3)' }}><Icon name={icon} size={24} /></div>
      <div style={{ fontSize: 17, fontWeight: 700 }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--t3)', marginTop: 8, lineHeight: 1.6 }}>{body}</div>
      {cta && <button className="btn btn-acc" style={{ marginTop: 16 }} onClick={onCta}>{cta}</button>}
    </Card>
  );
}

/** Section toolbar: title block on the left, actions on the right. */
export function LoadingCard({ label = 'Loading…' }) {
  return <Card style={{ textAlign: 'center', padding: 44, color: 'var(--t3)' }}>{label}</Card>;
}
