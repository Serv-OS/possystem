// v5.5.197 — Shared helpers for customer-facing gift card surfaces.
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

// ── Default dark theme (fallback when no branding is set) ───────────────
const DEFAULT_THEME = {
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
  logo: null,
  hero: null,
};

/**
 * Build a theme object from gift-specific branding if set, otherwise from
 * the location's online_branding. Falls back to the default dark theme if
 * neither is configured.
 *
 * @param {object} location - Platform DB location row (has online_branding)
 * @param {object} [giftBranding] - gift_brand_config.branding (per-feature override)
 */
export function buildGiftTheme(location, giftBranding) {
  // Gift-specific branding takes priority over online_branding
  const b = giftBranding || location?.online_branding;
  if (!b) return DEFAULT_THEME;
  const bg = b.background || DEFAULT_THEME.bg;
  const fg = b.foreground || DEFAULT_THEME.text;
  const accent = b.accent_color || DEFAULT_THEME.accent;
  // Derive muted/dim from the foreground colour at reduced opacity
  return {
    bg,
    card: blendColor(bg, fg, 0.04),
    border: blendColor(bg, fg, 0.12),
    accent,
    accentHover: accent,
    text: fg,
    textMuted: blendColor(bg, fg, 0.65),
    textDim: blendColor(bg, fg, 0.38),
    error: '#ff4466',
    success: '#22c55e',
    radius: 14,
    logo: b.logo_url || null,
    hero: b.hero_url || null,
  };
}

/** Blend two hex colours. t=0 → bg, t=1 → fg. */
function blendColor(bg, fg, t) {
  const parse = (hex) => {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
  };
  try {
    const [br,bg2,bb] = parse(bg);
    const [fr,fg2,fb] = parse(fg);
    const r = Math.round(br + (fr - br) * t);
    const g = Math.round(bg2 + (fg2 - bg2) * t);
    const b2 = Math.round(bb + (fb - bb) * t);
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b2.toString(16).padStart(2,'0')}`;
  } catch {
    return t > 0.5 ? fg : bg;
  }
}

/** Legacy export — kept for import compatibility, returns default theme */
export const giftTheme = DEFAULT_THEME;
