// src/lib/optionAnswers.js
//
// THE POS OPTION FLOW'S ANSWERS, AS A SMALL RECORD THAT CAN OPEN THE FLOW AGAIN (5.12.123).
//
// A pick inside a Combo can be changed after it was picked ("each pick can still be changed",
// Peter's Combo brief). The POS option flow (components/InlineItemFlow.jsx) always opened blank:
// fine for a line that has no options yet (a booking's pre order), but a pizza already carrying
// Extra cheese and No basil would lose them the moment somebody opened it to add an allergy note.
// So the flow hands back a record of what was answered, and takes one to start from:
//
//   { v: sizeId, s: { [groupId]: { one: optionId } | { many: [optionId, ...] } | { qty: { [optionId]: n } } },
//     i: { [instructionGroupId]: 'Medium rare' }, n: 'the note' }
//
// Ids only: prices and names are read from the venue's groups again when the flow opens, so an
// option that was repriced shows its price today, and one that has gone is simply not ticked.
//
// PURE: no imports. InlineItemFlow keeps its own state shapes; these two functions translate.

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** The id the flow knows an option by (its own id, else its label or name). */
export const optionKey = (opt) => (opt && (opt.id || opt.label || opt.name)) || null;
// A quantity group's selection is { optionId: qty }; a single choice is the option object itself.
const isQtyMap = (v) => isObj(v) && Object.keys(v).length > 0 && Object.values(v).every((n) => typeof n === 'number');

/** The record of a flow's answers. Empty parts are left out; nothing answered gives null. */
export function answersFromFlow({ variantId = null, selections = {}, instSelections = {}, notes = '' } = {}) {
  const s = {};
  for (const [gid, val] of Object.entries(selections || {})) {
    if (!val) continue;
    if (Array.isArray(val)) {
      const ids = val.map(optionKey).filter(Boolean);
      if (ids.length) s[gid] = { many: ids };
    } else if (isQtyMap(val)) {
      const q = Object.fromEntries(Object.entries(val).filter(([, n]) => n > 0));
      if (Object.keys(q).length) s[gid] = { qty: q };
    } else if (isObj(val) && optionKey(val)) {
      s[gid] = { one: optionKey(val) };
    }
  }
  const i = Object.fromEntries(Object.entries(instSelections || {}).filter(([, v]) => typeof v === 'string' && v));
  const out = {};
  if (variantId) out.v = variantId;
  if (Object.keys(s).length) out.s = s;
  if (Object.keys(i).length) out.i = i;
  if (String(notes || '').trim()) out.n = String(notes).trim();
  return Object.keys(out).length ? out : null;
}

/**
 * The record with its note set to what the LINE holds now. A note can be changed on the order
 * panel after the flow closed (the Note button writes the line, not this record), so the line's
 * note is the truth: Change must open with it, and must never bring an older one back or wipe it.
 * Returns null when nothing is left to remember.
 */
export function answersWithNote(answers, note) {
  const n = String(note || '').trim();
  const out = isObj(answers) ? { ...answers } : {};
  if (n) out.n = n; else delete out.n;
  return Object.keys(out).length ? out : null;
}

/**
 * The flow's own state from a record: { variantId, selections, instSelections, notes }.
 *   groupDefs   the venue's option groups ([{ id, options }]): an answer whose group or option has
 *               gone is left out, so the flow asks again where it must
 *   instDefs    the instruction groups ([{ id, options: ['Rare', ...] }])
 *   uid         () => a unique tag for each pick of a "several choices" group
 */
export function flowFromAnswers(answers, groupDefs = [], instDefs = [], uid = () => Date.now() + Math.random()) {
  const out = { variantId: null, selections: {}, instSelections: {}, notes: '' };
  if (!isObj(answers)) return out;
  if (answers.v) out.variantId = answers.v;
  if (typeof answers.n === 'string') out.notes = answers.n;
  const groups = new Map((Array.isArray(groupDefs) ? groupDefs : []).filter(Boolean).map((g) => [String(g.id), g]));
  for (const [gid, a] of Object.entries(isObj(answers.s) ? answers.s : {})) {
    const def = groups.get(String(gid));
    if (!def || !isObj(a)) continue;
    const find = (id) => (Array.isArray(def.options) ? def.options : []).find((o) => optionKey(o) === id) || null;
    const shaped = (opt) => { const id = optionKey(opt); return { ...opt, id, label: opt.name || opt.label || id }; };
    // The answer as the GROUP IS TODAY (the option flow's own rule: a quantity group holds counts,
    // a group with "up to" more than 1 holds a list, any other one choice). A group changed in the
    // Back Office since the answer was given (one choice made several, say) gets the same choices
    // in its new shape, so the flow opens and never meets a shape it cannot read.
    const picked = [];
    if (a.one != null) picked.push(a.one);
    else if (Array.isArray(a.many)) picked.push(...a.many);
    else if (isObj(a.qty)) for (const [id, n] of Object.entries(a.qty)) for (let k = 0; k < Math.min(99, Math.floor(Number(n) || 0)); k++) picked.push(id);
    const opts = picked.map(find).filter(Boolean);
    if (!opts.length) continue;
    // InlineItemFlow: maxPicks = max 99 or more, or none, is unlimited; "several" when it is over 1.
    const max = Number(def.max) >= 99 || !Number(def.max) ? 999 : Number(def.max);
    const kind = def.selectionType ?? def.selection_type ?? null;
    if (kind === 'quantity') {
      const q = {};
      for (const opt of opts.slice(0, max)) q[optionKey(opt)] = (q[optionKey(opt)] || 0) + 1;
      out.selections[gid] = q;
    } else if (max > 1) {
      // Each option once in a "once each" group (5.12.112); otherwise the same option may repeat.
      const once = kind === 'multiple_once';
      const seen = new Set();
      const list = [];
      for (const opt of opts) { const id = optionKey(opt); if (once && seen.has(id)) continue; seen.add(id); list.push({ ...shaped(opt), _uid: uid() }); }
      out.selections[gid] = list.slice(0, max);
    } else {
      out.selections[gid] = shaped(opts[0]);
    }
  }
  const insts = new Map((Array.isArray(instDefs) ? instDefs : []).filter(Boolean).map((g) => [String(g.id), g]));
  for (const [gid, val] of Object.entries(isObj(answers.i) ? answers.i : {})) {
    const def = insts.get(String(gid));
    if (def && Array.isArray(def.options) && def.options.includes(val)) out.instSelections[gid] = val;
  }
  return out;
}
