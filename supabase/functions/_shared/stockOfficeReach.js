/**
 * _shared/stockOfficeReach.js: may this signed in Back Office user act for this Ops venue? (v5.11.79)
 *
 * The SAME answer as the database's user_accessible_locations() (20260921u): a user_locations link
 * to the venue, a super admin, or the OWNER of the venue's company (user_profiles.role 'owner' with
 * the venue's org_id), who holds every venue of the company with no link row. Never an anonymous
 * session (a till, a kiosk, an online customer).
 *
 * WHY (multi site stock plan, 18 Oct 2026, 4.9 and Appendix D): po-send (email a purchase order)
 * and xero-bills (push a supplier bill to Xero) checked only the direct link rows, so an owner who
 * reaches a site through the owner rule was refused with "not authorized" on the PO email and the
 * Xero bill, while every other Back Office screen let them in.
 *
 * v5.11.84 (multi site stock Drop 0, plan 6.2): TWO answers, never one.
 *   officeReachesVenue        unchanged: link, super admin, owner of the venue's company. Used for
 *                             everything that is not stock (timesheets, time off, sales, staff).
 *   stockOfficeReachesVenue   the same, plus a login whose Stock control is 'all' in the venue's
 *                             own company (user_profiles.stock_control 'all' and profile org_id =
 *                             the venue's org), the database's stock_reach_locations(). Used ONLY
 *                             for stock work: po-send, xero-bills, manager-approve po.raise,
 *                             po.receive and stock.*, and the stock blocks of manager-snapshot.
 * A Stock control 'all' login therefore never gains timesheets, time off or sales at a site it is
 * not linked to. The level belongs to the login's own company only: a login linked into a second
 * company is never 'all' there.
 *
 * PURE: no imports, so node tests load it and the edge functions import it under Deno. The two
 * read helpers take the service role client as an argument.
 *
 * @param {{ user: { id?: string, is_anonymous?: boolean } | null, profile: { role?: string, org_id?: string } | null,
 *           linked: boolean, venueOrgId: string | null }} facts
 * @returns {{ ok: boolean, via: 'link' | 'super_admin' | 'owner' | null }}
 */
export function officeReachesVenue({ user = null, profile = null, linked = false, venueOrgId = null } = {}) {
  if (!user || !user.id || user.is_anonymous === true) return { ok: false, via: null };
  if (linked) return { ok: true, via: 'link' };
  if (profile && profile.role === 'super_admin') return { ok: true, via: 'super_admin' };
  if (profile && profile.role === 'owner' && profile.org_id && venueOrgId && String(profile.org_id) === String(venueOrgId)) {
    return { ok: true, via: 'owner' };
  }
  return { ok: false, via: null };
}

/** The stored Stock control levels (null on the profile means 'sites'). */
export const STOCK_CONTROL_LEVELS = Object.freeze(['sites', 'sites_full', 'all']);

/**
 * Stock reach: officeReachesVenue, plus Stock control 'all' in the venue's own company.
 * @param {{ user: { id?: string, is_anonymous?: boolean } | null,
 *           profile: { role?: string, org_id?: string, stock_control?: string | null } | null,
 *           linked: boolean, venueOrgId: string | null }} facts
 * @returns {{ ok: boolean, via: 'link' | 'super_admin' | 'owner' | 'stock_control' | null }}
 */
export function stockOfficeReachesVenue(facts = {}) {
  const base = officeReachesVenue(facts);
  if (base.ok) return base;
  const { user = null, profile = null, venueOrgId = null } = facts || {};
  if (!user || !user.id || user.is_anonymous === true) return { ok: false, via: null };
  if (profile && profile.stock_control === 'all' && profile.org_id && venueOrgId && String(profile.org_id) === String(venueOrgId)) {
    return { ok: true, via: 'stock_control' };
  }
  return { ok: false, via: null };
}

// A column the Drop 0 migration (20261021a) adds is not there yet: PostgREST 42703 or its words.
export function isMissingColumn(error, column) {
  if (!error) return false;
  const code = String(error.code || '');
  const msg = String(error.message || error || '');
  if (column && !msg.includes(column)) return false;
  return code === '42703' || /column .* does not exist|could not find the .* column/i.test(msg);
}

/**
 * The profile facts the reach rules read, with the service role client. stock_control comes with
 * 20261021a: before that migration the column is missing, so the read falls back to role and
 * org_id and the login is simply never 'all' (nobody is refused who passes today).
 * @returns {Promise<{ role?: string, org_id?: string, stock_control?: string | null } | null>}
 */
export async function readReachProfile(sb, userId) {
  if (!sb || !userId) return null;
  const first = await sb.from('user_profiles').select('role, org_id, stock_control').eq('id', userId).maybeSingle();
  if (!first?.error) return first?.data || null;
  if (!isMissingColumn(first.error, 'stock_control')) return null;
  const again = await sb.from('user_profiles').select('role, org_id').eq('id', userId).maybeSingle();
  return again?.error ? null : (again?.data || null);
}

/**
 * Every fact both rules need for one signed in user at one venue, read with the service role
 * client: the link row, the profile (with stock_control when the column exists) and the venue's
 * company. An anonymous or missing user reads nothing.
 * @returns {Promise<{ user: any, profile: any, linked: boolean, venueOrgId: string | null }>}
 */
export async function readOfficeReachFacts(sb, user, loc) {
  if (!user || !user.id || user.is_anonymous === true || !loc) return { user: user || null, profile: null, linked: false, venueOrgId: null };
  const [{ data: ul }, profile, { data: venue }] = await Promise.all([
    sb.from('user_locations').select('location_id').eq('user_id', user.id).eq('location_id', loc).maybeSingle(),
    readReachProfile(sb, user.id),
    sb.from('locations').select('org_id').eq('id', loc).maybeSingle(),
  ]);
  return { user, profile: profile || null, linked: !!ul, venueOrgId: venue?.org_id || null };
}
