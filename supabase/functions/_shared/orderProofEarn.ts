// supabase/functions/_shared/orderProofEarn.ts
//
// 19 Oct 2026 (v5.11.78, channel parity): a customer page's own order, by its order key, for
// loyalty-earn. The rule is earnFromCheck.ts decideOrderProofEarn (pure, node tested); this reads
// its facts with the service role. loyalty-earn calls it ONLY after its fence refused the caller.
//
import { opsAdmin, resolveVenue, uuidOr0 } from './loyalty-utils.ts';
import { decideOrderProofEarn, usableOrderKey, type CheckRow } from './earnFromCheck.ts';

// The facts for decideOrderProofEarn, read with the service role: the check at
// this venue, whether the key proves its ref (_order_track_ok, the rule attribute_public_order
// uses), the customer row being credited and this venue's organisation. Never throws: a failed
// read is a refusal.
export async function orderProofFor(p: { locationId: string; customerId: string; closedCheckId: string; channel: unknown; orderKey: unknown }) {
  try {
    const venue = await resolveVenue(p.locationId);
    const opsLoc = String(venue.opsLocationId || uuidOr0(p.locationId));
    const { data: check } = await opsAdmin
      .from('closed_checks')
      .select('id, ref, source, location_id, status, voided, refunded, customer, customer_phone')
      .eq('id', p.closedCheckId)
      .eq('location_id', opsLoc)
      .maybeSingle();
    let keyOk = false;
    if (check?.ref && usableOrderKey(p.orderKey)) {
      const { data, error } = await opsAdmin.rpc('_order_track_ok', {
        p_location_id: opsLoc, p_ref: String(check.ref), p_key: String(p.orderKey).trim(),
      });
      keyOk = !error && data === true;
    }
    const { data: cust } = await opsAdmin
      .from('customers').select('id, org_id, phone, deleted_at').eq('id', p.customerId).maybeSingle();
    const { data: loc } = await opsAdmin.from('locations').select('org_id').eq('id', opsLoc).maybeSingle();
    return decideOrderProofEarn({
      channel: p.channel, orderKey: p.orderKey, check: (check as CheckRow) ?? null, keyOk,
      customer: cust && !cust.deleted_at ? { orgId: cust.org_id ?? null, phone: cust.phone ?? null } : null,
      venueOrgId: loc?.org_id ?? null,
    });
  } catch {
    return { ok: false as const, reason: 'order_proof_error' };
  }
}

