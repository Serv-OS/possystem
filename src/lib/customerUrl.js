// v5.5.221 — Customer-facing URL parser.
// Handles customer surfaces from the same web app:
//   • Online ordering    https://<slug>.<customer-root>/          → mode: 'online'
//   • QR table-side      https://<slug>.<customer-root>/t/<id>    → mode: 'qr', tableId
//   • Gift purchase      https://<slug>.<customer-root>/gift      → mode: 'gift'
//   • Gift balance       https://<slug>.<customer-root>/gift/balance → mode: 'gift_balance'
//   • Gift success       https://<slug>.<customer-root>/gift/success → mode: 'gift_success'
//   • Loyalty portal     https://<slug>.<customer-root>/account   → mode: 'account'
//
// Customer root is tier-dependent (see src/lib/env.js):
//   dev   → <slug>.dev.serv-os.app
//   stage → <slug>.stage.serv-os.app
//   prod  → <slug>.serv-os.app
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

import { CUSTOMER_ROOT } from './env';

// Subdomains reserved for operator / infra surfaces — never customer slugs.
// "app" is the prod operator host; "dev", "stage" are tier hosts.
// If anyone tries to register a slug that collides with this list, the BO
// validator should also block it (TODO when we wire onboarding).
const NON_SLUG_SUBDOMAINS = new Set([
  '', 'www', 'localhost', 'possystem-liard',
  'de', 'app', 'bo', 'admin', 'api', 'staging', 'stage', 'dev', 'test', 'preview',
]);

// Domains we treat as the customer-facing root. The first match wins.
// Built dynamically from env config so all tiers are recognised,
// plus legacy domains for backward compat during migration.
const ROOT_DOMAIN_SUFFIXES = [
  `.${CUSTOMER_ROOT}`,       // e.g. .dev.serv-os.app (current tier)
  '.serv-os.app',            // prod / catch-all
  '.servos.app',             // typo-friendly fallback
  '.pos-up.com',             // legacy operating domain
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
  // /t/<id>           → qr
  // /k                → kiosk
  // /gift             → gift (purchase page)
  // /gift/balance     → gift_balance (balance check)
  // /gift/success     → gift_success (post-purchase confirmation)
  // anything else with a slug → online
  let mode = null;
  let tableId = null;
  const tableMatch = pathname.match(/^\/t\/([^/?#]+)/);
  if (tableMatch) {
    mode = 'qr';
    tableId = decodeURIComponent(tableMatch[1]);
  } else if (pathname.startsWith('/gift/balance')) {
    mode = 'gift_balance';
  } else if (pathname.startsWith('/gift/success')) {
    mode = 'gift_success';
  } else if (pathname === '/gift' || pathname.startsWith('/gift/')) {
    mode = 'gift';
  } else if (pathname === '/account' || pathname.startsWith('/account/')) {
    mode = 'account';
  } else if (pathname === '/review' || pathname.startsWith('/review/')) {
    mode = 'review';
  } else if (pathname === '/wifi' || pathname.startsWith('/wifi/')) {
    mode = 'wifi';
  } else if (pathname.startsWith('/k')) {
    mode = 'kiosk';
  } else {
    const surface = params.get('surface');
    if (surface === 'qr')           { mode = 'qr';     tableId = params.get('t'); }
    else if (surface === 'kiosk')     mode = 'kiosk';
    else if (surface === 'gift')      mode = 'gift';
    else if (surface === 'gift_balance') mode = 'gift_balance';
    else if (surface === 'review')    mode = 'review';
    else if (surface === 'wifi')      mode = 'wifi';
    else if (surface === 'online')    mode = 'online';
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
      .select('id, ops_location_id, name, timezone, currency, online_slug, online_enabled, qr_enabled, opening_hours, online_branding, online_menu_id, online_collection_lead_min, online_delivery_enabled, company_id')
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
    // v5.5.208: Fetch company name for customer-facing gift card pages.
    // Gift cards are org-level, so show company name instead of location name.
    if (data.company_id) {
      try {
        const { data: co } = await platformSupabase
          .from('companies').select('name')
          .eq('id', data.company_id).maybeSingle();
        if (co?.name) data.company_name = co.name;
      } catch { /* not critical — surfaces fall back to location.name */ }
    }
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
