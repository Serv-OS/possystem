// src/lib/portalLoyaltyView.js
//
// What the customer loyalty app shows on its home page (21 Oct 2026).
//
// Peter, Coffee Boy: "Customers are getting confused as on Coffee Boy they have points off but on
// the main loyalty page it says zero points. We need the customer facing loyalty app to show what
// is turned on, Stamps or Points, on the home page, and make it more obvious."
//
// The cause: loyalty-otp's sign in reply carried no points_enabled or stamps_enabled, and the app
// treated a missing flag as ON, so a stamps only company showed "0 loyalty points" right after
// sign in (and no points after a reload, which went another way). loyalty-otp now sends the flags
// on every reply. This helper decides, from that reply, what the home page shows:
//   * mode: 'stamps' | 'points' | 'both' | 'none'
//   * every stamp card in plain words ("4 of 10 stamps", "6 more stamps for your Free Drink")
//   * rewards ready, cards finished and rewards used, by the one rule Back Office uses
//     (completed cards minus redeem rows; see stampSummary.stampCardWords)
//   * which tabs show
// A reply with no flags (a loyalty-otp that has not been redeployed yet) is read from the data
// instead: stamp cards and no points activity means stamps. It never defaults to points.
//
// Pure: no React, no fetch. Tested in portalLoyaltyView.test.js.

import { stampDots, stampCardWords } from './stampSummary.js';

const whole = (n) => Math.max(0, Math.floor(Number(n) || 0));
const isFlag = (v) => typeof v === 'boolean';

/**
 * Which kinds of loyalty the company runs.
 * @param {object|null} loyalty the reply's loyalty object (null: loyalty is off for this company)
 * @param {object} [reply] the whole reply, whose top level may carry the flags too
 * @param {any[]} [cards] the stamp cards in the reply
 * @returns {{ known: boolean, loyaltyOn: boolean, pointsOn: boolean, stampsOn: boolean }}
 */
export function loyaltyFlags(loyalty, reply = {}, cards = []) {
  if (!loyalty) return { known: true, loyaltyOn: false, pointsOn: false, stampsOn: false };
  const pick = (k) => (isFlag(loyalty[k]) ? loyalty[k] : (reply && isFlag(reply[k]) ? reply[k] : undefined));
  if (pick('loyalty_enabled') === false) return { known: true, loyaltyOn: false, pointsOn: false, stampsOn: false };
  const p = pick('points_enabled');
  const s = pick('stamps_enabled');
  const hasCards = Array.isArray(cards) && cards.length > 0;
  // No flag from the server: read it from the data, never assume points.
  const guessStamps = hasCards;
  const guessPoints = !hasCards
    || whole(loyalty.points_balance) > 0
    || whole(loyalty.points_earned_total) > 0
    || (Array.isArray(loyalty.all_rewards) && loyalty.all_rewards.length > 0)
    || !!loyalty.tier;
  return {
    known: isFlag(p) && isFlag(s),
    loyaltyOn: true,
    pointsOn: isFlag(p) ? p : guessPoints,
    stampsOn: isFlag(s) ? s : guessStamps,
  };
}

/**
 * One stamp card in plain words.
 * @param {object} c a stamp card from the reply ({ id, name, icon, stamps_required, stamps_collected, completed_count, rewards_available, reward_description })
 * @param {Record<string, number>} [readyByProgram] stamp_rewards' available counts, for a card that does not carry rewards_available
 */
export function stampCardView(c, readyByProgram = {}) {
  const need = whole(c?.stamps_required);
  if (!need) return null;
  const have = Math.min(need, whole(c?.stamps_collected));
  const finished = whole(c?.completed_count);
  const id = String(c?.id ?? c?.program_id ?? c?.name ?? '');
  const ready = c?.rewards_available != null && c?.rewards_available !== ''
    ? whole(c.rewards_available)
    : whole(readyByProgram[id]);
  const reward = String(c?.reward_description || c?.name || 'reward').trim();
  const toGo = need - have;
  const words = stampCardWords({ finished, ready });
  return {
    id,
    name: String(c?.name || 'Stamp card'),
    icon: String(c?.icon || '☕'),
    description: c?.description ? String(c.description) : '',
    need, have, toGo, finished, ready, used: words.usedCount, reward,
    dots: stampDots(have, need),
    countText: `${have} of ${need} stamps`,
    toGoText: toGo > 0 ? `${toGo} more stamp${toGo === 1 ? '' : 's'} for your ${reward}` : `Card full: your ${reward} is next`,
    readyText: ready > 0 ? `${reward}: ${ready} ready to use` : `${reward}: none ready yet`,
    finishedText: words.finished,
    usedText: words.used,
    readyNowText: words.ready,
    // The line Back Office prints under the card, word for word.
    summaryText: `${words.finished} · ${words.used} · ${words.ready}`,
  };
}

/**
 * The last 4 digits of the member's phone, so they can see which account they are in.
 *
 * 4, not 3 (21 Oct 2026): the member who saw one stamp had a second account on a phone that
 * differs from his first one in the 4th digit from the end, so the last 3 read the same on both
 * accounts and only the member code told them apart. 4 digits is also what the email join notice
 * says ("your phone ending 8167", _shared/portalEmailJoin.phoneEnding).
 */
export function phoneEnding(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-4) : '';
}

/**
 * Everything the home page needs.
 * @param {{ loyalty?: object|null, stampCards?: any[], reply?: object, customer?: object|null }} input
 */
export function portalLoyaltyView({ loyalty = null, stampCards = [], reply = {}, customer = null } = {}) {
  const rawCards = Array.isArray(stampCards) && stampCards.length
    ? stampCards
    : (Array.isArray(loyalty?.stamp_cards) ? loyalty.stamp_cards : []);
  const flags = loyaltyFlags(loyalty, reply, rawCards);

  const readyByProgram = {};
  for (const r of (Array.isArray(loyalty?.stamp_rewards) ? loyalty.stamp_rewards : [])) {
    if (r && r.program_id != null) readyByProgram[String(r.program_id)] = whole(r.available);
  }
  const cards = rawCards.map((c) => stampCardView(c, readyByProgram)).filter(Boolean);

  const showStamps = flags.stampsOn && cards.length > 0;
  const showPoints = flags.pointsOn;
  const mode = showPoints && showStamps ? 'both' : showPoints ? 'points' : showStamps ? 'stamps' : 'none';

  // The main card: one with a reward ready, then the one closest to its reward, then the first.
  const ordered = cards
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.ready - a.c.ready) || (b.c.have / b.c.need - a.c.have / a.c.need) || (a.i - b.i))
    .map((x) => x.c);
  const main = showStamps ? ordered[0] : null;
  const otherCards = showStamps ? ordered.slice(1) : [];

  const stampsReady = showStamps ? cards.reduce((n, c) => n + c.ready, 0) : 0;
  const pointsRewardsReady = showPoints && Array.isArray(loyalty?.rewards_available) ? loyalty.rewards_available.length : 0;

  // Visits: loyalty-otp sends `visits` (every visit at the company's sites, the same number as
  // Back Office's Total visits). The old visit_count only counts visits that earned points, so it
  // is shown only when points are on.
  let visits = null;
  if (loyalty && loyalty.visits != null && Number.isFinite(Number(loyalty.visits))) visits = whole(loyalty.visits);
  else if (loyalty && showPoints) visits = whole(loyalty.visit_count);

  const ending = phoneEnding(customer?.phone);
  const memberCode = loyalty?.member_code ? String(loyalty.member_code) : '';

  return {
    mode,
    flagsKnown: flags.known,
    showPoints,
    showStamps,
    collects: { both: 'Points and stamps', points: 'Points', stamps: 'Stamps', none: '' }[mode],
    points: whole(loyalty?.points_balance),
    pointsEarned: whole(loyalty?.points_earned_total),
    cards,
    main,
    otherCards,
    stampsReady,
    pointsRewardsReady,
    rewardsReady: stampsReady + pointsRewardsReady,
    // The free items ready, from the same cards the header counts, so the two always agree.
    stampRewards: showStamps ? ordered.filter((c) => c.ready > 0).map((c) => ({ program_id: c.id, name: c.reward, available: c.ready })) : [],
    visits,
    memberCode,
    phoneEnding: ending,
    identityLine: [memberCode ? `Member ${memberCode}` : '', ending ? `phone ending ${ending}` : ''].filter(Boolean).join(' · '),
    tabs: {
      rewards: showPoints || stampsReady > 0,
      stamps: showStamps,
      history: showPoints,
    },
  };
}
