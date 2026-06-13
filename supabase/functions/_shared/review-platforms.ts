// supabase/functions/_shared/review-platforms.ts
//
// Platform adapter for Review Manager's two-way sync. ONE interface across
// Google / TripAdvisor / Facebook:
//   fetchReviews(link)        → reviews left directly on the platform (inbound)
//   postReply(link, text)     → publish an approved reply back to the platform
//
// Reality (capabilities refined from the platform-API research — see
// project_review_manager): the data flow here is REAL (dedup, upsert, draft,
// approve, record). The network calls are gated behind per-platform OAuth that
// isn't wired yet, so unsupported ops return a structured { mode:'manual' } with
// a deep-link the UI surfaces ("reply on TripAdvisor") instead of throwing —
// nothing silently fails. Slot real API calls into the marked spots per
// platform as OAuth lands; the callers don't change.

// ONLY platforms we can GENUINELY connect to — pull reviews AND post replies via
// an official API, with an open connection path. We deliberately do NOT list
// platforms we can't truly connect to (TripAdvisor read-only/no-store + no reply
// API; Yelp/Facebook/OpenTable/UberEats/Deliveroo/JustEat have no usable API;
// Booking.com onboarding currently paused) — a "manual deep-link" is not a
// connection. Add a platform here only when we can specifically connect to it.
export type Platform = 'google' | 'thefork' | 'trustpilot';

export interface PlatformLink {
  platform: Platform;
  url?: string | null;
  external_place_id?: string | null;
  // credentials_ref?: string;  // ← OAuth token reference, added when wiring real APIs
}

export interface PlatformReview {
  external_review_id: string;
  rating: number;                 // 1–5
  comment: string | null;
  customer_name: string | null;
  created_at: string;             // ISO
}

export interface PostResult {
  ok: boolean;
  mode: 'api' | 'manual' | 'unsupported';
  external_ref?: string;          // platform's id for the posted reply (api mode)
  manual_url?: string;            // deep-link for the staff to reply by hand (manual mode)
  message?: string;
}

// Per-platform capability matrix. read/reply ∈ 'api' | 'manual' | 'none'.
// 'api'    = sync/post happens automatically once the account is connected.
// 'manual' = no third-party API → deep-link staff to do it on the platform.
// 'none'   = the platform has no review API at all (read or reply).
// Verified against the platform-API research (2025-2026):
//  • Google: Business Profile API v4 reads reviews + posts replies — but needs
//    3-legged OAuth (business.manage) AND a ~2-week access-approval allowlist.
//  • TripAdvisor: Content API is read-only, caps ~5 reviews, and its no-storage
//    policy forbids the poll-and-diff a feed needs → manual (deep-link to reply).
//  • Facebook: Meta REMOVED Page recommendations/reviews from the Graph API
//    (error code 12, all versions since 2025-09-09) — nothing programmatic.
// All listed platforms are genuine two-way API connections (read reviews + post
// replies). Live calls are wired per-platform as each OAuth/credential path is
// implemented; until then a platform reports connected=false (no fake feed).
export const PLATFORM_CAPS: Record<Platform, { read: 'api' | 'manual' | 'none'; reply: 'api' | 'manual' | 'none' }> = {
  google:     { read: 'api', reply: 'api' },  // Business Profile API v4 (3-legged OAuth + ~2wk approval)
  thefork:    { read: 'api', reply: 'api' },  // TheFork B2B API (OAuth2 client-creds, light approval)
  trustpilot: { read: 'api', reply: 'api' },  // Trustpilot Business API (venue's paid plan + API add-on)
};

// How each platform is connected (shown in Settings). Connection = the venue
// authorises their own account on that platform — NOT a pasted URL — so reviews
// tie to the correct listing and replies post under the venue's identity.
export const PLATFORM_NOTES: Record<Platform, { status_label: string; how: string; note: string }> = {
  google: { status_label: 'Connect Google Business Profile', how: 'oauth', note: 'The profile owner/manager signs in with Google and picks this venue’s location. Reviews then sync in and your approved replies post back automatically. Google approves API access in ~2 weeks.' },
  thefork: { status_label: 'Connect TheFork', how: 'oauth', note: 'Sign in with this venue’s TheFork account. Reviews sync in and approved replies post back via TheFork’s partner API. For restaurants listed on TheFork.' },
  trustpilot: { status_label: 'Connect Trustpilot', how: 'oauth', note: 'Sign in with this venue’s Trustpilot business account (requires a paid Trustpilot plan with API access). Reviews sync in, replies post back, and you can send review invitations.' },
};

// True once real OAuth credentials are wired for a platform. Until then we run
// the data flow with no live network calls (and accept injected test reviews).
function liveApiEnabled(_platform: Platform): boolean {
  return false; // ← flip per-platform when OAuth + API access is configured
}

// ── Inbound: reviews left directly on the platform ──────────────────────────
// Returns [] until live OAuth is wired (no fake data in production). The sync
// edge fn also accepts injected test reviews so the whole loop is exercisable.
export async function fetchReviews(link: PlatformLink): Promise<PlatformReview[]> {
  const cap = PLATFORM_CAPS[link.platform]?.read;
  if (cap !== 'api' || !liveApiEnabled(link.platform)) return [];
  // ── REAL API CALL goes here per platform (Google reviews.list, etc.) ──
  return [];
}

// ── Outbound: publish an approved reply back to the originating platform ─────
export async function postReply(link: PlatformLink, _replyText: string): Promise<PostResult> {
  const cap = PLATFORM_CAPS[link.platform]?.reply;
  if (cap === 'api' && liveApiEnabled(link.platform)) {
    // ── REAL API CALL goes here (Google reviews.updateReply, etc.) ──
    return { ok: true, mode: 'api', external_ref: null as unknown as string };
  }
  if (cap === 'api') {
    // Connected platform but OAuth not wired yet — intent recorded, will post
    // once the account is linked. Treated as 'manual' for the operator's eyes.
    return { ok: true, mode: 'manual', manual_url: link.url ?? undefined, message: 'Saved — posts automatically once this platform is connected.' };
  }
  // Platform has no third-party reply API → hand the staff a deep-link.
  return { ok: true, mode: 'manual', manual_url: link.url ?? undefined, message: `Open ${link.platform} to post this reply (no reply API available).` };
}
