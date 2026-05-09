// ============================================================
// src/lib/customerLookup.js — phone-keyed customer lookup for kiosk
// ============================================================
// Looks up an existing customer record by normalized phone, scoped to the
// kiosk's org. Returns the customer's saved name + email so the kiosk can
// pre-fill those fields, plus a `rewards` slot that the loyalty system will
// populate when it ships.
//
// Today (v5.5.37): rewards / credit / discounts are STUBS. They always
// return empty / zero. The contract is locked in here so that when loyalty
// gets built, only this file changes — the kiosk UI doesn't need rewiring.
//
// Loyalty integration TODO (separate sprint):
//   - Add a `customer_rewards` table (or column on customers): { reward_id,
//     customer_id, label, value, expires_at, redeemed_at }
//   - In fetchCustomerByPhone(): SELECT eligible rewards alongside the
//     customer record, return them in the `rewards: []` array
//   - Add a `loyaltyCredit` numeric balance — extend the return shape with
//     { credit: number } when the loyalty wallet is built
//   - The kiosk UI in ScreenDetails already reserves layout space for
//     "Welcome back, NAME" + a rewards/credit list block — it only renders
//     when fetchCustomerByPhone returns a knownCustomer:true with non-empty
//     rewards/credit
//
// Phone normalization matches store/index.js _normalisePhone exactly so the
// same key resolves whether saved via POS or kiosk.
// ============================================================

import { supabase, getLocationId } from './supabase';

// Mirror of store._normalisePhone — kept local so this util can be used
// without depending on the Zustand store (the kiosk's customer-details
// screen runs without store hydration in some flows).
export function normalisePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('07') && digits.length === 11) return '+44' + digits.slice(1);
  if (digits.startsWith('44')) return '+' + digits;
  return digits;
}

// Cache the org_id for the active location so we don't refetch on every keystroke.
let _cachedLocId = null;
let _cachedOrgId = null;

async function resolveOrgIdForLocation(locId) {
  if (!locId || !supabase) return null;
  if (_cachedLocId === locId && _cachedOrgId) return _cachedOrgId;
  try {
    const { data, error } = await supabase
      .from('locations')
      .select('org_id')
      .eq('id', locId)
      .single();
    if (error) {
      console.warn('[customerLookup] failed to resolve org_id:', error.message);
      return null;
    }
    _cachedLocId = locId;
    _cachedOrgId = data?.org_id || null;
    return _cachedOrgId;
  } catch (e) {
    console.warn('[customerLookup] resolveOrgIdForLocation error:', e?.message || e);
    return null;
  }
}

/**
 * Look up a customer by phone in the current org. Returns null if no match
 * (or if lookup fails for any reason — caller should treat null and a
 * not-found result the same way).
 *
 * @param {string} rawPhone — phone as the customer typed it
 * @param {string} [locationId] — optional, defaults to getLocationId()
 * @returns {Promise<null | {
 *   customerId: string,
 *   name: string,
 *   email: string|null,
 *   marketingOptIn: boolean,
 *   knownCustomer: true,
 *   rewards: Array<{id: string, label: string, value: number}>, // STUB: always [] today
 *   credit: number,                                              // STUB: always 0 today
 * }>}
 */
export async function fetchCustomerByPhone(rawPhone, locationId) {
  const phoneN = normalisePhone(rawPhone);
  if (!phoneN || phoneN.length < 7) return null;

  const locId = locationId || await getLocationId();
  if (!locId) return null;

  const orgId = await resolveOrgIdForLocation(locId);
  if (!orgId) return null;

  try {
    const { data, error } = await supabase
      .from('customers')
      .select('id, name, email, marketing_opt_in')
      .eq('org_id', orgId)
      .eq('phone', phoneN)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) {
      console.warn('[customerLookup] query failed:', error.message);
      return null;
    }
    if (!data) return null;
    return {
      customerId: data.id,
      name: data.name || '',
      email: data.email || null,
      marketingOptIn: !!data.marketing_opt_in,
      knownCustomer: true,
      // STUB. Loyalty system not built yet. When it ships, populate from a
      // sibling SELECT or extend this function to JOIN against rewards.
      rewards: [],
      credit: 0,
    };
  } catch (e) {
    console.warn('[customerLookup] unexpected error:', e?.message || e);
    return null;
  }
}

/**
 * v5.5.121 — Online-order customer attribution.
 *
 * Records the order against the customer profile so every online order (and
 * therefore every visit) flows into the same CRM the operator UI uses.
 * Mirrors store.attributeOrderToCustomer but works without the operator-
 * facing Zustand store (which isn't hydrated on the customer surface).
 *
 *   1. Upsert customers row by (org_id, phone)
 *   2. Bump customer_locations.visit_count + lifetime_revenue (or insert)
 *   3. Insert customer_orders row (denormalised — channel='online')
 *
 * Fire-and-forget from the caller's perspective: a CRM blip never blocks
 * the customer's confirmation flow. Returns customerId on success, null
 * on any failure (errors are logged for diagnostics).
 */
export async function attributeOnlineOrder({
  phone, name, email, marketingOptIn = false,
  locationId,                    // ops_location_id (locations.id in ops DB)
  orderRecord,                   // { ref, total, items, type }
}) {
  if (!supabase || !phone || !locationId || !orderRecord) return null;
  const phoneN = normalisePhone(phone);
  if (!phoneN) return null;

  const orgId = await resolveOrgIdForLocation(locationId);
  if (!orgId) {
    console.warn('[attributeOnlineOrder] no org_id for location', locationId);
    return null;
  }

  let customerId = null;
  try {
    // 1. Upsert customers row. Use lookup-then-insert/update — same pattern
    // as store.upsertCustomer to avoid relying on a unique constraint.
    const { data: existing } = await supabase
      .from('customers')
      .select('id, name, email, marketing_opt_in')
      .eq('org_id', orgId)
      .eq('phone', phoneN)
      .is('deleted_at', null)
      .maybeSingle();

    if (existing) {
      customerId = existing.id;
      // Only fill blank fields — never overwrite an operator-curated value.
      const patch = {};
      if (!existing.name && name) patch.name = name;
      if (!existing.email && email) patch.email = email;
      if (!existing.marketing_opt_in && marketingOptIn) patch.marketing_opt_in = true;
      patch.last_seen_at = new Date().toISOString();
      const { error: updErr } = await supabase.from('customers').update(patch).eq('id', customerId);
      if (updErr) console.warn('[attributeOnlineOrder] customer update:', updErr.message);
    } else {
      const { data: ins, error: insErr } = await supabase
        .from('customers')
        .insert({
          org_id: orgId, phone: phoneN, phone_raw: phone,
          name: name || null, email: email || null,
          marketing_opt_in: !!marketingOptIn,
        })
        .select('id').maybeSingle();
      if (insErr) {
        console.warn('[attributeOnlineOrder] customer insert:', insErr.message);
        return null;
      }
      customerId = ins?.id;
    }
    if (!customerId) return null;

    // 2. customer_locations stats — read then INSERT or UPDATE.
    const incRevenue = Number(orderRecord.total) || 0;
    const nowIso = new Date().toISOString();
    const { data: existingLoc } = await supabase
      .from('customer_locations')
      .select('visit_count, lifetime_revenue')
      .eq('customer_id', customerId)
      .eq('location_id', locationId)
      .maybeSingle();

    if (existingLoc) {
      const newCount = (Number(existingLoc.visit_count) || 0) + 1;
      const newRevenue = (Number(existingLoc.lifetime_revenue) || 0) + incRevenue;
      const { error: e1 } = await supabase
        .from('customer_locations')
        .update({ visit_count: newCount, lifetime_revenue: newRevenue, last_visit_at: nowIso })
        .eq('customer_id', customerId).eq('location_id', locationId);
      if (e1) console.warn('[attributeOnlineOrder] customer_locations update:', e1.message);
    } else {
      const { error: e2 } = await supabase
        .from('customer_locations')
        .insert({
          customer_id: customerId, location_id: locationId,
          visit_count: 1, lifetime_revenue: incRevenue,
          first_visit_at: nowIso, last_visit_at: nowIso,
        });
      if (e2) console.warn('[attributeOnlineOrder] customer_locations insert:', e2.message);
    }

    // 3. customer_orders denormalised row.
    const itemSummary = (orderRecord.items || []).map(i => ({
      name: i.name, qty: i.qty, price: i.price,
    }));
    const { error: e3 } = await supabase.from('customer_orders').insert({
      customer_id: customerId,
      location_id: locationId,
      closed_check_id: orderRecord.ref || null,
      ordered_at: nowIso,
      total: Number(orderRecord.total) || 0,
      channel: 'online',
      item_summary: itemSummary,
    });
    if (e3) console.warn('[attributeOnlineOrder] customer_orders insert:', e3.message);

    return customerId;
  } catch (e) {
    console.warn('[attributeOnlineOrder] unexpected:', e?.message || e);
    return customerId;
  }
}
