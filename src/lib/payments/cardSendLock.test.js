// src/lib/payments/cardSendLock.test.js
//
// THE BILL DOES NOT CHANGE ONCE THE CARD MACHINE HAS BEEN ASKED FOR IT (25 Nov 2026).
// Six loyalty orders at four Coffee Boy sites: the reader took the full bill, the till booked a
// Free Drink reward on top and used the stamp card (Huddersfield R6900, Castleford R3997, R4598
// and R8595, Barnsley R22418, Headingley R30054; 23.55 in all). Three parts:
//   1. the rules themselves (pure);
//   2. the six orders replayed against the rules, and against the old behaviour to prove the
//      replay really shows the fault;
//   3. source pins: CheckoutModal reads the rules where it matters, and they fail if it drifts.
// Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CARD_SCREENS, REWARD_WAIT_MS, cardSendLocked, pendingRewardAction, holdCardForReward,
  cardLegDiffersFromSend, lateRewardMessage,
} from './cardSendLock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..', '..');
const read = (rel) => fs.readFileSync(path.resolve(SRC, rel), 'utf8');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// An en dash or an em dash, built from code points so this file holds neither.
const DASH = new RegExp(`[${String.fromCodePoint(0x2013, 0x2014)}]`);

const FREE_DRINK = { id: 'stamp:0afb5e8b', label: 'Free Drink', type: 'free_item', stamp: true };

// ── 1. The rules ────────────────────────────────────────────────────────────

test('the bill is locked while the send is out and on both card screens, and nowhere else', () => {
  assert.equal(cardSendLocked({ sending: true, screen: 'review' }), true, 'pressed, not yet answered');
  assert.equal(cardSendLocked({ sending: false, screen: 'pax_terminal' }), true, 'the reader has it');
  assert.equal(cardSendLocked({ sending: false, screen: 'card_terminal' }), true, 'the simulated card screen');
  for (const screen of ['review', 'cash', 'gift_card', 'loyalty_rewards']) {
    assert.equal(cardSendLocked({ sending: false, screen }), false, screen);
  }
  assert.equal(cardSendLocked(), false);
  assert.deepEqual([...CARD_SCREENS], ['pax_terminal', 'card_terminal']);
});

test('a chosen reward: wait for the lookup, apply on the bill, refuse once the card is out', () => {
  const base = { pending: FREE_DRINK, applied: null, haveLoyalty: true, locked: false };
  assert.equal(pendingRewardAction(base), 'apply');
  assert.equal(pendingRewardAction({ ...base, haveLoyalty: false }), 'wait');
  assert.equal(pendingRewardAction({ ...base, locked: true }), 'refuse');
  // nothing to do: none chosen, or one is already on the bill (locked or not)
  assert.equal(pendingRewardAction({ ...base, pending: null }), 'none');
  assert.equal(pendingRewardAction({ ...base, applied: { discount_value: 400 } }), 'none');
  assert.equal(pendingRewardAction({ ...base, applied: { discount_value: 400 }, locked: true }), 'none');
  // a reward that could not be applied (no eligible item) is left for staff: not tried again,
  // and no "arrived too late" message when Card is pressed
  assert.equal(pendingRewardAction({ ...base, applyFailed: true }), 'none');
  assert.equal(pendingRewardAction({ ...base, applyFailed: true, locked: true }), 'none');
  // the lookup has not answered and the card is out: still waiting, never applied
  assert.equal(pendingRewardAction({ ...base, haveLoyalty: false, locked: true }), 'wait');
  assert.equal(pendingRewardAction(), 'none');
});

test('Card waits for a chosen reward, and only for that', () => {
  const waiting = { pending: FREE_DRINK, applied: null, lookupDone: false, haveLoyalty: false, applyFailed: false, waitedOut: false };
  assert.equal(holdCardForReward(waiting), true, 'the lookup is still out');
  assert.equal(holdCardForReward({ ...waiting, lookupDone: true, haveLoyalty: true }), true, 'loaded, the reward lands in this tick');
  // never held when there is nothing to wait for
  assert.equal(holdCardForReward({ ...waiting, pending: null }), false, 'no reward chosen: every other sale');
  assert.equal(holdCardForReward({ ...waiting, applied: { discount_value: 400 } }), false, 'already on the bill');
  assert.equal(holdCardForReward({ ...waiting, lookupDone: true, haveLoyalty: false }), false, 'the lookup found no member, or failed');
  assert.equal(holdCardForReward({ ...waiting, lookupDone: true, haveLoyalty: true, applyFailed: true }), false, 'no eligible item: staff apply by hand');
  assert.equal(holdCardForReward({ ...waiting, waitedOut: true }), false, 'never longer than the wait');
  assert.equal(holdCardForReward(), false);
  assert.ok(REWARD_WAIT_MS > 0 && REWARD_WAIT_MS <= 5000, 'a card sale is never held more than five seconds');
});

test('the close check: differs only when both figures are known and not the same', () => {
  assert.equal(cardLegDiffersFromSend({ sentDueMinor: 885, bookedCardMinor: 485 }), true, 'R6900');
  assert.equal(cardLegDiffersFromSend({ sentDueMinor: 885, bookedCardMinor: 885 }), false);
  assert.equal(cardLegDiffersFromSend({ sentDueMinor: '885', bookedCardMinor: 885 }), false, 'a bigint column read as text');
  // a missing figure is not proof of anything: no alarm
  assert.equal(cardLegDiffersFromSend({ sentDueMinor: undefined, bookedCardMinor: 885 }), false);
  assert.equal(cardLegDiffersFromSend({ sentDueMinor: null, bookedCardMinor: 885 }), false);
  assert.equal(cardLegDiffersFromSend({ sentDueMinor: 885, bookedCardMinor: NaN }), false);
  assert.equal(cardLegDiffersFromSend(), false);
});

test('the words staff see name the reward and say the customer keeps it', () => {
  const msg = lateRewardMessage(FREE_DRINK);
  assert.match(msg, /^Free Drink is not on this bill: the card payment was already sent\./);
  assert.match(msg, /Cancel the card payment to use it now, or the customer keeps it for next time\.$/);
  assert.match(lateRewardMessage(null), /^The reward is not on this bill/);
  assert.doesNotMatch(msg, DASH, 'no dashes in words staff read');
});

// ── 2. The six orders, replayed ─────────────────────────────────────────────
//
// A model of the checkout's money, small enough to read in one go. The only rule it does not
// own is the one under test: `rules` decides what happens to the chosen reward and whether a
// Card press goes out. Events, in the order they happened on the day:
//   'card'     staff press Card (the amount goes to the reader, frozen)
//   'lookup'   the member's loyalty lookup answers
//   'approve'  the reader approves what it was sent; the till books the bill as it stands
//   'decline'  the reader declines; staff are back on the bill
function replay({ totalMinor, rewardMinor, events }, rules) {
  const s = {
    pending: FREE_DRINK, applied: null, haveLoyalty: false, lookupDone: false,
    sending: false, screen: 'review', sentDueMinor: null, booked: null, heldPresses: 0, refused: 0,
  };
  const due = () => totalMinor - (s.applied ? rewardMinor : 0);
  const settleReward = () => {
    const locked = rules.locked(s);
    const action = pendingRewardAction({ pending: s.pending, applied: s.applied, haveLoyalty: s.haveLoyalty, locked });
    if (action === 'apply') { s.applied = { discount_value: rewardMinor }; s.pending = null; }
    if (action === 'refuse') s.refused += 1;
  };
  for (const ev of events) {
    if (ev === 'lookup') { s.haveLoyalty = true; s.lookupDone = true; }
    if (ev === 'card') {
      if (rules.hold(s)) { s.heldPresses += 1; continue; }   // the button is disabled: nothing is sent
      s.sentDueMinor = due(); s.screen = 'pax_terminal';
    }
    if (ev === 'decline') { s.screen = 'review'; s.sentDueMinor = null; }
    settleReward();
    if (ev === 'approve' && s.sentDueMinor != null) {   // the reader can only approve what it was sent
      s.booked = {
        cardMinor: due(),
        loyaltyMinor: s.applied ? rewardMinor : 0,
        stampsUsed: !!s.applied,
      };
    }
  }
  return s;
}

const NOW = {
  locked: (s) => cardSendLocked({ sending: s.sending, screen: s.screen }),
  hold: (s) => holdCardForReward({ pending: s.pending, applied: s.applied, lookupDone: s.lookupDone, haveLoyalty: s.haveLoyalty }),
};
// Before 25 Nov 2026: the reward applied whenever the lookup answered, and Card never waited.
const BEFORE = { locked: () => false, hold: () => false };
// The lock on its own (the wait ran out, or the press got through): the belt.
const LOCK_ONLY = { locked: NOW.locked, hold: () => false };

const SIX = [
  { ref: 'Huddersfield R6900', totalMinor: 885, rewardMinor: 400 },
  { ref: 'Castleford R3997', totalMinor: 1772, rewardMinor: 470 },
  { ref: 'Castleford R4598', totalMinor: 1754, rewardMinor: 405 },
  { ref: 'Barnsley R22418', totalMinor: 1700, rewardMinor: 370 },
  { ref: 'Castleford R8595', totalMinor: 1607, rewardMinor: 150 },
  { ref: 'Headingley R30054', totalMinor: 1770, rewardMinor: 560 },
];
const LATE = ['card', 'lookup', 'approve'];   // Card pressed before the lookup answered

test('the replay shows the fault: before the fix all six book less on the card than the reader took', () => {
  let overcharged = 0;
  for (const o of SIX) {
    const s = replay({ ...o, events: LATE }, BEFORE);
    assert.equal(s.sentDueMinor, o.totalMinor, `${o.ref}: the reader was asked for the full bill`);
    assert.equal(s.booked.cardMinor, o.totalMinor - o.rewardMinor, `${o.ref}: the till booked the card net of the reward`);
    assert.equal(s.booked.stampsUsed, true, `${o.ref}: and used the stamp card`);
    assert.equal(cardLegDiffersFromSend({ sentDueMinor: s.sentDueMinor, bookedCardMinor: s.booked.cardMinor }), true);
    overcharged += s.sentDueMinor - s.booked.cardMinor;
  }
  assert.equal(overcharged, 2355, 'the 23.55 found across the four sites');
});

test('the lock: a reward that arrives after the send is refused, the sale is booked as charged', () => {
  for (const o of SIX) {
    const s = replay({ ...o, events: LATE }, LOCK_ONLY);
    assert.equal(s.sentDueMinor, o.totalMinor, o.ref);
    assert.equal(s.booked.cardMinor, s.sentDueMinor, `${o.ref}: the card leg is what the reader took`);
    assert.equal(s.booked.loyaltyMinor, 0, `${o.ref}: no loyalty tender`);
    assert.equal(s.booked.stampsUsed, false, `${o.ref}: the customer keeps the stamps`);
    assert.ok(s.refused > 0 && s.pending === FREE_DRINK, `${o.ref}: the reward is still chosen, and staff were told`);
  }
});

test('the wait: Card is held until the reward is on the bill, so the reader is asked for the right amount', () => {
  for (const o of SIX) {
    // staff press Card early (held), the lookup answers, they press again
    const s = replay({ ...o, events: ['card', 'lookup', 'card', 'approve'] }, NOW);
    assert.equal(s.heldPresses, 1, `${o.ref}: the early press sent nothing`);
    assert.equal(s.sentDueMinor, o.totalMinor - o.rewardMinor, `${o.ref}: the reader was asked for the bill less the reward`);
    assert.equal(s.booked.cardMinor, s.sentDueMinor, `${o.ref}: and that is what is booked`);
    assert.equal(s.booked.loyaltyMinor, o.rewardMinor, o.ref);
    assert.equal(s.booked.stampsUsed, true, `${o.ref}: the customer got the free drink they chose`);
  }
});

test('whatever the order of events, the card leg booked equals the amount sent', () => {
  const orders = [
    ['lookup', 'card', 'approve'],                       // the normal sale: reward on, then Card
    ['card', 'lookup', 'approve'],                       // the six
    ['card', 'approve', 'lookup'],                       // the lookup answers after the sale is booked
    ['card', 'lookup', 'decline', 'card', 'approve'],    // declined: back on the bill, the reward applies, sent again net
    ['card', 'decline', 'lookup', 'card', 'approve'],
    ['card', 'approve'],                                 // the lookup never answers
  ];
  for (const rules of [NOW, LOCK_ONLY]) {
    for (const events of orders) {
      for (const o of SIX) {
        const s = replay({ ...o, events }, rules);
        if (!s.booked) continue;   // every press was held and nothing was sent: nothing to book
        assert.equal(
          cardLegDiffersFromSend({ sentDueMinor: s.sentDueMinor, bookedCardMinor: s.booked.cardMinor }), false,
          `${o.ref} ${events.join(' > ')}: sent ${s.sentDueMinor}, booked ${s.booked.cardMinor}`,
        );
        assert.equal(s.booked.stampsUsed, s.booked.loyaltyMinor > 0, 'stamps are used only when the reward came off the bill');
      }
    }
  }
  // a declined card brings the reward onto the bill for the second send
  const again = replay({ ...SIX[0], events: ['card', 'lookup', 'decline', 'card', 'approve'] }, LOCK_ONLY);
  assert.equal(again.sentDueMinor, 485);
  assert.equal(again.booked.loyaltyMinor, 400);
});

// ── 3. Source pins: CheckoutModal reads the rules ───────────────────────────

test('checkout: the chosen reward goes through the lock, with the press known in the same tick', () => {
  const cm = code(read('surfaces/CheckoutModal.jsx'));
  assert.match(cm, /import \{\s*cardSendLocked, pendingRewardAction, holdCardForReward, cardLegDiffersFromSend, lateRewardMessage, REWARD_WAIT_MS,\s*\} from '\.\.\/lib\/payments\/cardSendLock';/);
  assert.match(cm, /const cardLocked = cardSendLocked\(\{ sending: paxBusy, screen \}\);/);

  // the lock is declared after the state it reads (a value used above its own line stops the page)
  assert.ok(cm.indexOf('const [paxBusy, setPaxBusy] = useState(false);') < cm.indexOf('const cardLocked = cardSendLocked('));
  assert.ok(cm.indexOf("const [screen, setScreen] = useState('review');") < cm.indexOf('const cardLocked = cardSendLocked('));

  // the effect asks the rule, and applies only on 'apply'
  const at = cm.indexOf('const action = pendingRewardAction({');
  assert.ok(at > cm.indexOf('const cardLocked = cardSendLocked('), 'the effect sits below the lock');
  const effect = cm.slice(at, cm.indexOf('}, [pendingLoyaltyReward, loyaltyData, loyaltyApplied, cardLocked]);', at));
  assert.ok(effect.length > 0, 'the lock is a dependency: the reward applies when staff are back on the bill');
  assert.match(effect, /pending: pendingLoyaltyReward, applied: loyaltyApplied, haveLoyalty: !!loyaltyData, locked: cardLocked,\s*applyFailed: rewardApplyFailed,/);
  assert.match(effect, /if \(action === 'refuse'\) \{ tellLateReward\(pendingLoyaltyReward\); return; \}/);
  assert.match(effect, /if \(action !== 'apply'\) return;/);
  // the answer checks the press itself before it touches the bill
  const then = effect.slice(effect.indexOf('.then(r => {'));
  assert.ok(then.indexOf('if (cardSendingRef.current) {') > 0);
  assert.ok(then.indexOf('if (cardSendingRef.current) {') < then.indexOf('setLoyaltyApplied(r);'), 'checked before the reward is applied');

  // this is the ONLY place the display's reward is applied
  assert.equal(cm.split('redeemLoyaltyReward(pendingLoyaltyReward, {').length - 1, 1);
  assert.doesNotMatch(cm, /\}, \[pendingLoyaltyReward, loyaltyData, loyaltyApplied\]\);/, 'the unlocked effect is gone');
});

test('checkout: every way a card payment starts sets the lock before anything else, and releases it at the end', () => {
  const cm = code(read('surfaces/CheckoutModal.jsx'));
  assert.match(cm, /const resetCardStart = \(\) => \{ cardSendingRef\.current = true; setPaxError\(''\); setPaxBusy\(true\);/);
  const start = cm.slice(cm.indexOf('const startTerminalJob = async () => {'), cm.indexOf('const watchBusyPayment = async (detail) => {'));
  assert.match(start, /^const startTerminalJob = async \(\) => \{\s*resetCardStart\(\);/, 'the first line of the send');
  assert.ok(start.indexOf('resetCardStart();') < start.indexOf('const dueMinor = toMinor(grand);'), 'locked before the amount is read');
  assert.match(start, /\} finally \{\s*cardSendingRef\.current = false;\s*setPaxBusy\(false\);\s*\}/);
  const watch = cm.slice(cm.indexOf('const watchBusyPayment = async (detail) => {'), cm.indexOf('const openPriorCheck ='));
  assert.match(watch, /^const watchBusyPayment = async \(detail\) => \{\s*cardSendingRef\.current = true;/);
  assert.match(watch, /\} finally \{\s*cardSendingRef\.current = false;\s*setPaxBusy\(false\);\s*\}/);
  // the amount sent and the reward in the job's draft are read in the same closure
  assert.match(start, /dueMinor,\n/);
  assert.match(start, /loyaltyRedemption: loyaltyApplied \|\| null,/);
});

test('checkout: a promo code answered after Card was pressed is not applied; gift and split have no late answer', () => {
  const cm = code(read('surfaces/CheckoutModal.jsx'));
  assert.match(cm, /useEffect\(\(\) => \{ cardLockedRef\.current = cardLocked; \}, \[cardLocked\]\);/);
  assert.match(cm, /const billLockedNow = \(\) => cardSendingRef\.current \|\| cardLockedRef\.current;/);
  // the promo check: the lock is read AFTER the server answers and BEFORE the code is held
  const promo = cm.slice(cm.indexOf('const applyPromoCode = async (rawCode) => {'), cm.indexOf('const taxCtx = useStore('));
  const answered = promo.indexOf("supabase.functions.invoke('promo-redeem'");
  const locked = promo.indexOf('if (billLockedNow()) return { error:');
  const held = promo.indexOf('setPromoApplied(heldPromo(');
  assert.ok(answered > 0 && locked > answered && held > locked, 'asked, lock read, then held');
  assert.equal(promo.split('setPromoApplied(').length - 1, 1, 'one place a typed code reaches the bill');
  // the caller leaves the screen it is on only when the code was applied
  assert.match(cm, /onPromoCode=\{async \(code\) => \{ const r = await applyPromoCode\(code\); if \(r\?\.ok\) setScreen\('review'\); return r; \}\}/);
  // a gift card reaches the bill by a press on its own screen (the lookup only fills that screen)
  const gift = cm.slice(cm.indexOf('function GiftCardEntry('), cm.indexOf('function LoyaltyRewardsEntry('));
  assert.match(gift, /setCardInfo\(j\); setLoading\(false\); return;/);
  assert.equal(gift.split('onApplied(').length - 1, 1, 'applied in one place');
  assert.ok(gift.indexOf('onApplied(') > gift.indexOf('const handleApply = () => {'), 'and that place is the Apply press');
  // a split carries no reward and no code: its close books neither
  const split = cm.slice(cm.indexOf('{showSplit && ('));
  const close = split.slice(split.indexOf("onComplete({ method:'split'"), split.indexOf('onClose={()=>setShowSplit(false)}'));
  assert.ok(close.length > 0);
  assert.doesNotMatch(close, /loyaltyRedemption|promoRedemption/);
});

test('checkout: Card waits for the chosen reward (button and press), for a bounded time', () => {
  const cm = code(read('surfaces/CheckoutModal.jsx'));
  assert.match(cm, /const \[loyaltyDone, setLoyaltyDone\] = useState\(!customer\?\.phone\);/);
  assert.match(cm, /\.finally\(\(\) => \{ if \(alive\) \{ setLoyaltyLoading\(false\); setLoyaltyDone\(true\); \} \}\);/, 'the lookup always ends the wait');
  assert.match(cm, /const waitingOnReward = holdCardForReward\(\{ \.\.\.rewardWait, waitedOut: false \}\);/);
  assert.match(cm, /const t = setTimeout\(\(\) => setRewardWaitOver\(true\), REWARD_WAIT_MS\);\s*return \(\) => clearTimeout\(t\);\s*\}, \[waitingOnReward\]\);/);
  assert.match(cm, /const holdCard = holdCardForReward\(\{ \.\.\.rewardWait, waitedOut: rewardWaitOver \}\);/);
  // the button
  assert.match(cm, /<button onClick=\{handleCardPress\} disabled=\{paxBusy \|\| holdCard\}/);
  // the press: after the training stop, before any send
  const press = cm.slice(cm.indexOf('const handleCardPress = () => {'), cm.indexOf('const nonVoided ='));
  assert.ok(press.indexOf('if (holdCard) return;') > press.indexOf('if (isTrainingMode())'));
  assert.ok(press.indexOf('if (holdCard) return;') < press.indexOf('startTerminalJob(); return;'));
  // declared before the handler that reads it
  assert.ok(cm.indexOf('const holdCard = holdCardForReward(') < cm.indexOf('const handleCardPress = () => {'));
});

test('checkout: the approved close compares the card leg with the job before it books', () => {
  const cm = code(read('surfaces/CheckoutModal.jsx'));
  const at = cm.indexOf("{screen==='pax_terminal' && paxJob && (");
  assert.ok(at > 0);
  const pax = cm.slice(at, cm.indexOf('onFailed={(job)=>{', at));
  const check = pax.indexOf('if (cardLegDiffersFromSend({ sentDueMinor: paxJob?.due_minor, bookedCardMinor: toMinor(grand) })) {');
  assert.ok(check > 0);
  assert.ok(check < pax.indexOf("complete('card',"), 'checked before the sale is booked');
  // it tells, it never stops the booking: an approved card is always recorded
  assert.doesNotMatch(pax.slice(check, pax.indexOf("complete('card',")), /\breturn;/);
});

test('the rule file is pure and has no dashes', () => {
  const src = read('lib/payments/cardSendLock.js');
  assert.doesNotMatch(src, /^import /m, 'no imports: no store, no React, no Supabase');
  assert.doesNotMatch(src, DASH);
  assert.doesNotMatch(read('lib/payments/cardSendLock.test.js'), DASH);
});
