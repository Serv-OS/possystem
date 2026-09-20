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

import { supabase, platformSupabase, getLocationId, ensureAuthToken, whenDeviceClaimed } from './supabase';

export { isMissingFn } from './customerFenceRules';
import { isMissingFn } from './customerFenceRules';

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
    // Database fence stage 2 (20260921_OPS_customers_fence.sql): the customers table is no
    // longer readable by an anonymous session, because the public key is in every page. The
    // server answers instead, and only for a till, kiosk or Back Office of THIS venue.
    // FENCE STAGE 2 FALLBACK: while the function does not exist we read the table as before.
    let data = null;
    const rpc = await supabase.rpc('customer_by_phone', { p_location_id: String(locId), p_phone: phoneN });
    if (isMissingFn(rpc.error)) {
      const legacy = await supabase
        .from('customers')
        .select('id, name, email, marketing_opt_in')
        .eq('org_id', orgId)
        .eq('phone', phoneN)
        .is('deleted_at', null)
        .maybeSingle();
      if (legacy.error) {
        console.warn('[customerLookup] query failed:', legacy.error.message);
        return null;
      }
      data = legacy.data;
    } else if (rpc.error) {
      console.warn('[customerLookup] customer_by_phone failed:', rpc.error.message);
      return null;
    } else {
      data = rpc.data || null;
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
        // Database fence stage 1: loyalty-balance returns full detail only to staff of the
        // venue, a device bound to the venue, or the member (report before 20260919a, enforced
        // after it). Send who we are: this session's token (till, host stand, customer display or
        // Back Office) and the venue, after the boot device link has had its chance to land.
        // A host stand is not a devices row, so after the fence it gets the summary (no points).
        const balanceUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/loyalty-balance`
          + `?customer_id=${encodeURIComponent(data.id)}&company_id=${encodeURIComponent(companyId)}`
          + `&location_id=${encodeURIComponent(locId)}`;
        await whenDeviceClaimed().catch(() => false);
        const authToken = await ensureAuthToken().catch(() => null);
        const balRes = await fetch(balanceUrl, authToken ? { headers: { authorization: `Bearer ${authToken}` } } : undefined);
        if (balRes.ok) {
          loyaltyData = await balRes.json();
          credit = loyaltyData.points_balance || 0;
          // Earned stamp-card rewards come FIRST — a completed card is already paid for
          // (v5.5.884: these never appeared anywhere before; the list was points-only).
          rewards = [
            ...(loyaltyData.stamp_rewards || []).map(sr => ({
              id: `stamp:${sr.program_id}`,
              label: sr.name,
              description: sr.available > 1 ? `Stamp card reward · ${sr.available} available` : 'Stamp card reward',
              icon: '🎟️',
              pointsCost: 0,
              type: sr.reward_type,
              value: sr.reward_config || {},
              stamp: true,
              stampProgramId: sr.program_id,
              available: sr.available,
            })),
            ...(loyaltyData.rewards_available || []).map(r => ({
              id: r.id,
              label: r.name,
              description: r.description || '',
              icon: r.icon || 'gift',
              pointsCost: r.points_cost,
              type: r.reward_type,
              value: r.reward_value,
            })),
          ];
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
      // v5.5.264: stamp cards and gift cards from loyalty-balance
      stampCards: loyaltyData?.stamp_cards || [],
      giftCards: loyaltyData?.gift_cards || [],
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
/**
 * Counter-side loyalty capture from the customer display: look the phone up;
 * if new, create the customer + fire the welcome/enrolment SMS (portal signup link).
 * Returns { ok, known, name, points, smsSent, customerId }.
 */
export async function captureLoyaltyByPhone(rawPhone, locationId, orgId) {
  const phoneN = normalisePhone(rawPhone);
  if (!phoneN || !supabase || !orgId) return { ok: false };
  try {
    const { data: existing } = await supabase
      .from('customers')
      .select('id, name')
      .eq('org_id', orgId)
      .eq('phone', phoneN)
      .is('deleted_at', null)
      .maybeSingle();

    if (existing?.id) {
      let points = 0;
      let name = existing.name || '';
      let rewards = [];
      let customerId = existing.id;
      try {
        const d = await fetchCustomerByPhone(rawPhone, locationId);
        if (d?.knownCustomer) {
          points = d.credit || 0;
          name = d.name || name;
          rewards = Array.isArray(d.rewards) ? d.rewards : [];
          customerId = d.customerId || customerId;
        }
      } catch { /* points/rewards best-effort */ }
      return { ok: true, known: true, name, points, rewards, customerId };
    }

    // New number → create the customer, then SMS them the loyalty signup form.
    const { data: ins, error } = await supabase
      .from('customers')
      .insert({ org_id: orgId, phone: phoneN, phone_raw: rawPhone, marketing_opt_in: true })
      .select('id').maybeSingle();
    if (error || !ins?.id) return { ok: false };

    try {
      let companyId = null;
      if (platformSupabase) {
        const { data: pLoc } = await platformSupabase
          .from('locations').select('company_id')
          .or(`ops_location_id.eq.${locationId},id.eq.${locationId}`)
          .limit(1).maybeSingle();
        companyId = pLoc?.company_id;
      }
      if (companyId) {
        const wToken = await ensureAuthToken();
        fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-welcome`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...(wToken ? { Authorization: `Bearer ${wToken}` } : {}) },
          body: JSON.stringify({ customer_id: ins.id, company_id: companyId, location_id: locationId }),
        }).catch(() => {});
      }
    } catch { /* welcome SMS best-effort */ }

    return { ok: true, known: false, smsSent: true, customerId: ins.id };
  } catch (e) {
    console.warn('[captureLoyaltyByPhone]', e?.message || e);
    return { ok: false };
  }
}

export async function attributeOnlineOrder({
  phone, name, email, marketingOptIn = false,
  locationId,                    // ops_location_id (locations.id in ops DB)
  orderRecord,                   // { ref, total, items, type }
  memberToken = null,            // the signed in member's loyalty session token (online)
  memberCustomerId = null,       // ...and whose it is (sent only when it is this order's customer)
  trackKey = null,               // fence stage 2: this order's own key (token, payment ref or last 4)
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
  let serverDidIt = false;
  let serverCreated = false;

  // Database fence stage 2: the customer tables are no longer writable from a customer's
  // browser. The server does the whole attribution, and only for someone who holds this
  // order's own key. FENCE STAGE 2 FALLBACK: while the function does not exist, the old
  // path below runs exactly as before.
  try {
    const rpc = await supabase.rpc('attribute_public_order', {
      p_location_id: String(locationId),
      p_ref: String(orderRecord.ref || ''),
      p_key: trackKey ? String(trackKey) : '',
      p_customer: { phone, name: name || '', email: email || null, marketing_opt_in: !!marketingOptIn },
      p_order: {
        total: Number(orderRecord.total) || 0,
        channel: orderRecord.channel || 'online',
        items: (orderRecord.items || []).map((i) => ({ name: i.name, qty: i.qty, price: i.price })),
      },
    });
    if (!isMissingFn(rpc.error)) {
      if (rpc.error) {
        console.warn('[attributeOnlineOrder] attribute_public_order failed:', rpc.error.message);
      } else if (rpc.data && rpc.data.ok) {
        customerId = rpc.data.customer_id || null;
        serverCreated = !!rpc.data.created;
        serverDidIt = true;
      } else {
        console.warn('[attributeOnlineOrder] attribute_public_order refused:', rpc.data && rpc.data.reason);
      }
      // the server had its say: never fall through to the direct writes it replaced
      if (!customerId) return null;
    }
  } catch (e) {
    console.warn('[attributeOnlineOrder] attribute_public_order threw:', e?.message || e);
  }

  try {
    if (serverDidIt) {
      // the rows are written; the welcome and the loyalty earn still run below
      if (serverCreated) await sendWelcomeFor(customerId, locationId);
      await earnForOnlineOrder({ customerId, locationId, orderRecord, memberToken, memberCustomerId });
      return customerId;
    }
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
      // customers.name is NOT NULL with no default: a null name was refused, so a nameless online
      // order never linked to a member (same bug loyalty-otp had, fixed 17 Sep 2026). Store an
      // empty name; the operator UI treats '' exactly like no name.
      const { data: ins, error: insErr } = await supabase
        .from('customers')
        .insert({
          org_id: orgId, phone: phoneN, phone_raw: phone,
          name: typeof name === 'string' ? name.trim() : '', email: email || null,
          marketing_opt_in: !!marketingOptIn,
        })
        .select('id').maybeSingle();
      if (insErr) {
        // Lost a race with another tab or device creating the same phone: use the winner's row.
        const { data: again } = await supabase
          .from('customers')
          .select('id')
          .eq('org_id', orgId)
          .eq('phone', phoneN)
          .is('deleted_at', null)
          .maybeSingle();
        if (!again?.id) {
          console.warn('[attributeOnlineOrder] customer insert:', insErr.code, insErr.message);
          return null;
        }
        customerId = again.id;
      } else {
        customerId = ins?.id;
      }

      if (customerId && !insErr) await sendWelcomeFor(customerId, locationId);
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

    earnForOnlineOrder({ customerId, locationId, orderRecord, memberToken, memberCustomerId });

    return customerId;
  } catch (e) {
    console.warn('[attributeOnlineOrder] unexpected:', e?.message || e);
    return customerId;
  }
}

/**
 * Loyalty points for an online or QR order. Fire and forget, and idempotent server side on
 * the check id. Used by both paths, the server one and the old one.
 */
export async function earnForOnlineOrder({ customerId, locationId, orderRecord, memberToken = null, memberCustomerId = null }) {
  if (!customerId || !locationId || !orderRecord) return;
  try {
    const token = await ensureAuthToken();
    if (!token) return;
    const earnBody = {
      customer_id: customerId,
      location_id: locationId,
      // Round three (18 Sep 2026): loyalty-earn now earns from the server's own closed_checks
      // row, so this must be that row's id (checkId, 'chk-OL-...'), not the display ref.
      closed_check_id: orderRecord.checkId || orderRecord.ref || `online-${Date.now()}`,
      channel: 'online',
      items: (orderRecord.items || []).map(i => ({
        name: i.name, qty: i.qty || 1, price: i.price || 0,
        cat: i.cat || i.category || null,
        id: i.itemId || i.id || null,
        isGiftCard: !!i.isGiftCard,
      })),
      subtotal: Number(orderRecord.total) || 0,
      // Database fence stage 1: loyalty-earn checks the caller. An online customer's browser
      // is anonymous, so the member's own token is its only proof. Sent only when the signed
      // in member IS this customer; a guest order (no sign in) earns before 20260919a (report
      // mode, logged) and not after it (enforced): signing in with the one time code earns.
      ...(memberToken && memberCustomerId && memberCustomerId === customerId ? { member_token: String(memberToken) } : {}),
    };
    const sendEarn = () => fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/loyalty-earn`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(earnBody),
      }
    );
    let res = await sendEarn();
    // 409 check_not_found means the closed_checks row has not landed yet (enforce only; an
    // order whose payment is still being checked has no check until it is proven). Try again
    // a little later; idempotent on the check id server side.
    for (const waitMs of [3000, 10000]) {
      if (res.status !== 409) break;
      let code = null;
      try { code = (await res.clone().json())?.code || null; } catch { /* not json */ }
      if (code !== 'check_not_found') break;
      await new Promise((r) => setTimeout(r, waitMs));
      res = await sendEarn();
    }
    const j = await res.json().catch(() => ({}));
    if (res.ok) {
      console.info('[attributeOnlineOrder] loyalty earn:', j.points_earned, 'pts → balance:', j.balance);
    } else if (res.status !== 404) {
      console.warn('[attributeOnlineOrder] loyalty earn HTTP', res.status, j.error || '');
    }
  } catch (le) {
    console.warn('[attributeOnlineOrder] loyalty earn failed (non-fatal):', le?.message || le);
  }
}

/**
 * Branded welcome SMS and email for a customer we have just created. Fire and forget: a
 * failure here never fails an order. Used by both paths, the server one and the old one.
 */
export async function sendWelcomeFor(customerId, locationId) {
  if (!customerId) return;
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
        const wToken = await ensureAuthToken();
        fetch(welcomeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(wToken ? { Authorization: `Bearer ${wToken}` } : {}) },
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
