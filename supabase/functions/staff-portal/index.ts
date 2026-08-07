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
// Staff-facing links (invite email, contract sign, 'open my app') must point at
// the real staff domain, NOT the Vercel deploy URL. Set as the PUBLIC_APP_BASE
// secret; the fallback matches it so a missing secret can't email a dead link.
const APP_BASE = (Deno.env.get('PUBLIC_APP_BASE') ?? 'https://dev.serv-os.app').replace(/\/+$/, '');
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
  const { data: ul } = await admin.from('user_locations').select('location_id, role').eq('user_id', uid).eq('location_id', locationId).limit(1);
  if (!ul?.length) return { ok: false };
  // Inviting mints a credential — membership alone is not enough.
  const role = String(ul[0].role || '').toLowerCase();
  if (!['owner', 'admin', 'manager'].includes(role)) return { ok: false };
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
    // Chain by LOCATION ordered by `at` — matching workforce-compute, the other
    // writer. (This read used to order by a non-existent `created_at`, so it
    // 400'd, prev_hash was always null and the chain was decorative.) The
    // hashed timestamp is the one we persist, so row_hash is recomputable.
    const { data: prev, error: prevErr } = await admin.from('wf_audit').select('row_hash')
      .eq('location_id', staff.location_id).order('at', { ascending: false }).limit(1);
    if (prevErr) throw new Error(`audit chain read failed: ${prevErr.message}`);
    const prevHash = prev?.[0]?.row_hash ?? null;
    const at = new Date().toISOString();
    const rowHash = await sha256(JSON.stringify({ prevHash, action, staff: staff.id, after, at }));
    await admin.from('wf_audit').insert({
      location_id: staff.location_id, org_id: staff.org_id,
      actor_id: null, actor_name: `${staff.name} (staff app)`,
      action, entity: 'wf_staff', entity_id: String(staff.id),
      before, after, prev_hash: prevHash, row_hash: rowHash, at,
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

    // ── notify_training: tell someone they have training to do. BO-authorised,
    //    called straight after an assignment. Email + it shows in their app. ──
    if (action === 'notify_training') {
      const { data: staffRow } = await admin.from('wf_staff').select('*').eq('id', body.staff_id).maybeSingle();
      if (!staffRow) return json({ error: 'staff member not found' }, 404);
      const caller = await callerManagesLocation(req, staffRow.location_id);
      if (!caller.ok) return json({ error: 'not allowed' }, 403);
      if (!staffRow.email) return json({ ok: true, skipped: 'no-email' });
      const first = String(staffRow.name || 'there').split(' ')[0];
      const due = body.due ? new Date(String(body.due) + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : null;
      const url = `${APP_BASE}/?mode=staff`;
      const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">
        <p>Hi ${first},</p>
        <p>You have new training to complete: <strong>${String(body.module_name || 'a training module')}</strong>${due ? `, due by <strong>${due}</strong>` : ''}.</p>
        <p>Open the staff app, read through it, and confirm when you're done.</p>
        <p style="margin:22px 0"><a href="${url}" style="background:#15C26A;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:700">Open my staff app</a></p>
      </div>`;
      const res = await fetch(`${SUPABASE_URL}/functions/v1/send-receipt`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_ROLE}` },
        body: JSON.stringify({ location_id: staffRow.location_id, to: staffRow.email, subject: `Training to complete: ${body.module_name || 'new module'}`, html, text: `Hi ${first}, you have training to complete: ${body.module_name}${due ? ` (due ${due})` : ''}. Open your staff app: ${url}` }),
      });
      if (!res.ok) return json({ error: `Email failed (${res.status})` }, 502);
      return json({ ok: true, sentTo: staffRow.email });
    }

    // ── outstanding: what this person still owes, by PIN. Used by the Time
    //    Clock so clocking in/out flags it on the shared tablet — no login,
    //    no personal data beyond counts and titles. ────────────────────────────
    if (action === 'outstanding') {
      const { location_id, staff_id } = body;
      if (!location_id || !staff_id) return json({ error: 'missing location_id / staff_id' }, 400);
      const today = new Date().toISOString().slice(0, 10);
      const [{ data: tr }, { data: onbRows }] = await Promise.all([
        admin.from('wf_training_assignments')
          .select('due_date, status, wf_training_modules(name)')
          .eq('staff_id', staff_id).eq('location_id', location_id).neq('status', 'complete'),
        admin.from('wf_onboarding').select('steps, meta').eq('staff_id', staff_id)
          .order('created_at', { ascending: false }).limit(1),
      ]);
      const training = (tr ?? []).map((a: any) => ({ name: a.wf_training_modules?.name || 'Training', due: a.due_date, overdue: !!(a.due_date && a.due_date < today) }));
      const onbOpen = (onbRows?.[0]?.steps || []).filter((st: any) => st.status !== 'complete').length;
      return json({ ok: true, training, onboardingOpen: onbOpen, total: training.length + onbOpen });
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
      if (staff.status === 'leaver') return json({ error: 'This account is closed' }, 403);
      // SECURITY (adversarial review, 7 Aug): before setting ANY password we
      // re-verify the target auth account. Two independent checks, because
      // wf_staff.email and portal_user_id are ordinary columns:
      //   1. the auth user's email must equal the staff record's email, so a
      //      swapped email can never redirect a password set;
      //   2. the account must not be a Back Office principal — BO users have
      //      their own recovery and must never be re-passworded from here.
      // Column-level writes are additionally blocked at the DB by
      // wf_staff_block_portal_cols_trg (20260806j).
      const guardTarget = async (uid: string) => {
        const { data: u } = await admin.auth.admin.getUserById(uid);
        const authEmail = String(u?.user?.email || '').toLowerCase();
        if (!authEmail || authEmail !== String(staff.email || '').toLowerCase()) {
          return 'This invite does not match the account on file — ask your manager to re-send it';
        }
        const [{ data: prof }, { data: locs }] = await Promise.all([
          admin.from('user_profiles').select('id').eq('id', uid).maybeSingle(),
          admin.from('user_locations').select('user_id').eq('user_id', uid).limit(1),
        ]);
        if (prof || locs?.length) {
          return 'That email is a Back Office login. Sign in with your Back Office password, or reset it there.';
        }
        return null;
      };

      let userId = staff.portal_user_id as string | null;
      let existing = false;
      if (userId) {
        const bad = await guardTarget(userId);
        if (bad) return json({ error: bad }, 403);
        const { error } = await admin.auth.admin.updateUserById(userId, { password });
        if (error) return json({ error: error.message }, 400);
      } else {
        const { data: created, error } = await admin.auth.admin.createUser({
          email: staff.email, password, email_confirm: true,
          user_metadata: { staff_portal: true, staff_id: staff.id },
        });
        if (!error) {
          userId = created.user.id;
        } else if (/already|registered|exists/i.test(error.message)) {
          // The email already has a ServOS account (e.g. an owner-operator who
          // is ALSO a Back Office user — one email is one account). The invite
          // link proves control of that inbox, which is exactly what password
          // recovery proves, so link the accounts and set the password they
          // just chose. That password now applies to the account everywhere.
          const { data: lk, error: lkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email: staff.email });
          if (lkErr || !lk?.user?.id) return json({ error: `Could not link the existing login: ${lkErr?.message || 'user lookup failed'}` }, 400);
          userId = lk.user.id;
          const bad = await guardTarget(userId);
          if (bad) return json({ error: bad }, 403);
          const { error: pwErr } = await admin.auth.admin.updateUserById(userId, { password });
          if (pwErr) return json({ error: pwErr.message }, 400);
          existing = true;
        } else {
          return json({ error: `Could not create the login: ${error.message}` }, 400);
        }
      }
      const { error: linkErr } = await admin.from('wf_staff')
        .update({ portal_user_id: userId, portal_invite_hash: null, portal_invite_expires: null })
        .eq('id', staff.id);
      if (linkErr) return json({ error: linkErr.message }, 500);
      await audit(staff, existing ? 'portal.login_linked' : 'portal.login_created', null, { email: staff.email, existingAccount: existing });
      return json({ ok: true, email: staff.email, existing });
    }

    // ── reset_start: forgot password. Same email, fresh link, no enumeration ──
    if (action === 'reset_start') {
      const email = String(body.email || '').trim().toLowerCase();
      if (email) {
        // .ilike() treated the input as a LIKE PATTERN: '%' matched every staff
        // row in every tenant and rotated a stranger's invite token. Exact match.
        const { data: rows } = await admin.from('wf_staff').select('*')
          .eq('email', email).neq('status', 'leaver').limit(1);
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
      const [{ data: shifts }, { data: ts }, { data: ann }, { data: onbRows }, { data: trainRows }] = await Promise.all([
        admin.from('wf_shifts').select('shift_date, start_time, finish_time, break_mins, section, status')
          .eq('staff_id', staff.id).eq('status', 'published').gte('shift_date', today).lte('shift_date', horizon)
          .order('shift_date').limit(50),
        admin.from('wf_timesheets').select('clock_in, clock_out, break_taken, actual_hours, pay_amount, status')
          .eq('staff_id', staff.id).gte('clock_in', monthAgo).order('clock_in', { ascending: false }).limit(60),
        admin.from('wf_announcements').select('body, audience, author_name, created_at')
          .eq('location_id', staff.location_id).gte('created_at', fortnightAgo)
          .order('created_at', { ascending: false }).limit(20),
        admin.from('wf_onboarding').select('*').eq('staff_id', staff.id)
          .order('created_at', { ascending: false }).limit(1),
        admin.from('wf_training_assignments')
          .select('id, module_id, assigned_at, due_date, tasks_done, opened_files, attested_at, completed_at, status, wf_training_modules(name, description, content, tasks, attachments)')
          .eq('staff_id', staff.id).order('due_date', { ascending: true }).limit(50),
      ]);
      // Their leave, accrued holiday and pay rate — small follow-ups, not worth
      // widening the main Promise.all's failure surface.
      const [{ data: leave }, { data: accrual }, { data: roleRow }] = await Promise.all([
        admin.from('wf_time_off').select('id, type, start_date, end_date, days, note, status, created_at')
          .eq('staff_id', staff.id).order('created_at', { ascending: false }).limit(20),
        admin.from('wf_holiday_accrual').select('accrued_hours').eq('staff_id', staff.id).limit(5000),
        staff.role_key
          ? admin.from('wf_roles').select('base_rate, salary_annual').eq('location_id', staff.location_id).eq('key', staff.role_key).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);
      const accruedHours = (accrual ?? []).reduce((a: number, r: any) => a + (Number(r.accrued_hours) || 0), 0);
      const payRate = staff.rate_override != null
        ? { kind: 'hourly', rate: Number(staff.rate_override), source: 'personal' }
        : roleRow?.base_rate != null
          ? { kind: 'hourly', rate: Number(roleRow.base_rate), source: 'position' }
          : roleRow?.salary_annual != null
            ? { kind: 'salary', annual: Number(roleRow.salary_annual), source: 'position' }
            : null;

      // Onboarding to-dos THEY can act on. Mirrors the BO's evidence-derived
      // statuses (WfOnboarding normalizeCase): meta is the truth, steps a cache.
      const onb = onbRows?.[0] ?? null;
      let onboarding = null;
      if (onb) {
        const meta = onb.meta || {};
        const signed = !!meta.signature;
        const contractReady = !!(meta.contractHtml || meta.contractPath);
        const steps = [
          { key: 'offer', label: 'Offer letter', done: !!meta.offerAccepted || !!meta.offerSentAt },
          {
            key: 'contract', label: 'Sign your contract', done: signed,
            action: !signed && contractReady && meta.signToken ? 'sign' : null,
            signUrl: !signed && contractReady && meta.signToken ? `${APP_BASE}/sign/${meta.signToken}` : null,
            waiting: !signed && !contractReady ? 'Your manager is preparing it' : null,
          },
          { key: 'rtw', label: 'Upload your Right to Work', done: !!meta.rtwPath, action: !meta.rtwPath ? 'rtw' : null },
          { key: 'bank', label: 'Add your bank details', done: !!meta.bankMasked || !!staff.bank_account_masked, action: (!meta.bankMasked && !staff.bank_account_masked) ? 'bank' : null },
          { key: 'posUser', label: 'Till access', done: !!staff.pos_user_id, waiting: !staff.pos_user_id ? 'Your manager sets this up' : null },
        ];
        onboarding = { open: steps.some(s => !s.done), steps };
      }

      const training = (trainRows ?? []).map((a: any) => {
        const mod = a.wf_training_modules || {};
        const doneIds = new Set((Array.isArray(a.tasks_done) ? a.tasks_done : []).map((t: any) => t.taskId));
        const openedIds = new Set((Array.isArray(a.opened_files) ? a.opened_files : []).map((f: any) => f.fileId));
        return {
          id: a.id,
          name: mod.name, description: mod.description,
          content: mod.content || null,
          // File PATHS never reach the client — only ids and names. The app asks
          // training_file_url for a short-lived signed URL per file, which is
          // also how "they actually opened it" gets recorded.
          files: (Array.isArray(mod.attachments) ? mod.attachments : []).map((f: any) => ({ id: f.id, name: f.name, opened: openedIds.has(f.id) })),
          tasks: (Array.isArray(mod.tasks) ? mod.tasks : []).map((t: any) => ({ id: t.id, title: t.title, detail: t.detail || null, done: doneIds.has(t.id) })),
          due: a.due_date, completedAt: a.completed_at, status: a.status,
          attestedAt: a.attested_at || null,
          overdue: a.status !== 'complete' && a.due_date && a.due_date < today,
        };
      });
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
        onboarding,
        training,
        leave: {
          accruedHours: Math.round(accruedHours * 100) / 100,
          requests: (leave ?? []).map((l: any) => ({ id: l.id, type: l.type, from: l.start_date, to: l.end_date, days: l.days != null ? Number(l.days) : null, note: l.note, status: l.status, at: l.created_at })),
        },
        payRate,
      });
    }

    // ── training_tick: tick/untick one task; completion stamped server-side ──
    if (action === 'training_tick') {
      const { data: a } = await admin.from('wf_training_assignments')
        .select('*, wf_training_modules(name, tasks)').eq('id', body.assignment_id).eq('staff_id', staff.id).maybeSingle();
      if (!a) return json({ error: 'assignment not found' }, 404);
      const taskIds = (Array.isArray(a.wf_training_modules?.tasks) ? a.wf_training_modules.tasks : []).map((t: any) => t.id);
      if (!taskIds.includes(body.task_id)) return json({ error: 'task not found' }, 404);
      let done = (Array.isArray(a.tasks_done) ? a.tasks_done : []).filter((t: any) => taskIds.includes(t.taskId));
      done = done.filter((t: any) => t.taskId !== body.task_id);
      if (body.done !== false) done.push({ taskId: body.task_id, at: new Date().toISOString() });
      // Ticks track PROGRESS only. Completion is the ATTESTATION (training_attest)
      // — the person's formal agreement, never an implicit side effect. But a
      // tick after attestation must not silently un-complete anything either.
      if (a.attested_at) return json({ error: 'This training is already completed and agreed' }, 400);
      const { error } = await admin.from('wf_training_assignments').update({ tasks_done: done }).eq('id', a.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ── training_file_url: open one training material. Serves a short-lived
    //    signed URL AND records the open — the evidence the attestation needs. ──
    if (action === 'training_file_url') {
      const { data: a } = await admin.from('wf_training_assignments')
        .select('id, opened_files, wf_training_modules(attachments)')
        .eq('id', body.assignment_id).eq('staff_id', staff.id).maybeSingle();
      if (!a) return json({ error: 'assignment not found' }, 404);
      const file = (Array.isArray(a.wf_training_modules?.attachments) ? a.wf_training_modules.attachments : []).find((f: any) => f.id === body.file_id);
      if (!file?.path) return json({ error: 'file not found' }, 404);
      const { data: signed, error } = await admin.storage.from('wf-documents').createSignedUrl(file.path, 300);
      if (error) return json({ error: error.message }, 500);
      const opened = (Array.isArray(a.opened_files) ? a.opened_files : []).filter((f: any) => f.fileId !== file.id);
      opened.push({ fileId: file.id, at: new Date().toISOString() });
      await admin.from('wf_training_assignments').update({ opened_files: opened }).eq('id', a.id);
      return json({ ok: true, url: signed.signedUrl });
    }

    // ── training_attest: the formal agreement — "I have completed and
    //    understood this training." Refused until every material was opened
    //    and every checklist item ticked. Stamped with name + time, audited. ──
    if (action === 'training_attest') {
      if (body.agree !== true) return json({ error: 'Tick the agreement first' }, 400);
      const { data: a } = await admin.from('wf_training_assignments')
        .select('*, wf_training_modules(name, tasks, attachments)')
        .eq('id', body.assignment_id).eq('staff_id', staff.id).maybeSingle();
      if (!a) return json({ error: 'assignment not found' }, 404);
      if (a.attested_at) return json({ ok: true, alreadyDone: true });
      const files = Array.isArray(a.wf_training_modules?.attachments) ? a.wf_training_modules.attachments : [];
      const openedIds = new Set((Array.isArray(a.opened_files) ? a.opened_files : []).map((f: any) => f.fileId));
      const unopened = files.filter((f: any) => !openedIds.has(f.id));
      if (unopened.length) return json({ error: `Open every material first — not yet opened: ${unopened.map((f: any) => f.name).join(', ')}` }, 400);
      const taskIds = (Array.isArray(a.wf_training_modules?.tasks) ? a.wf_training_modules.tasks : []).map((t: any) => t.id);
      const doneIds = new Set((Array.isArray(a.tasks_done) ? a.tasks_done : []).map((t: any) => t.taskId));
      if (taskIds.some((id: string) => !doneIds.has(id))) return json({ error: 'Tick every checklist item first' }, 400);
      const now = new Date().toISOString();
      const attestation = { name: staff.name, at: now };
      const { error } = await admin.from('wf_training_assignments')
        .update({ attested_at: now, attestation, status: 'complete', completed_at: a.completed_at || now })
        .eq('id', a.id);
      if (error) return json({ error: error.message }, 500);
      await audit(staff, 'training.attested', null, { module: a.wf_training_modules?.name, assignment: a.id, attestation });
      try {
        await admin.from('activity_events').insert({
          location_id: staff.location_id, kind: 'staff', severity: 'info',
          title: `${staff.name} completed training: ${a.wf_training_modules?.name || 'a module'}`,
          body: 'Agreed as completed and understood, from the staff app.',
          ref_type: 'wf_training_assignments', ref_id: String(a.id), actor_name: `${staff.name} (staff app)`,
        });
      } catch { /* best effort */ }
      return json({ ok: true });
    }

    // ── timeoff_request: lands as 'pending' in BO Leave AND Manager approvals ──
    if (action === 'timeoff_request') {
      const from = String(body.from || ''); const to = String(body.to || from);
      const type = ['holiday', 'sick', 'unpaid', 'parental'].includes(body.type) ? body.type : 'holiday';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) {
        return json({ error: 'Pick valid dates' }, 400);
      }
      const days = Math.round((new Date(to + 'T00:00:00').getTime() - new Date(from + 'T00:00:00').getTime()) / 86400000) + 1;
      if (days > 60) return json({ error: 'That is more than 60 days — talk to your manager directly' }, 400);
      const { error } = await admin.from('wf_time_off').insert({
        location_id: staff.location_id, org_id: staff.org_id, staff_id: staff.id,
        type, start_date: from, end_date: to, days, note: String(body.note || '').slice(0, 500) || null, status: 'pending',
      });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ── RTW upload from their phone: signed upload URL, then registration ──────
    if (action === 'rtw_upload_url') {
      const ext = String(body.ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg';
      const path = `${staff.location_id}/${staff.id}/RTW-${Date.now()}.${ext}`;
      const { data, error } = await admin.storage.from('wf-documents').createSignedUploadUrl(path);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, path, uploadUrl: data.signedUrl, token: data.token });
    }
    if (action === 'rtw_submit') {
      const path = String(body.path || '');
      if (!path.startsWith(`${staff.location_id}/${staff.id}/`)) return json({ error: 'invalid path' }, 400);
      // Mirrors the manager-side upload exactly: one current doc per person per
      // type, lands 'pending' — a manager approves it in Compliance (that IS
      // the RTW check), and the onboarding step follows the evidence.
      const { data: existingDoc } = await admin.from('wf_documents').select('id')
        .eq('staff_id', staff.id).eq('type', 'RTW').limit(1);
      const docRow = { location_id: staff.location_id, org_id: staff.org_id, staff_id: staff.id, type: 'RTW', file_url: path, status: 'pending', updated_at: new Date().toISOString() };
      const w = existingDoc?.[0]
        ? await admin.from('wf_documents').update(docRow).eq('id', existingDoc[0].id)
        : await admin.from('wf_documents').insert(docRow);
      if (w.error) return json({ error: w.error.message }, 500);
      const { data: onbRow } = await admin.from('wf_onboarding').select('*').eq('staff_id', staff.id)
        .order('created_at', { ascending: false }).limit(1);
      if (onbRow?.[0]) {
        const meta = { ...(onbRow[0].meta || {}), rtwPath: path };
        const steps = (onbRow[0].steps || []).map((st: any) => st.key === 'rtw' ? { ...st, status: 'complete', completedAt: new Date().toISOString() } : st);
        await admin.from('wf_onboarding').update({ meta, steps }).eq('id', onbRow[0].id);
      }
      await audit(staff, 'portal.rtw_uploaded', null, { path });
      return json({ ok: true });
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
        // Bank swaps are THE payroll fraud vector — but that is a MANAGER
        // concern, not a till one (Peter, 6 Aug: "shouldn't go to the POS").
        // ops_alerts surfaces in the Manager app (Need-you-now count + alerts
        // list with acknowledge) and BO Operations; tills never see it.
        try {
          await admin.from('ops_alerts').insert({
            location_id: staff.location_id, org_id: staff.org_id, type: 'staff_change', severity: 'major',
            title: `${staff.name} changed their bank details`,
            body: `Updated from the staff app. New account ending ${String(patch.bank_account_masked).slice(-4)}. If this wasn't them, act before the next pay run.`,
            source_type: 'wf_staff', source_id: staff.id, target_role: 'manager',
          });
        } catch (e) { console.error('[staff-portal] ops alert:', (e as Error).message); }
        // Close the onboarding "bank details" step if a case is open — the case
        // derives from evidence, and the evidence now exists.
        try {
          const { data: onbRow } = await admin.from('wf_onboarding').select('*').eq('staff_id', staff.id)
            .order('created_at', { ascending: false }).limit(1);
          if (onbRow?.[0] && !(onbRow[0].meta || {}).bankMasked) {
            const meta = { ...(onbRow[0].meta || {}), bankMasked: patch.bank_account_masked, bankCapturedAt: new Date().toISOString() };
            const steps = (onbRow[0].steps || []).map((st: any) => st.key === 'bank' ? { ...st, status: 'complete', completedAt: new Date().toISOString() } : st);
            await admin.from('wf_onboarding').update({ meta, steps }).eq('id', onbRow[0].id);
          }
        } catch { /* best effort */ }
      }
      return json({ ok: true });
    }

    return json({ error: `unknown action: ${action}` }, 400);
  } catch (e) {
    console.error('[staff-portal]', e);
    return json({ error: (e as Error).message || 'server error' }, 500);
  }
});
