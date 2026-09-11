// src/lib/bookings/preorderRows.js
//
// booking_preorders row mapping, both directions, as pure functions
// (10 Sep 2026 review). bookingsData.js imports the Supabase client, which
// node:test cannot load, so the mapping that decides whether a staff save
// keeps or wipes a guest's size and options lives here and is tested.

// A database row to the store's pre-order shape. Before migration 20260910
// Part B the choice columns are absent and read as none.
export const rowToPreorder = (r) => (r ? {
  id: r.id, bookingId: r.booking_id, seat: r.seat ?? null, guestName: r.guest_name || '',
  itemId: r.item_id || null, displayName: r.display_name || '', course: r.course ?? 0, notes: r.notes || '',
  mods: Array.isArray(r.mods) ? r.mods : [],
  variantItemId: r.variant_item_id || null,
  variantName: r.variant_name || null,
} : null);

// The rows a wholesale replace inserts. The guest's size and options are
// written back with every row, so a staff save never wipes them.
export function preorderInsertRows(bookingId, locationId, rows) {
  return (rows || []).filter((r) => r && (r.displayName || r.itemId)).map((r) => ({
    location_id: locationId,
    booking_id: bookingId,
    seat: r.seat ?? null,
    guest_name: r.guestName || null,
    item_id: r.itemId || null,
    display_name: r.displayName || 'Item',
    course: r.course ?? 0,
    notes: r.notes || '',
    mods: Array.isArray(r.mods) ? r.mods : [],
    variant_item_id: r.variantItemId || null,
    variant_name: r.variantName || null,
  }));
}

// The same rows without the choice columns, for a database without them yet.
export const withoutChoiceColumns = (rows) =>
  // eslint-disable-next-line no-unused-vars
  (rows || []).map(({ mods, variant_item_id, variant_name, ...rest }) => rest);

// A column the database does not have yet (Postgres 42703, PostgREST PGRST204).
export const missingColumn = (e) => {
  const code = String(e?.code || '');
  const m = String(e?.message || '');
  return code === '42703' || code === 'PGRST204' || /could not find the '.+' column|column .+ does not exist/i.test(m);
};
