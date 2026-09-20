// moneyFunctionHelpers.test.js: database fence stage 1, the money edge functions (19 Sep 2026).
// The helpers and client wiring behind moneyFunctionFence.test.js, first built on the parked
// lockdown branch (fix/loyalty-giftcard-exposure, rounds one to four) and carried into stage 1:
//   * the member's session token carries the phone proven with the one time code, and gift cards
//     are matched on THAT phone only (never a name, never an unverified email);
//   * loyalty-earn earns from the server's own closed check, never the request body;
//   * promo codes match exactly, inside the venue's own org;
//   * gift-fulfill proves the payment with the processor, issues one card per purchase, and a
//     processor outage is retried by the webhooks;
//   * the clients send what the fence needs: the member token (online, kiosk), the venue and the
//     session (till loyalty lookups, Back Office), and they wait for the device link.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createSessionToken, verifySessionToken, inspectSessionToken, memberTokenCoversCheck, SESSION_TTL_MS,
} from '../../supabase/functions/_shared/loyalty-session.ts';
import {
  phoneMatchVariants, giftCardRecipientFilter, memberGiftCards, MEMBER_GIFT_CARD_COLUMNS,
  normaliseMemberPhone, cardBelongsToPhone, phonesMatch, phoneShape,
} from '../../supabase/functions/_shared/giftCardMatch.ts';
import { limitedMemberReply, LIMITED_MEMBER_KEYS } from '../../supabase/functions/_shared/memberReply.ts';
import {
  decideEarnSource, earnItemsFromCheck, checkCapMinor, checkBelongsToMember, checkItemIds, checkIsEarnable,
} from '../../supabase/functions/_shared/earnFromCheck.ts';
import {
  normalisePromoCode, escapeLike, promoRowMatches, pickPromoRow, offerInOrg, planSaveOffer,
} from '../../supabase/functions/_shared/promoLookup.ts';
import { opsIdsOf, companyOrgIds, locationInCompany, customerInCompany } from '../../supabase/functions/_shared/orgScope.ts';
import {
  stripeSessionProvesPurchase, ryftSessionProvesPurchase, purchaseProcessor,
} from '../../supabase/functions/_shared/giftPurchaseProof.ts';
import {
  purchaseCardId, issueLedgerKey, proofReasonRetryable, processorErrorReason, fulfilResponseRetryable,
} from '../../supabase/functions/_shared/giftFulfilPlan.ts';
import { createAuthorityLogLimiter } from '../../supabase/functions/_shared/authorityLogLimiter.ts';
import { authorityLogRow } from '../../supabase/functions/_shared/loyalty-authority.ts';
import { codeHolderView, isFullGiftCode, classifyGiftLookup } from '../../supabase/functions/_shared/gift-authority.ts';
import { setActiveMemberSession, memberTokenFor, activeMemberToken, MEMBER_GRACE_MS } from './memberSession.js';
import { stageGiftCard, commitGiftCard, giftReversalFailedMessage } from './giftCommit.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const fnSrc = (name) => code(read(`../../supabase/functions/${name}/index.ts`));

const ALICE = '+447700900001';
const CO = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const ORG2 = '33333333-3333-4333-8333-333333333333';

// ── The member's session token ──────────────────────────────────────────────
test('the session token carries the proven phone and still reads tokens minted before it did', async () => {
  const secret = 's3cret';
  const now = 1_800_000_000_000;
  const tok = await createSessionToken('cust-1', 'co-1', ALICE, secret, now);
  assert.deepEqual(await verifySessionToken(tok, secret, now + 1000), { customerId: 'cust-1', companyId: 'co-1', phone: ALICE });
  assert.equal(await verifySessionToken(tok, 'wrong', now), null, 'bad signature');
  assert.equal(await verifySessionToken(tok, secret, now + SESSION_TTL_MS + 1), null, 'expired');
  const forged = btoa(`cust-2:co-1:${now}:${ALICE}`) + '.' + tok.split('.')[1];
  assert.equal(await verifySessionToken(forged, secret, now), null, 'cannot swap the customer');
  // A three field token from before 18 Sep 2026 (same HMAC over the raw payload).
  const payload = `cust-1:co-1:${now}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))).map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.deepEqual(await verifySessionToken(btoa(payload) + '.' + sig, secret, now), { customerId: 'cust-1', companyId: 'co-1', phone: null });
});

test('an expired member token still counts for the order it was live for, and nothing else', async () => {
  const secret = 's3cret';
  const issued = 1_800_000_000_000;
  const tok = await createSessionToken('cust-1', CO, ALICE, secret, issued);
  const later = issued + SESSION_TTL_MS + 3 * 24 * 60 * 60 * 1000;
  assert.equal(await verifySessionToken(tok, secret, later), null, 'expired for everything normal');
  const t = await inspectSessionToken(tok, secret, later);
  assert.equal(t.expired, true);
  assert.equal(await inspectSessionToken(tok, 'wrong', later), null);
  assert.equal(memberTokenCoversCheck(t.issuedAt, issued + 60 * 60 * 1000), true);
  assert.equal(memberTokenCoversCheck(t.issuedAt, issued + SESSION_TTL_MS + 60 * 60 * 1000), false);
  assert.equal(memberTokenCoversCheck(t.issuedAt, issued - 60 * 60 * 1000), false);
  assert.equal(memberTokenCoversCheck(t.issuedAt, NaN), false);
});

// ── Gift cards reach only the phone proven with the code ────────────────────
const rows = [
  { id: 'a1', code_last4: '1111', code_plain: 'AAAA1111AAAA1111', balance_minor: 2500, initial_amount_minor: 2500, recipient_phone: ALICE, recipient_name: 'Sam Smith', recipient_email: 'alice@example.com' },
  { id: 'a2', code_last4: '2222', code_plain: 'AAAA2222AAAA2222', balance_minor: 1000, initial_amount_minor: 1000, recipient_phone: '07700900001', recipient_name: 'Alice' },
  { id: 'b1', code_last4: '9999', code_plain: 'BBBB9999BBBB9999', balance_minor: 5000, initial_amount_minor: 5000, recipient_phone: '+447700900999', recipient_name: 'Sam Smith' },
  { id: 'c1', code_last4: '8888', code_plain: 'CCCC8888CCCC8888', balance_minor: 7000, initial_amount_minor: 7000, recipient_phone: null, recipient_email: 'victim@example.com' },
];

test('a member named like somebody else, or who typed somebody\'s email, never sees their card', () => {
  const seen = memberGiftCards(rows, ALICE).map((c) => c.id);
  assert.deepEqual(seen.sort(), ['a1', 'a2']);
  assert.deepEqual(memberGiftCards(rows, null), []);
  assert.deepEqual(memberGiftCards(rows, ''), []);
  const [card] = memberGiftCards([rows[0]], ALICE);
  assert.deepEqual(card, { id: 'a1', last4: '1111', code: 'AAAA1111AAAA1111', balance: 2500, initial: 2500, expires_at: null }, 'the member keeps the code of their OWN card');
});

test('the gift card filter fetches the proven phone however it was typed, and refuses junk', () => {
  const net = '%7%7%0%0%9%0%0%0%0%1%';
  assert.equal(giftCardRecipientFilter(ALICE), `recipient_phone.ilike.${net}`);
  assert.equal(giftCardRecipientFilter('07700900001'), `recipient_phone.ilike.${net}`);
  assert.equal(giftCardRecipientFilter('07700 900 001'), `recipient_phone.ilike.${net}`);
  assert.equal(giftCardRecipientFilter(null), null);
  assert.equal(giftCardRecipientFilter('x,recipient_name.eq.Sam'), null, 'no filter injection');
  assert.ok(/^recipient_phone\.ilike\.[%0-9]+$/.test(giftCardRecipientFilter('+1 (650) 555-0100')));
  assert.deepEqual(phoneMatchVariants('+1 555'), []);
  assert.ok(MEMBER_GIFT_CARD_COLUMNS.includes('recipient_phone'));
});

test('GB and US numbers match on their digits, never across countries', () => {
  assert.ok(phonesMatch('+44 (0) 7931 123456', '+447931123456'));
  assert.ok(phonesMatch('07931 123 456', '+447931123456'));
  assert.ok(phonesMatch('(415) 555-0123', '+14155550123'));
  assert.ok(phonesMatch('1 415 555 0123', '+14155550123'));
  assert.equal(phonesMatch('07021234567', '+17021234567'), false, 'a trunk 0 is never a US number');
  assert.equal(phonesMatch('+447021234567', '+17021234567'), false);
  assert.equal(phonesMatch('123456', '+44123456'), false, 'too short to mean anything');
  assert.equal(phoneShape('+44 (0) 7931 123456').nsn, '7931123456');
  assert.ok(cardBelongsToPhone({ recipient_phone: '(415) 555-0123' }, '+14155550123'));
  assert.equal(cardBelongsToPhone({ recipient_phone: null, recipient_email: 'x@y' }, ALICE), false, 'email only cards are never matched');
  assert.equal(normaliseMemberPhone('07931 123 456'), '+447931123456');
});

test('the phone rule is the app\'s own rule (same as src/lib/customerLookup.js normalisePhone)', () => {
  const src = read('./customerLookup.js');
  const body = src.slice(src.indexOf('export function normalisePhone(raw) {'), src.indexOf('// Cache the org_id'));
  const appRule = new Function(`${body.replace('export ', '')}; return normalisePhone;`)();
  for (const p of ['07931 123 456', '+44 7931 123456', '447931123456', '07931-123-456', '(650) 555-0100', '+1 650 555 0100', '0203 123 4567', '', 'abc']) {
    assert.equal(normaliseMemberPhone(p), appRule(p), p);
  }
});

test('loyalty-otp verify and refresh match gift cards on the proven phone only', () => {
  const src = fnSrc('loyalty-otp');
  assert.ok(src.includes('giftCardsForProvenPhone(companyId, phone)'), 'verify uses the phone Twilio approved');
  assert.ok(src.includes('const provenPhone = session.phone || cust?.phone || null;'), 'refresh uses the phone on the token');
  const member = fnSrc('loyalty-member-lookup');
  assert.ok(!member.includes('recipient_email') && !member.includes('code_plain'));
  assert.ok(member.includes('.filter(c => cardBelongsToPhone(c, customer.phone))'));
});

test('the limited reply says only "member" and the points and stamps switches', () => {
  const r = limitedMemberReply({ enabled: true, points_enabled: false, stamps_enabled: true });
  assert.deepEqual(Object.keys(r).sort(), [...LIMITED_MEMBER_KEYS].sort());
  assert.equal(limitedMemberReply({ enabled: false }).points_enabled, false);
  for (const k of ['name', 'phone', 'email', 'allergens', 'customer_id', 'member_code', 'points_balance', 'recent_transactions']) assert.ok(!(k in r), `no ${k}`);
});

test('a code holder sees balance and status, never the email, note or history', () => {
  const v = codeHolderView({ card_id: 'c', status: 'active', balance: 500, recipient_name: 'Sam', recipient_email: 's@x.com', note: 'n', recent_transactions: [{}] });
  assert.equal(v.balance, 500);
  assert.equal(v.recipient_name, 'Sam', 'the till shows the name');
  assert.ok(!('recipient_email' in v) && !('note' in v) && !('recent_transactions' in v));
  assert.ok(isFullGiftCode('ABCD EFGH JKLM NPQR'));
  for (const body of [{ search: 'Sam Smith' }, { search: 'sam@example.com' }, { search: 'NPQR' }, { code_last4: 'NPQR', email: 'sam@example.com' }]) {
    assert.equal(classifyGiftLookup(body), 'staff_search', JSON.stringify(body));
  }
});

// ── Earn from the server's closed check ─────────────────────────────────────
const check = {
  id: 'chk-1', location_id: 'L', subtotal: 12.5, total: 12.5, status: 'paid',
  customer: { name: 'Sam', phone: '07931 123456' },
  items: [
    { itemId: 'latte-l', parentId: 'latte', name: 'Latte (L)', price: 3.5, qty: 2 },
    { itemId: 'cake', name: 'Cake', price: 4, qty: 1, cat: 'body-says-coffee' },
    { itemId: 'void-thing', name: 'Voided', price: 100, qty: 1, voided: true },
    { itemId: 'gc', name: 'Gift card', price: 20, qty: 1, isGiftCard: true },
  ],
};
const menu = [{ id: 'latte', cat: 'coffee' }, { id: 'latte-l', cat: 'sandwiches', parent_id: 'latte' }, { id: 'cake', cat: 'bakery' }];

test('earn uses the server\'s closed check, not the body', () => {
  const items = earnItemsFromCheck(check, menu);
  assert.equal(items.length, 3, 'voided lines never earn');
  assert.equal(items[0].cat, 'coffee', "a variant takes its parent's category from the menu");
  assert.equal(items[1].cat, 'bakery', 'the menu wins over what the check line says');
  assert.equal(checkCapMinor(check), 1250);
  assert.deepEqual(checkItemIds(check).sort(), ['cake', 'gc', 'latte', 'latte-l']);
  assert.equal(checkIsEarnable({ ...check, refunded: true }), false);
  assert.equal(decideEarnSource({ mode: 'enforce', check: null, via: 'device', member: null }).code, 'check_not_found');
  assert.equal(decideEarnSource({ mode: 'enforce', check: { ...check, voided: true }, via: 'device', member: null }).use, 'refuse');
  const stranger = { customerId: 'cust-9', phone: '+447000000000' };
  assert.equal(decideEarnSource({ mode: 'enforce', check, via: 'member', member: stranger }).code, 'check_not_this_member');
  assert.deepEqual(decideEarnSource({ mode: 'enforce', check, via: 'member', member: { customerId: 'c', phone: '+447931123456' } }), { use: 'check', record: null });
  assert.equal(checkBelongsToMember({ ...check, customer_id: 'c-7' }, { customerId: 'c-7', phone: null }), true);
  assert.deepEqual(decideEarnSource({ mode: 'report', check: null, via: null, member: null }), { use: 'body', record: 'check_not_found' });
});

test('loyalty-earn wiring: reads its check at the venue, earns from it, one earn per check, claim first', () => {
  const src = fnSrc('loyalty-earn');
  const gate = src.indexOf('if (!gate.allow) return gate.response!;');
  assert.ok(src.indexOf(".from('closed_checks')") > gate);
  assert.ok(src.includes(".eq('id', String(closed_check_id))\n    .in('location_id', locKeys)"));
  assert.ok(src.includes('items = earnItemsFromCheck(check as CheckRow, menu);'));
  assert.ok(src.includes('if (cap > 0) qualifyingMinor = Math.min(qualifyingMinor, cap);'));
  const claim = src.indexOf("const { data: claim, error: claimErr } = await opsAdmin.from('loyalty_transactions').insert({");
  assert.ok(claim > 0 && src.indexOf('const nb = await updateBalance(membership.id, pointsEarned);') > claim);
  const store = read('../store/index.js');
  assert.ok(store.includes('closed_check_id: orderRecord.id || orderRecord.ref,'));
  assert.ok(read('./customerLookup.js').includes('closed_check_id: orderRecord.checkId || orderRecord.ref || `online-${Date.now()}`,'));
  assert.equal((read('../surfaces/online/OnlineCheckout.jsx').match(/orderRecord: \{ ref, checkId, total:/g) || []).length, 2, 'both online paths');
  assert.ok(store.includes("if (code !== 'check_not_found') break;"));
  assert.ok(read('./customerLookup.js').includes("if (code !== 'check_not_found') break;"));
});

// ── Promo codes ─────────────────────────────────────────────────────────────
test('promo codes: exact match only, never a wildcard or a prefix, never another company', () => {
  for (const bad of ['%', '_', '*', 'A%', 'BDAY-%', 'BDAY-*', '%BDAY%', 'B_AY', '', '   ', '-', 'A-', 'A B', "A'", 'A,B', null, 42]) {
    assert.equal(normalisePromoCode(bad), null, `refused: ${JSON.stringify(bad)}`);
  }
  assert.equal(normalisePromoCode(' bday-7f3k9 '), 'BDAY-7F3K9');
  assert.equal(escapeLike('A%B_C\\D*'), 'A\\%B\\_C\\\\D\\*');
  const mine = { code: 'bday-7f3k9', org_id: ORG };
  const theirs = { code: 'BDAY-7F3K9', org_id: ORG2 };
  const prefixSibling = { code: 'BDAY-7F3K99', org_id: ORG };
  assert.equal(promoRowMatches(mine, 'BDAY-7F3K9', ORG), true);
  assert.equal(promoRowMatches(theirs, 'BDAY-7F3K9', ORG), false);
  assert.equal(promoRowMatches(prefixSibling, 'BDAY-7F3K9', ORG), false);
  assert.equal(pickPromoRow([theirs, prefixSibling, mine], 'BDAY-7F3K9', ORG), mine);
  assert.equal(offerInOrg({ org_id: ORG2 }, ORG), false);
  assert.deepEqual(planSaveOffer(null, null, ORG), { ok: true, mode: 'insert' });
  assert.equal(planSaveOffer('offer-x', { id: 'offer-x', org_id: ORG2 }, ORG).status, 404, 'another company\'s offer is never taken over');
  const src = fnSrc('promo-redeem');
  assert.equal((src.match(/await evaluate\(body\?\.code, locationId, customerId, subtotal\)/g) || []).length, 2, 'validate and redeem share the lookup');
});

test('the venue org comes from the Ops row (Platform locations has no org_id)', () => {
  const platform = [{ id: 'p1', ops_location_id: 'L1' }, { id: 'p2', ops_location_id: 'L2' }, { id: 'p3', ops_location_id: null }];
  assert.deepEqual(opsIdsOf(platform), ['L1', 'L2']);
  assert.deepEqual([...companyOrgIds([{ id: 'L1', org_id: ORG }, { id: 'x', org_id: null }])], [ORG]);
  assert.equal(locationInCompany(platform, 'L1'), true);
  assert.equal(locationInCompany(platform, 'elsewhere'), false);
  assert.equal(customerInCompany({ org_id: ORG2 }, new Set([ORG])), false);
});

// ── Gift card purchases ─────────────────────────────────────────────────────
const purchase = { id: 'pur-1', amount_minor: 2500, currency: 'gbp' };

test('an unpaid purchase never fulfils; a paid one (Stripe or Ryft) still does', () => {
  const paid = { payment_status: 'paid', metadata: { purchase_id: 'pur-1' }, amount_total: 2500, currency: 'gbp' };
  assert.deepEqual(stripeSessionProvesPurchase(paid, purchase), { ok: true });
  assert.equal(stripeSessionProvesPurchase({ ...paid, payment_status: 'unpaid' }, purchase).reason, 'not_paid');
  assert.equal(stripeSessionProvesPurchase({ ...paid, metadata: { purchase_id: 'pur-2' } }, purchase).reason, 'session_not_for_purchase');
  assert.equal(stripeSessionProvesPurchase({ ...paid, amount_total: 500 }, purchase).reason, 'amount_short', 'a row whose amount was raised after paying');
  assert.equal(stripeSessionProvesPurchase({ ...paid, currency: 'usd' }, purchase).reason, 'currency_mismatch');
  const ps = { status: 'Captured', metadata: { purchase_id: 'pur-1' }, amount: 2500, currency: 'GBP' };
  assert.deepEqual(ryftSessionProvesPurchase(ps, purchase), { ok: true });
  assert.equal(ryftSessionProvesPurchase({ ...ps, status: 'Approved' }, purchase).reason, 'not_paid');
  assert.equal(purchaseProcessor({ processor: 'adyen' }), null, 'Adyen has no gift purchase flow: refused');
});

test('one card per purchase; an outage is retried; "not paid" is final', async () => {
  const a = await purchaseCardId('11111111-2222-4333-8444-555555555555');
  assert.equal(a, await purchaseCardId('11111111-2222-4333-8444-555555555555'));
  assert.notEqual(a, await purchaseCardId('11111111-2222-4333-8444-555555555556'));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(issueLedgerKey('p-1'), 'issue:purchase:p-1');
  assert.equal(proofReasonRetryable('processor_unreachable'), true);
  assert.equal(proofReasonRetryable('ryft_503'), true);
  assert.equal(proofReasonRetryable('not_paid'), false);
  assert.equal(processorErrorReason({ type: 'StripeInvalidRequestError', statusCode: 404 }), 'processor_rejected');
  assert.equal(processorErrorReason(new TypeError('fetch failed')), 'processor_unreachable');
  assert.equal(fulfilResponseRetryable(503, { retryable: true }), true);
  assert.equal(fulfilResponseRetryable(402, { code: 'payment_not_proven' }), false);
  const ful = fnSrc('gift-fulfill');
  assert.ok(ful.includes('const cardId = await purchaseCardId(purchase.id);'));
  assert.ok(ful.includes('idempotency_key: issueLedgerKey(purchase.id),'));
  assert.ok(ful.includes(".from('merchant_stripe_accounts').select('stripe_account_id').eq('location_id', purchase.location_id)"), 'the merchant account from OUR table, never the row');
  const st = fnSrc('stripe-webhook-connect');
  assert.ok(st.includes("(session as any).payment_status !== 'paid'"), 'only a paid session marks a purchase paid');
  assert.ok(st.includes(".eq('id', meta.purchase_id).eq('status', 'pending');"), 'never rewinds a fulfilled purchase');
  assert.ok(st.includes("return new Response('retry later', { status: 503 });"));
  const ry = fnSrc('ryft-webhook');
  assert.ok(ry.includes(".eq('id', p.id).eq('status', 'pending');"));
  assert.ok(ry.includes('if (fulfilResponseRetryable(status, body)) {'));
  assert.ok(fnSrc('gift-purchase-status').includes("status: purchase.status === 'fulfilling' ? 'paid' : purchase.status,"));
  assert.ok(read('../surfaces/gift/GiftSuccessSurface.jsx').includes("data.status === 'fulfilling'"));
});

// ── The authority log ───────────────────────────────────────────────────────
test('the log cannot flood and carries nothing secret', () => {
  let t = 0;
  const lim = createAuthorityLogLimiter({ windowMs: 1000, perKey: 2, perVenueAnonymous: 3, global: 5, now: () => t });
  const k = { fn: 'loyalty-earn', reason: 'anonymous_no_device', callerId: 'a', locationId: 'L', anonymous: true };
  assert.equal(lim.admit(k).write, true);
  assert.equal(lim.admit(k).write, true);
  assert.equal(lim.admit(k).write, false, 'per caller cap');
  assert.equal(lim.admit({ ...k, callerId: 'b' }).write, true);
  assert.equal(lim.admit({ ...k, callerId: 'c' }).write, false, 'an anonymous flood against one venue is sampled');
  t = 1500;
  const next = lim.admit(k);
  assert.equal(next.write, true);
  assert.equal(next.suppressedBefore, 1);
  const row = authorityLogRow({ fn: 'x', mode: 'report', outcome: 'would_refuse', decision: { ok: false, reason: 'r' }, user: { id: 'not-a-uuid', is_anonymous: true }, companyId: 'drop table', locationId: 'x'.repeat(500), deviceHint: "x' or 1=1" });
  assert.equal(row.caller_id, null);
  assert.equal(row.company_id, null);
  assert.equal(row.location_id.length, 80);
  assert.equal(row.detail, null, 'a hint that is not an id is dropped');
  for (const f of ['loyalty-earn', 'gift-redeem', 'gift-list', 'gift-lookup', 'gift-reverse-redeem', 'gift-fulfill', 'stripe-refund', 'ryft-refund']) {
    assert.ok(!fnSrc(f).includes('await recordAuthority('), `${f} never waits on the log`);
  }
});

// ── The clients send what the fence needs ───────────────────────────────────
test('memberSession: a token only ever speaks for its own member, with a short grace after a reset', () => {
  const t0 = 1_000_000;
  setActiveMemberSession({ token: 'tok-a', customerId: 'cust-a' }, t0);
  assert.equal(memberTokenFor('cust-a', t0), 'tok-a');
  assert.equal(memberTokenFor('cust-b', t0), null, 'never for somebody else');
  assert.equal(activeMemberToken(), 'tok-a');
  setActiveMemberSession(null, t0 + 1000);
  assert.equal(activeMemberToken(), null, 'gift cards: no grace');
  assert.equal(memberTokenFor('cust-a', t0 + 2000), 'tok-a', 'an earn landing just after a reset');
  assert.equal(memberTokenFor('cust-a', t0 + 1000 + MEMBER_GRACE_MS + 1), null, 'grace ends');
  setActiveMemberSession(null);
});

test('the kiosk sends the member token with a linked gift card; the till sends none', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ applied: 500, remaining_balance: 0, idempotency_key: 'k', card_id: 'card-1' }) }; };
  try {
    setActiveMemberSession({ token: 'member-tok', customerId: 'cust-1' });
    const r = await commitGiftCard(stageGiftCard({ cardId: 'card-1', code: null, balanceMinor: 500, amountDueMinor: 500 }), { functionsUrl: 'https://x/functions/v1', token: 't', locationId: 'l', channel: 'kiosk', closedCheckId: 'chk-1' });
    assert.equal(r.ok, true);
    assert.equal(calls[0].body.member_token, 'member-tok');
    setActiveMemberSession(null);
    calls.length = 0;
    await commitGiftCard(stageGiftCard({ cardId: 'card-1', code: 'ABCDEFGHJKLMNPQR', balanceMinor: 500, amountDueMinor: 500 }), { functionsUrl: 'https://x/functions/v1', token: 't', locationId: 'l', channel: 'pos', closedCheckId: 'chk-2' });
    assert.ok(!('member_token' in calls[0].body), 'no member, no token');
  } finally {
    globalThis.fetch = realFetch;
    setActiveMemberSession(null);
  }
});

test('the kiosk keeps the member token from verify and publishes it (outside the frozen blocks)', () => {
  const k = read('../surfaces/KioskApp.jsx');
  assert.ok(k.includes('token: data.token || null,'));
  assert.ok(read('../surfaces/kiosk/KioskOtpSheet.jsx').includes('token: data.token || null,'), 'the new design keeps it too');
  assert.ok(k.includes('setActiveMemberSession(verifiedLoyalty?.token'));
  const submit = k.slice(k.indexOf('const submitOrder = useCallback('), k.indexOf('tableNumber, resetSession]);'));
  assert.ok(!submit.includes('setActiveMemberSession') && !submit.includes('memberToken'), 'submitOrder untouched (card path guard)');
});

test('the till waits for its device link before earn, redeem and refund, and re-links once on a 403', () => {
  const store = read('../store/index.js');
  assert.ok(store.includes('setDeviceClaimHooks({ waitForClaim: () => whenDeviceClaimed(), reclaim: () => claimPairedDeviceOnBoot() });'));
  const at = store.indexOf('async function postLoyaltyWithDeviceLink');
  const helper = store.slice(at, at + 1400);
  assert.ok(helper.indexOf('await whenDeviceClaimed();') < helper.indexOf('let res = await send();'));
  assert.ok(helper.includes('if (res && res.status === 403) {') && helper.includes('await claimPairedDeviceOnBoot();'));
  assert.ok(store.includes("const res = await postLoyaltyWithDeviceLink('loyalty-earn', earnBody);"));
  assert.ok(store.includes("const res = await postLoyaltyWithDeviceLink('loyalty-refund', {"));
  assert.ok(store.includes('...(memberTokenFor(customerId) ? { member_token: memberTokenFor(customerId) } : {}),'), 'kiosk earn carries the member token');
  const cr = read('./commitRedemptions.js');
  const commit = cr.slice(cr.indexOf('export async function commitRedemption'));
  assert.ok(commit.indexOf('await _deviceHooks.waitForClaim();') < commit.indexOf('result = await post(call.fn, call.body, { functionsUrl, token });'));
  assert.ok(commit.includes('if (!o.ok && loyaltyCall && result.res?.status === 403 && _deviceHooks.reclaim) {'));
  assert.ok(cr.includes('member_token: String(memberTokenOf(spec))'));
  assert.ok(cr.includes("|| (res.status === 403 && j?.code === 'loyalty_authority'),"), 'a refusal by the fence stays in the replay queue');
});

test('online checkout: the member id from customer.id, the member token to redeem and earn, the summary lookup', () => {
  const online = read('../surfaces/online/OnlineCheckout.jsx');
  assert.ok(online.includes('const memberCustomerId = loyalty?.customer?.id || loyalty?.loyalty?.customer_id || null;'));
  assert.equal((online.match(/loyalty\?\.loyalty\?\.customer_id \|\| null,/g) || []).length, 0, 'nothing reads the missing field alone');
  assert.equal((online.match(/customerId: memberCustomerId,/g) || []).length, 2, 'promo and loyalty commits');
  assert.ok(online.includes('customer_id: memberCustomerId,'), 'promo validate');
  assert.ok(online.includes('memberToken: loyalty?.token || null,\n    }, { functionsUrl: FUNCTIONS_URL'), 'redeem carries the member token');
  assert.equal((online.match(/memberToken: loyalty\?\.token \|\| null,\n {8}memberCustomerId,/g) || []).length, 2, 'both earn paths');
  assert.ok(online.includes('/loyalty-balance?view=summary&phone='));
  assert.ok(!/\?\.member_code/.test(online), 'nothing reads member_code off the prompt lookup');
  const cl = read('./customerLookup.js');
  assert.ok(cl.includes('...(memberToken && memberCustomerId && memberCustomerId === customerId ? { member_token: String(memberToken) } : {}),'));
  assert.ok(cl.includes('+ `&location_id=${encodeURIComponent(locId)}`;'), 'the till lookup names its venue');
  assert.ok(cl.includes('authToken ? { headers: { authorization: `Bearer ${authToken}` } } : undefined'), 'and sends its session');
  assert.ok(read('../backoffice/sections/Customers.jsx').includes('location_id: body?.location_id || getActiveLocationSync() || undefined'), 'Back Office customer cards send the venue');
});

test('attributeOnlineOrder never inserts a null customer name', () => {
  const src = read('./customerLookup.js');
  const fn = src.slice(src.indexOf('export async function attributeOnlineOrder'));
  const insert = fn.slice(fn.indexOf(".from('customers')\n        .insert("), fn.indexOf(".select('id').maybeSingle();"));
  assert.ok(insert.includes("name: typeof name === 'string' ? name.trim() : '',"));
  assert.ok(fn.includes('customerId = again.id;'), 'a lost race re reads the row');
});

test('a failed gift card reversal tells staff what they can actually do', () => {
  const m = giftReversalFailedMessage({ code_last4: '1234', applied: 1250 }, 'Only staff or a paired till can do this', (x) => `£${(x / 100).toFixed(2)}`);
  assert.equal(m, 'Gift card ending 1234: £12.50 NOT put back on the card (Only staff or a paired till can do this). Give the customer that amount another way, or issue them a new gift card for it in Back Office, Gift cards, Issue card.');
  assert.ok(!/[\u2013\u2014]/.test(m));
  const store = read('../store/index.js');
  assert.ok(!store.includes('check the balance in Back Office'));
  assert.equal((store.match(/giftReversalFailedMessage\(leg, r\.error \|\| 'reversal failed'/g) || []).length, 2, 'refund and cancelled card machine job');
});
