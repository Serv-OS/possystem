// Adjusting a customer's stamps by hand in Back Office (Peter, Coffee Boy, 30 Sep 2026): what
// the request must carry, what a change does to the card, who may ask, and the note the ledger
// keeps. The rules are supabase/functions/_shared/stampAdjust.js, shared with loyalty-earn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STAMP_ADJUST_ACTION, STAMP_ADJUST_TYPE, validateStampAdjust, applyStampAdjust, stampAdjustNote, stampAdjustKey,
  rewardsAvailable, redeemedByProgram, canAdjustStamps, stampAdjustBody, mergeAdjustedCard, rewardsAvailableText,
  newAdjustRequestId, STAMP_ADJUST_FN, adjustErrorText, STAMP_ADJUST_NEEDS_DEPLOY,
} from './stampAdjust.js';
import { stampAdjustRole } from '../../supabase/functions/_shared/stampAdjust.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');

const CUST = '11111111-1111-4111-8111-111111111111';
const LOC = '22222222-2222-4222-8222-222222222222';
const PROG = '33333333-3333-4333-8333-333333333333';
const good = () => stampAdjustBody({ customerId: CUST, locationId: LOC, programId: PROG, stampsDelta: 2, rewardsDelta: 0, reason: 'Lost paper card', requestId: 'req-0001-abcd' });

test('the body the screen builds is the body the function accepts', () => {
  const v = validateStampAdjust(good());
  assert.equal(v.ok, true);
  assert.deepEqual([v.customerId, v.locationId, v.programId, v.stampsDelta, v.rewardsDelta, v.reason, v.requestId], [CUST, LOC, PROG, 2, 0, 'Lost paper card', 'req-0001-abcd']);
  assert.equal(good().action, STAMP_ADJUST_ACTION);
  assert.equal(STAMP_ADJUST_FN, 'loyalty-earn');
});

test('refusals read plainly: no reason, nothing to change, silly numbers, bad ids', () => {
  assert.equal(validateStampAdjust({ ...good(), reason: '  ' }).error, 'Give a reason (at least 3 characters).');
  assert.equal(validateStampAdjust({ ...good(), stamps_delta: 0 }).error, 'Nothing to change: add or remove at least one stamp or reward.');
  assert.equal(validateStampAdjust({ ...good(), stamps_delta: 1.5 }).error, 'Stamps and rewards must be whole numbers.');
  assert.equal(validateStampAdjust({ ...good(), stamps_delta: 501 }).error, 'No more than 500 at a time.');
  assert.equal(validateStampAdjust({ ...good(), customer_id: 'nope' }).error, 'customer_id required');
  assert.equal(validateStampAdjust({ ...good(), stamp_program_id: null }).error, 'stamp_program_id required');
  assert.match(validateStampAdjust({ ...good(), request_id: 'short' }).error, /request_id required/);
  assert.equal(validateStampAdjust({ ...good(), action: 'earn' }).error, 'Not a stamp adjustment.');
  assert.equal(validateStampAdjust(null).error, 'Not a stamp adjustment.');
  // A rewards only change is fine; a string number is fine.
  assert.equal(validateStampAdjust({ ...good(), stamps_delta: '0', rewards_delta: '-1' }).ok, true);
});

test('adding stamps rolls over into completed cards exactly as an order would', () => {
  const r = applyStampAdjust({ stamps_collected: 8, completed_count: 1 }, 1, { stampsDelta: 13, stampsRequired: 10 });
  assert.deepEqual(r, { ok: true, stamps_collected: 1, completed_count: 3, rolled: 2, rewards_available: 2 });
});

test('removing stamps never goes below zero; a completed card comes off through rewards', () => {
  assert.equal(applyStampAdjust({ stamps_collected: 2, completed_count: 1 }, 0, { stampsDelta: -3, stampsRequired: 10 }).error,
    'Only 2 stamps on this card to remove. Take a completed card off with the rewards control instead.');
  assert.equal(applyStampAdjust({ stamps_collected: 0, completed_count: 0 }, 0, { stampsDelta: -1, stampsRequired: 10 }).error, 'No stamps on this card to remove.');
  const ok = applyStampAdjust({ stamps_collected: 2, completed_count: 1 }, 0, { stampsDelta: -2, stampsRequired: 10 });
  assert.deepEqual(ok, { ok: true, stamps_collected: 0, completed_count: 1, rolled: 0, rewards_available: 1 });
});

test('rewards: add a whole card, or take one off only while one is still available', () => {
  assert.deepEqual(applyStampAdjust({ stamps_collected: 4, completed_count: 0 }, 0, { rewardsDelta: 1, stampsRequired: 10 }),
    { ok: true, stamps_collected: 4, completed_count: 1, rolled: 0, rewards_available: 1 });
  // Two completed, one already redeemed: one available, so removing two is refused.
  assert.equal(applyStampAdjust({ stamps_collected: 0, completed_count: 2 }, 1, { rewardsDelta: -2, stampsRequired: 10 }).error, 'Only 1 reward available to remove.');
  assert.equal(applyStampAdjust({ stamps_collected: 0, completed_count: 1 }, 1, { rewardsDelta: -1, stampsRequired: 10 }).error, 'No rewards available to remove.');
  assert.deepEqual(applyStampAdjust({ stamps_collected: 0, completed_count: 2 }, 1, { rewardsDelta: -1, stampsRequired: 10 }),
    { ok: true, stamps_collected: 0, completed_count: 1, rolled: 0, rewards_available: 0 });
  // A missing card behaves as an empty one; a programme with no length is refused.
  assert.equal(applyStampAdjust(null, 0, { stampsDelta: 1, stampsRequired: 10 }).stamps_collected, 1);
  assert.equal(applyStampAdjust(null, 0, { stampsDelta: 1, stampsRequired: 0 }).error, 'This stamp card has no length set.');
});

test('rewards available and the redeem count per programme', () => {
  assert.equal(rewardsAvailable({ completed_count: 3 }, 1), 2);
  assert.equal(rewardsAvailable({ completed_count: 1 }, 4), 0, 'never negative');
  assert.equal(rewardsAvailable(null, 0), 0);
  assert.deepEqual(redeemedByProgram([{ type: 'redeem', program_id: 'a' }, { type: 'redeem', program_id: 'a' }, { type: 'earn', program_id: 'a' }, { type: 'redeem', program_id: 'b' }, null]), { a: 2, b: 1 });
  assert.equal(rewardsAvailableText(0), 'No reward yet');
  assert.equal(rewardsAvailableText(1), '1 reward available');
  assert.equal(rewardsAvailableText(3), '3 rewards available');
});

test('the ledger note says what changed, why and who', () => {
  assert.equal(stampAdjustNote({ stampsDelta: 13, rolled: 1, reason: 'Lost paper card', actor: 'peter@posup.co.uk' }),
    'Adjusted by staff: +13 stamps (card completed). Reason: Lost paper card. By peter@posup.co.uk');
  assert.equal(stampAdjustNote({ stampsDelta: -1, rewardsDelta: 2, reason: 'Goodwill' }), 'Adjusted by staff: -1 stamp, +2 rewards. Reason: Goodwill');
  assert.equal(stampAdjustKey('req-1234-abcd'), 'stampadjust:req-1234-abcd');
  assert.equal(STAMP_ADJUST_TYPE, 'adjust');
});

test('who may adjust: owner or manager of the venue, org owner, company role, super admin; never a till', () => {
  const venueOrgId = 'org-1';
  assert.equal(stampAdjustRole({ user: { id: 'u' }, linkRole: 'manager', venueOrgId }), 'venue_role');
  assert.equal(stampAdjustRole({ user: { id: 'u' }, linkRole: 'owner', venueOrgId }), 'venue_role');
  assert.equal(stampAdjustRole({ user: { id: 'u' }, linkRole: 'staff', venueOrgId }), null);
  assert.equal(stampAdjustRole({ user: { id: 'u' }, profileRole: 'owner', profileOrgId: 'org-1', venueOrgId }), 'owner_org');
  assert.equal(stampAdjustRole({ user: { id: 'u' }, profileRole: 'owner', profileOrgId: 'org-2', venueOrgId }), null, 'another organisation');
  assert.equal(stampAdjustRole({ user: { id: 'u' }, companyRole: 'admin', venueOrgId }), 'company_role');
  assert.equal(stampAdjustRole({ user: { id: 'u' }, profileRole: 'super_admin' }), 'super_admin');
  assert.equal(stampAdjustRole({ user: { id: 'u', is_anonymous: true }, linkRole: 'owner', venueOrgId }), null, 'a till session');
  assert.equal(stampAdjustRole({ user: null, linkRole: 'owner' }), null);
  assert.equal(canAdjustStamps({ linkRole: 'manager', venueOrgId }), true);
  assert.equal(canAdjustStamps({ linkRole: 'staff', venueOrgId }), false);
});

test('Back Office merges the answered card into the customer\'s list', () => {
  const cards = [{ id: 'c1', customer_id: 'x', program_id: 'p1', stamps_collected: 2, completed_count: 0, last_stamp_at: '2026-09-01' }];
  const merged = mergeAdjustedCard(cards, 'x', 'co', { id: 'c1', program_id: 'p1', stamps_collected: 4, completed_count: 1 });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].stamps_collected, 4);
  assert.equal(merged[0].completed_count, 1);
  assert.equal(merged[0].last_stamp_at, '2026-09-01', 'a hand adjustment is not a stamp');
  const added = mergeAdjustedCard(cards, 'x', 'co', { id: 'c2', program_id: 'p2', stamps_collected: 1, completed_count: 0 });
  assert.equal(added.length, 2);
  assert.equal(added[1].company_id, 'co');
  assert.deepEqual(mergeAdjustedCard(cards, 'x', 'co', null), cards);
  const id = newAdjustRequestId();
  assert.ok(id.length >= 8 && /^[A-Za-z0-9._:-]+$/.test(id), 'usable as request_id');
});

test('loyalty-earn takes the action before it insists on a check, writes the ledger row first, and only owners or managers pass', () => {
  const fn = read('../../supabase/functions/loyalty-earn/index.ts');
  assert.ok(fn.includes("import { STAMP_ADJUST_ACTION, STAMP_ADJUST_TYPE, validateStampAdjust, applyStampAdjust, stampAdjustNote, stampAdjustKey, stampAdjustRole, rewardsAvailable } from '../_shared/stampAdjust.js';"));
  const branch = fn.indexOf('if ((body as any).action === STAMP_ADJUST_ACTION)');
  assert.ok(branch > 0 && branch < fn.indexOf("if (!closed_check_id) return json({ error: 'closed_check_id required' }, 400);"), 'an adjustment has no check');
  const adj = fn.slice(fn.indexOf('async function adjustStamps('));
  assert.ok(adj.includes('await secondStepRefusal(req)'), 'Back Office second step applies');
  assert.ok(adj.includes('stampAdjustRole({ user: caller, ...roles, venueOrgId })'), 'the merge role rule');
  assert.ok(adj.indexOf(".from('stamp_transactions')\n    .insert({") < adj.indexOf(".from('customer_stamp_cards')\n    .update({"), 'ledger row first, card second');
  assert.ok(adj.includes("if (insErr?.code === '23505')"), 'a retry is a no-op');
  assert.ok(adj.includes("type: STAMP_ADJUST_TYPE,"));
  assert.ok(adj.includes(".eq('stamps_collected', card.stamps_collected)\n    .eq('completed_count', card.completed_count)"), 'a card that moved meanwhile is not overwritten');
  assert.ok(adj.includes("await opsAdmin.from('stamp_transactions').delete().eq('id', ins.id);"), 'and the claim is taken back');
  // Review 30 Sep: the card guard cannot see a redeem (loyalty-redeem only inserts a ledger row),
  // so taking a reward off recounts AFTER the move and reverts when the ledger would be in debt.
  const recount = adj.indexOf('if (v.rewardsDelta < 0 && plan.completed_count - (await countRedeemed()) < 0)');
  assert.ok(recount > adj.indexOf(".from('customer_stamp_cards')\n    .update({"), 'the recount comes after the move');
  const revert = adj.slice(recount);
  assert.ok(revert.includes(".update({ stamps_collected: card.stamps_collected, completed_count: card.completed_count })\n      .eq('id', card.id)\n      .eq('stamps_collected', plan.stamps_collected)\n      .eq('completed_count', plan.completed_count)"), 'put back only from the state we set');
  assert.ok(revert.includes("await opsAdmin.from('stamp_transactions').delete().eq('id', ins.id);"), 'the claim goes too');
  assert.ok(revert.includes('return await changedReply();'), 'and the screen is told it changed (409)');
  // Back Office sends exactly this body, to this function, and gates the button on the same rule.
  const bo = read('../backoffice/sections/Customers.jsx');
  assert.ok(bo.includes("stampAdjustBody({"), 'the shared body builder');
  assert.ok(bo.includes('${FUNCTIONS_URL}/${STAMP_ADJUST_FN}'));
  assert.ok(bo.includes('setCanAdjust(canAdjustStamps({'), 'the button and the function share one rule');
  assert.ok(bo.includes("canAdjust={canMerge}") || bo.includes('canAdjust={canAdjust}'));
  assert.ok(bo.includes('new Error(adjustErrorText(res.status, j))'), 'refusals go through adjustErrorText');
});

test('a 400 with no code is the old loyalty-earn (not yet redeployed): plain English, nothing written', () => {
  // The old function never heard of the action and insists on a check.
  assert.equal(adjustErrorText(400, { error: 'closed_check_id required' }), STAMP_ADJUST_NEEDS_DEPLOY);
  assert.equal(adjustErrorText(400, {}), STAMP_ADJUST_NEEDS_DEPLOY);
  // Every refusal the new function writes carries a code and its own words.
  assert.equal(adjustErrorText(400, { error: 'No rewards available to remove.', code: 'refused' }), 'No rewards available to remove.');
  assert.equal(adjustErrorText(400, { error: 'Give a reason (at least 3 characters).', code: 'bad_request' }), 'Give a reason (at least 3 characters).');
  assert.equal(adjustErrorText(409, { error: 'This card changed a moment ago (a stamp or a reward). Check the new figures and try again.', code: 'changed' }).startsWith('This card changed'), true);
  assert.equal(adjustErrorText(403, { error: 'Only an owner or a manager can adjust stamps.', code: 'not_allowed' }), 'Only an owner or a manager can adjust stamps.');
  assert.equal(adjustErrorText(502, {}), 'The loyalty service answered 502.');
  assert.ok(!/[\u2013\u2014]/.test(STAMP_ADJUST_NEEDS_DEPLOY), 'no dashes in staff copy');
});
