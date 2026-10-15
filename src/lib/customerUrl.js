// v5.5.221 — Customer-facing URL parser.
// Handles customer surfaces from the same web app:
//   • Online ordering    https://<slug>.<customer-root>/          → mode: 'online'
//   • QR table-side      https://<slug>.<customer-root>/t/<id>    → mode: 'qr', tableId
//   • Gift purchase      https://<slug>.<customer-root>/gift      → mode: 'gift'
//   • Gift balance       https://<slug>.<customer-root>/gift/balance → mode: 'gift_balance'
//   • Gift success       https://<slug>.<customer-root>/gift/success → mode: 'gift_success'
//   • Loyalty portal     https://<slug>.<customer-root>/account   → mode: 'account'
//   • Booking widget     https://<slug>.<customer-root>/book      → mode: 'book'
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
//
// 29 Sep 2026: the parsing itself lives in lib/customerHost.js (pure, tested by node:test), which
// also knows the WiFi front door hosts <slug>.wifi.serv-os.app and <slug>.wifi.dev.serv-os.app.

import { CUSTOMER_ROOT } from './env';
import { parseCustomerLocation } from './customerHost';

function readStoredSlug() {
  return (window.localStorage || {}).getItem?.('rpos-online-slug') || null;
}

export function parseCustomerUrl(loc = (typeof window !== 'undefined' ? window.location : null)) {
  return parseCustomerLocation(loc, { customerRoot: CUSTOMER_ROOT, readStoredSlug });
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
    // v5.5.891: the three follow-up reads (QR settings, tab guardrails, company name) are
    // independent and were run SEQUENTIALLY — 4 round-trips before a customer page could
    // paint. Now fired together; each stays individually defensive (a missing-column error
    // on a partially-migrated venue only loses its own fields, exactly as before).
    // v5.7.99: the busy prep rule is read SEPARATELY and defensively, exactly
    // like the QR settings below. It must never join the main select: that one
    // has no missing-column fallback, so a column that is not there yet would
    // make the whole row come back empty and every storefront would report
    // "venue not found" until the migration ran.
    const [qrRes, tabRes, coRes, busyRes] = await Promise.allSettled([
      platformSupabase.from('locations')
        .select('qr_payment_mode, qr_table_mode, qr_service_charge_pct')
        .eq('id', data.id).maybeSingle(),
      platformSupabase.from('locations')
        .select('qr_tab_pre_auth_amount, qr_tab_warning_message, qr_tab_left_open_surcharge_pct, qr_tab_left_open_surcharge_fixed, qr_tab_force_close_after_minutes')
        .eq('id', data.id).maybeSingle(),
      data.company_id
        ? platformSupabase.from('companies').select('name').eq('id', data.company_id).maybeSingle()
        : Promise.resolve({ data: null }),
      // collection_lead_minutes rides along here, not in the main select, for
      // the same reason: it is the KITCHEN START lead (how far ahead of a
      // promised collection the kitchen begins), which is a different setting
      // from the wait quoted to the customer. The checkout needs it to stamp
      // sent_at on a pre-order.
      platformSupabase.from('locations')
        .select('online_busy_step_orders, online_busy_step_minutes, online_busy_max_minutes, collection_lead_minutes, tipping_config, online_advance_days')
        .eq('id', data.id).maybeSingle(),
    ]);
    if (qrRes.status === 'fulfilled' && qrRes.value?.data) Object.assign(data, qrRes.value.data);
    if (tabRes.status === 'fulfilled' && tabRes.value?.data) Object.assign(data, tabRes.value.data);
    if (coRes.status === 'fulfilled' && coRes.value?.data?.name) data.company_name = coRes.value.data.name;
    if (busyRes.status === 'fulfilled' && busyRes.value?.data) Object.assign(data, busyRes.value.data);
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
