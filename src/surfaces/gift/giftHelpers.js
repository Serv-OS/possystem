// v5.5.208 — Shared helpers for customer-facing gift card surfaces.
// Calls the Ops DB edge functions. Customer surfaces use anon-key auth
// (same pattern as OnlineCheckout).

const OPS_URL = import.meta.env.VITE_SUPABASE_URL;
const OPS_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

import { normaliseGiftLimits } from './giftTheme';
export { PRESET_AMOUNTS, GIFT_DEFAULT_LIMITS, normaliseGiftLimits, giftPresetsFor, buildGiftTheme, giftTheme } from './giftTheme';


/**
 * The public gift config for a company, fetched once: branding plus the card
 * value limits the checkout enforces. Cached per company_id.
 */
const _publicCache = {};
async function fetchGiftPublic(companyId) {
  if (!companyId) return null;
  if (_publicCache[companyId] !== undefined) return _publicCache[companyId];
  try {
    _publicCache[companyId] = await callGiftPublic('gift-branding-public', { company_id: companyId });
  } catch {
    _publicCache[companyId] = null;
  }
  return _publicCache[companyId];
}

/**
 * Fetch gift-specific branding for a company from gift_brand_config.
 * Returns the branding object or null.
 */
export async function fetchGiftBranding(companyId) {
  const data = await fetchGiftPublic(companyId);
  return data?.branding || null;
}

/**
 * The card value limits set in Back Office, Gift cards, Settings, exactly as the
 * checkout enforces them, so the page never offers an amount the payment refuses.
 */
export async function fetchGiftLimits(companyId) {
  const data = await fetchGiftPublic(companyId);
  return normaliseGiftLimits(data?.limits);
}

/**
 * Call a gift-card edge function on the Ops DB project.
 * For customer-facing (anonymous) calls, we pass the anon key as bearer.
 */
export async function callGiftPublic(fnName, body) {
  const res = await fetch(`${OPS_URL}/functions/v1/${fnName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPS_ANON}`,
      'apikey': OPS_ANON,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

/** Format minor currency units → display string (e.g. 2500 → "£25.00") */
export function formatAmount(minor, currency = 'gbp') {
  const major = (minor || 0) / 100;
  const sym = currency === 'usd' ? '$' : '£';
  return `${sym}${major.toFixed(2)}`;
}

/** Common preset amounts for gift card purchase (minor units) */
export function giftUrl(path) {
  const params = new URLSearchParams(window.location.search);
  const loc = params.get('loc');
  const base = `${window.location.origin}${path}`;
  return loc ? `${base}?loc=${encodeURIComponent(loc)}` : base;
}

/** Legacy export — kept for import compatibility, returns default theme */
