// supabase/functions/_shared/staffNotify.ts
//
// v5.11.101: tell members of staff something about their shifts (an open shift is up, a shift was
// offered to them, a manager decided). Used by staff-portal and manager-approve.
//
// TODAY: a text message through send-sms (the same sender as rota publish texts), the number read
// with the VENUE's country (_shared/regionPack.js toE164: a US venue's 801 555 1234 is +1, never +44).
// A person with no usable mobile is skipped and counted, never an error.
//
// PUSH AS WELL (5.11.102, review decision S5): each person with the staff app on their phone
// (push_devices, through their chat profile) also gets an app push. The text still goes to everyone
// as before: an accepted push is not a seen push. The push runs beside the texts and is given at most
// PUSH_CAP_MS in all, so it can never slow a shift change down. sent counts texts, as before.
//
// Never throws: a text that did not go is reported in the answer, and the shift change it is about
// has already happened.

import { toE164 } from './regionPack.js';
import { sendPushMany, restRpc, type PushDevice } from './push.ts';

export type NotifyPerson = { id?: string; name?: string | null; mobile?: string | null };
export type NotifyResult = { sent: number; skipped: number; failed: number; pushed?: number; texted?: number };

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const PUSH_CAP_MS = 3000;

async function sendOne(to: string, message: string, locationId: string, type: string, ref: string | null): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify({ to, message, location_id: locationId, type, reference_id: ref }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Text each person the same message. venue: the locations row (currency, and country if one is
 * ever added) so numbers read the venue's way. At most `limit` texts (an open shift at a big venue
 * must not text 300 people).
 */
export async function notifyStaff(
  venue: { id: string; currency?: string | null; country?: string | null },
  people: NotifyPerson[],
  message: string,
  { type = 'rota_notification', ref = null, limit = 60 }: { type?: string; ref?: string | null; limit?: number } = {},
): Promise<NotifyResult> {
  // MARKER 5.11.102 staffNotify notifyStaff push beside the text (review fix S5)
  const out: NotifyResult = { sent: 0, skipped: 0, failed: 0, pushed: 0, texted: 0 };
  const started = Date.now();
  const pushing = pushStaff((people || []).map((p) => p?.id).filter((x): x is string => typeof x === 'string'),
    { title: (venue as any)?.name || 'ServOS', body: message, data: { type } }).catch(() => new Set<string>());
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const p of people || []) {
    const to = toE164(p?.mobile || '', { currency: venue.currency || 'GBP', country: venue.country || undefined });
    if (!to || seen.has(to)) { out.skipped++; continue; }
    seen.add(to);
    targets.push(to);
  }
  const results = await Promise.all(targets.slice(0, limit).map((to) => sendOne(to, message, venue.id, type, ref)));
  for (const r of results) { if (r) out.texted!++; else out.failed++; }
  out.skipped += Math.max(0, targets.length - limit);
  out.sent = out.texted!;
  const left = Math.max(0, PUSH_CAP_MS - (Date.now() - started));
  const pushed = await Promise.race([pushing, new Promise<Set<string>>((r) => setTimeout(() => r(new Set()), left))]);
  out.pushed = pushed.size;
  return out;
}

/** Push to some staff members' phones. Returns the staff ids at least one push reached. Never throws. */
async function pushStaff(staffIds: string[], msg: { title: string; body: string; data?: Record<string, unknown> }): Promise<Set<string>> {
  const reached = new Set<string>();
  try {
    const ids = [...new Set(staffIds)].filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 500);
    if (!ids.length) return reached;
    const r = await restRpc('chat_push_staff_devices', { p_staff_ids: ids });
    const all: PushDevice[] = [];
    const owner = new Map<string, string>();
    for (const row of r?.staff || []) for (const d of (row.devices || []) as PushDevice[]) { all.push(d); owner.set(d.id, row.staff_id); }
    if (!all.length) return reached;
    const { landed } = await sendPushMany(all, { title: msg.title, body: msg.body, data: msg.data });
    for (const id of landed) { const sid = owner.get(id); if (sid) reached.add(sid); }
  } catch { /* the text still goes */ }
  return reached;
}

// ── TEAM CHAT PUSH (5.11.102) ────────────────────────────────────────────────
// MARKER 5.11.102 staffNotify chat push
// team-chat calls this after a message is stored (never awaited by the sender). The database decides
// who it reaches (public.chat_push_targets: not the sender, not chat off, mutes and quiet when off
// shift kept, @mentions by a manager and urgent announcements through). An urgent announcement is
// texted to each staff member no push reached, when the company has the text backup on.
export type ChatPushPayload = {
  orgId: string;
  conversationId: string;
  conversationKind: string;
  messageId: number | string;
  senderMemberId: string;
  senderName?: string | null;
  preview?: string | null;
  urgent?: boolean;
  mentions?: string[];
};
export async function pushChatMessage(payload: ChatPushPayload): Promise<{ sent: number; skipped: number; texted: number; reason?: string }> {
  const out = { sent: 0, skipped: 0, texted: 0 } as { sent: number; skipped: number; texted: number; reason?: string };
  try {
    const t = await restRpc('chat_push_targets', { p_message: Number(payload.messageId) });
    if (!t?.ok) return { ...out, reason: 'no targets' };
    const msg = { title: String(t.title || 'ServOS'), body: String(t.body || ''), threadId: String(t.conversation_id), urgent: t.urgent === true,
      data: { type: 'chat', conversation_id: t.conversation_id, message_id: payload.messageId, url: '/?mode=staff&chat=' + t.conversation_id } };
    const all: PushDevice[] = [];
    const owner = new Map<string, string>();
    for (const target of t.targets || []) for (const d of target.devices || []) { all.push(d); owner.set(d.id, target.member_id); }
    const { landed, skipped } = await sendPushMany(all, msg);
    out.skipped = skipped;
    const reached = new Set<string>([...landed].map((id) => owner.get(id)!).filter(Boolean));
    out.sent = reached.size;
    if (t.urgent) {
      const texts: Promise<boolean>[] = [];
      const seen = new Set<string>();
      for (const target of t.targets || []) {
        if (reached.has(target.member_id) || !target.sms?.mobile) continue;
        const to = toE164(target.sms.mobile, { currency: target.sms.currency || 'GBP' });
        if (!to || seen.has(to) || texts.length >= 300) continue;
        seen.add(to);
        texts.push(sendOne(to, `${msg.title}: ${msg.body}`.slice(0, 320), target.sms.location_id, 'chat_urgent', String(payload.messageId)));
      }
      out.texted = (await Promise.all(texts)).filter(Boolean).length;
    }
  } catch (e) {
    out.reason = (e as Error)?.message || 'error';
  }
  return out;
}
