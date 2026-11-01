// src/backoffice/sections/website/HeaderNav.jsx
//
// 5.12.8: the Header and navigation card on Branding and domain. Header options save at once
// (settings.header, merged server side); the navigation is edited as rows and saved with one
// button (save_site nav), with "Back to automatic" clearing it. Publish puts either live.
// 5.12.19 (Peter: "drag one menu item under another or say sub menu item of this"): every row has
// a "Show under" pick. Rows under another sit indented beneath it; the site shows them as a
// dropdown. Arrows move a row among the rows beside it.

import { useState } from 'react';
import { W } from './ui.js';
import { HEADER_BRAND_OPTIONS, HEADER_CTA_OPTIONS, HEADER_LOGO_OPTIONS, MAX_NAV_ITEMS, childrenOf, headerDraft, moveSibling, navPages, navPatchFrom, navRowsFrom, newRow, orderedRows, parentOptions, removeRow, setUnder, topRows } from './navDraft.js';

const LINK = '__link__';
const LOCATIONS = '__locations__';
const GROUP = '__group__';

function Seg({ label, options, value, onPick, hint }) {
  return (
    <div style={W.field}>
      <label style={W.label}>{label}</label>
      <div style={{ ...W.row, gap: 6 }}>
        {options.map(([v, l, sub]) => <button key={v} type="button" style={W.seg(value === v)} onClick={() => onPick(v)} title={sub || ''}>{l}</button>)}
      </div>
      {hint ? <div style={W.hint}>{hint}</div> : null}
    </div>
  );
}

export default function HeaderNavCard({ site, pages, saveSite, toast }) {
  // Header options come from the site row; `pending` paints the pick while the save is in flight.
  const [pending, setPending] = useState(null);
  const hdr = pending || headerDraft(site);
  const [{ rows, auto }, setNav] = useState(() => navRowsFrom(site, pages));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState([]);
  const list = navPages(pages);

  // A save elsewhere (the designer, another tab) refreshes the rows unless the owner is mid edit:
  // derived state adjusted during render (React's "when a prop changes" pattern), never an effect.
  const navKey = JSON.stringify([site && site.nav, (pages || []).map((p) => [p.id, p.title, p.status])]);
  const [seenKey, setSeenKey] = useState(navKey);
  if (navKey !== seenKey) {
    setSeenKey(navKey);
    if (!dirty) setNav(navRowsFrom(site, pages));
  }

  const saveHeader = async (patch) => {
    const next = { ...hdr, ...patch };
    setPending(next);
    const { error } = await saveSite({ settings: { header: next } });
    setPending(null);
    if (error) toast(error.message || 'Could not save the header', 'error');
    else toast('Header saved. Publish to put it live.');
  };

  const change = (fn) => { setDirty(true); setNav((cur) => ({ auto: false, rows: fn(cur.rows) })); };
  const edit = (key, patch) => change((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const move = (key, d) => change((rs) => moveSibling(rs, key, d));
  const remove = (key) => change((rs) => removeRow(rs, key));
  const under = (key, parentKey) => change((rs) => setUnder(rs, key, parentKey));
  const add = () => {
    const used = new Set(rows.map((r) => r.page_id));
    const page = list.find((p) => !used.has(p.id));
    change((rs) => [...rs, page ? newRow({ label: String(page.title || page.slug || 'Page'), kind: 'page', page_id: page.id }) : newRow({ label: '', kind: 'link' })]);
  };
  const pickTarget = (key, v) => {
    const r = rows.find((x) => x.key === key) || {};
    if (v === LINK) return edit(key, { kind: 'link', page_id: '', href: r.href || '' });
    if (v === LOCATIONS) return change((rs) => setUnder(rs, key, '').map((x) => (x.key === key ? { ...x, kind: 'locations', page_id: '', href: '', label: x.label || 'Locations', under: '' } : (x.under === key ? { ...x, under: '' } : x))));
    if (v === GROUP) return change((rs) => setUnder(rs, key, '').map((x) => (x.key === key ? { ...x, kind: 'group', page_id: '', href: '', under: '' } : x)));
    return edit(key, { kind: 'page', page_id: v, href: '' });
  };

  const save = async () => {
    const { nav, errors } = navPatchFrom(rows);
    setProblems(errors);
    if (errors.length) return;
    setBusy(true);
    const { error } = await saveSite({ nav });
    setBusy(false);
    if (error) { setProblems([error.message || 'Could not save the navigation']); return; }
    setDirty(false);
    toast('Navigation saved. Publish to put it live.');
  };
  const backToAuto = async () => {
    setBusy(true);
    const { error } = await saveSite({ nav: [] });
    setBusy(false);
    if (error) { toast(error.message || 'Could not reset the navigation', 'error'); return; }
    setDirty(false);
    setProblems([]);
    setNav(navRowsFrom({ ...site, nav: [] }, pages));
    toast('Navigation follows your pages again. Publish to put it live.');
  };

  const shown = orderedRows(rows);
  const tops = topRows(rows);
  return (
    <div style={W.card}>
      <div style={W.cardHead}><h2 style={W.h2}>Header and navigation</h2></div>
      <Seg label="Brand mark" options={HEADER_BRAND_OPTIONS} value={hdr.brand} onPick={(v) => saveHeader({ brand: v })} hint={HEADER_BRAND_OPTIONS.find(([v]) => v === hdr.brand)?.[2]} />
      <Seg label="Logo size" options={HEADER_LOGO_OPTIONS} value={hdr.logo_size} onPick={(v) => saveHeader({ logo_size: v })} hint={HEADER_LOGO_OPTIONS.find(([v]) => v === hdr.logo_size)?.[2]} />
      <Seg label="Header button" options={HEADER_CTA_OPTIONS} value={hdr.cta} onPick={(v) => saveHeader({ cta: v })} hint={HEADER_CTA_OPTIONS.find(([v]) => v === hdr.cta)?.[2] || 'A coloured button at the end of the menu.'} />
      <div style={W.switchRow}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>Header stays at the top</div>
          <div style={W.hint}>Off: the header scrolls away with the page.</div>
        </div>
        <button type="button" style={W.toggle(hdr.sticky)} aria-pressed={hdr.sticky} aria-label="Header stays at the top" onClick={() => saveHeader({ sticky: !hdr.sticky })}><span style={W.knob(hdr.sticky)} /></button>
      </div>

      <div style={{ ...W.cardHead, marginTop: 18 }}>
        <h3 style={{ ...W.h2, fontSize: 14 }}>Navigation</h3>
        <span style={W.chip}>{auto && !dirty ? 'Automatic: follows your pages' : 'Custom'}</span>
      </div>
      <div style={W.hint}>Each item is a page, a link, a heading, or every venue. Pick "Show under" to put an item under another: the site shows those as a dropdown. The arrows reorder.</div>
      <div style={{ marginTop: 8 }}>
        {shown.map((r) => {
          const isChild = !!r.under && rows.some((x) => x.key === r.under);
          const kids = childrenOf(rows, r.key);
          const sibs = isChild ? childrenOf(rows, r.under) : tops;
          const at = sibs.findIndex((x) => x.key === r.key);
          const n = shown.indexOf(r) + 1;
          const parents = parentOptions(rows, r.key);
          return (
            <div key={r.key} style={{ ...W.listRow, flexWrap: 'wrap', paddingLeft: isChild ? 28 : 0 }}>
              {isChild ? <span aria-hidden="true" style={{ color: 'var(--t3)', fontWeight: 700 }}>↳</span> : null}
              <input aria-label={`Item ${n} label`} style={{ ...W.input, flex: '1 1 140px', width: 'auto' }} value={r.label} maxLength={60} placeholder="Label" onChange={(e) => edit(r.key, { label: e.target.value })} />
              <select aria-label={`Item ${n} goes to`} style={{ ...W.input, flex: '1 1 160px', width: 'auto' }} value={r.kind === 'link' ? LINK : r.kind === 'locations' ? LOCATIONS : r.kind === 'group' ? GROUP : r.page_id} onChange={(e) => pickTarget(r.key, e.target.value)}>
                {r.kind === 'page' && r.page_id && !list.some((p) => p.id === r.page_id) ? <option value={r.page_id}>Missing page</option> : null}
                {list.map((p) => <option key={p.id} value={p.id}>{p.title || p.slug || 'Home'}{p.kind === 'location' ? ' (venue page)' : ''}{p.status === 'draft' ? ' (draft)' : ''}</option>)}
                <option value={LINK}>Custom link</option>
                {isChild ? null : <option value={GROUP}>Heading only (opens the items under it)</option>}
                {isChild ? null : <option value={LOCATIONS}>Every venue page (dropdown)</option>}
              </select>
              {r.kind === 'link' ? <input aria-label={`Item ${n} link`} style={{ ...W.input, flex: '2 1 200px', width: 'auto' }} value={r.href} placeholder="https://… or /menu" onChange={(e) => edit(r.key, { href: e.target.value })} /> : null}
              {r.kind === 'locations' ? null : (
                <select aria-label={`Item ${n} show under`} style={{ ...W.input, flex: '1 1 150px', width: 'auto' }} value={isChild ? r.under : ''} disabled={kids.length > 0} title={kids.length ? 'Has items under it; move those first' : ''} onChange={(e) => under(r.key, e.target.value)}>
                  <option value="">Top level</option>
                  {parents.map((p) => <option key={p.key} value={p.key}>Under {p.label || '(no label)'}</option>)}
                </select>
              )}
              {r.kind === 'locations' ? <span style={{ ...W.hint, flex: '1 1 100%' }}>Opens every published venue page. New venues appear on their own.</span> : null}
              {r.kind === 'group' && !kids.length ? <span style={{ ...W.hint, flex: '1 1 100%' }}>A heading needs items under it: set "Show under" on other items.</span> : null}
              <div style={{ ...W.row, gap: 4, flex: '0 0 auto' }}>
                <button type="button" style={W.ghost} aria-label="Move up" disabled={at <= 0} onClick={() => move(r.key, -1)}>↑</button>
                <button type="button" style={W.ghost} aria-label="Move down" disabled={at >= sibs.length - 1} onClick={() => move(r.key, 1)}>↓</button>
                <button type="button" style={W.danger} aria-label="Remove" onClick={() => remove(r.key)}>Remove</button>
              </div>
            </div>
          );
        })}
        {!rows.length ? <div style={{ ...W.hint, padding: '10px 0' }}>No items. Add one, or go back to automatic.</div> : null}
      </div>
      {problems.length ? <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 8 }}>{problems.map((p) => <div key={p}>{p}</div>)}</div> : null}
      <div style={{ ...W.row, marginTop: 12 }}>
        <button type="button" style={W.ghost} onClick={add} disabled={tops.length >= MAX_NAV_ITEMS}>Add item</button>
        <button type="button" style={W.btn} onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save navigation'}</button>
        {!auto || dirty ? <button type="button" style={W.ghost} onClick={backToAuto} disabled={busy}>Back to automatic</button> : null}
      </div>
    </div>
  );
}
