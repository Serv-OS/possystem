// kdsStationNames.js: the name a kitchen station shows under in reports (5 Oct 2026).
//
// Peter, Coffee Boy Barnsley: "KDS report station name doesn't match what we called them". The
// report showed raw ids (pc-1790752941614-i9vh) because it looked the id up among MENU CATEGORIES.
// A kitchen ticket's centre_id is a PRODUCTION CENTRE id (Back Office, Production printing), so
// the names live in print_routing.centres: "KDS drinks", "kds food", "Frozen Drinks KDS".

/** { centreId: name } from one or more lists of production centres. Later lists win. */
export function stationNameMap(...centreLists) {
  const map = {};
  for (const list of centreLists) {
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      const id = c && typeof c.id === 'string' ? c.id : null;
      const name = c && typeof c.name === 'string' ? c.name.trim() : '';
      if (id && name) map[id] = name;
    }
  }
  return map;
}

/**
 * The label for a ticket's centre id. A centre that was deleted after its tickets were made has
 * no name any more: say so, with the last 4 characters so two removed stations stay apart.
 */
export function stationLabel(centreId, map = {}) {
  if (!centreId) return 'No station';
  if (map[centreId]) return map[centreId];
  const tail = String(centreId).slice(-4);
  return `Removed station (${tail})`;
}
