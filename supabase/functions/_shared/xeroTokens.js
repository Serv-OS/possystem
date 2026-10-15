// supabase/functions/_shared/xeroTokens.js
//
// Pure helpers for Xero token sets shared across venues (30 Sep 2026). Coffee Boy Leeds and
// Huddersfield post to the same Xero organisation, connected by the same Xero user. Xero
// rotates the refresh token on every refresh, and a new sign in supersedes the older set, so
// each venue refreshing its own copy on its own breaks the other. xero.ts rotates every row
// holding the same refresh token in one statement, and when a venue's own refresh fails it
// takes over the newest set of a sibling signed in by the same Xero user.
//
// 7 Oct 2026: the family is the Xero USER, on any organisation. A Xero token set belongs to
// the user and the app, not to one organisation: the same set reaches every organisation that
// user has connected (the xero-tenant-id header picks one). Coffee Boy's one sign in covers two
// organisations, so a family fenced by organisation would split one token chain in two and the
// half that refreshed second would be left holding a spent refresh token.

/** The claims of a Xero access token (a JWT), or null. Read only for our own stored rows. */
export function xeroClaimsFromToken(jwt) {
  const part = String(jwt ?? '').split('.')[1];
  if (!part) return null;
  try {
    let b = part.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const bin = atob(b);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    return claims && typeof claims === 'object' ? claims : null;
  } catch { return null; }
}

const claim = (jwt, key) => {
  const v = xeroClaimsFromToken(jwt)?.[key];
  return typeof v === 'string' && v ? v : null;
};

/** The Xero user (the xero_userid claim) an access token belongs to, or null. */
export function xeroUserIdFromToken(jwt) { return claim(jwt, 'xero_userid'); }

/** The sign in event (authentication_event_id) an access token came from, or null. */
export function xeroAuthEventIdFromToken(jwt) { return claim(jwt, 'authentication_event_id'); }

/**
 * The rows that share a venue's Xero sign in: the same Xero user (read from each row's access
 * token), on any organisation, other venues only. A row whose user cannot be read shares nothing.
 */
export function tokenFamily(rows, self) {
  const uid = xeroUserIdFromToken(self?.access_token);
  if (!uid) return [];
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.location_id !== self.location_id
    && xeroUserIdFromToken(r.access_token) === uid);
}

/** The sibling whose token set this venue should take over (newest first), or null. */
export function pickTokenDonor(rows, self) {
  const fam = tokenFamily(rows, self).filter((r) => r.refresh_token && r.refresh_token !== self.refresh_token);
  fam.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  return fam[0] || null;
}
