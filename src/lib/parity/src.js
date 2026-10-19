// src/lib/parity/src.js: read the repo's source for the parity suite's wiring checks (v5.11.78).
//
// Money code that lives inside a screen (a .jsx surface) cannot be imported by node. The parity
// suite proves those screens call the ONE shared rule by reading their source, the repo's usual
// wiring style (menuRulesUsage.test.js, taxVenueWiring.test.js). Each check names the exact call,
// so a screen that grows its own copy of a rule fails here. PURE apart from fs.

import fs from 'node:fs';

const ROOT = new URL('../../../', import.meta.url);

/** The text of a repo file (path from the repo root, e.g. 'src/surfaces/BarSurface.jsx'). */
export const readRepo = (rel) => fs.readFileSync(new URL(rel, ROOT), 'utf8');

/** The text between two markers of a file (start included), for a check scoped to one function. */
export function between(text, start, end) {
  const i = text.indexOf(start);
  if (i < 0) return '';
  const j = end ? text.indexOf(end, i + start.length) : -1;
  return j > i ? text.slice(i, j) : text.slice(i);
}

/** Does the repo file exist (a new shared module on this branch, missing on main)? */
export const repoHas = (rel) => fs.existsSync(new URL(rel, ROOT));
