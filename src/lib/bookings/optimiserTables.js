// src/lib/bookings/optimiserTables.js
//
// Store tables to optimiser tables (16 Oct 2026). Only real floor plan tables reach
// suggestTables: merged split check children (parentId) are left out exactly like the waitlist's
// tablesView, and so are the rebuilt 'Removed table' entries rebuildOrphans adds (planRemoved or
// rebuilt). Those are not in floor_tables, so create_booking would refuse them as unknown_table
// and the host stand would offer the same refused table again.
export function optimiserTables(tables = []) {
  return (tables || []).filter((t) => t && !t.parentId && !t.planRemoved && !t.rebuilt).map((t) => ({
    id: t.id, label: t.label || t.id, covers: t.maxCovers || 2, section: t.section || null,
  }));
}
