// src/lib/checkoutPaxWiring.test.js (30 Sep 2026): the till checkout watches and finishes every card
// machine payment from the first second. Reads the real files, like paymentBusyWiring.test.js: a
// perfect kickRace.js is worth nothing unless CheckoutModal opts in, hides the exits and hands the
// kick to the card screen.
//
// Coffee Boy Huddersfield, 30 Sep 2026: the checkout awaited its own Adyen 'start' call (the whole
// tender), so it sat on "Sending…" with × and Cash live and nothing watching the job. Staff closed
// it at 17 s, the reader approved £11.65, the till's reconciler booked R5737 in the background (no
// kitchen ticket, cart still on screen), and the order was rung again: R5739, the same card.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel) => fs.readFileSync(here(rel), 'utf8');
const count = (hay, needle) => hay.split(needle).length - 1;
const between = (src, startMarker, endMarker) => {
  const i = src.indexOf(startMarker);
  assert.ok(i >= 0, `marker not found: ${startMarker}`);
  const j = endMarker ? src.indexOf(endMarker, i + startMarker.length) : src.length;
  assert.ok(j > i, `end marker not found after ${startMarker}: ${endMarker}`);
  return src.slice(i, j);
};
const before = (src, first, second, why) => {
  const a = src.indexOf(first);
  const b = src.indexOf(second);
  assert.ok(a >= 0, `${why}: missing ${first}`);
  assert.ok(b >= 0, `${why}: missing ${second}`);
  assert.ok(a < b, why);
};

const co = read('../surfaces/CheckoutModal.jsx');
const startJob = between(co, 'const startTerminalJob = async () => {', 'const handleCardPress = () => {');

test('the checkout watches its check before anything else in startTerminalJob: link gate, gift commit, create', () => {
  assert.ok(co.includes("import { checkoutOrderRef, watchCheckout } from '../lib/payments/terminalJobCloser';"));
  before(startJob, 'watchThisCheck();', 'confirmLinkBeforeCard()', 'watch, then the link gate');
  before(startJob, 'watchThisCheck();', 'commitGift(', 'watch, then the gift commit');
  before(startJob, 'watchThisCheck();', 'dispatchTerminalJob({', 'watch, then the create');
  // Keyed on the same check id the job carries as closed_check_id.
  const helper = between(co, 'const watchThisCheck = () => {', 'const startTerminalJob = async () => {');
  assert.ok(helper.includes('const watchId = getCheckId();'));
  assert.ok(helper.includes('checkWatchRef.current = { id: watchId, off: watchCheckout(watchId) };'));
  assert.ok(startJob.includes('closedCheckId: checkId,'));
  // Released on unmount, so a closed checkout lets the reconciler book an approved sale at once.
  assert.ok(co.includes('useEffect(() => () => { checkWatchRef.current?.off?.(); checkWatchRef.current = null; }, []);'));
  assert.equal(count(co, 'watchCheckout('), 1, 'one watch per checkout');
});

test('kickWaitMs is passed on the create, and the kick comes back with the job', () => {
  assert.ok(co.includes("import { KICK_WAIT_MS } from '../lib/payments/kickRace';"));
  assert.ok(startJob.includes('const { job, kickError, serverKick, kickPending, kick, repeatWarning } = await dispatchTerminalJob({'));
  assert.ok(startJob.includes('kickWaitMs: KICK_WAIT_MS,'));
  // The card screen mounts as soon as the send returns, kick settled or not.
  before(startJob, 'setPaxJob(job);', "setScreen('pax_terminal');", 'job set, then the card screen');
  assert.ok(startJob.includes('setPaxKick(kickPending && kick ? kick : null);'));
  before(startJob, 'setPaxKick(kickPending && kick ? kick : null);', "setScreen('pax_terminal');", 'the kick is handed over before the screen shows');
});

test('while the send is out (paxBusy): × and Back are hidden, Cash is hidden, gift and split are disabled, the bill is locked', () => {
  const header = between(co, '{/* v5.5.181: while a card payment is in flight on the reader,', '{/* v5.5.793: on the review screen the body is a flex column');
  assert.ok(header.includes("{screen!=='card_terminal' && screen!=='pax_terminal' && !paxBusy && ("), '× hidden while paxBusy');
  assert.ok(header.includes("{screen!=='review' && screen!=='card_terminal' && screen!=='pax_terminal' && !paxBusy && ("), 'Back hidden while paxBusy');
  assert.equal(count(header, 'onClick={onClose}'), 1, 'one × and it sits behind the guard');
  assert.ok(co.includes("{_canTakeCash && !paxBusy && <button onClick={()=>setScreen('cash')}"), 'Cash hidden while paxBusy');
  assert.ok(co.includes("<button disabled={paxBusy} onClick={()=>setScreen('gift_card')}"), 'gift card disabled');
  assert.ok(co.includes('<button disabled={paxBusy || splitWithReader || splitWithBookingCredit} onClick={()=>{'), 'split disabled');
  assert.ok(co.includes("pointerEvents: paxBusy ? 'none' : undefined"), 'the bill region is locked');
  // The gift and promo "remove" links sit in the pinned totals region: the due the reader was sent
  // is already net of them, so they are locked too.
  assert.ok(co.includes("<button disabled={paxBusy} onClick={()=>{ applyGift(null); setGiftError(''); }}"), 'gift remove locked');
  assert.ok(co.includes("<button disabled={paxBusy} onClick={()=>{ setPromoApplied(null); }}"), 'promo remove locked');
  assert.ok(co.includes('<button onClick={handleCardPress} disabled={paxBusy}'), 'Card itself cannot be pressed twice');
});

test('staff wording: Sending to the card machine…, and the card screen says the payment finishes by itself', () => {
  assert.ok(co.includes("{paxBusy ? 'Sending to the card machine…' : 'Card'}"));
  const px = read('../surfaces/PaxTerminal.jsx');
  assert.ok(px.includes("sub: 'Customer is paying on the card machine. Keep this screen open, it finishes by itself.'"));
  assert.ok(px.includes("{cancelBusy ? 'Cancelling…' : 'Cancel payment'}"));
  // No em or en dashes as punctuation in the new copy.
  for (const line of [
    'Sending to the card machine…',
    'Customer is paying on the card machine. Keep this screen open, it finishes by itself.',
    'Card approved after the checkout closed:',
  ]) assert.ok(!/[–—]/.test(line), line);
});

test('the card screen takes the kick and its own watch (by job id) is unchanged', () => {
  const mount = between(co, "{screen==='pax_terminal' && paxJob && (", '{screen===\'cash\' && (');
  assert.ok(mount.includes('kickPending={!!paxKick || paxAdopted}'), 'an adopted live job counts as an open kick');
  assert.ok(mount.includes('kick={paxKick}'));
  assert.ok(mount.includes('setPaxJob(null); setPaxKick(null); setScreen(\'review\');'), 'Back clears the kick with the job');
  const px = read('../surfaces/PaxTerminal.jsx');
  assert.ok(px.includes('useEffect(() => watchTerminalJob(initialJob?.id), [initialJob?.id]);'));
});

test('the sale booked after the checkout closed is adopted: reconciler → store → banner', () => {
  const rec = read('../sync/TerminalJobReconciler.js');
  assert.ok(rec.includes("import { closerRole, closeWaitMs, isDue, createSightings, isWatchedHere, adoptBookedSale } from '../lib/payments/terminalJobCloser';"));
  const tick = between(rec, 'const tick = async () => {', '\n  };');
  before(tick, 'const watchedHere = isWatchedHere(job.id, job.closed_check_id);', 'closeApprovedTerminalJob(job)', 'the watch is read before the book');
  before(tick, 'const booked = await useStore.getState().closeApprovedTerminalJob(job);', 'adoptBookedSale({', 'book, then adopt');
  assert.ok(tick.includes("const walkInRef = st.walkInOrder?.ref || null;"));
  assert.ok(tick.includes('if (adopt.clearWalkIn) st.clearWalkIn?.();'));
  assert.ok(tick.includes('st.showCardAdoptedBanner?.({ text: adopt.banner, jobId: job.id, ref: booked?.ref || null, at: Date.now() });'));
  const store = read('../store/index.js');
  assert.ok(store.includes('cardAdoptedBanner: null,'));
  assert.ok(store.includes('dismissCardAdoptedBanner: () => set({ cardAdoptedBanner: null }),'));
  const banner = read('../components/CardAdoptedBanner.jsx');
  assert.ok(banner.includes('const banner = useStore(s => s.cardAdoptedBanner);'));
  assert.ok(!/setTimeout/.test(banner), 'sticky: no auto dismiss');
  assert.ok(read('../App.jsx').includes('<CardAdoptedBanner />'));
});

test('the payment busy wiring is untouched by this change (dispatch wrapper, checkout hold)', () => {
  const tj = read('./payments/terminalJobs.js');
  assert.ok(tj.includes("export function dispatchTerminalJob(p) {\n  return withPaymentBusy('card machine job send', () => sendTerminalJob(p));\n}"));
  assert.equal(count(co, "usePaymentBusy(true, 'checkout');"), 1);
});
