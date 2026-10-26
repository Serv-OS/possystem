// supabase/functions/_shared/staffNotify.ts
//
// v5.11.101: tell members of staff something about their shifts (an open shift is up, a shift was
// offered to them, a manager decided). Used by staff-portal and manager-approve.
//
// TODAY: a text message through send-sms (the same sender as rota publish texts), the number read
// with the VENUE's country (_shared/regionPack.js toE164: a US venue's 801 555 1234 is +1, never +44).
// A person with no usable mobile is skipped and counted, never an error.
//
// PUSH HOOK: the next build (5.11.102, team chat and push) adds the app push here, in sendOne,
// before the text: one place, so every caller gets push without changing.
//
// Never throws: a text that did not go is reported in the answer, and the shift change it is about
// has already happened.

import { toE164 } from './regionPack.js';

export type NotifyPerson = { id?: string; name?: string | null; mobile?: string | null };
export type NotifyResult = { sent: number; skipped: number; failed: number };

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

async function sendOne(to: string, message: string, locationId: string, type: string, ref: string | null): Promise<boolean> {
  // PUSH HOOK (5.11.102): send the app push for this person here first.
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
  const out: NotifyResult = { sent: 0, skipped: 0, failed: 0 };
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const p of people || []) {
    const to = toE164(p?.mobile || '', { currency: venue.currency || 'GBP', country: venue.country || undefined });
    if (!to || seen.has(to)) { out.skipped++; continue; }
    seen.add(to);
    targets.push(to);
  }
  const results = await Promise.all(targets.slice(0, limit).map((to) => sendOne(to, message, venue.id, type, ref)));
  for (const r of results) { if (r) out.sent++; else out.failed++; }
  out.skipped += Math.max(0, targets.length - limit);
  return out;
}

// ── TEAM CHAT PUSH (5.11.102) ────────────────────────────────────────────────
// MARKER 5.11.102 staffNotify chat push stub
// team-chat calls this after a message is stored. Part 4 of 5.11.102 fills it in (_shared/push.ts:
// APNs for the iOS staff app, Web Push for Android and the browser, never Firebase) and wires the same
// push into sendOne above. Until then it sends nothing and says so. Never throws.
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
export async function pushChatMessage(payload: ChatPushPayload): Promise<{ sent: number; skipped: number; reason?: string }> {
  try {
    void payload;
    return { sent: 0, skipped: 0, reason: 'push is not set up yet (5.11.102 part 4)' };
  } catch {
    return { sent: 0, skipped: 0, reason: 'error' };
  }
}
