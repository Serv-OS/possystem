// v5.5.103 — Customer-facing URL parser.
// Handles three customer surfaces from the same web app:
//   • Online ordering    https://(slug).serv-os.app/        → mode: 'online'
//   • QR table-side      https://(slug).serv-os.app/t/<id>  → mode: 'qr', tableId
//   • Kiosk (legacy)     https://possystem-liard.vercel.app/?mode=kiosk
//
// Local / preview testing falls back to query params so we can iterate
// without DNS:
//   ?loc=peters-cafe&surface=online
//   ?loc=peters-cafe&surface=qr&t=t5
// (or set window.localStorage 'rpos-online-slug' for sticky preview).
//
// Resolution path: the parser returns { mode, slug, tableId } — DOES NOT
// hit Supabase. The caller (boot loader) takes the slug and resolves it
// to a platform location row via lookupLocationBySlug() in supabase.js.

// Subdomains reserved for operator / infra surfaces — never customer slugs.
// "de" is the BO host on pos-up.com today; "app", "bo", "admin", "api",
// "staging", "dev", "test" are the usual suspects we should defend against.
// If anyone tries to register a slug that collides with this list, the BO
// validator should also block it (TODO when we wire onboarding).
const NON_SLUG_SUBDOMAINS = new Set([
  '', 'www', 'localhost', 'possystem-liard',
  'de', 'app', 'bo', 'admin', 'api', 'staging', 'stage', 'dev', 'test', 'preview',
]);

// Domains we treat as the customer-facing root. The first match wins.
//   • serv-os.app    → final intended customer domain
//   • pos-up.com     → today's operating domain (de.pos-up.com is BO; future
//                      <slug>.pos-up.com is customer ordering)
//   • servos.app     → typo-friendly fallback
const ROOT_DOMAIN_SUFFIXES = [
  '.serv-os.app', '.servos.app', '.pos-up.com',
];

export function parseCustomerUrl(loc = (typeof window !== 'undefined' ? window.location : null)) {
  if (!loc) return { mode: null, slug: null, tableId: null };
  const hostname = (loc.hostname || '').toLowerCase();
  const pathname = loc.pathname || '/';
  const params = new URLSearchParams(loc.search || '');

  // 1. Slug — try subdomain first, fall back to ?loc query
  let slug = null;
  for (const suffix of ROOT_DOMAIN_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      const sub = hostname.slice(0, -suffix.length);
      if (sub && !NON_SLUG_SUBDOMAINS.has(sub)) slug = sub;
      break;
    }
  }
  if (!slug) {
    const q = params.get('loc');
    if (q) slug = q.toLowerCase();
  }
  if (!slug) {
    try {
      const stored = (window.localStorage || {}).getItem?.('rpos-online-slug');
      if (stored) slug = stored.toLowerCase();
    } catch {}
  }

  // 2. Mode — path takes precedence, then ?surface, then default
  // /t/<id>     → qr
  // /k          → kiosk
  // anything else with a slug → online
  let mode = null;
  let tableId = null;
  const tableMatch = pathname.match(/^\/t\/([^/?#]+)/);
  if (tableMatch) {
    mode = 'qr';
    tableId = decodeURIComponent(tableMatch[1]);
  } else if (pathname.startsWith('/k')) {
    mode = 'kiosk';
  } else {
    const surface = params.get('surface');
    if (surface === 'qr')      { mode = 'qr';     tableId = params.get('t'); }
    else if (surface === 'kiosk') mode = 'kiosk';
    else if (surface === 'online') mode = 'online';
    else if (slug) mode = 'online'; // having a slug implies online by default
  }

  return { mode, slug, tableId };
}

// Resolve a slug to a location row from platform DB. Returns null if the
// slug is unknown. Lightweight 30-second cache so the customer page doesn't
// hammer Supabase on every interaction, but refreshes often enough that
// operator changes (slug move, hours edit, enable toggle) propagate quickly
// and we don't get stuck on a row that was migrated away in BO.
const _slugCache = new Map();
// v5.5.153: dropped from 30s → 5s. With BO QR settings now persisting,
// operators expect changes to be visible on the customer surface
// immediately after a refresh — 30s of stale cache hides BO toggles.
// Trade-off is one extra slug-lookup per customer every 5s (cheap).
const SLUG_CACHE_TTL_MS = 5_000;

export async function lookupLocationBySlug(slug, platformSupabase) {
  if (!slug || !platformSupabase) return null;
  const hit = _slugCache.get(slug);
  if (hit && (Date.now() - hit.at) < SLUG_CACHE_TTL_MS) return hit.row;
  try {
    const { data } = await platformSupabase
      .from('locations')
      // Pull every column the customer surface might need so we don't have
      // to round-trip again. online_branding / online_menu_id /
      // online_collection_lead_min / online_delivery_enabled were added in
      // v5.5.109 — all platform-DB columns, not ops. (Reminder: receipt_branding
      // lives on OPS — fetched by OnlineSurface as a fallback only when
      // online_branding is empty.)
      .select('id, ops_location_id, name, timezone, online_slug, online_enabled, qr_enabled, opening_hours, online_branding, online_menu_id, online_collection_lead_min, online_delivery_enabled')
      .eq('online_slug', slug)
      .maybeSingle();
    if (!data) {
      _slugCache.set(slug, { row: null, at: Date.now() });
      return null;
    }
    // v5.5.145: defensively probe QR-mode settings in a second SELECT so a
    // missing-column error (venue's platform.locations hasn't run the QR
    // migration yet) only loses the QR fields — not the entire location.
    // The first SELECT keeps the customer surface working unchanged.
    try {
      const { data: qrRow } = await platformSupabase
        .from('locations')
        .select('qr_payment_mode, qr_table_mode, qr_service_charge_pct')
        .eq('id', data.id)
        .maybeSingle();
      if (qrRow) Object.assign(data, qrRow);
    } catch { /* columns not yet migrated — fall back to defaults at use site */ }
    // v5.5.149: open-tab guardrails — separate defensive SELECT so missing
    // columns from a partial migration don't poison the rest of the load.
    try {
      const { data: tabRow } = await platformSupabase
        .from('locations')
        .select('qr_tab_pre_auth_amount, qr_tab_warning_message, qr_tab_left_open_surcharge_pct, qr_tab_left_open_surcharge_fixed, qr_tab_force_close_after_minutes')
        .eq('id', data.id)
        .maybeSingle();
      if (tabRow) Object.assign(data, tabRow);
    } catch { /* columns not yet migrated */ }
    _slugCache.set(slug, { row: data, at: Date.now() });
    return data;
  } catch (e) {
    console.warn('[customerUrl] slug lookup failed:', e?.message);
    return null;
  }
}

// Force a refetch — used by the customer surface itself after the user
// navigates around so a stale 30s cache can't lock them into "we're closed".
export function invalidateSlugCache(slug) {
  if (slug) _slugCache.delete(slug); else _slugCache.clear();
}

// Validate a slug input from BO — same shape DNS-friendly: lowercase a-z,
// digits, hyphens, 3-40 chars, no leading/trailing hyphen.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
export function isValidSlug(s) {
  return typeof s === 'string' && SLUG_RE.test(s);
}
export function suggestSlug(name = '') {
  return String(name)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
