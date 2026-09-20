// supabase/functions/second-step-reset/index.ts
//
// LOST PHONE RECOVERY for the Back Office second sign in step (docs/SECOND_STEP.md).
//
// A login that loses its phone cannot remove its own Face ID or authenticator app: the
// auth server needs the second step to remove a verified one. This function (service
// role) removes EVERY second step a login has, so it sets up again at its next sign in.
//
//   POST { action: 'team',  location_id? }
//        The Back Office logins at a venue with whether each has set up its second step.
//        Owners: their own venue only (location_id required). ServOS super admin: any
//        venue, or every login when location_id is left out (admin portal).
//   POST { action: 'reset', user_id, location_id?, reason? }
//        Remove all of that login's second steps. Rules in
//        _shared/second-step-reset-rules.ts: an owner resets staff whose every venue
//        they own; only a ServOS super admin resets an owner or a super admin; nobody
//        resets themselves this way.
//
// ALWAYS needs the caller's own second step (aal2), whatever the enforcement switch says.
// Anonymous sessions, password only logins and the service role are refused.
// Every reset is written to public.second_step_resets BEFORE anything is removed, and the
// person is emailed through send-receipt. No personal data is logged.
//
// Deploy: npx supabase functions deploy second-step-reset --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireAal2, bearerToken } from '../_shared/second-step.ts';
import { resetDecision, factorSummary, ownedVenues, type ResetCaller, type ResetTarget, type VenueLink } from '../_shared/second-step-reset-rules.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Profile = { role: string | null; location_id: string | null; full_name: string | null } | null;

async function linksOf(userId: string): Promise<VenueLink[]> {
  const { data } = await admin.from('user_locations').select('location_id, role').eq('user_id', userId);
  return (data ?? []).map((r: any) => ({ venueId: String(r.location_id), role: r.role ?? null }));
}

async function profileOf(userId: string): Promise<Profile> {
  const { data } = await admin.from('user_profiles').select('role, location_id, full_name').eq('id', userId).maybeSingle();
  return (data as Profile) ?? null;
}

async function venueName(venueId: string | null | undefined): Promise<string> {
  if (!venueId) return '';
  const { data } = await admin.from('locations').select('name').eq('id', venueId).maybeSingle();
  return String((data as any)?.name ?? '');
}

async function targetFor(userId: string): Promise<{ target: ResetTarget; user: any; profile: Profile } | null> {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  const user = (data as any)?.user;
  if (error || !user || user.is_anonymous) return null;
  const [profile, links] = await Promise.all([profileOf(userId), linksOf(userId)]);
  return {
    user,
    profile,
    target: {
      id: userId,
      isSuperAdmin: profile?.role === 'super_admin',
      links,
      profileVenueId: profile?.location_id ?? null,
    },
  };
}

/** Small concurrency limit so a big list does not hammer the auth server. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  });
  await Promise.all(workers);
  return out;
}

async function teamIds(locationId: string | null): Promise<string[]> {
  if (locationId) {
    const [{ data: ul }, { data: up }] = await Promise.all([
      admin.from('user_locations').select('user_id').eq('location_id', locationId),
      admin.from('user_profiles').select('id').eq('location_id', locationId),
    ]);
    return [...new Set([...(ul ?? []).map((r: any) => String(r.user_id)), ...(up ?? []).map((r: any) => String(r.id))])];
  }
  // Every real login (super admin only). Anonymous sessions are the till fleet: skip them.
  const ids: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) break;
    const users = (data as any)?.users ?? [];
    for (const u of users) if (!u.is_anonymous) ids.push(String(u.id));
    if (users.length < 200) break;
  }
  return ids;
}

async function sendNotice(opts: { to: string; firstName: string; who: string; venueId: string | null }): Promise<boolean> {
  if (!opts.to || !opts.venueId) return false;
  const when = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const text =
    `Hi ${opts.firstName},\n\n` +
    `${opts.who} reset the second sign in step on your ServOS Back Office login on ${when}.\n\n` +
    `The next time you sign in you will be asked to set it up again: scan a new code with your authenticator app, ` +
    `and add Face ID or fingerprint if your device has it.\n\n` +
    `If you did not ask for this, tell your manager or ServOS support straight away.`;
  const html =
    `<div style="font-family:'Space Grotesk',system-ui,sans-serif;max-width:560px;color:#0F1211">` +
    `<p>Hi ${escapeHtml(opts.firstName)},</p>` +
    `<p><strong>${escapeHtml(opts.who)}</strong> reset the second sign in step on your ServOS Back Office login on ${escapeHtml(when)}.</p>` +
    `<p>The next time you sign in you will be asked to set it up again: scan a new code with your authenticator app, and add Face ID or fingerprint if your device has it.</p>` +
    `<p style="color:#8C938C">If you did not ask for this, tell your manager or ServOS support straight away.</p></div>`;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-receipt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify({ location_id: opts.venueId, to: opts.to, subject: 'Your ServOS sign in second step was reset', html, text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // 1. The caller's own second step, ALWAYS (switch or no switch).
  const needs = requireAal2(req, [SERVICE_ROLE]);
  if (needs) return needs;

  // 2. The token must be a real, current session (signature and session checked by the auth server).
  const { data: auth } = await admin.auth.getUser(bearerToken(req));
  const me = (auth as any)?.user;
  if (!me) return json({ error: 'Your sign in has expired. Sign in again.', code: 'sign_in_required' }, 401);
  if (me.is_anonymous) return json({ error: 'Sign in to Back Office first.', code: 'sign_in_required' }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? '').trim();
  const locationId = body?.location_id ? String(body.location_id) : null;
  if (locationId && !UUID.test(locationId)) return json({ error: 'bad location_id' }, 400);

  const [myProfile, myLinks] = await Promise.all([profileOf(me.id), linksOf(me.id)]);
  const caller: ResetCaller = { id: me.id, isSuperAdmin: myProfile?.role === 'super_admin', links: myLinks };

  // ── team: who at this venue has set up their second step ───────────────────
  if (action === 'team') {
    if (!caller.isSuperAdmin) {
      if (!locationId) return json({ error: 'location_id required' }, 400);
      if (!ownedVenues(caller.links).has(locationId)) {
        return json({ error: 'Only the owner of this venue can see this list.', code: 'not_owner' }, 403);
      }
    }
    const ids = await teamIds(locationId);
    const rows = (await mapLimit(ids, 5, async (id) => {
      const t = await targetFor(id);
      if (!t) return null;
      const venueRole = locationId ? (t.target.links.find((l) => l.venueId === locationId)?.role ?? null) : null;
      const decision = resetDecision(caller, t.target, locationId);
      return {
        user_id: id,
        email: t.user.email ?? null,
        name: t.profile?.full_name ?? null,
        venue_role: venueRole,
        is_you: id === caller.id,
        servos_admin: t.target.isSuperAdmin,
        second_step: factorSummary(t.user.factors),
        last_sign_in_at: t.user.last_sign_in_at ?? null,
        can_reset: decision.ok,
        reset_note: decision.ok ? null : decision.reason,
      };
    })).filter(Boolean) as any[];
    rows.sort((a, b) => Number(a.second_step.set_up) - Number(b.second_step.set_up) || String(a.email).localeCompare(String(b.email)));
    const setUp = rows.filter((r) => r.second_step.set_up).length;
    return json({ ok: true, location_id: locationId, total: rows.length, set_up: setUp, rows });
  }

  // ── reset: remove every second step so they set up again ────────────────────
  if (action === 'reset') {
    const targetId = String(body?.user_id ?? '');
    if (!UUID.test(targetId)) return json({ error: 'user_id required' }, 400);
    const t = await targetFor(targetId);
    if (!t) return json({ error: 'That login was not found.' }, 404);

    const decision = resetDecision(caller, t.target, locationId);
    if (!decision.ok) return json({ error: decision.reason, code: decision.code }, 403);

    // Audit FIRST: no row, no reset.
    const reason = String(body?.reason ?? '').slice(0, 200) || null;
    const { data: auditRow, error: auditErr } = await admin.from('second_step_resets').insert({
      actor_id: caller.id,
      actor_kind: caller.isSuperAdmin ? 'super_admin' : 'owner',
      target_id: targetId,
      location_id: locationId,
      reason,
      outcome: 'started',
    }).select('id').single();
    if (auditErr || !auditRow) {
      return json({
        error: 'Run the second step database update first (20260919s_OPS_second_step.sql). Nothing was reset.',
        code: 'not_ready',
      }, 409);
    }

    let removed = 0;
    let failed = 0;
    const types: string[] = [];
    const { data: listed, error: listErr } = await admin.auth.admin.mfa.listFactors({ userId: targetId });
    const factors = listErr ? [] : ((listed as any)?.factors ?? []);
    if (!listErr && factors.length === 0) {
      await admin.from('second_step_resets').update({
        factors_removed: 0, factor_types: [], outcome: 'done', emailed: false, finished_at: new Date().toISOString(),
      }).eq('id', (auditRow as any).id);
      return json({ ok: true, outcome: 'done', removed: 0, emailed: false, note: 'They have not set up a second step yet, so there was nothing to reset.' });
    }
    for (const f of factors) {
      const { error } = await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId: targetId });
      if (error) failed++;
      else { removed++; types.push(String(f.factor_type ?? 'unknown')); }
    }
    const outcome = listErr || failed ? (removed ? 'partial' : 'failed') : 'done';

    const firstName = String(t.profile?.full_name || '').trim().split(/\s+/)[0] || 'there';
    const venueForEmail = locationId || [...new Set([...t.target.links.map((l) => l.venueId), t.target.profileVenueId].filter(Boolean) as string[])][0] || null;
    const who = caller.isSuperAdmin ? 'ServOS support' : `The owner of ${(await venueName(venueForEmail)) || 'your venue'}`;
    const emailed = outcome === 'failed' ? false : await sendNotice({ to: t.user.email ?? '', firstName, who, venueId: venueForEmail });

    await admin.from('second_step_resets').update({
      factors_removed: removed,
      factor_types: types,
      outcome,
      emailed,
      finished_at: new Date().toISOString(),
    }).eq('id', (auditRow as any).id);

    if (outcome === 'failed') return json({ error: 'The reset did not go through. Please try again.', removed, emailed }, 502);
    return json({ ok: true, outcome, removed, emailed });
  }

  return json({ error: 'unknown action' }, 400);
});
