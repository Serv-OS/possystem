// supabase/functions/_shared/authUserLookup.js
//
// 5.11.123 (30 Oct 2026): find ONE auth user by email, whatever the size of auth.users.
//
// WHY: create-user paged through auth.admin.listUsers (20 pages x 200 = 4,000 users at most) to
// find an email that "already exists". Ops passed 6,000 users (mostly anonymous kiosk and online
// sessions), so an account made in July sat past the cap, the lookup found nothing and Peter saw
// the raw "A user with this email address has already been registered" with no account in sight
// (mickey at Next Flavour Kitchens, 30 Oct). GoTrue's admin users endpoint takes `filter`, which
// matches the email, so one request answers. The paging walk stays as the fallback.

const norm = (e) => String(e || '').trim().toLowerCase();

/** The URL GoTrue's admin users list answers at, with the email filter. */
export function adminUsersUrl(supabaseUrl, email, perPage = 50) {
  const u = new URL('/auth/v1/admin/users', supabaseUrl);
  u.searchParams.set('page', '1');
  u.searchParams.set('per_page', String(perPage));
  u.searchParams.set('filter', norm(email));
  return u.toString();
}

/** The exact email match out of a users list (the filter is a contains match). */
export function pickByEmail(users, email) {
  const want = norm(email);
  return (users || []).find((u) => norm(u?.email) === want) || null;
}

/**
 * Find the auth user with this email. fetchFn and listUsers are injected (tests).
 * Returns the user object or null. Never throws: a failed lookup is null.
 */
export async function findAuthUserByEmail({ supabaseUrl, serviceKey, email, fetchFn = globalThis.fetch, listUsers = null, maxPages = 20 }) {
  const want = norm(email);
  if (!want) return null;
  try {
    const r = await fetchFn(adminUsersUrl(supabaseUrl, want), {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (r.ok) {
      const body = await r.json();
      const hit = pickByEmail(body?.users || body || [], want);
      if (hit) return hit;
      // The filter said nobody: trust it when the answer is well formed.
      if (Array.isArray(body?.users)) return null;
    }
  } catch { /* fall through to the walk */ }
  if (!listUsers) return null;
  try {
    for (let page = 1; page <= maxPages; page++) {
      const { data: list } = await listUsers({ page, perPage: 200 });
      const hit = pickByEmail(list?.users, want);
      if (hit) return hit;
      if (!list || (list.users || []).length < 200) break;
    }
  } catch { /* unresolved */ }
  return null;
}
