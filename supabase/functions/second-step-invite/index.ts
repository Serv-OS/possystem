// supabase/functions/second-step-invite/index.ts
//
// PROOF OF THE EMAIL BEFORE A FIRST SECOND STEP (docs/SECOND_STEP.md, fix round 20 Sep 2026).
//
// WHY. A password on its own must never be enough to SET one UP. A thief with the password of a
// login nobody uses could otherwise enrol their own authenticator app and be that person for
// good. So the auth server refuses a login's FIRST factor (public.second_step_mfa_hook) until
// there is a proof row saying "whoever is doing this holds the email address on the account".
// This function is the only thing that writes one.
//
//   POST { action: 'start' }                    (the person themselves, password only is fine)
//        Emails a 6 digit code to the address ON THE ACCOUNT. Never to an address in the body.
//   POST { action: 'claim', code }              (the person themselves)
//        The code they typed. Right code: the proof row is marked proved and the auth server
//        will accept their first factor for the next hour.
//   POST { action: 'invite', user_id }          (an owner of their venue, or ServOS, at aal2)
//        For someone who cannot reach their email, or who was locked out at switch on time.
//        Emails them the code as well, so the email is still proved where it can be.
//   POST { action: 'status' }                   (the person themselves)
//        { needs_email, proved, sent_to } so the screen knows what to show. No code.
//
// The code is stored HASHED (sha256 of the code and the login id). Five wrong tries and they
// need a new one. One code a minute per login. The proof is single use and lasts an hour.
//
// Deploy: npx supabase functions deploy second-step-invite --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireAal2, bearerToken } from '../_shared/second-step.ts';
import {
  CODE_TTL_MS, MAX_ATTEMPTS, codeFromBytes, normalizeCode, maySend, checkCode, codeMessage,
  inviteDecision, type ProofRow,
} from '../_shared/second-step-invite-rules.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function digestOf(code: string, userId: string): Promise<string> {
  const data = new TextEncoder().encode(`${userId}:${code}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return codeFromBytes(bytes);
}

async function proofOf(userId: string): Promise<ProofRow> {
  const { data } = await admin.from('second_step_enrolment_proof').select('*').eq('user_id', userId).maybeSingle();
  return (data as ProofRow) ?? null;
}

async function hasVerifiedFactor(userId: string): Promise<boolean> {
  const { data } = await admin.auth.admin.mfa.listFactors({ userId });
  return ((data as any)?.factors ?? []).some((f: any) => f.status === 'verified');
}

async function venuesOf(userId: string): Promise<string[]> {
  const { data } = await admin.from('user_locations').select('location_id').eq('user_id', userId);
  return (data ?? []).map((r: any) => String(r.location_id)).filter(Boolean);
}

async function ownedBy(userId: string): Promise<string[]> {
  const { data } = await admin.from('user_locations').select('location_id, role').eq('user_id', userId);
  return (data ?? []).filter((r: any) => String(r.role ?? '') === 'owner').map((r: any) => String(r.location_id));
}

async function isSuperAdmin(userId: string): Promise<boolean> {
  const { data } = await admin.from('user_profiles').select('role').eq('id', userId).maybeSingle();
  return String((data as any)?.role ?? '') === 'super_admin';
}

/** A venue to send the email from (send-receipt needs one): theirs, else any venue we have. */
async function venueForEmail(userId: string): Promise<string | null> {
  const mine = await venuesOf(userId);
  if (mine.length) return mine[0];
  const { data } = await admin.from('locations').select('id').limit(1);
  return (data ?? [])[0]?.id ? String((data as any)[0].id) : null;
}

async function emailCode(to: string, code: string, venueId: string | null, forSomeoneElse: boolean): Promise<boolean> {
  if (!to || !venueId) return false;
  const text =
    `Your ServOS set up code is ${code}\n\n` +
    `Type it on the "Set up your second sign in step" screen. It lasts one hour and works once.\n\n` +
    (forSomeoneElse
      ? `Someone at your venue asked us to send this so you can set your second step up.\n\n`
      : '') +
    `If you did not ask for it, someone may have your password: tell your manager or ServOS support straight away, and change it.`;
  const html =
    `<div style="font-family:'Space Grotesk',system-ui,sans-serif;max-width:560px;color:#0F1211">` +
    `<p>Your ServOS set up code is</p>` +
    `<p style="font-size:34px;font-weight:800;letter-spacing:6px;margin:8px 0">${code}</p>` +
    `<p>Type it on the "Set up your second sign in step" screen. It lasts one hour and works once.</p>` +
    (forSomeoneElse ? `<p>Someone at your venue asked us to send this so you can set your second step up.</p>` : '') +
    `<p style="color:#8C938C">If you did not ask for it, someone may have your password: tell your manager or ServOS support straight away, and change it.</p></div>`;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-receipt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify({ location_id: venueId, to, subject: 'Your ServOS set up code', html, text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function needsEmailStep(): Promise<boolean> {
  const { data } = await admin.from('second_step_settings').select('first_factor_needs_email').eq('id', true).maybeSingle();
  if (!data) return true;
  return (data as any).first_factor_needs_email !== false;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // The caller is whoever the auth server says they are. A PASSWORD ONLY session is fine here
  // on purpose: this is the step that comes BEFORE a second step exists. It never reveals
  // anything and never sends the code anywhere but the address on the account.
  const { data: auth } = await admin.auth.getUser(bearerToken(req));
  const me = (auth as any)?.user;
  if (!me?.id) return json({ error: 'Your sign in has expired. Sign in again.', code: 'sign_in_required' }, 401);
  if (me.is_anonymous) return json({ error: 'not allowed' }, 403);

  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }
  const action = String(body.action ?? '');
  const now = Date.now();

  if (action === 'status') {
    const [needs, row, has] = await Promise.all([needsEmailStep(), proofOf(me.id), hasVerifiedFactor(me.id)]);
    return json({
      ok: true,
      needs_email: needs && !has,
      proved: !!(row?.proved_at && !row?.used_at && row?.expires_at && Date.parse(row.expires_at) > now),
      sent_to: maskEmail(String(me.email ?? '')),
    });
  }

  if (action === 'start') {
    if (await hasVerifiedFactor(me.id)) {
      return json({ ok: true, needs_email: false, note: 'You already have a second step, so no code is needed.' });
    }
    const row = await proofOf(me.id);
    const send = maySend(row, now);
    if (!send.ok) {
      return json({ error: `We have just sent one. Wait ${Math.ceil(send.waitMs / 1000)} seconds and check your email.`, code: 'wait' }, 429);
    }
    const code = newCode();
    const hash = await digestOf(code, me.id);
    const { error } = await admin.from('second_step_enrolment_proof').upsert({
      user_id: me.id,
      code_hash: hash,
      sent_to: String(me.email ?? ''),
      issued_by: me.id,
      issued_kind: 'self',
      attempts: 0,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + CODE_TTL_MS).toISOString(),
      proved_at: null,
      used_at: null,
    }, { onConflict: 'user_id' });
    if (error) return json({ error: 'We could not start that. Try again.' }, 500);
    const sent = await emailCode(String(me.email ?? ''), code, await venueForEmail(me.id), false);
    if (!sent) {
      return json({ error: 'We could not send the email. Ask your owner or ServOS to set you up instead.', code: 'email_failed' }, 502);
    }
    return json({ ok: true, sent_to: maskEmail(String(me.email ?? '')) });
  }

  if (action === 'claim') {
    const row = await proofOf(me.id);
    const typed = normalizeCode(body.code);
    const outcome = checkCode(row, typed, await digestOf(typed, me.id), now);
    if (outcome !== 'ok') {
      if (row && (outcome === 'wrong')) {
        await admin.from('second_step_enrolment_proof')
          .update({ attempts: (row.attempts ?? 0) + 1 }).eq('user_id', me.id);
      }
      return json({ error: codeMessage(outcome), code: outcome }, 400);
    }
    await admin.from('second_step_enrolment_proof')
      .update({ proved_at: new Date(now).toISOString(), attempts: 0 }).eq('user_id', me.id);
    return json({ ok: true, proved: true });
  }

  if (action === 'invite') {
    // Issuing FOR SOMEONE ELSE needs the caller's own second step, whatever the switch says.
    const needs = requireAal2(req, [SERVICE_ROLE]);
    if (needs) return needs;
    const targetId = String(body.user_id ?? '');
    if (!UUID.test(targetId)) return json({ error: 'user_id required' }, 400);
    const [actorSuper, owned, venues, has] = await Promise.all([
      isSuperAdmin(me.id), ownedBy(me.id), venuesOf(targetId), hasVerifiedFactor(targetId),
    ]);
    const decision = inviteDecision(
      { id: me.id, isSuperAdmin: actorSuper, ownedVenues: owned },
      { id: targetId, venues, hasVerifiedFactor: has },
    );
    if (!decision.ok) return json({ error: decision.message, code: decision.code }, 403);
    const { data: targetUser } = await admin.auth.admin.getUserById(targetId);
    const to = String((targetUser as any)?.user?.email ?? '');
    if (!to) return json({ error: 'That login has no email address on it. Ask ServOS.' }, 400);
    const code = newCode();
    const hash = await digestOf(code, targetId);
    await admin.from('second_step_enrolment_proof').upsert({
      user_id: targetId,
      code_hash: hash,
      sent_to: to,
      issued_by: me.id,
      issued_kind: decision.code === 'super_admin' ? 'super_admin' : 'owner',
      attempts: 0,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + CODE_TTL_MS).toISOString(),
      proved_at: null,
      used_at: null,
    }, { onConflict: 'user_id' });
    const sent = await emailCode(to, code, await venueForEmail(targetId), true);
    return json({ ok: true, emailed: sent, sent_to: maskEmail(to) });
  }

  return json({ error: 'unknown action' }, 400);
});

/** j***@acme.test: enough for the person to know which inbox to open, no more. */
function maskEmail(email: string): string {
  const [name, domain] = String(email ?? '').split('@');
  if (!name || !domain) return '';
  return `${name.slice(0, 1)}${'*'.repeat(Math.max(1, name.length - 1))}@${domain}`;
}

export { MAX_ATTEMPTS };
