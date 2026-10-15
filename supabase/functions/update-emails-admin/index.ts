// supabase/functions/update-emails-admin/index.ts
//
// EMAIL AN UPDATE TO BACK OFFICE LOGINS: who gets it, a test to yourself, the send, the history.
// ServOS staff only.
//
// WHY (Peter, 8 Oct 2026): he writes a what's new email for clients each week. "Do we have a way
// to email it to people that are registered in the back office? Right now it's only a few and I
// can manually send, but would be good to be able to send it out."
//
// Whoever can call this can write to every owner and manager of every venue as ServOS. So the
// door is as narrow as venue-messages-admin's, and in the same order:
//   1. A real sign in that has done its SECOND STEP (requireAal2). The Company Admin portal
//      already makes every sign in do it, so nobody real is refused.
//   2. The token must belong to a real user (getUser), never an anonymous session.
//   3. That user's user_profiles.role must be 'super_admin', read here with the service role
//      (a login cannot give itself that role: user_profiles_role_guard, 20260915c / 20260919a1).
//
// THE TABLE (20261008b_OPS_update_emails.sql) has no policy and no grant for anon or
// authenticated: this function, under the service role, is its only reader and writer.
//
// THE RULES live in ../_shared/updateEmailRules.js and are the same file the admin screen
// previews with, so what the screen shows is what is sent. This file only reads the database,
// talks to the mail provider and writes the rows.
//
//   recipients { company_ids?, owners_only?, include_staff? }
//                -> { recipients, count, left, companies }
//   test       { subject, body_md }                 the caller only, [TEST] on the subject
//                -> { sent, failed, to, error? }
//   send       { subject, body_md, company_ids?, owners_only?, include_staff?, expect_count, expect_emails?, broadcast_id }
//                -> { broadcast_id, sent, failed, skipped, waiting, total }
//              409 count_changed  the server's list is not the size (or not the people) the screen showed
//              409 already_sent   that broadcast_id already holds a DIFFERENT text
//              409 test_first     no test of this exact text has gone to the caller yet
//              409 no_provider    email sending is not set up on the server
//   history    {}                -> { rows, companies, ready, from, provider_ready }
//
// Deploy: npx supabase functions deploy update-emails-admin --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireAal2, bearerToken } from '../_shared/second-step.ts';
// @ts-ignore plain JS shared with node tests
import {
  cleanDraft, pickRecipients, countByCompany, buildEmail, servosSender, providerRequest, providerMessageId, providerReady,
  deliverAll, stillToSend, sortPriorRows, splitOwned, sameText, sameRecipientSet, idempotencyKey, retryDelayMs,
  isUuid, isEmail, oneLine, NAME_MAX, MAX_RECIPIENTS_PER_SEND, NO_PROVIDER_LINE, SEND_GAP_MS, PROVIDER_TIMEOUT_MS, STALE_QUEUED_MS,
} from '../_shared/updateEmailRules.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

// The same provider plumbing as send-welcome and send-receipt. EMAIL_PROVIDER is read first for
// a future split; today RECEIPT_EMAIL_PROVIDER is the one that is set.
const EMAIL_PROVIDER = (Deno.env.get('EMAIL_PROVIDER') || Deno.env.get('RECEIPT_EMAIL_PROVIDER') || 'log').toLowerCase();
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const POSTMARK_KEY = Deno.env.get('POSTMARK_API_TOKEN') ?? '';
// ServOS writing to its clients: the ServOS address, never a venue's branded domain.
const SENDER = servosSender(Deno.env.get('RECEIPT_EMAIL_FROM') || '');
const PROVIDER_READY = providerReady({ provider: EMAIL_PROVIDER, resendKey: RESEND_KEY, postmarkKey: POSTMARK_KEY });

const NOT_READY = 'Run the database update first (20261008b_OPS_update_emails.sql). Nothing was sent.';
const HISTORY_DAYS = 180;
const PAGE = 1000;       // PostgREST never returns more than 1000 rows a request, whatever the limit says
const MAX_ROWS = 10000;
// One request at a time with SEND_GAP_MS between them (8 Oct 2026, review): two workers firing
// back to back made 6 to 8 requests a second against Resend's 2 and failed people on our own
// pace. 100 people (the cap) take about 90 seconds this way, inside the function's wall clock.
const SEND_CONCURRENCY = 1;
const TEST_ROWS_TO_CHECK = 20;   // the sender's most recent tests of this subject, compared in code

// The table is not there yet: say so plainly instead of a raw database error.
const isMissingTable = (e: any) => {
  const code = String(e?.code ?? '');
  if (code === '42P01' || code === 'PGRST205') return true;
  return /update_emails/i.test(String(e?.message ?? '')) && /(does not exist|could not find|schema cache)/i.test(String(e?.message ?? ''));
};
const dbRefusal = (e: any) => (isMissingTable(e)
  ? json({ error: NOT_READY, code: 'not_ready' }, 409)
  : json({ error: 'The database refused that. Nothing was changed.', detail: String(e?.message ?? '') }, 500));

type Profile = { id: string; org_id: string | null; full_name: string | null; role: string | null; email: string | null; bo_access: boolean | null };
type Org = { id: string; name: string; status: string | null };
type Recipient = { userId: string; email: string; name: string; role: string; orgId: string | null; company: string };
type SendOut = { ok: boolean; id?: string | null; error?: string };

async function pagedSelect(table: string, columns: string, shape: (q: any) => any): Promise<{ rows: any[]; error: any }> {
  const rows: any[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await shape(admin.from(table).select(columns)).range(from, from + PAGE - 1);
    if (error) return { rows, error };
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return { rows, error: null };
}

/**
 * Every login that could be a recipient, with its SIGN IN email. The profile's email column is
 * only a fallback: the address a person signs in with is the one that reaches them, and the
 * admin API is the only way to read auth.users. One getUserById per candidate (tens of logins,
 * never the till fleet: listUsers would page through thousands of anonymous device sessions).
 */
async function loadPeople(): Promise<{ profiles: Profile[]; orgs: Org[]; authEmails: Map<string, string>; error: any }> {
  const [prof, orgs] = await Promise.all([
    pagedSelect('user_profiles', 'id, org_id, full_name, role, email, bo_access', (q) => q.in('role', ['owner', 'manager', 'super_admin']).order('id')),
    pagedSelect('organisations', 'id, name, status', (q) => q.order('name')),
  ]);
  if (prof.error) return { profiles: [], orgs: [], authEmails: new Map(), error: prof.error };
  if (orgs.error) return { profiles: [], orgs: [], authEmails: new Map(), error: orgs.error };
  const profiles: Profile[] = prof.rows.map((p: any) => ({
    id: String(p.id), org_id: p.org_id ? String(p.org_id) : null, full_name: p.full_name ?? null, role: p.role ?? null, email: p.email ?? null, bo_access: p.bo_access ?? null,
  }));
  const authEmails = new Map<string, string>();
  const candidates = profiles.filter((p) => p.bo_access !== false);
  for (let i = 0; i < candidates.length; i += 10) {
    await Promise.all(candidates.slice(i, i + 10).map(async (p) => {
      try {
        const { data } = await admin.auth.admin.getUserById(p.id);
        const u = (data as any)?.user;
        if (u && !u.is_anonymous && isEmail(String(u.email ?? ''))) authEmails.set(p.id, String(u.email));
      } catch { /* the profile email is the fallback */ }
    }));
  }
  const orgList: Org[] = orgs.rows.map((o: any) => ({ id: String(o.id), name: String(o.name ?? ''), status: o.status ?? null }));
  return { profiles, orgs: orgList, authEmails, error: null };
}

/** The three choices on the screen, read once, the same way for recipients and send. */
function readOptions(body: any): { companyIds: string[] | null; ownersOnly: boolean; includeStaff: boolean } {
  const companyIds = Array.isArray(body?.company_ids) ? body.company_ids.filter(isUuid).map(String) : null;
  return { companyIds, ownersOnly: body?.owners_only === true, includeStaff: body?.include_staff === true };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The ONE place an email leaves this function. One provider request per recipient, carrying an
 * idempotency key (broadcast id and address) so a request repeated after a lost reply is the
 * same email to Resend. A 429 is tried again at the pace Retry-After asks; a 5xx, a network
 * failure or the timeout a few times more; any other refusal is that recipient's error and does
 * not stop the others (retryDelayMs, deliverAll).
 */
function makeSendOne(broadcastId: string, subject: string, bodyMd: string, test: boolean) {
  return async (r: Recipient): Promise<SendOut> => {
    const email = buildEmail({ subject, bodyMd, companyName: r.company, test });
    const spec = providerRequest({
      provider: EMAIL_PROVIDER, resendKey: RESEND_KEY, postmarkKey: POSTMARK_KEY, sender: SENDER, to: r.email,
      subject: email.subject, html: email.html, text: email.text, idempotencyKey: idempotencyKey(broadcastId, r.email),
    });
    if (!spec) return { ok: false, error: NO_PROVIDER_LINE };
    let lastError = '';
    for (let attempt = 1; ; attempt++) {
      let status: number | null = null;
      let retryAfter: string | null = null;
      try {
        // A hung connection becomes this row's failure after PROVIDER_TIMEOUT_MS, never a run
        // that sits on its queued rows until the wall clock kills it.
        const res = await fetch(spec.url, { method: 'POST', headers: spec.headers, body: JSON.stringify(spec.body), signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
        const j = await res.json().catch(() => ({}));
        if (res.ok) return { ok: true, id: providerMessageId(EMAIL_PROVIDER, j) };
        status = res.status;
        retryAfter = res.headers.get('retry-after');
        lastError = String(j?.message || j?.Message || `${EMAIL_PROVIDER} HTTP ${res.status}`);
      } catch (e) {
        lastError = String((e as any)?.message ?? e);
      }
      const delay = retryDelayMs({ status, attempt, retryAfter });
      if (delay == null) return { ok: false, error: lastError || 'The email provider did not answer.' };
      await wait(delay);
    }
  };
}

/**
 * Send to these people and write each person's row (sent or failed, the provider's id or its
 * error) straight after THEIR email, never after everybody's (8 Oct 2026, review: with the
 * writes at the end, a run killed mid way left every row queued although the emails had gone).
 * A row write that fails is logged and the email still counts as sent: the row stays queued, a
 * try after STALE_QUEUED_MS would claim it, and the idempotency key stops a second copy.
 */
async function deliverAndRecord(broadcastId: string, list: Recipient[], sendOne: (r: Recipient) => Promise<SendOut>, opts: { concurrency: number; minGapMs?: number }) {
  return await deliverAll(list, async (r: Recipient) => {
    const out = (await sendOne(r)) || { ok: false, error: 'The email provider refused it.' };
    const { error } = await admin.from('update_emails')
      .update({ status: out.ok ? 'sent' : 'failed', provider_id: out.ok ? (out.id ?? null) : null, error: out.ok ? null : String(out.error ?? '').slice(0, 500), sent_at: new Date().toISOString() })
      .eq('broadcast_id', broadcastId).eq('to_email', r.email);
    if (error) console.error('[update-emails-admin] row not written after the email', r.email, error.message);
    return out;
  }, opts);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // 1. A real sign in with its second step done, always (docs/SECOND_STEP.md).
  const needs = requireAal2(req, [SERVICE_ROLE]);
  if (needs) return needs;

  // 2. A real user, never an anonymous session and never the service key itself (an email must
  //    have a person behind it).
  const token = bearerToken(req);
  if (!token || token === SERVICE_ROLE) return json({ error: 'Sign in to Company Admin first.' }, 401);
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user || !user.id) return json({ error: 'Sign in to Company Admin first.' }, 401);
  if (user.is_anonymous) return json({ error: 'Only ServOS staff can do this.' }, 403);

  // 3. ServOS staff: the role on the profile, read with the service role (see the header).
  const { data: profile, error: profErr } = await admin.from('user_profiles')
    .select('role, full_name, email, org_id').eq('id', user.id).maybeSingle();
  if (profErr || profile?.role !== 'super_admin') return json({ error: 'Only ServOS staff can do this.' }, 403);
  const senderName = oneLine(profile.full_name || profile.email || user.email || 'ServOS').slice(0, NAME_MAX);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? '');

  // ── recipients: who the current choices reach, for the list the admin checks before Send ──
  if (action === 'recipients') {
    const opts = readOptions(body);
    const people = await loadPeople();
    if (people.error) return dbRefusal(people.error);
    const { recipients, left } = pickRecipients({ ...people, ...opts });
    // Per company counts for the tick list, with the same owners / staff choices and every
    // company picked, so a company's number does not change as companies are ticked.
    const everyCompany = pickRecipients({ ...people, companyIds: null, ownersOnly: opts.ownersOnly, includeStaff: opts.includeStaff });
    const perCompany = countByCompany(everyCompany.recipients);
    const companies = people.orgs.map((o) => ({ id: o.id, name: o.name, status: o.status, count: perCompany.get(o.id) || 0 }));
    return json({ ok: true, recipients, count: recipients.length, left, companies });
  }

  // ── history: every send of the last 180 days, one row per person ─────────────────────────
  if (action === 'history') {
    const { rows: orgRows, error: oErr } = await pagedSelect('organisations', 'id, name, status', (q) => q.order('name'));
    if (oErr) return dbRefusal(oErr);
    const companies = orgRows.map((o: any) => ({ id: String(o.id), name: String(o.name ?? ''), status: o.status ?? null }));
    const since = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { rows, error } = await pagedSelect('update_emails', '*', (q) => q.gte('sent_at', since).order('sent_at', { ascending: false }).order('id'));
    if (error) {
      if (isMissingTable(error)) return json({ rows: [], companies, ready: false, note: NOT_READY, from: SENDER.from, provider_ready: PROVIDER_READY });
      return dbRefusal(error);
    }
    return json({ rows, companies, ready: true, days: HISTORY_DAYS, from: SENDER.from, provider_ready: PROVIDER_READY });
  }

  // ── test: the caller only, [TEST] on the subject, recorded like any send ─────────────────
  if (action === 'test') {
    const draft = cleanDraft({ subject: body?.subject, body_md: body?.body_md });
    if (!draft.ok) return json({ error: draft.error, code: 'bad_message' }, 400);
    if (!PROVIDER_READY) return json({ error: NO_PROVIDER_LINE, code: 'no_provider' }, 409);
    const to = String(user.email ?? profile.email ?? '').trim().toLowerCase();
    if (!isEmail(to)) return json({ error: 'Your sign in has no email address to test with.', code: 'no_email' }, 400);
    const me: Recipient = { userId: user.id, email: to, name: senderName, role: 'super_admin', orgId: profile.org_id ? String(profile.org_id) : null, company: 'ServOS' };
    const broadcastId = crypto.randomUUID();
    // The row first: a test that cannot be recorded is not sent (the record is what lets the
    // real send through later).
    const { error: insErr } = await admin.from('update_emails').insert({
      broadcast_id: broadcastId, subject: draft.subject, body_md: draft.bodyMd, to_email: to, to_user_id: user.id, to_name: senderName,
      org_id: me.orgId, role: 'super_admin', sent_by: user.id, sent_by_name: senderName, provider: EMAIL_PROVIDER, status: 'queued', is_test: true,
    });
    if (insErr) return dbRefusal(insErr);
    const [r] = await deliverAndRecord(broadcastId, [me], makeSendOne(broadcastId, draft.subject, draft.bodyMd, true), { concurrency: 1 });
    if (!r.ok) return json({ error: `The test did not send: ${r.error}`, code: 'send_failed', to }, 502);
    return json({ ok: true, sent: 1, failed: 0, to });
  }

  // ── send ─────────────────────────────────────────────────────────────────────────────────
  if (action === 'send') {
    const draft = cleanDraft({ subject: body?.subject, body_md: body?.body_md });
    if (!draft.ok) return json({ error: draft.error, code: 'bad_message' }, 400);
    if (!PROVIDER_READY) return json({ error: NO_PROVIDER_LINE, code: 'no_provider' }, 409);
    // The screen always sends its own id: a retry after a lost reply must be the same send.
    if (!isUuid(body?.broadcast_id)) return json({ error: 'broadcast_id required', code: 'bad_request' }, 400);
    if (body?.expect_count == null || !Number.isFinite(Number(body.expect_count))) return json({ error: 'expect_count required', code: 'bad_request' }, 400);
    const broadcastId = String(body.broadcast_id);
    const opts = readOptions(body);

    const people = await loadPeople();
    if (people.error) return dbRefusal(people.error);
    const { recipients } = pickRecipients({ ...people, ...opts }) as { recipients: Recipient[] };
    if (!recipients.length) return json({ error: 'Nobody matches those choices. Tick a company that has Back Office logins.', code: 'no_people' }, 400);
    if (recipients.length > MAX_RECIPIENTS_PER_SEND) return json({ error: `That is more than ${MAX_RECIPIENTS_PER_SEND} people in one send. Tick fewer companies.`, code: 'too_many', count: recipients.length }, 400);
    // The screen showed a list and a count and asked "Email 7 people now?". If the server's
    // list is another size (a login was added or removed meanwhile), stop: never email a number
    // nobody agreed to. The screen reloads the list and asks again.
    if (Number(body.expect_count) !== recipients.length) {
      return json({ error: 'The list of people changed. Check it and send again.', code: 'count_changed', count: recipients.length }, 409);
    }
    // And the same PEOPLE, when the screen says who it showed (8 Oct 2026, review: a tick swapped
    // for another company of the same size passed the count alone).
    if (!sameRecipientSet(body.expect_emails, recipients)) {
      return json({ error: 'The list of people changed. Check it and send again.', code: 'count_changed', count: recipients.length }, 409);
    }

    // One broadcast_id is ONE text, always. Same words = a true second try, carry on and skip
    // whoever already has it; different words = refuse, so one id can never mean two emails.
    const { data: prior, error: priorErr } = await admin.from('update_emails')
      .select('to_email, status, subject, body_md').eq('broadcast_id', broadcastId).eq('is_test', false).range(0, PAGE - 1);
    if (priorErr) return dbRefusal(priorErr);
    const priorRows = prior ?? [];
    if (priorRows.length && !sameText(priorRows[0], draft)) {
      return json({ error: 'That email was already sent before you changed it. See Sent below, then send this one as a new email.', code: 'already_sent' }, 409);
    }

    // Test first, on the server too: a test of THIS exact text must have reached the sender.
    // The body is compared in code, never put in the filter: a filter is the request URL, and a
    // long what's new (the screen allows 15,000 characters) overran the gateway's line limit
    // and blocked the send as "the database refused that" (8 Oct 2026, review).
    const { data: tested, error: testErr } = await admin.from('update_emails').select('subject, body_md')
      .eq('sent_by', user.id).eq('is_test', true).eq('status', 'sent').eq('subject', draft.subject)
      .order('sent_at', { ascending: false }).limit(TEST_ROWS_TO_CHECK);
    if (testErr) return dbRefusal(testErr);
    if (!(tested ?? []).some((row: any) => sameText(row, draft))) return json({ error: 'Send yourself a test of this text first.', code: 'test_first' }, 409);

    const { todo, skipped } = stillToSend(recipients, priorRows) as { todo: Recipient[]; skipped: number };
    if (!todo.length) return json({ ok: true, broadcast_id: broadcastId, sent: 0, failed: 0, skipped, waiting: 0, total: recipients.length });

    // OWN the rows before anything leaves (8 Oct 2026, review: a second Send while the first was
    // still going emailed everyone twice). This run emails only the people whose row it made or
    // claimed; a row another run holds (queued less than STALE_QUEUED_MS ago) is left to it.
    //   1. Queue a row per person. ignoreDuplicates keeps every existing row, and the select gives
    //      back only the rows THIS call inserted (the venue-messages "written" pattern).
    const nowMs = Date.now();
    const queuedAt = new Date(nowMs).toISOString();
    const rows = todo.map((r) => ({
      broadcast_id: broadcastId, subject: draft.subject, body_md: draft.bodyMd, to_email: r.email, to_user_id: r.userId, to_name: r.name || null,
      org_id: r.orgId, role: r.role, sent_by: user.id, sent_by_name: senderName, sent_at: queuedAt, provider: EMAIL_PROVIDER, status: 'queued', is_test: false,
    }));
    const { data: insertedRows, error: qErr } = await admin.from('update_emails')
      .upsert(rows, { onConflict: 'broadcast_id,to_email', ignoreDuplicates: true }).select('to_email');
    if (qErr) return dbRefusal(qErr);
    const inserted = (insertedRows ?? []).map((x: any) => String(x.to_email));

    //   2. Claim the rows a try can take again: failed, or queued so long ago that their run is
    //      dead. ONE update with the same test in its where clause, so two runs can never both
    //      take a row (the second sees the first's new sent_at and matches nothing). The stale
    //      cut off is a plain timestamp in the filter, as adyen-capture-sweep's own sweep filters are.
    const { retry } = sortPriorRows(todo, priorRows, nowMs) as { retry: Recipient[] };
    let claimed: string[] = [];
    if (retry.length) {
      const staleIso = new Date(Math.floor((nowMs - STALE_QUEUED_MS) / 1000) * 1000).toISOString().replace('.000Z', 'Z');
      const { data: claimedRows, error: cErr } = await admin.from('update_emails')
        .update({ status: 'queued', error: null, provider_id: null, sent_at: queuedAt, sent_by: user.id, sent_by_name: senderName })
        .eq('broadcast_id', broadcastId).eq('is_test', false).in('to_email', retry.map((r) => r.email))
        .or(`status.eq.failed,and(status.eq.queued,sent_at.lt.${staleIso})`)
        .select('to_email');
      if (cErr) return dbRefusal(cErr);
      claimed = (claimedRows ?? []).map((x: any) => String(x.to_email));
    }
    const { owned, waiting } = splitOwned(todo, inserted, claimed) as { owned: Recipient[]; waiting: Recipient[] };

    //   3. Send to the owned rows only, writing each row straight after its email.
    const results = await deliverAndRecord(broadcastId, owned, makeSendOne(broadcastId, draft.subject, draft.bodyMd, false), { concurrency: SEND_CONCURRENCY, minGapMs: SEND_GAP_MS });
    let sent = 0, failed = 0;
    for (const r of results) { if (r.ok) sent += 1; else failed += 1; }
    return json({ ok: true, broadcast_id: broadcastId, sent, failed, skipped, waiting: waiting.length, total: recipients.length });
  }

  return json({ error: 'unknown action' }, 400);
});
