// ============================================================
// src/lib/customerLookup.js — phone-keyed customer lookup for kiosk
// ============================================================
// Looks up an existing customer record by normalized phone, scoped to the
// kiosk's org. Returns the customer's saved name + email so the kiosk can
// pre-fill those fields, plus loyalty rewards and points balance.
//
// v5.5.218: Loyalty integration live — rewards[] and credit populated from
// the loyalty-balance edge function. The kiosk UI in ScreenDetails renders
// "Welcome back, NAME" + rewards/credit when these are non-empty.
//
// Phone normalization matches store/index.js _normalisePhone exactly so the
// same key resolves whether saved via POS or kiosk.
// ============================================================

import { supabase, platformSupabase, getLocationId, ensureAuthToken } from './supabase';

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

    // v5.5.218: Fetch live loyalty data from the public balance endpoint.
    // Non-blocking — if it fails we still return the customer with empty loyalty.
    let rewards = [];
    let credit = 0;
    let loyaltyData = null;
    try {
      // Resolve company_id from the platform DB (locations → company_id)
      if (!platformSupabase) throw new Error('platformSupabase not available');
      const { data: locRow } = await platformSupabase
        .from('locations')
        .select('company_id')
        .or(`ops_location_id.eq.${locId},id.eq.${locId}`)
        .limit(1)
        .maybeSingle();
      const companyId = locRow?.company_id;
      if (companyId) {
        const balanceUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/loyalty-balance`
          + `?customer_id=${encodeURIComponent(data.id)}&company_id=${encodeURIComponent(companyId)}`;
        const balRes = await fetch(balanceUrl);
        if (balRes.ok) {
          loyaltyData = await balRes.json();
          credit = loyaltyData.points_balance || 0;
          rewards = (loyaltyData.rewards_available || []).map(r => ({
            id: r.id,
            label: r.name,
            description: r.description || '',
            icon: r.icon || 'gift',
            pointsCost: r.points_cost,
            type: r.reward_type,
            value: r.reward_value,
          }));
        }
      }
    } catch (loyaltyErr) {
      console.warn('[customerLookup] loyalty fetch failed (non-fatal):', loyaltyErr?.message || loyaltyErr);
    }

    return {
      customerId: data.id,
      name: data.name || '',
      email: data.email || null,
      marketingOptIn: !!data.marketing_opt_in,
      knownCustomer: true,
      rewards,
      credit,
      // Extended loyalty data for richer UI
      memberCode: loyaltyData?.member_code || null,
      tier: loyaltyData?.tier || null,
      pointsEarnedTotal: loyaltyData?.points_earned_total || 0,
      enrolledAt: loyaltyData?.enrolled_at || null,
      allRewards: loyaltyData?.all_rewards || [],
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

      // Fire-and-forget: send branded welcome SMS + email for new customers
      if (customerId) {
        try {
          let companyId = null;
          if (platformSupabase) {
            const { data: pLoc } = await platformSupabase
              .from('locations')
              .select('company_id')
              .or(`ops_location_id.eq.${locationId},id.eq.${locationId}`)
              .limit(1).maybeSingle();
            companyId = pLoc?.company_id;
          }
          if (companyId) {
            const welcomeUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-welcome`;
            fetch(welcomeUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                customer_id: customerId,
                company_id: companyId,
                location_id: locationId,
              }),
            }).catch(() => {});
          }
        } catch (e) {
          console.warn('[attributeOnlineOrder] welcome send failed (non-fatal):', e?.message);
        }
      }
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

    // v5.5.218: Loyalty points earn for online orders — fire-and-forget.
    // Uses the same edge function as the POS store's attributeOrderToCustomer.
    (async () => {
      try {
        const token = await ensureAuthToken();
        if (!token) return;
        const earnBody = {
          customer_id: customerId,
          location_id: locationId,
          closed_check_id: orderRecord.ref || `online-${Date.now()}`,
          channel: 'online',
          items: (orderRecord.items || []).map(i => ({
            name: i.name, qty: i.qty || 1, price: i.price || 0,
            cat: i.cat || i.category || null,
            id: i.itemId || i.id || null,
            isGiftCard: !!i.isGiftCard,
          })),
          subtotal: Number(orderRecord.total) || 0,
        };
        const res = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/loyalty-earn`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(earnBody),
          }
        );
        const j = await res.json().catch(() => ({}));
        if (res.ok) {
          console.info('[attributeOnlineOrder] loyalty earn:', j.points_earned, 'pts → balance:', j.balance);
        } else if (res.status !== 404) {
          console.warn('[attributeOnlineOrder] loyalty earn HTTP', res.status, j.error || '');
        }
      } catch (le) {
        console.warn('[attributeOnlineOrder] loyalty earn failed (non-fatal):', le?.message || le);
      }
    })();

    return customerId;
  } catch (e) {
    console.warn('[attributeOnlineOrder] unexpected:', e?.message || e);
    return customerId;
  }
}
