// src/lib/rowMapping.js — ONE shared normaliser for `menus` rows.
//
// WHY: on 20 Aug 2026 three production bugs shipped from the same class in one
// day: rows arriving snake_case while screens and writers read camelCase.
// menus.is_default was dropped by three separate loaders (v5.7.11 + v5.7.14)
// and then wiped by the sbUpsertMenu writer (v5.7.15). The fixes were correct
// but hand-copied at every site, which is exactly how the class keeps
// re-shipping. This is the single copy. Every door a menus row can enter
// through MUST use it:
//   - SyncBridge boot load (raw Supabase rows)
//   - store applyConfigUpdate (push snapshots carry raw snake rows)
//   - BackOfficeApp.loadLocationData (the Back Office's own loader)
//   - _sbUpsertMenuNow (a stale tab may hold snake-only rows; reading only
//     the camel spelling silently un-starred the default on ANY save)
// If you add a new menus loader or writer, call this, never re-type the chain.

// Normalise one `menus` row to the camelCase shape the app reads (MenuManager,
// menu resolvers), KEEPING the snake originals via spread. The camel spelling
// wins when both are present: an already-normalised store row must never be
// overridden by a stale snake field riding along on the same object.
// Accepts snake-only, camel-only and mixed rows.
export const normaliseMenuRow = (row) => {
  if (!row || typeof row !== 'object') return row;
  return {
    ...row,
    isDefault: row.isDefault ?? row.is_default ?? false,
    isActive: row.isActive ?? row.is_active ?? true,
    sortOrder: row.sortOrder ?? row.sort_order ?? 0,
  };
};
