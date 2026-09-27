// supabase/functions/customer-join-notice
//
// ONE SHORT EMAIL AFTER AN AUTOMATIC JOIN (27 Sep 2026). When a till joins a customer by email
// (the phone goes on the imported profile that has that email, or the empty profile the portal
// made from the phone is folded into it), the person who owns that email is told once:
//   "Your <venue> stamps and points are now linked to your phone ending 8167. If this wasn't you,
//    reply to this email or tell staff."
// Peter decided the join happens with no question to staff; an email is never verified, so this
// notice is how a wrong join gets noticed and undone.
//
//   POST { customer_id, location_id, source_id? }
//     customer_id  the profile that took the phone
//     source_id    the empty profile the merge core folded into it (a join made through
//                  customer-merge), when there was one
//     location_id  the venue the till is at
//
// WHO MAY ASK (18 Sep 2026: any JWT is not authority): a till BOUND to that venue, staff of the
// venue, or the service role. The venue must belong to the customer's organisation.
//
// WHAT IT CHECKS (_shared/emailJoinNotice.js decideJoinNotice, node tested): the profile is live,
// has an email and a phone, and its data shows an automatic join for THAT phone (the till's
// `email_join:<phone>` tag, or the merge core's trail on the folded in profile). The caller's word
// is never enough. At most one notice per phone: the profile is tagged `join_notice:<phone>` in
// one statement that only lands while the profile is exactly as read (updated_at), so two calls
// at once send one email. A send that fails takes the tag off again.
//
// HOW IT SENDS: through send-receipt with the service role, the path every server email takes
// (provider, the venue's own sending domain, and the receipt_emails audit row). The till never
// waits for this, and a failed email never undoes the join.
//
// Gift cards: nothing here reads or changes one (the 18 Sep 2026 rule stays: a card is shown only
// to the phone proved with the one time code).

import {
  cors, json, opsAdmin, platformAdmin, resolveVenue, callerStaffOrDevice, isServiceRoleRequest,
} from '../_shared/loyalty-utils.ts';
import { secondStepRefusal } from '../_shared/second-step.ts';
import { wrapInEmailHtml } from '../_shared/template-resolver.ts';
import { maskEmail, union } from '../_shared/customerMergePlan.js';
import {
  validateNoticeRequest, decideJoinNotice, joinNoticeMessage, noticeVenueName, escapeHtml, lastFour,
  NOTICE_CUSTOMER_COLS, NOTICE_SOURCE_COLS,
} from '../_shared/emailJoinNotice.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

/** Send through send-receipt (provider, branded sender, receipt_emails audit). Never throws. */
async function sendViaReceipt(locationId: string, to: string, subject: string, html: string, text: string): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-receipt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify({ location_id: locationId, to, subject, html, text }),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    console.warn('[customer-join-notice] send-receipt call failed:', (e as any)?.message || e);
    return { ok: false, status: 0 };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  if (req.method !== 'POST') return json({ ok: false, code: 'bad_request', error: 'POST only' }, 405);

  let body: unknown = null;
  try { body = await req.json(); } catch { return json({ ok: false, code: 'bad_request', error: 'invalid json' }, 400); }
  // JS module, loosely typed here: the shapes are pinned by src/lib/emailJoinNotice.test.js.
  const r: any = validateNoticeRequest(body);
  if (!r.ok) return json({ ok: false, code: 'bad_request', error: r.error }, 400);

  // ── who is asking ──
  const service = isServiceRoleRequest(req);
  let caller = 'service';
  let user: any = null;
  if (!service) {
    const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
    if (!token) return json({ ok: false, code: 'sign_in', error: 'Sign in first.' }, 401);
    const { data } = await opsAdmin.auth.getUser(token);
    user = data?.user ?? null;
    if (!user) return json({ ok: false, code: 'sign_in', error: 'Sign in first.' }, 401);
  }

  // ── the venue and its organisation (always the OPS row's org) ──
  const venue = await resolveVenue(r.locationId);
  if (!venue.opsLocationId) return json({ ok: false, code: 'no_venue', error: 'That venue could not be found.' }, 404);
  if (!service) {
    const f = await callerStaffOrDevice(user, venue.opsLocationId, venue.companyId);
    if (!f.staff && !f.device) {
      console.warn('[customer-join-notice] refused', JSON.stringify({ reason: 'not_allowed', caller_id: user?.id, location_id: venue.opsLocationId }));
      return json({ ok: false, code: 'not_allowed', error: 'Not allowed.' }, 403);
    }
    caller = f.staff ? 'staff' : 'device';
  }
  const { data: vloc } = await opsAdmin.from('locations').select('org_id, name').eq('id', venue.opsLocationId).maybeSingle();
  const venueOrgId: string | null = (vloc as any)?.org_id ?? null;

  // ── the profile, and the folded in one when there was a merge ──
  const { data: customer, error: readErr } = await opsAdmin.from('customers')
    .select(NOTICE_CUSTOMER_COLS).eq('id', r.customerId).maybeSingle();
  if (readErr) {
    console.warn('[customer-join-notice] read failed:', readErr.message);
    return json({ ok: false, code: 'read_failed', error: 'Try again.' }, 503);
  }
  let source: any = null;
  if (r.sourceId) {
    const { data: s } = await opsAdmin.from('customers').select(NOTICE_SOURCE_COLS).eq('id', r.sourceId).maybeSingle();
    source = s ?? null;
  }
  const decision: any = decideJoinNotice({ customer, source, venueOrgId });
  if (!decision.ok) {
    // Only the code: a till learns nothing else about the customer, and a profile of another
    // organisation reads as not found.
    console.log('[customer-join-notice] not sent', JSON.stringify({ code: decision.code, customer_id: r.customerId, location_id: venue.opsLocationId, caller }));
    return json({ ok: true, sent: false, code: decision.code === 'other_org' ? 'not_found' : decision.code });
  }
  const c: any = customer;

  // ── claim the one notice for this phone: lands only while the profile is exactly as read ──
  const claimedAt = new Date().toISOString();
  const claimTags = union(Array.isArray(c.tags) ? c.tags : [], [decision.tag]);
  let claim = opsAdmin.from('customers').update({ tags: claimTags, updated_at: claimedAt })
    .eq('id', c.id).is('deleted_at', null).eq('phone', decision.phone);
  claim = c.updated_at == null ? claim.is('updated_at', null) : claim.eq('updated_at', c.updated_at);
  const { data: claimed, error: claimErr } = await claim.select('id');
  if (claimErr || !Array.isArray(claimed) || !claimed.length) {
    console.log('[customer-join-notice] not sent', JSON.stringify({ code: claimErr ? 'claim_failed' : 'changed', customer_id: c.id, location_id: venue.opsLocationId, caller, error: claimErr?.message ?? null }));
    return json({ ok: true, sent: false, code: claimErr ? 'claim_failed' : 'changed' });
  }

  // ── the email ──
  let platformName: string | null = null;
  try {
    const { data: pLoc } = await platformAdmin.from('locations').select('name')
      .or(`ops_location_id.eq.${venue.opsLocationId},id.eq.${venue.opsLocationId}`).limit(1).maybeSingle();
    platformName = (pLoc as any)?.name ?? null;
  } catch { platformName = null; }
  const venueName = noticeVenueName((vloc as any)?.name, platformName);
  const msg = joinNoticeMessage({ venueName, phone: decision.phone });
  const html = wrapInEmailHtml(escapeHtml(msg.text), { venueName: escapeHtml(venueName) });
  const sent = await sendViaReceipt(venue.opsLocationId, String(c.email).trim(), msg.subject, html, msg.text);

  if (!sent.ok) {
    // Take the claim off again, so a later join can still send it. Only while nothing else changed.
    try {
      await opsAdmin.from('customers').update({ tags: Array.isArray(c.tags) ? c.tags : [], updated_at: new Date().toISOString() })
        .eq('id', c.id).eq('updated_at', claimedAt);
    } catch { /* the tag stays: at worst no second try */ }
  }
  console.log('[customer-join-notice] ' + (sent.ok ? 'sent' : 'send failed'), JSON.stringify({
    customer_id: c.id, source_id: r.sourceId, location_id: venue.opsLocationId, caller, caller_id: user?.id ?? null,
    to: maskEmail(c.email), phone_ending: lastFour(decision.phone), send_status: sent.status,
  }));
  return json({ ok: true, sent: sent.ok });
});
