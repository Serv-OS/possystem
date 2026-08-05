// supabase/functions/promo-redeem/index.ts
//
// POS-facing promo-code endpoint (called from the till like gift-redeem/loyalty-redeem — anon key,
// verify_jwt=false; location + staff identity passed for audit). Two actions:
//
//   validate { code, location_id, customer_id?, basket:{subtotal} }
//       → { valid, discount:{type,value,amount,label,item_id?}, offer:{id,name}, reason? }   (no write)
//   redeem   { code, order_id, location_id, customer_id?, staff_id?, basket_value?, idempotency_key? }
//       → { ok, redeemed:true, discount, reason? }
//
// Redemption is RACE-SAFE and CRASH-SAFE: the ledger row and the use consumption happen inside one
// transaction, the promo_redeem_atomic RPC (migration 20260806c). Only ONE concurrent till can win a
// single-use code; a second attempt gets reason 'already_used'. Idempotent on retry via
// promo_redemptions.idempotency_key (default `${order_id}:${code}`).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { computeDiscount } from '../_shared/promo.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

const norm = (c: string) => String(c ?? '').trim().toUpperCase();

// Load code + its offer, and run all eligibility checks. Returns { code, offer, discount } or { reason }.
async function evaluate(codeStr: string, locationId: string, customerId: string | null, subtotal: number) {
  const code = norm(codeStr);
  if (!code) return { reason: 'not_found' as const };
  // case-insensitive match (unique index is on upper(code))
  const { data: rows } = await opsAdmin.from('promo_codes').select('*').ilike('code', code).limit(1);
  const row = rows?.[0];
  if (!row) return { reason: 'not_found' as const };
  if (row.status === 'voided') return { reason: 'voided' as const, row };
  if (row.status === 'expired') return { reason: 'expired' as const, row };
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return { reason: 'expired' as const, row };
  if ((row.uses_count ?? 0) >= (row.uses_allowed ?? 1)) return { reason: 'already_used' as const, row };
  if (row.customer_id && customerId && row.customer_id !== customerId) return { reason: 'customer_mismatch' as const, row };
  // v5.5.946: a code minted FOR a customer used to demand the till attach that exact
  // customer first ('customer_required') — which made every campaign-issued personal
  // code unredeemable at the counter, and for online/kiosk guests who weren't signed
  // into loyalty. Presenting the code IS the identity evidence (it was delivered to
  // that person's own inbox/phone), so adopt the code's owner as the redemption
  // customer instead of refusing. A DIFFERENT attached customer is still refused above.
  const effectiveCustomerId = customerId || row.customer_id || null;

  const { data: offer } = await opsAdmin.from('offers').select('*').eq('id', row.offer_id).maybeSingle();
  if (!offer) return { reason: 'not_found' as const, row };
  if (!offer.active) return { reason: 'inactive' as const, row, offer };
  const nowMs = Date.now();
  if (offer.valid_from && new Date(offer.valid_from).getTime() > nowMs) return { reason: 'not_yet_active' as const, row, offer };
  if (offer.valid_to && new Date(offer.valid_to).getTime() < nowMs) return { reason: 'expired' as const, row, offer };
  const venues: string[] = Array.isArray(offer.venue_ids) ? offer.venue_ids : [];
  if (venues.length && locationId && !venues.includes(locationId)) return { reason: 'wrong_venue' as const, row, offer };
  if (offer.min_spend != null && Number(subtotal) < Number(offer.min_spend)) return { reason: 'min_spend' as const, row, offer, min_spend: Number(offer.min_spend) };

  // per-customer limit across the offer (shared codes): count this customer's prior redemptions.
  if (effectiveCustomerId && (offer.per_customer_limit ?? 0) > 0) {
    const { count } = await opsAdmin.from('promo_redemptions').select('id', { count: 'exact', head: true })
      .eq('offer_id', offer.id).eq('customer_id', effectiveCustomerId);
    if ((count ?? 0) >= offer.per_customer_limit) return { reason: 'usage_limit' as const, row, offer };
  }

  const discount = computeDiscount(offer, Number(subtotal) || 0);
  return { row, offer, discount, effectiveCustomerId };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? '').trim();
  const locationId = String(body?.location_id ?? '').trim();
  const customerId = body?.customer_id ? String(body.customer_id) : null;
  const subtotal = Number(body?.basket?.subtotal ?? body?.basket_value ?? 0) || 0;

  if (action === 'validate') {
    const ev = await evaluate(body?.code, locationId, customerId, subtotal);
    if ('reason' in ev) return json({ valid: false, reason: ev.reason, min_spend: (ev as any).min_spend });
    return json({ valid: true, discount: ev.discount, offer: { id: ev.offer.id, name: ev.offer.name }, code_id: ev.row.id });
  }

  if (action === 'redeem') {
    const orderId = body?.order_id ? String(body.order_id) : null;
    const staffId = body?.staff_id ? String(body.staff_id) : null;
    const idemKey = String(body?.idempotency_key || (orderId ? `${orderId}:${norm(body?.code)}` : '')) || null;

    // Idempotent retry: if this (order,code) was already redeemed, return success unchanged.
    if (idemKey) {
      const { data: prior } = await opsAdmin.from('promo_redemptions').select('id, discount_value').eq('idempotency_key', idemKey).maybeSingle();
      if (prior) return json({ ok: true, redeemed: true, idempotent: true });
    }

    const ev = await evaluate(body?.code, locationId, customerId, subtotal);
    if ('reason' in ev) return json({ ok: false, redeemed: false, reason: ev.reason });
    const { row, offer, discount } = ev;
    // Attribution: prefer the adopted owner (personal codes) over the till's null.
    const redemptionCustomerId = (ev as any).effectiveCustomerId ?? customerId;

    // The ledger row, the compare-and-swap on uses_count and the offer counter are ONE
    // transaction. As two round trips there was a window either way round: ledger-first, a
    // dead isolate stranded a guard row over an unconsumed code (spendable again, and
    // nothing said so); and the rollback DELETE that covered a lost CAS could erase a row a
    // concurrent replay had already reported success on. A transaction cannot leave half of
    // itself behind, so neither window exists. p_expected_uses is the CAS anchor.
    const { data: res, error: rpcErr } = await opsAdmin.rpc('promo_redeem_atomic', {
      p_code_id: row.id,
      p_expected_uses: row.uses_count ?? 0,
      p_offer_id: offer.id,
      p_org_id: row.org_id,
      p_code: row.code,
      p_customer_id: redemptionCustomerId,
      p_location_id: locationId,
      p_order_id: orderId,
      p_staff_id: staffId,
      p_basket_value: subtotal,
      p_discount_value: discount.amount ?? 0,
      p_idempotency_key: idemKey,
    });
    if (rpcErr || !res?.result) {
      console.error('[promo-redeem] promo_redeem_atomic failed:', rpcErr?.message);
      return json({ error: 'Failed to record redemption' }, 500);
    }
    if (res.result === 'idempotent_hit') return json({ ok: true, redeemed: true, idempotent: true });
    // 'already_used' (lost the CAS or the code is spent) and 'not_found' are both terminal.
    if (res.result !== 'redeemed') return json({ ok: false, redeemed: false, reason: res.result });

    return json({ ok: true, redeemed: true, discount, offer: { id: offer.id, name: offer.name } });
  }

  return json({ error: 'unknown action' }, 400);
});
