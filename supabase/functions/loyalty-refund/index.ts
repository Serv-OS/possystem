// supabase/functions/loyalty-refund/index.ts
//
// Reverse loyalty points when a check is refunded/voided.
// Called by store.refundCheck() — fire-and-forget, same pattern as
// gift-reverse-redeem.
//
// Body: {
//   customer_id,
//   location_id,
//   closed_check_id,    -- the check being refunded
//   reason?,
//   staff_id?,
// }
//
// Reverses ALL loyalty transactions for the given check:
//   - earn → clawback (negative points)
//   - redeem → restore (positive points)
//
// Redemptions the Ops ledger is missing are picked up from the Platform redemption
// claims: loyalty-redeem debits the balance on Platform and writes the Ops ledger row
// afterwards (two clusters, no shared transaction), so a redemption can exist with no
// ledger row to find.
//
// Idempotent via refund:{closed_check_id}
//
// STAMP REWARDS (30 Sep 2026, review of multi redeem): a stamp card reward is not points. It is
// a stamp_transactions type='redeem' row (order_ref = the check id) that loyalty-balance,
// loyalty-redeem, loyalty-earn adjust_stamps and Back Office all COUNT against the card's
// completed_count. Nothing here ever gave one back, so a refunded order left the member's
// completed card spent, and with two rewards on one order that showed. Now each redeem row of the
// check is restored: an audit row (type='refund', key stamprefund:<redeem key>) is written FIRST
// as the claim, then the redeem row is deleted, so every reader counts the reward available again
// at once. Idempotent on its own (a retry finds no redeem row). Whole check, like the points path.
//
// 19 Oct 2026 (v5.11.78, channel parity): a full refund puts loyalty back exactly as it was.
//   * customer_id is optional. The till only knew it when the check carried it, and a stamps
//     only member's check never did, so every refund skipped this function ("no customer_id on
//     check"): 0 stamp refund rows and 0 points refund rows ever. With none sent, the customer is
//     the one this check's own ledger rows name (stamp_transactions.order_ref, loyalty_transactions
//     .closed_check_id); exactly one, or nothing is done.
//   * stamps EARNED on the refunded sale come off the card, as points earned always did
//     (_shared/stampAdjust.js planStampClawback: the stamps first, then an UNUSED completed card,
//     never a reward already used). An audit row (type 'refund', negative stamps, key
//     stamprefund:earn:<earn key>) is written FIRST as the claim, then the card moves only from the
//     state it was read in, and the redeem rows are counted again after the move (the adjust_stamps
//     rule in loyalty-earn), so a reward taken this second is never left in debt.
//   * the till calls this on a FULL refund only (store.refundCheck): it reverses the whole check.
//
// v5.11.81 (19 Oct 2026): a PART refund takes back what the refunded part earned
// (_shared/loyaltyPartRefund.js). Body adds { part: true, refund_id, share, items }:
//   * points: floor(points earned x share of the goods refunded), its own row refund:<check>:<refund id>;
//   * stamps: the qualifying items refunded (counted with loyalty-earn's own rule), its own row
//     stamprefund:earn:<earn key>:<refund id>;
//   * a reward used on the check stays used; only a FULL refund gives it back.
// A full refund after part refunds takes only what they left. v5.11.78 reversed nothing on a part
// refund (and before it, the whole check).

import {
  cors, json, opsAdmin, platformAdmin, authenticateCaller,
  resolveCompanyForLocation, updateBalance, checkLoyaltyAuthority, deviceHintOf,
} from '../_shared/loyalty-utils.ts';
import { planStampClawback } from '../_shared/stampAdjust.js';
import { countQualifyingStamps, loadStampNameIndex } from '../_shared/stampQualify.ts';
import {
  partRefundKey, isPartRefundKey, partStampKey, isPartStampKey, refundShare,
  partRefundPoints, partRefundStamps, remainingAfterParts,
} from '../_shared/loyaltyPartRefund.js';

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
    customer_id: bodyCustomerId,
    location_id,
    closed_check_id,
    reason,
    staff_id,
  } = body as any;

  if (!closed_check_id) return json({ error: 'closed_check_id required' }, 400);
  if (!location_id) return json({ error: 'location_id required' }, 400);
  // v5.11.81: a part refund names itself, its refund id, the share of the goods it returned and the
  // lines it returned (for the stamps).
  const part = (body as any).part === true;
  const refundId = part ? String((body as any).refund_id || '').trim().slice(0, 80) : '';
  const share = part ? refundShare((body as any).share) : 1;
  const partItems = part && Array.isArray((body as any).items) ? ((body as any).items as any[]).slice(0, 500) : [];
  if (part && !refundId) return json({ error: 'refund_id required for a part refund' }, 400);

  // ── Resolve company (validates caller access) ─────────────────────────
  // v5.5.218: Must validate the caller has access to this company via their
  // location, same as gift-reverse-redeem. Without this, a user from Company A
  // could reverse loyalty transactions belonging to Company B.
  const resolved = await resolveCompanyForLocation(caller.id, location_id as string);
  if (resolved instanceof Response) return resolved;
  const companyId = resolved;

  // ── Authority (database fence stage 1) ─────────────────────────────────
  // Resolving the company proves nothing about the caller (the location id is public), so any
  // anonymous session could reverse anybody's transactions (a refunded redemption gives the
  // points back). A device bound to this venue or a Back Office user of the venue; NOT the
  // member's own token. Report before 20260919a (refunds as before, the ones enforce would
  // refuse are logged), enforced by itself once it has run.
  const gate = await checkLoyaltyAuthority({
    fn: 'loyalty-refund',
    caller,
    locationId: String(location_id),
    companyId: String(companyId),
    customerId: String(bodyCustomerId || ''),
    memberToken: (body as any).member_token,
    closedCheckId: closed_check_id,
    channel: (body as any).channel ?? null,
    // A refund is a TILL action. A member's own token never passes it (a member refunding their
    // own redemption would keep the reward and get the points back); only a device bound to the
    // venue or staff may refund.
    memberAllowed: false,
    deviceHint: deviceHintOf(body),
  });
  if (!gate.allow) return gate.response!;

  // ── The customer (19 Oct 2026): the one sent, else the one this check's own ledger names ──
  let customer_id: string | null = bodyCustomerId ? String(bodyCustomerId) : null;
  if (!customer_id) {
    const [{ data: sRows, error: sErr }, { data: lRows, error: lErr }] = await Promise.all([
      opsAdmin.from('stamp_transactions').select('customer_id').eq('order_ref', String(closed_check_id)).limit(50),
      opsAdmin.from('loyalty_transactions').select('customer_id').eq('closed_check_id', String(closed_check_id)).eq('company_id', companyId).limit(50),
    ]);
    if (sErr || lErr) return json({ error: 'could not read the loyalty ledger, refund not attempted' }, 500);
    const names = new Set([...(sRows || []), ...(lRows || [])].map((r: any) => r?.customer_id).filter(Boolean).map(String));
    if (names.size !== 1) {
      return json({ status: 'no_transactions', points_reversed: 0, stamp_rewards_restored: 0, stamps_clawed: 0, ...(names.size > 1 ? { reason: 'more_than_one_customer' } : {}) });
    }
    customer_id = [...names][0];
  }

  // ── Stamps EARNED on this check come off the card (19 Oct 2026) ────────────────────────
  let stampsClawed = 0;
  {
    const { data: stampEarns, error: earnReadErr } = await opsAdmin
      .from('stamp_transactions')
      .select('id, program_id, location_id, stamps, idempotency_key')
      .eq('customer_id', customer_id)
      .eq('order_ref', String(closed_check_id))
      .eq('type', 'earn');
    if (earnReadErr) {
      return json({ error: `could not read the stamp ledger, refund not attempted: ${earnReadErr.message}` }, 500);
    }
    // v5.11.81: the stamps earlier part refunds of this check already took back, per earn row.
    const { data: stampRefunds, error: refReadErr } = (stampEarns || []).length
      ? await opsAdmin.from('stamp_transactions').select('stamps, idempotency_key, program_id')
        .eq('customer_id', customer_id).eq('order_ref', String(closed_check_id)).eq('type', 'refund')
      : { data: [], error: null };
    if (refReadErr) {
      return json({ error: `could not read the stamp ledger, refund not attempted: ${refReadErr.message}` }, 500);
    }
    let stampNames: any = null;
    for (const row of stampEarns || []) {
      const earned = Math.max(0, Math.floor(Number(row.stamps) || 0));
      if (!earned || !row.program_id) continue;
      const earnKey = String(row.idempotency_key || row.id);
      const fullKey = `stamprefund:earn:${earnKey}`;
      const claimKey = part ? partStampKey(earnKey, refundId) : fullKey;
      const { data: done } = await opsAdmin.from('stamp_transactions').select('id').eq('idempotency_key', claimKey).maybeSingle();
      if (done) continue;
      if (part) {
        // A full refund already took this earn back: a part refund after it takes nothing.
        const { data: fullDone } = await opsAdmin.from('stamp_transactions').select('id').eq('idempotency_key', fullKey).maybeSingle();
        if (fullDone) continue;
      }
      const alreadyTaken = (stampRefunds || [])
        .filter((r: any) => isPartStampKey(r?.idempotency_key, earnKey))
        .reduce((n: number, r: any) => n + Math.max(0, -Math.floor(Number(r?.stamps) || 0)), 0);
      const { data: prog } = await platformAdmin.from('stamp_card_programs')
        .select('id, stamps_required, qualifying_category_ids, qualifying_item_ids').eq('id', row.program_id).eq('company_id', companyId).maybeSingle();
      if (!prog) continue;
      let toClaw: number;
      if (part) {
        if (stampNames === null) stampNames = await loadStampNameIndex(opsAdmin, [prog], partItems);
        toClaw = partRefundStamps({ earned, alreadyTaken, refundedQualifying: countQualifyingStamps(partItems, prog as any, stampNames) });
      } else {
        toClaw = remainingAfterParts({ earned, alreadyTaken });
      }
      if (!toClaw) continue;
      const { data: card } = await platformAdmin.rpc('upsert_customer_stamp_card', {
        p_customer_id: customer_id, p_program_id: prog.id, p_company_id: companyId,
      });
      if (!card) return json({ error: 'could not read the stamp card, refund not attempted' }, 503);
      const countRedeemed = async (): Promise<number> => {
        const { count } = await opsAdmin.from('stamp_transactions').select('id', { count: 'exact', head: true })
          .eq('customer_id', customer_id).eq('program_id', prog.id).eq('type', 'redeem');
        return count || 0;
      };
      const plan = planStampClawback(card, await countRedeemed(), { stamps: toClaw, stampsRequired: prog.stamps_required });
      if (!plan.clawed) continue;
      const { data: ins, error: insErr } = await opsAdmin.from('stamp_transactions').insert({
        customer_id,
        program_id: prog.id,
        location_id: row.location_id || location_id,
        stamps: -plan.clawed,
        type: 'refund',
        note: `Stamps taken back: ${part ? 'part of the order' : 'order'} refunded${reason ? ` (${reason})` : ''}${plan.clawed < toClaw ? ` (${toClaw - plan.clawed} left: a reward was already used)` : ''}`,
        order_ref: String(closed_check_id),
        idempotency_key: claimKey,
      }).select('id').single();
      if (insErr?.code === '23505') continue;   // a previous attempt claimed it
      if (insErr || !ins) return json({ error: 'could not record the stamp refund, refund not attempted' }, 500);
      const { data: moved, error: updErr } = await platformAdmin.from('customer_stamp_cards')
        .update({ stamps_collected: plan.stamps_collected, completed_count: plan.completed_count })
        .eq('id', card.id).eq('stamps_collected', card.stamps_collected).eq('completed_count', card.completed_count)
        .select('id');
      if (updErr || !moved || moved.length === 0) {
        await opsAdmin.from('stamp_transactions').delete().eq('id', ins.id);
        return json({ error: 'the stamp card changed a moment ago, try the refund again', code: 'changed' }, 409);
      }
      if (plan.completed_count - (await countRedeemed()) < 0) {
        await platformAdmin.from('customer_stamp_cards')
          .update({ stamps_collected: card.stamps_collected, completed_count: card.completed_count })
          .eq('id', card.id).eq('stamps_collected', plan.stamps_collected).eq('completed_count', plan.completed_count);
        await opsAdmin.from('stamp_transactions').delete().eq('id', ins.id);
        return json({ error: 'a reward was used a moment ago, try the refund again', code: 'changed' }, 409);
      }
      stampsClawed += plan.clawed;
    }
    if (stampsClawed > 0) console.info(`[loyalty-refund] took back ${stampsClawed} stamp(s) earned on check ${closed_check_id}`);
  }

  // ── Stamp rewards redeemed on this check: give the completed cards back ────────────────
  // Before the points idempotency check on purpose: a check with only stamp rewards has no
  // loyalty_transactions row, and answered 'no_transactions' having restored nothing.
  let stampRewardsRestored = 0;
  // v5.11.81: a part refund leaves a reward used on the check used (the visit happened).
  if (!part) {
    const { data: stampRedeems, error: stampReadErr } = await opsAdmin
      .from('stamp_transactions')
      .select('id, program_id, location_id, note, idempotency_key')
      .eq('customer_id', customer_id)
      .eq('order_ref', String(closed_check_id))
      .eq('type', 'redeem');
    if (stampReadErr) {
      return json({ error: `could not read the stamp ledger, refund not attempted: ${stampReadErr.message}` }, 500);
    }
    for (const row of stampRedeems || []) {
      const { error: auditErr } = await opsAdmin.from('stamp_transactions').insert({
        customer_id,
        program_id: row.program_id,
        location_id: row.location_id || location_id,
        stamps: 0,
        type: 'refund',
        note: `Reward restored: order refunded${reason ? ` (${reason})` : ''}. Was: ${row.note || 'Redeemed'}`,
        order_ref: String(closed_check_id),
        idempotency_key: `stamprefund:${row.idempotency_key || row.id}`,
      });
      // 23505: a previous attempt wrote the audit row and fell over before the delete. Carry on.
      if (auditErr && auditErr.code !== '23505') {
        console.error('[loyalty-refund] stamp restore audit insert failed:', auditErr.message);
        return json({ error: 'could not record the stamp reward restore, refund not attempted' }, 500);
      }
      const { error: delErr } = await opsAdmin.from('stamp_transactions').delete().eq('id', row.id).eq('type', 'redeem');
      if (delErr) {
        console.error('[loyalty-refund] stamp restore delete failed:', delErr.message);
        return json({ error: 'could not restore the stamp reward, refund not attempted' }, 500);
      }
      stampRewardsRestored += 1;
    }
    if (stampRewardsRestored > 0) console.info(`[loyalty-refund] restored ${stampRewardsRestored} stamp reward(s) on check ${closed_check_id}`);
  }

  // ── Idempotency check (scoped to company) ─────────────────────────────
  const fullRefundKey = `refund:${closed_check_id}`;
  const idempotencyKey = part ? partRefundKey(String(closed_check_id), refundId) : fullRefundKey;
  const { data: existingRefund } = await opsAdmin
    .from('loyalty_transactions')
    .select('id, points, balance_after')
    .eq('idempotency_key', idempotencyKey)
    .eq('company_id', companyId)
    .maybeSingle();
  // v5.11.81: a part refund after the full refund takes nothing (the full one took everything).
  const { data: fullRefundRow } = part
    ? await opsAdmin.from('loyalty_transactions').select('id, points, balance_after')
      .eq('idempotency_key', fullRefundKey).eq('company_id', companyId).maybeSingle()
    : { data: null };
  if (!existingRefund && fullRefundRow) {
    return json({ status: 'already_processed', points_reversed: 0, balance: fullRefundRow.balance_after, stamp_rewards_restored: 0, stamps_clawed: stampsClawed });
  }

  if (existingRefund) {
    return json({
      status: 'already_processed',
      points_reversed: existingRefund.points,
      balance: existingRefund.balance_after,
      stamp_rewards_restored: stampRewardsRestored,
      stamps_clawed: stampsClawed,
    });
  }

  // ── Find original transactions for this check ──────────────────────────
  // The error MUST be checked. This read used to be harmless to lose: a null result answered
  // 'no_transactions' having written nothing, so a retry could still do the whole job. Now that the
  // Platform claims fallback below merges into this list, a failed read produces a PARTIAL reversal
  // — the claim rows reverse, the earn row does not — and the refund ledger row it writes makes that
  // partial state permanent, because the next attempt short-circuits on it as already refunded.
  const { data: originalTxs, error: txReadErr } = await opsAdmin
    .from('loyalty_transactions')
    .select('*')
    .eq('closed_check_id', closed_check_id)
    .eq('customer_id', customer_id)
    .eq('company_id', companyId)
    .order('created_at');
  if (txReadErr) {
    return json({ error: `could not read the loyalty ledger — refund not attempted: ${txReadErr.message}` }, 500);
  }

  // ── Get membership ─────────────────────────────────────────────────────
  // Read before the reversal maths because the claims fallback below is fenced on
  // membership.id. The 404 stays where it was, after the "nothing found" answers.
  const { data: membership } = await platformAdmin
    .from('customer_loyalty')
    .select('id, points_balance, points_earned_total, points_redeemed_total, visit_count, lifetime_spend_minor, tier_id')
    .eq('customer_id', customer_id)
    .eq('company_id', companyId)
    .maybeSingle();

  // ── Fill the gaps from the Platform redemption claims ──────────────────
  // The points debit and its ledger row are on two different Postgres clusters, so
  // loyalty-redeem can take the points and then fail to land the Ops ledger row. Such a
  // redemption is invisible to the query above — the customer would be debited, the sale
  // refunded, and the points never given back. The claim row
  // (platform.loyalty_redemption_claims, migration 20260806c) holds the membership, the points
  // and the reward, which is exactly what a reversal needs. Its primary key is the redeem
  // idempotency key, shape `redeem:<closed_check_id>:<reward_id>`.
  //
  // Checked on EVERY refund, not just when the ledger came back empty: the earn row is written
  // by a different function, so the usual shape of this failure is a check that HAS its earn
  // row and is missing only the redeem one.
  let claimTxs: any[] = [];
  if (membership && !part) {
    const prefix = `redeem:${closed_check_id}:`;
    const { data: claims } = await platformAdmin
      .from('loyalty_redemption_claims')
      .select('idempotency_key, points, reward_id')
      .eq('membership_id', membership.id)
      .like('idempotency_key', `${prefix}%`);
    const ledgerKeys = new Set((originalTxs || []).map((t) => t.idempotency_key));
    claimTxs = (claims || [])
      // `_` is a LIKE wildcard and check ids can contain one, so re-check the prefix literally:
      // a claim from a different check of the same length must never be reversed here.
      .filter((c) => String(c.idempotency_key).startsWith(prefix) && !ledgerKeys.has(c.idempotency_key))
      .map((c) => ({
        type: 'redeem',
        points: -Math.abs(c.points),   // ledger rows store redeems negative; claims store the magnitude
        reward_id: c.reward_id,
        channel: null,
        location_id: null,
      }));
    if (claimTxs.length > 0) {
      console.warn(`[loyalty-refund] ${claimTxs.length} redemption(s) on check ${closed_check_id} have no Ops ledger row — reversing them from the Platform claim rows`);
    }
  }

  const sourceTxs = [...(originalTxs || []), ...claimTxs];

  if (sourceTxs.length === 0) {
    return json({ status: 'no_transactions', points_reversed: 0, stamp_rewards_restored: stampRewardsRestored, stamps_clawed: stampsClawed });
  }

  // Calculate net reversal: earned points get clawed back (negative),
  // redeemed points get restored (positive)
  // v5.11.81: the points earlier part refunds of this check already took back (positive figure).
  const partTaken = (originalTxs || [])
    .filter((t: any) => t.type === 'refund' && isPartRefundKey(t.idempotency_key, String(closed_check_id)))
    .reduce((n: number, t: any) => n + Math.max(0, -(Number(t.points) || 0)), 0);
  let netReversal = 0;
  if (part) {
    // A part refund: the share of the points earned, never a redeem (the reward stays used).
    const earned = sourceTxs.filter((t: any) => t.type === 'earn' || t.type === 'bonus')
      .reduce((n: number, t: any) => n + (Number(t.points) || 0), 0);
    netReversal = -partRefundPoints({ earned, alreadyTaken: partTaken, share });
  } else {
    for (const tx of sourceTxs) {
      if (tx.type === 'earn' || tx.type === 'bonus') {
        // Clawback: reverse the earn
        netReversal -= tx.points;
      } else if (tx.type === 'redeem') {
        // Restore: reverse the redeem (tx.points is already negative)
        netReversal -= tx.points; // double negative = positive
      }
    }
    // What part refunds already took back is not taken twice.
    netReversal += partTaken;
  }

  if (netReversal === 0) {
    return json({ status: 'nothing_to_reverse', points_reversed: 0, stamp_rewards_restored: stampRewardsRestored, stamps_clawed: stampsClawed });
  }

  if (!membership) {
    return json({ error: 'Membership not found' }, 404);
  }

  // ── Apply reversal ─────────────────────────────────────────────────────
  // Ensure balance doesn't go negative (clawback can't take more than balance)
  const effectiveReversal = Math.max(
    netReversal,
    -membership.points_balance,
  );

  const newBalance = await updateBalance(membership.id, effectiveReversal);
  if (newBalance === null) {
    return json({ error: 'Failed to update balance' }, 500);
  }

  // ── Update lifetime stats ──────────────────────────────────────────────
  const updates: Record<string, any> = {};
  if (effectiveReversal < 0) {
    // Clawback: reduce earned total
    updates.points_earned_total = Math.max(
      0,
      (membership.points_earned_total || 0) + effectiveReversal,
    );
  } else if (effectiveReversal > 0) {
    // Restore: reduce redeemed total
    updates.points_redeemed_total = Math.max(
      0,
      (membership.points_redeemed_total || 0) - effectiveReversal,
    );
  }
  if (Object.keys(updates).length > 0) {
    await platformAdmin
      .from('customer_loyalty')
      .update(updates)
      .eq('id', membership.id);
  }

  // ── v5.5.315 (H4): release reward inventory for reversed redemptions ─────
  // loyalty-redeem increments loyalty_rewards.total_redeemed (which gates
  // limited-availability rewards). A refund must give that stock back, else a
  // limited reward reports "sold out" earlier than it should after refunds.
  if (!part) try {
    for (const tx of sourceTxs) {
      if (tx.type === 'redeem' && tx.reward_id) {
        const { data: rw } = await platformAdmin
          .from('loyalty_rewards')
          .select('id, total_redeemed')
          .eq('id', tx.reward_id)
          .maybeSingle();
        if (rw) {
          await platformAdmin
            .from('loyalty_rewards')
            .update({ total_redeemed: Math.max(0, (rw.total_redeemed || 0) - 1) })
            .eq('id', rw.id);
        }
      }
    }
  } catch (e) {
    console.warn('[loyalty-refund] reward total_redeemed reversal failed (non-fatal):', e);
  }

  // ── v5.5.315 (H2): re-evaluate tier after the clawback ──────────────────
  // The refund reduced points_earned_total; the customer may no longer qualify
  // for their tier. Demote (or adjust) to the highest tier they still qualify
  // for, so they don't keep an over-privileged earning multiplier. Mirrors the
  // deterministic ranking in loyalty-earn.
  try {
    const newEarnedTotal = Math.max(0, (membership.points_earned_total || 0) + Math.min(0, effectiveReversal));
    const stats = {
      points_earned_total: newEarnedTotal,
      visit_count: membership.visit_count || 0,
      lifetime_spend_minor: membership.lifetime_spend_minor || 0,
    };
    const { data: allTiers } = await platformAdmin
      .from('loyalty_tiers')
      .select('id, min_points_earned, min_visits, min_spend_minor')
      .eq('company_id', companyId);
    if (allTiers && allTiers.length > 0) {
      const qualifiedTier = allTiers
        .filter(t =>
          stats.points_earned_total >= (t.min_points_earned || 0) &&
          stats.visit_count >= (t.min_visits || 0) &&
          stats.lifetime_spend_minor >= (t.min_spend_minor || 0)
        )
        .sort((a, b) =>
          (b.min_points_earned || 0) - (a.min_points_earned || 0) ||
          (b.min_spend_minor || 0) - (a.min_spend_minor || 0) ||
          (b.min_visits || 0) - (a.min_visits || 0)
        )[0] || null;
      const newTierId = qualifiedTier?.id || null;
      if (newTierId !== membership.tier_id) {
        await platformAdmin
          .from('customer_loyalty')
          .update({ tier_id: newTierId, tier_qualified_at: newTierId ? new Date().toISOString() : null })
          .eq('id', membership.id);
      }
    }
  } catch (e) {
    console.warn('[loyalty-refund] tier re-evaluation failed (non-fatal):', e);
  }

  // ── Write refund transaction ───────────────────────────────────────────
  await opsAdmin.from('loyalty_transactions').insert({
    customer_id,
    company_id: companyId,
    location_id: location_id || sourceTxs[0].location_id,
    type: 'refund',
    points: effectiveReversal,
    balance_after: newBalance,
    source: 'purchase',
    channel: sourceTxs[0].channel,
    closed_check_id,
    idempotency_key: idempotencyKey,
    staff_id: staff_id || null,
    note: part
      ? (reason ? `Part refund: ${reason}` : 'Part of the order refunded: points it earned taken back')
      : (reason ? `Refund: ${reason}` : 'Order refunded — loyalty reversed'),
  });

  return json({
    status: 'ok',
    points_reversed: effectiveReversal,
    balance: newBalance,
    original_transactions: sourceTxs.length,
    stamp_rewards_restored: stampRewardsRestored,
    stamps_clawed: stampsClawed,
    ...(claimTxs.length > 0 ? { claims_reversed: claimTxs.length } : {}),
  });
});
