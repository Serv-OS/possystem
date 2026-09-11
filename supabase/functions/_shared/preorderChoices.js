// preorderChoices.js — guest pre-order choices (sizes and options), pure rules.
//
// 10 Sep 2026. A guest pre-ordering a package dish can now pick its size and
// its options (how a steak is cooked, a sauce) on the booking page, through
// the same online item sheet the storefront uses. ONE copy of the rules, used by:
//   - supabase/functions/booking-widget (validates every pick on the server:
//     only options that really exist on that dish survive, prices restamped
//     from the database)
//   - the web app (booking page: which dishes open the sheet, which must be
//     configured before they count; host stand: the one line summary)
//
// KEEP BYTE-IDENTICAL: supabase/functions/_shared/preorderChoices.js and
// src/lib/bookings/preorderChoices.js. preorderChoicesParity.test.js fails the
// build when they drift (Deno cannot import from src/).
//
// Stored shape of a pick (booking_preorders): item_id stays the PACKAGE LINE's
// item even when a size is picked (packagePricing matches the line by item id,
// then name); variant_item_id and variant_name carry the size; mods is the
// same array the till and the online sheet build:
//   { id, name, label, itemId, groupLabel, price }            a modifier
//   { id, name, label, groupLabel, price: 0, _instruction }   an instruction
// Menu rows arrive snake_case from the database or camelCase from the store.
// No I/O, no clock, no globals.

export const MAX_CHOICE_MODS = 30;
export const MAX_CHOICE_NOTE = 120;
export const MAX_MOD_QTY = 20;

const norm = (s) => String(s ?? '').trim().toLowerCase();
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round(n * 100) / 100;
const pick = (o, snake, camel) => {
  if (!o) return undefined;
  return o[snake] !== undefined ? o[snake] : o[camel];
};
const parentOf = (r) => pick(r, 'parent_id', 'parentId') ?? null;
const live = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r && r.archived !== true);

// Assigned groups are either bare ids or objects with per-item overrides
// ({ groupId, min, max }). Flat string ids either way.
export function groupIdsOf(list) {
  return (Array.isArray(list) ? list : [])
    .map((g) => (typeof g === 'string' ? g : (g?.groupId || g?.id)))
    .filter(Boolean)
    .map(String);
}

// The live sizes of a dish (menu rows whose parent is this row).
export function sizeChildren(item, rows) {
  if (!item?.id) return [];
  return live(rows).filter((r) => String(parentOf(r) ?? '') === String(item.id));
}

// Instruction assignments with their PER ITEM minimum. Back Office's Required
// toggle saves { groupId, min: 1 } on the item, never on the group def, so
// the minimum has to travel with the assignment (the till merges it the same
// way: a.min ?? def.min ?? 0, InlineItemFlow).
export function instructionEntriesOf(list) {
  return (Array.isArray(list) ? list : [])
    .map((g) => (typeof g === 'string' ? { groupId: g, min: undefined } : { groupId: g?.groupId || g?.id, min: g?.min }))
    .filter((e) => e.groupId)
    .map((e) => ({ groupId: String(e.groupId), min: e.min }));
}

// The groups that apply to a row: its own, else its parent's (a size with no
// groups of its own uses the dish's). Same rule as OnlineItemSheet.
export function optionGroupIdsFor(item, rows) {
  if (!item) return { mod: [], inst: [], instEntries: [] };
  const ownModRaw = pick(item, 'assigned_modifier_groups', 'assignedModifierGroups');
  const ownInstRaw = pick(item, 'assigned_instruction_groups', 'assignedInstructionGroups');
  const ownMod = groupIdsOf(ownModRaw);
  const ownInst = instructionEntriesOf(ownInstRaw);
  const pid = parentOf(item);
  const parent = pid ? (Array.isArray(rows) ? rows : []).find((r) => r && String(r.id) === String(pid)) : null;
  const instEntries = ownInst.length || !parent
    ? ownInst
    : instructionEntriesOf(pick(parent, 'assigned_instruction_groups', 'assignedInstructionGroups'));
  return {
    mod: ownMod.length || !parent ? ownMod : groupIdsOf(pick(parent, 'assigned_modifier_groups', 'assignedModifierGroups')),
    inst: instEntries.map((e) => e.groupId),
    instEntries,
  };
}

// The instruction groups a guest MUST answer on this row (how the steak is
// cooked): the per item minimum, else the def's own min, else def.required.
export function requiredInstructionGroups(item, rows, instDefs = []) {
  if (!item) return [];
  const defs = Array.isArray(instDefs) ? instDefs : [];
  const out = [];
  for (const e of optionGroupIdsFor(item, rows).instEntries) {
    const def = defs.find((d) => d && String(d.id) === e.groupId);
    if (!def) continue;
    const min = e.min ?? def.min ?? 0;
    if (num(min) > 0 || def.required === true) out.push(def);
  }
  return out;
}

// Which required instruction groups have no answer in these mods? An answer
// is an _instruction mod whose id is the sheet's ig-<group>-<label> or whose
// groupLabel is the group's name (the till's own shape has no id).
export function missingInstructionGroups({ item = null, rows = [], instDefs = [], mods = [] } = {}) {
  const list = Array.isArray(mods) ? mods : [];
  return requiredInstructionGroups(item, rows, instDefs).filter((def) => !list.some((m) => m && m._instruction && (
    (m.id && String(m.id).startsWith(`ig-${def.id}-`))
    || (norm(def.name) && norm(m.groupLabel) === norm(def.name))
  )));
}

// Does this dish have anything to choose? Sizes, modifier groups or
// instruction groups. The same test as the till's Options badge
// (POSSurface lineNeedsOptions), pizza excluded.
export function itemHasOptions(item, rows) {
  if (!item || item.type === 'pizza') return false;
  if (item.type === 'variants' || sizeChildren(item, rows).length > 0) return true;
  const g = optionGroupIdsFor(item, rows);
  return g.mod.length > 0 || g.inst.length > 0;
}

// Must the guest finish the sheet before this dish counts as chosen? True
// when a size must be picked, an instruction group is required, or a
// modifier group has a minimum. groupMin is { groupId: min } for the groups
// that loaded; without it modifier minimums are unknown and do not block.
export function itemNeedsSheetReturn(item, rows, { groupMin = null, instDefs = [] } = {}) {
  if (!itemHasOptions(item, rows)) return false;
  if (sizeChildren(item, rows).length > 0) return true;
  if (requiredInstructionGroups(item, rows, instDefs).length > 0) return true;
  if (!groupMin) return false;
  return optionGroupIdsFor(item, rows).mod.some((id) => num(groupMin[id]) >= 1);
}

// A pick that came back from the sheet, or one saved with options on it.
// With the dish's menu row, every required instruction group (on the picked
// size, else the dish) must also be answered, so a saved pick with a sauce
// but no cooking temperature never counts as chosen.
export function choiceConfigured(choice, { item = null, rows = [], instDefs = [] } = {}) {
  if (!choice) return false;
  const touched = choice.configured === true
    || (Array.isArray(choice.mods) && choice.mods.length > 0)
    || !!choice.variantItemId;
  if (!touched) return false;
  if (!item) return true;
  const size = choice.variantItemId
    ? sizeChildren(item, rows).find((r) => String(r.id) === String(choice.variantItemId)) || null
    : null;
  return missingInstructionGroups({ item: size || item, rows, instDefs, mods: choice.mods }).length === 0;
}

// Which package choice option a submitted pick belongs to. The course the
// page sends plus the option name wins, then the name, then the menu item, so
// the same dish offered in two courses lands in the right one. An older page
// sends only the name and matches exactly as before.
//   groups  [{ course, options: [{ name, itemId, ... }] }]
// Returns { g, opt } or null.
export function matchChoice(groups, r) {
  const list = Array.isArray(groups) ? groups : [];
  const name = String(r?.name || r?.displayName || '');
  const itemId = r?.itemId ? String(r.itemId) : '';
  const course = r?.course === undefined || r?.course === null || r?.course === '' ? null : Number(r.course);
  const find = (test) => {
    for (const g of list) for (const o of (Array.isArray(g?.options) ? g.options : [])) if (test(g, o)) return { g, opt: o };
    return null;
  };
  return (course !== null && name ? find((g, o) => Number(g.course) === course && String(o.name) === name) : null)
    || (name ? find((_g, o) => String(o.name) === name) : null)
    || (itemId ? find((_g, o) => !!o.itemId && String(o.itemId) === itemId) : null);
}

// The option surcharges on a pick (prices already include any quantity).
export function modsExtra(mods) {
  return round2((Array.isArray(mods) ? mods : []).reduce((s, m) => s + num(m?.price), 0));
}

// "12oz, Medium rare, Peppercorn sauce": the size, then every option, in order.
export function choiceSummary(choice) {
  if (!choice) return '';
  const parts = [choice.variantName || null];
  for (const m of Array.isArray(choice.mods) ? choice.mods : []) parts.push(m?.label || m?.name || null);
  return parts.filter(Boolean).join(', ');
}

// SERVER VALIDATION. Keep only what really exists on this dish, restamp every
// price from the database, cap the list.
//   lineItemId     the package line's menu item (the dish)
//   variantItemId  a size the guest picked: kept only when it is a live size of the dish
//   mods           what the page sent
//   rows           the venue's menu_items (archived rows are ignored)
//   groups         modifier_groups rows reachable from the dish (sub-groups included)
//   instDefs       the config_pushes snapshot's instructionGroupDefs
// Returns { mods, variantItemId, variantName }. A free text line (no dish)
// can carry no options.
export function sanitiseChoice({ lineItemId, variantItemId, mods, rows, groups, instDefs } = {}) {
  const out = { mods: [], variantItemId: null, variantName: null };
  const menu = live(rows);
  const line = lineItemId ? menu.find((r) => String(r.id) === String(lineItemId)) : null;
  if (!line) return out;

  let item = line;
  if (variantItemId) {
    const size = sizeChildren(line, menu).find((r) => String(r.id) === String(variantItemId));
    if (size) {
      item = size;
      out.variantItemId = String(size.id);
      out.variantName = String(pick(size, 'menu_name', 'menuName') || size.name || '') || null;
    }
  }

  const ids = optionGroupIdsFor(item, menu);
  const byId = new Map((Array.isArray(groups) ? groups : []).filter((g) => g && g.id != null).map((g) => [String(g.id), g]));
  // The dish's modifier groups, then every sub-group their options open.
  const reach = [];
  const seen = new Set();
  const queue = [...ids.mod];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const g = byId.get(id);
    if (!g) continue;
    reach.push(g);
    for (const o of Array.isArray(g.options) ? g.options : []) {
      if (o?.subGroupId) queue.push(String(o.subGroupId));
    }
  }
  const defs = (Array.isArray(instDefs) ? instDefs : []).filter((d) => d && ids.inst.includes(String(d.id)));

  // An option's stock item: its explicit link, else a sold-alone sub-item of
  // the same name (the sheet's rule), so the daily count decrements at seat.
  const soldAlone = menu.filter((r) => r.type === 'subitem' && pick(r, 'sold_alone', 'soldAlone'));
  const linkOf = (o) => {
    const direct = o?.itemId || o?.item_id;
    if (direct) return String(direct);
    const key = norm(o?.name || o?.label);
    if (!key) return null;
    const hit = soldAlone.find((r) => [r.name, pick(r, 'menu_name', 'menuName'), pick(r, 'receipt_name', 'receiptName'), pick(r, 'kitchen_name', 'kitchenName')]
      .some((n) => norm(n) === key));
    return hit ? String(hit.id) : null;
  };
  const optName = (o) => String(o?.name || o?.label || '');

  for (const m of Array.isArray(mods) ? mods : []) {
    if (out.mods.length >= MAX_CHOICE_MODS) break;
    if (!m || typeof m !== 'object') continue;

    if (m._instruction) {
      const want = norm(m.label || m.name);
      if (!want) continue;
      const def = defs.find((d) => (m.id && String(m.id).startsWith(`ig-${d.id}-`))
        || (norm(d.name) && norm(d.name) === norm(m.groupLabel)));
      if (!def) continue;
      const label = (Array.isArray(def.options) ? def.options : [])
        .map((o) => (typeof o === 'string' ? o : (o?.label || o?.name)))
        .find((l) => l && norm(l) === want);
      if (!label) continue;
      out.mods.push({ id: `ig-${def.id}-${label}`, name: label, label, groupLabel: String(def.name || ''), price: 0, _instruction: true });
      continue;
    }

    const wantName = norm(m.name || m.label);
    let hit = null;
    if (m.id != null && m.id !== '') {
      for (const g of reach) {
        const o = (Array.isArray(g.options) ? g.options : []).find((x) => x?.id != null && String(x.id) === String(m.id));
        if (o) { hit = { g, o }; break; }
      }
    }
    if (!hit && wantName) {
      const byName = (g) => (Array.isArray(g.options) ? g.options : []).find((x) => x && norm(optName(x)) === wantName);
      const sameGroup = reach.find((g) => norm(g.name) && norm(g.name) === norm(m.groupLabel) && byName(g));
      const g = sameGroup || reach.find((gg) => byName(gg));
      if (g) hit = { g, o: byName(g) };
    }
    if (!hit) continue;

    const qty = Math.max(1, Math.min(MAX_MOD_QTY, Math.round(num(m.qty)) || 1));
    const name = optName(hit.o);
    out.mods.push({
      id: hit.o.id ?? null,
      name,
      label: qty > 1 ? `${name} ×${qty}` : name,
      itemId: linkOf(hit.o),
      groupLabel: String(hit.g.name || ''),
      price: round2(num(hit.o.price) * qty),
      ...(qty > 1 ? { qty } : {}),
    });
  }
  return out;
}
