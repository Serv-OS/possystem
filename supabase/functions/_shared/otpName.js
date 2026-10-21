// supabase/functions/_shared/otpName.js
//
// The one rule for the name in a loyalty code text (21 Oct 2026). Twilio stamps the Verify
// SERVICE's friendly name (at most 30 characters) into "Your <name> verification code is ...".
// A venue's code must carry the name set in Back Office for THAT venue, never another venue's.
// Pure, tested in src/lib/otpName.test.js.

/** What Twilio will show for a name: trimmed and cut to 30 characters. */
export function twilioName(name) {
  return String(name || '').trim().slice(0, 30);
}

/**
 * May a code for `venueName` go out from a service whose current name is `serviceName`?
 * Only when Twilio would show the same words (case does not matter). An unreadable service
 * name (null) is never good enough.
 */
export function sameServiceName(serviceName, venueName) {
  if (serviceName == null) return false;
  const a = twilioName(serviceName).toLowerCase();
  const b = twilioName(venueName).toLowerCase();
  return !!a && a === b;
}
