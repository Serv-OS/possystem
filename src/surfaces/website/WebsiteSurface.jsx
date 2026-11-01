// src/surfaces/website/WebsiteSurface.jsx
//
// The venue website in the browser (ARCHITECTURE.md sections 3, 4, 7, 8). Mounted by App.jsx for
// website hosts (<slug>.sites.serv-os.app, a custom domain) and for ?site=<slug> on any host.
// It reads window.__SERVOS_SITE__ (the server rendered page's snapshot) first, else resolves the
// host with the Platform RPC web_resolve_host, then replaces the server HTML with the same markup
// (same class names, same theme variables, so nothing moves). Routing is the pathname with
// pushState for internal links; the live menu comes from data/loadMenu.js and refreshes on the
// online-86:<location> realtime channel like the storefront. Never a literal colour: everything
// is a --w-* variable from theme.js.

import { siteQueryFor } from './hostParse.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, platformSupabase } from '../../lib/supabase';
import { CUSTOMER_ROOT } from '../../lib/env';
import { ensureCustomerSession } from '../../lib/publicOrderClient';
import { SiteContext } from './siteContext.js';
import { A } from './Link.jsx';
import { CN } from './blocks/classNames.js';
import { SITE_CSS, SHELL_RESET_CSS, SHELL_RESET_ID } from './siteStyles.js';
import { siteVars } from './theme.js';
import { resolveRoute, visibleNav, breadcrumbsFor, normalisePath, layoutHasHero, headerOptions } from './routes.js';
import { buildCtx, renderPage, siteName, headerCta } from './ssr/renderBlocks.js';
import { resolveHref, pickLocation, menuLocation } from './resolveHref.js';
import { layoutBlocks, walkBlocks } from './blocks/schema.js';
import { loadMenu } from './data/loadMenu.js';
import { BlockRenderer } from './blocks/BlockRenderer.jsx';
import { PostArticle } from './blocks/components/ContentBlocks.jsx';

const cls = (...xs) => xs.filter(Boolean).join(' ');

/** 5.12.8: the visitor's venue pick for menus, from ?venue=<slug> in the address bar. */
function readVenueParam() {
  try { return (new URLSearchParams(window.location.search).get('venue') || '').toLowerCase() || null; } catch { return null; }
}
/** The query to keep on client side navigation: ?site= (when present) and the venue pick. */
function keptQuery(search, siteSlug, menuVenue) {
  const base = siteQueryFor(search, siteSlug);
  if (!menuVenue) return base;
  return `${base ? `${base}&` : '?'}venue=${encodeURIComponent(menuVenue)}`;
}

/** 5.12.12: a nav item with children. Hover and focus open it through CSS; a tap toggles it on a phone. */
function NavDropdown({ item, path, ctx }) {
  // Closes when the path changes: derived during render (no setState in an effect).
  const [st, setSt] = useState({ open: false, path });
  if (st.path !== path) setSt({ open: false, path });
  const open = st.path === path && st.open;
  return (
    <div className={CN.navItem} data-open={open ? 'true' : 'false'}>
      <button type="button" className={cls(CN.navLink, CN.navDrop)} aria-haspopup="true" aria-expanded={open} onClick={() => setSt({ open: !open, path })}>{item.label}</button>
      <div className={CN.navSub}>
        {item.children.map((c) => <A key={`${c.label}-${c.href}`} className={CN.navLink} href={c.href} aria-current={resolveHref(ctx, c.href) === path ? 'page' : undefined}>{c.label}</A>)}
      </div>
    </div>
  );
}

function readBoot() {
  try {
    const b = typeof window !== 'undefined' ? window.__SERVOS_SITE__ : null;
    return b && b.snapshot && typeof b.snapshot === 'object' ? b : null;
  } catch { return null; }
}

/** The snapshot for this host (or slug), through the Platform anon client. Never throws. */
async function fetchSnapshot(host, siteSlug) {
  if (!platformSupabase) return { snapshot: null, error: new Error('no platform client') };
  try {
    if (!siteSlug) {
      const rpc = await platformSupabase.rpc('web_resolve_host', { p_host: host });
      if (!rpc.error) {
        const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
        return { snapshot: rowSnapshot(row), error: null };
      }
    }
    const slug = siteSlug || (/^([a-z0-9-]+)\.sites\./.exec(host) || [])[1] || null;
    let q = platformSupabase.from('web_sites_public').select('*');
    q = slug ? q.eq('slug', slug) : q.or(`custom_domain.eq.${host},apex_domain.eq.${host}`);
    const res = await q.limit(1).maybeSingle();
    if (res.error) return { snapshot: null, error: res.error };
    return { snapshot: rowSnapshot(res.data), error: null };
  } catch (e) {
    return { snapshot: null, error: e };
  }
}
function rowSnapshot(row) {
  if (!row) return null;
  let s = row.snapshot;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch { s = null; } }
  if (!s || typeof s !== 'object') return null;
  s.site = s.site || {};
  if (row.slug) s.site.slug = row.slug;
  if (row.custom_domain !== undefined) s.site.custom_domain = row.custom_domain || null;
  s.site.domain_live = !!(s.site.custom_domain && row.domain_live === true);
  return s;
}

/** The menu block that drives this page's menu read (first LiveMenu, else first Specials; 5.12.9: inside a Row column too). */
function menuPlanFor(page, ctx) {
  const blocks = walkBlocks(page && page.layout);
  const block = blocks.find((b) => b.type === 'LiveMenu') || blocks.find((b) => b.type === 'Specials');
  if (!block) return null;
  // 5.12.8: an unpinned block follows the visitor's venue pick (same rule as the server's menuPlan).
  const location = menuLocation(ctx, block.props.location_id);
  if (!location || !location.ops_location_id) return null;
  return {
    key: `${location.ops_location_id}|${block.props.menu_id || 'follow'}|${block.props.price_mode || 'collection'}`,
    opsLocationId: location.ops_location_id,
    options: { menuId: block.type === 'LiveMenu' ? block.props.menu_id : 'follow', pinnedMenuId: location.online_menu_id || null, timezone: location.timezone, currency: location.currency || 'GBP', priceMode: block.type === 'LiveMenu' ? block.props.price_mode : 'collection' },
  };
}

export default function WebsiteSurface({ host, siteSlug = null }) {
  const boot = useMemo(() => readBoot(), []);
  const [snapshot, setSnapshot] = useState(() => (boot ? boot.snapshot : null));
  const [loadState, setLoadState] = useState(() => (boot ? 'ready' : 'loading'));
  // On a /preview page the address bar says /preview; the server tells us which page it painted.
  const [path, setPath] = useState(() => normalisePath(boot && boot.path ? boot.path : (typeof window !== 'undefined' ? window.location.pathname : '/')));
  const preview = !!(boot && boot.preview);
  const [menu, setMenu] = useState(null);
  const [menuLoading, setMenuLoading] = useState(false);
  const [here, setHere] = useState(null);
  const [nearestState, setNearestState] = useState('idle');
  const [navOpen, setNavOpen] = useState(false);
  // 5.12.8: whose menu an unpinned menu block shows (online slug), from the venue switch or ?venue=.
  const [menuVenue, setMenuVenueState] = useState(() => (typeof window !== 'undefined' ? readVenueParam() : null));
  const menuKeyRef = useRef('');

  // 1. The snapshot: boot payload, else the Platform RPC.
  useEffect(() => {
    if (boot) return;
    let alive = true;
    (async () => {
      const r = await fetchSnapshot(String(host || '').toLowerCase(), siteSlug);
      if (!alive) return;
      if (r.snapshot) { setSnapshot(r.snapshot); setLoadState('ready'); } else setLoadState('none');
    })();
    return () => { alive = false; };
  }, [boot, host, siteSlug]);

  // 2. Client side routing on the pathname.
  useEffect(() => {
    const onPop = () => { setPath(normalisePath(window.location.pathname)); setMenuVenueState(readVenueParam()); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((href) => {
    const target = normalisePath(href);
    const keepQuery = keptQuery(typeof window !== 'undefined' ? window.location.search : '', siteSlug, menuVenue);
    // A draft preview keeps its /preview?token address: the live paths may not exist yet.
    if (!preview) { try { window.history.pushState({}, '', target + keepQuery); } catch { /* file: or sandboxed */ } }
    setPath(target);
    setNavOpen(false);
    try { window.scrollTo({ top: 0, behavior: 'instant' }); } catch { window.scrollTo(0, 0); }
  }, [siteSlug, preview, menuVenue]);

  // 5.12.8: the venue switch. The pick lands in the address bar (?venue=) so the page can be
  // shared and reloaded on the same venue; a draft preview keeps its /preview?token address.
  const setMenuVenue = useCallback((slug) => {
    const v = slug ? String(slug).toLowerCase() : null;
    setMenuVenueState(v);
    if (preview) return;
    try {
      const u = new URL(window.location.href);
      if (v) u.searchParams.set('venue', v); else u.searchParams.delete('venue');
      window.history.replaceState({}, '', u.pathname + u.search);
    } catch { /* file: or sandboxed */ }
  }, [preview]);

  // 3. The site stylesheet, once (the SSR head already carries it; this covers the client only path).
  useEffect(() => {
    // 5.12.7: the scroll reset too, so a page the SPA shell served (no SSR head) still scrolls.
    if (!document.getElementById(SHELL_RESET_ID)) {
      const r = document.createElement('style');
      r.id = SHELL_RESET_ID;
      r.textContent = SHELL_RESET_CSS;
      document.head.appendChild(r);
    }
    if (document.getElementById('w-css')) return;
    const el = document.createElement('style');
    el.id = 'w-css';
    el.textContent = SITE_CSS;
    document.head.appendChild(el);
  }, []);

  const route = useMemo(() => (snapshot ? resolveRoute(snapshot, path) : null), [snapshot, path]);
  const ctx = useMemo(() => buildCtx({ snapshot, host, path, menu, customerRoot: CUSTOMER_ROOT, menuVenue, pageKind: route && route.page ? route.page.kind : null }), [snapshot, host, path, menu, menuVenue, route]);
  const vars = useMemo(() => siteVars(ctx.site.theme, (pickLocation(ctx, 'default') || {}).online_branding), [ctx]);
  const plan = useMemo(() => (route && route.page ? menuPlanFor(route.page, ctx) : null), [route, ctx]);

  // 4. The live menu for this page, refreshed on the 86 channel (same pattern as OnlineSurface).
  useEffect(() => {
    if (!plan || !supabase) { menuKeyRef.current = ''; return; }
    let alive = true;
    let timer = null;
    const load = async () => {
      if (!alive) return;
      setMenuLoading(true);
      try { await ensureCustomerSession(); } catch { /* public reads still answer */ }
      const m = await loadMenu(supabase, plan.opsLocationId, plan.options);
      if (!alive) return;
      setMenu(m);
      setMenuLoading(false);
    };
    if (menuKeyRef.current !== plan.key) { menuKeyRef.current = plan.key; load(); }
    const chan = supabase.channel(`online-86:${plan.opsLocationId}:site`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'eighty_six', filter: `location_id=eq.${plan.opsLocationId}` }, () => {
        // Several 86 rows can land together; one reload a second later covers them all.
        clearTimeout(timer); timer = setTimeout(load, 800);
      })
      .subscribe();
    return () => { alive = false; clearTimeout(timer); try { supabase.removeChannel(chan); } catch { /* already gone */ } };
  }, [plan]);

  // 5. Head updates for client side navigation (the server wrote the first ones).
  useEffect(() => {
    if (!snapshot || !route) return;
    try {
      const r = renderPage({ snapshot, route, path, host, menu, customerRoot: CUSTOMER_ROOT, menuVenue });
      document.title = r.title;
      let m = document.querySelector('meta[name="description"]');
      if (!m) { m = document.createElement('meta'); m.setAttribute('name', 'description'); document.head.appendChild(m); }
      m.setAttribute('content', r.description || '');
    } catch { /* a head that does not update is not worth a crash */ }
  }, [snapshot, route, path, host, menu, menuVenue]);

  // 6. Nearest shop: geolocation ON TAP, Haversine sorting in the FindUs block.
  const requestNearest = useCallback(() => {
    if (!navigator.geolocation) { setNearestState('denied'); return; }
    setNearestState('asking');
    navigator.geolocation.getCurrentPosition(
      (pos) => { setHere({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setNearestState('ok'); },
      () => setNearestState('denied'),
      { timeout: 10000, maximumAge: 300000 },
    );
  }, []);

  const value = useMemo(() => ({ ctx, menu, menuLoading, here, nearestState, requestNearest, navigate, menuVenue, setMenuVenue }), [ctx, menu, menuLoading, here, nearestState, requestNearest, navigate, menuVenue, setMenuVenue]);

  if (loadState === 'loading') {
    return <div className={CN.site} style={vars}><div className={cls(CN.inner, CN.notFound)}><p className={CN.muted}>Loading…</p></div></div>;
  }
  if (!snapshot) {
    return <div className={CN.site} style={vars}><div className={cls(CN.inner, CN.notFound)}><h1>No site here</h1><p className={CN.muted}>There is no website set up for this address yet.</p></div></div>;
  }

  const name = siteName(snapshot);
  const loc0 = pickLocation(ctx, 'default');
  const logo = loc0 && loc0.online_branding && loc0.online_branding.logo_url;
  // 5.12.8: the owner's header options (brand mark, header button, sticky), same rules as the SSR.
  const hdr = headerOptions(ctx.settings);
  const showImg = !!logo && hdr.brand !== 'name';
  const showName = !showImg || hdr.brand === 'both';
  const cta = headerCta(ctx);
  const nav = visibleNav(snapshot);
  const crumbs = breadcrumbsFor(route, snapshot);
  const footer = ctx.site.footer || {};
  const settings = ctx.settings;

  let main;
  if (!route || route.kind === 'notfound') {
    main = <div className={cls(CN.inner, CN.notFound)}><h1>Page not found</h1><p className={CN.muted}>That page is not here. <A href="/">Go to the home page</A>.</p></div>;
  } else if (route.kind === 'post') {
    main = <><Breadcrumb crumbs={crumbs} /><PostArticle post={route.post} /></>;
  } else {
    const page = route.page;
    const hasHero = layoutHasHero(page.layout);
    const blocks = layoutBlocks(page.layout);
    const heroFirst = blocks.length && blocks[0].type === 'Hero';
    const title = hasHero ? null : <div className={CN.inner}><h1>{page.title || name}</h1></div>;
    const crumb = path !== '/' ? <Breadcrumb crumbs={crumbs} /> : null;
    // Same order as the SSR: a leading Hero, then breadcrumb and title, then the rest.
    main = heroFirst ? (
      <>
        <BlockRenderer layout={{ content: blocks.slice(0, 1) }} settings={settings} />
        {crumb}{title}
        <BlockRenderer layout={{ content: blocks.slice(1) }} settings={settings} firstHeroIsH1={false} />
      </>
    ) : (
      <>{crumb}{title}<BlockRenderer layout={page.layout} settings={settings} />{blocks.length ? null : <p className={CN.empty}>This page is being written.</p>}</>
    );
  }

  return (
    <SiteContext.Provider value={value}>
      <div className={CN.site} style={vars} data-layout={(ctx.site.theme && ctx.site.theme.layout) || 'ember'}>
        <header className={CN.header} data-sticky={hdr.sticky ? undefined : 'false'} data-logo={hdr.logo_size !== 'normal' ? hdr.logo_size : undefined}>
          <div className={CN.inner}>
            <A className={CN.logo} href="/" aria-label={`${name} home`}>{showImg ? <img src={logo} alt={name} /> : null}{showName ? <span>{name}</span> : null}</A>
            <button type="button" className={CN.navToggle} aria-expanded={navOpen} aria-controls="w-nav" onClick={() => setNavOpen((o) => !o)}>Menu</button>
            <nav id="w-nav" className={CN.nav} aria-label="Site" data-open={navOpen ? 'true' : 'false'}>
              {nav.map((n) => (Array.isArray(n.children) && n.children.length ? (
                <NavDropdown key={`${n.label}-${n.href}`} item={n} path={path} ctx={ctx} />
              ) : (
                <A key={`${n.label}-${n.href}`} className={CN.navLink} href={n.href} aria-current={resolveHref(ctx, n.href) === path ? 'page' : undefined}>{n.label}</A>
              )))}
              {cta ? <A className={cls(CN.navLink, CN.headerCta)} href={cta.href}>{cta.label}</A> : null}
            </nav>
          </div>
        </header>
        <main className={CN.main} id="w-main">{main}</main>
        <footer className={CN.footer}>
          <div className={CN.inner}>
            <div>{footer.text || `© ${new Date().getFullYear()} ${name}`}</div>
            <FooterLinks footer={footer} />
            {footer.show_powered_by !== false ? <div className={CN.powered}>Powered by <a href="https://serv-os.app" rel="noopener">ServOS</a></div> : null}
          </div>
        </footer>
      </div>
    </SiteContext.Provider>
  );
}

function Breadcrumb({ crumbs }) {
  if (!crumbs || crumbs.length < 2) return null;
  return (
    <nav className={cls(CN.inner, CN.breadcrumb)} aria-label="Breadcrumb">
      {crumbs.map((c, i) => i < crumbs.length - 1 ? <span key={c.path}><A href={c.path}>{c.name}</A> › </span> : <span key={c.path}>{c.name}</span>)}
    </nav>
  );
}

function FooterLinks({ footer }) {
  const links = (Array.isArray(footer.links) ? footer.links : []).filter((l) => l && l.label && l.href);
  const ig = footer.instagram ? String(footer.instagram).replace(/^@/, '') : '';
  const items = [
    ...links.map((l) => <li key={`l-${l.label}`}><A href={l.href}>{l.label}</A></li>),
    ig ? <li key="ig"><a href={`https://www.instagram.com/${ig}`} rel="noopener">Instagram</a></li> : null,
    footer.facebook ? <li key="fb"><a href={footer.facebook} rel="noopener">Facebook</a></li> : null,
    footer.email ? <li key="em"><a href={`mailto:${footer.email}`}>{footer.email}</a></li> : null,
    footer.phone ? <li key="ph"><a href={`tel:${String(footer.phone).replace(/\s+/g, '')}`}>{footer.phone}</a></li> : null,
  ].filter(Boolean);
  if (!items.length) return null;
  return <ul className={CN.footerLinks}>{items}</ul>;
}
