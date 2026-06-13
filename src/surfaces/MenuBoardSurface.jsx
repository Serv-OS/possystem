// src/surfaces/MenuBoardSurface.jsx  (?mode=menuboard)
//
// Digital menu board — a read-only display surface for an Android TV stick.
// Renders ONE "screen" (a menu_boards row) for the paired location: its chosen
// categories, auto-balanced into columns and auto-fit-scaled so the whole menu
// always fills exactly one screen. Live: menu/price/86 stream over Supabase
// Realtime; the board's own row streams design changes (publish). Cache-first so
// it never goes blank offline. No SyncBridge (read-only), like CustomerDisplay.
//
// Phase 1: render + auto-fit + auto-balance + 86 "sold out" + marketing mode +
// offline cache. Builder, drag-arrange, pagination, dayparting come later
// (see MENU_BOARD_PLAN.md).

import { useEffect, useState, useRef, useLayoutEffect, useCallback, useMemo } from 'react';
import { supabase, isMock, getActiveLocationSync } from '../lib/supabase';
import { fetchMenuCategories, fetchMenuItems, fetch86List } from '../lib/db';
import { money } from '../lib/currency';

const DEFAULT_THEME = { bgColor: '#14110d', textColor: '#F5EFE6', mutedColor: '#B8AE9E', accent: '#E8A23C', font: '', footerNote: '', logoUrl: null, bgImageUrl: null };
const DEFAULT_DISPLAY = { showDescription: true, showAllergens: true, showPrices: true, showImages: false, soldOut: 'grey', textScale: 1, hidePriceless: false };
const FIT = { base: 30, min: 11, max: 48 };          // px; the fit-loop lands somewhere in here
const cacheKey = (loc, b) => `rpos-mb-${loc}-${b || 'def'}`;

// Board price: prefer the dine-in price, then any-channel, then base, then legacy scalar.
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
  for (const t of (Array.isArray(it.tags) ? it.tags : [])) {
    const b = DIET[String(t).toLowerCase().trim()];
    if (b && !seen.has(b)) { seen.add(b); out.push(b); }
  }
  return out;
};
const visibleItem = (it) => !it.archived && (!it.visibility || it.visibility.kiosk !== false);

export default function MenuBoardSurface() {
  // A screen is addressed by ?board=<id> — point a stick straight at one screen.
  const boardId = useMemo(() => { try { return new URLSearchParams(window.location.search).get('board'); } catch { return null; } }, []);
  const [locId, setLocId] = useState(null);
  const [resolving, setResolving] = useState(true);
  const [data, setData] = useState(null);   // { board, cats:[], items:[], six:Set }
  const reloadTimer = useRef(null);

  // ── resolve the location. With ?board=<id> the board itself carries the
  // location (no pairing needed). Otherwise use the paired/active location. ──
  useEffect(() => {
    let alive = true, tries = 0;
    (async () => {
      if (boardId && !isMock && supabase) {
        const { data: b } = await supabase.from('menu_boards').select('location_id').eq('id', boardId).maybeSingle();
        if (alive && b?.location_id) { setLocId(b.location_id); setResolving(false); return; }
      }
      const tick = () => {
        if (!alive) return;
        const id = getActiveLocationSync();
        if (id && id !== 'loc-demo') { setLocId(id); setResolving(false); return; }
        if (++tries > 8) { setResolving(false); return; }
        setTimeout(tick, 1500);
      };
      tick();
    })();
    return () => { alive = false; };
  }, [boardId]);

  const load = useCallback(async (id) => {
    if (isMock || !supabase || !id) return;
    try {
      const boardQ = boardId
        ? supabase.from('menu_boards').select('*').eq('id', boardId).maybeSingle()
        : supabase.from('menu_boards').select('*').eq('location_id', id).order('created_at').limit(1).maybeSingle();
      const [boardRes, catsRes, itemsRes, sixRes] = await Promise.all([
        boardQ, fetchMenuCategories(id), fetchMenuItems(id), fetch86List(id),
      ]);
      const next = {
        board: boardRes?.data || null,
        cats: catsRes?.data || [],
        items: itemsRes?.data || [],
        six: new Set((sixRes?.data || []).map((r) => r.item_id)),
      };
      setData(next);
      try { localStorage.setItem(cacheKey(id, boardId), JSON.stringify({ ...next, six: [...next.six] })); } catch {}
    } catch (e) { console.warn('[menuboard] load', e?.message); }
  }, [boardId]);

  // boot: render cache instantly, then refresh + subscribe
  useEffect(() => {
    if (!locId) return;
    try {
      const c = JSON.parse(localStorage.getItem(cacheKey(locId, boardId)) || 'null');
      if (c) setData({ ...c, six: new Set(c.six || []) });
    } catch {}
    load(locId);

    if (isMock || !supabase) return;
    const reload = () => { clearTimeout(reloadTimer.current); reloadTimer.current = setTimeout(() => load(locId), 400); };
    const ch = supabase.channel(`menuboard:${locId}:${boardId || 'def'}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'eighty_six', filter: `location_id=eq.${locId}` }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_items', filter: `location_id=eq.${locId}` }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_boards', filter: `location_id=eq.${locId}` }, reload)
      .subscribe();
    const poll = setInterval(() => load(locId), 90000);   // safety net for missed events / long uptime
    return () => { supabase.removeChannel(ch); clearInterval(poll); clearTimeout(reloadTimer.current); };
  }, [locId, load, boardId]);

  if (resolving && !data) return <Splash text="Starting menu board…" />;
  if (!locId) return <Splash text="Pair this screen" sub="Open the device pairing screen to link this display to a venue." />;
  if (!data) return <Splash text="Loading menu…" />;
  return <Board data={data} />;
}

function Board({ data }) {
  const theme = { ...DEFAULT_THEME, ...(data.board?.theme || {}) };
  const disp = { ...DEFAULT_DISPLAY, ...(data.board?.display_options || {}) };
  const mode = data.board?.mode || 'menu';
  const orientation = data.board?.orientation || 'landscape';
  const textScale = Math.max(0.6, Math.min(1.6, Number(disp.textScale) || 1));

  const boardRef = useRef(null);
  const contentRef = useRef(null);
  const flowRef = useRef(null);
  const [fitTick, setFitTick] = useState(0);

  // ordered sections; content flows column-by-column and fills the screen
  const sections = mode === 'menu' ? buildSections(data) : [];
  const fixedCols = Number(data.board?.layout?.columns) || 0;   // operator override; 0 = Auto

  // ── auto-fit: FILL the screen. Columns fill top-to-bottom (column-fill:auto)
  // so a column only breaks to the next when it is genuinely full — no early
  // "balanced" break that leaves the bottom of the screen empty. We grow the
  // root font-size until the content fills every column to the bottom (one more
  // pixel would spill into an extra column). With "Auto" columns we drive the
  // layout by a readable column WIDTH, so the column count adapts to how much
  // content there is and how big the fitted font ends up. ──
  useLayoutEffect(() => {
    if (mode !== 'menu') return;
    const root = boardRef.current, flow = flowRef.current;
    if (!root || !flow) return;
    // The text-size preference is NOT a post-multiply (that would overflow a
    // screen the fit already filled). In Auto it widens/narrows the columns —
    // "Larger" → wider columns → fewer of them → bigger text that still fills.
    if (fixedCols) { flow.style.columnCount = String(fixedCols); flow.style.columnWidth = 'auto'; }
    else { flow.style.columnCount = 'auto'; flow.style.columnWidth = ((orientation === 'portrait' ? 19 : 16) * textScale) + 'em'; }
    // content fits when it neither spills into an extra column (width) nor
    // overflows a too-tall element (height) — i.e. nothing is clipped.
    const fits = () => flow.scrollWidth <= flow.clientWidth + 1 && flow.scrollHeight <= flow.clientHeight + 1;
    let lo = FIT.min, hi = FIT.max, best = FIT.min;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      root.style.fontSize = mid + 'px';
      if (fits()) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    root.style.fontSize = best + 'px';
  }, [data, mode, orientation, fixedCols, textScale, fitTick]);

  useEffect(() => {
    const refit = () => setFitTick((t) => t + 1);
    window.addEventListener('resize', refit);
    window.addEventListener('mb-refit', refit);
    return () => { window.removeEventListener('resize', refit); window.removeEventListener('mb-refit', refit); };
  }, []);

  const rootStyle = {
    position: 'fixed', inset: 0, overflow: 'hidden',
    background: theme.bgColor, color: theme.textColor,
    fontFamily: theme.font || "'Plus Jakarta Sans', system-ui, sans-serif",
    fontSize: FIT.base + 'px',
  };
  const bgLayer = theme.bgImageUrl ? {
    position: 'absolute', inset: 0, backgroundImage: `url(${theme.bgImageUrl})`,
    backgroundSize: 'cover', backgroundPosition: 'center', opacity: 1,
  } : null;
  const scrim = theme.bgImageUrl ? { position: 'absolute', inset: 0, background: theme.bgColor, opacity: 0.72 } : null;

  // ── marketing mode: fullscreen media, no menu ──
  if (mode === 'marketing') {
    const m = data.board?.marketing || {};
    return (
      <div ref={boardRef} style={rootStyle}>
        {m.mediaUrl && m.mediaType === 'video' && (
          <video src={m.mediaUrl} autoPlay muted loop playsInline
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: m.fit || 'cover' }} />
        )}
        {m.mediaUrl && m.mediaType !== 'video' && (
          <div style={{ position: 'absolute', inset: 0, backgroundImage: `url(${m.mediaUrl})`, backgroundSize: m.fit || 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' }} />
        )}
        {!m.mediaUrl && <Splash text="Marketing screen" sub="Upload an image or video in Back Office." inline />}
      </div>
    );
  }

  if (!sections.length) {
    return <div style={rootStyle}><Splash text="Menu coming soon" inline /></div>;
  }

  const pad = orientation === 'portrait' ? '4.5vmin 4vmin' : '3.5vmin 4vmin';
  return (
    <div ref={boardRef} style={rootStyle}>
      {bgLayer && <div style={bgLayer} />}
      {scrim && <div style={scrim} />}
      <div style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', padding: pad, boxSizing: 'border-box' }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: `0.09em solid ${theme.accent}`, paddingBottom: '0.35em', marginBottom: '0.6em', flex: '0 0 auto' }}>
          {theme.logoUrl
            ? <img src={theme.logoUrl} alt="" style={{ height: '1.4em', objectFit: 'contain' }} />
            : <div style={{ fontSize: '1em', fontWeight: 600, letterSpacing: '.06em' }}>{data.board?.name || 'Menu'}</div>}
          <span style={{ fontSize: '0.34em', color: theme.mutedColor, display: 'flex', alignItems: 'center', gap: '.5em', opacity: .8 }}>
            <span style={{ width: '.55em', height: '.55em', borderRadius: '50%', background: '#3BD16F', display: 'inline-block' }} />Live
          </span>
        </div>

        {/* dynamic newspaper flow — EVERY item; categories flow & balance across
            columns; the fit-loop scales the whole thing to fill one screen. */}
        <div ref={contentRef} style={{ flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>
          <div ref={flowRef} style={{ height: '100%', columnGap: '1.7em', columnFill: 'auto' }}>
            {sections.map((sec) => (
              <Section key={sec.cat.id} sec={sec} theme={theme} disp={disp} six={data.six} />
            ))}
          </div>
        </div>

        {/* footer */}
        <div style={{ flex: '0 0 auto', borderTop: `0.04em solid ${theme.mutedColor}33`, marginTop: '0.5em', paddingTop: '0.4em', display: 'flex', justifyContent: 'space-between', fontSize: '0.32em', color: theme.mutedColor }}>
          <span>{theme.footerNote || 'Please ask staff about the 14 allergens.'}</span>
        </div>
      </div>
    </div>
  );
}

function Section({ sec, theme, disp, six }) {
  const { cat, items } = sec;
  return (
    <div style={{ marginBottom: '1em', breakInside: 'auto', ...(sec.span === 'all' ? { columnSpan: 'all', WebkitColumnSpan: 'all' } : null) }}>
      <div style={{ fontSize: '0.62em', fontWeight: 600, letterSpacing: '.16em', color: theme.accent, marginBottom: '0.45em', textTransform: 'uppercase', breakAfter: 'avoid', WebkitColumnBreakAfter: 'avoid' }}>{cat.label}</div>
      {items.filter((it) => !(disp.hidePriceless && boardPrice(it) <= 0 && !(it._variants || []).length)).map((it) => {
        const variants = it._variants || [];
        const hasVar = variants.length > 0;
        const sold = six.has(it.id);
        const diet = dietaryBadges(it);
        const price = boardPrice(it);
        return (
          <div key={it.id} style={{ marginBottom: '0.55em', opacity: sold ? 0.42 : 1, breakInside: 'avoid', WebkitColumnBreakInside: 'avoid' }}>
            {/* product line */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.55em' }}>
              {disp.showImages && it.image && <img src={it.image} alt="" style={{ width: '2.4em', height: '2.4em', objectFit: 'cover', borderRadius: '0.3em', flexShrink: 0 }} />}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '0.5em', fontWeight: 600, lineHeight: 1.15 }}>
                  {it.menu_name || it.name}
                  {diet.map((d) => (
                    <span key={d} style={{ fontSize: '0.66em', background: '#1f3a26', color: '#7fd99a', borderRadius: '1em', padding: '0 .55em', marginLeft: '.3em', whiteSpace: 'nowrap', fontWeight: 700 }}>{d}</span>
                  ))}
                  {disp.showAllergens && Array.isArray(it.allergens) && it.allergens.length > 0 && (
                    <span style={{ marginLeft: '.35em' }}>
                      {it.allergens.map((a) => (
                        <span key={a} style={{ fontSize: '0.62em', background: `${theme.mutedColor}22`, color: theme.mutedColor, borderRadius: '1em', padding: '0 .5em', marginLeft: '.22em', whiteSpace: 'nowrap' }}>{a}</span>
                      ))}
                    </span>
                  )}
                </div>
                {disp.showDescription && it.description && (
                  <div style={{ fontSize: '0.38em', color: theme.mutedColor, lineHeight: 1.3, marginTop: '.15em' }}>{it.description}</div>
                )}
              </div>
              <div style={{ flexShrink: 0, display: 'flex', alignItems: 'flex-start', lineHeight: 1 }}>
                {sold
                  ? <span style={{ fontSize: '0.34em', fontWeight: 600, letterSpacing: '.05em', background: '#5a1e1e', color: '#f3b0b0', borderRadius: '1.4em', padding: '.2em .8em' }}>SOLD OUT</span>
                  : (!hasVar && disp.showPrices && price > 0 && <span style={{ fontSize: '0.42em', fontWeight: 600, background: theme.accent, color: '#1c1206', borderRadius: '1.4em', padding: '.18em .7em' }}>{money(price)}</span>)}
              </div>
            </div>
            {/* indented variant sizes */}
            {hasVar && (
              <div style={{ marginTop: '.18em', marginLeft: '.2em', paddingLeft: (disp.showImages && it.image) ? '3em' : '0.9em', borderLeft: `0.14em solid ${theme.accent}40` }}>
                {variants.map((v) => {
                  const vsold = six.has(v.id);
                  const vp = boardPrice(v);
                  return (
                    <div key={v.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5em', marginBottom: '.34em', opacity: vsold ? 0.42 : 1 }}>
                      <span style={{ fontSize: '0.4em', color: theme.mutedColor }}>{v.menu_name || v.name}</span>
                      {vsold
                        ? <span style={{ fontSize: '0.3em', fontWeight: 600, background: '#5a1e1e', color: '#f3b0b0', borderRadius: '1.4em', padding: '.2em .7em' }}>SOLD OUT</span>
                        : (disp.showPrices && vp > 0 && <span style={{ fontSize: '0.36em', fontWeight: 600, background: theme.accent, color: '#1c1206', borderRadius: '1.4em', padding: '.16em .65em' }}>{money(vp)}</span>)}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Ordered, non-empty category sections. Variant children (items with a parent_id
// pointing at a visible item — e.g. Regular/Large under "Pepsi Max") are nested
// onto their parent as `_variants` rather than shown as flat top-level rows.
function buildSections(data) {
  const visible = data.items.filter(visibleItem);
  const byId = Object.fromEntries(visible.map((i) => [i.id, i]));
  const kids = {};
  for (const it of visible) if (it.parent_id && byId[it.parent_id]) (kids[it.parent_id] ||= []).push(it);
  for (const k in kids) kids[k].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  const itemsByCat = {};
  for (const it of visible) {
    if (it.parent_id && byId[it.parent_id]) continue;   // variant child — shown under its parent
    const ids = new Set([it.cat, ...(Array.isArray(it.cats) ? it.cats : [])].filter(Boolean));
    for (const cid of ids) (itemsByCat[cid] ||= []).push(it);
  }
  for (const k in itemsByCat) itemsByCat[k].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  let cats = data.cats.filter((c) => !c.parent_id && !c.is_special).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const spanById = {};
  const blocks = data.board?.layout?.blocks;
  if (Array.isArray(blocks) && blocks.length) {
    const byCatId = Object.fromEntries(cats.map((c) => [c.id, c]));
    cats = blocks.map((b) => { spanById[b.categoryId] = b.span; return byCatId[b.categoryId]; }).filter(Boolean);
  }
  return cats
    .map((cat) => ({ cat, span: spanById[cat.id], items: (itemsByCat[cat.id] || []).map((it) => ({ ...it, _variants: kids[it.id] || [] })) }))
    .filter((s) => s.items.length > 0);
}

function Splash({ text, sub, inline }) {
  const wrap = inline
    ? { position: 'absolute', inset: 0 }
    : { position: 'fixed', inset: 0, background: '#14110d' };
  return (
    <div style={{ ...wrap, color: '#F5EFE6', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", padding: '8vw' }}>
      <div style={{ fontSize: 'clamp(20px,4vw,40px)', fontWeight: 600, letterSpacing: '-.01em' }}>{text}</div>
      {sub && <div style={{ fontSize: 'clamp(13px,1.6vw,18px)', color: '#B8AE9E', marginTop: 12, maxWidth: 520 }}>{sub}</div>}
    </div>
  );
}
