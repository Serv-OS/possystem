// supabase/functions/_shared/xeroTokens.js
//
// Pure helpers for Xero token sets shared across venues (30 Sep 2026). Coffee Boy Leeds and
// Huddersfield post to the same Xero organisation, connected by the same Xero user. Xero
// rotates the refresh token on every refresh, and a new sign in supersedes the older set, so
// each venue refreshing its own copy on its own breaks the other. xero.ts rotates every row
// holding the same refresh token in one statement, and when a venue's own refresh fails it
// takes over the newest set of a sibling on the same tenant and the same Xero user.

/** The Xero user (the xero_userid claim) an access token belongs to, or null. */
export function xeroUserIdFromToken(jwt) {
  const part = String(jwt ?? '').split('.')[1];
  if (!part) return null;
  try {
    let b = part.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const bin = atob(b);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    return typeof claims?.xero_userid === 'string' && claims.xero_userid ? claims.xero_userid : null;
  } catch { return null; }
}

/**
 * The rows that share a venue's Xero sign in: the same tenant and the same Xero user (read from
 * each row's access token), other venues only.
 */
export function tokenFamily(rows, self) {
  const uid = xeroUserIdFromToken(self?.access_token);
  if (!uid || !self?.tenant_id) return [];
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.location_id !== self.location_id
    && r.tenant_id === self.tenant_id && xeroUserIdFromToken(r.access_token) === uid);
}

/** The sibling whose token set this venue should take over (newest first), or null. */
export function pickTokenDonor(rows, self) {
  const fam = tokenFamily(rows, self).filter((r) => r.refresh_token && r.refresh_token !== self.refresh_token);
  fam.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  return fam[0] || null;
}
