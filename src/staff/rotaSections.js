// src/staff/rotaSections.js
//
// Which SECTION row does a rota shift belong to on the "By section" view?
//
// v5.5.992. The section grid used to filter on `shift.sectionId === section.id`
// and nothing else, so any shift with no section assigned — which is most of
// them, since the field is optional and rarely set — was silently dropped. A
// week showing 12 shifts under "By staff" rendered 3 under "By section", with
// nothing on screen to say 9 had gone.
//
// The two views also group by different things, which is why they were never
// going to agree by accident:
//   By staff   → the PERSON's role group (Floor / Kitchen / Bar, from wfUi's
//                GRP_SECTION, derived from their role)
//   By section → the SHIFT's own sectionId (a wf_sections row: Runner, Bar…)
//
// So: resolve explicitly, and give anything left over a home. The UNASSIGNED
// bucket is what makes the drop impossible rather than merely unlikely.

export const UNASSIGNED = '__unassigned__';

/**
 * Resolve one shift to a section id.
 *   1. its own sectionId, if that section still exists
 *   2. the PERSON's own section (wf_staff.section_ids) — "Jane works Runner",
 *      so her unsectioned shifts belong under Runner. Only when they belong to
 *      exactly one section; someone in two could go either way and guessing
 *      would put them in the wrong place half the time.
 *   3. a section whose NAME matches the person's role group (a Chef lands in
 *      "Kitchen" when a Kitchen section exists), case-insensitive
 *   4. UNASSIGNED
 *
 * @param shift       { sectionId?, roleKey?, staffId }
 * @param sections    wf_sections rows [{ id, name }]
 * @param groupNameOf (shift) => role-group display name or null, e.g. 'Kitchen'
 * @param staffSectionsOf (shift) => that person's section id array
 */
export function sectionIdForShift(shift, sections = [], groupNameOf = () => null, staffSectionsOf = () => []) {
  if (!shift) return UNASSIGNED;
  const live = id => id && sections.some(x => x.id === id);
  if (live(shift.sectionId)) return shift.sectionId;

  const mine = (staffSectionsOf(shift) || []).filter(live);
  if (mine.length === 1) return mine[0];

  const grpName = groupNameOf(shift);
  if (grpName) {
    const hit = sections.find(x => String(x.name || '').toLowerCase() === String(grpName).toLowerCase());
    if (hit) return hit.id;
  }
  // Someone in several sections with no shift section and no role-group match
  // is genuinely ambiguous. Say so rather than picking one.
  return UNASSIGNED;
}

/**
 * Bucket a week of shifts by `${sectionId}|${date}`, each list sorted by start.
 * Every shift lands in exactly one bucket — that is the whole point, and
 * `bucketedCount` exists so a caller can assert it.
 */
export function bucketShiftsBySection(shifts = [], sections = [], groupNameOf = () => null, staffSectionsOf = () => []) {
  const map = new Map();
  let unassigned = 0;
  (shifts || []).forEach(sh => {
    const secId = sectionIdForShift(sh, sections, groupNameOf, staffSectionsOf);
    if (secId === UNASSIGNED) unassigned++;
    const k = `${secId}|${sh.date}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(sh);
  });
  map.forEach(list => list.sort((a, b) => String(a.start || '').localeCompare(String(b.start || ''))));
  let bucketed = 0;
  map.forEach(list => { bucketed += list.length; });
  return { map, unassigned, bucketedCount: bucketed };
}
