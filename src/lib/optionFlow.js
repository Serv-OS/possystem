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
