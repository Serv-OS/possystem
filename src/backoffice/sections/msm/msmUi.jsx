// src/backoffice/sections/msm/msmUi.jsx
//
// MULTI SITE MENU (v5.11.75): small shared pieces for the screens, in the ServOS look (the Back
// Office theme tokens in src/styles/globals.css). No data, no rules: those live in src/lib/msm.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
      opacity: rest.disabled ? 0.5 : 1, ...kinds[kind],
      // A grey main button reads as "not yet" (the warnings still need a tick), never as ready.
      ...(rest.disabled && kind === 'primary' ? { background: 'var(--bg3)', color: 'var(--t3)', border: '1px solid var(--bdr2)', opacity: 0.85 } : {}),
      ...style,
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

/**
 * The in app "are you sure". window.confirm shows nothing in the iPad apps (their web view has no
 * confirm panel, so it answers false and the button silently does nothing) and a grey browser
 * box in Safari. This is a ServOS dialog with the action written on its button.
 */
export function ConfirmDialog({ title, words, yes = 'Yes', no = 'Go back', danger = false, onYes, onNo }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onNo?.(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onNo]);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 95, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={onNo} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.5)' }} />
      <div role="alertdialog" aria-modal="true" aria-label={title} style={{ position: 'relative', width: 'min(440px, 100%)', background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 16, boxShadow: 'var(--sh3, var(--sh))', padding: '20px 22px' }}>
        <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-.01em' }}>{title}</div>
        {words && <div style={{ ...ui.sub, marginTop: 8, fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-line' }}>{words}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18, flexWrap: 'wrap' }}>
          <Btn onClick={onNo}>{no}</Btn>
          <Btn kind={danger ? 'danger' : 'primary'} onClick={onYes} autoFocus>{yes}</Btn>
        </div>
      </div>
    </div>
  );
}

// Closing a panel with unsaved typing asks first (Escape, a tap outside, or Close).
function useGuardedClose(onClose, dirty, dirtyWords) {
  const [asking, setAsking] = useState(false);
  const request = useCallback(() => { if (dirty) setAsking(true); else onClose?.(); }, [dirty, onClose]);
  const dialog = asking ? (
    <ConfirmDialog title="Close without saving?" words={dirtyWords || 'What you typed here is lost.'} yes="Close it" no="Keep editing" danger
      onYes={() => { setAsking(false); onClose?.(); }} onNo={() => setAsking(false)} />
  ) : null;
  return { request, asking, dialog };
}

/** A panel that slides in from the right. dirty: closing asks first. */
export function Sheet({ title, sub, onClose, width = 560, children, footer, dirty = false, dirtyWords }) {
  const guard = useGuardedClose(onClose, dirty, dirtyWords);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape' && !guard.asking) guard.request(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [guard]);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', justifyContent: 'flex-end' }}>
      {guard.dialog}
      <div onClick={guard.request} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.38)' }} />
      <div role="dialog" aria-label={title} style={{ position: 'relative', width: `min(${width}px, 100vw)`, height: '100%', background: 'var(--bg1)', borderLeft: '1px solid var(--bdr)', boxShadow: 'var(--sh3, var(--sh))', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-.01em' }}>{title}</div>
            {sub && <div style={{ ...ui.sub, marginTop: 3 }}>{sub}</div>}
          </div>
          <Btn small onClick={guard.request} aria-label="Close">Close</Btn>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>{children}</div>
        {footer && <div style={{ padding: '14px 20px', borderTop: '1px solid var(--bdr)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{footer}</div>}
      </div>
    </div>
  );
}

/** A centred dialog. dirty: closing asks first. */
export function Modal({ title, sub, onClose, width = 760, children, footer, dirty = false, dirtyWords }) {
  const guard = useGuardedClose(onClose, dirty, dirtyWords);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape' && !guard.asking) guard.request(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [guard]);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      {guard.dialog}
      <div onClick={guard.request} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.45)' }} />
      <div role="dialog" aria-label={title} style={{ position: 'relative', width: `min(${width}px, 100%)`, maxHeight: 'calc(100vh - 32px)', background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 16, boxShadow: 'var(--sh3, var(--sh))', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '18px 22px 12px', borderBottom: '1px solid var(--bdr)', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-.01em' }}>{title}</div>
            {sub && <div style={{ ...ui.sub, marginTop: 3 }}>{sub}</div>}
          </div>
          <Btn small onClick={guard.request}>Close</Btn>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 22px' }}>{children}</div>
        {footer && <div style={{ padding: '14px 22px', borderTop: '1px solid var(--bdr)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{footer}</div>}
      </div>
    </div>
  );
}

/**
 * A button that opens a small panel under it (closes on a click outside or Escape).
 *
 * Peter's UI issue 1 (17 Oct 2026): the Sites panel opened UNDER the grid's sticky header, which
 * hid every site but the first. The panel is now drawn in a portal on document.body, fixed to the
 * screen at the button's place, above every sticky cell, sheet and dialog (z-index 200), and it
 * follows the button when the page or the grid scrolls. A panel that would run off the bottom of
 * the screen opens above the button instead (iPad in landscape).
 */
export function Popover({ label, children, align = 'left', disabled, kind = 'ghost', small = true, width = 280, title, testId }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  const place = useCallback(() => {
    const el = btnRef.current;
    if (!el || typeof window === 'undefined') return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const w = Math.min(width, vw - 16);
    let left = align === 'right' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    const below = vh - r.bottom - 14;
    const above = r.top - 14;
    const up = below < 220 && above > below;
    setPos(up
      ? { left, bottom: vh - r.top + 6, width: w, maxHeight: Math.max(140, above) }
      : { left, top: r.bottom + 6, width: w, maxHeight: Math.max(140, below) });
  }, [align, width]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (e) => {
      if (btnRef.current && btnRef.current.contains(e.target)) return;
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    const move = () => place();
    document.addEventListener('mousedown', outside);
    document.addEventListener('touchstart', outside, { passive: true });
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', move);
    window.addEventListener('scroll', move, true);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('touchstart', outside);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', move);
      window.removeEventListener('scroll', move, true);
    };
  }, [open, place]);
  const close = () => setOpen(false);
  const panel = open && pos && typeof document !== 'undefined' ? createPortal(
    <div ref={panelRef} role="dialog" aria-label={typeof label === 'string' ? label : undefined} data-msm-popover="1"
      style={{ position: 'fixed', zIndex: 200, left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxHeight, overflowY: 'auto', boxSizing: 'border-box',
        background: 'var(--bg1)', border: '1px solid var(--bdr2)', borderRadius: 12, boxShadow: 'var(--sh3, 0 12px 32px rgba(0,0,0,.35))', padding: 12, color: 'var(--t1)', fontFamily: 'inherit' }}>
      {typeof children === 'function' ? children(close) : children}
    </div>, document.body) : null;
  return (
    <span ref={btnRef} style={{ display: 'inline-block' }}>
      <Btn kind={kind} small={small} disabled={disabled} title={title} aria-expanded={open} data-testid={testId} onClick={() => { if (!open) place(); setOpen(!open); }}>{label}</Btn>
      {panel}
    </span>
  );
}

/** A "More" style menu: a Popover whose items are plain rows. items: [{ label, hint, onClick, disabled, why }]. */
export function MenuButton({ label = 'More', items, align = 'right', width = 280, kind = 'ghost', small = true }) {
  return (
    <Popover label={label} align={align} width={width} kind={kind} small={small}>
      {(close) => (
        <div style={{ display: 'grid', gap: 2, margin: -6 }}>
          {items.filter(Boolean).map((it) => (
            <button key={it.label} type="button" disabled={it.disabled} title={it.disabled ? it.why : undefined}
              onClick={() => { close(); it.onClick?.(); }}
              style={{ textAlign: 'left', background: 'transparent', border: 'none', borderRadius: 8, padding: '8px 10px', cursor: it.disabled ? 'default' : 'pointer', fontFamily: 'inherit', color: 'var(--t1)', opacity: it.disabled ? 0.5 : 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{it.label}</div>
              {(it.hint || (it.disabled && it.why)) && <div style={{ ...ui.sub, fontSize: 11.5 }}>{it.disabled && it.why ? it.why : it.hint}</div>}
            </button>
          ))}
        </div>
      )}
    </Popover>
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

/**
 * A message strip: tone good, warn, bad or info. actions: [{ label, onClick }] drawn as buttons on
 * the strip (every staged note carries its own way on: [Undo], [Review and publish]).
 */
export function Notice({ tone = 'warn', children, onClose, actions = null }) {
  const tones = {
    good: { background: 'var(--acc-d)', color: 'var(--t1)', border: '1px solid var(--acc-b, var(--acc))' },
    warn: { background: 'color-mix(in srgb, var(--amber, #F5A623) 12%, transparent)', color: 'var(--t1)', border: '1px solid color-mix(in srgb, var(--amber, #F5A623) 45%, transparent)' },
    bad: { background: 'var(--red-d)', color: 'var(--t1)', border: '1px solid var(--red-b)' },
    info: { background: 'var(--blu-d, var(--bg2))', color: 'var(--t1)', border: '1px solid color-mix(in srgb, var(--blu, #4A8CFF) 40%, transparent)' },
  };
  const list = (actions || []).filter(Boolean);
  return (
    <div role="status" style={{ ...(tones[tone] || tones.warn), borderRadius: 10, padding: '9px 12px', fontSize: 13, lineHeight: 1.45, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 240px', minWidth: 0 }}>{children}</div>
      {list.map((a) => <Btn key={a.label} small kind={a.kind || 'soft'} onClick={a.onClick} disabled={a.disabled}>{a.label}</Btn>)}
      {onClose && <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit' }}>Dismiss</button>}
    </div>
  );
}

/**
 * "What this does": the sentence summary shown before Add to draft and before Publish (design 6.4,
 * lib/msm/msmSummary.js makes the sentences).
 */
export function SummaryBox({ lines, title = 'What this does', empty = null }) {
  const list = (lines || []).filter(Boolean);
  if (!list.length) return empty;
  return (
    <div data-testid="msm-summary" style={{ background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '10px 14px' }}>
      <div style={{ ...ui.label, marginBottom: 4 }}>{title}</div>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 3 }}>
        {list.slice(0, 12).map((l, i) => <li key={i} style={{ fontSize: 13, lineHeight: 1.45, color: 'var(--t1)' }}>{l}</li>)}
      </ul>
      {list.length > 12 && <div style={{ ...ui.sub, marginTop: 4 }}>And {list.length - 12} more.</div>}
    </div>
  );
}

/**
 * Warnings that need a tick (design 6.5, lib/msm/msmRisk.js riskChecks). The button that goes on
 * stays grey until every one is ticked (msmRisk.allTicked). A risk may carry an action, such as
 * "Schedule for tonight 23:00 instead": onAction(risk) is called for it.
 */
export function ConfirmTicks({ risks, ticked, onChange, onAction = null, actionLabel = null }) {
  const list = (risks || []).filter(Boolean);
  if (!list.length) return null;
  const set = ticked instanceof Set ? ticked : new Set();
  const flip = (k) => { const n = new Set(set); if (n.has(k)) n.delete(k); else n.add(k); onChange(n); };
  return (
    <div data-testid="msm-risks" style={{ border: '1px solid color-mix(in srgb, var(--amber, #F5A623) 50%, transparent)', background: 'color-mix(in srgb, var(--amber, #F5A623) 8%, transparent)', borderRadius: 12, padding: '10px 14px' }}>
      <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 2 }}>Please check {list.length === 1 ? 'this' : `these ${list.length}`} before you go on</div>
      <div style={{ ...ui.sub, marginBottom: 8 }}>Tick each one to say you meant it. Nothing reaches the tills until you publish.</div>
      {list.map((r) => (
        <label key={r.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '5px 0', fontSize: 13, cursor: 'pointer', borderTop: '1px solid var(--bdr)' }}>
          <input type="checkbox" checked={set.has(r.key)} onChange={() => flip(r.key)} style={{ marginTop: 3 }} />
          <span style={{ flex: 1 }}>{r.words}</span>
          {r.action && onAction && <Btn small kind="soft" onClick={(e) => { e.preventDefault(); onAction(r); }}>{actionLabel ? actionLabel(r) : 'Do that instead'}</Btn>}
        </label>
      ))}
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
