// supabase/functions/venue-messages-admin/index.ts
//
// MESSAGES FROM SERVOS TO VENUES: send, list, send again, withdraw. ServOS staff only.
//
// WHY (Peter, 5 Oct 2026): "we need to be able to send a notification, like a message, to all
// customers or certain customers asking them to do things, like a POP UP from the admin."
// The pop up appears on every till and Back Office of the chosen venues and stays until someone
// taps Got it. That is a loud voice: whoever can call this can put words on every till in the
// estate under the heading "Message from ServOS". So the door is narrow.
//
// THE FENCE (in this order, do not reorder)
//   1. A real sign in that has done its SECOND STEP, switch or no switch (requireAal2, the same
//      bar as resetting somebody's second step). The Company Admin portal already makes every
//      sign in do it, so nobody real is refused.
//   2. The token must belong to a real user (getUser), never an anonymous session: every till,
//      kiosk and customer page holds one of those for free.
//   3. That user's user_profiles.role must be 'super_admin', read here with the service role.
//      WHY THE ROLE CAN BE TRUSTED: a login cannot give itself a role. Checked on the live
//      database on 5 Oct 2026: the user_profiles_role_guard trigger and the restrictive
//      up_insert_super_admin_only / up_delete_super_admin_only policies (20260915c, 20260919a1)
//      are in place, and two profiles hold the role. Venue owners and managers are never ServOS
//      staff here, whatever they hold in user_locations or user_company_roles.
//
// THE TABLE (20261005a_OPS_venue_messages.sql) has no insert, update or delete policy and no
// write grant: this function, under the service role, is the only writer besides the venue's
// own Got it (public.venue_message_confirm). Recipients are checked against the server's own
// list of venues, so a made up venue id is never written.
//
//   list      {}                                           -> { venues, rows }
//   send      { title?, body, kind, company_ids?, venue_ids?, broadcast_id? }
//                                                          -> { broadcast_id, sent, written }
//             (409 already_sent when that broadcast_id already holds a DIFFERENT text)
//   resend    { broadcast_id }   only the venues still waiting -> { resent }
//   withdraw  { broadcast_id }   gone from every screen        -> { withdrawn }
//
// Deploy: npx supabase functions deploy venue-messages-admin --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireAal2, bearerToken } from '../_shared/second-step.ts';
import { cleanDraft, expandRecipients, isUuid, oneLine, sameMessage, MAX_VENUES_PER_SEND, NAME_MAX } from '../_shared/venueMessageRules.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const NOT_READY = 'Run the database update first (20261005a_OPS_venue_messages.sql). Nothing was sent.';
const LIST_DAYS = 90;
const PAGE = 1000;       // PostgREST never returns more than 1000 rows a request, whatever the limit says
const MAX_ROWS = 10000;

// The table is not there yet: say so plainly instead of a raw database error.
const isMissingTable = (e: any) => {
  const code = String(e?.code ?? '');
  if (code === '42P01' || code === 'PGRST205') return true;
  return /venue_messages/i.test(String(e?.message ?? '')) && /(does not exist|could not find|schema cache)/i.test(String(e?.message ?? ''));
};
const dbRefusal = (e: any) => (isMissingTable(e)
  ? json({ error: NOT_READY, code: 'not_ready' }, 409)
  : json({ error: 'The database refused that. Nothing was changed.', detail: String(e?.message ?? '') }, 500));

type Venue = { id: string; name: string; org_id: string | null; org_name: string; timezone: string | null; status: string | null };

async function loadVenues(): Promise<{ venues: Venue[]; error: any }> {
  const [locs, orgs] = await Promise.all([
    admin.from('locations').select('id, name, org_id, timezone, status').order('name').range(0, PAGE - 1),
    admin.from('organisations').select('id, name').range(0, PAGE - 1),
  ]);
  if (locs.error) return { venues: [], error: locs.error };
  const orgName = new Map<string, string>((orgs.data ?? []).map((o: any) => [String(o.id), String(o.name ?? '')]));
  const venues = (locs.data ?? []).map((l: any) => ({
    id: String(l.id), name: String(l.name ?? ''), org_id: l.org_id ? String(l.org_id) : null,
    org_name: l.org_id ? (orgName.get(String(l.org_id)) ?? '') : '', timezone: l.timezone ?? null, status: l.status ?? null,
  }));
  return { venues, error: null };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // 1. A real sign in with its second step done, always (docs/SECOND_STEP.md).
  const needs = requireAal2(req, [SERVICE_ROLE]);
  if (needs) return needs;

  // 2. A real user, never an anonymous session and never the service key itself (a message
  //    must have a person behind it).
  const token = bearerToken(req);
  if (!token || token === SERVICE_ROLE) return json({ error: 'Sign in to Company Admin first.' }, 401);
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user || !user.id) return json({ error: 'Sign in to Company Admin first.' }, 401);
  if (user.is_anonymous) return json({ error: 'Only ServOS staff can do this.' }, 403);

  // 3. ServOS staff: the role on the profile, read with the service role (see the header).
  const { data: profile, error: profErr } = await admin.from('user_profiles')
    .select('role, full_name, email').eq('id', user.id).maybeSingle();
  if (profErr || profile?.role !== 'super_admin') return json({ error: 'Only ServOS staff can do this.' }, 403);
  const senderName = oneLine(profile.full_name || profile.email || user.email || 'ServOS').slice(0, NAME_MAX);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? '');

  // ── list: every venue (for the tick list) and every message of the last 90 days ──────────
  if (action === 'list') {
    const { venues, error: vErr } = await loadVenues();
    if (vErr) return dbRefusal(vErr);
    const since = new Date(Date.now() - LIST_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const rows: any[] = [];
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      const { data, error } = await admin.from('venue_messages').select('*')
        .gte('sent_at', since).order('sent_at', { ascending: false }).order('id').range(from, from + PAGE - 1);
      if (error) {
        if (isMissingTable(error)) return json({ venues, rows: [], ready: false, note: NOT_READY });
        return dbRefusal(error);
      }
      rows.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }
    return json({ venues, rows, ready: true, days: LIST_DAYS });
  }

  // ── send ─────────────────────────────────────────────────────────────────────────────────
  if (action === 'send') {
    const draft = cleanDraft({ title: body?.title, body: body?.body, kind: body?.kind });
    if (!draft.ok) return json({ error: draft.error, code: 'bad_message' }, 400);
    const companyIds = Array.isArray(body?.company_ids) ? body.company_ids.filter(isUuid) : [];
    const venueIds = Array.isArray(body?.venue_ids) ? body.venue_ids.filter(isUuid) : [];
    const { venues, error: vErr } = await loadVenues();
    if (vErr) return dbRefusal(vErr);
    const picked = expandRecipients({ companyIds, venueIds, venues });
    if (!picked.venueIds.length) return json({ error: 'Tick at least one venue.', code: 'no_venues' }, 400);
    if (picked.venueIds.length > MAX_VENUES_PER_SEND) return json({ error: `That is more than ${MAX_VENUES_PER_SEND} venues in one send.`, code: 'too_many' }, 400);
    // The screen counted the venues before asking "Send to 6 venues?". If the server's count is
    // different (a venue was removed meanwhile), stop: never send to a number nobody agreed to.
    if (body?.expect_count != null && Number(body.expect_count) !== picked.venueIds.length) {
      return json({ error: 'The list of venues changed. Check the ticks and send again.', code: 'count_changed', count: picked.venueIds.length }, 409);
    }
    // The screen sends its own id for the send, so a retry after a lost reply cannot send twice
    // (one row per broadcast per venue, enforced by the table).
    const broadcastId = isUuid(body?.broadcast_id) ? String(body.broadcast_id) : crypto.randomUUID();
    // One broadcast_id is ONE text, always. If the first reply was lost, the screen still holds
    // the same id; if the words (or the kind) were changed before trying again, writing would
    // skip the venues that already have the old words and give the new words to any venue added
    // since, all under one id, and the Sent list would show one text for both. So: same words =
    // a true retry, carry on; different words = stop and say it was already sent.
    if (isUuid(body?.broadcast_id)) {
      const { data: prior, error: priorErr } = await admin.from('venue_messages')
        .select('kind, title, body').eq('broadcast_id', broadcastId).limit(1);
      if (priorErr) return dbRefusal(priorErr);
      const was = (prior ?? [])[0];
      if (was && !sameMessage(was, draft)) {
        return json({ error: 'That message was already sent before you changed it. Check the Sent list: withdraw the old one if it is wrong, then send this one.', code: 'already_sent' }, 409);
      }
    }
    const sentAt = new Date().toISOString();
    const rows = picked.venueIds.map((location_id: string) => ({
      broadcast_id: broadcastId, location_id, kind: draft.kind, title: draft.title, body: draft.body,
      sent_by: user.id, sent_by_name: senderName, sent_at: sentAt,
    }));
    const { data, error } = await admin.from('venue_messages')
      .upsert(rows, { onConflict: 'broadcast_id,location_id', ignoreDuplicates: true }).select('id');
    if (error) return dbRefusal(error);
    // sent = the venues asked for; written = the rows this call really added (0 on a pure retry).
    return json({ ok: true, broadcast_id: broadcastId, sent: picked.venueIds.length, written: (data ?? []).length });
  }

  // ── resend / withdraw: one message, by its broadcast id ─────────────────────────────────
  if (action === 'resend' || action === 'withdraw') {
    const broadcastId = String(body?.broadcast_id ?? '');
    if (!isUuid(broadcastId)) return json({ error: 'broadcast_id required' }, 400);
    const now = new Date().toISOString();
    if (action === 'resend') {
      // Only the venues still waiting. It chimes again there; nothing changes anywhere else.
      const { data, error } = await admin.from('venue_messages').update({ resent_at: now })
        .eq('broadcast_id', broadcastId).is('confirmed_at', null).is('withdrawn_at', null).select('id');
      if (error) return dbRefusal(error);
      return json({ ok: true, resent: (data ?? []).length });
    }
    // Withdraw: every copy, confirmed ones included, so it also reads "Withdrawn" in each
    // venue's own list. A confirmation already given is kept on the row.
    const { data, error } = await admin.from('venue_messages').update({ withdrawn_at: now, withdrawn_by: senderName })
      .eq('broadcast_id', broadcastId).is('withdrawn_at', null).select('id');
    if (error) return dbRefusal(error);
    return json({ ok: true, withdrawn: (data ?? []).length });
  }

  return json({ error: 'unknown action' }, 400);
});
