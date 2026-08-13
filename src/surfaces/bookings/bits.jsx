// src/surfaces/bookings/bits.jsx
//
// Table Bookings — tiny shared bits for the host-stand screens. Pure
// presentation helpers only: status derivation, token tints, steppers,
// toggles and chips. No store access, no DB.

import { useEffect, useState } from 'react';
import { toMin, DEFAULT_TURN_BANDS, DEFAULT_RULES } from '../../lib/bookings/optimiser.js';

export const mono = { fontFamily: 'var(--font-mono)' };

// -d / -b tints for tokens that only ship as a base colour (orn / uv / t3…).
export const tintBg = (col, pct = 13) => `color-mix(in srgb, ${col} ${pct}%, transparent)`;
export const tintBd = (col, pct = 32) => `color-mix(in srgb, ${col} ${pct}%, transparent)`;

// ── rules with defaults (screens must tolerate bookingRules === null) ─────────
export const FALLBACK_RULES = {
  ...DEFAULT_RULES,
  turnBands: DEFAULT_TURN_BANDS,
  serviceStart: '17:00',
  serviceEnd: '23:00',
  slotMinutes: 15,
  holdPerCover: 20,
  cancellationWindowHours: 24,
  protectLargeTables: true,
  pacingOverrideRequiresPin: true,
  joinGroups: [],
};
export const rulesOf = (r) => ({
  ...FALLBACK_RULES,
  ...(r || {}),
  turnBands: { ...DEFAULT_TURN_BANDS, ...(r?.turnBands || {}) },
});

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// live minute-of-day ticker (30s granularity is plenty for a diary)
export function useNowMin(intervalMs = 30000) {
  const calc = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const [now, setNow] = useState(calc);
  useEffect(() => {
    const t = setInterval(() => setNow(calc()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

// ── status derivation ─────────────────────────────────────────────────────────
// nowMin === null ⇒ the diary is showing a day that is not today, so the
// late / due clock states do not apply.
export const DUE_WINDOW = 15; // minutes before start that reads "due now"

export function displayStatus(b, nowMin, packages = []) {
  if (!b) return 'confirmed';
  if (b.status && b.status !== 'confirmed') return b.status; // dining / departed / no_show / cancelled
  const start = toMin(String(b.startTime || '').slice(0, 5));
  if (Number.isFinite(nowMin)) {
    if (nowMin > start) return 'late';                       // past arrival, not seated
    if (nowMin >= start - DUE_WINDOW) return 'due';          // inside the grace window
  }
  const pkg = b.packageId ? (packages || []).find((p) => p.id === b.packageId) : null;
  if (pkg?.paymentModel === 'prepay') return 'prepaid';
  return 'confirmed';
}

export const STATUS_META = {
  departed:  { col: 'var(--t3)',  label: 'Departed' },
  dining:    { col: 'var(--acc)', label: 'Dining' },
  late:      { col: 'var(--red)', label: 'Late' },
  due:       { col: 'var(--orn)', label: 'Due now' },
  confirmed: { col: 'var(--uv)',  label: 'Confirmed' },
  prepaid:   { col: 'var(--grn)', label: 'Prepaid' },
  no_show:   { col: 'var(--t4)',  label: 'No-show' },
  cancelled: { col: 'var(--t4)',  label: 'Cancelled' },
};
export const statusMeta = (key) => STATUS_META[key] || STATUS_META.confirmed;

// The one status pill — diary inspector + diary list rows render the same badge
// from the same status→colour map above.
export function StatusBadge({ st, style = {} }) {
  const meta = statusMeta(st);
  return (
    <span className="badge" style={{
      background: tintBg(meta.col), border: `1px solid ${tintBd(meta.col)}`, color: meta.col,
      borderRadius: 20, padding: '3px 10px', fontSize: 10, fontWeight: 700, ...style,
    }}>{meta.label}</span>
  );
}

export const isDead = (b) => !b || b.status === 'cancelled' || b.status === 'no_show';
export const isLive = (b) => !isDead(b) && b.status !== 'departed';

export const bookingName = (b) => b?.customer?.name || (b?.source === 'walk_in' ? 'Walk-in' : `Party of ${b?.covers || '?'}`);

// ── formatting ────────────────────────────────────────────────────────────────
export const money = (n, dp = 0) => `£${Number(n || 0).toFixed(dp)}`;
export const initialsOf = (name) =>
  String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';

export const sessionTotal = (session) =>
  (session?.items || []).reduce((s, i) => {
    const mods = (i.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
    return s + ((Number(i.price) || 0) + mods) * (Number(i.qty) || 1);
  }, 0);

// ── tiny controls ─────────────────────────────────────────────────────────────
export function Chip({ active, danger, disabled, onClick, style = {}, children, title }) {
  const col = danger ? 'var(--red)' : 'var(--acc)';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        minWidth: 40, height: 38, padding: '0 12px', borderRadius: 10, cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700,
        background: active ? tintBg(col) : 'var(--inset, var(--bg3))',
        border: `1.5px solid ${active ? tintBd(col) : 'var(--bdr)'}`,
        color: disabled ? 'var(--t4)' : active ? col : 'var(--t2)',
        transition: 'all 140ms cubic-bezier(.2,.8,.3,1)',
        ...style,
      }}
    >{children}</button>
  );
}

export function Stepper({ label, sub, value, onChange, step = 1, min = 0, max = 999, fmt = (v) => v }) {
  const clamp = (v) => Math.min(max, Math.max(min, v));
  const btn = {
    width: 32, height: 32, borderRadius: 9, background: 'var(--bg3)', border: '1px solid var(--bdr2)',
    color: 'var(--t1)', fontSize: 16, fontWeight: 700, cursor: 'pointer', display: 'grid', placeItems: 'center',
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--bdr)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2, lineHeight: 1.4 }}>{sub}</div>}
      </div>
      <button style={btn} onClick={() => onChange(clamp(Number(value) - step))} aria-label={`decrease ${label}`}>−</button>
      <div style={{ minWidth: 58, textAlign: 'center', fontSize: 15, fontWeight: 800, color: 'var(--t1)', ...mono }}>{fmt(value)}</div>
      <button style={btn} onClick={() => onChange(clamp(Number(value) + step))} aria-label={`increase ${label}`}>+</button>
    </div>
  );
}

export function ToggleRow({ label, sub, on, onToggle }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--bdr)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2, lineHeight: 1.4 }}>{sub}</div>}
      </div>
      <button
        onClick={onToggle}
        aria-pressed={!!on}
        style={{
          width: 44, height: 26, borderRadius: 999, border: '1px solid var(--bdr2)', cursor: 'pointer',
          background: on ? 'var(--acc)' : 'var(--bg5)', position: 'relative', transition: 'background 180ms',
          flexShrink: 0, padding: 0,
        }}
      >
        <span style={{
          position: 'absolute', top: 2, left: on ? 21 : 2, width: 20, height: 20, borderRadius: 999,
          background: 'var(--white, var(--t1))', transition: 'left 180ms', boxShadow: 'var(--sh)',
        }} />
      </button>
    </div>
  );
}

export function SectionTitle({ n, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
      {n != null && (
        <span style={{
          width: 22, height: 22, borderRadius: 999, display: 'grid', placeItems: 'center', flexShrink: 0,
          background: tintBg('var(--acc)'), border: `1px solid ${tintBd('var(--acc)')}`,
          color: 'var(--acc)', fontSize: 11, fontWeight: 800, ...mono,
        }}>{n}</span>
      )}
      <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--t1)', letterSpacing: '-0.01em' }}>{children}</span>
    </div>
  );
}

export function EmptyNote({ title, sub }) {
  return (
    <div className="sv-glass" style={{ padding: '30px 20px', textAlign: 'center', borderRadius: 18 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t2)' }}>{title}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 6, ...mono }}>{sub}</div>}
    </div>
  );
}


// ── pre-order state for a booking (Peter, 13 Aug: "needs to be clear what
// package someone has booked and if they haven't done their pre order").
// complete = one choice per guest per choice-course. null = no choices needed.
export function preorderStateFor(b, packages = []) {
  if (!b?.packageId) return null;
  const pkg = packages.find((p) => p.id === b.packageId);
  if (!pkg?.requiresPreorder) return null;
  const groups = new Set((pkg.lines || []).filter((l) => l.isPreorderChoice).map((l) => l.course ?? 0));
  if (!groups.size) return null;
  const needed = groups.size * (b.covers || 1);
  const have = b.preorderCount || 0;
  if (have >= needed) return { state: 'complete', have, needed };
  if (have > 0) return { state: 'partial', have, needed };
  return { state: 'missing', have: 0, needed };
}
