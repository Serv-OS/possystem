/**
 * sortTables — natural-order table comparator
 *
 * Sorts a tables array so the operator sees them the way they expect:
 *   - Section first (alphabetical, with no-section last)
 *   - Then label, natural-sorted (T1, T2, T9, T10 — not T1, T10, T2)
 *
 * Fixes the bug Peter reported in v5.5.13: send-to-table picker was
 * showing tables in whatever order the store happened to have them
 * (Supabase result order, mutation order, etc) — never sorted on
 * display. Same pattern was in OrderTypeModal, TableActionsModal,
 * SendWithoutTableModal — anywhere a table picker renders.
 *
 * Returns a NEW array; doesn't mutate the input.
 *
 * Uses Intl.Collator with numeric:true for natural sort. localeCompare
 * with numeric:true on individual strings would also work but Collator
 * is faster when the same comparator is reused across array sorts.
 */

const _collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortTables(tables) {
  return [...(tables || [])].sort((a, b) => {
    // Section first — push tables with no section to the end so they
    // don't interleave between sectioned ones.
    const sa = a.section || '\uFFFF'; // U+FFFF sorts after all real strings
    const sb = b.section || '\uFFFF';
    const secCmp = _collator.compare(sa, sb);
    if (secCmp !== 0) return secCmp;
    return _collator.compare(a.label || '', b.label || '');
  });
}
