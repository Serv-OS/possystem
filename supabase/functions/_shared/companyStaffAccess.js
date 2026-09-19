// supabase/functions/_shared/companyStaffAccess.js
//
// Database fence stage 1, contract P3: is this signed in user Back Office staff of this COMPANY?
// "Any JWT" is not authority (memory reference_edge_fn_any_jwt_authority): anybody holding the
// public key can sign in anonymously.
//
// The rule mirrors the fenced public.user_accessible_locations() (file 20260919a): the login's
// user_locations rows, or every venue for a verified super admin. user_profiles.location_id is
// NOT access (it was writable by the login itself). On top, the arm the gift and loyalty
// functions have always honoured: a Platform user_company_roles row for the company, so an
// owner set up at company level is not locked out.
//
// Pure: no Deno, no Supabase. Tested from src/lib/companyStaffAccess.test.js.

/**
 * @param {object} f
 * @param {{id?: string, is_anonymous?: boolean}|null} f.user
 * @param {string|null} f.role                     user_profiles.role
 * @param {string[]}    f.userLocationIds          the login's user_locations (Ops ids)
 * @param {string[]}    f.companyOpsLocationIds    every Ops id of the company's venues
 * @param {string[]}    f.companyRoleCompanyIds    Platform user_company_roles company ids
 * @param {string|null} f.companyId
 * @returns {{ok: boolean, via: 'super_admin'|'user_locations'|'company_role'|null}}
 */
export function decideCompanyStaff(f = {}) {
  const no = { ok: false, via: null };
  const user = f.user || null;
  if (!user || !user.id || user.is_anonymous) return no;
  if (f.role === 'super_admin') return { ok: true, via: 'super_admin' };
  if (!f.companyId) return no;
  const mine = new Set((f.userLocationIds || []).filter(Boolean).map(String));
  if ((f.companyOpsLocationIds || []).filter(Boolean).map(String).some((id) => mine.has(id))) {
    return { ok: true, via: 'user_locations' };
  }
  if ((f.companyRoleCompanyIds || []).map(String).includes(String(f.companyId))) return { ok: true, via: 'company_role' };
  return no;
}

/** The columns the Back Office purchases list shows. Never fulfilled_code (a spendable code). */
export const PURCHASE_LIST_COLUMNS = 'id, amount_minor, currency, sender_name, sender_email, recipient_name, recipient_email, delivery_type, status, code_last4, created_at, fulfilled_at';
