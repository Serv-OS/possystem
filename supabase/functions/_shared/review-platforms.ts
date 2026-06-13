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

export type Platform = 'google' | 'tripadvisor' | 'facebook';

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
export const PLATFORM_CAPS: Record<Platform, { read: 'api' | 'manual' | 'none'; reply: 'api' | 'manual' | 'none' }> = {
  google:      { read: 'api',    reply: 'api'    },
  tripadvisor: { read: 'manual', reply: 'manual' },
  facebook:    { read: 'none',   reply: 'none'   },
};

// User-facing copy for the Settings screen (per-platform connection state).
export const PLATFORM_NOTES: Record<Platform, { status_label: string; note: string }> = {
  google: { status_label: 'Connect (recommended)', note: 'Reviews sync in and your approved replies post back automatically once you connect this venue’s Google Business Profile. Connecting needs the profile owner/manager to sign in (Google access approval can take ~2 weeks). To get more Google reviews, send guests your Google review link — they post it themselves.' },
  tripadvisor: { status_label: 'Read-only — replies open in TripAdvisor', note: 'TripAdvisor’s terms don’t allow us to store your review history or post replies for you, so we can’t sync a full feed here. Approve a reply and we’ll open it for you to paste into the TripAdvisor Management Center.' },
  facebook: { status_label: 'Not available via API', note: 'Meta removed API access to Page recommendations/reviews (Sept 2025), so we can’t sync them or reply automatically. Read and respond in Meta Business Suite — we’ll keep your approved reply text ready to paste.' },
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
