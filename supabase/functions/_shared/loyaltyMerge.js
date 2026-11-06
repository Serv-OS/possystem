// supabase/functions/_shared/loyaltyMerge.js (6 Nov 2026, marketing v3). PURE, no imports: node
// tests load it directly; marketing-send and the batch sender share one rule with the segment
// loyalty rules (segmentAudience.ts).
//
// Peter: "Loyalty points stamps into email campaigns". The merge tags are worked out from the SAME
// rows the loyalty portal reads (loyalty-otp memberAccount): Platform customer_loyalty (points,
// tier), loyalty_rewards (points_cost), stamp_card_programs (stamps_required) and
// customer_stamp_cards (stamps_collected, completed_count) with the Ops stamp_transactions
// 'redeem' rows taken off completed_count for rewards ready. Nothing is computed in the email.
//
// Tags (all company wide):
//   points_balance          the member's points now
//   points_to_next_reward   the smallest reward above the balance, minus the balance (0 when one is ready, or no rewards)
//   next_reward             that reward's name
//   tier                    the member's tier name ('' when the company has no tiers or they have none)
//   stamps_earned           stamps on the main card now (the card nearest its reward, like the portal)
//   stamps_target           that card's stamps_required
//   stamps_to_go            target minus earned (0 when the card is full)
//   stamp_reward            that card's reward wording
//   rewards_ready           free rewards waiting across every card
//   stamp_card              that card's name

const whole = (n) => Math.max(0, Math.floor(Number(n) || 0));

export const LOYALTY_TAGS = ['points_balance', 'points_to_next_reward', 'next_reward', 'tier', 'stamps_earned', 'stamps_target', 'stamps_to_go', 'stamp_reward', 'rewards_ready', 'stamp_card'];

/** True when a subject, body or sms mentions any loyalty tag: the send then reads loyalty, else it never does. */
export function mentionsLoyalty(...texts) {
  const re = new RegExp(`\\{\\{\\s*(${LOYALTY_TAGS.join('|')})\\s*(\\|[^}]*)?\\}\\}`, 'i');
  return texts.some((t) => re.test(String(t || '')));
}

/**
 * One member's stamp cards, cleaned, with the main card first (a reward ready, then nearest to
 * its reward, then the oldest program), exactly the portal's order.
 * @param {Array<{id, stamps_required, name, reward_description}>} programs active programs, in created order
 * @param {Array<{program_id, stamps_collected, completed_count}>} cards this member's cards
 * @param {Record<string, number>} redeemedByProgram program id -> count of 'redeem' stamp_transactions
 */
export function stampCardsFor(programs, cards, redeemedByProgram = {}) {
  const byProgram = new Map((Array.isArray(cards) ? cards : []).map((c) => [String(c.program_id), c]));
  return (Array.isArray(programs) ? programs : [])
    .map((p, i) => {
      const need = whole(p?.stamps_required);
      if (!need) return null;
      const c = byProgram.get(String(p.id));
      if (!c) return null;                                 // never started this card
      const have = Math.min(need, whole(c.stamps_collected));
      const ready = Math.max(0, whole(c.completed_count) - whole(redeemedByProgram[String(p.id)]));
      return { id: String(p.id), name: String(p.name || 'Stamp card'), reward: String(p.reward_description || p.name || 'reward'), have, need, toGo: need - have, ready, i };
    })
    .filter(Boolean)
    .sort((a, b) => (b.ready - a.ready) || (b.have / b.need - a.have / a.need) || (a.i - b.i));
}

/**
 * The merge values for one member.
 * @param {object|null} loyalty customer_loyalty row {points_balance, tier_id} or null when not a member
 * @param {Array<{points_cost, name, active}>} rewards the company's active rewards
 * @param {Array<{id, name}>} tiers the company's tiers
 * @param {Array} programs, cards, redeemedByProgram as stampCardsFor
 */
export function loyaltyMergeValues({ loyalty = null, rewards = [], tiers = [], programs = [], cards = [], redeemedByProgram = {} } = {}) {
  const balance = whole(loyalty?.points_balance);
  const costs = (Array.isArray(rewards) ? rewards : [])
    .filter((r) => r && (r.active == null || r.active === true) && whole(r.points_cost) > 0)
    .sort((a, b) => whole(a.points_cost) - whole(b.points_cost));
  const next = costs.find((r) => whole(r.points_cost) > balance) || null;
  const tier = loyalty?.tier_id ? (Array.isArray(tiers) ? tiers : []).find((t) => String(t.id) === String(loyalty.tier_id)) : null;
  const stamps = stampCardsFor(programs, cards, redeemedByProgram);
  const main = stamps[0] || null;
  return {
    points_balance: loyalty ? balance : 0,
    points_to_next_reward: next ? whole(next.points_cost) - balance : 0,
    next_reward: next ? String(next.name || '') : '',
    tier: tier ? String(tier.name || '') : '',
    stamps_earned: main ? main.have : 0,
    stamps_target: main ? main.need : 0,
    stamps_to_go: main ? main.toGo : 0,
    stamp_reward: main ? main.reward : '',
    rewards_ready: stamps.reduce((n, c) => n + c.ready, 0),
    stamp_card: main ? main.name : '',
  };
}

/** A segment rule on loyalty, decided per member from the same values. Returns true when the member matches. */
export function loyaltyRuleMatches(rule, values, member) {
  const op = String(rule?.op || 'eq').toLowerCase();
  const field = String(rule?.field || '');
  if (field === 'loyalty_member') return op === 'is_false' ? !member : !!member;
  if (field === 'tier') {
    const want = Array.isArray(rule?.value) ? rule.value.map((v) => String(v).toLowerCase()) : [String(rule?.value ?? '').toLowerCase()];
    const have = String(values?.tier || '').toLowerCase();
    const hit = want.includes(have) && have !== '';
    return op === 'neq' || op === 'not_in' ? !hit : hit;
  }
  const n = Number(values?.[field]);
  if (!Number.isFinite(n)) return false;
  const v = Number(rule?.value);
  if (!Number.isFinite(v)) return false;
  switch (op) {
    case 'eq': return n === v;
    case 'neq': return n !== v;
    case 'gt': return n > v;
    case 'gte': return n >= v;
    case 'lt': return n < v;
    case 'lte': return n <= v;
    default: return false;
  }
}

export const LOYALTY_RULE_FIELDS = ['points_balance', 'points_to_next_reward', 'stamps_earned', 'stamps_to_go', 'rewards_ready', 'loyalty_member', 'tier'];

/** The fields the Ops resolver does not know: these are expanded into customer_id lists first. */
export function isLoyaltyRule(rule) {
  return !!rule && typeof rule === 'object' && !Array.isArray(rule.rules) && LOYALTY_RULE_FIELDS.includes(String(rule.field || ''));
}

/** Walk a definition (groups to any depth) and collect every loyalty rule. */
export function collectLoyaltyRules(def, out = []) {
  if (!def || typeof def !== 'object') return out;
  for (const r of Array.isArray(def.rules) ? def.rules : []) {
    if (r && Array.isArray(r.rules)) collectLoyaltyRules(r, out);
    else if (isLoyaltyRule(r)) out.push(r);
  }
  return out;
}

/**
 * The same definition with every loyalty rule replaced by {field:'customer_id', op:'in', value:[ids]}.
 * `idsFor(rule)` returns the member ids that match that rule. A non member never matches a points or
 * stamps rule, so "is not a member" is the one rule that expands to 'not_in' of the member list.
 */
export function expandLoyaltyRules(def, idsFor) {
  if (!def || typeof def !== 'object') return def;
  const rules = (Array.isArray(def.rules) ? def.rules : []).map((r) => {
    if (r && Array.isArray(r.rules)) return expandLoyaltyRules(r, idsFor);
    if (!isLoyaltyRule(r)) return r;
    const want = idsFor(r);
    return { field: 'customer_id', op: want.negate ? 'not_in' : 'in', value: want.ids };
  });
  return { ...def, rules };
}
