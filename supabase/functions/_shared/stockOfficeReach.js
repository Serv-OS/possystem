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
 * PURE: no imports, so node tests load it and both edge functions import it under Deno.
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
