// src/staff/reinstate.js (5.12.89): is this person already on the system? Pure, no imports: node --test.
//
// WHY (Peter, 23 Nov 2026: "if we have a history tab we need a way to reinstate someone and if they
// are already on that company/locations system, it needs to say so and do a reinstatement"). Add
// staff member used to make a second record for someone who had left and come back, so their
// documents, timesheets and holiday record sat on an archived record nobody could see.
//
// records: the company's wf_staff rows ({ id, name, email, mobile, location_id, status, leaver_date }).
// A match is the same email, the same mobile or the same name. The manager always decides: a shared
// name can be two people.

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);

function whyMatch(form, r) {
  const why = [];
  const email = norm(form.email), phone = digits(form.mobile), name = norm(form.name);
  if (email && norm(r.email) === email) why.push('same email');
  if (phone.length >= 7 && digits(r.mobile) === phone) why.push('same mobile');
  if (name && norm(r.name) === name) why.push('same name');
  return why;
}

/**
 * Who on the system looks like the person being added.
 * Returns { hereLeaver, hereActive, elsewhere: [] }: the best match at this site as a leaver, the
 * best match at this site still on the team, and matches at the company's other sites.
 * Each match: { id, name, locationId, site, leaver, leftOn, why }.
 */
export function existingMatches(form, records, locationId, locationNames = {}) {
  const out = { hereLeaver: null, hereActive: null, elsewhere: [] };
  if (!form) return out;
  const rows = [];
  for (const r of records || []) {
    if (!r || (form.id && r.id === form.id)) continue;
    const why = whyMatch(form, r);
    if (!why.length) continue;
    rows.push({
      id: r.id, name: r.name, locationId: r.location_id, site: locationNames[r.location_id] || 'Another site',
      leaver: r.status === 'leaver', leftOn: r.leaver_date || null, why: why.join(', '), strength: why.length,
    });
  }
  // Strongest first (email and mobile beat a name alone), newest leaver first.
  rows.sort((a, b) => b.strength - a.strength || String(b.leftOn || '').localeCompare(String(a.leftOn || '')));
  for (const m of rows) {
    if (m.locationId === locationId) {
      if (m.leaver && !out.hereLeaver) out.hereLeaver = m;
      if (!m.leaver && !out.hereActive) out.hereActive = m;
    } else out.elsewhere.push(m);
  }
  return out;
}

/** Is there anything to tell the manager before the record is made? */
export function hasMatch(found) {
  return !!(found && (found.hereLeaver || found.hereActive || (found.elsewhere && found.elsewhere.length)));
}

/** The toast after a reinstatement, from the server's answer ({ till }). */
export function reinstatedWords(name, answer = {}) {
  const who = name || 'They';
  const till = answer.till === 'restored' ? ' Their till PIN works again.'
    : answer.till === 'pin_taken' ? ' Their old till PIN now belongs to someone else: give them a new one on the Team page.'
    : answer.till === 'none' ? ' They have no till access yet.' : '';
  return `${who} is back on the team.${till} Back Office access is not given back: add it on the Team page if they need it.`;
}
