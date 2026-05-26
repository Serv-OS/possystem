// supabase/functions/loyalty-earn/index.ts
//
// Award loyalty points from a completed purchase.
// Called by the POS/kiosk/online after payment is confirmed.
//
// Body: {
//   customer_id,     -- ops DB customer UUID
//   location_id,     -- ops location_id
//   closed_check_id, -- for idempotency + audit trail
//   channel,         -- 'pos'|'kiosk'|'online'|'qr'
//   items,           -- line items array for qualifying amount calc
//   subtotal,        -- order subtotal (fallback if items not detailed)
//   staff_id?,       -- who processed the order
// }
//
// Returns: { points_earned, balance, member_code, tier, is_new_member }

import {
  cors, json, opsAdmin, platformAdmin, authenticateCaller,
  resolveCompanyForLocation, getOrCreateConfig, ensureMembership,
  calculatePoints, calculateQualifyingAmount, updateBalance,
} from '../_shared/loyalty-utils.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // Auth
  const authResult = await authenticateCaller(req);
  if (authResult instanceof Response) return authResult;
  const caller = authResult.user;

  // Parse body
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const {
    customer_id,
    location_id,
    closed_check_id,
    channel = 'pos',
    items = [],
    subtotal,
    staff_id,
  } = body as any;

  if (!customer_id) return json({ error: 'customer_id required' }, 400);
  if (!location_id) return json({ error: 'location_id required' }, 400);
  if (!closed_check_id) return json({ error: 'closed_check_id required' }, 400);

  // ── Resolve company (before anything else — needed for scoping) ─────────
  // v5.5.218: moved above idempotency check so all queries are company-scoped.
  // Prevents cross-company bleed if two companies share a customer_id.
  const resolved = await resolveCompanyForLocation(caller.id, location_id);
  if (resolved instanceof Response) return resolved;
  const companyId = resolved;

  // ── Idempotency check (scoped to company) ─────────────────────────────
  const idempotencyKey = `earn:${closed_check_id}`;
  const { data: existingTx } = await opsAdmin
    .from('loyalty_transactions')
    .select('id, points, balance_after')
    .eq('idempotency_key', idempotencyKey)
    .eq('company_id', companyId)
    .maybeSingle();

  if (existingTx) {
    // Already processed — return the same result
    const { data: membership } = await platformAdmin
      .from('customer_loyalty')
      .select('points_balance, member_code, tier_id')
      .eq('customer_id', customer_id)
      .eq('company_id', companyId)
      .maybeSingle();
    return json({
      status: 'already_processed',
      points_earned: existingTx.points,
      balance: membership?.points_balance ?? existingTx.balance_after,
      member_code: membership?.member_code ?? null,
    });
  }

  // ── Get loyalty config ─────────────────────────────────────────────────
  const config = await getOrCreateConfig(companyId);
  if (!config || !config.enabled) {
    return json({ status: 'loyalty_disabled', points_earned: 0 });
  }

  // ── Ensure membership (auto-enroll on first purchase) ──────────────────
  const memberResult = await ensureMembership(customer_id, companyId, config);
  if (memberResult instanceof Response) return memberResult;
  const { membership, isNew } = memberResult;

  // ── Calculate qualifying amount ────────────────────────────────────────
  let qualifyingMinor: number;
  if (Array.isArray(items) && items.length > 0) {
    qualifyingMinor = calculateQualifyingAmount(items, config);
  } else {
    // Fallback: use subtotal (already in currency units, convert to minor)
    qualifyingMinor = Math.round(Number(subtotal || 0) * 100);
  }

  if (qualifyingMinor <= 0) {
    return json({
      status: 'no_qualifying_amount',
      points_earned: 0,
      balance: membership.points_balance,
      member_code: membership.member_code,
      is_new_member: isNew,
    });
  }

  // ── Get tier multiplier ────────────────────────────────────────────────
  let tierMultiplier = 1.0;
  let tierName: string | null = null;
  if (membership.tier_id) {
    const { data: tier } = await platformAdmin
      .from('loyalty_tiers')
      .select('name, points_multiplier')
      .eq('id', membership.tier_id)
      .maybeSingle();
    if (tier) {
      tierMultiplier = Number(tier.points_multiplier) || 1.0;
      tierName = tier.name;
    }
  }

  // ── Check earning rules for bonus multipliers ──────────────────────────
  // Future: evaluate loyalty_earning_rules for time/product bonuses.
  // For now, just use the base config + tier multiplier.

  // ── Calculate points ───────────────────────────────────────────────────
  const pointsEarned = calculatePoints(
    qualifyingMinor,
    Number(config.points_per_currency_unit) || 1,
    tierMultiplier,
    config.points_rounding || 'floor',
  );

  if (pointsEarned <= 0) {
    return json({
      status: 'zero_points',
      points_earned: 0,
      balance: membership.points_balance,
      member_code: membership.member_code,
      is_new_member: isNew,
    });
  }

  // ── Update balance ─────────────────────────────────────────────────────
  const newBalance = await updateBalance(membership.id, pointsEarned);
  if (newBalance === null) {
    return json({ error: 'Failed to update balance — concurrent modification' }, 409);
  }

  // ── Update lifetime stats ──────────────────────────────────────────────
  await platformAdmin
    .from('customer_loyalty')
    .update({
      points_earned_total: (membership.points_earned_total || 0) + pointsEarned,
      visit_count: (membership.visit_count || 0) + 1,
      lifetime_spend_minor: (membership.lifetime_spend_minor || 0) + qualifyingMinor,
    })
    .eq('id', membership.id);

  // ── Write transaction ledger ───────────────────────────────────────────
  await opsAdmin.from('loyalty_transactions').insert({
    customer_id,
    company_id: companyId,
    location_id,
    type: 'earn',
    points: pointsEarned,
    balance_after: newBalance,
    source: 'purchase',
    channel,
    closed_check_id,
    idempotency_key: idempotencyKey,
    qualifying_amount_minor: qualifyingMinor,
    multiplier_applied: tierMultiplier,
    tier_at_time: tierName,
    staff_id: staff_id || null,
  });

  // ── Registration bonus transaction (if new member with bonus) ──────────
  if (isNew && (config.registration_bonus || 0) > 0) {
    await opsAdmin.from('loyalty_transactions').insert({
      customer_id,
      company_id: companyId,
      location_id,
      type: 'bonus',
      points: config.registration_bonus,
      balance_after: newBalance + config.registration_bonus,
      source: 'welcome',
      channel,
      idempotency_key: `welcome:${customer_id}:${companyId}`,
      note: 'Welcome bonus on first purchase',
    });
  }

  // ── Stamp cards — award stamps for qualifying items ─────────────────────
  let stampsAwarded: { program_id: string; program_name: string; stamps: number; new_total: number; completed: boolean }[] = [];
  try {
    // Fetch active stamp card programs for this company
    const { data: programs } = await platformAdmin
      .from('stamp_card_programs')
      .select('id, name, icon, stamps_required, qualifying_category_ids, qualifying_item_ids')
      .eq('company_id', companyId)
      .eq('active', true);

    if (programs && programs.length > 0 && Array.isArray(items) && items.length > 0) {
      for (const prog of programs) {
        const qualCats: string[] = prog.qualifying_category_ids || [];
        const qualItems: string[] = prog.qualifying_item_ids || [];
        const allQualify = qualCats.length === 0 && qualItems.length === 0;

        // Count qualifying items in the order
        let qualifyingCount = 0;
        for (const item of items as any[]) {
          if (item.isComp || item.isGiftCard) continue;
          const qty = Number(item.qty) || 1;
          if (allQualify) {
            qualifyingCount += qty;
          } else if (qualItems.length > 0 && item.id && qualItems.includes(item.id)) {
            qualifyingCount += qty;
          } else if (qualCats.length > 0 && item.cat && qualCats.includes(item.cat)) {
            qualifyingCount += qty;
          }
        }

        if (qualifyingCount <= 0) continue;

        // Idempotency: skip if stamps already awarded for this check
        const stampIdemKey = `stamp:${closed_check_id}:${prog.id}`;
        const { data: existingStamp } = await opsAdmin
          .from('stamp_transactions')
          .select('id')
          .eq('idempotency_key', stampIdemKey)
          .maybeSingle();
        if (existingStamp) continue;

        // Get or create customer stamp card (upsert to avoid race condition)
        const { data: card } = await platformAdmin.rpc('upsert_customer_stamp_card', {
          p_customer_id: customer_id,
          p_program_id: prog.id,
          p_company_id: companyId,
        });
        if (!card) continue;

        let newStamps = (card.stamps_collected || 0) + qualifyingCount;
        let completions = card.completed_count || 0;
        let completedThisOrder = false;

        // Handle completions (may complete multiple times if large order)
        while (newStamps >= prog.stamps_required) {
          newStamps -= prog.stamps_required;
          completions += 1;
          completedThisOrder = true;
        }

        // Update the stamp card
        await platformAdmin
          .from('customer_stamp_cards')
          .update({
            stamps_collected: newStamps,
            completed_count: completions,
            last_stamp_at: new Date().toISOString(),
          })
          .eq('id', card.id);

        // Audit trail on ops DB (with idempotency key)
        await opsAdmin.from('stamp_transactions').insert({
          customer_id,
          program_id: prog.id,
          location_id,
          stamps: qualifyingCount,
          trigger_item_name: (items as any[]).filter(i => !i.isComp && !i.isGiftCard).map(i => i.name).join(', ').slice(0, 200),
          order_ref: String(closed_check_id),
          type: 'earn',
          idempotency_key: stampIdemKey,
        });

        stampsAwarded.push({
          program_id: prog.id,
          program_name: prog.name,
          stamps: qualifyingCount,
          new_total: newStamps,
          completed: completedThisOrder,
        });
      }
    }
  } catch (e) {
    console.warn('[loyalty-earn] stamp card processing failed (non-fatal):', e);
  }

  return json({
    status: 'ok',
    points_earned: pointsEarned,
    balance: newBalance,
    member_code: membership.member_code,
    tier: tierName,
    is_new_member: isNew,
    qualifying_amount_minor: qualifyingMinor,
    multiplier: tierMultiplier,
    stamps_awarded: stampsAwarded.length > 0 ? stampsAwarded : undefined,
  });
});
