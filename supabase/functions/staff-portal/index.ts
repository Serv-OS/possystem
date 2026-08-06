// supabase/functions/staff-portal/index.ts
//
// The staff self-service app (?mode=staff) — server side. Staff see their own
// shifts, announcements, timesheets and details from their own phone, so the
// shared clock-in tablet is never held hostage by a 20-minute training module.
//
// AUTH MODEL (Peter, 6 Aug): onboarding emails the new starter a link; the link
// lets them CREATE THEIR USER AND PASSWORD (Supabase Auth on the Ops project);
// after that they log in with email + password from the app itself.
//
//   invite        { staff_id }                 BO-authenticated. Stamps a one-use
//                                              7-day token on wf_staff and emails
//                                              the create-your-login link.
//   accept_invite { token, password }          Public. Verifies the token, creates
//                                              (or re-passwords) the auth user,
//                                              links wf_staff.portal_user_id.
//   reset_start   { email }                    Public. If the email matches a staff
//                                              record, sends a fresh link. Always
//                                              answers ok — no account enumeration.
//   snapshot      (Bearer = staff JWT)         Their profile, next shifts (14d),
//                                              announcements, timesheets (28d).
//   update_details{ patch } (Bearer)           Address / emergency contact / bank.
//                                              Bank changes are audited AND pinged
//                                              to the venue activity feed — a bank
//                                              swap is the classic payroll fraud.
//
// TRUST: service_role client, self-fenced (the workforce-clock model). A portal
// auth user has NO user_profiles/user_locations rows, so every BO RLS policy
// treats them as nobody; the ONLY door to data is this function.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const APP_BASE = (Deno.env.get('PUBLIC_APP_BASE') ?? 'https://possystem-liard.vercel.app').replace(/\/+$/, '');
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
}
const newToken = () => {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
};

/** The staff record behind a portal JWT, or null. Leavers lose access. */
async function staffFromJwt(req: Request) {
  const auth = req.headers.get('authorization') || '';
  const jwt = auth.replace(/^Bearer\s+/i, '');
  if (!jwt) return null;
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user) return null;
  const { data: rows } = await admin.from('wf_staff')
    .select('*').eq('portal_user_id', data.user.id).neq('status', 'leaver').limit(1);
  return rows?.[0] ?? null;
}

/** Is the calling BO user allowed to manage this staff member's location? */
async function callerManagesLocation(req: Request, locationId: string): Promise<{ ok: boolean; name?: string; id?: string }> {
  const auth = req.headers.get('authorization') || '';
  const jwt = auth.replace(/^Bearer\s+/i, '');
  if (!jwt) return { ok: false };
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user) return { ok: false };
  const uid = data.user.id;
  const { data: ul } = await admin.from('user_locations').select('location_id').eq('user_id', uid).eq('location_id', locationId).limit(1);
  if (!ul?.length) return { ok: false };
  const { data: prof } = await admin.from('user_profiles').select('display_name, email').eq('id', uid).maybeSingle();
  return { ok: true, id: uid, name: prof?.display_name || prof?.email || 'Manager' };
}

async function sendInviteEmail(staff: any, token: string, resend: boolean) {
  const url = `${APP_BASE}/?mode=staff&invite=${token}`;
  const first = String(staff.name || 'there').split(' ')[0];
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">
    <p>Hi ${first},</p>
    <p>${resend ? 'Here is a fresh link to' : 'Welcome! As part of your onboarding you can now'} set up your <strong>ServOS staff app</strong> login.
    You'll use it to see your shifts, announcements, timesheets and training, and to keep your details up to date.</p>
    <p style="margin:22px 0"><a href="${url}" style="background:#15C26A;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:700">Create my login</a></p>
    <p style="color:#667">The link works once and expires in 7 days. If it has expired, ask your manager to send a new one.</p>
  </div>`;
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-receipt`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_ROLE}` },
    body: JSON.stringify({ location_id: staff.location_id, to: staff.email, subject: 'Set up your ServOS staff app login', html, text: `Hi ${first}, set up your ServOS staff app login: ${url} (link works once, expires in 7 days)` }),
  });
  if (!res.ok) throw new Error(`invite email failed (${res.status})`);
}

/** Stamp a fresh single-use invite token on the staff row + email it. */
async function issueInvite(staff: any, resend: boolean) {
  if (!staff.email) throw new Error('This staff member has no email address on file');
  const token = newToken();
  const { error } = await admin.from('wf_staff').update({
    portal_invite_hash: await sha256(token),
    portal_invite_expires: new Date(Date.now() + 7 * 86400000).toISOString(),
  }).eq('id', staff.id);
  if (error) throw new Error(error.message);
  await sendInviteEmail(staff, token, resend);
}

async function audit(staff: any, action: string, before: unknown, after: unknown) {
  // Best-effort append to the tamper-evident log; chain hash comes from the
  // previous row like the other writers.
  try {
    const { data: prev } = await admin.from('wf_audit').select('row_hash').eq('org_id', staff.org_id)
      .order('created_at', { ascending: false }).limit(1);
    const prevHash = prev?.[0]?.row_hash ?? null;
    const rowHash = await sha256(JSON.stringify({ prevHash, action, staff: staff.id, after, at: Date.now() }));
    await admin.from('wf_audit').insert({
      location_id: staff.location_id, org_id: staff.org_id,
      actor_id: null, actor_name: `${staff.name} (staff app)`,
      action, entity: 'wf_staff', entity_id: String(staff.id),
      before, after, prev_hash: prevHash, row_hash: rowHash,
    });
  } catch (e) { console.error('[staff-portal] audit failed:', (e as Error).message); }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'snapshot';

    // ── invite: BO-side. Manager sends (or re-sends) the create-login email ──
    if (action === 'invite') {
      const { data: staff } = await admin.from('wf_staff').select('*').eq('id', body.staff_id).maybeSingle();
      if (!staff) return json({ error: 'staff member not found' }, 404);
      const caller = await callerManagesLocation(req, staff.location_id);
      if (!caller.ok) return json({ error: 'not allowed' }, 403);
      await issueInvite(staff, !!staff.portal_user_id || !!staff.portal_invite_hash);
      return json({ ok: true, sentTo: staff.email });
    }

    // ── accept_invite: the emailed link lands here with their chosen password ──
    if (action === 'accept_invite') {
      const token = String(body.token || ''); const password = String(body.password || '');
      if (!token) return json({ error: 'missing token' }, 400);
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);
      const hash = await sha256(token);
      const { data: rows } = await admin.from('wf_staff').select('*').eq('portal_invite_hash', hash).limit(1);
      const staff = rows?.[0];
      if (!staff) return json({ error: 'This link is not valid — ask your manager to send a new one' }, 400);
      if (!staff.portal_invite_expires || new Date(staff.portal_invite_expires) < new Date()) {
        return json({ error: 'This link has expired — ask your manager to send a new one' }, 400);
      }
      let userId = staff.portal_user_id as string | null;
      if (userId) {
        const { error } = await admin.auth.admin.updateUserById(userId, { password });
        if (error) return json({ error: error.message }, 400);
      } else {
        const { data: created, error } = await admin.auth.admin.createUser({
          email: staff.email, password, email_confirm: true,
          user_metadata: { staff_portal: true, staff_id: staff.id },
        });
        if (error) {
          // The email may already have an auth user (e.g. re-invite after a
          // partial run). Never attach to an account we didn't create here.
          return json({ error: `Could not create the login: ${error.message}` }, 400);
        }
        userId = created.user.id;
      }
      const { error: linkErr } = await admin.from('wf_staff')
        .update({ portal_user_id: userId, portal_invite_hash: null, portal_invite_expires: null })
        .eq('id', staff.id);
      if (linkErr) return json({ error: linkErr.message }, 500);
      await audit(staff, 'portal.login_created', null, { email: staff.email });
      return json({ ok: true, email: staff.email });
    }

    // ── reset_start: forgot password. Same email, fresh link, no enumeration ──
    if (action === 'reset_start') {
      const email = String(body.email || '').trim().toLowerCase();
      if (email) {
        const { data: rows } = await admin.from('wf_staff').select('*')
          .ilike('email', email).neq('status', 'leaver').limit(1);
        if (rows?.[0]) { try { await issueInvite(rows[0], true); } catch (e) { console.error('[staff-portal] reset:', (e as Error).message); } }
      }
      return json({ ok: true }); // always
    }

    // ── everything below is the logged-in staff member ────────────────────────
    const staff = await staffFromJwt(req);
    if (!staff) return json({ error: 'not signed in' }, 401);

    if (action === 'snapshot') {
      const today = new Date().toISOString().slice(0, 10);
      const horizon = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
      const monthAgo = new Date(Date.now() - 28 * 86400000).toISOString();
      const fortnightAgo = new Date(Date.now() - 14 * 86400000).toISOString();
      const [{ data: shifts }, { data: ts }, { data: ann }] = await Promise.all([
        admin.from('wf_shifts').select('shift_date, start_time, finish_time, break_mins, section, status')
          .eq('staff_id', staff.id).eq('status', 'published').gte('shift_date', today).lte('shift_date', horizon)
          .order('shift_date').limit(50),
        admin.from('wf_timesheets').select('clock_in, clock_out, break_taken, actual_hours, pay_amount, status')
          .eq('staff_id', staff.id).gte('clock_in', monthAgo).order('clock_in', { ascending: false }).limit(60),
        admin.from('wf_announcements').select('body, audience, author_name, created_at')
          .eq('location_id', staff.location_id).gte('created_at', fortnightAgo)
          .order('created_at', { ascending: false }).limit(20),
      ]);
      // Audience filter: all | their role | their section(s) — mirrors the clock.
      const roleLc = String(staff.role_key || '').toLowerCase();
      const mySections = new Set(staff.section_ids || []);
      const announcements = (ann ?? []).filter((a: any) => {
        const k = a.audience?.kind;
        if (!k || k === 'all') return true;
        if (k === 'role') return String(a.audience?.value || '').toLowerCase() === roleLc;
        if (k === 'section') return mySections.has(a.audience?.value);
        return false;
      }).slice(0, 10).map((a: any) => ({ body: a.body, author: a.author_name, at: a.created_at }));
      return json({
        ok: true,
        me: {
          name: staff.name, role: staff.role_key, email: staff.email, mobile: staff.mobile,
          startDate: staff.start_date, address: staff.address || null,
          emergencyContact: staff.emergency_contact || null,
          bankMasked: staff.bank_account_masked || null, bankSortCode: staff.bank_sort_code || null,
          bankAccountName: staff.bank_account_name || null,
        },
        shifts: (shifts ?? []).map((s: any) => ({ date: s.shift_date, start: String(s.start_time || '').slice(0, 5), finish: String(s.finish_time || '').slice(0, 5), breakMins: s.break_mins || 0, section: s.section })),
        timesheets: (ts ?? []).map((t: any) => ({ in: t.clock_in, out: t.clock_out, breakMins: t.break_taken || 0, hours: t.actual_hours != null ? Number(t.actual_hours) : null, pay: t.pay_amount != null ? Number(t.pay_amount) : null, status: t.status })),
        announcements,
        training: [],  // lands with the training module (see TRAINING_MODULE_PLAN.md)
      });
    }

    if (action === 'update_details') {
      const p = body.patch || {};
      const patch: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      if (p.address !== undefined) { before.address = staff.address; patch.address = String(p.address || '').slice(0, 500) || null; }
      if (p.emergencyContact !== undefined) {
        before.emergency_contact = staff.emergency_contact;
        const ec = p.emergencyContact || {};
        patch.emergency_contact = (ec.name || ec.phone || ec.relationship)
          ? { name: ec.name || null, phone: ec.phone || null, relationship: ec.relationship || null } : null;
      }
      let bankChanged = false;
      if (p.bank !== undefined) {
        const digits = String(p.bank.account || '').replace(/\D/g, '');
        const sort = String(p.bank.sortCode || '').replace(/[^0-9]/g, '').replace(/(\d{2})(\d{2})(\d{2})/, '$1-$2-$3');
        if (digits.length < 6 || !/^\d{2}-\d{2}-\d{2}$/.test(sort)) return json({ error: 'Enter a valid sort code and account number' }, 400);
        before.bank = { sort: staff.bank_sort_code, masked: staff.bank_account_masked };
        patch.bank_sort_code = sort;
        patch.bank_account = digits;
        patch.bank_account_masked = `****${digits.slice(-4)}`;
        patch.bank_account_name = String(p.bank.accountName || '').trim() || null;
        bankChanged = true;
      }
      if (!Object.keys(patch).length) return json({ error: 'nothing to update' }, 400);
      const { error } = await admin.from('wf_staff').update(patch).eq('id', staff.id);
      if (error) return json({ error: error.message }, 500);
      await audit(staff, bankChanged ? 'portal.bank_changed' : 'portal.details_changed', before, {
        ...patch, bank_account: undefined,  // never the full account number in the audit row
      });
      if (bankChanged) {
        // Bank swaps are THE payroll fraud vector — make it loud where managers look.
        try {
          await admin.from('activity_events').insert({
            location_id: staff.location_id, kind: 'staff', severity: 'action',
            title: `${staff.name} changed their bank details`,
            body: `Updated from the staff app. New account ending ${String(patch.bank_account_masked).slice(-4)}. If this wasn't them, act before the next pay run.`,
            ref_type: 'wf_staff', ref_id: String(staff.id), actor_name: `${staff.name} (staff app)`,
          });
        } catch (e) { console.error('[staff-portal] activity:', (e as Error).message); }
      }
      return json({ ok: true });
    }

    return json({ error: `unknown action: ${action}` }, 400);
  } catch (e) {
    console.error('[staff-portal]', e);
    return json({ error: (e as Error).message || 'server error' }, 500);
  }
});
