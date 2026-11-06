// src/backoffice/sections/marketing/MarketingSites.jsx (6 Nov 2026, 5.12.69)
//
// The Sites control every Marketing page carries, and the badge every row carries. The page's scope
// comes from useMarketingSites.js (its own file: this one exports components only); the rule it
// draws is in src/lib/marketingSites.js (the organisation owns, the sites use): "All sites" shows
// everything the organisation has; one site shows what is aimed at that site or at every site.
// Same look as the Reports and Stock controls. Hidden for a one site company: nothing to choose.

import { useEffect, useRef, useState } from 'react';
import { SHARED_NOTE } from '../../../lib/marketingSites';

const S = {
  bar: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '-6px 0 14px', maxWidth: 920 },
  btn: { padding: '6px 10px', borderRadius: 8, background: 'var(--bg3)', border: '1px solid var(--bdr)', color: 'var(--t2)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 6 },
  menu: { position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 30, minWidth: 220, maxHeight: 340, overflow: 'auto', padding: 6, background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.25)' },
  row: (on) => ({ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', fontSize: 12, color: on ? 'var(--acc)' : 'var(--t1)', fontWeight: on ? 700 : 400, cursor: 'pointer', borderRadius: 6, width: '100%', background: 'transparent', border: 'none', fontFamily: 'inherit', textAlign: 'left' }),
  note: { fontSize: 12, color: 'var(--t3)', lineHeight: 1.45, flex: '1 1 320px' },
  pill: { display: 'inline-block', padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 700, background: 'var(--bg2)', border: '1px solid var(--bdr2)', color: 'var(--t3)', marginLeft: 6, verticalAlign: 'middle' },
};

/**
 * The Sites control plus the one line note. `what` names the things the page lists ("campaigns");
 * `onSite` is the true sentence for one site when the page does not simply filter a list
 * ("{site}" is replaced by the site's name).
 */
export function MarketingSitesBar({ scope, what = 'things', note = true, onSite = '' }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  if (!scope?.show) return null;
  const pick = (id) => { scope.setSiteId(id); setOpen(false); };
  const siteWords = (name) => (onSite ? onSite.replace('{site}', name) : `Showing the ${what} aimed at ${name} or at every site. The data itself is the whole organisation's.`);
  const menuWords = onSite ? onSite.replace('{site}', 'one site') : `One site shows the ${what} aimed at it or at every site.`;
  return (
    <div style={S.bar} data-marketing-sites>
      <div ref={box} style={{ position: 'relative' }}>
        <button type="button" style={S.btn} onClick={() => setOpen((o) => !o)} aria-haspopup="true" aria-expanded={open} title={`Which site's ${what} to show`}>
          <span style={{ color: 'var(--t4)' }}>Sites</span>
          <strong style={{ color: 'var(--t1)', fontWeight: 700 }}>{scope.siteName}</strong>
          <span style={{ color: 'var(--t4)', fontSize: 10 }}>▾</span>
        </button>
        {open && (
          <div role="menu" style={S.menu}>
            <button type="button" role="menuitemradio" aria-checked={!scope.siteId} style={{ ...S.row(!scope.siteId), borderBottom: '1px solid var(--bdr)', borderRadius: 0, marginBottom: 4 }} onClick={() => pick('')}>
              All sites <span style={{ marginLeft: 'auto', color: 'var(--t4)', fontWeight: 400 }}>{scope.sites.length}</span>
            </button>
            {scope.sites.map((v) => (
              <button key={v.id} type="button" role="menuitemradio" aria-checked={scope.siteId === v.id} style={S.row(scope.siteId === v.id)} onClick={() => pick(v.id)}>{v.name}</button>
            ))}
            <div style={{ padding: '6px 10px 4px', fontSize: 10, color: 'var(--t4)', lineHeight: 1.5 }}>{menuWords}</div>
          </div>
        )}
      </div>
      {note && <div style={S.note}>{scope.siteId ? siteWords(scope.siteName) : SHARED_NOTE}</div>}
    </div>
  );
}

/** "All sites" or "Leeds, Hudds" on a row. */
export function SiteBadge({ scope, ids }) {
  if (!scope?.show) return null;
  return <span style={S.pill} title="Which sites this is aimed at">{scope.badge(ids)}</span>;
}
