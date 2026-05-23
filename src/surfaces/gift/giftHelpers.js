// v5.5.196 — Shared helpers for customer-facing gift card surfaces.
// Calls the Ops DB edge functions. Customer surfaces use anon-key auth
// (same pattern as OnlineCheckout).

const OPS_URL = import.meta.env.VITE_SUPABASE_URL;
const OPS_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

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
export const PRESET_AMOUNTS = [1000, 2000, 2500, 5000, 7500, 10000];

/** Shared dark-theme style tokens matching the customer surface look */
export const giftTheme = {
  bg: '#0e0e10',
  card: '#16161a',
  border: '#2a2a30',
  accent: '#e8a020',
  accentHover: '#f0b040',
  text: '#fff',
  textMuted: '#aaa',
  textDim: '#666',
  error: '#ff4466',
  success: '#22c55e',
  radius: 14,
};
