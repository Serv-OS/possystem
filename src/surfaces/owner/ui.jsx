// src/surfaces/owner/ui.jsx: the small pieces the Owner app's screens share.
// Plain HTML and one SVG line, the way Back Office draws its reports
// (src/backoffice/sections/reports/_charts.jsx). No chart library.

import { periodChip, periodChipOn } from './style';

/** One report: a titled card. `note` is the grey line under the title. */
export function ReportCard({ title, note, children }) {
  return (
    <section style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 16, padding: 16, marginBottom: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 800 }}>{title}</div>
      {note && <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 2 }}>{note}</div>}
      <div style={{ marginTop: 12 }}>{children}</div>
    </section>
  );
}

/** The grey line a report shows when it has nothing to draw. */
export function Empty({ children }) {
  return <div style={{ fontSize: 13, color: 'var(--t3)' }}>{children}</div>;
}

/** A row with a name, a figure on the right and a bar under them. `w` is 0 to 1. */
export function BarLine({ label, sub, value, w, color = 'var(--acc)' }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13 }}>
        <span style={{ color: 'var(--t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ flexShrink: 0, fontWeight: 700 }}>{value}{sub && <span style={{ color: 'var(--t4)', fontWeight: 600 }}> · {sub}</span>}</span>
      </div>
      <div style={{ height: 6, background: 'var(--bg3)', borderRadius: 99, marginTop: 4, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.round((w || 0) * 100)}%`, background: color, borderRadius: 99 }} />
      </div>
    </div>
  );
}

/** A small two or three way switch inside a card. */
export function Tabs({ options, value, onChange, label }) {
  return (
    <div role="group" aria-label={label} style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
      {options.map((o) => (
        <button key={o.id} onClick={() => onChange(o.id)} aria-pressed={value === o.id}
          style={{ ...periodChip, padding: '6px 12px', fontSize: 12, ...(value === o.id ? periodChipOn : null) }}>{o.label}</button>
      ))}
    </div>
  );
}
