// src/staff/peopleAcrossSites.js: one person, many sites (5.12.36). Pure, no imports: node --test.
//
// Workforce keeps one staff record per site (the site's role, rate, rota and timesheets) and links
// the records of one person with wf_staff.person_id (20261111a). The Back Office Sites panel on a
// staff profile lists the person's other sites, adds one ("Also works at") and links records that
// were made by hand at two sites. These are the rules it shows.

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);

/**
 * The person's other sites: their linked records anywhere but this one, leavers last.
 * records: wf_staff rows ({ id, location_id, person_id, role_key, rate_override, status, name }).
 */
export function otherSites(me, records, locationNames = {}) {
  if (!me?.personId) return [];
  return (records || [])
    .filter((r) => r && r.person_id === me.personId && r.id !== me.id)
    .map((r) => ({
      staffId: r.id, locationId: r.location_id, site: locationNames[r.location_id] || 'Another site',
      role: r.role_key || null, rate: r.rate_override != null ? Number(r.rate_override) : null,
      leaver: r.status === 'leaver',
    }))
    .sort((a, b) => Number(a.leaver) - Number(b.leaver) || a.site.localeCompare(b.site));
}

/**
 * Records at the company's other sites that look like the same person: the same name, the same email
 * or the same mobile, not a leaver, at a site this person is not already at, not already linked to
 * them. The manager confirms; nothing links on a guess.
 */
export function linkCandidates(me, records, locationNames = {}) {
  if (!me) return [];
  const myName = norm(me.name), myEmail = norm(me.email), myPhone = digits(me.mobile);
  const mySites = new Set([me.locationId]);
  for (const r of records || []) if (me.personId && r.person_id === me.personId) mySites.add(r.location_id);
  const out = [];
  for (const r of records || []) {
    if (!r || r.id === me.id || r.status === 'leaver' || mySites.has(r.location_id)) continue;
    if (me.personId && r.person_id === me.personId) continue;
    const why = [];
    if (myName && norm(r.name) === myName) why.push('same name');
    if (myEmail && norm(r.email) === myEmail) why.push('same email');
    if (myPhone.length >= 7 && digits(r.mobile) === myPhone) why.push('same mobile');
    if (!why.length) continue;
    out.push({ staffId: r.id, locationId: r.location_id, site: locationNames[r.location_id] || 'Another site', name: r.name, why: why.join(', '), linkedElsewhere: !!r.person_id });
  }
  return out.sort((a, b) => b.why.split(',').length - a.why.split(',').length || a.site.localeCompare(b.site));
}

/** Sites the person could be added at: the company's sites they have no live record at. */
export function sitesToAdd(me, records, sites) {
  const taken = new Set([me?.locationId]);
  for (const r of records || []) if (me?.personId && r.person_id === me.personId && r.status !== 'leaver') taken.add(r.location_id);
  return (sites || []).filter((s) => s && !taken.has(s.id)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** Till user rows (staff_members) as these rules read records: switched off reads as a leaver. */
export function asTillRecords(rows) {
  return (rows || []).filter((r) => r && r.location_id).map((r) => ({
    id: r.id, name: r.name, location_id: r.location_id, person_id: r.person_id || null,
    status: r.active === false ? 'leaver' : 'active',
  }));
}

/** The server's refusal in words for the panel (the SQL already says most of it). */
export function linkErrorWords(err) {
  const m = String(err?.message || err || '');
  const code = String(err?.code || '');
  if (code === 'PGRST202' || code === '42883' || /function .*wf_(staff|till)_(add_site|link|unlink).* does not exist|Could not find the function/i.test(m)) {
    return 'Linking sites needs a database update first. Ask your ServOS contact to run release 5.12.36.';
  }
  if (/every site/i.test(m)) return 'You need access to both sites to do that. Ask an owner.';
  if (/second sign in step/i.test(m)) return 'Finish your second sign in step first.';
  if (/already used by/i.test(m)) return m.replace(/\s+\./g, '.');
  if (/already work at that site|two records at one site/i.test(m)) return 'They already have a record at that site. Link it instead of adding a new one.';
  return m || 'That did not save. Try again.';
}
