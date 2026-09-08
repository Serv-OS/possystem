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
// offline cache. Builder, drag-arrange, pagination come later (see
// MENU_BOARD_PLAN.md).
//
// Follow timed menus (layout.followMenus, default false): when a board asks for
// it, the arranged categories are narrowed to the menu that is live on the
// VENUE clock (the shared resolver, same schedules as the till, kiosk, phone and
// online) and prices read that menu's tier. Menus, links and the venue timezone
// ride the same cache so an offline boot still evaluates. Never blank: if the
// narrowing would leave nothing, or the menus read fails, the full arranged
// board shows. See src/lib/menuBoardMenus.js (shared with the BO preview).

import { useEffect, useState, useRef, useLayoutEffect, useCallback, useMemo } from 'react';
import { supabase, platformSupabase, isMock, ensureAuthToken } from '../lib/supabase';
import { fetchMenuCategories, fetchMenuItems, fetch86List, fetchMenus, fetchMenuCategoryLinks } from '../lib/db';
import { money } from '../lib/currency';
import { dietaryBadges } from '../lib/dietary';
import { resolveBoardPrice } from '../lib/menuPricing';
import { boardFollowsMenus, resolveBoardMenu, applyMenuToSections } from '../lib/menuBoardMenus';

const DEFAULT_THEME = { bgColor: '#14110d', textColor: '#F5EFE6', mutedColor: '#B8AE9E', accent: '#E8A23C', font: '', footerNote: '', logoUrl: null, bgImageUrl: null };
const DEFAULT_DISPLAY = { showDescription: true, showAllergens: true, showPrices: true, showImages: false, soldOut: 'grey', textScale: 1, hidePriceless: false };
const FIT = { base: 30, min: 11, max: 160 };         // px; the fit-loop lands somewhere in here (max high enough for 4K TVs)
// Text-size preference → how many columns to flow into. MORE columns = BIGGER text,
// because the content is spread thinner per column and the auto-fit grows the font
// to fill the screen height. Fewer columns = smaller text. Driven by an explicit
// integer count (never column-width:auto, which lets Chromium clip overflow silently).
const COLS_FOR_SCALE = { portrait: [1, 1, 2, 2], landscape: [2, 3, 4, 5] };  // Smaller / Default / Larger / Extra large
const scaleTier = (ts) => (ts <= 0.9 ? 0 : ts < 1.075 ? 1 : ts < 1.225 ? 2 : 3);
const cacheKey = (loc, b) => `rpos-mb-${loc}-${b || 'def'}`;
const LS_SCREEN = 'rpos-mbscreen';   // this device's screen row {id,code,board_id} — kept across tenant-fence wipes
// Human pairing code shown on an unassigned screen (operator types it into Back Office).
// 8 chars from a 30-symbol unambiguous alphabet (no I/L/O/U/0/1) ≈ 39 bits — high
// enough that the codespace can't be brute-forced through the claim RPC, while
// still readable across a room and quick to type. Formatted XXXX-XXXX.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const genCode = () => {
  let out = '';
  for (let i = 0; i < 8; i++) { if (i === 4) out += '-'; out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]; }
  return out;
};

// Board price: the active menu's tier (dineIn, then all) when one exists, else the
// board's own display chain: dineIn, then any-channel, then base, then legacy scalar.
// Shared with the Back Office preview via src/lib/menuPricing.js. activeMenuId null
// means "no active menu known", which is exactly the pre-tier behaviour.
const boardPrice = (it, activeMenuId = null) => resolveBoardPrice(it, activeMenuId);
// GF/V/VG/DF badge resolution now shared (src/lib/dietary.js) with the print
// menu + online storefront — imported above, do not re-fork the map here.
const visibleItem = (it) => !it.archived && (!it.visibility || it.visibility.kiosk !== false);

// Venue clock for "Follow timed menus". The timezone an operator sets in Location
// Settings lives on the PLATFORM locations row (joined by ops_location_id, anon
// readable, kept that way on purpose in 20260805c B6); the ops locations.timezone
// column is a legacy default and is only read when the platform row cannot be.
// Never the device clock: a US venue's TV must flip menus on the venue's time,
// not on London's. Returns null when nothing could be read so the caller can
// keep the last good value from the cache.
async function fetchVenueTimezone(locId) {
  if (!locId) return null;
  try {
    if (platformSupabase) {
      const { data } = await platformSupabase.from('locations').select('timezone')
        .or(`ops_location_id.eq.${locId},id.eq.${locId}`).limit(1).maybeSingle();
      if (data?.timezone) return data.timezone;
    }
  } catch { /* platform read failed, try the ops column */ }
  try {
    if (supabase) {
      const { data } = await supabase.from('locations').select('timezone').eq('id', locId).maybeSingle();
      if (data?.timezone) return data.timezone;
    }
  } catch { /* ops read failed too, caller keeps the last good tz */ }
  return null;
}
let warnedNoTz = false;

export default function MenuBoardSurface() {
  // Two ways to drive a screen:
  //   • ?board=<id>  — a direct link to one board (manual fallback / preview).
  //   • no param     — DEVICE PAIRING: the screen self-registers, shows a pairing
  //     code, and the operator assigns a board from Back Office. The screen then
  //     learns its board over Realtime and renders it live.
  const urlBoardId = useMemo(() => { try { return new URLSearchParams(window.location.search).get('board'); } catch { return null; } }, []);
  const pairing = !urlBoardId;

  const [screen, setScreen] = useState(() => {       // this device's screen row (pairing mode only)
    if (!pairing) return null;
    try { return JSON.parse(localStorage.getItem(LS_SCREEN) || 'null'); } catch { return null; }
  });
  const screenIdRef = useRef(screen?.id || null);
  const effectiveBoardId = urlBoardId || screen?.board_id || null;

  const [locId, setLocId] = useState(null);
  const [resolving, setResolving] = useState(true);
  const [data, setData] = useState(null);   // { board, cats:[], items:[], six:Set, menus:[], links:[], tz }
  const dataRef = useRef(null);             // last data set, so a failed timezone read keeps the last good tz
  const reloadTimer = useRef(null);
  const menusSubSeq = useRef(0);            // unique topic per menus subscription, see the Follow-timed-menus effect

  // Lock the viewport to 1:1 for signage. TV browsers (notably LG webOS) otherwise
  // apply their own default zoom, scaling the board past the screen ("zoomed in /
  // doesn't fit"). Restore the previous viewport on unmount so other surfaces are
  // unaffected. The auto-fit then sizes the menu to the real screen.
  useEffect(() => {
    let meta = document.querySelector('meta[name=viewport]');
    const prev = meta ? meta.getAttribute('content') : null;
    if (!meta) { meta = document.createElement('meta'); meta.setAttribute('name', 'viewport'); document.head.appendChild(meta); }
    meta.setAttribute('content', 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no');
    return () => { if (prev != null) meta.setAttribute('content', prev); };
  }, []);

  // ── device pairing: register/find this screen's row, then watch it for an
  // assignment. The device only ever reads/heartbeats its OWN row (RLS scopes it
  // by device_uid = auth.uid()); it never writes location_id/board_id. ──
  useEffect(() => {
    if (!pairing || isMock || !supabase) return;
    let alive = true, poll = null, ch = null;
    const persist = (s) => { try { localStorage.setItem(LS_SCREEN, JSON.stringify(s)); } catch {} };
    const apply = (r) => {
      if (!alive || !r) return;
      screenIdRef.current = r.id;
      const s = { id: r.id, code: r.code, board_id: r.board_id || null };
      setScreen(s); persist(s);
    };
    (async () => {
      await ensureAuthToken();                 // anon session → auth.uid() for device_uid + RLS
      if (!alive) return;
      // 1) load our existing row (by cached id) or create a fresh unclaimed one
      let row = null;
      if (screenIdRef.current) {
        const { data } = await supabase.from('menu_board_screens').select('*').eq('id', screenIdRef.current).maybeSingle();
        row = data || null;
      }
      for (let i = 0; i < 3 && !row; i++) {
        const { data, error } = await supabase.from('menu_board_screens').insert({ code: genCode() }).select().maybeSingle();
        if (!error) { row = data; break; }
        if (error.code !== '23505') break;     // not a code collision → give up
      }
      if (!alive || !row) return;
      apply(row);
      const sid = row.id;
      // Reliable loop: re-auth, re-read our row, and stamp last_seen — every 12s.
      // This is the source of truth and works even when the realtime socket can't
      // open on an older TV browser (which previously left the heartbeat stuck at
      // "never seen" and the assignment unseen). Realtime below is a best-effort
      // instant push layered on top, wrapped so it can never break this loop.
      let misses = 0;
      const tick = async () => {
        try {
          await ensureAuthToken();
          const { data } = await supabase.from('menu_board_screens').select('*').eq('id', sid).maybeSingle();
          if (data) { misses = 0; apply(data); supabase.rpc('mb_screen_heartbeat', { p_id: sid }).then(() => {}, () => {}); }
          else if (++misses >= 3) { try { localStorage.removeItem(LS_SCREEN); } catch {} window.location.reload(); }  // genuinely retired in BO
        } catch {}
      };
      tick();
      poll = setInterval(tick, 12000);
      try {
        ch = supabase.channel(`mbscreen-${sid}`)
          .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'menu_board_screens', filter: `id=eq.${sid}` }, (p) => apply(p.new))
          .subscribe();
      } catch {}
    })();
    return () => { alive = false; if (poll) clearInterval(poll); if (ch) { try { supabase.removeChannel(ch); } catch {} } };
  }, [pairing]);

  // ── resolve the location from whatever board we're showing (direct link or
  // the screen's assignment). The board row carries its own location_id. ──
  useEffect(() => {
    let alive = true;
    setResolving(true);
    (async () => {
      if (effectiveBoardId && !isMock && supabase) {
        const { data: b } = await supabase.from('menu_boards').select('location_id').eq('id', effectiveBoardId).maybeSingle();
        if (alive) { if (b?.location_id) setLocId(b.location_id); setResolving(false); }
      } else if (alive) {
        setLocId(null); setResolving(false);     // no board yet → pairing splash
      }
    })();
    return () => { alive = false; };
  }, [effectiveBoardId]);

  const load = useCallback(async (id) => {
    if (isMock || !supabase || !id || !effectiveBoardId) return;
    try {
      const [boardRes, catsRes, itemsRes, sixRes] = await Promise.all([
        supabase.from('menu_boards').select('*').eq('id', effectiveBoardId).maybeSingle(),
        fetchMenuCategories(id), fetchMenuItems(id), fetch86List(id),
      ]);
      const board = boardRes?.data || null;
      const next = {
        board,
        cats: catsRes?.data || [],
        items: itemsRes?.data || [],
        six: new Set((sixRes?.data || []).map((r) => r.item_id)),
        menus: [], links: [], tz: null,
      };
      // Follow timed menus: only when the published board asks for it, so a
      // board with the flag off makes exactly the reads it always has. Each
      // extra read degrades on its own: no menus = no active menu = the full
      // arranged board and no tier (never blank); a failed timezone read keeps
      // the last good value rather than silently jumping to London.
      if (boardFollowsMenus(board)) {
        const [mRes, lRes, tzRes] = await Promise.allSettled([fetchMenus(id), fetchMenuCategoryLinks(id), fetchVenueTimezone(id)]);
        next.menus = (mRes.status === 'fulfilled' && Array.isArray(mRes.value?.data)) ? mRes.value.data : [];
        next.links = (lRes.status === 'fulfilled' && Array.isArray(lRes.value?.data)) ? lRes.value.data : [];
        next.tz = (tzRes.status === 'fulfilled' && tzRes.value) || dataRef.current?.tz || null;
        if (mRes.status === 'fulfilled' && mRes.value?.error) console.warn('[menuboard] menus read failed, showing every category:', mRes.value.error.message);
        if (!next.tz && !warnedNoTz) { warnedNoTz = true; console.warn('[menuboard] venue timezone unknown, timed menus evaluate on Europe/London'); }
      }
      dataRef.current = next;
      setData(next);
      try { localStorage.setItem(cacheKey(id, effectiveBoardId), JSON.stringify({ ...next, six: [...next.six] })); } catch {}
    } catch (e) { console.warn('[menuboard] load', e?.message); }
  }, [effectiveBoardId]);

  const reload = useCallback(() => { clearTimeout(reloadTimer.current); reloadTimer.current = setTimeout(() => load(locId), 400); }, [load, locId]);

  // boot: render cache instantly, then refresh + subscribe
  useEffect(() => {
    if (!locId || !effectiveBoardId) return;
    try {
      const c = JSON.parse(localStorage.getItem(cacheKey(locId, effectiveBoardId)) || 'null');
      if (c) {
        // A cache written before "Follow timed menus" simply lacks the fields.
        const d = { ...c, six: new Set(c.six || []), menus: Array.isArray(c.menus) ? c.menus : [], links: Array.isArray(c.links) ? c.links : [], tz: c.tz || null };
        dataRef.current = d;
        setData(d);
      }
    } catch {}
    load(locId);

    if (isMock || !supabase) return;
    const ch = supabase.channel(`menuboard:${locId}:${effectiveBoardId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'eighty_six', filter: `location_id=eq.${locId}` }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_items', filter: `location_id=eq.${locId}` }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_boards', filter: `location_id=eq.${locId}` }, reload)
      .subscribe();
    const poll = setInterval(() => load(locId), 90000);   // safety net for missed events / long uptime
    return () => { supabase.removeChannel(ch); clearInterval(poll); clearTimeout(reloadTimer.current); };
  }, [locId, load, effectiveBoardId, reload]);

  // Follow timed menus: schedule and membership edits reach the TV live too.
  // Only while the board follows menus (a board with the flag off subscribes to
  // exactly what it always has). `menus` carries location_id so it filters like
  // the main channel; menu_category_links has no location column, so it is
  // filtered by this venue's menu ids (re-subscribed when that set changes).
  // The 90s poll above remains the safety net if either table is not published.
  //
  // The topic carries a sequence number. removeChannel() only sends a leave and
  // keeps the phoenix channel registered until the server acks it, so a
  // re-subscribe under the SAME topic in the same commit (menuIdsKey changed)
  // got the leaving instance back from supabase.channel(): the new bindings
  // were attached to a dying object, subscribe() was a no-op, and the ack then
  // tore the bindings down. No throw, no warning, and no menus or links events
  // ever reached the TV again until a reload. A fresh topic per subscription
  // can never collide with the one that is leaving.
  const followMenus = boardFollowsMenus(data?.board);
  const menuIdsKey = followMenus
    ? (data?.menus || []).map((m) => m?.id).filter((x) => typeof x === 'string' && /^[A-Za-z0-9_-]+$/.test(x)).sort().join(',')
    : '';
  useEffect(() => {
    if (!followMenus || !locId || !effectiveBoardId || isMock || !supabase) return;
    let ch = null;
    try {
      ch = supabase.channel(`menuboard-menus:${locId}:${effectiveBoardId}:${++menusSubSeq.current}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'menus', filter: `location_id=eq.${locId}` }, reload);
      if (menuIdsKey) ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: 'menu_category_links', filter: `menu_id=in.(${menuIdsKey})` }, reload);
      ch.subscribe();
    } catch (e) { console.warn('[menuboard] menus realtime', e?.message); }
    return () => { if (ch) { try { supabase.removeChannel(ch); } catch { /* already gone */ } } };
  }, [followMenus, menuIdsKey, locId, effectiveBoardId, reload]);

  // No board yet → device-pairing screen (shows the code to type into Back Office).
  if (pairing && !effectiveBoardId) return <PairScreen code={screen?.code} />;
  if (resolving && !data) return <Splash text="Starting menu board…" />;
  if (!data) return <Splash text="Loading menu…" />;
  return <Board data={data} />;
}

// Full-screen pairing prompt for an unassigned screen.
function PairScreen({ code }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#14110d', color: '#F5EFE6', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", padding: '6vw' }}>
      <div style={{ fontSize: 'clamp(16px,2.6vw,32px)', color: '#B8AE9E', letterSpacing: '.04em' }}>Pair this screen</div>
      <div style={{ fontSize: 'clamp(48px,13vw,170px)', fontWeight: 700, letterSpacing: '.04em', color: '#E8A23C', lineHeight: 1.05, margin: '.25em 0' }}>{code || '· · ·'}</div>
      <div style={{ fontSize: 'clamp(13px,1.7vw,20px)', color: '#B8AE9E', marginTop: '.6em', maxWidth: 780, lineHeight: 1.5 }}>
        In Back Office → Channels → Menu boards, tap <strong style={{ color: '#F5EFE6' }}>“Pair a screen”</strong> and enter this code to choose what this display shows.
      </div>
    </div>
  );
}

function Board({ data }) {
  const theme = { ...DEFAULT_THEME, ...(data.board?.theme || {}) };
  const disp = { ...DEFAULT_DISPLAY, ...(data.board?.display_options || {}) };
  const mode = data.board?.mode || 'menu';
  const orientation = data.board?.orientation || 'landscape';
  const textScale = Math.max(0.6, Math.min(1.6, Number(disp.textScale) || 1));

  // Follow timed menus (layout.followMenus). The live menu is resolved on the
  // VENUE clock (data.tz, never the device clock) by the shared resolver, and
  // re-evaluated every minute so the TV flips at a schedule boundary without a
  // push. It narrows the arranged sections (never to nothing, see
  // applyMenuToSections) and picks the price tier. Null = flag off, no menus
  // known, or nothing resolved = the board is exactly its arranged blocks with
  // no tier, which is byte-for-byte the pre-flag behaviour.
  const followMenus = boardFollowsMenus(data.board);
  const [, setClockTick] = useState(0);
  useEffect(() => {
    if (!followMenus) return;
    const t = setInterval(() => setClockTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, [followMenus]);
  const activeMenuId = resolveBoardMenu({ board: data.board, menus: data.menus, categories: data.cats, links: data.links, timezone: data.tz });

  const boardRef = useRef(null);
  const contentRef = useRef(null);
  const flowRef = useRef(null);
  const [fitTick, setFitTick] = useState(0);

  // ordered sections; content flows column-by-column and fills the screen
  const sections = mode === 'menu' ? buildSections(data, activeMenuId) : [];
  const fixedCols = Number(data.board?.layout?.columns) || 0;   // operator override; 0 = Auto
  const totalItems = sections.reduce((n, s) => n + ((s.items && s.items.length) || 0), 0);

  // ── auto-fit: FILL the screen, never clip. Columns fill top-to-bottom
  // (column-fill:auto) so a column only breaks when it is genuinely full. We use
  // an EXPLICIT integer column count (operator override, else derived from the
  // text-size preference) — never column-width:auto, because Chromium clips
  // overflow from an auto count without reporting it, which let large fonts run
  // off the bottom of the screen. With a fixed count, overflow creates a real
  // extra column that scrollWidth reports, so the binary search always lands on
  // the largest font that fits the whole menu on one screen. ──
  useLayoutEffect(() => {
    if (mode !== 'menu') return;
    const root = boardRef.current, flow = flowRef.current;
    if (!root || !flow) return;
    const maxN = orientation === 'portrait' ? 3 : 6;
    let cols = fixedCols || COLS_FOR_SCALE[orientation === 'portrait' ? 'portrait' : 'landscape'][scaleTier(textScale)];
    // don't open more columns than the content can reasonably fill (~3 items each)
    cols = Math.max(1, Math.min(cols, maxN, Math.ceil((totalItems || 1) / 3)));
    flow.style.columnWidth = 'auto';
    flow.style.columnCount = String(cols);
    const fits = () => flow.scrollWidth <= flow.clientWidth + 1 && flow.scrollHeight <= flow.clientHeight + 1;
    let lo = FIT.min, hi = FIT.max, best = FIT.min;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      root.style.fontSize = mid + 'px';
      if (fits()) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    root.style.fontSize = best + 'px';
  }, [data, mode, orientation, fixedCols, textScale, totalItems, fitTick, activeMenuId]);

  useEffect(() => {
    const refit = () => setFitTick((t) => t + 1);
    window.addEventListener('resize', refit);
    window.addEventListener('mb-refit', refit);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', refit);
    // Re-fit once the web font has actually loaded — its metrics differ from the
    // system fallback, so on a slow TV browser the first fit (done against the
    // fallback) would otherwise overflow once the real font swaps in, making the
    // board look "zoomed in / off the edge". Also a couple of delayed passes for
    // TV browsers that report their final viewport size only after first paint.
    try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit).catch(() => {}); } catch {}
    const timers = [setTimeout(refit, 400), setTimeout(refit, 1500), setTimeout(refit, 4000)];
    return () => {
      window.removeEventListener('resize', refit);
      window.removeEventListener('mb-refit', refit);
      if (window.visualViewport) window.visualViewport.removeEventListener('resize', refit);
      timers.forEach(clearTimeout);
    };
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

  const pad = orientation === 'portrait' ? '6vmin 5.5vmin' : '5.5vmin 6vmin';   // safe edge margin (also covers TV overscan)
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
              <Section key={sec.cat.id} sec={sec} theme={theme} disp={disp} six={data.six} activeMenuId={activeMenuId} />
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

function Section({ sec, theme, disp, six, activeMenuId = null }) {
  const { cat, items } = sec;
  return (
    <div style={{ marginBottom: '1.4em', breakInside: 'avoid', WebkitColumnBreakInside: 'avoid', ...(sec.span === 'all' ? { columnSpan: 'all', WebkitColumnSpan: 'all', breakInside: 'auto' } : null) }}>
      <div style={{ fontSize: '0.82em', fontWeight: 700, letterSpacing: '.12em', color: theme.accent, marginBottom: '0.55em', textTransform: 'uppercase', breakAfter: 'avoid', WebkitColumnBreakAfter: 'avoid' }}>{cat.label}</div>
      {items.filter((it) => !(disp.hidePriceless && boardPrice(it, activeMenuId) <= 0 && !(it._variants || []).length)).map((it) => {
        const variants = it._variants || [];
        const hasVar = variants.length > 0;
        const sold = six.has(it.id);
        const diet = dietaryBadges(it);
        const price = boardPrice(it, activeMenuId);
        return (
          <div key={it.id} style={{ marginBottom: '0.65em', opacity: sold ? 0.42 : 1, breakInside: 'avoid', WebkitColumnBreakInside: 'avoid' }}>
            {/* product line */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.55em' }}>
              {disp.showImages && it.image && <img src={it.image} alt="" style={{ width: '2.4em', height: '2.4em', objectFit: 'cover', borderRadius: '0.3em', flexShrink: 0 }} />}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '0.56em', fontWeight: 600, lineHeight: 1.15 }}>
                  {it.menu_name || it.name}
                  {diet.map((d) => (
                    <span key={d} style={{ fontSize: '0.6em', background: '#1f3a26', color: '#7fd99a', borderRadius: '1em', padding: '0 .55em', marginLeft: '.3em', whiteSpace: 'nowrap', fontWeight: 700 }}>{d}</span>
                  ))}
                </div>
                {disp.showDescription && it.description && (
                  <div style={{ fontSize: '0.42em', color: theme.mutedColor, lineHeight: 1.3, marginTop: '.15em' }}>{it.description}</div>
                )}
                {disp.showAllergens && Array.isArray(it.allergens) && it.allergens.length > 0 && (
                  <div style={{ fontSize: '0.34em', color: theme.mutedColor, lineHeight: 1.3, marginTop: '.25em', textTransform: 'capitalize', opacity: 0.9 }}>
                    Allergens: {it.allergens.join(', ')}
                  </div>
                )}
              </div>
              <div style={{ flexShrink: 0, display: 'flex', alignItems: 'flex-start', lineHeight: 1 }}>
                {sold
                  ? <span style={{ fontSize: '0.38em', fontWeight: 600, letterSpacing: '.05em', background: '#5a1e1e', color: '#f3b0b0', borderRadius: '1.4em', padding: '.2em .8em' }}>SOLD OUT</span>
                  : (!hasVar && disp.showPrices && price > 0 && <span style={{ fontSize: '0.5em', fontWeight: 700, background: theme.accent, color: '#1c1206', borderRadius: '1.4em', padding: '.18em .7em' }}>{money(price)}</span>)}
              </div>
            </div>
            {/* indented variant sizes */}
            {hasVar && (
              <div style={{ marginTop: '.18em', marginLeft: '.2em', paddingLeft: (disp.showImages && it.image) ? '3em' : '0.9em', borderLeft: `0.14em solid ${theme.accent}40` }}>
                {variants.map((v) => {
                  const vsold = six.has(v.id);
                  const vp = boardPrice(v, activeMenuId);
                  return (
                    <div key={v.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5em', marginBottom: '.4em', opacity: vsold ? 0.42 : 1 }}>
                      <span style={{ fontSize: '0.46em', color: theme.mutedColor }}>{v.menu_name || v.name}</span>
                      {vsold
                        ? <span style={{ fontSize: '0.34em', fontWeight: 600, background: '#5a1e1e', color: '#f3b0b0', borderRadius: '1.4em', padding: '.2em .7em' }}>SOLD OUT</span>
                        : (disp.showPrices && vp > 0 && <span style={{ fontSize: '0.42em', fontWeight: 700, background: theme.accent, color: '#1c1206', borderRadius: '1.4em', padding: '.16em .65em' }}>{money(vp)}</span>)}
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
// activeMenuId (Follow timed menus) narrows the result to the categories on that
// menu, in the arranged order, falling back to the full board when nothing
// with items would survive. Null = no narrowing.
function buildSections(data, activeMenuId = null) {
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
  const sections = cats
    .map((cat) => ({ cat, span: spanById[cat.id], items: (itemsByCat[cat.id] || []).map((it) => ({ ...it, _variants: kids[it.id] || [] })) }))
    .filter((s) => s.items.length > 0);
  return applyMenuToSections(sections, { categories: data.cats, links: data.links, activeMenuId });
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
