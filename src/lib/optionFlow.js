// src/lib/optionFlow.js — v5.5.948
//
// ONE ordering rule for an item's option flow, shared by every surface.
//
// An item carries two separately-assigned lists — modifier groups and instruction
// groups (cooking preferences) — and, since v5.5.948, an optional combined order:
// menu_items.option_group_order (camelCase optionGroupOrder in the store), an array
// of group ids mixing both kinds, edited by dragging on Back Office → item → Flow.
//
// Rules:
//   • No saved order → instructions FIRST, then modifier groups in their assigned
//     order (the v5.5.915/947 default: the kitchen-critical choice leads).
//   • Saved order → groups render exactly in that order, on every surface.
//   • Groups NOT in the saved order (assigned after the drag): a new instruction
//     group goes to the FRONT (default rule), a new modifier group APPENDS.
//
// Callers pass their own already-built group lists; entries come back as
// { kind: 'mod' | 'inst', id, g } where g is the caller's untouched group object.

// v5.5.964: the committed order LINE must follow the same flow. The check rail,
// KDS, receipts and kitchen tickets all render item.mods in ARRAY ORDER, so a
// surface that appends instructions after modifiers (the old shape) printed
// cooking preferences last no matter what the Back Office flow said.
//
// Callers keep their own per-group entry builders (shapes differ per surface):
//   buildModGroup(gid, g) → array of mod entries for that group ([] when none)
//   buildInst(gid, g)     → one instruction entry or null
// modKeys/instKeys are the caller's selection keys — anything not covered by a
// top-level flow entry (nested sub-groups, stale assignments) appends AFTER the
// flow in its original order, exactly the old behaviour for those edge cases.
export function flowOrderedMods({ order, modGroups, instGroups, getId, modKeys = [], instKeys = [], buildModGroup, buildInst }) {
  const mods = [];
  const doneM = new Set(), doneI = new Set();
  for (const entry of orderOptionFlow(order, modGroups, instGroups, getId)) {
    if (entry.kind === 'mod') { mods.push(...(buildModGroup(entry.id, entry.g) || [])); doneM.add(entry.id); }
    else { const m = buildInst(entry.id, entry.g); if (m) mods.push(m); doneI.add(entry.id); }
  }
  for (const gid of modKeys) if (!doneM.has(String(gid))) mods.push(...(buildModGroup(gid) || []));
  for (const gid of instKeys) if (!doneI.has(String(gid))) { const m = buildInst(gid); if (m) mods.push(m); }
  return mods;
}

export function orderOptionFlow(order, mods, insts, getId = (x) => String(x?.id ?? x?.groupId ?? '')) {
  const entries = [
    ...(insts || []).map((g) => ({ kind: 'inst', id: getId(g), g })),
    ...(mods || []).map((g) => ({ kind: 'mod', id: getId(g), g })),
  ];
  if (!Array.isArray(order) || order.length === 0) return entries;
  const pos = new Map(order.map((id, i) => [String(id), i]));
  return entries
    .map((e, i) => ({
      e,
      k: pos.has(e.id) ? pos.get(e.id) : (e.kind === 'inst' ? -1000 + i : 1e6 + i),
    }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.e);
}
