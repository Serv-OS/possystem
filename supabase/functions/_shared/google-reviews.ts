// supabase/functions/_shared/google-reviews.ts
//
// Google Business Profile review integration. ONE platform OAuth client (the
// platform owner registers it once: GOOGLE_OAUTH_CLIENT_ID / _SECRET) — each
// venue just signs in. Reviews are on the LEGACY v4 API (mybusiness.googleapis
// .com/v4); accounts + locations come from the v1 split APIs. Needs Google's
// Business Profile API access approval (~2 weeks) before calls return data.

const CLIENT_ID = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET') ?? '';
export const SCOPE = 'https://www.googleapis.com/auth/business.manage';

export function googleConfigured(): boolean { return !!(CLIENT_ID && CLIENT_SECRET); }

export function consentUrl(redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tokenCall(body: Record<string, string>) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error_description || j.error || `token ${res.status}`);
  return j as { access_token: string; refresh_token?: string; scope?: string; expires_in?: number };
}

export const exchangeCode = (code: string, redirectUri: string) =>
  tokenCall({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: redirectUri, grant_type: 'authorization_code' });

export async function accessTokenFrom(refreshToken: string): Promise<string> {
  const j = await tokenCall({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: refreshToken, grant_type: 'refresh_token' });
  return j.access_token;
}

async function gget(url: string, accessToken: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || `GET ${url} → ${res.status}`);
  return j;
}

// Flatten the user's accounts → locations into pickable {name,title} where name
// is the v4-style "accounts/{a}/locations/{l}" needed for the reviews API.
export async function listLocations(accessToken: string): Promise<Array<{ name: string; title: string }>> {
  const acc = await gget('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', accessToken);
  const out: Array<{ name: string; title: string }> = [];
  for (const a of acc.accounts ?? []) {
    const accountName = a.name as string; // "accounts/{id}"
    let pageToken = '';
    do {
      const url = `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title&pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`;
      const locs = await gget(url, accessToken);
      for (const l of locs.locations ?? []) {
        // l.name is "locations/{id}"; the v4 reviews path needs account + location.
        const locId = String(l.name).split('/').pop();
        out.push({ name: `${accountName}/locations/${locId}`, title: l.title || locId || 'Location' });
      }
      pageToken = locs.nextPageToken || '';
    } while (pageToken);
  }
  return out;
}

const STAR: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export interface GReview { external_review_id: string; rating: number; comment: string | null; customer_name: string | null; created_at: string; reply?: string | null; }

// List reviews for "accounts/{a}/locations/{l}" (v4).
export async function listReviews(accessToken: string, accountAndLocation: string): Promise<GReview[]> {
  const out: GReview[] = [];
  let pageToken = '';
  do {
    const url = `https://mybusiness.googleapis.com/v4/${accountAndLocation}/reviews?pageSize=50&orderBy=updateTime desc${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const j = await gget(url, accessToken);
    for (const r of j.reviews ?? []) {
      out.push({
        external_review_id: `${accountAndLocation}/reviews/${r.reviewId}`,
        rating: STAR[r.starRating] ?? 0,
        comment: r.comment ?? null,
        customer_name: r.reviewer?.displayName ?? null,
        created_at: r.createTime ?? new Date().toISOString(),
        reply: r.reviewReply?.comment ?? null,
      });
    }
    pageToken = j.nextPageToken || '';
    if (out.length >= 200) break;   // safety cap per sync
  } while (pageToken);
  return out;
}

// Post / update the owner reply on a review (v4 updateReply).
export async function replyToReview(accessToken: string, reviewName: string, comment: string): Promise<void> {
  const res = await fetch(`https://mybusiness.googleapis.com/v4/${reviewName}/reply`, {
    method: 'PUT', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment }),
  });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error?.message || `reply ${res.status}`); }
}
