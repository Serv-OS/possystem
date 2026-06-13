// supabase/functions/review-reply/index.ts
//
// Send/post an APPROVED reply. One entry point for "comment and send back":
//   • synced platform review  → postReply() back to the originating platform
//                                (Google/TripAdvisor/Facebook) via the adapter.
//   • private (under-threshold) → send the recovery message to the guest over
//                                their contact channel (SMS, else email).
//   • card-origin public       → record the reply (no external thread to post to).
// Records the result on review_replies and marks the feedback resolved. Auth:
// a staff user with access to the feedback's location (or super_admin).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { postReply, type Platform } from '../_shared/review-platforms.ts';
import { accessTokenFrom, replyToReview } from '../_shared/google-reviews.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

async function callerWithAccess(req: Request, opsLocationId: string): Promise<{ id: string | null } | null> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return null;
  if (token === SERVICE_ROLE) return { id: null };   // trusted internal/cron caller
  const { data: { user } } = await opsAdmin.auth.getUser(token);
  if (!user) return null;
  const { data: ul } = await opsAdmin.from('user_locations').select('location_id').eq('user_id', user.id).eq('location_id', opsLocationId).maybeSingle();
  if (ul) return { id: user.id };
  const { data: prof } = await opsAdmin.from('user_profiles').select('role').eq('id', user.id).maybeSingle();
  return prof?.role === 'super_admin' ? { id: user.id } : null;
}

async function callFn(name: string, payload: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify(payload),
    });
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok && !j.error, error: j.error };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const feedbackId = String(body.feedback_id ?? '').trim();
  const text = String(body.text ?? '').trim();
  if (!feedbackId || !text) return json({ error: 'feedback_id and text required' }, 400);

  const { data: fb } = await opsAdmin.from('review_feedback')
    .select('id, location_id, is_public, source_platform, external_review_id, customer_email, customer_phone, customer_name').eq('id', feedbackId).maybeSingle();
  if (!fb) return json({ error: 'feedback not found' }, 404);

  const caller = await callerWithAccess(req, fb.location_id);
  if (!caller) return json({ error: 'no access to this location' }, 403);

  // Reuse the feedback's pending reply row if there is one, else create.
  const { data: existingReply } = await opsAdmin.from('review_replies')
    .select('id').eq('feedback_id', feedbackId).order('created_at', { ascending: true }).limit(1).maybeSingle();
  const nowIso = new Date().toISOString();

  async function recordReply(kind: string, status: string) {
    const patch = { kind, edited_text: text, status, approved_by: caller!.id, sent_at: nowIso, updated_at: nowIso, location_id: fb.location_id, feedback_id: feedbackId };
    if (existingReply) await opsAdmin.from('review_replies').update(patch).eq('id', existingReply.id);
    else await opsAdmin.from('review_replies').insert(patch);
  }

  // ── synced platform review → post the reply back to the source platform ───
  if (fb.source_platform) {
    const platform = fb.source_platform as Platform;
    // Google: post for real via the Business Profile API using the venue's token.
    if (platform === 'google' && fb.external_review_id) {
      try {
        const { data: t } = await opsAdmin.from('review_google_tokens').select('refresh_token').eq('location_id', fb.location_id).maybeSingle();
        if (!t?.refresh_token) throw new Error('Google not connected for this location');
        const at = await accessTokenFrom(t.refresh_token);
        await replyToReview(at, fb.external_review_id, text);
        await recordReply('public_reply', 'posted');
        await opsAdmin.from('review_feedback').update({ status: 'resolved', updated_at: nowIso }).eq('id', feedbackId);
        return json({ ok: true, mode: 'api', message: 'Posted to Google.' });
      } catch (e) {
        await recordReply('public_reply', 'approved');
        return json({ ok: false, mode: 'api', error: (e as Error).message }, 502);
      }
    }
    // Other platforms: adapter (stubbed/manual until their API is wired).
    const { data: link } = await opsAdmin.from('review_platform_links')
      .select('platform, url, external_place_id').eq('location_id', fb.location_id).eq('platform', platform).maybeSingle();
    const result = await postReply({ platform, url: link?.url, external_place_id: link?.external_place_id }, text);
    await recordReply('public_reply', result.mode === 'api' ? 'posted' : 'approved');
    await opsAdmin.from('review_feedback').update({ status: 'resolved', updated_at: nowIso }).eq('id', feedbackId);
    return json({ ok: true, mode: result.mode, manual_url: result.manual_url, message: result.message });
  }

  // ── private (under-threshold) feedback → send the recovery to the guest ───
  if (!fb.is_public) {
    let channel: string | null = null; let sendErr: string | undefined;
    if (fb.customer_phone) {
      const r = await callFn('send-sms', { to: fb.customer_phone, message: text, location_id: fb.location_id, type: 'review_reply', reference_id: feedbackId });
      if (r.ok) channel = 'sms'; else sendErr = r.error;
    }
    if (!channel && fb.customer_email) {
      const r = await callFn('send-receipt', { to: fb.customer_email, subject: 'A note from us', html: `<p>${text.replace(/</g, '&lt;')}</p>`, location_id: fb.location_id });
      if (r.ok) channel = 'email'; else sendErr = sendErr || r.error;
    }
    await recordReply('private_recovery', channel ? 'sent' : 'approved');
    await opsAdmin.from('review_feedback').update({ status: 'resolved', updated_at: nowIso }).eq('id', feedbackId);
    if (!channel && !fb.customer_phone && !fb.customer_email) {
      return json({ ok: true, channel: null, message: 'Reply saved — guest left no contact details to send to.' });
    }
    return json({ ok: !!channel, channel, message: channel ? `Sent via ${channel}.` : `Could not send: ${sendErr || 'no channel'}` });
  }

  // ── card-origin public review with no platform thread → just record ───────
  await recordReply('public_reply', 'approved');
  return json({ ok: true, mode: 'recorded', message: 'Reply saved.' });
});
