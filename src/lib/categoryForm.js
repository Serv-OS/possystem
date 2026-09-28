// src/lib/categoryForm.js: the category editor's form, and the edit it saves.
//
// 27 Sep 2026, Peter: "I archived choc babychino but its still on the menu board". The category
// editor (MenuManager CatModal) copies seven fields into its form when it opens, and Save used to
// send ALL seven as the edit. Every field went back to what the window had when the editor
// opened, so a window that renamed a category put back the tax profile another window had set
// meanwhile (the Leeds tax incident again, for categories), or was refused over a field the
// person never touched.
//
// Now Save sends only the fields the person changed in the form (categoryFormPatch), and the
// writer compares them against the values the form OPENED with (store updateCategory opts.opened,
// lib/menuWriters.js), so a field changed elsewhere since the editor opened is refused in plain
// words and never silently overwritten. Pure.

import { sameValue } from './menuItemWrite.js';

/** The form as the editor opens it, from the category row (store shape). */
export function categoryFormOf(cat) {
  return {
    label: cat?.label ?? '',
    icon: cat?.icon || '🍽',
    color: cat?.color || '#3b82f6',
    parentId: cat?.parentId || '',
    accountingGroup: cat?.accountingGroup || '',
    defaultCourse: cat?.defaultCourse ?? 1,
    taxProfileId: cat?.taxProfileId || '',
  };
}

// The pickers use '' for "none"; the row holds null.
const NULLABLE = new Set(['parentId', 'taxProfileId']);
const saved = (k, v) => (NULLABLE.has(k) ? (v || null) : v);

/**
 * The edit to save: ONLY the fields that differ from what the form opened with, in the row's
 * shape ('' becomes null for the parent and the tax profile). {} when nothing changed.
 */
export function categoryFormPatch(opened, form) {
  const out = {};
  for (const k of Object.keys(form || {})) {
    const now = saved(k, form[k]);
    if (!sameValue(saved(k, opened ? opened[k] : undefined), now)) out[k] = now;
  }
  return out;
}
