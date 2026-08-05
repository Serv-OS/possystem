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
// Redemption is RACE-SAFE: a compare-and-swap UPDATE guarded on uses_count means only ONE concurrent
// till can win a single-use code; a second attempt gets reason 'already_used'. Idempotent on retry via
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

    // Append-only ledger FIRST — its UNIQUE idempotency_key is the retry guard. Written AFTER
    // the CAS it left a window where the code was already consumed with nothing to dedupe
    // against, so a retry consumed a second use. A single-use code is covered by the CAS
    // itself; a MULTI-use one is not.
    const { data: ledger, error: ledgerErr } = await opsAdmin.from('promo_redemptions').insert({
      promo_code_id: row.id, offer_id: offer.id, org_id: row.org_id, code: row.code,
      customer_id: redemptionCustomerId, location_id: locationId, order_id: orderId, staff_id: staffId,
      basket_value: subtotal, discount_value: discount.amount ?? 0, idempotency_key: idemKey,
    }).select('id').single();
    if (ledgerErr?.code === '23505') return json({ ok: true, redeemed: true, idempotent: true });
    if (ledgerErr || !ledger) {
      console.error('[promo-redeem] ledger insert failed:', ledgerErr?.message);
      return json({ error: 'Failed to record redemption' }, 500);
    }

    // RACE-SAFE compare-and-swap: only succeeds if uses_count is still what we read.
    const newCount = (row.uses_count ?? 0) + 1;
    const { data: updated } = await opsAdmin.from('promo_codes')
      .update({
        uses_count: newCount,
        status: newCount >= (row.uses_allowed ?? 1) ? 'redeemed' : row.status,
        redeemed_at: new Date().toISOString(),
        redeemed_order_id: orderId, redeemed_location_id: locationId,
        redeemed_value: discount.amount ?? 0, redeemed_staff_id: staffId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id)
      .eq('uses_count', row.uses_count ?? 0)   // <-- CAS guard: the race anchor
      .select('id').maybeSingle();
    if (!updated) {
      // Lost the race / already used — nothing was consumed, so drop our guard row.
      await opsAdmin.from('promo_redemptions').delete().eq('id', ledger.id);
      return json({ ok: false, redeemed: false, reason: 'already_used' });
    }

    // Best-effort offer counter.
    try { await opsAdmin.from('offers').update({ redeemed_count: (offer.redeemed_count ?? 0) + 1, updated_at: new Date().toISOString() }).eq('id', offer.id); } catch (_e) {}

    return json({ ok: true, redeemed: true, discount, offer: { id: offer.id, name: offer.name } });
  }

  return json({ error: 'unknown action' }, 400);
});
