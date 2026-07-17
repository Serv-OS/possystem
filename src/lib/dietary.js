// ============================================================
// src/lib/dietary.js — shared dietary-badge resolution
// ============================================================
// Dietary flags live on `menu_items.tags` (jsonb array of tag ids, set in
// Back office → Menu → item → Allergens & dietary; see migration
// 20260713j_menu_item_dietary_tags.sql). This maps those raw tags to the
// four customer-facing badges: GF / V / VG / DF.
//
// Single source of truth — used by the print menu (printMenu.js), the
// digital menu board (MenuBoardSurface.jsx) and the online ordering
// storefront (OnlineSurface.jsx / OnlineItemSheet.jsx). Do NOT fork this
// map into a surface; import it.
//
// Pure — no React/DOM/Supabase.

export const DIET = {
  gf: 'GF', glutenfree: 'GF', 'gluten-free': 'GF', 'gluten free': 'GF',
  v: 'V', veg: 'V', vegetarian: 'V',
  vg: 'VG', vegan: 'VG',
  df: 'DF', dairyfree: 'DF', 'dairy-free': 'DF',
};

// Full customer-facing label for each badge (item sheet, tooltips).
export const DIET_LABELS = { GF: 'Gluten free', V: 'Vegetarian', VG: 'Vegan', DF: 'Dairy free' };

// item → deduped ordered badge list, e.g. ['VG', 'GF']. Reads `tags` on
// either shape (raw Supabase row or camelCase store row — column is `tags`
// in both). Unknown tags are ignored; no tags → [].
export function dietaryBadges(it) {
  const out = [], seen = new Set();
  for (const t of (it && Array.isArray(it.tags) ? it.tags : [])) {
    const b = DIET[String(t).toLowerCase().trim()];
    if (b && !seen.has(b)) { seen.add(b); out.push(b); }
  }
  return out;
}
