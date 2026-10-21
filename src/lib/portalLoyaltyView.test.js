// portalLoyaltyView.test.js: the loyalty app's home page shows what the company runs (21 Oct 2026).
//
// Peter, Coffee Boy: "Customers are getting confused as on Coffee Boy they have points off but on
// the main loyalty page it says zero points." And a member's app showed different stamps from
// Back Office. The home page now says "You collect: Stamps" (or Points, or both), shows the stamp
// card big, and counts rewards ready by the same rule as Back Office. Fixtures are made up.
// Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { portalLoyaltyView, loyaltyFlags, stampCardView, phoneEnding } from './portalLoyaltyView.js';
import { stampCardWords } from './stampSummary.js';
import { rewardsAvailable, redeemedByProgram } from './stampAdjust.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// A stamps only company: 4 of 10 stamps, one card finished and its reward already used.
const freeDrink = {
  id: 'prog-drink', name: 'Free Drink', icon: '☕', description: 'Buy 10 drinks, get one free',
  stamps_required: 10, stamps_collected: 4, completed_count: 1, rewards_available: 0,
  reward_description: 'Free Drink',
};
const stampsOnly = {
  enrolled: true, loyalty_enabled: true, points_enabled: false, stamps_enabled: true,
  member_code: 'SRV-TEST01', points_balance: 0, points_earned_total: 0, visit_count: 0, visits: 6,
  rewards_available: [], all_rewards: [], stamp_rewards: [], tier: null,
};
const member = { id: 'cust-1', name: 'Test Member', phone: '+447700900123' };

test('stamps only: the header says Stamps, shows the card big, and never shows points', () => {
  const v = portalLoyaltyView({ loyalty: stampsOnly, stampCards: [freeDrink], customer: member });
  assert.equal(v.mode, 'stamps');
  assert.equal(v.collects, 'Stamps');
  assert.equal(v.showPoints, false);
  assert.equal(v.showStamps, true);
  assert.equal(v.main.countText, '4 of 10 stamps');
  assert.equal(v.main.toGoText, '6 more stamps for your Free Drink');
  assert.deepEqual(v.main.dots, [true, true, true, true, false, false, false, false, false, false]);
  assert.equal(v.main.readyText, 'Free Drink: none ready yet');
  assert.equal(v.main.finishedText, 'Cards finished: 1');
  assert.equal(v.main.usedText, 'Rewards used: 1');
  assert.equal(v.rewardsReady, 0);
  assert.deepEqual(v.tabs, { rewards: false, stamps: true, history: false });
  assert.equal(v.visits, 6, 'every visit at the company sites, as Back Office Total visits');
  assert.equal(v.identityLine, 'Member SRV-TEST01 · phone ending 0123');
});

test('points only: today\'s points header, no stamp card even when one exists', () => {
  const loyalty = { ...stampsOnly, points_enabled: true, stamps_enabled: false, points_balance: 120, points_earned_total: 300, visit_count: 9, visits: undefined, rewards_available: [{ id: 'r1', name: 'Cake', points_cost: 100 }] };
  const v = portalLoyaltyView({ loyalty, stampCards: [freeDrink], customer: member });
  assert.equal(v.mode, 'points');
  assert.equal(v.collects, 'Points');
  assert.equal(v.points, 120);
  assert.equal(v.main, null);
  assert.equal(v.rewardsReady, 1);
  assert.deepEqual(v.tabs, { rewards: true, stamps: false, history: true });
  assert.equal(v.visits, 9, 'an older reply with no visits falls back to the points visit count');
});

test('both: points and the main stamp card', () => {
  const loyalty = { ...stampsOnly, points_enabled: true, points_balance: 40 };
  const v = portalLoyaltyView({ loyalty, stampCards: [freeDrink], customer: member });
  assert.equal(v.mode, 'both');
  assert.equal(v.collects, 'Points and stamps');
  assert.equal(v.main.id, 'prog-drink');
  assert.deepEqual(v.tabs, { rewards: true, stamps: true, history: true });
});

test('none: loyalty off, or both halves off', () => {
  const off = portalLoyaltyView({ loyalty: null, stampCards: [freeDrink] });
  assert.equal(off.mode, 'none');
  assert.equal(off.collects, '');
  assert.deepEqual(off.tabs, { rewards: false, stamps: false, history: false });
  assert.equal(off.visits, null);
  const disabled = portalLoyaltyView({ loyalty: { ...stampsOnly, loyalty_enabled: false }, stampCards: [freeDrink] });
  assert.equal(disabled.mode, 'none');
  const bothOff = portalLoyaltyView({ loyalty: { ...stampsOnly, stamps_enabled: false }, stampCards: [freeDrink] });
  assert.equal(bothOff.mode, 'none');
  // Stamps on but no stamp card running: nothing to show for stamps.
  assert.equal(portalLoyaltyView({ loyalty: stampsOnly, stampCards: [] }).mode, 'none');
});

test('flags missing (a server not yet redeployed): read from the data, never assume points', () => {
  const noFlags = { member_code: 'SRV-TEST01', points_balance: 0, points_earned_total: 0, visit_count: 0, rewards_available: [], all_rewards: [] };
  const stamps = portalLoyaltyView({ loyalty: noFlags, stampCards: [freeDrink] });
  assert.equal(stamps.mode, 'stamps', 'stamp cards and no points activity: stamps');
  assert.equal(stamps.flagsKnown, false);
  assert.equal(stamps.visits, null, 'the points only visit count is not shown as visits');
  assert.equal(portalLoyaltyView({ loyalty: noFlags, stampCards: [] }).mode, 'points', 'no stamp cards: a points company');
  assert.equal(portalLoyaltyView({ loyalty: { ...noFlags, points_balance: 15 }, stampCards: [freeDrink] }).mode, 'both');
  assert.equal(portalLoyaltyView({ loyalty: { ...noFlags, all_rewards: [{ id: 'r' }] }, stampCards: [freeDrink] }).mode, 'both');
  // A flag at the top level of the reply counts too (kiosk and online read it there).
  assert.deepEqual(loyaltyFlags(noFlags, { points_enabled: false, stamps_enabled: true }, [freeDrink]), { known: true, loyaltyOn: true, pointsOn: false, stampsOn: true });
});

test('a card at 0 stamps with a reward ready is shown, and the reward is ready to use with points off', () => {
  const card = { ...freeDrink, stamps_collected: 0, completed_count: 2, rewards_available: 1 };
  const loyalty = { ...stampsOnly, stamp_rewards: [{ program_id: 'prog-drink', name: 'Free Drink', available: 1 }] };
  const v = portalLoyaltyView({ loyalty, stampCards: [card] });
  assert.equal(v.main.countText, '0 of 10 stamps');
  assert.equal(v.main.readyText, 'Free Drink: 1 ready to use');
  assert.equal(v.main.usedText, 'Rewards used: 1');
  assert.equal(v.rewardsReady, 1);
  assert.deepEqual(v.stampRewards, [{ program_id: 'prog-drink', name: 'Free Drink', available: 1 }], 'the ready list comes from the same cards as the header');
  assert.equal(v.tabs.rewards, true, 'a stamp reward opens the Rewards tab even with points off');
});

test('a card with no rewards_available (the old refresh shape) reads ready from stamp_rewards', () => {
  const { rewards_available: _drop, ...bare } = { ...freeDrink, completed_count: 3 };
  const loyalty = { ...stampsOnly, stamp_rewards: [{ program_id: 'prog-drink', available: 2 }] };
  const v = portalLoyaltyView({ loyalty, stampCards: [bare] });
  assert.equal(v.main.ready, 2);
  assert.equal(v.main.used, 1);
  // and with nothing anywhere it is 0, never the completed count
  assert.equal(stampCardView(bare).ready, 0);
});

test('the app and Back Office say the same thing for the same card and ledger', () => {
  // Back Office: the Platform card row plus the Ops redeem rows (Customers.jsx DetailPanel).
  const row = { program_id: 'prog-drink', stamps_collected: 4, completed_count: 1 };
  const redeemRows = [{ program_id: 'prog-drink', type: 'redeem' }];
  const boReady = rewardsAvailable(row, redeemedByProgram(redeemRows)['prog-drink'] || 0);
  const bo = stampCardWords({ finished: row.completed_count, ready: boReady });
  // The app: loyalty-otp works rewards_available out by the same rule (completed minus redeem rows).
  const app = stampCardView({ ...freeDrink, rewards_available: Math.max(0, 1 - redeemRows.length) });
  assert.equal(app.ready, boReady);
  assert.deepEqual([app.finishedText, app.usedText, app.readyNowText], [bo.finished, bo.used, bo.ready]);
  assert.deepEqual([bo.finished, bo.used, bo.ready], ['Cards finished: 1', 'Rewards used: 1', 'Ready now: 0']);
  // The app prints the same line Back Office prints under the card, word for word.
  assert.equal(app.summaryText, `${bo.finished} · ${bo.used} · ${bo.ready}`);
});

test('several cards: the one with a reward ready leads, every other one is listed', () => {
  const cake = { id: 'prog-cake', name: 'Cake card', icon: '🍰', stamps_required: 5, stamps_collected: 0, completed_count: 0, rewards_available: 0, reward_description: 'Free cake' };
  const ready = { ...freeDrink, id: 'prog-ready', name: 'Smoothie card', stamps_collected: 1, completed_count: 1, rewards_available: 1, reward_description: 'Free smoothie' };
  const v = portalLoyaltyView({ loyalty: stampsOnly, stampCards: [cake, freeDrink, ready] });
  assert.equal(v.main.id, 'prog-ready');
  assert.deepEqual(v.otherCards.map((c) => c.id), ['prog-drink', 'prog-cake'], 'closest to its reward next, and a card at 0 stamps is not hidden');
  assert.equal(v.cards.length, 3);
});

test('wording: one stamp, plain words, no dashes', () => {
  const one = stampCardView({ ...freeDrink, stamps_collected: 9 });
  assert.equal(one.toGoText, '1 more stamp for your Free Drink');
  const v = portalLoyaltyView({ loyalty: stampsOnly, stampCards: [freeDrink], customer: member });
  const all = JSON.stringify(v);
  assert.doesNotMatch(all, /[–—]/, 'never an em or en dash');
  assert.doesNotMatch(all, /loyalty points/i);
  assert.equal(phoneEnding('+44 7700 900123'), '0123');
  assert.equal(phoneEnding('12'), '', 'too short to be a phone');
  assert.equal(portalLoyaltyView({ loyalty: { ...stampsOnly, member_code: null }, stampCards: [freeDrink] }).identityLine, '');
});

test('two accounts whose phones differ only in the 4th digit from the end read differently', () => {
  // 21 Oct 2026: the member who saw one stamp was signed in to a second account. Its phone
  // differed from his first account's in the 4th digit from the end, so "phone ending" with 3
  // digits read the same on both. Neutral numbers, not real ones.
  const first = '+440000000123';
  const second = '+440000001123';
  assert.equal(first.slice(-3), second.slice(-3), 'the last 3 digits match, as in the report');
  assert.notEqual(phoneEnding(first), phoneEnding(second));
  const lineFor = (code, phone) => portalLoyaltyView({
    loyalty: { ...stampsOnly, member_code: code }, stampCards: [freeDrink], customer: { ...member, phone },
  }).identityLine;
  assert.equal(lineFor('SRV-TEST01', first), 'Member SRV-TEST01 · phone ending 0123');
  assert.equal(lineFor('SRV-TEST02', second), 'Member SRV-TEST02 · phone ending 1123');
});

// ── the wiring (Deno is not run here, so the edge function is pinned by its source) ──

test('loyalty-otp sends the flags and visits on every reply, and refresh answers like a sign in', () => {
  const src = read('../../supabase/functions/loyalty-otp/index.ts');
  const account = src.slice(src.indexOf('async function memberAccount('), src.indexOf('// ── The venue a portal save is made from'));
  assert.ok(account.includes("flags = { loyalty_enabled: true, points_enabled: pointsOn, stamps_enabled: config.stamps_enabled !== false };"));
  assert.ok(account.includes('const pointsOn = config.points_enabled !== false;'), 'the loyalty-balance rule');
  assert.ok(account.includes('      ...flags,\n      member_code: loyaltyData.member_code,'), 'inside loyalty');
  assert.ok(account.includes('    ...flags,\n    gift_cards: giftCards,'), 'and at the top level');
  assert.ok(account.includes('      visits,\n'));
  assert.ok(account.includes(".from('customer_locations')"));
  assert.ok(account.includes('const bonus = pointsOn ? (config.registration_bonus || 0) : 0;'), 'no welcome points at a stamps only company');
  // Every card carries rewards_available, by one grouped read of the redeem rows.
  assert.ok(account.includes('rewards_available: Math.max(0, (sc.completed_count || 0) - (redeemedByProg[sc.id] || 0)),'));
  assert.ok(!account.includes("{ count: 'exact', head: true }"), 'no count round trip per card');
  // Refresh: memberAccount, no HTTP hop to loyalty-balance, no second copy of the stamp query.
  const refresh = src.slice(src.indexOf("if (action === 'refresh') {"), src.indexOf("if (action === 'update_profile') {"));
  assert.ok(refresh.includes('return json(await memberAccount(cust, session.companyId, provenPhone));'));
  assert.ok(!refresh.includes('loyalty-balance') && !refresh.includes("from('stamp_card_programs')"));
  assert.ok(refresh.includes("if (!cust || cust.deleted_at) return json({ error: JOIN_MESSAGES.signed_out, code: 'sign_in_again' }, 401);"), 'a joined or deleted profile signs in again');
});

test('the portal home page follows the view: no points words when points are off', () => {
  const src = read('../surfaces/customer/CustomerPortal.jsx');
  assert.ok(src.includes("import { portalLoyaltyView } from '../../lib/portalLoyaltyView';"));
  assert.ok(src.includes('const view = useMemo(() => portalLoyaltyView({ loyalty, stampCards, customer }), [loyalty, stampCards, customer]);'));
  // The old rule (a missing flag means points ON) is gone.
  assert.ok(!src.includes("loyalty?.points_enabled !== false;\n  const stampsEnabled"));
  assert.ok(!src.includes('function PointsHero('));
  // "loyalty points" is printed once, inside the hero's points block.
  assert.equal(src.split('loyalty points\n').length - 1, 1);
  const hero = src.slice(src.indexOf('function LoyaltyHero('), src.indexOf('function HeroStampCard('));
  const pointsBlock = hero.slice(hero.indexOf('{view.showPoints && ('), hero.indexOf('{view.showStamps && view.main && ('));
  assert.ok(pointsBlock.includes('loyalty points'));
  assert.ok(hero.includes('You collect: {view.collects}'));
  assert.ok(hero.includes('{view.identityLine}') && hero.includes('Not you? Sign out'));
  // Home lists every card (not only cards with stamps) and tiles follow the flags.
  const home = src.slice(src.indexOf('function HomeTab('), src.indexOf('// ── Rewards Tab'));
  assert.ok(!home.includes('stamps_collected > 0'));
  assert.ok(home.includes("if (view.showPoints) tiles.push({ key: 'earned'"));
  // The lifetime count never reads as a reward on hand.
  assert.ok(!src.includes('}× completed') && !src.includes('completed_count > 0 && ('), 'no bare lifetime pill');
  // Both stamp card views print Back Office's own line (Cards finished · Rewards used · Ready now).
  assert.equal(src.split('{card.summaryText}').length - 1, 2);
  assert.ok(!src.includes('{card.finishedText} · {card.usedText}'));
  // An open tab reads the account again when the member comes back (at most once a minute).
  assert.ok(src.includes("document.addEventListener('visibilitychange', onBack);"));
  assert.ok(src.includes('if (opts.quiet && e?.status !== 401) return;'), 'a failed background read never signs out');
});

test('Back Office shows the same words, and points rows only when points are on', () => {
  const src = read('../backoffice/sections/Customers.jsx');
  assert.ok(src.includes("import { stampCardWords } from '../../lib/stampSummary';"));
  assert.ok(src.includes('const words = stampCardWords({ finished: completed, ready: available });'));
  assert.ok(!src.includes('}× completed'));
  assert.ok(!src.includes('label="Loyalty visits"'), 'the points visit count is named for what it is');
  assert.ok(src.includes('{pointsOn && <Row label="Visits that earned points" value={loyalty.visit_count || 0}/>}'));
  assert.ok(src.includes("platformSupabase.from('loyalty_config').select('enabled, points_enabled, stamps_enabled')"));
  assert.ok(src.includes('pointsOn={loyaltyFlags?.pointsOn !== false}'));
  // The merge says which phone to keep.
  assert.ok(src.includes('Keep the phone the customer signs in to the loyalty app with.'));
});
