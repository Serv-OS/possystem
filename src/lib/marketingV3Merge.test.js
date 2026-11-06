// marketingV3Merge.test.js (6 Nov 2026, 5.12.67): loyalty merge tags, loyalty segment rules and
// tracked links, the pure rules behind marketing-send, the batch sender and marketing-webhook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loyaltyMergeValues, stampCardsFor, mentionsLoyalty, loyaltyRuleMatches, collectLoyaltyRules, expandLoyaltyRules, LOYALTY_TAGS } from '../../supabase/functions/_shared/loyaltyMerge.js';
import { collectHrefs, wrapTrackedLinks, trackedUrl, campaignDestination, clickParamsOk, clickSignText, isTrackable } from '../../supabase/functions/_shared/marketingLinks.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const programs = [
  { id: 'p-coffee', name: 'Coffee card', stamps_required: 10, reward_description: 'free coffee' },
  { id: 'p-lunch', name: 'Lunch card', stamps_required: 5, reward_description: 'free lunch' },
];

test('points: balance, next reward and tier come from the same rows the portal reads', () => {
  const v = loyaltyMergeValues({
    loyalty: { points_balance: 120, tier_id: 't-gold' },
    rewards: [{ name: 'Free cake', points_cost: 200, active: true }, { name: 'Free coffee', points_cost: 100, active: true }, { name: 'Off', points_cost: 50, active: false }],
    tiers: [{ id: 't-gold', name: 'Gold' }],
  });
  assert.equal(v.points_balance, 120);
  assert.equal(v.points_to_next_reward, 80);
  assert.equal(v.next_reward, 'Free cake');
  assert.equal(v.tier, 'Gold');
  // a balance above every reward: nothing to go
  assert.equal(loyaltyMergeValues({ loyalty: { points_balance: 999 }, rewards: [{ points_cost: 100 }] }).points_to_next_reward, 0);
  // not a member: zeros and blanks, never an error
  const none = loyaltyMergeValues({ loyalty: null, rewards: [{ points_cost: 100 }] });
  assert.equal(none.points_balance, 0); assert.equal(none.points_to_next_reward, 100); assert.equal(none.tier, '');
  assert.deepEqual(Object.keys(none).sort(), [...LOYALTY_TAGS].sort());
});

test('stamps: the main card is the one nearest its reward, rewards ready = completed minus redeemed', () => {
  const cards = [
    { program_id: 'p-coffee', stamps_collected: 9, completed_count: 2 },
    { program_id: 'p-lunch', stamps_collected: 1, completed_count: 1 },
  ];
  const v = loyaltyMergeValues({ loyalty: { points_balance: 0 }, programs, cards, redeemedByProgram: { 'p-coffee': 2, 'p-lunch': 1 } });
  assert.equal(v.stamps_earned, 9); assert.equal(v.stamps_target, 10); assert.equal(v.stamps_to_go, 1);
  assert.equal(v.stamp_reward, 'free coffee'); assert.equal(v.stamp_card, 'Coffee card');
  assert.equal(v.rewards_ready, 0);     // every completed card has been redeemed
  // the lunch card with one free lunch waiting becomes the main card, as in the portal
  const w = loyaltyMergeValues({ loyalty: { points_balance: 0 }, programs, cards, redeemedByProgram: { 'p-coffee': 2, 'p-lunch': 0 } });
  assert.equal(w.stamp_card, 'Lunch card'); assert.equal(w.rewards_ready, 1); assert.equal(w.stamps_to_go, 4);
  // a card with a reward ready comes first even when another is nearer
  const first = stampCardsFor(programs, cards, { 'p-coffee': 1 })[0];
  assert.equal(first.id, 'p-coffee'); assert.equal(first.ready, 1);
  // stamps_collected never shows above the target, a never started card is left out
  assert.equal(stampCardsFor(programs, [{ program_id: 'p-lunch', stamps_collected: 7, completed_count: 0 }]).length, 1);
  assert.equal(stampCardsFor(programs, [{ program_id: 'p-lunch', stamps_collected: 7, completed_count: 0 }])[0].have, 5);
  assert.equal(loyaltyMergeValues({ programs, cards: [] }).stamps_target, 0);
});

test('a send reads loyalty only when a tag asks for it', () => {
  assert.equal(mentionsLoyalty('Hi {{first_name}}', '<p>{{promo_code}}</p>'), false);
  assert.equal(mentionsLoyalty('', 'You have {{ points_balance }} points'), true);
  assert.equal(mentionsLoyalty('{{stamps_to_go|a few}} more stamps'), true);
  assert.equal(mentionsLoyalty(null, undefined), false);
});

test('loyalty segment rules decide per member and expand to customer id lists inside groups', () => {
  const v = loyaltyMergeValues({ loyalty: { points_balance: 120, tier_id: 't' }, rewards: [{ points_cost: 200 }], tiers: [{ id: 't', name: 'Gold' }], programs, cards: [{ program_id: 'p-coffee', stamps_collected: 9, completed_count: 0 }] });
  assert.equal(loyaltyRuleMatches({ field: 'stamps_to_go', op: 'eq', value: 1 }, v, true), true);
  assert.equal(loyaltyRuleMatches({ field: 'points_balance', op: 'gte', value: 100 }, v, true), true);
  assert.equal(loyaltyRuleMatches({ field: 'points_balance', op: 'lt', value: 100 }, v, true), false);
  assert.equal(loyaltyRuleMatches({ field: 'tier', op: 'eq', value: 'gold' }, v, true), true);
  assert.equal(loyaltyRuleMatches({ field: 'tier', op: 'in', value: ['Silver', 'Gold'] }, v, true), true);
  assert.equal(loyaltyRuleMatches({ field: 'tier', op: 'neq', value: 'Gold' }, v, true), false);
  assert.equal(loyaltyRuleMatches({ field: 'loyalty_member', op: 'is_true' }, v, false), false);
  assert.equal(loyaltyRuleMatches({ field: 'loyalty_member', op: 'is_false' }, v, false), true);
  assert.equal(loyaltyRuleMatches({ field: 'points_balance', op: 'gte', value: 'abc' }, v, true), false);

  const def = { match: 'any', rules: [
    { match: 'all', rules: [{ field: 'lifetime_revenue', op: 'gte', value: 250 }, { field: 'stamps_to_go', op: 'eq', value: 1 }] },
    { field: 'loyalty_member', op: 'is_false' },
    { field: 'has_email', op: 'is_true' },
  ] };
  assert.equal(collectLoyaltyRules(def).length, 2);
  const out = expandLoyaltyRules(def, (r) => (r.field === 'loyalty_member' ? { ids: ['m1', 'm2'], negate: true } : { ids: ['m1'] }));
  assert.deepEqual(out.rules[0].rules[1], { field: 'customer_id', op: 'in', value: ['m1'] });
  assert.deepEqual(out.rules[1], { field: 'customer_id', op: 'not_in', value: ['m1', 'm2'] });
  assert.deepEqual(out.rules[2], { field: 'has_email', op: 'is_true' });
  assert.deepEqual(def.rules[1], { field: 'loyalty_member', op: 'is_false' }, 'the saved definition is not changed');
});

test('tracked links: every http link is wrapped once, compliance and mailto links are left alone', () => {
  const html = `<p><a href="https://venue.test/menu?x=1&amp;y=2">Menu</a> <a href='https://venue.test/book'>Book</a>
  <a href="https://venue.test/menu?x=1&amp;y=2">Menu again</a> <a href="mailto:hi@venue.test">mail</a> <a href="#top">top</a>
  <a href="{{preferences_url}}">prefs</a> <a href="https://x.supabase.co/functions/v1/marketing-webhook?action=unsubscribe&amp;c=1">Unsubscribe</a></p>`;
  const hrefs = collectHrefs(html);
  assert.deepEqual(hrefs, ['https://venue.test/menu?x=1&y=2', 'https://venue.test/book', 'https://x.supabase.co/functions/v1/marketing-webhook?action=unsubscribe&c=1']);
  assert.equal(isTrackable(hrefs[2], ['https://x.supabase.co/functions/v1/marketing-webhook']), false);
  const base = 'https://x.supabase.co/functions/v1/marketing-webhook';
  const map = new Map(hrefs.slice(0, 2).map((h) => [h, trackedUrl(base, 'm-1', h, 'ab'.repeat(16))]));
  const out = wrapTrackedLinks(html, map);
  assert.match(out, /href="https:\/\/x\.supabase\.co\/functions\/v1\/marketing-webhook\?action=click&amp;m=m-1&amp;u=https%3A%2F%2Fvenue\.test%2Fmenu%3Fx%3D1%26y%3D2&amp;t=abab/);
  assert.match(out, /href='https:\/\/x\.supabase\.co[^']*u=https%3A%2F%2Fvenue\.test%2Fbook/);
  assert.equal((out.match(/action=click/g) || []).length, 3, 'the repeated menu link is wrapped both times');
  assert.match(out, /href="mailto:hi@venue\.test"/);
  assert.match(out, /href="#top"/);
  assert.match(out, /href="\{\{preferences_url\}\}"/);
  assert.match(out, /action=unsubscribe&amp;c=1"/, 'the unsubscribe link is untouched');
  assert.equal(wrapTrackedLinks('', map), '');
  assert.equal(wrapTrackedLinks('<p>no links</p>', new Map()), '<p>no links</p>');
});

test('the click redirect: signed params only, destination carries utm and the message token', () => {
  const m = '7b1f2d64-9c0e-4a41-8bb6-2a6d5c3f1e90';
  assert.equal(clickSignText(m, 'https://a.test/'), `click:${m}:https://a.test/`);
  assert.deepEqual(clickParamsOk({ m, u: 'https://a.test/menu', t: 'A'.repeat(32) }), { ok: true, messageId: m, url: 'https://a.test/menu', token: 'a'.repeat(32) });
  assert.equal(clickParamsOk({ m: 'nope', u: 'https://a.test/', t: 'a'.repeat(32) }).ok, false);
  assert.equal(clickParamsOk({ m, u: 'javascript:alert(1)', t: 'a'.repeat(32) }).ok, false);
  assert.equal(clickParamsOk({ m, u: 'https://a.test/', t: 'short' }).ok, false);
  assert.equal(clickParamsOk({ m, u: 'https://a.test/' + 'x'.repeat(2100), t: 'a'.repeat(32) }).ok, false);
  const dest = campaignDestination('https://venue.test/menu?x=1', { campaignId: 'c-9', messageId: m });
  const u = new URL(dest);
  assert.equal(u.searchParams.get('x'), '1');
  assert.equal(u.searchParams.get('utm_source'), 'servos');
  assert.equal(u.searchParams.get('utm_medium'), 'email');
  assert.equal(u.searchParams.get('utm_campaign'), 'c-9');
  assert.equal(u.searchParams.get('sv_m'), m);
  // a link that already carries its own utm keeps it
  assert.equal(new URL(campaignDestination('https://venue.test/?utm_source=mine', { campaignId: 'c' })).searchParams.get('utm_source'), 'mine');
  assert.equal(campaignDestination('not a url', {}), 'not a url');
});

test('the email builder lists the loyalty tags with sample values', () => {
  // emailCompiler.js imports the app's currency helper without an extension, so it is read as text here.
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'emailCompiler.js'), 'utf8');
  for (const k of ['points_balance', 'points_to_next_reward', 'stamps_earned', 'stamps_target', 'stamps_to_go', 'tier', 'rewards_ready']) {
    assert.ok(src.includes(`['{{${k}}}'`), `builder lists {{${k}}}`);
    assert.match(src, new RegExp(`\\b${k}: `), `sample has ${k}`);
  }
});

test('the click table stores the link as written, not the tracking tags', async () => {
  const { plainUrl } = await import('../../supabase/functions/_shared/marketingLinks.js');
  assert.equal(plainUrl('https://venue.test/menu?x=1&utm_source=servos&utm_medium=email&utm_campaign=c-9&sv_m=abc'), 'https://venue.test/menu?x=1');
  assert.equal(plainUrl('https://venue.test/?utm_source=mine&sv_m=abc'), 'https://venue.test/?utm_source=mine');
  assert.equal(plainUrl('https://venue.test/'), 'https://venue.test/');
});
