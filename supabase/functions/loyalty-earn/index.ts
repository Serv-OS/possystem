// supabase/functions/loyalty-earn/index.ts
//
// Award loyalty points from a completed purchase.
// Called by the POS/kiosk/online after payment is confirmed.
//
// Body: {
//   customer_id,     -- ops DB customer UUID
//   location_id,     -- ops location_id
//   closed_check_id, -- the closed_checks.id of the order (idempotency + the source of the earn)
//   channel,         -- 'pos'|'kiosk'|'online'|'qr'
//   items,           -- line items; used ONLY while the check row has not landed (report mode)
//   subtotal,        -- same
//   staff_id?,       -- who processed the order
//   member_token?,   -- the member's loyalty session token (kiosk or online, when signed in)
//   device_hint?,    -- the till's or kiosk's own id, for caller_authority_log only
// }
//
// AUTHORITY: see the gate below and _shared/loyalty-authority.ts (report first).
//
// ROUND THREE (18 Sep 2026): the earn comes from the server's own closed_checks row for that id
// at that location (_shared/earnFromCheck.ts), not from the body: amount and items from the
// check, capped at its own subtotal or total; a check that does not exist, is voided or refunded,
// or (for a member token) is not the member's own, is refused under enforce and recorded under
// report; one earn per check whatever the key; the ledger row is written FIRST as the claim, so
// two racing calls can never both move the balance.
//
// Returns: { points_earned, balance, member_code, tier, is_new_member }

import {
  cors, json, opsAdmin, platformAdmin, authenticateCaller,
  resolveCompanyForLocation, getOrCreateConfig, ensureMembership,
  calculatePoints, calculateQualifyingAmount, updateBalance, checkLoyaltyAuthority,
  recordAuthority, deviceHintOf, uuidOr0,
} from '../_shared/loyalty-utils.ts';
import { authorityLogRow } from '../_shared/loyalty-authority.ts';
import {
  decideEarnSource, earnItemsFromCheck, checkItemIds, checkCapMinor, type CheckRow,
} from '../_shared/earnFromCheck.ts';

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
    items: bodyItems = [],
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

  // ── Authority (18 Sep 2026) ────────────────────────────────────────────
  // customer_id and closed_check_id come from the body, so an anonymous session could mint
  // points for itself. Same rule as loyalty-redeem: a claimed device of this company, a Back
  // Office user with the location, or the member's own token. REPORT FIRST:
  // LOYALTY_AUTHORITY_MODE unset or 'report' earns exactly as before and records the calls
  // enforce would refuse (caller_authority_log); 'enforce' refuses them. Before any read.
  const gate = await checkLoyaltyAuthority({
    fn: 'loyalty-earn',
    caller,
    locationId: String(location_id),
    companyId: String(companyId),
    customerId: String(customer_id),
    memberToken: (body as any).member_token,
    closedCheckId: closed_check_id,
    channel,
    deviceHint: deviceHintOf(body),
  });
  if (!gate.allow) return gate.response!;

  // ── The check itself (round three) ────────────────────────────────────
  // Read at THIS location (the id may arrive as the Ops or the Platform id).
  const locKeys = [String(location_id)];
  {
    const { data: pl } = await platformAdmin.from('locations')
      .select('ops_location_id')
      .or(`id.eq.${uuidOr0(location_id)},ops_location_id.eq.${uuidOr0(location_id)}`)
      .limit(1).maybeSingle();
    if (pl?.ops_location_id && !locKeys.includes(String(pl.ops_location_id))) locKeys.push(String(pl.ops_location_id));
  }
  const { data: check } = await opsAdmin
    .from('closed_checks')
    .select('id, location_id, items, subtotal, total, status, voided, refunded, customer, customer_id, customer_phone')
    .eq('id', String(closed_check_id))
    .in('location_id', locKeys)
    .maybeSingle();
  const via = gate.decision.ok ? gate.decision.via : null;
  const source = decideEarnSource({
    mode: gate.mode,
    check: (check as CheckRow) ?? null,
    via,
    member: via === 'member' && gate.memberSession
      ? { customerId: gate.memberSession.customerId, phone: gate.memberSession.phone }
      : null,
  });
  if (source.record) {
    recordAuthority(authorityLogRow({
      fn: 'loyalty-earn', mode: gate.mode,
      outcome: source.use === 'refuse' ? 'refused' : 'would_refuse',
      decision: { ok: false, reason: source.record, callerKind: gate.decision.callerKind },
      user: caller, companyId, locationId: location_id, customerId: customer_id,
      closedCheckId: closed_check_id, channel, deviceHint: deviceHintOf(body),
    }));
  }
  if (source.use === 'refuse') {
    return json({ error: source.error, code: source.code, retryable: source.retryable }, source.status);
  }

  // ── Idempotency check (scoped to company) ─────────────────────────────
  const idempotencyKey = `earn:${closed_check_id}`;
  const alreadyEarned = async () => {
    const { data: byKey } = await opsAdmin
      .from('loyalty_transactions')
      .select('id, points, balance_after')
      .eq('idempotency_key', idempotencyKey)
      .eq('company_id', companyId)
      .maybeSingle();
    if (byKey) return byKey;
    // Round three: one earn per CHECK, whatever key an older client used for it.
    const { data: byCheck } = await opsAdmin
      .from('loyalty_transactions')
      .select('id, points, balance_after')
      .eq('closed_check_id', String(closed_check_id))
      .eq('company_id', companyId)
      .eq('type', 'earn')
      .limit(1)
      .maybeSingle();
    return byCheck;
  };
  const existingTx = await alreadyEarned();

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

  // ── What to earn on: the check (round three), or the body while the check has not landed ──
  let items: any[] = Array.isArray(bodyItems) ? bodyItems : [];
  let qualifyingMinor: number;
  if (source.use === 'check' && check) {
    const ids = checkItemIds(check as CheckRow);
    let menu: any[] = [];
    if (ids.length) {
      const { data: m } = await opsAdmin
        .from('menu_items')
        .select('id, cat, cats, parent_id')
        .in('location_id', locKeys)
        .in('id', ids.slice(0, 500));
      menu = m || [];
      // A variant's parent may not be on the check: fetch the parents the menu rows name.
      const parents = [...new Set(menu.map((r: any) => r.parent_id).filter((p: any) => p && !menu.some((x: any) => x.id === p)))];
      if (parents.length) {
        const { data: pm } = await opsAdmin.from('menu_items').select('id, cat, cats, parent_id').in('location_id', locKeys).in('id', parents.slice(0, 500));
        menu = menu.concat(pm || []);
      }
    }
    items = earnItemsFromCheck(check as CheckRow, menu);
    const cap = checkCapMinor(check as CheckRow);
    qualifyingMinor = items.length ? calculateQualifyingAmount(items, config) : cap;
    if (cap > 0) qualifyingMinor = Math.min(qualifyingMinor, cap);
  } else if (items.length > 0) {
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

  // ── Points + stamps can each be turned off (points-only / stamps-only / both) ──
  const pointsOn = config.points_enabled !== false;
  const stampsOn = config.stamps_enabled !== false;

  // ── Points (only when points collection is enabled) ─────────────────────
  // When points are off (stamp-cards-only venue), or the order earns 0 points, we DON'T
  // early-return — we fall through so stamp cards still get awarded below.
  let pointsEarned = 0;
  let newBalance = membership.points_balance;
  if (pointsOn) {
    pointsEarned = calculatePoints(
      qualifyingMinor,
      Number(config.points_per_currency_unit) || 1,
      tierMultiplier,
      config.points_rounding || 'floor',
    );
    if (pointsEarned > 0) {
      // Round three: the ledger row is the CLAIM and goes in first. earn:<check> is unique, so
      // of two racing calls exactly one writes it; the other is told already_processed and moves
      // nothing. balance_after is corrected once the balance has moved.
      const { data: claim, error: claimErr } = await opsAdmin.from('loyalty_transactions').insert({
        customer_id,
        company_id: companyId,
        location_id,
        type: 'earn',
        points: pointsEarned,
        balance_after: (membership.points_balance || 0) + pointsEarned,
        source: 'purchase',
        channel,
        closed_check_id,
        idempotency_key: idempotencyKey,
        qualifying_amount_minor: qualifyingMinor,
        multiplier_applied: tierMultiplier,
        tier_at_time: tierName,
        staff_id: staff_id || null,
      }).select('id').single();
      if (claimErr || !claim) {
        const again = await alreadyEarned();
        if (again) {
          return json({ status: 'already_processed', points_earned: again.points, balance: again.balance_after, member_code: membership.member_code });
        }
        return json({ error: `Failed to record the earn: ${claimErr?.message || 'no row'}` }, 500);
      }

      const nb = await updateBalance(membership.id, pointsEarned);
      if (nb === null) {
        // The balance did not move: take the claim back so a retry can do the whole job.
        await opsAdmin.from('loyalty_transactions').delete().eq('id', claim.id);
        return json({ error: 'Failed to update balance — concurrent modification' }, 409);
      }
      newBalance = nb;
      await opsAdmin.from('loyalty_transactions').update({ balance_after: nb }).eq('id', claim.id);

      // Lifetime stats
      await platformAdmin
        .from('customer_loyalty')
        .update({
          points_earned_total: (membership.points_earned_total || 0) + pointsEarned,
          visit_count: (membership.visit_count || 0) + 1,
          lifetime_spend_minor: (membership.lifetime_spend_minor || 0) + qualifyingMinor,
        })
        .eq('id', membership.id);

      // Registration bonus transaction (if new member with bonus). v5.5.321: the bonus was
      // already credited into points_balance at enrollment, so balance_after is the bonus itself.
      if (isNew && (config.registration_bonus || 0) > 0) {
        await opsAdmin.from('loyalty_transactions').insert({
          customer_id,
          company_id: companyId,
          location_id,
          type: 'bonus',
          points: config.registration_bonus,
          balance_after: config.registration_bonus,
          source: 'welcome',
          channel,
          idempotency_key: `welcome:${customer_id}:${companyId}`,
          note: 'Welcome bonus',
        });
      }
    }
  }

  // ── Stamp cards — award stamps for qualifying items (only when enabled) ──
  let stampsAwarded: { program_id: string; program_name: string; stamps: number; new_total: number; completed: boolean }[] = [];
  if (stampsOn) try {
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

  // ── Tier evaluation — auto-upgrade to highest qualifying tier ───────────
  let newTierName = tierName;
  try {
    const updatedStats = {
      points_earned_total: (membership.points_earned_total || 0) + pointsEarned,
      visit_count: (membership.visit_count || 0) + 1,
      lifetime_spend_minor: (membership.lifetime_spend_minor || 0) + qualifyingMinor,
    };

    const { data: allTiers } = await platformAdmin
      .from('loyalty_tiers')
      .select('id, name, min_points_earned, min_visits, min_spend_minor, points_multiplier, sort_order')
      .eq('company_id', companyId);

    if (allTiers && allTiers.length > 0) {
      // v5.5.312: pick the highest tier the customer qualifies for, ranked by
      // the actual qualification thresholds — NOT by sort_order. The tier
      // editor has no sort_order input, so every tier is created with
      // sort_order=0; ordering by it gave an arbitrary "highest" tier. Rank by
      // min_points_earned, then min_spend_minor, then min_visits (all desc) so
      // the most demanding qualifying tier always wins, deterministically.
      const qualifiedTier = allTiers
        .filter(t =>
          updatedStats.points_earned_total >= (t.min_points_earned || 0) &&
          updatedStats.visit_count >= (t.min_visits || 0) &&
          updatedStats.lifetime_spend_minor >= (t.min_spend_minor || 0)
        )
        .sort((a, b) =>
          (b.min_points_earned || 0) - (a.min_points_earned || 0) ||
          (b.min_spend_minor || 0) - (a.min_spend_minor || 0) ||
          (b.min_visits || 0) - (a.min_visits || 0)
        )[0] || null;

      const newTierId = qualifiedTier?.id || null;

      // Upgrade or assign tier if it changed
      if (newTierId !== membership.tier_id) {
        await platformAdmin
          .from('customer_loyalty')
          .update({
            tier_id: newTierId,
            tier_qualified_at: newTierId ? new Date().toISOString() : null,
          })
          .eq('id', membership.id);

        if (qualifiedTier) {
          newTierName = qualifiedTier.name;
          console.log(`[loyalty-earn] Tier ${membership.tier_id ? 'upgraded' : 'assigned'}: ${qualifiedTier.name} for customer ${customer_id}`);
        } else {
          newTierName = null;
          console.log(`[loyalty-earn] Tier removed for customer ${customer_id} — no longer qualifies`);
        }
      }
    }
  } catch (e) {
    console.warn('[loyalty-earn] tier evaluation failed (non-fatal):', e);
  }

  return json({
    status: 'ok',
    points_earned: pointsEarned,
    balance: newBalance,
    member_code: membership.member_code,
    tier: newTierName,
    is_new_member: isNew,
    qualifying_amount_minor: qualifyingMinor,
    multiplier: tierMultiplier,
    stamps_awarded: stampsAwarded.length > 0 ? stampsAwarded : undefined,
  });
});
