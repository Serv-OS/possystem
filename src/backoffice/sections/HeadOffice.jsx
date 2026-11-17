// src/backoffice/sections/HeadOffice.jsx
//
// Head office (16 Nov 2026, Mozz Pizza's ask: a leadership hub for the company's directors).
// A Back Office section group, the Workforce shape: it receives { section, orgCtx } and switches
// on the sub route. Seven screens live in ./headoffice/:
//   hq-scorecard    the sites ranked by prime cost, the till's sales and the typed numbers
//   hq-departments  one tab per department with its figures and projects
//   hq-projects     internal projects, their tasks, phases and the update feed for the owner
//   hq-checkin      the weekly check in (owner reads every one, a director reads their own)
//   hq-numbers      the daily numbers the tills cannot know, typed or pasted
//   hq-safe         the site's safe and banking, fed by the till (nobody retypes a figure)
//   hq-targets      the red, amber, green bands the scorecard colours by (owner edits)
// Back Office only: nothing here reads or writes the till store. Every read goes through
// src/lib/hq/data.js, and a database without the hq_ tables shows one calm card per screen.
// Slice 2 (20261201a) adds the safe ledger, bank deposits, targets and the Operations figures.
// Those tables may not exist yet: the two new screens show the calm card, the others fall back.

import { useEffect, useMemo, useState } from 'react';
import { getAvailableLocations } from '../../lib/supabase';
import { getActiveCurrencyCode } from '../../lib/currency';
import { venueToday } from '../../lib/venueDates';
import { isEverythingRole } from '../../lib/boSections';
import HqScorecard from './headoffice/HqScorecard';
import HqDepartments from './headoffice/HqDepartments';
import HqProjects from './headoffice/HqProjects';
import HqCheckin from './headoffice/HqCheckin';
import HqNumbers from './headoffice/HqNumbers';
import HqSafe from './headoffice/HqSafe';
import HqTargets from './headoffice/HqTargets';
import { page, LoadingLine, localYmd } from './headoffice/hqUi';

/**
 * The hub's own context, built once from orgCtx and the sites this login can manage:
 *   orgId     the company the hub works in: the VENUE's company (locations.org_id, which is
 *             what every hq_ row carries), falling back to the login's own profile company
 *   sites     [{ id, name, org_id }] from getAvailableLocations, kept to that company when the
 *             rows carry org_id (a ServOS super admin can manage sites of many companies)
 *   today     today's date on the venue clock, 'YYYY-MM-DD'
 *   currency  the active venue's currency for group figures (each site's row carries its own)
 */
export function buildHqCtx(orgCtx, locations) {
  const orgId = orgCtx?.venueOrgId || orgCtx?.orgId || null;
  const all = Array.isArray(locations) ? locations.filter((l) => l?.id) : [];
  const carryOrg = all.some((l) => l.org_id);
  const mine = carryOrg && orgId ? all.filter((l) => l.org_id === orgId) : all;
  const sites = (mine.length ? mine : all).map((l) => ({ id: l.id, name: l.name || 'Site', org_id: l.org_id || null }));
  const currency = getActiveCurrencyCode();
  const today = venueToday(null, new Date()) || localYmd();
  return {
    orgId,
    sites,
    today,
    currency,
    userId: orgCtx?.userId || null,
    userName: orgCtx?.userName || null,
    role: orgCtx?.role || null,
    ownerRole: isEverythingRole(orgCtx?.role),
    locationId: orgCtx?.locationId || null,
  };
}

export default function HeadOffice({ section, orgCtx, setSection }) {
  const [locations, setLocations] = useState(null);

  useEffect(() => {
    let live = true;
    getAvailableLocations().then((rows) => { if (live) setLocations(rows || []); }).catch(() => { if (live) setLocations([]); });
    return () => { live = false; };
  }, [orgCtx?.userId, orgCtx?.locationId]);

  // One object per (login, sites) pair: the screens key their reads on hq.sites, so a rerender of
  // the app above must not hand them a fresh array and make them read again.
  const hq = useMemo(() => buildHqCtx(orgCtx, locations || []), [orgCtx, locations]);

  if (locations === null) return <div style={page}><LoadingLine>Loading</LoadingLine></div>;
  const go = typeof setSection === 'function' ? setSection : () => {};

  switch (section) {
    case 'hq-departments': return <HqDepartments hq={hq} go={go} />;
    case 'hq-projects': return <HqProjects hq={hq} go={go} />;
    case 'hq-checkin': return <HqCheckin hq={hq} go={go} />;
    case 'hq-numbers': return <HqNumbers hq={hq} go={go} />;
    case 'hq-safe': return <HqSafe hq={hq} go={go} />;
    case 'hq-targets': return <HqTargets hq={hq} go={go} />;
    case 'hq-scorecard':
    default: return <HqScorecard hq={hq} go={go} />;
  }
}
