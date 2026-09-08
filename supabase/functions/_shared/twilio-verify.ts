// supabase/functions/_shared/twilio-verify.ts
//
// Twilio Verify (start / check) — the single home for ALL OTP delivery + validation.
//
// Replaces self-rolled OTP (generate a 6-digit code → store it → send via send-sms → compare):
// Twilio Verify generates the code, sends it over a managed/branded route with its OWN anti-fraud
// and rate-limiting, and validates it — so we never store or compare codes, and deliverability is
// far better than raw A2P SMS (which was hitting carrier/fraud blocks like error 30453).
//
// Secrets (TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN are already set for send-sms; project-wide):
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_VERIFY_SERVICE_SID   ← NEW: create a Verify Service in the Twilio console and set this.

const SID = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
const TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
const VERIFY_SERVICE_SID = Deno.env.get('TWILIO_VERIFY_SERVICE_SID') ?? '';

export function verifyConfigured(): boolean {
  return !!(SID && TOKEN && VERIFY_SERVICE_SID);
}

function authHeader(): string {
  return 'Basic ' + btoa(`${SID}:${TOKEN}`);
}

export interface VerifyResult {
  ok: boolean;
  status?: string;   // Twilio status: 'pending' | 'approved' | 'canceled' | 'expired' | ...
  error?: string;
  // our normalised error code: 'not_configured' | 'rate_limited' | 'max_attempts' | 'invalid' | 'send_failed'
  code?: string;
  httpStatus?: number;
  twilioCode?: number;   // Twilio's numeric error code (e.g. 60200 invalid To, 60410 blocked, 20404 bad service SID)
}

// Some Verify Services reject the CustomFriendlyName parameter (Twilio error 60204 "Custom friendly
// name not allowed" — e.g. when the service uses a custom message template). That param is only a
// nicety ("Your <venue> verification code is …"); getting the code DELIVERED matters far more. So we
// remember, per warm instance + per service, once a service has rejected it and stop sending it.
const friendlyNameBlockedSids = new Set<string>();

// Create a NEW Verify service (per-company isolation — each venue's codes carry ITS name).
// Returns the VA… sid. Services are free; billing is per verification.
export async function createVerifyService(name: string): Promise<{ ok: boolean; sid?: string; error?: string }> {
  if (!SID || !TOKEN) return { ok: false, error: 'Twilio not configured' };
  const clean = String(name || '').trim().slice(0, 30) || 'our venue';
  const form = new URLSearchParams();
  form.append('FriendlyName', clean);
  try {
    const res = await fetch('https://verify.twilio.com/v2/Services', {
      method: 'POST',
      headers: { 'Authorization': authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j?.sid) return { ok: false, error: j?.message || `Twilio HTTP ${res.status}` };
    return { ok: true, sid: j.sid as string };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || String(e) };
  }
}

// Start a verification — Twilio sends the code over `channel` to `to`.
// `serviceSid` targets a specific (per-company) Verify service; defaults to the shared env service.
// `friendlyName` overrides {{friendly_name}} in Twilio's default template so the SMS reads
// "Your <venue> verification code is 123456" — but only when the service permits it (see above).
export async function startVerification(
  to: string,
  opts: { channel?: string; friendlyName?: string; serviceSid?: string } = {},
): Promise<VerifyResult> {
  if (!verifyConfigured() && !opts.serviceSid) return { ok: false, error: 'Verify not configured', code: 'not_configured' };
  const svc = opts.serviceSid || VERIFY_SERVICE_SID;

  const post = async (withFriendly: boolean) => {
    const form = new URLSearchParams();
    form.append('To', to);
    form.append('Channel', opts.channel || 'sms');
    if (withFriendly && opts.friendlyName) form.append('CustomFriendlyName', opts.friendlyName.slice(0, 30));
    const res = await fetch(`https://verify.twilio.com/v2/Services/${svc}/Verifications`, {
      method: 'POST',
      headers: { 'Authorization': authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const j = await res.json().catch(() => ({}));
    return { res, j: j as { code?: number; message?: string; status?: string } };
  };

  try {
    const useFriendly = !friendlyNameBlockedSids.has(svc) && !!opts.friendlyName;
    let { res, j } = await post(useFriendly);
    // Custom friendly name rejected → this service doesn't allow it. Remember + retry without it.
    if (!res.ok && Number(j?.code) === 60204 && useFriendly) {
      friendlyNameBlockedSids.add(svc);
      ({ res, j } = await post(false));
    }
    if (!res.ok) {
      const tw = Number(j?.code);
      // 60203 = max send attempts reached for this number; 429 = rate limited.
      const code = (res.status === 429 || tw === 60203) ? 'rate_limited' : 'send_failed';
      return { ok: false, status: j?.status, error: j?.message || `Twilio HTTP ${res.status}`, code, httpStatus: res.status, twilioCode: Number.isFinite(tw) ? tw : undefined };
    }
    return { ok: true, status: j?.status };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || String(e), code: 'send_failed' };
  }
}

// Rename the Verify SERVICE itself. Twilio stamps the service's friendly name into the code SMS
// ("Your <friendly_name> verification code is ..."), and in practice ignores the per-request
// CustomFriendlyName on this service — so the service-level name is the one that actually shows.
// Called when the operator saves/resets the business name in BO → Messages → Verification Code.
export async function setVerifyServiceName(name: string, serviceSid?: string): Promise<VerifyResult> {
  if (!verifyConfigured() && !serviceSid) return { ok: false, error: 'Verify not configured', code: 'not_configured' };
  const clean = String(name || '').trim().slice(0, 30);
  if (!clean) return { ok: false, error: 'name required', code: 'invalid' };
  const form = new URLSearchParams();
  form.append('FriendlyName', clean);
  try {
    const res = await fetch(`https://verify.twilio.com/v2/Services/${serviceSid || VERIFY_SERVICE_SID}`, {
      method: 'POST',
      headers: { 'Authorization': authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (j as { message?: string })?.message || `Twilio HTTP ${res.status}`, code: 'send_failed', httpStatus: res.status };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || String(e), code: 'send_failed' };
  }
}

// Check a code. ok===true (status 'approved') means the code was correct. Twilio enforces expiry
// and per-verification attempt limits itself (404 once expired/consumed, 429 on too many checks).
export async function checkVerification(to: string, codeInput: string, serviceSid?: string): Promise<VerifyResult> {
  if (!verifyConfigured() && !serviceSid) return { ok: false, error: 'Verify not configured', code: 'not_configured' };
  const form = new URLSearchParams();
  form.append('To', to);
  form.append('Code', codeInput);
  try {
    const res = await fetch(`https://verify.twilio.com/v2/Services/${serviceSid || VERIFY_SERVICE_SID}/VerificationCheck`, {
      method: 'POST',
      headers: { 'Authorization': authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const j = await res.json().catch(() => ({}));
    if (res.status === 404) return { ok: false, status: 'expired', error: 'Code expired or already used — request a new one.', code: 'invalid', httpStatus: 404 };
    if (res.status === 429) return { ok: false, status: 'too_many', error: 'Too many attempts. Request a new code.', code: 'max_attempts', httpStatus: 429 };
    if (!res.ok) return { ok: false, error: (j as { message?: string })?.message || `Twilio HTTP ${res.status}`, code: 'invalid', httpStatus: res.status };
    const status = (j as { status?: string })?.status;
    return { ok: status === 'approved', status };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || String(e), code: 'invalid' };
  }
}
