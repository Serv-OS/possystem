// src/backoffice/sections/stock/stockUi.jsx
//
// MULTI SITE STOCK (v5.11.89, Drop 1, contract 4.1): the one look of the company stock screens.
// The Multi site menu pieces are already in the ServOS look, so they are re-exported from here, and
// the table, cell and page pieces the stock screens share are added. Theme tokens only (light and
// dark both work); never a fixed colour other than the token fallbacks; never window.confirm (use
// ConfirmDialog or useConfirm); never a page wide horizontal scroll (TableWrap scrolls inside its
// card). One site companies never reach these screens: their screens are today's files.

import { useEffect, useRef, useState } from 'react';
import {
  Btn, Pill, Switch, Segmented, ConfirmDialog, Sheet, Modal, Popover, MenuButton, Notice, Field, WindowedList, Count,
  SiteChecklist as MsmSiteChecklist,
} from '../msm/msmUi';
import { useConfirm } from '../msm/useConfirm';
import { ui as msmUi } from '../msm/msmStyle';
import { stockApi } from '../../../lib/stock/stockApi';
import { NEEDS_UPDATE } from '../../../lib/stock/saveRules';
import { useStockScope } from '../../StockScope';

// The hook and the styles ride along with the components (contract 3.1): one import for every screen.
// eslint-disable-next-line react-refresh/only-export-components
export { Btn, Pill, Switch, Segmented, ConfirmDialog, Sheet, Modal, Popover, MenuButton, Notice, Field, WindowedList, Count, useConfirm };

/** The shared styles: the Multi site menu's, plus the stock page, table and cell styles. */
// eslint-disable-next-line react-refresh/only-export-components
export const ui = {
  ...msmUi,
  page: { padding: '22px 26px 40px', background: 'var(--bg0)', color: 'var(--t1)', minHeight: '100%', boxSizing: 'border-box' },
  title: { fontSize: 24, fontWeight: 700, color: 'var(--t1)', letterSpacing: '-.01em', margin: 0 },
  pageSub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 },
  th: { textAlign: 'left', padding: '9px 12px', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap', verticalAlign: 'bottom', background: 'var(--bg1)' },
  thHint: { display: 'block', marginTop: 3, fontSize: 11.5, fontWeight: 400, color: 'var(--t4)', textTransform: 'none', letterSpacing: 0, whiteSpace: 'normal', maxWidth: 220 },
  td: { padding: '9px 12px', fontSize: 13, color: 'var(--t1)', borderBottom: '1px solid var(--bdr)', verticalAlign: 'middle', background: 'var(--bg1)' },
  num: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  grey: { color: 'var(--t4)' },
  sticky: { position: 'sticky', left: 0, zIndex: 1, boxShadow: 'inset -1px 0 0 var(--bdr)' },
  lockline: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '10px 14px', borderRadius: 8, background: 'var(--bg2)', color: 'var(--t3)', fontSize: 13 },
  bulk: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '10px 14px', borderRadius: 12, background: 'var(--t1)', color: 'var(--bg1)' },
};

/**
 * Tick boxes for sites with All, None and the site groups (the Multi site menu's SiteChecklist).
 * The stock scope's groups carry locationIds; the menu's carry location_ids. Both are read.
 */
export function SiteChecklist({ sites, value, onChange, groups = [] }) {
  const shaped = (groups || []).map((g) => ({ ...g, location_ids: g.location_ids || g.locationIds || [] }));
  return <MsmSiteChecklist sites={sites} value={value} onChange={onChange} groups={shaped} />;
}

/** The page title (24 px), the sub line under it, the buttons on the right, and a back link. */
export function PageHead({ title, sub, back, onBack, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      {back && onBack && <Btn kind="link" small onClick={onBack} style={{ marginBottom: 6, paddingLeft: 0 }}>{back}</Btn>}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <h1 style={ui.title}>{title}</h1>
          {sub && <div style={ui.pageSub}>{sub}</div>}
        </div>
        {children && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>{children}</div>}
      </div>
    </div>
  );
}

/** Tabs: [{ id, label, count }] or plain labels. */
export function TabBar({ tabs, value, onChange }) {
  const list = (tabs || []).map((t) => (typeof t === 'string' ? { id: t, label: t } : t));
  return (
    <div role="tablist" style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--bdr)', marginBottom: 14, overflowX: 'auto' }}>
      {list.map((t) => {
        const on = t.id === value;
        return (
          <button key={t.id} type="button" role="tab" aria-selected={on} onClick={() => onChange?.(t.id)}
            style={{ padding: '9px 14px', border: 'none', borderBottom: `2px solid ${on ? 'var(--acc)' : 'transparent'}`, background: 'transparent',
              color: on ? 'var(--t1)' : 'var(--t3)', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center' }}>
            {t.label}<Count n={t.count} />
          </button>
        );
      })}
    </div>
  );
}

/** A table that scrolls sideways inside its card, never the page. */
export function TableWrap({ children, minWidth }) {
  return (
    <div style={{ overflowX: 'auto', maxWidth: '100%', border: '1px solid var(--bdr)', borderRadius: 12, background: 'var(--bg1)' }}>
      <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, minWidth: minWidth || undefined }}>{children}</table>
    </div>
  );
}

/** A header cell: 11 px upper case, with a one line hint under it in normal case. */
export function Th({ children, hint, right, sticky }) {
  return (
    <th style={{ ...ui.th, ...(right ? { textAlign: 'right' } : {}), ...(sticky ? { ...ui.sticky, zIndex: 2 } : {}) }}>
      {children}
      {hint && <span style={{ ...ui.thHint, ...(right ? { marginLeft: 'auto' } : {}) }}>{hint}</span>}
    </th>
  );
}

/** A body cell: 13 px; numbers right aligned with tabular figures; grey for "follows the company". */
export function Td({ children, right, num, grey, strong, sticky }) {
  return (
    <td style={{ ...ui.td, ...(right || num ? ui.num : {}), ...(grey ? ui.grey : {}), ...(strong ? { fontWeight: 700 } : {}), ...(sticky ? ui.sticky : {}) }}>{children}</td>
  );
}

/** The small green tick a cell shows for 2 s after a save. */
export function SavedTick() {
  return <span aria-label="Saved" title="Saved" style={{ color: 'var(--acc)', fontWeight: 800, fontSize: 12, marginLeft: 4 }}>✓</span>;
}

const toValue = (text, kind) => {
  if (kind !== 'number') return text;
  const t = String(text ?? '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};
const sameValue = (a, b, kind = 'text') => {
  if (a == null || b == null) return a == null && b == null;
  if (kind === 'number' && Number.isFinite(Number(a)) && Number.isFinite(Number(b))) return Math.abs(Number(a) - Number(b)) < 1e-9;
  return String(a) === String(b);
};
/**
 * The text a cell shows for a value. `places` (a number cell only, integrator Drop 1): money reads
 * '9.60', never '9.6'. A value with more places than that is shown in full, so the box never hides
 * a digit that a save would then drop.
 */
const cellText = (value, kind, places) => {
  if (value == null || value === '') return '';
  if (kind !== 'number' || places == null || !Number.isFinite(Number(value))) return String(value);
  const fixed = Number(value).toFixed(places);
  return Math.abs(Number(fixed) - Number(value)) < 1e-9 ? fixed : String(Number(value));
};

/**
 * A cell that saves when you leave it (or press Enter): onCommit(value) may return a promise of
 * { error } (a refusal: red border and the words under it) or anything else (saved: the tick for
 * 2 s). Escape puts the old value back. Grey text when `follow` (it follows the company value).
 */
export function CellInput({ value, onCommit, disabled, follow, width = 76, ariaLabel, kind = 'number', places = null }) {
  const [draft, setDraft] = useState(null);   // null = not editing: the value is shown
  const [state, setState] = useState(null);   // null | 'busy' | 'saved' | { error }
  const timer = useRef(null);
  const focusText = useRef(null);             // the text when the box was entered: leaving it untouched saves nothing
  const escaped = useRef(false);              // Escape blurs at once, before the cleared draft renders: never save then
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const asText = cellText(value, kind, places);
  const shown = draft != null ? draft : asText;
  const commit = async () => {
    if (escaped.current) { escaped.current = false; setDraft(null); return; }
    if (draft == null) return;
    const typed = draft;
    const next = toValue(draft, kind);
    setDraft(null);
    if (typed === focusText.current) return;
    if (next === undefined) { setState({ error: 'Type a number.' }); return; }
    if (sameValue(next, value, kind)) return;
    setState('busy');
    let r;
    try { r = await onCommit?.(next); } catch (e) { r = { error: e }; }
    if (r && typeof r === 'object' && r.error) {
      setState({ error: r.error?.message || String(r.error) });
      return;
    }
    setState('saved');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(null), 2000);
  };
  const bad = state && typeof state === 'object' && state.error;
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center' }}>
        <input
          type="text" inputMode={kind === 'number' ? 'decimal' : 'text'} aria-label={ariaLabel} disabled={disabled || state === 'busy'}
          value={shown}
          onFocus={() => { focusText.current = asText; setDraft(asText); }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
            if (e.key === 'Escape') { escaped.current = true; setDraft(null); setState(null); e.currentTarget.blur(); }
          }}
          style={{
            width, boxSizing: 'border-box', padding: '5px 8px', borderRadius: 7, fontSize: 13, fontFamily: 'inherit', outline: 'none',
            textAlign: kind === 'number' ? 'right' : 'left', fontVariantNumeric: 'tabular-nums', background: 'var(--bg2)',
            border: `1px solid ${bad ? 'var(--red)' : 'var(--bdr2)'}`, color: follow && draft == null ? 'var(--t4)' : 'var(--t1)',
            opacity: disabled ? 0.55 : 1,
          }}
        />
        {state === 'saved' && <SavedTick />}
      </span>
      {bad && <span style={{ fontSize: 11.5, color: 'var(--red)', maxWidth: 260, textAlign: 'right' }}>{state.error}</span>}
    </span>
  );
}

/** 'Show more' under a page of 100, when the server said there is a next page. */
export function ShowMore({ next, busy, onMore }) {
  if (!next) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0' }}>
      <Btn kind="soft" disabled={busy} onClick={onMore}>{busy ? 'Loading…' : 'Show more'}</Btn>
    </div>
  );
}

/** A red line with the database's words; the NEEDS_UPDATE words when the function is not there. */
export function ErrorLine({ error }) {
  if (!error) return null;
  const words = error.needsUpdate || error.code === 'needs_update' ? NEEDS_UPDATE : (error.message || String(error));
  return <div role="alert" style={{ ...ui.err, padding: '8px 0' }}>{words}</div>;
}

/** A grey line for an empty list. */
export function EmptyLine({ children }) {
  return <div style={{ padding: '18px 4px', fontSize: 13, color: 'var(--t3)' }}>{children}</div>;
}

/**
 * '<site> catching up' / '<n> sites catching up' while save queue jobs naming these records wait or
 * run. Polls every 3 s while any job is open; says nothing once none is (or the queue cannot be read).
 */
export function CatchingUp({ entityIds }) {
  const sc = useStockScope();
  const [jobs, setJobs] = useState([]);
  const key = (entityIds || []).filter(Boolean).join(',');
  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    let timer = null;
    const ids = key.split(',');
    const tick = async () => {
      const r = await stockApi.catchingUp(ids);
      if (!live) return;
      const rows = Array.isArray(r.data) ? r.data : [];
      setJobs(rows);
      if (rows.length && !r.error) timer = setTimeout(tick, 3000);
    };
    tick();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [key]);
  const sites = [...new Set(jobs.map((j) => j.location_id).filter(Boolean))];
  if (!key || !jobs.length) return null;
  const words = sites.length === 1 ? `${sc.siteName(sites[0]) || 'One site'} catching up` : `${sites.length || jobs.length} sites catching up`;
  return <Pill tone="neutral" title="Saved. The sites catch up within a minute.">{words}</Pill>;
}
