// src/backoffice/sections/headoffice/hqUi.jsx
//
// Head office hub: the small shared pieces every hub screen uses (stat tile, pill, status
// badge, progress bar, section heading, the one calm "not set up yet" card) and the words for
// money and dates in the venue's own locale. Inline styles with the Back Office CSS variables,
// the same ones Operations and Workforce read. No CSS file of its own.

import { Icon } from '../../../components/ServOSIcons';
import { PROJECT_STATUSES, departmentLabel } from '../../../lib/hq/departments.js';
import { shortMoney } from '../../../lib/hq/primeCost.js';

/** A one shot hand off between hub screens: which Daily numbers tab to open, which department
 *  a new project starts in. Read once on mount and cleared by the screen that reads it. */
export const hqHandoff = { numbersTab: null, projectDept: null };

// ── Styles ───────────────────────────────────────────────────────────────────
export const mono = { fontFamily: 'var(--font-mono)' };
export const page = { height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px', boxSizing: 'border-box' };
export const card = { background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '14px 16px' };
export const field = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' };
export const lbl = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 };
export const btn = { padding: '8px 14px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600 };
export const accBtn = { padding: '9px 16px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 0, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
export const smallBtn = { ...btn, padding: '5px 10px', fontSize: 12 };
export const linkBtn = { background: 'none', border: 0, padding: 0, color: 'var(--acc)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600 };
export const tabBtn = (on) => ({ ...btn, background: on ? 'var(--acc-d)' : 'var(--bg2)', color: on ? 'var(--acc)' : 'var(--t2)', borderColor: on ? 'var(--acc)' : 'var(--bdr2)' });
export const th = { padding: '10px 10px', textAlign: 'left', ...mono, fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--bdr)' };
export const td = { padding: '10px 10px', borderBottom: '1px solid var(--bdr)', verticalAlign: 'middle', fontSize: 13, color: 'var(--t1)' };
export const disabled = (on) => (on ? { opacity: 0.55, cursor: 'default' } : null);

const TONE_COLOR = { grn: 'var(--grn)', orn: 'var(--orn)', red: 'var(--red)', acc: 'var(--acc)', t3: 'var(--t3)', t4: 'var(--t4)', t2: 'var(--t2)' };
export const toneColor = (tone) => TONE_COLOR[tone] || 'var(--t2)';

// ── Words for figures ────────────────────────────────────────────────────────
/** The venue's locale from its currency: a US venue reads en-US, every other venue en-GB. */
export const localeFor = (currency) => (String(currency || '').toUpperCase() === 'USD' ? 'en-US' : 'en-GB');

export const NA = 'n/a';
const isNil = (v) => v === null || v === undefined || v === '' || Number.isNaN(Number(v));

/** "$7.9k" for the big tiles, n/a when there is nothing. */
export const bigMoney = (n, currency) => (isNil(n) ? NA : shortMoney(n, currency || 'USD'));

/** The exact figure, "$5,230" or "£5,230.50", n/a when there is nothing. */
export function exactMoney(n, currency, dp = 0) {
  if (isNil(n)) return NA;
  try {
    return new Intl.NumberFormat(localeFor(currency), { style: 'currency', currency: currency || 'USD', minimumFractionDigits: dp, maximumFractionDigits: dp }).format(Number(n));
  } catch { return `${Number(n).toFixed(dp)}`; }
}

/** "58.7%" or n/a. */
export const pct = (n, dp = 1) => (isNil(n) ? NA : `${Number(n).toFixed(dp)}%`);

/** A plain number with the venue's thousands separator. */
export const num = (n, dp = 0) => (isNil(n) ? NA : new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dp }).format(Number(n)));

/** "+4.2%" or "-1.8%" for a comparison. */
export const signedPct = (n, dp = 1) => (isNil(n) ? NA : `${Number(n) > 0 ? '+' : ''}${Number(n).toFixed(dp)}%`);

/** A calendar day ('YYYY-MM-DD' or a timestamp) in the venue's words: "Nov 16, 2026" or "16 Nov 2026". */
export function dateText(iso, currency, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!iso) return NA;
  const s = String(iso);
  const d = s.length === 10 ? new Date(`${s}T12:00:00`) : new Date(s);
  if (Number.isNaN(d.getTime())) return NA;
  return d.toLocaleDateString(localeFor(currency), opts);
}

/** A timestamp with its time, for a feed. */
export function dateTimeText(iso, currency) {
  if (!iso) return NA;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NA;
  return d.toLocaleString(localeFor(currency), { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

/** Today as 'YYYY-MM-DD' from the local date parts (never toISOString, which is a UTC day). */
export function localYmd(d = new Date()) {
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

/** 'YYYY-MM-DD' moved by n days. */
export function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localYmd(d);
}

// ── Pieces ───────────────────────────────────────────────────────────────────
export function PageHead({ title, sub, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 4px', color: 'var(--t1)' }}>{title}</h1>
        {sub && <div style={{ fontSize: 13, color: 'var(--t3)' }}>{sub}</div>}
      </div>
      {right && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{right}</div>}
    </div>
  );
}

export function SectionHead({ title, sub, right, style }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, margin: '22px 0 10px', ...style }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>{title}</div>
        {sub && <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>{sub}</div>}
      </div>
      {right}
    </div>
  );
}

/** One big figure. tone colours the value; note sits under it in small grey text. */
export function StatTile({ label, value, note, tone, icon }) {
  return (
    <div style={{ ...card, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ ...lbl, marginBottom: 0 }}>{label}</div>
        {icon && <Icon name={icon} size={15} style={{ color: 'var(--t4)' }} />}
      </div>
      <div className="mono" style={{ ...mono, fontSize: 26, fontWeight: 700, marginTop: 8, color: tone ? toneColor(tone) : 'var(--t1)', lineHeight: 1.1 }}>{value}</div>
      {note && <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 6 }}>{note}</div>}
    </div>
  );
}

/** A filter pill with an optional count. */
export function Pill({ on, onClick, children, count }) {
  return (
    <button type="button" onClick={onClick} style={{ ...tabBtn(on), padding: '6px 12px', borderRadius: 999, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {children}
      {count !== undefined && count !== null && <span className="mono" style={{ ...mono, fontSize: 11, opacity: 0.8 }}>{count}</span>}
    </button>
  );
}

/** A small toned chip. */
export function Chip({ tone = 't3', children, style }) {
  const c = toneColor(tone);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, color: c, border: `1px solid ${c}`, background: 'transparent', whiteSpace: 'nowrap', ...style }}>{children}</span>
  );
}

/** The project status word, toned from PROJECT_STATUSES. */
export function StatusBadge({ status }) {
  const s = PROJECT_STATUSES.find((x) => x.id === status) || PROJECT_STATUSES.find((x) => x.id === 'planning');
  return <Chip tone={s.tone}>{s.label}</Chip>;
}

export function DepartmentChip({ id }) {
  return <Chip tone="t2">{departmentLabel(id)}</Chip>;
}

export function ProgressBar({ pct: p, tone = 'acc', height = 6 }) {
  const v = Math.max(0, Math.min(100, Number(p) || 0));
  return (
    <div style={{ height, borderRadius: height, background: 'var(--bg3, var(--bdr))', overflow: 'hidden' }}>
      <div style={{ width: `${v}%`, height: '100%', background: toneColor(tone), borderRadius: height, transition: 'width .2s' }} />
    </div>
  );
}

/** The one calm card when the tables are not there yet. */
export function AbsentCard({ message }) {
  return (
    <div style={{ ...card, maxWidth: 560, padding: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>
        <Icon name="info" size={18} style={{ color: 'var(--t3)' }} />
        Head office is not set up in the database yet
      </div>
      <div style={{ fontSize: 13, color: 'var(--t3)', marginTop: 8, lineHeight: 1.6 }}>{message}</div>
    </div>
  );
}

export function EmptyCard({ title, body, children }) {
  return (
    <div style={{ ...card, textAlign: 'center', padding: 28, color: 'var(--t3)' }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t2)' }}>{title}</div>
      {body && <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.6 }}>{body}</div>}
      {children && <div style={{ marginTop: 12 }}>{children}</div>}
    </div>
  );
}

export function LoadingLine({ children = 'Loading' }) {
  return <div style={{ fontSize: 13, color: 'var(--t3)', padding: '10px 0' }}>{children}</div>;
}

/** A quiet amber line for a failure the screen can live with. */
export function AmberLine({ children, style }) {
  if (!children) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--orn)', margin: '8px 0', ...style }}>
      <Icon name="warn" size={14} />
      <span>{children}</span>
    </div>
  );
}

export function GreenLine({ children, style }) {
  if (!children) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--grn)', margin: '8px 0', ...style }}>
      <Icon name="check" size={14} />
      <span>{children}</span>
    </div>
  );
}

/** Horizontal tab row. tabs = [[id, label]]. */
export function TabRow({ tabs, value, onChange, style }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', ...style }}>
      {tabs.map(([id, label]) => <button key={id} type="button" style={tabBtn(value === id)} onClick={() => onChange(id)}>{label}</button>)}
    </div>
  );
}

/** A labelled form row. */
export function Field({ label, children, style }) {
  return (
    <label style={{ display: 'block', ...style }}>
      <span style={lbl}>{label}</span>
      {children}
    </label>
  );
}

/** The site's name for a project or check in: "All sites" when there is no site. */
export function siteName(sites, locationId, none = 'All sites') {
  if (!locationId) return none;
  return (sites || []).find((s) => s.id === locationId)?.name || 'Site';
}

/** A modal sheet over the screen. */
export function Sheet({ title, onClose, children, width = 560 }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 16px', zIndex: 60, overflowY: 'auto' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...card, width: '100%', maxWidth: width, padding: 20, background: 'var(--bg1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--t1)' }}>{title}</div>
          <button type="button" onClick={onClose} style={{ ...smallBtn, border: 0, background: 'transparent', color: 'var(--t3)' }} aria-label="Close"><Icon name="close" size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
