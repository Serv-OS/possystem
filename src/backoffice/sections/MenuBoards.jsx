// src/backoffice/sections/MenuBoards.jsx
//
// Back Office → Channels → Menu boards. Create/manage "screens" for the digital
// menu board (the ?mode=menuboard display surface). Each screen = a menu_boards
// row: pick which categories show, reorder them, set display options + columns +
// orientation + mode + branding, then Publish (paired screens refresh live).
// Keys here MUST match MenuBoardSurface.jsx (layout/display_options/theme/marketing).
// layout.followMenus ("Follow timed menus", default false) narrows the board to
// the menu live on the venue clock; the preview mirrors the TV through the same
// shared helpers (src/lib/menuBoardMenus.js).

import { useEffect, useMemo, useState, useCallback, useRef, useLayoutEffect } from 'react';
import { supabase, isMock, getActiveLocationSync } from '../../lib/supabase';
import { beginDrag, dragOver } from '../../lib/dragReorder';
import { reportSave } from '../../lib/saveHealth';
import { fetchMenuCategories, fetchMenuItems, fetch86List, fetchMenus, fetchMenuCategoryLinks } from '../../lib/db';
import { getLocationConfig } from '../../lib/locationTime';
import { money } from '../../lib/currency';
import { resolveBoardPrice } from '../../lib/menuPricing';
import { resolveBoardMenu, applyMenuToSections } from '../../lib/menuBoardMenus';
import { boardItemsByCategory, boardAddOnsByCategory, boardCategoryChoices, boardSections, boardSectionsForMenu, boardColumns, fitFont, scaledFont, newTextBlock, isTextBlock, SIZE_OPTS } from '../../lib/menuBoardSections';
import { BoardHeader, BoardSection, BoardFooter } from '../../surfaces/menuboard/BoardParts';

const ASSET_BUCKET = 'receipt-assets';
const FONTS = ['', 'Plus Jakarta Sans', 'Space Grotesk', 'Inter', 'Georgia', 'Oswald'];
const DEF_THEME = {
  bgColor: '#14110d', textColor: '#F5EFE6', accent: '#E8A23C', font: '', footerNote: '', logoUrl: '', bgImageUrl: '',
  // v5.9.68 design (lib/menuBoardSections.js boardSizes / boardColors; the TV's DEFAULT_THEME agrees)
  title: '', subtitle: '', titleColor: '', titleSize: 'm', logoSize: 'l', headingColor: '', headingSize: 'm', headingRule: true, headerRule: true, itemSize: 'm', priceStyle: 'pill', priceColor: '',
};
const DEF_DISP = { showDescription: true, showAllergens: true, showPrices: true, showImages: false, soldOut: 'grey', textScale: 1, hidePriceless: false, sizeGrid: true };
// followMenus defaults false here so the Edit merge (`{ ...newBoard(1).layout, ...b.layout }`)
// gives every board saved before the flag existed the exact behaviour it has today.
const newBoard = (n) => ({ name: `Menu board ${n}`, orientation: 'landscape', mode: 'menu', layout: { columns: 'auto', blocks: [], followMenus: false }, display_options: { ...DEF_DISP }, theme: { ...DEF_THEME }, marketing: { mediaUrl: '', mediaType: 'image', fit: 'cover' } });

// "online" if the screen heartbeat is recent, else a relative last-seen label.
const seenLabel = (ts) => {
  if (!ts) return { online: false, text: 'never seen' };
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins <= 3) return { online: true, text: 'Online' };
  if (mins < 90) return { online: false, text: `seen ${mins}m ago` };
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return { online: false, text: `seen ${hrs}h ago` };
  return { online: false, text: `seen ${Math.round(hrs / 24)}d ago` };
};

export default function MenuBoards() {
  const [locId, setLocId] = useState(null);
  const [screens, setScreens] = useState([]);
  const [cats, setCats] = useState([]);
  const [allCats, setAllCats] = useState([]);      // every category row (subs too), for menu membership
  const [items, setItems] = useState([]);
  const [six, setSix] = useState(new Set());
  const [menus, setMenus] = useState([]);          // Follow timed menus: what the preview needs to mirror the TV
  const [links, setLinks] = useState([]);
  const [tz, setTz] = useState(null);              // venue timezone (platform locations row); null = read failed
  const [menusOk, setMenusOk] = useState(true);    // false = menus could not be read; the preview shows everything
  const [catsErr, setCatsErr] = useState('');      // why the category list is empty, when it is
  const [editing, setEditing] = useState(null);   // board object (new or existing)
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');
  const [paired, setPaired] = useState([]);        // physical screens (menu_board_screens) at this location
  const [pairCode, setPairCode] = useState('');
  const [pairBoard, setPairBoard] = useState('');
  const [pairMsg, setPairMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const id = getActiveLocationSync();
      setLocId(id);
      if (isMock || !supabase || !id) { setLoading(false); return; }
      const [b, c, it, s, scr, m, l, cfg] = await Promise.all([
        supabase.from('menu_boards').select('*').eq('location_id', id).order('created_at'),
        fetchMenuCategories(id), fetchMenuItems(id), fetch86List(id),
        supabase.from('menu_board_screens').select('*').eq('location_id', id).order('created_at'),
        // Follow timed menus: menus + links + the venue clock for the live preview.
        // Best effort: a failure here must not take the builder down, it only
        // leaves the preview unfiltered (with a note under the toggle).
        fetchMenus(id).catch(() => null), fetchMenuCategoryLinks(id).catch(() => null), getLocationConfig(id).catch(() => null),
      ]);
      setScreens(b?.data || []);
      // WHY there is nothing to offer, not just THAT there is nothing (21 Sep
      // 2026: Huddersfield's four categories were never in the database, so
      // this builder said "add some below" with nothing below and the operator
      // had no way to tell an empty venue from a failed read).
      setCatsErr(c?.error ? (c.error.message || 'could not be read') : '');
      setAllCats(c?.data || []);
      // v5.9.67: every category a board may show, subcategories included, in tree order.
      setCats(boardCategoryChoices(c?.data || []));
      setItems(it?.data || []);
      setSix(new Set((s?.data || []).map(r => r.item_id)));
      setPaired(scr?.data || []);
      setMenus(Array.isArray(m?.data) ? m.data : []);
      setLinks(Array.isArray(l?.data) ? l.data : []);
      setTz(cfg?.timezone || null);
      setMenusOk(!!m && !m.error);
    } catch (e) { setErr(e.message || 'Could not load'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Pairing: claim a screen by the code it shows, then assign/reassign/unpair/retire.
  const pairScreen = async () => {
    const code = pairCode.trim(); if (!code || !pairBoard) { setPairMsg('Enter the code shown on the screen and pick a board.'); return; }
    setBusy('pair'); setPairMsg('');
    try {
      const { error } = await supabase.rpc('claim_menu_board_screen', { p_code: code, p_board_id: pairBoard });
      if (error) throw error;
      setPairCode(''); setPairBoard(''); setPairMsg('✓ Screen paired'); await load();
      setTimeout(() => setPairMsg(m => (m === '✓ Screen paired' ? '' : m)), 2500);
    } catch (e) { setPairMsg(e.message || 'Could not pair — check the code.'); }
    finally { setBusy(''); }
  };
  const reassign = async (screenId, boardId) => {
    setBusy('scr-' + screenId);
    try { const { error } = await supabase.rpc('set_menu_board_screen', { p_screen_id: screenId, p_board_id: boardId || null }); if (error) throw error; await load(); }
    catch (e) { setErr(e.message || 'Could not update screen'); }
    finally { setBusy(''); }
  };
  const retireScreen = async (screenId) => {
    if (!window.confirm('Remove this screen? It will show a fresh pairing code next time it loads.')) return;
    setBusy('scr-' + screenId);
    try {
      const { data, error } = await supabase.from('menu_board_screens').delete().eq('id', screenId).select('id');
      if (error) throw error;
      if (!data || data.length === 0) throw new Error('Remove matched 0 rows — RLS may have blocked it. The screen is still paired.');
      reportSave('menu board screen', null);
      await load();
    }
    catch (e) { reportSave('menu board screen', e); setErr(e.message || 'Could not remove screen'); }
    finally { setBusy(''); }
  };

  // The TV's grouping exactly (lib/menuBoardSections.js): sizes nest under their parent and an
  // option only sub item is never a line, so the count and the preview here match the screen.
  const itemsByCat = useMemo(() => boardItemsByCategory(items), [items]);
  const addOnsByCat = useMemo(() => boardAddOnsByCategory(items), [items]);

  const save = async (publish) => {
    if (!editing || !locId) return;
    setBusy(publish ? 'publish' : 'save'); setErr('');
    try {
      const row = {
        location_id: locId, name: editing.name || 'Menu board',
        orientation: editing.orientation, mode: editing.mode,
        layout: editing.layout, display_options: editing.display_options,
        theme: editing.theme, marketing: editing.marketing,
        updated_at: new Date().toISOString(),
      };
      if (publish) { row.published_at = new Date().toISOString(); row.version = (editing.version || 1) + 1; }
      let res;
      if (editing.id) res = await supabase.from('menu_boards').update(row).eq('id', editing.id).select().single();
      else res = await supabase.from('menu_boards').insert(row).select().single();
      if (res.error) throw res.error;
      reportSave('menu board', null);
      setEditing(null); await load();
    } catch (e) { reportSave('menu board', e); setErr(e.message || 'Save failed'); }
    finally { setBusy(''); }
  };

  const del = async (id) => {
    if (!window.confirm('Delete this menu board screen?')) return;
    setErr('');
    const { data, error } = await supabase.from('menu_boards').delete().eq('id', id).select('id');
    const failure = error || (!data || data.length === 0
      ? new Error(`Delete matched 0 rows for board ${id} — RLS may have blocked it`)
      : null);
    reportSave('menu board delete', failure);
    // Without this the board silently reappears when load() re-reads the DB.
    if (failure) { setErr(`Board NOT deleted — ${failure.message}`); return; }
    await load();
  };

  const screenUrl = (id) => `${window.location.origin}/?mode=menuboard&board=${id}`;
  const copyLink = async (id) => {
    try { await navigator.clipboard.writeText(screenUrl(id)); } catch { /* clipboard blocked; nothing else to do */ }
    setCopied(id); setTimeout(() => setCopied(c => (c === id ? '' : c)), 1800);
  };

  const upload = async (file, kind) => {
    if (!file || !locId) return null;
    setBusy('upload-' + kind);
    try {
      const ext = (file.name.split('.').pop() || 'png').toLowerCase();
      const path = `locations/${locId}/menuboard/${kind}-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from(ASSET_BUCKET).upload(path, file, { upsert: true, contentType: file.type });
      if (error) throw error;
      const { data } = supabase.storage.from(ASSET_BUCKET).getPublicUrl(path);
      return `${data.publicUrl}?t=${Date.now()}`;
    } catch (e) { setErr(e.message || 'Upload failed'); return null; }
    finally { setBusy(''); }
  };

  if (loading) return <div style={S.empty}>Loading menu boards…</div>;
  if (!locId) return <div style={S.empty}>Pick a location to manage its menu boards.</div>;

  if (editing) return (
    <Editor board={editing} setBoard={setEditing} cats={cats} catsErr={catsErr} itemsByCat={itemsByCat} addOnsByCat={addOnsByCat} six={six}
      allCats={allCats} menus={menus} links={links} tz={tz} menusOk={menusOk}
      onSave={() => save(false)} onPublish={() => save(true)} onCancel={() => setEditing(null)}
      onUpload={upload} busy={busy} err={err} />
  );

  const boardName = (id) => screens.find(b => b.id === id)?.name || '—';
  // TVs paired to an order screen (Channels → Order screens) are managed there, not here.
  // Before the 20260911 migration order_display_id is undefined, so nothing is filtered.
  const boardTvs = paired.filter(s => !s.order_display_id);
  const orderScreenTvs = paired.length - boardTvs.length;

  return (
    <div style={{ maxWidth: 1100 }}>
      <Head title="Menu boards" sub="Build a screen below, then put it on a TV one of two ways: pair the screen (power on the TV at the menu-board app, then enter the code it shows under “Paired screens”), or use “Copy screen link” for a direct link. Either way it refreshes live when you publish." />
      {err && <div style={S.errBar}>{err}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 14 }}>
        {screens.map(b => (
          <div key={b.id} style={S.card}>
            <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)' }}>{b.name}</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 3 }}>
              {b.mode === 'marketing' ? 'Marketing screen' : `${(b.layout?.blocks?.length || 0)} categories · ${b.orientation}`}
            </div>
            <div style={{ fontSize: 11, color: b.published_at ? 'var(--grn)' : 'var(--t4)', marginTop: 6 }}>
              {b.published_at ? `Published ${new Date(b.published_at).toLocaleDateString('en-GB')}` : 'Not published'}
            </div>
            <button style={{ ...S.btn, width: '100%', marginTop: 12 }} onClick={() => copyLink(b.id)}>{copied === b.id ? '✓ Link copied' : 'Copy screen link'}</button>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button style={S.btn} onClick={() => setEditing({ ...newBoard(1), ...b, layout: { ...newBoard(1).layout, ...b.layout }, display_options: { ...DEF_DISP, ...b.display_options }, theme: { ...DEF_THEME, ...b.theme }, marketing: { ...newBoard(1).marketing, ...b.marketing } })}>Edit</button>
              <button style={S.btnGhost} onClick={() => del(b.id)}>Delete</button>
            </div>
          </div>
        ))}
        <button style={S.addCard} onClick={() => setEditing(newBoard(screens.length + 1))}>+ New screen</button>
      </div>

      {/* Physical screens paired to this venue */}
      <div style={{ ...S.section, marginTop: 22 }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--t1)' }}>Paired screens</div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 3, marginBottom: 12 }}>
          Power on a TV at the menu-board app — it shows a pairing code. Enter that code here and pick which board it should display.
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <input style={{ ...S.inp, width: 170, textTransform: 'uppercase' }} placeholder="Code e.g. K7P2-9XQM"
            value={pairCode} onChange={e => setPairCode(e.target.value)} />
          <select style={{ ...S.inp, width: 200 }} value={pairBoard} onChange={e => setPairBoard(e.target.value)}>
            <option value="">Show board…</option>
            {screens.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button style={S.btnPrimary} onClick={pairScreen} disabled={busy === 'pair'}>{busy === 'pair' ? 'Pairing…' : 'Pair screen'}</button>
          {pairMsg && <span style={{ fontSize: 12, color: pairMsg.startsWith('✓') ? 'var(--grn)' : 'var(--red)' }}>{pairMsg}</span>}
        </div>

        {boardTvs.length > 0 ? (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {boardTvs.map(s => { const sl = seenLabel(s.last_seen_at); return (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 10px', border: '1px solid var(--bdr)', borderRadius: 10, background: 'var(--bg2)' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: sl.online ? '#3BD16F' : 'var(--bdr2)', flexShrink: 0 }} title={sl.text} />
                <div style={{ flex: 1, minWidth: 140 }}>
                  <div style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 700 }}>{s.name || boardName(s.board_id)}</div>
                  <div style={{ fontSize: 11, color: 'var(--t4)' }}>{s.code} · {sl.text}</div>
                </div>
                <select style={{ ...S.inp, width: 190 }} value={s.board_id || ''} disabled={busy === 'scr-' + s.id}
                  onChange={e => reassign(s.id, e.target.value)}>
                  <option value="">— Unpaired —</option>
                  {screens.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                <button style={S.btnGhost} onClick={() => retireScreen(s.id)} disabled={busy === 'scr-' + s.id}>Remove</button>
              </div>
            ); })}
          </div>
        ) : orderScreenTvs > 0
          ? <div style={{ fontSize: 15, color: 'var(--t4)', marginTop: 12 }}>No TVs show a menu board yet.</div>
          : <div style={{ fontSize: 12, color: 'var(--t4)', marginTop: 12 }}>No screens paired yet.</div>}
        {orderScreenTvs > 0 && (
          <div style={{ fontSize: 15, color: 'var(--t3)', marginTop: 12 }}>Some TVs show order screens. Manage them in Order screens.</div>
        )}
      </div>
    </div>
  );
}

function Editor({ board, setBoard, cats, catsErr = '', itemsByCat, addOnsByCat = {}, six, allCats = [], menus = [], links = [], tz = null, menusOk = true, onSave, onPublish, onCancel, onUpload, busy, err }) {
  const set = (patch) => setBoard(b => ({ ...b, ...patch }));
  const setLayout = (patch) => setBoard(b => ({ ...b, layout: { ...b.layout, ...patch } }));
  const setDisp = (patch) => setBoard(b => ({ ...b, display_options: { ...b.display_options, ...patch } }));
  const setTheme = (patch) => setBoard(b => ({ ...b, theme: { ...b.theme, ...patch } }));
  const setMkt = (patch) => setBoard(b => ({ ...b, marketing: { ...b.marketing, ...patch } }));

  const blocks = board.layout?.blocks || [];
  const selIds = blocks.map(x => x.categoryId);
  const offCats = cats.filter(c => !selIds.includes(c.id));
  const [dragI, setDragI] = useState(null);
  const [overI, setOverI] = useState(null);
  const [addOnsOpen, setAddOnsOpen] = useState(null);   // index of the block whose add-on list is open

  // Follow timed menus: the preview mirrors the TV. Same shared resolver on the
  // venue clock (tz from the platform locations row), re-evaluated every minute
  // while the flag is on, so the operator sees what the screen shows right now.
  const followMenus = board.layout?.followMenus === true;
  const [, setClockTick] = useState(0);
  useEffect(() => {
    if (!followMenus) return;
    const t = setInterval(() => setClockTick(x => x + 1), 60_000);
    return () => clearInterval(t);
  }, [followMenus]);
  const activeMenuId = resolveBoardMenu({ board, menus, categories: allCats, links, timezone: tz });
  const activeMenu = activeMenuId ? menus.find(m => m.id === activeMenuId) : null;
  // Which arranged blocks the TV is showing right now (after the never-blank fallback),
  // so the list can flag the ones that are hidden by the live menu.
  const shownNow = new Set(applyMenuToSections(
    blocks.filter(b => !isTextBlock(b)).map(b => ({ id: b.categoryId, items: itemsByCat[b.categoryId] || [] })),
    { categories: allCats, links, activeMenuId, categoryIdOf: s => s.id },
  ).map(s => s.id));
  const hiddenNow = (catId) => followMenus && !!activeMenuId && !shownNow.has(catId);
  let venueClock = '';
  try { venueClock = tz ? new Date().toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }) : ''; } catch { venueClock = ''; }
  const followStatus = !followMenus ? null
    : !menusOk ? 'Menus could not be loaded, so this preview shows every category. The TV applies the schedule.'
    : menus.length === 0 ? 'No menus are set up at this venue yet, so the board shows every category.'
    : activeMenu ? `On now: ${activeMenu.name || activeMenuId}${venueClock ? ` (${venueClock} at the venue)` : ''}. The preview follows it.`
    : 'No menu is on right now, so the board shows every category.';
  const addCat = (id) => setLayout({ blocks: [...blocks, { categoryId: id, span: 1 }] });
  const removeBlk = (i) => setLayout({ blocks: blocks.filter((_, j) => j !== i) });
  const reorder = (from, to) => { if (from == null || to == null || from === to) return; const a = [...blocks]; const [m] = a.splice(from, 1); a.splice(to, 0, m); setLayout({ blocks: a }); };
  const toggleSpan = (i) => setLayout({ blocks: blocks.map((b, j) => j === i ? { ...b, span: b.span === 'all' ? 1 : 'all' } : b) });
  // v5.9.67: a block may carry its own heading (two "Iced" subcategories can read differently on the TV).
  const setBlockTitle = (i, title) => setLayout({ blocks: blocks.map((b, j) => j === i ? { ...b, title } : b) });
  const setBlockField = (i, patch) => setLayout({ blocks: blocks.map((b, j) => j === i ? { ...b, ...patch } : b) });
  const catOf = (id) => cats.find(c => c.id === id);
  const catLabel = (id) => catOf(id)?.path || catOf(id)?.label || '—';

  const pickFile = (kind, accept, cb) => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = accept;
    inp.onchange = async () => { const f = inp.files?.[0]; if (f) { const url = await onUpload(f, kind); if (url) cb(url); } };
    inp.click();
  };

  return (
    <div style={{ maxWidth: 1180 }}>
      <button style={S.back} onClick={onCancel}>← Back to menu boards</button>
      <Head title={board.id ? 'Edit screen' : 'New screen'} sub="Compose what this display shows, then Publish." />
      {err && <div style={S.errBar}>{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.15fr) minmax(0,1fr)', gap: 18, marginTop: 14, alignItems: 'start' }}>
        {/* ── form ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Section>
            <Field label="Screen name"><input style={S.inp} value={board.name} onChange={e => set({ name: e.target.value })} /></Field>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
              <Field label="Orientation"><Pills opts={[['landscape', 'Landscape'], ['portrait', 'Portrait']]} val={board.orientation}
                on={v => { set({ orientation: v }); if (v !== 'portrait') setLayout({ rotate: 0 }); }} /></Field>
              <Field label="Mode"><Pills opts={[['menu', 'Menu'], ['marketing', 'Marketing']]} val={board.mode} on={v => set({ mode: v })} /></Field>
            </div>
            {/* A PORTRAIT TV (21 Sep 2026). Peter: the order screens turn properly
                and the menu boards do not, with no setting to force it. Same
                control, same words, same rule (lib/orderScreen/orderScreenLayout
                stageSize), so two TVs side by side cannot behave differently. */}
            {board.orientation === 'portrait' && (
              <Field label="If the TV shows the picture sideways">
                <Pills
                  opts={[['0', 'Do not turn'], ['90', 'Turn right'], ['270', 'Turn left']]}
                  val={String(Number(board.layout?.rotate) || 0)}
                  on={v => setLayout({ rotate: Number(v) })}
                />
                <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 6, lineHeight: 1.5, maxWidth: 560 }}>
                  The Serv OS Menu TV app always runs landscape. If your TV hangs portrait, choose Turn right or Turn left.
                </div>
              </Field>
            )}
          </Section>

          {board.mode === 'menu' ? (
            <>
              <Section title="Categories on this screen" desc="Drag to reorder. Add a subcategory on its own (it does not need its parent). Type a heading to change what the TV shows above it. Add-ons lets you tick the option only sub items (whipped cream, marshmallows) to list under a category; everything else stays off. A text panel is a boxed heading with lines (the Syrups box). “Full width” spans the whole board.">
                {blocks.length === 0 && (
                  <div style={{ fontSize: 12, color: catsErr ? 'var(--red)' : 'var(--t4)', lineHeight: 1.5 }}>
                    {catsErr
                      ? `This venue’s menu could not be read (${catsErr}). Check you are on the right venue, or refresh and sign in again.`
                      : cats.length === 0
                        ? 'This venue has no menu categories, so there is nothing to put on the board yet. Build them in Menu first, then come back.'
                        : 'No categories on this screen yet — add some below.'}
                  </div>
                )}
                {blocks.map((blk, i) => {
                  const rowStyle = { ...S.row, cursor: 'grab', borderRadius: 6, background: dragI === i ? 'var(--bg3)' : 'transparent', alignItems: 'flex-start', flexWrap: 'wrap' };
                  const dragProps = {
                    draggable: true,
                    onDragStart: e => { setDragI(i); beginDrag(e, blk.categoryId || blk.id || String(i)); },
                    onDragOver: e => dragOver(e, i, overI, setOverI),
                    onDrop: () => { reorder(dragI, i); setDragI(null); setOverI(null); },
                    onDragEnd: () => { setDragI(null); setOverI(null); },
                  };
                  // Typing in a field must never start a drag of the row.
                  const stopDrag = { draggable: false, onDragStart: e => { e.preventDefault(); e.stopPropagation(); } };
                  if (isTextBlock(blk)) {
                    return (
                      <div key={blk.id || `text-${i}`} {...dragProps} style={rowStyle}>
                        <span style={{ color: 'var(--t4)', fontSize: 15, cursor: 'grab', userSelect: 'none' }} title="Drag to reorder">⠿</span>
                        <div style={{ flex: 1, minWidth: 220, display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div style={{ fontSize: 11, color: 'var(--t4)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }}>Text panel</div>
                          <input {...stopDrag} style={{ ...S.inp, fontSize: 12 }} value={blk.title || ''} placeholder="Heading, e.g. SYRUPS" onChange={e => setBlockField(i, { title: e.target.value })} />
                          <textarea {...stopDrag} style={{ ...S.inp, fontSize: 12, minHeight: 70, resize: 'vertical', fontFamily: 'inherit' }} value={blk.body || ''} placeholder={'One line per row, e.g.\n#Peanut butter\n#Caramel'} onChange={e => setBlockField(i, { body: e.target.value })} />
                          <input {...stopDrag} style={{ ...S.inp, fontSize: 12 }} value={blk.footer || ''} placeholder="Last line, e.g. #EACH 0.70" onChange={e => setBlockField(i, { footer: e.target.value })} />
                          <div><Toggle on={blk.boxed !== false} label="Boxed" set={v => setBlockField(i, { boxed: v })} /></div>
                        </div>
                        <button style={blk.span === 'all' ? S.spanOn : S.spanOff} onClick={() => toggleSpan(i)} title="Span the full width of the board">Full width</button>
                        <button style={S.miniX} onClick={() => removeBlk(i)}>✕</button>
                      </div>
                    );
                  }
                  const addOns = addOnsByCat[blk.categoryId] || [];
                  const chosen = new Set(Array.isArray(blk.addOnIds) ? blk.addOnIds : []);
                  const open = addOnsOpen === i;
                  return (
                    <div key={blk.categoryId} {...dragProps} style={rowStyle}>
                      <span style={{ color: 'var(--t4)', fontSize: 15, cursor: 'grab', userSelect: 'none' }} title="Drag to reorder">⠿</span>
                      <span style={{ flex: 1, fontSize: 13, color: 'var(--t1)', minWidth: 160 }}>{catLabel(blk.categoryId)} <span style={{ color: 'var(--t4)', fontSize: 11 }}>· {(itemsByCat[blk.categoryId] || []).length} items{chosen.size ? ` · ${chosen.size} add-on${chosen.size === 1 ? '' : 's'}` : ''}</span>
                        {hiddenNow(blk.categoryId) && <span title="Not on the menu that is on right now" style={{ marginLeft: 6, fontSize: 10.5, color: 'var(--t4)', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '1px 7px' }}>hidden now</span>}
                      </span>
                      <input {...stopDrag} style={{ ...S.inp, width: 150, padding: '4px 8px', fontSize: 12 }} value={blk.title || ''} placeholder={catOf(blk.categoryId)?.label || 'Heading'} title="The heading the TV shows above this category. Leave empty to use the category's name." onChange={e => setBlockTitle(i, e.target.value)} />
                      {addOns.length > 0 && (
                        <button style={open ? S.spanOn : S.spanOff} onClick={() => setAddOnsOpen(open ? null : i)} title="Tick the option only sub items (milks, syrups, toppings) to list under this category">
                          Add-ons{chosen.size ? ` (${chosen.size})` : ''}
                        </button>
                      )}
                      <button style={blk.span === 'all' ? S.spanOn : S.spanOff} onClick={() => toggleSpan(i)} title="Span the full width of the board (hero)">Full width</button>
                      <button style={S.miniX} onClick={() => removeBlk(i)}>✕</button>
                      {open && (
                        <div style={{ flexBasis: '100%', display: 'flex', flexWrap: 'wrap', gap: 6, padding: '6px 0 2px 26px' }}>
                          {addOns.map(a => {
                            const on = chosen.has(a.id);
                            const ap = resolveBoardPrice(a, activeMenuId);
                            return (
                              <button key={a.id} style={on ? S.pillOn : S.pill} onClick={() => setBlockField(i, { addOnIds: on ? [...chosen].filter(x => x !== a.id) : [...chosen, a.id] })}>
                                {on ? '✓ ' : ''}{a.menu_name || a.name}{ap > 0 ? ` · ${money(ap)}` : ''}
                              </button>
                            );
                          })}
                          <div style={{ flexBasis: '100%', fontSize: 11, color: 'var(--t4)', lineHeight: 1.5 }}>Ticked add-ons appear as small lines in their menu order (put them right after the product in Menu to sit under it). Unticked ones never show.</div>
                        </div>
                      )}
                    </div>
                  );
                })}
                <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                  <button style={S.btnGhost} onClick={() => setLayout({ blocks: [...blocks, newTextBlock()] })}>+ Text panel</button>
                </div>
                {offCats.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={S.lbl}>Add category</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 5 }}>
                      {offCats.map(c => <button key={c.id} style={S.chip} onClick={() => addCat(c.id)} title={c.depth ? 'Subcategory: shows on its own, without its parent' : undefined}>+ {c.path || c.label}</button>)}
                    </div>
                  </div>
                )}
              </Section>

              <Section title="Layout & display">
                <Field label="Columns"><Pills opts={[['auto', 'Auto'], ['2', '2'], ['3', '3'], ['4', '4']]} val={String(board.layout.columns)} on={v => setLayout({ columns: v === 'auto' ? 'auto' : Number(v) })} /></Field>
                <div>
                  <Toggle on={followMenus} label="Follow timed menus" set={v => setLayout({ followMenus: v })} />
                  <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 6, lineHeight: 1.5, maxWidth: 560 }}>
                    Show only the categories on the menu that is on right now. Uses the same schedules as the till, kiosk and online ordering. Prices follow that menu too.
                  </div>
                  {followStatus && (
                    <div style={{ fontSize: 11.5, color: activeMenu && menusOk ? 'var(--grn)' : 'var(--t3)', marginTop: 4, lineHeight: 1.5 }}>{followStatus}</div>
                  )}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                  <Toggle on={board.display_options.showDescription} label="Descriptions" set={v => setDisp({ showDescription: v })} />
                  <Toggle on={board.display_options.showAllergens} label="Allergens" set={v => setDisp({ showAllergens: v })} />
                  <Toggle on={board.display_options.showPrices} label="Prices" set={v => setDisp({ showPrices: v })} />
                  <Toggle on={board.display_options.showImages} label="Images" set={v => setDisp({ showImages: v })} />
                  <Toggle on={board.display_options.hidePriceless} label="Hide items with no price" set={v => setDisp({ hidePriceless: v })} />
                </div>
                <Field label="When an item is sold out"><Pills opts={[['grey', 'Grey “sold out”'], ['hide', 'Hide it']]} val={board.display_options.soldOut} on={v => setDisp({ soldOut: v })} /></Field>
                <Field label="Text size"><Pills opts={[['0.7', '70%'], ['0.85', '85%'], ['1', '100% · fill'], ['1.15', '115%'], ['1.3', '130%'], ['1.5', '150%']]} val={String(board.display_options.textScale ?? 1)} on={v => setDisp({ textScale: Number(v) })} /></Field>
                <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: -4, lineHeight: 1.5, maxWidth: 560 }}>
                  100% is the largest text that fills the screen. Smaller sizes leave room around the menu. Larger sizes open more columns to make room, then take the biggest size that still fits. The preview uses the same rule as the TV.
                </div>
                <Toggle on={board.display_options.sizeGrid !== false} label="Price grid by size (Small · Big · XL across the top)" set={v => setDisp({ sizeGrid: v })} />
              </Section>

              <Section title="Design" desc="What the screen looks like. The preview on the right is drawn by the same code as the TV, so it is what the screen shows.">
                <Field label="Page title"><input style={S.inp} value={board.theme.title || ''} onChange={e => setTheme({ title: e.target.value })} placeholder="e.g. HOT DRINKS" /></Field>
                <Field label="Note under the title">
                  <textarea style={{ ...S.inp, minHeight: 48, resize: 'vertical', fontFamily: 'inherit' }} value={board.theme.subtitle || ''} onChange={e => setTheme({ subtitle: e.target.value })}
                    placeholder={'e.g. Alternative milk options available, additional 50p charge\nOat | Coconut | Almond, Soya is free'} />
                </Field>
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                  <Field label="Title size"><Pills opts={SIZE_OPTS} val={board.theme.titleSize || 'm'} on={v => setTheme({ titleSize: v })} /></Field>
                  <Field label="Logo size"><Pills opts={SIZE_OPTS} val={board.theme.logoSize || 'm'} on={v => setTheme({ logoSize: v })} /></Field>
                </div>
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                  <Field label="Category headings"><Pills opts={SIZE_OPTS} val={board.theme.headingSize || 'm'} on={v => setTheme({ headingSize: v })} /></Field>
                  <Field label="Item text"><Pills opts={SIZE_OPTS} val={board.theme.itemSize || 'm'} on={v => setTheme({ itemSize: v })} /></Field>
                  <Field label="Prices"><Pills opts={[['pill', 'Pill'], ['plain', 'Plain text']]} val={board.theme.priceStyle || 'pill'} on={v => setTheme({ priceStyle: v })} /></Field>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Toggle on={board.theme.headingRule !== false} label="Line under headings" set={v => setTheme({ headingRule: v })} />
                  <Toggle on={board.theme.headerRule !== false} label="Line under the header" set={v => setTheme({ headerRule: v })} />
                  <Toggle on={board.theme.headingCase !== 'as-typed'} label="Headings in capitals" set={v => setTheme({ headingCase: v ? 'upper' : 'as-typed' })} />
                </div>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <ColorRow label="Background" val={board.theme.bgColor} on={v => setTheme({ bgColor: v })} />
                  <ColorRow label="Text" val={board.theme.textColor} on={v => setTheme({ textColor: v })} />
                  <ColorRow label="Title" val={board.theme.titleColor || board.theme.textColor} on={v => setTheme({ titleColor: v })} />
                  <ColorRow label="Headings" val={board.theme.headingColor || board.theme.accent} on={v => setTheme({ headingColor: v })} />
                  <ColorRow label="Prices" val={board.theme.priceColor || (board.theme.priceStyle === 'plain' ? board.theme.textColor : board.theme.accent)} on={v => setTheme({ priceColor: v })} />
                  <ColorRow label="Small print" val={board.theme.mutedColor || '#B8AE9E'} on={v => setTheme({ mutedColor: v })} />
                  <ColorRow label="Accent (size lines)" val={board.theme.accent} on={v => setTheme({ accent: v })} />
                </div>
                <Field label="Font"><select style={S.inp} value={board.theme.font} onChange={e => setTheme({ font: e.target.value })}>{FONTS.map(f => <option key={f} value={f}>{f || 'Default (Jakarta)'}</option>)}</select></Field>
                <Field label="Footer note"><input style={S.inp} value={board.theme.footerNote} onChange={e => setTheme({ footerNote: e.target.value })} placeholder="e.g. Please ask staff about the 14 allergens." /></Field>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button style={S.btn} onClick={() => pickFile('bg', 'image/*', url => setTheme({ bgImageUrl: url }))}>{busy === 'upload-bg' ? 'Uploading…' : board.theme.bgImageUrl ? 'Replace background image' : 'Upload background image'}</button>
                  {board.theme.bgImageUrl && <button style={S.btnGhost} onClick={() => setTheme({ bgImageUrl: '' })}>Clear bg</button>}
                  <button style={S.btn} onClick={() => pickFile('logo', 'image/*', url => setTheme({ logoUrl: url }))}>{busy === 'upload-logo' ? 'Uploading…' : board.theme.logoUrl ? 'Replace logo' : 'Upload logo'}</button>
                  {board.theme.logoUrl && <button style={S.btnGhost} onClick={() => setTheme({ logoUrl: '' })}>Clear logo</button>}
                </div>
              </Section>
            </>
          ) : (
            <Section title="Marketing media" desc="Shown full-screen instead of the menu.">
              <Field label="Type"><Pills opts={[['image', 'Image'], ['video', 'Video']]} val={board.marketing.mediaType} on={v => setMkt({ mediaType: v })} /></Field>
              <Field label="Fit"><Pills opts={[['cover', 'Fill screen'], ['contain', 'Fit (letterbox)']]} val={board.marketing.fit} on={v => setMkt({ fit: v })} /></Field>
              <button style={S.btn} onClick={() => pickFile('mkt', board.marketing.mediaType === 'video' ? 'video/*' : 'image/*', url => setMkt({ mediaUrl: url }))}>{busy === 'upload-mkt' ? 'Uploading…' : board.marketing.mediaUrl ? 'Replace media' : 'Upload media'}</button>
              {board.marketing.mediaUrl && <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 6, wordBreak: 'break-all' }}>{board.marketing.mediaUrl.split('?')[0].split('/').pop()}</div>}
            </Section>
          )}

          <div style={{ display: 'flex', gap: 10 }}>
            <button style={S.btnPrimary} onClick={onPublish} disabled={!!busy}>{busy === 'publish' ? 'Publishing…' : 'Publish'}</button>
            <button style={S.btn} onClick={onSave} disabled={!!busy}>{busy === 'save' ? 'Saving…' : 'Save draft'}</button>
            <button style={S.btnGhost} onClick={onCancel}>Cancel</button>
          </div>
        </div>

        {/* ── live preview ── */}
        <div style={{ position: 'sticky', top: 12 }}>
          <div style={S.lbl}>Live preview</div>
          <Preview board={board} itemsByCat={itemsByCat} addOnsByCat={addOnsByCat} six={six} allCats={allCats} links={links} activeMenuId={activeMenuId} />
          <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 8, lineHeight: 1.5 }}>The real display auto-scales type to fill the screen. Publish to push to paired displays.</div>
        </div>
      </div>
    </div>
  );
}

// activeMenuId: the menu the board follows right now (Follow timed menus), or null.
// It narrows the arranged blocks exactly as the TV does (same shared helper, same
// never-blank fallback) and picks the price tier. Null = arranged blocks, no tier.
function Preview({ board, itemsByCat, addOnsByCat = {}, six, allCats = [], links = [], activeMenuId = null }) {
  const t = { ...DEF_THEME, ...board.theme };
  const disp = { ...DEF_DISP, ...board.display_options };
  const ar = board.orientation === 'portrait' ? '9 / 16' : '16 / 9';
  const rootRef = useRef(null), areaRef = useRef(null), flowRef = useRef(null);

  const blocks = board.layout?.blocks || [];
  // The TV's sections exactly (lib/menuBoardSections.js): subcategories, headings, add-ons, text panels.
  const secs = boardSectionsForMenu(boardSections({ blocks, cats: allCats, itemsByCat, addOnsByCat }), { categories: allCats, links, activeMenuId });
  const fixedCols = Number(board.layout?.columns) || 0;   // 0 = Auto
  const totalItems = secs.reduce((n, s) => n + ((s.items && s.items.length) || 0), 0);

  // mini auto-fit: mirror the live board exactly — explicit integer column count
  // (text-size preference → more columns = bigger fill text), column-fill:auto so
  // columns fill top-to-bottom, and the font grows until the content fills without
  // clipping. Never column-width:auto (it would clip silently on the real board).
  useLayoutEffect(() => {
    const area = areaRef.current, flow = flowRef.current;
    if (!area || !flow) return;
    const root = rootRef.current;
    if (!root) return;
    // The TV's rule, on the preview's own frame (v5.9.68): header, sections and footer all scale.
    const cols = boardColumns({ textScale: board.display_options?.textScale, orientation: board.orientation, fixedCols, totalItems });
    flow.style.columnWidth = 'auto';
    flow.style.columnCount = String(cols);
    const fits = (px) => { root.style.fontSize = px + 'px'; return flow.scrollWidth <= flow.clientWidth + 1 && flow.scrollHeight <= flow.clientHeight + 1; };
    root.style.fontSize = scaledFont(fitFont(fits, { min: 4, max: 44 }), board.display_options?.textScale, 4) + 'px';
  });

  if (board.mode === 'marketing') {
    return <div style={{ aspectRatio: ar, background: '#000', borderRadius: 10, border: '4px solid #060504', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', fontSize: 12, overflow: 'hidden' }}>
      {board.marketing?.mediaUrl ? (board.marketing.mediaType === 'video'
        ? <video src={board.marketing.mediaUrl} muted loop autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: board.marketing.fit || 'cover' }} />
        : <img src={board.marketing.mediaUrl} alt="" style={{ width: '100%', height: '100%', objectFit: board.marketing.fit || 'cover' }} />)
      : 'Marketing media'}
    </div>;
  }
  return (
    <div ref={rootRef} style={{ aspectRatio: ar, background: t.bgColor, color: t.textColor, borderRadius: 10, border: '4px solid #060504', padding: '10px 12px', overflow: 'hidden', fontFamily: t.font || 'inherit', position: 'relative' }}>
      {t.bgImageUrl && <><div style={{ position: 'absolute', inset: 0, backgroundImage: `url(${t.bgImageUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }} /><div style={{ position: 'absolute', inset: 0, background: t.bgColor, opacity: 0.72 }} /></>}
      <div style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column' }}>
        <BoardHeader theme={t} name={board.name} />
        {secs.length === 0
          ? <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8a8276', fontSize: 11 }}>Add categories to preview</div>
          : <div ref={areaRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              <div ref={flowRef} style={{ height: '100%', columnGap: '1.7em', columnFill: 'balance' }}>
                {secs.map(sec => <BoardSection key={sec.id} sec={sec} theme={t} disp={disp} six={six} activeMenuId={activeMenuId} />)}
              </div>
            </div>}
        <BoardFooter theme={t} />
      </div>
    </div>
  );
}

// ── little UI helpers (ServOS BO style) ──
const Head = ({ title, sub }) => (
  <div style={{ marginBottom: 4 }}>
    <div style={{ fontSize: 11, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 700 }}>Channels</div>
    <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--t1)', marginTop: 2 }}>{title}</div>
    <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4, maxWidth: 720, lineHeight: 1.5 }}>{sub}</div>
  </div>
);
const Section = ({ title, desc, children }) => (
  <div style={S.section}>
    {title && <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{title}</div>}
    {desc && <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 2, marginBottom: 4 }}>{desc}</div>}
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: title ? 8 : 0 }}>{children}</div>
  </div>
);
const Field = ({ label, children }) => (<div><div style={S.lbl}>{label}</div><div style={{ marginTop: 4 }}>{children}</div></div>);
const Pills = ({ opts, val, on }) => (
  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
    {opts.map(([v, l]) => <button key={v} onClick={() => on(v)} style={String(val) === String(v) ? S.pillOn : S.pill}>{l}</button>)}
  </div>
);
const Toggle = ({ on, label, set }) => (
  <button onClick={() => set(!on)} style={on ? S.pillOn : S.pill}>{on ? '✓ ' : ''}{label}</button>
);
const ColorRow = ({ label, val, on }) => (
  <div><div style={S.lbl}>{label}</div><div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
    <input type="color" value={val || '#000000'} onChange={e => on(e.target.value)} style={{ width: 34, height: 30, border: '1px solid var(--bdr)', borderRadius: 6, background: 'none', cursor: 'pointer' }} />
    <input style={{ ...S.inp, width: 92 }} value={val} onChange={e => on(e.target.value)} />
  </div></div>
);

const S = {
  empty: { textAlign: 'center', padding: '50px 20px', color: 'var(--t3)', fontSize: 14 },
  errBar: { background: 'var(--red-d)', border: '1px solid var(--red-b)', color: 'var(--red)', borderRadius: 8, padding: '8px 12px', fontSize: 13, marginTop: 10 },
  card: { width: 230, background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 14 },
  addCard: { width: 230, minHeight: 110, background: 'transparent', border: '1px dashed var(--bdr2)', borderRadius: 12, color: 'var(--acc)', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  section: { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 14 },
  lbl: { fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.04em' },
  inp: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' },
  row: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 0', borderBottom: '1px solid var(--bdr)' },
  mini: { width: 26, height: 26, borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--bg2)', color: 'var(--t2)', cursor: 'pointer', fontFamily: 'inherit' },
  miniX: { width: 26, height: 26, borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--bg2)', color: 'var(--red)', cursor: 'pointer', fontFamily: 'inherit' },
  chip: { fontSize: 12, padding: '4px 10px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t2)', cursor: 'pointer', fontFamily: 'inherit' },
  pill: { fontSize: 12.5, padding: '6px 11px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t2)', cursor: 'pointer', fontFamily: 'inherit' },
  pillOn: { fontSize: 12.5, padding: '6px 11px', borderRadius: 8, border: '1px solid var(--acc)', background: 'var(--acc-d)', color: 'var(--acc)', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700 },
  spanOff: { fontSize: 11, padding: '4px 9px', borderRadius: 6, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t3)', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  spanOn: { fontSize: 11, padding: '4px 9px', borderRadius: 6, border: '1px solid var(--acc)', background: 'var(--acc-d)', color: 'var(--acc)', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700, whiteSpace: 'nowrap' },
  btn: { padding: '8px 14px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  btnGhost: { padding: '8px 14px', borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--t3)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  btnPrimary: { padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--acc)', color: '#0b0c10', fontSize: 13, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' },
  back: { background: 'none', border: 'none', color: 'var(--t3)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', padding: 0, marginBottom: 10 },
};
