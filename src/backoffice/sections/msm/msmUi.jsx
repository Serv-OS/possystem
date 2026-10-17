// src/backoffice/sections/msm/msmUi.jsx
//
// MULTI SITE MENU (v5.11.75): small shared pieces for the screens, in the ServOS look (the Back
// Office theme tokens in src/styles/globals.css). No data, no rules: those live in src/lib/msm.

import { useEffect, useRef, useState } from 'react';
import { ui } from './msmStyle';

export function Btn({ kind = 'ghost', small = false, children, style, ...rest }) {
  const kinds = {
    primary: { background: 'var(--acc)', color: '#0b0c10', border: '1px solid var(--acc)' },
    ghost: { background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
    soft: { background: 'var(--bg3)', color: 'var(--t1)', border: '1px solid var(--bdr)' },
    danger: { background: 'transparent', color: 'var(--red)', border: '1px solid var(--red-b)' },
    link: { background: 'transparent', color: 'var(--acc)', border: '1px solid transparent', padding: small ? '2px 4px' : '4px 6px' },
  };
  return (
    <button type="button" {...rest} style={{
      padding: small ? '5px 10px' : '8px 14px', borderRadius: 9, cursor: rest.disabled ? 'default' : 'pointer',
      fontSize: small ? 12 : 13, fontWeight: 700, fontFamily: 'inherit', whiteSpace: 'nowrap',
      opacity: rest.disabled ? 0.5 : 1, ...kinds[kind], ...style,
    }}>{children}</button>
  );
}

export function Pill({ tone = 'neutral', children, title, style }) {
  const tones = {
    neutral: { background: 'var(--bg3)', color: 'var(--t2)' },
    acc: { background: 'var(--acc-d)', color: 'var(--acc)' },
    good: { background: 'var(--acc-d)', color: 'var(--acc)' },
    warn: { background: 'color-mix(in srgb, var(--amber, #F5A623) 16%, transparent)', color: 'var(--amber, #F5A623)' },
    bad: { background: 'var(--red-d)', color: 'var(--red)' },
    blue: { background: 'var(--blu-d)', color: 'var(--blu)' },
  };
  return <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', ...tones[tone], ...style }}>{children}</span>;
}

/** An on or off switch. */
export function Switch({ on, onChange, disabled, small = false, title }) {
  const w = small ? 26 : 34, h = small ? 15 : 19;
  return (
    <button type="button" role="switch" aria-checked={!!on} title={title} disabled={disabled}
      onClick={(e) => { e.stopPropagation(); if (!disabled) onChange?.(!on); }}
      style={{ width: w, height: h, borderRadius: h, border: 'none', padding: 2, cursor: disabled ? 'default' : 'pointer', flexShrink: 0,
        background: on ? 'var(--acc)' : 'var(--bg4, var(--bg3))', opacity: disabled ? 0.55 : 1, transition: 'background .15s', display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start' }}>
      <span style={{ width: h - 4, height: h - 4, borderRadius: '50%', background: on ? '#0b0c10' : 'var(--t3)', display: 'block' }} />
    </button>
  );
}

/** A row of buttons where one is chosen. */
export function Segmented({ value, options, onChange, small = false }) {
  return (
    <div style={{ display: 'inline-flex', background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 10, padding: 2, gap: 2 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={String(o.value)} type="button" onClick={() => onChange(o.value)} title={o.title}
            style={{ padding: small ? '4px 9px' : '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: small ? 12 : 12.5, fontWeight: 700,
              background: on ? 'var(--bg4, var(--bg3))' : 'transparent', color: on ? 'var(--t1)' : 'var(--t3)' }}>{o.label}</button>
        );
      })}
    </div>
  );
}

/** A panel that slides in from the right. */
export function Sheet({ title, sub, onClose, width = 560, children, footer }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.38)' }} />
      <div role="dialog" aria-label={title} style={{ position: 'relative', width: `min(${width}px, 100vw)`, height: '100%', background: 'var(--bg1)', borderLeft: '1px solid var(--bdr)', boxShadow: 'var(--sh3, var(--sh))', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-.01em' }}>{title}</div>
            {sub && <div style={{ ...ui.sub, marginTop: 3 }}>{sub}</div>}
          </div>
          <Btn small onClick={onClose} aria-label="Close">Close</Btn>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>{children}</div>
        {footer && <div style={{ padding: '14px 20px', borderTop: '1px solid var(--bdr)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{footer}</div>}
      </div>
    </div>
  );
}

/** A centred dialog. */
export function Modal({ title, sub, onClose, width = 760, children, footer }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.45)' }} />
      <div role="dialog" aria-label={title} style={{ position: 'relative', width: `min(${width}px, 100%)`, maxHeight: 'calc(100vh - 32px)', background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 16, boxShadow: 'var(--sh3, var(--sh))', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '18px 22px 12px', borderBottom: '1px solid var(--bdr)', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-.01em' }}>{title}</div>
            {sub && <div style={{ ...ui.sub, marginTop: 3 }}>{sub}</div>}
          </div>
          <Btn small onClick={onClose}>Close</Btn>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 22px' }}>{children}</div>
        {footer && <div style={{ padding: '14px 22px', borderTop: '1px solid var(--bdr)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{footer}</div>}
      </div>
    </div>
  );
}

/** A button that opens a small panel under it (closes on a click outside or Escape). */
export function Popover({ label, children, align = 'left', disabled, kind = 'ghost', small = true, width = 280 }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const click = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', click);
    window.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', click); window.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <Btn kind={kind} small={small} disabled={disabled} onClick={() => setOpen((o) => !o)}>{label}</Btn>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', [align]: 0, zIndex: 40, width, background: 'var(--bg1)', border: '1px solid var(--bdr2)', borderRadius: 12, boxShadow: 'var(--sh3, var(--sh))', padding: 12 }}>
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  );
}

/** Tick boxes for sites, with All and None, and saved groups of sites as shortcuts. */
export function SiteChecklist({ sites, value, onChange, groups = [] }) {
  const set = new Set(value);
  const toggle = (id) => { const s = new Set(set); if (s.has(id)) s.delete(id); else s.add(id); onChange([...s]); };
  return (
    <div>
      <div style={{ ...ui.row, marginBottom: 8, flexWrap: 'wrap' }}>
        <Btn small kind="soft" onClick={() => onChange(sites.map((s) => s.id))}>All</Btn>
        <Btn small kind="soft" onClick={() => onChange([])}>None</Btn>
        {groups.map((g) => <Btn key={g.id} small kind="soft" onClick={() => onChange((g.location_ids || []).filter((l) => sites.some((s) => s.id === l)))}>{g.name}</Btn>)}
      </div>
      <div style={{ display: 'grid', gap: 2, maxHeight: 240, overflowY: 'auto' }}>
        {sites.map((s) => (
          <label key={s.id} style={{ ...ui.row, padding: '5px 4px', fontSize: 13, cursor: 'pointer', borderRadius: 6 }}>
            <input type="checkbox" checked={set.has(s.id)} onChange={() => toggle(s.id)} />
            <span>{s.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/** A message strip: tone good, warn or bad. */
export function Notice({ tone = 'warn', children, onClose }) {
  const tones = {
    good: { background: 'var(--acc-d)', color: 'var(--t1)', border: '1px solid var(--acc-b, var(--acc))' },
    warn: { background: 'color-mix(in srgb, var(--amber, #F5A623) 12%, transparent)', color: 'var(--t1)', border: '1px solid color-mix(in srgb, var(--amber, #F5A623) 45%, transparent)' },
    bad: { background: 'var(--red-d)', color: 'var(--t1)', border: '1px solid var(--red-b)' },
  };
  return (
    <div role="status" style={{ ...tones[tone], borderRadius: 10, padding: '9px 12px', fontSize: 13, lineHeight: 1.45, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <div style={{ flex: 1 }}>{children}</div>
      {onClose && <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit' }}>Dismiss</button>}
    </div>
  );
}

/** A labelled field. */
export function Field({ label, hint, children, style }) {
  return (
    <div style={{ marginBottom: 14, ...style }}>
      {label && <span style={ui.label}>{label}</span>}
      {children}
      {hint && <div style={{ ...ui.sub, fontSize: 11.5, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

/**
 * A long list where only the rows on screen are drawn (fixed row height), for the publish preview,
 * the price spread and the spreadsheet import. `renderRow(item, index)` returns one row.
 */
export function WindowedList({ items, rowHeight = 34, height = 380, renderRow, empty = null, style }) {
  const [top, setTop] = useState(0);
  const list = items || [];
  if (!list.length) return empty;
  const h = Math.min(height, list.length * rowHeight);
  const first = Math.max(0, Math.floor(top / rowHeight) - 6);
  const last = Math.min(list.length, Math.ceil((top + h) / rowHeight) + 6);
  return (
    <div onScroll={(e) => setTop(e.currentTarget.scrollTop)} style={{ height: h, overflowY: 'auto', position: 'relative', ...style }}>
      <div style={{ height: list.length * rowHeight, position: 'relative' }}>
        {list.slice(first, last).map((item, i) => (
          <div key={first + i} style={{ position: 'absolute', top: (first + i) * rowHeight, left: 0, right: 0, height: rowHeight }}>
            {renderRow(item, first + i)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A small number in a circle, for tab badges. */
export function Count({ n, tone = 'acc' }) {
  if (!n) return null;
  const bg = tone === 'bad' ? 'var(--red)' : tone === 'blue' ? 'var(--blu)' : 'var(--acc)';
  return <span style={{ marginLeft: 6, minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9, background: bg, color: '#0b0c10', fontSize: 11, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box' }}>{n}</span>;
}
