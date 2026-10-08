// src/lib/groupBrand.js
// Which venue's Menu appearance dresses the group ordering page (/order/<group>
// and /cater/<group>). A company has no branding of its own: the page borrows
// one venue's look. Until 7 Oct 2026 it borrowed the FIRST venue by name that
// had any branding at all, so a venue with no header photo (Coffee Boy
// Headingley) gave the whole group the flame gradient while the other five
// venues had the shop front photo. Now the most complete look wins: header
// photo, then logo, then colour. Ties go to a venue the page can send people
// to, then to the order the page lists them in.
//
// PURE: no React, no Supabase. Used by GroupOrderSurface (the page) and by
// Back Office → Online ordering (the card that says whose look the page wears).
import { isLight } from '../surfaces/menu/menuTheme.js';

// The cream the picker was designed on (handoff v5.5.807).
export const GROUP_PAGE_BG = '#FAF8F3';

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

// How much of a look a branding row holds: 4 header photo, 2 logo, 1 colour.
export function brandScore(branding) {
  const b = branding && typeof branding === 'object' && !Array.isArray(branding) ? branding : {};
  return (str(b.hero_url) ? 4 : 0) + (str(b.logo_url) ? 2 : 0) + (str(b.brand_color) ? 1 : 0);
}

function later(a, b) {
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}

// venues: platform locations rows ({ id, online_enabled, online_slug, online_branding }).
// actionableIds: the ids the page can send a customer to. Returns the venue
// whose look the page should wear, or null when no venue has one.
export function pickBrandVenue(venues, actionableIds) {
  const act = new Set(Array.isArray(actionableIds) ? actionableIds : []);
  let best = null;
  let bestKey = null;
  (Array.isArray(venues) ? venues : []).forEach((v, i) => {
    const score = brandScore(v?.online_branding);
    if (score === 0) return;
    const key = [score, act.has(v.id) ? 1 : 0, v.online_enabled ? 1 : 0, -i];
    if (!best || later(key, bestKey)) { best = v; bestKey = key; }
  });
  return best;
}

// The page body: the borrowed venue's storefront background when it is a
// light colour (the picker's dark text sits on it), else the cream.
export function groupBodyBg(bodyBg) {
  const raw = String(bodyBg || '').trim();
  if (!/^#?[0-9a-fA-F]{6}$/.test(raw)) return GROUP_PAGE_BG;
  const hex = raw.startsWith('#') ? raw : `#${raw}`;
  return isLight(hex) ? hex : GROUP_PAGE_BG;
}
