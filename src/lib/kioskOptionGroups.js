/**
 * kioskOptionGroups.js: which option groups the kiosk item screen shows, and the selection
 * helpers it runs on them. KioskProductModal owns the item screen for BOTH kiosk designs
 * (today's modal and the new design's sheet), so both follow these rules.
 *
 * Pure: the only import is lib/menuRules.js (itself import free), so node:test can load it
 * (kioskOptionGroups.test.js). The group build needs normalizeGroup (kioskGroupRules.js) and
 * orderOptionFlow (optionFlow.js); the caller passes them in, and the tests pass the same two.
 * The rules themselves (which options a size shows, required, instruction min) are the shared
 * ones in lib/menuRules.js, the same functions the till's InlineItemFlow calls.
 *
 * SIZES AND GROUPS (the till's rule, src/components/InlineItemFlow.jsx, the flow the POS and
 * the bar run for every sized item)
 *   Options are set on the SIZES. When a size is picked the sheet shows THAT SIZE's own groups.
 *   Only when the size has none does it fall back to the parent's groups. Modifier groups and
 *   instruction groups decide this each on their own. As on the till, "has none" means none
 *   whose group still exists (a deleted group does not count). The option flow order is the
 *   parent's option_group_order, as on the till.
 *   Before v5.8.69 the kiosk read only the parent's groups, so a venue that set its options on
 *   the sizes (Pepsi Max: parent empty, both sizes carry "Soft Drinks Options") saw Size and
 *   nothing else, and a parent with old leftover groups (Latte) showed those instead.
 *
 * BEFORE A SIZE IS PICKED (kiosk timing; nothing is preselected)
 *   Only the groups EVERY offered size would show by the rule above. Whichever size the
 *   customer taps, those stay, so they show straight away and the sheet does not jump. A group
 *   only some sizes show appears once one of those sizes is picked. The Size group is required,
 *   so nothing can be added before a size is picked.
 *
 * The Size group itself always comes first.
 */

import { sizeOrMainOptions, instructionGroupMin } from './menuRules.js';

// ── Assignments ─────────────────────────────────────────────────────────────

/**
 * An item's modifier group assignments (assigned_modifier_groups) as [{ id, min, max }],
 * read exactly as KioskProductModal always read them: a plain id string has no overrides; an
 * object gives groupId (or id) plus optional min and max. Entries without an id are dropped.
 */
export function kioskModifierAssignments(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list) {
    if (typeof a === 'string') { if (a) out.push({ id: a, min: null, max: null }); continue; }
    if (!a || typeof a !== 'object') continue;
    const id = a.groupId || a.id;
    if (id) out.push({ id, min: a.min ?? null, max: a.max ?? null });
  }
  return out;
}

/**
 * An item's instruction group assignments (assigned_instruction_groups) as [{ id, min }]:
 * a plain id, or { groupId | id, min }. min is null when the assignment does not set one
 * (the group is then required, as before).
 */
export function kioskInstructionAssignments(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list) {
    if (typeof a === 'string') { if (a) out.push({ id: a, min: null }); continue; }
    if (!a || typeof a !== 'object') continue;
    const id = a.groupId || a.id;
    if (id) out.push({ id, min: a.min !== undefined ? a.min : null });
  }
  return out;
}

// One entry per group id, first place wins (the kiosk always showed a group once).
function uniqueById(list) {
  const out = [];
  const seen = new Set();
  for (const e of list) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

// Whether a group id still exists. known is a Set of ids, or null when the rows are not known
// yet (then every id counts, and the plan is worked out again once they are).
const existsIn = (known) => (id) => !known || known.has(id);

// The shared rule for ONE size (lib/menuRules.js rule 2, the till's InlineItemFlow): its own
// groups that still exist, else the main product's. Counting only groups that exist is what the
// till does (it builds the groups from the definitions it has before choosing).
function forSize(sizeList, parentList, exists) {
  const own = sizeList.filter(e => exists(e.id));
  return uniqueById(sizeOrMainOptions(own, parentList.filter(e => exists(e.id))));
}

// The groups every size's list carries, in the first size's order, with the first size's
// assignment. No sizes means nothing is shared.
function sharedBySizes(lists) {
  if (!lists.length) return [];
  return lists[0].filter(e => lists.slice(1).every(l => l.some(x => x.id === e.id)));
}

function flowOrderOf(row) {
  const o = row?.option_group_order ?? row?.optionGroupOrder;
  return Array.isArray(o) && o.length > 0 ? o : null;
}

function knownIds(groupRows, instructionDefs) {
  let mods = null;
  if (groupRows instanceof Map) mods = new Set(groupRows.keys());
  else if (groupRows && typeof groupRows === 'object') mods = new Set(Object.keys(groupRows));
  const inst = Array.isArray(instructionDefs)
    ? new Set(instructionDefs.filter(d => d && d.id != null).map(d => d.id))
    : null;
  return { mods, inst };
}

/**
 * Which groups to show and in what order, as assignments:
 *   { sizeId, modifiers: [{ id, min, max }], instructions: [{ id, min }], order }
 * parent           the item (a variant parent, or a plain item)
 * sizes            the sizes the sheet offers (live, not 86'd or sold out), in size order
 * pickedSizeId     the size the customer picked, or null. An id that is not one of the offered
 *                  sizes counts as no pick (sizeId comes back null).
 * groupRows        optional modifier_groups rows (Map or { id: row }) and instructionDefs the
 *                  instruction definitions: with them, a size whose groups were all deleted
 *                  falls back to the parent's, exactly as the till does.
 * A plain item (no sizes) gets exactly its own groups and its own order, as before.
 */
export function kioskOptionGroupPlan({ parent, sizes, pickedSizeId = null, groupRows = null, instructionDefs = null } = {}) {
  const offered = (Array.isArray(sizes) ? sizes : []).filter(s => s && s.id != null);
  const picked = pickedSizeId != null ? (offered.find(s => s.id === pickedSizeId) || null) : null;
  const parentMods = kioskModifierAssignments(parent?.assigned_modifier_groups);
  const parentInst = kioskInstructionAssignments(parent?.assigned_instruction_groups);
  const order = flowOrderOf(parent);
  if (!offered.length) {
    return { sizeId: null, modifiers: uniqueById(parentMods), instructions: uniqueById(parentInst), order };
  }
  const known = knownIds(groupRows, instructionDefs);
  const modsOf = (s) => forSize(kioskModifierAssignments(s.assigned_modifier_groups), parentMods, existsIn(known.mods));
  const instOf = (s) => forSize(kioskInstructionAssignments(s.assigned_instruction_groups), parentInst, existsIn(known.inst));
  if (picked) {
    return { sizeId: picked.id, modifiers: modsOf(picked), instructions: instOf(picked), order };
  }
  return {
    sizeId: null,
    modifiers: sharedBySizes(offered.map(modsOf)),
    instructions: sharedBySizes(offered.map(instOf)),
    order,
  };
}

/**
 * Every modifier group id the sheet may need for this item: the parent's and every offered
 * size's, without repeats. The sheet reads them all in ONE query when it opens, so picking or
 * changing a size never waits for a read (no loading flash, no reset of the picks).
 */
export function kioskSheetGroupIds(parent, sizes) {
  const out = [];
  const seen = new Set();
  const add = (list) => {
    for (const a of kioskModifierAssignments(list)) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a.id);
    }
  };
  add(parent?.assigned_modifier_groups);
  for (const s of (Array.isArray(sizes) ? sizes : [])) add(s?.assigned_modifier_groups);
  return out;
}

/** Every instruction group id the parent and the offered sizes use, without repeats. */
export function kioskSheetInstructionIds(parent, sizes) {
  const out = [];
  const seen = new Set();
  for (const row of [parent, ...(Array.isArray(sizes) ? sizes : [])]) {
    for (const a of kioskInstructionAssignments(row?.assigned_instruction_groups)) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a.id);
    }
  }
  return out;
}

// ── Groups ──────────────────────────────────────────────────────────────────

/**
 * The sheet's groups for a plan: the Size group first, then the modifier and instruction
 * groups in the option flow order. Built exactly as KioskProductModal built them before:
 *   modifier group: the modifier_groups row as it is (its own min and max), normalizeGroup'd.
 *                   A row that was not found is skipped.
 *   instruction group: id '__instr__' + def id, single choice, min from the assignment, else
 *                   the definition, else 0 (optional), max 1, one 0 priced option per label.
 *                   A missing def is skipped.
 * groupRows is a Map or a plain object of id to row. normalizeGroup and orderOptionFlow are
 * the functions from kioskGroupRules.js and optionFlow.js.
 */
export function kioskSheetGroups({ plan, sizeGroup = null, groupRows, instructionDefs, normalizeGroup, orderOptionFlow }) {
  const rowOf = (id) => (groupRows instanceof Map ? groupRows.get(id) : (groupRows ? groupRows[id] : undefined));
  const mods = [];
  for (const { id } of (plan?.modifiers || [])) {
    const g = rowOf(id);
    if (!g) continue;
    // The group's own min and max (lib/menuRules.js rule 3). A { min, max } copy saved on the
    // item is ignored, as on the till and in Back Office (Milk stays required).
    mods.push(normalizeGroup({ ...g }));
  }
  const defs = Array.isArray(instructionDefs) ? instructionDefs : [];
  const insts = [];
  for (const { id, min } of (plan?.instructions || [])) {
    const def = defs.find(d => d && d.id === id);
    if (!def) continue;
    insts.push(normalizeGroup({
      id: '__instr__' + def.id,
      name: def.name,
      selection_type: 'single',
      min: instructionGroupMin({ min }, def),   // lib/menuRules.js rule 4
      max: 1,
      __isInstructionGroup: true,
      options: (def.options || []).map((label, idx) => ({
        id: 'instr-' + def.id + '-' + idx,
        name: label,
        price: 0,
      })),
    }));
  }
  // Kiosk instruction group ids carry the '__instr__' prefix; the saved order stores RAW
  // group ids, so strip it when matching.
  const ordered = orderOptionFlow(plan?.order ?? null, mods, insts,
    (g) => String(g.id || '').replace('__instr__', '')).map(e => e.g);
  return sizeGroup ? [sizeGroup, ...ordered] : ordered;
}

// ── Keeping picks in step with the shown groups ─────────────────────────────

/**
 * The picks with every group that is no longer shown dropped, and within a shown group any
 * option id it no longer has. Returns the SAME object when nothing changes, so a caller can
 * run it after every groups change without a render loop.
 */
export function kioskPruneSelections(groups, selections) {
  const byId = new Map((Array.isArray(groups) ? groups : []).filter(Boolean).map(g => [g.id, g]));
  const src = selections || {};
  let changed = false;
  const next = {};
  for (const [gid, picks] of Object.entries(src)) {
    const g = byId.get(gid);
    if (!g) { changed = true; continue; }
    const list = Array.isArray(picks) ? picks : [];
    const ids = new Set((g.options || []).map(o => o && o.id));
    const kept = list.filter(id => ids.has(id));
    if (kept.length !== list.length || list !== picks) changed = true;
    next[gid] = kept;
  }
  return changed ? next : selections;
}

/**
 * The nested picks ('groupId:optionId:occurrence' keys) with every key whose group is no
 * longer shown, or whose option that group no longer has, dropped. Same object when nothing
 * changes.
 */
export function kioskPruneNestedSelections(groups, nestedSelections) {
  const byId = new Map((Array.isArray(groups) ? groups : []).filter(Boolean).map(g => [g.id, g]));
  const src = nestedSelections || {};
  let changed = false;
  const next = {};
  for (const [key, val] of Object.entries(src)) {
    const last = key.lastIndexOf(':');
    const mid = last > 0 ? key.lastIndexOf(':', last - 1) : -1;
    const gid = mid > 0 ? key.slice(0, mid) : null;
    const optId = mid > 0 ? key.slice(mid + 1, last) : null;
    const g = gid != null ? byId.get(gid) : null;
    if (!g || !(g.options || []).some(o => o && o.id === optId)) { changed = true; continue; }
    next[key] = val;
  }
  return changed ? next : nestedSelections;
}

// ── Selection helpers (moved WORD FOR WORD from KioskProductModal.jsx) ──────
// So the tests can prove a pick from a size's group reaches the order line, the price and
// the checks exactly like a pick from the parent's groups. Do not change them without
// checking the kiosk item screen.

// Walks all selected occurrences of options-with-subGroupId and returns
// the parent option occurrences that need a nested pick.
export function collectNestedOccurrences(groups, selections) {
  const out = [];
  for (const g of groups) {
    if (g.__isVariantGroup) continue;
    const picked = selections[g.id] || [];
    const occCounts = {};
    picked.forEach(optId => {
      const opt = (g.options || []).find(o => o.id === optId);
      if (!opt || !opt.subGroupId) return;
      const idx = occCounts[optId] || 0;
      occCounts[optId] = idx + 1;
      out.push({ groupId: g.id, optionId: optId, occurrenceIdx: idx, option: opt, parentGroup: g });
    });
  }
  return out;
}

export function validateSelections(groups, selections, nestedSelections, subGroupsCache) {
  // Top-level group min/max
  for (const g of groups) {
    const picked = selections[g.id] || [];
    if (picked.length < g._min) {
      return g._min === 1 ? 'Pick a ' + g.name : 'Pick at least ' + g._min + ' from ' + g.name;
    }
    if (picked.length > g._max) {
      return 'Too many in ' + g.name + ' (max ' + g._max + ')';
    }
  }
  // Nested sub-group min/max for each occurrence of an option with subGroupId
  const nested = collectNestedOccurrences(groups, selections);
  for (const n of nested) {
    const sub = subGroupsCache[n.option.subGroupId];
    if (!sub) continue; // sub-group not loaded — soft skip
    const key = n.groupId + ':' + n.optionId + ':' + n.occurrenceIdx;
    const subSel = (nestedSelections[key] && nestedSelections[key][sub.id]) || [];
    if (subSel.length < sub._min) {
      return sub._min === 1 ? 'Pick a ' + sub.name + ' for ' + n.option.name : 'Pick ' + sub._min + ' from ' + sub.name;
    }
    if (subSel.length > sub._max) {
      return 'Too many in ' + sub.name + ' (max ' + sub._max + ')';
    }
  }
  return null;
}

export function priceDelta(groups, selections, nestedSelections, subGroupsCache) {
  let delta = 0;
  for (const g of groups) {
    if (g.__isVariantGroup) continue;
    const picked = selections[g.id] || [];
    for (const optId of picked) {
      const opt = (g.options || []).find(o => o.id === optId);
      if (opt && typeof opt.price === 'number') delta += opt.price;
    }
  }
  // Nested option prices
  const nested = collectNestedOccurrences(groups, selections);
  for (const n of nested) {
    const sub = subGroupsCache[n.option.subGroupId];
    if (!sub) continue;
    const key = n.groupId + ':' + n.optionId + ':' + n.occurrenceIdx;
    const subSel = (nestedSelections[key] && nestedSelections[key][sub.id]) || [];
    for (const subOptId of subSel) {
      const subOpt = (sub.options || []).find(o => o.id === subOptId);
      if (subOpt && typeof subOpt.price === 'number') delta += subOpt.price;
    }
  }
  return delta;
}

export function buildModsArray(groups, selections, nestedSelections, subGroupsCache) {
  const mods = [];
  for (const g of groups) {
    if (g.__isVariantGroup) continue;
    const isInstrGroup = g.__isInstructionGroup;
    const picked = selections[g.id] || [];
    const occCounts = {};
    for (const optId of picked) {
      const opt = (g.options || []).find(o => o.id === optId);
      if (!opt) continue;
      mods.push({
        label: opt.name,
        price: typeof opt.price === 'number' ? opt.price : 0,
        groupLabel: g.name,
        ...(opt.itemId ? { itemId: opt.itemId } : {}),
        ...(isInstrGroup ? { _instruction: true } : {}),
      });
      // If this option has nested config, emit the nested picks tagged with parent
      if (opt.subGroupId) {
        const idx = occCounts[optId] || 0;
        occCounts[optId] = idx + 1;
        const sub = subGroupsCache[opt.subGroupId];
        if (sub) {
          const key = g.id + ':' + optId + ':' + idx;
          const subSel = (nestedSelections[key] && nestedSelections[key][sub.id]) || [];
          for (const subOptId of subSel) {
            const subOpt = (sub.options || []).find(o => o.id === subOptId);
            if (!subOpt) continue;
            mods.push({
              label: subOpt.name,
              price: typeof subOpt.price === 'number' ? subOpt.price : 0,
              groupLabel: opt.name + ' → ' + sub.name,
            });
          }
        }
      }
    }
  }
  return mods;
}

export function summarizeForDisplay(groups, selections, nestedSelections, subGroupsCache) {
  const parts = [];
  for (const g of groups) {
    const picked = selections[g.id] || [];
    if (picked.length === 0) continue;
    const counts = {};
    for (const id of picked) counts[id] = (counts[id] || 0) + 1;
    const labels = Object.entries(counts).map(([id, n]) => {
      const name = (g.options || []).find(o => o.id === id)?.name;
      if (!name) return null;
      return n > 1 ? (name + ' ×' + n) : name;
    }).filter(Boolean);
    if (labels.length > 0) parts.push(labels.join(', '));
  }
  // Append nested labels
  const nested = collectNestedOccurrences(groups, selections);
  for (const n of nested) {
    const sub = subGroupsCache[n.option.subGroupId];
    if (!sub) continue;
    const key = n.groupId + ':' + n.optionId + ':' + n.occurrenceIdx;
    const subSel = (nestedSelections[key] && nestedSelections[key][sub.id]) || [];
    const subNames = subSel.map(id => (sub.options || []).find(o => o.id === id)?.name).filter(Boolean);
    if (subNames.length > 0) parts.push(n.option.name + ': ' + subNames.join(', '));
  }
  return parts.join(' · ');
}

/**
 * The new item sheet's guidance for a NESTED choice, as a translation key: the same checks, in
 * the same order, as validateSelections' nested loop, whose English text ("Pick a Milk for
 * Latte") stays for today's modal. Top level groups are kioskSheetGroupHint's (kioskGroupRules).
 * Returns { key, vars: { group, option, n? } } or null.
 */
export function kioskSheetNestedHint(groups, selections, nestedSelections, subGroupsCache) {
  const nested = collectNestedOccurrences(Array.isArray(groups) ? groups : [], selections || {});
  for (const n of nested) {
    const sub = (subGroupsCache || {})[n.option.subGroupId];
    if (!sub) continue;
    const key = n.groupId + ':' + n.optionId + ':' + n.occurrenceIdx;
    const subSel = (nestedSelections && nestedSelections[key] && nestedSelections[key][sub.id]) || [];
    const vars = { group: String(sub.name ?? '').trim(), option: String(n.option.name ?? '').trim() };
    if (subSel.length < sub._min) {
      if (sub._min === 1 && sub._max === 1) return { key: 'k2.sheet.nestedPickOne', vars };
      if (sub._min === sub._max) return { key: 'k2.sheet.nestedPickExactly', vars: { ...vars, n: sub._min } };
      return { key: 'k2.sheet.nestedPickAtLeast', vars: { ...vars, n: sub._min } };
    }
    if (subSel.length > sub._max) return { key: 'k2.sheet.nestedPickTooMany', vars: { ...vars, n: sub._max } };
  }
  return null;
}
