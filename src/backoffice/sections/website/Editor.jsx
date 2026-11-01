// src/backoffice/sections/website/Editor.jsx
//
// Contract 9.3: Puck, with the block config from agent B's puckConfig(ctx). Page tabs,
// Add page, Desktop / Phone, Undo / Redo (Puck history), Ask designer, Preview, Publish.
// Autosave 3 s after the last change through save_page. Our own header replaces Puck's
// (overrides.header) so the undo and viewport controls can use usePuck inside Puck's tree.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Puck, usePuck } from '@measured/puck';
import '@measured/puck/puck.css';
import './puck-theme.css';
import { W } from './ui.js';
import { PAGE_KINDS, PUCK_THEME_VARS, VIEWPORTS, isValidSlug, kindForSlug, orderPages, pagePath, slugify } from './helpers.js';
import { CUSTOMER_ROOT } from '../../../lib/env';
import { supabase } from '../../../lib/supabase';
import { ensureCustomerSession } from '../../../lib/publicOrderClient';
// The public site's stylesheet (scoped to .w-site). Puck copies the document's <style> tags into
// its canvas iframe, so one copy here styles the blocks the owner is editing.
import { SITE_CSS } from '../../../surfaces/website/siteStyles.js';
// 5.12.9: the default venue's live menu, read once per venue, so the Live menu block shows real
// items in the editor and the Menu and Categories pickers list real menus and categories.
import { loadMenu } from '../../../surfaces/website/data/loadMenu.js';

const EMPTY_LAYOUT = { content: [], root: { props: {} } };
const AUTOSAVE_MS = 3000;

// Agent B owns the block registry. A glob import resolves to nothing instead of failing the
// build when the file is not in the tree yet; the editor then shows an empty palette.
const configModules = import.meta.glob('../../../surfaces/website/blocks/puckConfig.jsx');
const loadPuckConfig = configModules['../../../surfaces/website/blocks/puckConfig.jsx'];

function buildConfig(mod, ctx) {
  // A broken block registry must never take the whole Back Office tab down with it.
  try {
    const fn = mod?.puckConfig || mod?.default;
    const c = typeof fn === 'function' ? fn(ctx) : null;
    if (c && typeof c === 'object' && c.components) return c;
  } catch (e) { console.warn('[website] puckConfig failed', e); }
  return { components: {}, categories: {} };
}

// The header override is a stable function; it reads live editor state through this context.
const HeaderCtx = createContext(null);

// Rendered INSIDE Puck (header override), so usePuck works here.
function EditorHeader() {
  const h = useContext(HeaderCtx) || {};
  const { page, pages, saveState, viewport, setViewport, onPickPage, onAddPage, onAskDesigner, onPreview, onPublish, publishing } = h;
  const { history, dispatch } = usePuck();
  const pick = (vp) => {
    setViewport?.(vp);
    const v = VIEWPORTS[vp];
    dispatch({ type: 'setUi', ui: { viewports: { current: { width: v.width, height: v.height }, controlsVisible: false, options: Object.values(VIEWPORTS) } } });
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 12px', background: 'var(--bg1)', borderBottom: '1px solid var(--bdr)' }}>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
        {orderPages(pages).map((p) => (
          <button key={p.id} style={W.tab(p.id === page?.id)} onClick={() => onPickPage?.(p.id)} title={pagePath(p)}>{p.title || 'Untitled'}{p.status !== 'published' ? ' ·' : ''}</button>
        ))}
        <button style={W.ghost} onClick={onAddPage}>+ Add page</button>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, color: saveState === 'error' ? 'var(--red)' : 'var(--t4)', minWidth: 60 }}>
          {saveState === 'saving' ? 'Saving…' : saveState === 'dirty' ? 'Unsaved' : saveState === 'error' ? 'Save failed' : saveState === 'saved' ? 'Saved' : ''}
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button style={W.seg(viewport === 'desktop')} onClick={() => pick('desktop')}>Desktop</button>
          <button style={W.seg(viewport === 'phone')} onClick={() => pick('phone')}>Phone</button>
        </div>
        <button style={W.ghost} disabled={!history.hasPast} onClick={() => history.back()} title="Undo">↶ Undo</button>
        <button style={W.ghost} disabled={!history.hasFuture} onClick={() => history.forward()} title="Redo">↷ Redo</button>
        <button style={W.ghost} onClick={() => onAskDesigner?.(page?.id)}>✨ Ask designer</button>
        <button style={W.ghost} onClick={() => onPreview?.(pagePath(page))}>Preview ↗</button>
        <button style={W.btn} disabled={publishing} onClick={onPublish}>{publishing ? 'Publishing…' : 'Publish'}</button>
      </div>
    </div>
  );
}

const PUCK_OVERRIDES = { header: () => <EditorHeader /> };

function AddPageModal({ pages, onClose, onCreate }) {
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [kind, setKind] = useState('custom');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const effSlug = slugTouched ? slug : slugify(title);
  const taken = pages.some((p) => p.slug === effSlug);
  const submit = async () => {
    setErr('');
    if (!title.trim()) { setErr('Give the page a title.'); return; }
    if (!isValidSlug(effSlug)) { setErr('The address can only use lower case letters, numbers and dashes.'); return; }
    if (taken) { setErr('A page with that address already exists.'); return; }
    setBusy(true);
    const ok = await onCreate({ title: title.trim(), slug: effSlug, kind });
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ ...W.card, width: 420, maxWidth: '92vw', marginBottom: 0 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ ...W.h2, marginBottom: 12 }}>Add a page</h2>
        <div style={W.field}><label style={W.label}>Title</label><input style={W.input} value={title} autoFocus onChange={(e) => { setTitle(e.target.value); if (!slugTouched) setKind(kindForSlug(slugify(e.target.value))); }} placeholder="Our story" /></div>
        <div style={W.field}><label style={W.label}>Address</label>
          <div style={{ ...W.row, gap: 6 }}><span style={{ ...W.mono, color: 'var(--t3)' }}>/</span><input style={{ ...W.input, flex: 1 }} value={effSlug} onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)); setKind(kindForSlug(slugify(e.target.value))); }} /></div>
        </div>
        <div style={W.field}><label style={W.label}>Kind</label>
          <select style={W.input} value={kind} onChange={(e) => setKind(e.target.value)}>
            {PAGE_KINDS.filter(([k]) => k !== 'home' && k !== 'location').map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <div style={W.hint}>ServOS kinds (menu, order, loyalty, gift cards, find us) start with their live block already on the page.</div>
        </div>
        {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginBottom: 10 }}>{err}</div>}
        <div style={{ ...W.row, justifyContent: 'flex-end' }}>
          <button style={W.ghost} onClick={onClose}>Cancel</button>
          <button style={W.btn} disabled={busy} onClick={submit}>{busy ? 'Adding…' : 'Add page'}</button>
        </div>
      </div>
    </div>
  );
}

// A new ServOS page gets its live block straight away, so it is never a blank canvas.
function starterLayout(kind) {
  const block = { menu: 'LiveMenu', order: 'OrderEmbed', catering: 'OrderEmbed', loyalty: 'LoyaltyJoin', gift: 'GiftCards', findus: 'FindUs', blog: 'BlogList' }[kind];
  if (!block) return EMPTY_LAYOUT;
  const id = `${block}-${Math.random().toString(36).slice(2, 10)}`;
  const props = kind === 'catering' ? { id, mode: 'catering' } : { id };
  return { content: [{ type: block, props }], root: { props: {} } };
}

export default function Editor({ ws, toast, pageId, onPageChange, onAskDesigner, onPreview, onPublish }) {
  const { site, pages, locations, publicLocations, defaultLocation, branding, savePage, uploadAsset } = ws;
  const ordered = useMemo(() => orderPages(pages), [pages]);
  const page = ordered.find((p) => p.id === pageId) || ordered[0] || null;
  const [viewport, setViewport] = useState('desktop');
  const [adding, setAdding] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [saveState, setSaveState] = useState('');
  const [configMod, setConfigMod] = useState(loadPuckConfig ? undefined : null); // undefined = loading
  // 5.12.12 (Peter: "the design scrolls with the page, you cannot see the field to edit"): the
  // editor fills the window below its own top edge, so the page itself never scrolls and Puck's
  // panes scroll on their own. Measured, because the Appearance header above it varies in height.
  // 5.12.14: this sits BELOW the configMod state on purpose. The effect's dependency list names
  // configMod and React reads that list during render, so with the effect above the useState the
  // whole Back Office died on first render with "Cannot access 'oe' before initialization".
  const puckBox = useRef(null);
  const pageKey = page ? page.id : null;
  const [puckHeight, setPuckHeight] = useState('max(560px, calc(100vh - 170px))');
  useEffect(() => {
    const measure = () => {
      const el = puckBox.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      setPuckHeight(`max(480px, calc(100vh - ${Math.round(top)}px - 12px))`);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [pageKey, configMod]);

  useEffect(() => {
    if (!loadPuckConfig) return undefined;
    let on = true;
    loadPuckConfig().then((m) => { if (on) setConfigMod(m || null); }, (e) => { console.warn('[website] puckConfig load failed', e); if (on) setConfigMod(null); });
    return () => { on = false; };
  }, []);

  useEffect(() => {
    try {
      if (document.getElementById('w-css')) return;
      const el = document.createElement('style');
      el.id = 'w-css';
      el.textContent = SITE_CSS;
      document.head.appendChild(el);
    } catch { /* no document, no styles, no crash */ }
  }, []);

  // The public locations (from get_site) carry hours, address and coordinates; the platform rows
  // the branding panel reads do not, so the blocks get the public shape when it is there.
  const blockLocations = publicLocations && publicLocations.length ? publicLocations : locations;

  // 5.12.9: the default venue's live menu for the editor. The platform row (defaultLocation) has no
  // Ops id; the public row of the same venue does (ops_location_id, timezone, currency).
  const menuVenue = useMemo(() => {
    const list = Array.isArray(publicLocations) ? publicLocations : [];
    const hit = defaultLocation ? list.find((l) => l && l.id === defaultLocation.id) : null;
    return hit || (defaultLocation && defaultLocation.ops_location_id ? defaultLocation : null) || list.find((l) => l && l.ops_location_id) || null;
  }, [publicLocations, defaultLocation]);
  const menuOpsId = menuVenue && menuVenue.ops_location_id ? String(menuVenue.ops_location_id) : '';
  const menuTimezone = (menuVenue && menuVenue.timezone) || 'Europe/London';
  const menuCurrency = (menuVenue && menuVenue.currency) || 'GBP';
  const menuPinned = (menuVenue && menuVenue.online_menu_id) || null;
  const [menu, setMenu] = useState(null);
  useEffect(() => {
    if (!menuOpsId || !supabase) return undefined;
    let on = true;
    (async () => {
      // The Back Office is signed in; this only covers a tab with no session yet (never mints anon here).
      try { await ensureCustomerSession(); } catch { /* public reads still answer */ }
      let m = null;
      try { m = await loadMenu(supabase, menuOpsId, { menuId: 'follow', pinnedMenuId: menuPinned, timezone: menuTimezone, currency: menuCurrency }); }
      catch (e) { console.warn('[website] editor menu read failed', e); }
      // A failed read never blocks the editor: the block shows its "being updated" line and the
      // pickers their "once the menu has loaded" hint.
      if (on) setMenu(m && !m.error ? m : null);
    })();
    return () => { on = false; };
  }, [menuOpsId, menuTimezone, menuCurrency, menuPinned]);

  const config = useMemo(() => buildConfig(configMod, { site, pages, location: defaultLocation, locations: blockLocations, branding, menu, uploadAsset, customerRoot: CUSTOMER_ROOT, mode: 'editor' }), [configMod, site, pages, defaultLocation, blockLocations, branding, menu, uploadAsset]);

  // Autosave: the latest layout per page waits 3 s after the last change, then saves.
  const pending = useRef({ pageId: null, layout: null, timer: null });
  const flush = useCallback(async () => {
    const p = pending.current;
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    if (!p.pageId || !p.layout) return;
    const { pageId: id, layout } = p;
    pending.current = { pageId: null, layout: null, timer: null };
    setSaveState('saving');
    const { error } = await savePage(id, { layout });
    if (error) { setSaveState('error'); toast(error.message || 'Could not save the page', 'error'); }
    else setSaveState('saved');
    // Depends on the stable savePage callback, not the ws object: a new ws every render would
    // re-run the unmount cleanup below on each render and save before the 3 s wait.
  }, [savePage, toast]);

  const onChange = useCallback((data) => {
    if (!page?.id) return;
    // Puck fires onChange once on mount with the data it was given; that is not an edit.
    if (data === page.layout) return;
    try { if (JSON.stringify(data) === JSON.stringify(page.layout)) return; } catch { /* compare failed, treat as a change */ }
    const p = pending.current;
    if (p.pageId && p.pageId !== page.id) flush();
    pending.current.pageId = page.id;
    pending.current.layout = data;
    setSaveState('dirty');
    if (p.timer) clearTimeout(p.timer);
    pending.current.timer = setTimeout(flush, AUTOSAVE_MS);
  }, [page, flush]);

  // Leaving the editor (or the tab) saves whatever is still waiting.
  useEffect(() => () => { flush(); }, [flush]);

  const pickPage = async (id) => { await flush(); onPageChange(id); };

  const createPage = async ({ title, slug, kind }) => {
    await flush();
    const { data, error } = await ws.savePage(null, { title, slug, kind, layout: starterLayout(kind), seo: {}, sort_order: pages.length, status: 'draft' });
    if (error) { toast(error.message || 'Could not add the page', 'error'); return false; }
    const newId = data?.page?.id || data?.id || null;
    if (newId) onPageChange(newId); else ws.reload();
    toast(`Added ${title}`);
    return true;
  };

  const publish = async () => {
    setPublishing(true);
    await flush();
    await onPublish('Published from the page editor');
    setPublishing(false);
  };

  const headerValue = { page, pages, saveState, viewport, setViewport, onPickPage: pickPage, onAddPage: () => setAdding(true), onAskDesigner, onPreview, onPublish: publish, publishing };

  if (!site) return <div style={W.empty}>No site yet. Go to Overview and press Build me a website.</div>;

  return (
    <HeaderCtx.Provider value={headerValue}>
      {!page && (
        <div style={{ ...W.card, textAlign: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)' }}>No pages yet</div>
          <div style={{ ...W.hint, marginBottom: 12 }}>Add a page here, or let the designer build the whole site.</div>
          <button style={W.btn} onClick={() => setAdding(true)}>+ Add page</button>
        </div>
      )}
      {page && configMod === undefined && <div style={W.empty}>Loading the editor…</div>}
      {page && configMod !== undefined && (
        <div className="svw-puck" ref={puckBox} style={{ ...PUCK_THEME_VARS, height: puckHeight }}>
          {!loadPuckConfig && <div style={{ padding: '6px 12px', fontSize: 12, color: 'var(--acc)', background: 'var(--acc-d)' }}>The block library is not in this build yet, so the palette is empty.</div>}
          <Puck
            key={page.id}
            config={config}
            data={page.layout && typeof page.layout === 'object' ? page.layout : EMPTY_LAYOUT}
            onChange={onChange}
            onPublish={publish}
            overrides={PUCK_OVERRIDES}
            viewports={Object.values(VIEWPORTS)}
            ui={{ viewports: { current: { width: VIEWPORTS[viewport].width, height: 'auto' }, controlsVisible: false, options: Object.values(VIEWPORTS) }, leftSideBarVisible: true, rightSideBarVisible: true }}
            headerTitle={page.title || 'Page'}
            headerPath={pagePath(page)}
            metadata={{ site, page, location: defaultLocation, branding }}
          />
        </div>
      )}
      {adding && <AddPageModal pages={pages} onClose={() => setAdding(false)} onCreate={createPage} />}
    </HeaderCtx.Provider>
  );
}
