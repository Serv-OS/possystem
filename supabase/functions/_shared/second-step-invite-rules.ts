// supabase/functions/_shared/second-step-invite-rules.ts
//
// PROOF OF THE EMAIL, BEFORE A FIRST SECOND STEP (docs/SECOND_STEP.md, fix round 20 Sep 2026).
//
// WHY. A password on its own must never be enough to SET UP a second step. 7 of 13 live logins
// had not signed in for 30 days: a thief with one of those passwords could have enrolled their
// own authenticator app and become that person for good. So before the auth server accepts a
// login's FIRST factor, that login must have typed a code we sent to the address ON THE ACCOUNT.
// A thief with the password but not the inbox never gets it.
//
// The database is what enforces it (public.second_step_mfa_hook, the Supabase MFA verification
// attempt hook, which the auth server calls itself). This file is the pure rules the
// second-step-invite edge function uses to issue and check the code, so node:test can drive
// every branch.
//
// PURE. No Deno, no fetch, no crypto: the caller injects the random bytes, the digest and the
// clock.

export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 60 * 60 * 1000;      // an hour: long enough to find the email
export const MAX_ATTEMPTS = 5;                   // then a new code is needed
export const RESEND_WAIT_MS = 60 * 1000;         // one code a minute, per login

/** A 6 digit code from random bytes the caller supplies (crypto.getRandomValues in Deno). */
export function codeFromBytes(bytes: ArrayLike<number>): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) out += String((bytes[i] ?? 0) % 10);
  return out;
}

/** Typed codes are compared without spaces; only digits count. */
export function normalizeCode(code: unknown): string {
  return String(code ?? '').replace(/\D+/g, '');
}

export type ProofRow = {
  user_id?: string;
  code_hash?: string | null;
  attempts?: number | null;
  created_at?: string | null;
  expires_at?: string | null;
  proved_at?: string | null;
  used_at?: string | null;
} | null;

/**
 * May this login be sent a code now? Refuses a flood of emails (one a minute) and says when.
 */
export function maySend(row: ProofRow, now: number): { ok: boolean; waitMs: number } {
  const at = row?.created_at ? Date.parse(row.created_at) : 0;
  if (!at || Number.isNaN(at)) return { ok: true, waitMs: 0 };
  const since = now - at;
  if (since >= RESEND_WAIT_MS) return { ok: true, waitMs: 0 };
  return { ok: false, waitMs: RESEND_WAIT_MS - since };
}

/**
 * Is the typed code the one we sent? 'ok' | 'none' (never asked) | 'expired' | 'used' |
 * 'too_many' (ask for a new code) | 'wrong'.
 */
export function checkCode(row: ProofRow, typed: unknown, digest: string, now: number): string {
  if (!row || !row.code_hash) return 'none';
  if (row.used_at) return 'used';
  const exp = row.expires_at ? Date.parse(row.expires_at) : 0;
  if (!exp || Number.isNaN(exp) || exp <= now) return 'expired';
  if ((row.attempts ?? 0) >= MAX_ATTEMPTS) return 'too_many';
  const code = normalizeCode(typed);
  if (code.length !== CODE_LENGTH) return 'wrong';
  return digest && row.code_hash === digest ? 'ok' : 'wrong';
}

/** Plain words for each answer of checkCode. Never says whether the account exists. */
export function codeMessage(outcome: string): string {
  switch (outcome) {
    case 'none': return 'Press "Email me a code" first, then type the code we send you.';
    case 'expired': return 'That code has run out. Press "Email me a code" for a new one.';
    case 'used': return 'That code has been used already. Press "Email me a code" for a new one.';
    case 'too_many': return 'Too many tries. Press "Email me a code" for a new one.';
    case 'wrong': return 'That code does not match. Check the email and type the 6 digits again.';
    default: return '';
  }
}

export type InviteActor = {
  id: string;
  isSuperAdmin: boolean;
  /** venueId of every user_locations row where this person is an owner. */
  ownedVenues: string[];
};
export type InviteTarget = {
  id: string;
  /** every venueId this login is linked to. */
  venues: string[];
  hasVerifiedFactor: boolean;
};

/**
 * May this actor issue a set up invite FOR SOMEONE ELSE (the person cannot reach their email,
 * or they are locked out after the switch on)? The same shape as the reset rules:
 *   * ServOS (super admin) may invite anyone;
 *   * an owner may invite someone whose every venue they own;
 *   * nobody invites themselves this way (they press "Email me a code", which proves the email);
 *   * nobody is invited who already holds a second step (there is nothing to set up).
 */
export function inviteDecision(actor: InviteActor, target: InviteTarget): { ok: boolean; code: string; message: string } {
  const no = (code: string, message: string) => ({ ok: false, code, message });
  if (!actor?.id || !target?.id) return no('unknown', 'We could not tell who this is for.');
  if (actor.id === target.id) {
    return no('self', 'Press "Email me a code" on your own screen: that is what proves the email is yours.');
  }
  if (target.hasVerifiedFactor) {
    return no('already_set_up', 'They already have a second step. If they lost their phone, use Reset instead.');
  }
  if (actor.isSuperAdmin) return { ok: true, code: 'super_admin', message: '' };
  const owned = new Set((actor.ownedVenues || []).filter(Boolean));
  const venues = (target.venues || []).filter(Boolean);
  if (!owned.size) return no('not_owner', 'Only an owner of their venue, or ServOS, can do this.');
  if (!venues.length) return no('no_venue', 'That login is not linked to a venue you own. Ask ServOS.');
  if (venues.every((v) => owned.has(v))) return { ok: true, code: 'owner', message: '' };
  return no('other_venue', 'That login also works at a venue you do not own. Ask ServOS.');
}
