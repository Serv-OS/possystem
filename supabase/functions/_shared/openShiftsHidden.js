// supabase/functions/_shared/openShiftsHidden.js
//
// 5.11.122: what the staff app says when the open shifts list is empty. Peter tested open shifts at
// Provo on 28 Oct 2026: three open shifts existed, all hidden from William (two for a bartender, one
// already started), and the app said "Nothing up for grabs", which read as "there are no open shifts".
// The server now counts the shifts it hid by reason, and the app says so.
//
// Pure, shared by the staff-portal function (counts) and the staff app (words), tested in
// src/lib/openShiftsHidden.test.js.

/** Count open (unassigned) shifts hidden by reason. role: per position label; past: already started. */
export function countHidden(entries) {
  const role = {};
  let past = 0, other = 0;
  for (const e of entries || []) {
    const code = e && e.code;
    if (code === 'role') {
      const label = (e.role || '').trim() || 'someone in another position';
      role[label] = (role[label] || 0) + 1;
    } else if (code === 'past') past += 1;
    else if (code) other += 1;
  }
  return { role, past, other };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const lower = (s) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const joinList = (parts) => parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

/** The empty state sentence(s). hidden = countHidden() result (or null when the server is older). */
export function openShiftsEmptyWords(hidden) {
  const h = hidden || { role: {}, past: 0, other: 0 };
  const roles = Object.entries(h.role || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const parts = [];
  if (roles.length) {
    const total = roles.reduce((n, [, c]) => n + c, 0);
    const needs = joinList(roles.map(([label, c]) => `${c === total ? '' : `${c} `}${lower(label)}`.trim()));
    const who = /^(someone|\d)/.test(needs) ? needs : `a ${needs}`;
    parts.push(total === 1
      ? `1 open shift needs ${who}, not your position.`
      : `${total} open shifts need ${who}, not your position.`);
  }
  if (h.past > 0) parts.push(`${plural(h.past, 'open shift has', 'open shifts have')} already started.`);
  if (!parts.length) return 'Nothing up for grabs in the next three weeks.';
  return parts.join(' ');
}
