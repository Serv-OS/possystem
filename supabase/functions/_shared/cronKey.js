// supabase/functions/_shared/cronKey.js
//
// WHO MAY RUN A SWEEP (17 Oct 2026, v5.11.73, PR 295 follow up "booking-reminders send_due
// behind a cron key"). Pure, no Deno, no network: node:test drives every branch
// (src/lib/bookings/cronKey.test.js) and booking-reminders imports this file.
//
// booking-reminders is public (deployed --no-verify-jwt: the booking page calls it with the bare
// public key). Its send_due sweep texts and emails guests, and anyone could start it. Each run is
// ledger gated, so a stranger could never make it send twice, but it answered with booking ids
// and the reason each guest was skipped, and it is the pg_cron job's work, not a stranger's.
//
// Now send_due runs for:
//   * the service role (another edge function, or a person with the service key), or
//   * the pg_cron job, which sends the header x-cron-key with a random key that lives ONLY in the
//     database vault (secret booking_reminders_cron_key, made by migration
//     20261017a_OPS_booking_reminders_cron_key.sql; nobody ever types or sees it). The function
//     asks the database whether the key is right (public.booking_reminders_cron_ok, service role
//     only), so there is no second copy of the key to keep in step.
//   * anyone, ONLY while that check function does not exist yet (the migration has not run).
//     That is exactly today's behaviour, so the function can be deployed before or after the
//     migration and reminders never stop. Any other failure of the check refuses (fails closed).
//
// The host stand no longer starts the sweep at all (the cron runs it every 5 minutes, stand or
// no stand); an old stand that still asks gets a quiet 403.

export const CRON_KEY_HEADER = 'x-cron-key';
export const CRON_KEY_CHECK = 'booking_reminders_cron_ok';

// The check function is missing (PostgREST PGRST202, Postgres 42883, or its words).
export function isMissingCheck(error) {
  if (!error) return false;
  const code = String(error.code || '');
  const msg = String(error.message || '');
  return code === 'PGRST202' || code === '42883'
    || /could not find the function|function .*does not exist|schema cache/i.test(msg);
}

// The bearer token of an Authorization header ('' when there is none).
export function bearerOf(header) {
  const m = /^Bearer\s+(.+)$/i.exec(String(header || '').trim());
  return m ? m[1].trim() : '';
}

// Is this the service role? Exact match on the function's own key, never an empty key.
export function isServiceRoleBearer(header, serviceRole) {
  const key = String(serviceRole || '');
  return !!key && bearerOf(header) === key;
}

// The decision, from what the request carried and what the database said about the key.
//   service   the caller is the service role (no database question was needed)
//   key       the header x-cron-key ('' when none)
//   check     { data, error } from rpc(CRON_KEY_CHECK, { p_key: key }), or null when not asked
// Returns { ok, by, reason }:
//   by 'service_role' | 'cron_key' | 'before_migration'
//   reason (when refused) 'no_cron_key' | 'wrong_cron_key' | 'cron_key_check_failed'
export function sweepAccess({ service = false, key = '', check = null } = {}) {
  if (service) return { ok: true, by: 'service_role', reason: null };
  if (check?.error && isMissingCheck(check.error)) return { ok: true, by: 'before_migration', reason: null };
  if (check?.error) return { ok: false, by: null, reason: 'cron_key_check_failed' };
  if (!String(key || '')) return { ok: false, by: null, reason: 'no_cron_key' };
  if (check?.data === true) return { ok: true, by: 'cron_key', reason: null };
  return { ok: false, by: null, reason: 'wrong_cron_key' };
}
