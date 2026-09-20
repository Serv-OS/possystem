// supabase/functions/ryft-refund/index.ts
//
// Refund a Ryft payment (card-present or online) by its payment-session id.
// Location-scoped: caller must be a signed-in Ops user with access to the
// location (user_locations) — or super_admin. Routes to Ryft only; the caller
// (Transactions report) decides processor by the original payment.
//
//   { location_id (ops), payment_session_id, amount_minor?, reason?,
//     refund_platform_fee?, idempotency_key? }
//     amount_minor omitted = FULL refund.
//     refund_platform_fee: default = give our markup back on a FULL refund, keep
//     it (proportional) on a partial. Overridable.
//
// Auth mirrors stripe-refund. location_id resolves the account.
// WHO (database fence stage 1, 19 Sep 2026, enforced always): the service role, staff of the
// venue (user_locations, or a verified super admin), or a device BOUND to the venue (the device
// arm of pos_can_access; the POS refund path runs on the till's anonymous device session). The
// header above always promised this; the code accepted ANY valid session, so a customer could
// refund their own payment session. Rules: _shared/gift-authority.ts decideCardRefundAuthority.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { refundPaymentSession, ryftConfigured } from '../_shared/ryft.ts';
import { callerStaffOrDevice, recordAuthority, isServiceRoleRequest, deviceHintOf } from '../_shared/loyalty-utils.ts';
import { decideCardRefundAuthority } from '../_shared/gift-authority.ts';
import { authorityLogRow } from '../_shared/loyalty-authority.ts';
import { secondStepRefusal } from '../_shared/second-step.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const ryftErr = (d: any): string | null => d?.errors?.[0]?.message || d?.message || null;

const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const serviceRole = isServiceRoleRequest(req);
  let caller: any = null;
  if (!serviceRole) {
    const { data: { user } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
    if (!user) return json({ error: 'Invalid token' }, 401);
    caller = user;
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const opsLocationId = String(body?.location_id ?? body?.ops_location_id ?? '').trim();
  const sessionId = String(body?.payment_session_id ?? '').trim();
  if (!opsLocationId || !sessionId) return json({ error: 'location_id and payment_session_id required' }, 400);

  // ── Who may refund (stage 1, enforced always), before anything is read or moved ──
  if (!serviceRole) {
    const who = await callerStaffOrDevice(caller, opsLocationId, null);
    const authority = decideCardRefundAuthority({ serviceRole, user: caller, staff: who.staff, device: who.device, deviceReason: who.deviceReason });
    if (!authority.ok) {
      recordAuthority(authorityLogRow({
        fn: 'ryft-refund', mode: 'enforce', outcome: 'refused',
        decision: { ok: false, reason: authority.reason, callerKind: caller?.is_anonymous ? 'anonymous' : 'user_no_access' },
        user: caller, locationId: opsLocationId, closedCheckId: body?.closed_check_id ?? null,
        deviceHint: deviceHintOf(body), detail: { device_reason: who.deviceReason },
      }));
      return json({ error: authority.error, code: 'refund_not_allowed', reason: authority.reason }, authority.status);
    }
  }
  if (!ryftConfigured()) return json({ error: 'Ryft not configured' }, 500);

  // Resolve the location's Ryft sub-account (the Account header for the refund).
  // location_id may be the ops id or the platform id.
  const { data: loc } = await platformAdmin.from('locations').select('id')
    .or(`ops_location_id.eq.${opsLocationId},id.eq.${opsLocationId}`).maybeSingle();
  if (!loc) return json({ error: 'location not found in platform DB' }, 404);
  const { data: mra } = await platformAdmin.from('merchant_ryft_accounts').select('ryft_account_id').eq('location_id', loc.id).maybeSingle();
  const opts: Record<string, unknown> = mra?.ryft_account_id ? { accountId: mra.ryft_account_id } : {};
  if (body.idempotency_key) opts.idempotencyKey = String(body.idempotency_key);

  const amount = (body.amount_minor === undefined || body.amount_minor === null) ? null : Math.round(Number(body.amount_minor));
  if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) return json({ error: 'amount_minor must be a positive integer' }, 400);
  const isFull = amount === null;
  const refundPlatformFee = body.refund_platform_fee === undefined ? isFull : !!body.refund_platform_fee;

  const refundBody: Record<string, unknown> = { refundPlatformFee };
  if (amount !== null) refundBody.amount = amount;
  if (body.reason) refundBody.reason = String(body.reason).slice(0, 200);

  const res = await refundPaymentSession(sessionId, refundBody, opts);
  if (!res.ok) {
    return json({ error: ryftErr(res.data) || `Refund failed (${res.status})`, ryft: res.data }, res.status >= 400 && res.status < 500 ? 400 : 502);
  }
  return json({ success: true, refund: res.data });
});
