// supabase/functions/_shared/msmAccess.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): who may open it and who may run a publish. Pure,
// tested (src/lib/msm/msmAccess.test.js).
//
// THE SCREEN (Back Office): only people ServOS added by name, while the company is switched on.
// Owners and ServOS staff do NOT get in automatically. Everyone else sees nothing: no sidebar entry,
// and the route is refused. A missing table or function means "not installed" (the migration has
// not run): hidden. ANY other failure: hidden too (fail closed). A screen lock, said plainly; the
// database checks every read and write itself (row level security and the functions).
//
// THE SERVER (msm-publish): the pg_cron job proves itself with the vault key (x-cron-key, checked
// by public.msm_cron_ok, so the key is never copied anywhere); the service role may call it; a
// person may only start a publish their own sign in already froze (public.msm_publish_now checked
// they are an editor with the second step), and the function asks the database again as them.
// Unlike booking-reminders there is NO "before the migration" opening: without the check function
// nothing runs (fail closed; a new feature has nothing to keep working).

export const NOT_INSTALLED_CODES = Object.freeze(['42P01', 'PGRST205', 'PGRST202', '42883']);

export function isNotInstalled(error) {
  if (!error) return false;
  const code = String(error.code || '');
  const msg = String(error.message || '');
  return NOT_INSTALLED_CODES.includes(code) || /could not find the function|function .*does not exist|relation .*does not exist|schema cache/i.test(msg);
}

/**
 * What the Back Office may show, from rpc('msm_my_access').
 *   res      { data, error }
 *   orgId    the company the person works in (their profile's org), to pick when they are a
 *            member of more than one
 * Returns { installed, enabled, role, orgId, orgName, canOpen, canEdit, companies, reason }.
 */
export function accessFromRpc(res, orgId = null) {
  const none = (installed, reason) => ({ installed, enabled: false, role: null, orgId: null, orgName: null, canOpen: false, canEdit: false, companies: [], reason });
  if (!res) return none(false, 'no_answer');
  if (res.error) return isNotInstalled(res.error) ? none(false, 'not_installed') : none(true, 'read_failed');
  const list = Array.isArray(res.data?.companies) ? res.data.companies : [];
  const usable = list.filter((c) => c && c.enabled === true && (c.role === 'editor' || c.role === 'viewer'));
  const pick = usable.find((c) => orgId && c.org_id === orgId) || usable[0] || null;
  if (!pick) return { ...none(true, list.length ? 'switched_off' : 'not_a_member'), companies: list };
  return {
    installed: true, enabled: true, role: pick.role, orgId: pick.org_id, orgName: pick.org_name || null,
    canOpen: true, canEdit: pick.role === 'editor', companies: list, reason: null,
  };
}

/**
 * Who is calling msm-publish.
 *   service    the bearer is the function's own service role key
 *   key        x-cron-key header ('' when none)
 *   keyCheck   { data, error } from rpc('msm_cron_ok', { p_key }), or null when not asked
 *   user       { id, error } from auth.getUser(token), or null when not asked
 * Returns { ok, by: 'service_role' | 'cron_key' | 'user', reason }.
 */
export function callerAccess({ service = false, key = '', keyCheck = null, user = null } = {}) {
  if (service) return { ok: true, by: 'service_role', reason: null };
  if (key) {
    if (keyCheck?.error) return { ok: false, by: null, reason: 'cron_key_check_failed' };
    if (keyCheck?.data === true) return { ok: true, by: 'cron_key', reason: null };
    return { ok: false, by: null, reason: 'wrong_cron_key' };
  }
  if (user?.id && !user.error) return { ok: true, by: 'user', reason: null };
  return { ok: false, by: null, reason: 'not_signed_in' };
}
