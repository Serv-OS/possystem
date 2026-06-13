// src/backoffice/sections/MenuBoards.jsx
//
// Back Office → Channels → Menu boards. Create/manage "screens" for the digital
// menu board (the ?mode=menuboard display surface). Each screen = a menu_boards
// row: pick which categories show, reorder them, set display options + columns +
// orientation + mode + branding, then Publish (paired screens refresh live).
// Keys here MUST match MenuBoardSurface.jsx (layout/display_options/theme/marketing).

import { useEffect, useMemo, useState, useCallback, useRef, useLayoutEffect } from 'react';
import { supabase, isMock, getActiveLocationSync } from '../../lib/supabase';
import { fetchMenuCategories, fetchMenuItems, fetch86List } from '../../lib/db';
import { money } from '../../lib/currency';

const ASSET_BUCKET = 'receipt-assets';
const FONTS = ['', 'Plus Jakarta Sans', 'Space Grotesk', 'Inter', 'Georgia', 'Oswald'];
const DEF_THEME = { bgColor: '#14110d', textColor: '#F5EFE6', accent: '#E8A23C', font: '', footerNote: '', logoUrl: '', bgImageUrl: '' };
const DEF_DISP = { showDescription: true, showAllergens: true, showPrices: true, showImages: false, soldOut: 'grey', textScale: 1, hidePriceless: false };
const newBoard = (n) => ({ name: `Menu board ${n}`, orientation: 'landscape', mode: 'menu', layout: { columns: 'auto', blocks: [] }, display_options: { ...DEF_DISP }, theme: { ...DEF_THEME }, marketing: { mediaUrl: '', mediaType: 'image', fit: 'cover' } });

const boardPrice = (it) => {
  const p = it.pricing;
  if (p && typeof p === 'object') {
    for (const k of ['dineIn', 'all', 'base']) if (p[k] != null && Number(p[k]) > 0) return Number(p[k]);
    if (p.base != null) return Number(p.base) || 0;
  }
  return Number(it.price) || 0;
};
const DIET = { gf: 'GF', glutenfree: 'GF', 'gluten-free': 'GF', 'gluten free': 'GF', v: 'V', veg: 'V', vegetarian: 'V', vg: 'VG', vegan: 'VG', df: 'DF', dairyfree: 'DF', 'dairy-free': 'DF' };
const dietaryBadges = (it) => {
  const out = [], seen = new Set();
  for (const t of (Array.isArray(it.tags) ? it.tags : [])) { const b = DIET[String(t).toLowerCase().trim()]; if (b && !seen.has(b)) { seen.add(b); out.push(b); } }
  return out;
};
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
  const [items, setItems] = useState([]);
  const [six, setSix] = useState(new Set());
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
      const [b, c, it, s, scr] = await Promise.all([
        supabase.from('menu_boards').select('*').eq('location_id', id).order('created_at'),
        fetchMenuCategories(id), fetchMenuItems(id), fetch86List(id),
        supabase.from('menu_board_screens').select('*').eq('location_id', id).order('created_at'),
      ]);
      setScreens(b?.data || []);
      setCats((c?.data || []).filter(x => !x.parent_id && !x.is_special).sort((a, z) => (a.sort_order || 0) - (z.sort_order || 0)));
      setItems(it?.data || []);
      setSix(new Set((s?.data || []).map(r => r.item_id)));
      setPaired(scr?.data || []);
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
    try { await supabase.from('menu_board_screens').delete().eq('id', screenId); await load(); }
    catch (e) { setErr(e.message || 'Could not remove screen'); }
    finally { setBusy(''); }
  };

  const itemsByCat = useMemo(() => {
    const vis = items.filter(it => !it.archived && !(it.visibility && it.visibility.kiosk === false));
    const byId = Object.fromEntries(vis.map(i => [i.id, i]));
    const kids = {};
    for (const it of vis) if (it.parent_id && byId[it.parent_id]) (kids[it.parent_id] ||= []).push(it);
    for (const k in kids) kids[k].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const m = {};
    for (const it of vis) {
      if (it.parent_id && byId[it.parent_id]) continue;   // variant child — nested under its parent
      for (const cid of [it.cat, ...(Array.isArray(it.cats) ? it.cats : [])].filter(Boolean)) (m[cid] ||= []).push({ ...it, _variants: kids[it.id] || [] });
    }
    for (const k in m) m[k].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    return m;
  }, [items]);

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
      setEditing(null); await load();
    } catch (e) { setErr(e.message || 'Save failed'); }
    finally { setBusy(''); }
  };

  const del = async (id) => {
    if (!window.confirm('Delete this menu board screen?')) return;
    await supabase.from('menu_boards').delete().eq('id', id);
    await load();
  };

  const screenUrl = (id) => `${window.location.origin}/?mode=menuboard&board=${id}`;
  const copyLink = async (id) => {
    try { await navigator.clipboard.writeText(screenUrl(id)); } catch {}
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
    <Editor board={editing} setBoard={setEditing} cats={cats} itemsByCat={itemsByCat} six={six}
      onSave={() => save(false)} onPublish={() => save(true)} onCancel={() => setEditing(null)}
      onUpload={upload} busy={busy} err={err} />
  );

  const boardName = (id) => screens.find(b => b.id === id)?.name || '—';

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
          <input style={{ ...S.inp, width: 170, textTransform: 'uppercase' }} placeholder="Code e.g. WING-4823"
            value={pairCode} onChange={e => setPairCode(e.target.value)} />
          <select style={{ ...S.inp, width: 200 }} value={pairBoard} onChange={e => setPairBoard(e.target.value)}>
            <option value="">Show board…</option>
            {screens.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button style={S.btnPrimary} onClick={pairScreen} disabled={busy === 'pair'}>{busy === 'pair' ? 'Pairing…' : 'Pair screen'}</button>
          {pairMsg && <span style={{ fontSize: 12, color: pairMsg.startsWith('✓') ? 'var(--grn)' : 'var(--red)' }}>{pairMsg}</span>}
        </div>

        {paired.length > 0 ? (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {paired.map(s => { const sl = seenLabel(s.last_seen_at); return (
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
        ) : <div style={{ fontSize: 12, color: 'var(--t4)', marginTop: 12 }}>No screens paired yet.</div>}
      </div>
    </div>
  );
}

function Editor({ board, setBoard, cats, itemsByCat, six, onSave, onPublish, onCancel, onUpload, busy, err }) {
  const set = (patch) => setBoard(b => ({ ...b, ...patch }));
  const setLayout = (patch) => setBoard(b => ({ ...b, layout: { ...b.layout, ...patch } }));
  const setDisp = (patch) => setBoard(b => ({ ...b, display_options: { ...b.display_options, ...patch } }));
  const setTheme = (patch) => setBoard(b => ({ ...b, theme: { ...b.theme, ...patch } }));
  const setMkt = (patch) => setBoard(b => ({ ...b, marketing: { ...b.marketing, ...patch } }));

  const blocks = board.layout?.blocks || [];
  const selIds = blocks.map(x => x.categoryId);
  const offCats = cats.filter(c => !selIds.includes(c.id));
  const [dragI, setDragI] = useState(null);
  const addCat = (id) => setLayout({ blocks: [...blocks, { categoryId: id, span: 1 }] });
  const removeBlk = (i) => setLayout({ blocks: blocks.filter((_, j) => j !== i) });
  const reorder = (from, to) => { if (from == null || to == null || from === to) return; const a = [...blocks]; const [m] = a.splice(from, 1); a.splice(to, 0, m); setLayout({ blocks: a }); };
  const toggleSpan = (i) => setLayout({ blocks: blocks.map((b, j) => j === i ? { ...b, span: b.span === 'all' ? 1 : 'all' } : b) });
  const catLabel = (id) => cats.find(c => c.id === id)?.label || '—';

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
              <Field label="Orientation"><Pills opts={[['landscape', 'Landscape'], ['portrait', 'Portrait']]} val={board.orientation} on={v => set({ orientation: v })} /></Field>
              <Field label="Mode"><Pills opts={[['menu', 'Menu'], ['marketing', 'Marketing']]} val={board.mode} on={v => set({ mode: v })} /></Field>
            </div>
          </Section>

          {board.mode === 'menu' ? (
            <>
              <Section title="Categories on this screen" desc="Drag to reorder. “Full width” makes a category span the whole board (a hero); the rest auto-balance into columns.">
                {blocks.length === 0 && <div style={{ fontSize: 12, color: 'var(--t4)' }}>No categories yet — add some below.</div>}
                {blocks.map((blk, i) => (
                  <div key={blk.categoryId} draggable
                    onDragStart={() => setDragI(i)}
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => { reorder(dragI, i); setDragI(null); }}
                    onDragEnd={() => setDragI(null)}
                    style={{ ...S.row, cursor: 'grab', borderRadius: 6, background: dragI === i ? 'var(--bg3)' : 'transparent' }}>
                    <span style={{ color: 'var(--t4)', fontSize: 15, cursor: 'grab', userSelect: 'none' }} title="Drag to reorder">⠿</span>
                    <span style={{ flex: 1, fontSize: 13, color: 'var(--t1)' }}>{catLabel(blk.categoryId)} <span style={{ color: 'var(--t4)', fontSize: 11 }}>· {(itemsByCat[blk.categoryId] || []).length} items</span></span>
                    <button style={blk.span === 'all' ? S.spanOn : S.spanOff} onClick={() => toggleSpan(i)} title="Span the full width of the board (hero)">Full width</button>
                    <button style={S.miniX} onClick={() => removeBlk(i)}>✕</button>
                  </div>
                ))}
                {offCats.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={S.lbl}>Add category</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 5 }}>
                      {offCats.map(c => <button key={c.id} style={S.chip} onClick={() => addCat(c.id)}>+ {c.label}</button>)}
                    </div>
                  </div>
                )}
              </Section>

              <Section title="Layout & display">
                <Field label="Columns"><Pills opts={[['auto', 'Auto'], ['2', '2'], ['3', '3'], ['4', '4']]} val={String(board.layout.columns)} on={v => setLayout({ columns: v === 'auto' ? 'auto' : Number(v) })} /></Field>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                  <Toggle on={board.display_options.showDescription} label="Descriptions" set={v => setDisp({ showDescription: v })} />
                  <Toggle on={board.display_options.showAllergens} label="Allergens" set={v => setDisp({ showAllergens: v })} />
                  <Toggle on={board.display_options.showPrices} label="Prices" set={v => setDisp({ showPrices: v })} />
                  <Toggle on={board.display_options.showImages} label="Images" set={v => setDisp({ showImages: v })} />
                  <Toggle on={board.display_options.hidePriceless} label="Hide items with no price" set={v => setDisp({ hidePriceless: v })} />
                </div>
                <Field label="When an item is sold out"><Pills opts={[['grey', 'Grey “sold out”'], ['hide', 'Hide it']]} val={board.display_options.soldOut} on={v => setDisp({ soldOut: v })} /></Field>
                <Field label="Text size"><Pills opts={[['0.85', 'Smaller'], ['1', 'Default'], ['1.15', 'Larger'], ['1.3', 'Extra large']]} val={String(board.display_options.textScale ?? 1)} on={v => setDisp({ textScale: Number(v) })} /></Field>
              </Section>

              <Section title="Branding">
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <ColorRow label="Background" val={board.theme.bgColor} on={v => setTheme({ bgColor: v })} />
                  <ColorRow label="Text" val={board.theme.textColor} on={v => setTheme({ textColor: v })} />
                  <ColorRow label="Accent" val={board.theme.accent} on={v => setTheme({ accent: v })} />
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
          <Preview board={board} cats={cats} itemsByCat={itemsByCat} six={six} />
          <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 8, lineHeight: 1.5 }}>The real display auto-scales type to fill the screen. Publish to push to paired displays.</div>
        </div>
      </div>
    </div>
  );
}

function Preview({ board, cats, itemsByCat, six }) {
  const t = { ...DEF_THEME, ...board.theme };
  const disp = { ...DEF_DISP, ...board.display_options };
  const ar = board.orientation === 'portrait' ? '9 / 16' : '16 / 9';
  const areaRef = useRef(null), flowRef = useRef(null);

  const blocks = board.layout?.blocks || [];
  const secs = blocks.map(b => ({ id: b.categoryId, label: cats.find(c => c.id === b.categoryId)?.label, items: itemsByCat[b.categoryId] || [], span: b.span })).filter(s => s.label);
  const fixedCols = Number(board.layout?.columns) || 0;   // 0 = Auto
  const totalItems = secs.reduce((n, s) => n + ((s.items && s.items.length) || 0), 0);

  // mini auto-fit: mirror the live board exactly — explicit integer column count
  // (text-size preference → more columns = bigger fill text), column-fill:auto so
  // columns fill top-to-bottom, and the font grows until the content fills without
  // clipping. Never column-width:auto (it would clip silently on the real board).
  useLayoutEffect(() => {
    const area = areaRef.current, flow = flowRef.current;
    if (!area || !flow) return;
    const ts = Math.max(0.6, Math.min(1.6, Number(board.display_options?.textScale) || 1));
    const portrait = board.orientation === 'portrait';
    const maxN = portrait ? 3 : 6;
    const tier = ts <= 0.9 ? 0 : ts < 1.075 ? 1 : ts < 1.225 ? 2 : 3;
    let cols = fixedCols || (portrait ? [1, 1, 2, 2] : [2, 3, 4, 5])[tier];
    cols = Math.max(1, Math.min(cols, maxN, Math.ceil((totalItems || 1) / 3)));
    flow.style.columnWidth = 'auto';
    flow.style.columnCount = String(cols);
    const fits = () => flow.scrollWidth <= flow.clientWidth + 1 && flow.scrollHeight <= flow.clientHeight + 1;
    let lo = 4, hi = 44, best = 4;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      flow.style.fontSize = mid + 'px';
      if (fits()) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    flow.style.fontSize = best + 'px';
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
    <div style={{ aspectRatio: ar, background: t.bgColor, color: t.textColor, borderRadius: 10, border: '4px solid #060504', padding: '10px 12px', overflow: 'hidden', fontFamily: t.font || 'inherit', position: 'relative' }}>
      {t.bgImageUrl && <><div style={{ position: 'absolute', inset: 0, backgroundImage: `url(${t.bgImageUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }} /><div style={{ position: 'absolute', inset: 0, background: t.bgColor, opacity: 0.72 }} /></>}
      <div style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: `2px solid ${t.accent}`, paddingBottom: 4, marginBottom: 7, flex: '0 0 auto' }}>
          {t.logoUrl ? <img src={t.logoUrl} alt="" style={{ height: 16, objectFit: 'contain' }} /> : <span style={{ fontSize: 11, fontWeight: 700 }}>{board.name || 'Menu'}</span>}
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#3BD16F' }} />
        </div>
        {secs.length === 0
          ? <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8a8276', fontSize: 11 }}>Add categories to preview</div>
          : <div ref={areaRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              <div ref={flowRef} style={{ height: '100%', columnGap: 12, columnFill: 'auto', fontSize: 13 }}>
                {secs.map(sec => (
                  <div key={sec.id} style={{ marginBottom: '0.9em', breakInside: 'auto', ...(sec.span === 'all' ? { columnSpan: 'all', WebkitColumnSpan: 'all' } : null) }}>
                    <div style={{ fontSize: '0.72em', letterSpacing: '.1em', color: t.accent, marginBottom: '0.35em', textTransform: 'uppercase', fontWeight: 700, breakAfter: 'avoid', WebkitColumnBreakAfter: 'avoid' }}>{sec.label}</div>
                    {sec.items.filter(it => !(disp.hidePriceless && boardPrice(it) <= 0 && !(it._variants || []).length)).map(it => {
                      const variants = it._variants || [];
                      const hasVar = variants.length > 0;
                      const sold = six.has(it.id), price = boardPrice(it), diet = dietaryBadges(it);
                      const muted = t.mutedColor || '#8a8276';
                      return <div key={it.id} style={{ marginBottom: '0.3em', opacity: sold ? 0.45 : 1, breakInside: 'avoid', WebkitColumnBreakInside: 'avoid' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 5 }}>
                          {disp.showImages && it.image && <img src={it.image} alt="" style={{ width: '1.8em', height: '1.8em', objectFit: 'cover', borderRadius: 3, flexShrink: 0 }} />}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '0.6em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.menu_name || it.name}
                              {diet.map(d => <span key={d} style={{ color: '#7fd99a', marginLeft: 3, fontWeight: 700 }}>{d}</span>)}
                              {disp.showAllergens && it.allergens?.length > 0 && it.allergens.map(a => <span key={a} style={{ color: muted, marginLeft: 3, fontSize: '0.85em' }}>{a}</span>)}
                            </div>
                            {disp.showDescription && it.description && <div style={{ fontSize: '0.46em', color: muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.description}</div>}
                          </div>
                          {sold ? <span style={{ fontSize: '0.5em', color: '#f3b0b0', flexShrink: 0 }}>SOLD OUT</span>
                            : !hasVar && disp.showPrices && price > 0 && <span style={{ fontSize: '0.56em', background: t.accent, color: '#1c1206', borderRadius: 6, padding: '0 5px', flexShrink: 0 }}>{money(price)}</span>}
                        </div>
                        {hasVar && <div style={{ marginTop: 1, marginLeft: 1, paddingLeft: (disp.showImages && it.image) ? '2.3em' : 8, borderLeft: `2px solid ${t.accent}55` }}>
                          {variants.map(v => { const vs = six.has(v.id), vp = boardPrice(v);
                            return <div key={v.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4, marginBottom: '0.2em', opacity: vs ? 0.45 : 1 }}>
                              <span style={{ fontSize: '0.5em', color: muted }}>{v.menu_name || v.name}</span>
                              {vs ? <span style={{ fontSize: '0.45em', color: '#f3b0b0' }}>SOLD OUT</span> : disp.showPrices && vp > 0 && <span style={{ fontSize: '0.5em', background: t.accent, color: '#1c1206', borderRadius: 5, padding: '0 4px' }}>{money(vp)}</span>}
                            </div>;
                          })}
                        </div>}
                      </div>;
                    })}
                  </div>
                ))}
              </div>
            </div>}
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
