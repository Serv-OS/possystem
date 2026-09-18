// Loyalty endpoints handed out gift card codes (spendable money) to people who did not own them,
// and loyalty-redeem let any anonymous session spend anybody's points (audit, 18 Sep 2026).
// These tests pin every fix. The edge functions cannot run under node (Deno.serve, esm.sh), so
// their decisions live in pure _shared modules tested here directly, and the wiring is pinned by
// reading the function source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  phoneMatchVariants, giftCardRecipientFilter, memberGiftCards, MEMBER_GIFT_CARD_COLUMNS,
} from '../../supabase/functions/_shared/giftCardMatch.ts';
import { createSessionToken, verifySessionToken, SESSION_TTL_MS } from '../../supabase/functions/_shared/loyalty-session.ts';
import { decideRedeemAuthority } from '../../supabase/functions/_shared/loyalty-authority.ts';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// ── 1. Public loyalty-balance ────────────────────────────────────────────────
test('loyalty-balance (public, by phone) never reads or returns a gift card code, id or name match', () => {
  const src = code(read('../../supabase/functions/loyalty-balance/index.ts'));
  assert.ok(!src.includes('code_plain'), 'never selects code_plain');
  assert.ok(!src.includes('recipient_name'), 'never matches a card by name');
  assert.ok(!src.includes('recipient_email'), 'never matches a card by email');
  assert.ok(!src.includes("from('gift_cards')"), 'does not query gift_cards at all');
  assert.ok(/const giftCards: never\[\] = \[\];/.test(src), 'gift_cards is always an empty list');
  assert.ok(src.includes('gift_cards: giftCards,'), 'the key stays in the reply for older clients');
});

// ── 2. Signed in portal: proven phone only ───────────────────────────────────
const ALICE = '+447700900001';
const rows = [
  // Addressed to Alice's proven phone (stored both ways).
  { id: 'a1', code_last4: '1111', code_plain: 'AAAA1111AAAA1111', balance_minor: 2500, initial_amount_minor: 2500, recipient_phone: ALICE, recipient_name: 'Sam Smith', recipient_email: 'alice@example.com' },
  { id: 'a2', code_last4: '2222', code_plain: 'AAAA2222AAAA2222', balance_minor: 1000, initial_amount_minor: 1000, recipient_phone: '07700900001', recipient_name: 'Alice' },
  // Somebody else called Sam Smith: same NAME as the member, different phone.
  { id: 'b1', code_last4: '9999', code_plain: 'BBBB9999BBBB9999', balance_minor: 5000, initial_amount_minor: 5000, recipient_phone: '+447700900999', recipient_name: 'Sam Smith' },
  // Somebody whose EMAIL the member typed into their profile, unverified.
  { id: 'c1', code_last4: '8888', code_plain: 'CCCC8888CCCC8888', balance_minor: 7000, initial_amount_minor: 7000, recipient_phone: null, recipient_email: 'victim@example.com' },
];

test('a member named like somebody else never sees that person\'s card', () => {
  const seen = memberGiftCards(rows, ALICE).map((c) => c.id);
  assert.deepEqual(seen.sort(), ['a1', 'a2']);
  assert.ok(!seen.includes('b1'));
});

test('an unverified email never surfaces a card', () => {
  const seen = memberGiftCards(rows, ALICE).map((c) => c.id);
  assert.ok(!seen.includes('c1'));
  // Without a proven phone there are no cards at all, whatever else the row matched.
  assert.deepEqual(memberGiftCards(rows, null), []);
  assert.deepEqual(memberGiftCards(rows, ''), []);
});

test('the gift card filter matches the proven phone only, in both UK forms, and refuses junk', () => {
  assert.equal(giftCardRecipientFilter(ALICE), 'recipient_phone.eq.+447700900001,recipient_phone.eq.07700900001');
  assert.equal(giftCardRecipientFilter('07700900001'), 'recipient_phone.eq.07700900001,recipient_phone.eq.+447700900001');
  assert.equal(giftCardRecipientFilter(null), null);
  assert.equal(giftCardRecipientFilter('x,recipient_name.eq.Sam'), null, 'no filter injection');
  assert.deepEqual(phoneMatchVariants('+1 555'), []);
  assert.ok(MEMBER_GIFT_CARD_COLUMNS.includes('recipient_phone'), 'rows carry the phone for the row by row check');
});

test('the member keeps the full code of their OWN card (portal spends it online)', () => {
  const [card] = memberGiftCards([rows[0]], ALICE);
  assert.deepEqual(card, { id: 'a1', last4: '1111', code: 'AAAA1111AAAA1111', balance: 2500, initial: 2500, expires_at: null });
});

test('loyalty-otp verify and refresh match gift cards on the proven phone only', () => {
  const src = code(read('../../supabase/functions/loyalty-otp/index.ts'));
  assert.ok(!src.includes('recipient_name'), 'no name matching');
  assert.ok(!src.includes('recipient_email'), 'no email matching');
  assert.ok(src.includes('giftCardsForProvenPhone(companyId, phone)'), 'verify uses the phone Twilio approved');
  assert.ok(src.includes('const provenPhone = session.phone || cust?.phone || null;'), 'refresh uses the phone on the token');
  assert.ok(src.includes('createSessionToken(customer.id, companyId, phone)'), 'the token carries the proven phone');
  // update_profile may change email, but nothing reads the email for gift cards any more.
  assert.ok(!/gift_cards[\s\S]{0,400}email/.test(src.slice(src.indexOf('async function giftCardsForProvenPhone'), src.indexOf('// ── Phone normalisation'))));
});

test('loyalty-member-lookup (any session) returns neither card ids nor email matches', () => {
  const src = code(read('../../supabase/functions/loyalty-member-lookup/index.ts'));
  assert.ok(!src.includes('recipient_email'), 'no email matching');
  assert.ok(!src.includes('code_plain'), 'no codes');
  const block = src.slice(src.indexOf('giftCardRecipientFilter(customer.phone)'), src.indexOf('Gift card lookup is non-critical'));
  assert.ok(!/\bid: c\.id\b/.test(block), 'no card id (gift-redeem spends by id)');
});

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
  const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))).toString('hex');
  assert.deepEqual(await verifySessionToken(btoa(payload) + '.' + sig, secret, now), { customerId: 'cust-1', companyId: 'co-1', phone: null });
});

// ── 4a. loyalty-redeem authority ─────────────────────────────────────────────
const base = { customerId: 'cust-1', companyId: 'co-1', memberTokenSent: false, memberSession: null, staffHasLocation: false, deviceCompanyId: null };
const anon = { id: 'u-anon', is_anonymous: true };

test('a bare anonymous session cannot spend anybody\'s points', () => {
  const r = decideRedeemAuthority({ ...base, user: anon });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(decideRedeemAuthority({ ...base, user: null }).status, 401);
});

test('a paired device may redeem for members of its own company only', () => {
  assert.deepEqual(decideRedeemAuthority({ ...base, user: anon, deviceCompanyId: 'co-1' }), { ok: true, via: 'device' });
  assert.equal(decideRedeemAuthority({ ...base, user: anon, deviceCompanyId: 'co-2' }).ok, false);
});

test('a Back Office user with the location may redeem; an anonymous "staff" claim may not', () => {
  assert.deepEqual(decideRedeemAuthority({ ...base, user: { id: 'u1', is_anonymous: false }, staffHasLocation: true }), { ok: true, via: 'staff' });
  assert.equal(decideRedeemAuthority({ ...base, user: anon, staffHasLocation: true }).ok, false);
});

test('the member may redeem their OWN rewards with their token, never somebody else\'s', () => {
  const own = { ...base, user: anon, memberTokenSent: true, memberSession: { customerId: 'cust-1', companyId: 'co-1' } };
  assert.deepEqual(decideRedeemAuthority(own), { ok: true, via: 'member' });
  assert.equal(decideRedeemAuthority({ ...own, customerId: 'cust-2' }).ok, false, 'other customer');
  assert.equal(decideRedeemAuthority({ ...own, companyId: 'co-2' }).ok, false, 'other company');
  assert.equal(decideRedeemAuthority({ ...own, memberSession: null }).ok, false, 'expired or forged token');
  // A bad token never falls through to a device arm.
  assert.equal(decideRedeemAuthority({ ...own, memberSession: null, deviceCompanyId: 'co-1' }).ok, false);
});

test('loyalty-redeem decides authority before it reads or moves any balance', () => {
  const src = code(read('../../supabase/functions/loyalty-redeem/index.ts'));
  const fence = src.indexOf('decideRedeemAuthority({');
  assert.ok(fence > 0);
  assert.ok(src.indexOf('if (!authority.ok)') > fence);
  for (const later of ["from('customer_stamp_cards')", "from('customer_loyalty')", "rpc('loyalty_redeem_points'", "from('stamp_transactions')"]) {
    assert.ok(src.indexOf(later) > fence, `${later} comes after the fence`);
  }
});

test('every caller of loyalty-redeem still carries an authority the fence accepts', () => {
  const cr = read('./commitRedemptions.js');
  assert.ok(cr.includes('member_token: String(spec.memberToken)'), 'commitRedemptions forwards the member token');
  const online = read('../surfaces/online/OnlineCheckout.jsx');
  assert.ok(online.includes('memberToken: loyalty?.token || null,'), 'online sends the member token');
  // The kiosk (submitOrder is frozen by the card path guard) and the till rely on their claimed
  // device: claim_device stamps devices.device_uid at pairing (kiosk) and on every boot (till).
  // A kiosk taking Adyen or Ryft cards already needs that claim (terminal-job-create fences on it).
  assert.ok(read('../surfaces/KioskSurface.jsx').includes("supabase.rpc('claim_device'"), 'kiosks claim their device at pairing');
  assert.ok(read('./supabase.js').includes("supabase.rpc('claim_device'"), 'tills claim their device on boot');
});

// ── 4b. attributeOnlineOrder ─────────────────────────────────────────────────
test('attributeOnlineOrder never inserts a null customer name', () => {
  const src = read('./customerLookup.js');
  const fn = src.slice(src.indexOf('export async function attributeOnlineOrder'));
  const insert = fn.slice(fn.indexOf(".from('customers')\n        .insert("), fn.indexOf(".select('id').maybeSingle();"));
  assert.ok(insert.length > 0);
  assert.ok(!/name:\s*name\s*\|\|\s*null/.test(insert), 'no name || null');
  assert.ok(insert.includes("name: typeof name === 'string' ? name.trim() : '',"), 'empty name instead');
  assert.ok(fn.includes('if (insErr) {') && fn.includes('customerId = again.id;'), 'the insert error is checked and a lost race re reads the row');
});

// ── 4c. Online reads the member id from where verify puts it ─────────────────
test('online checkout takes the member id from customer.id (verify\'s loyalty block has none)', () => {
  const otp = code(read('../../supabase/functions/loyalty-otp/index.ts'));
  const loyaltyBlock = otp.slice(otp.indexOf('loyalty: loyaltyData ? {'), otp.indexOf('gift_cards: giftCards,'));
  assert.ok(!loyaltyBlock.includes('customer_id'), 'verify\'s loyalty block really has no customer_id');
  assert.ok(otp.includes('id: customer.id,'), 'verify sends customer.id');

  const online = read('../surfaces/online/OnlineCheckout.jsx');
  assert.ok(online.includes('const memberCustomerId = loyalty?.customer?.id || loyalty?.loyalty?.customer_id || null;'));
  assert.equal((online.match(/loyalty\?\.loyalty\?\.customer_id \|\| null,/g) || []).length, 0, 'no call site reads the missing field alone');
  assert.equal((online.match(/customerId: memberCustomerId,/g) || []).length, 2, 'promo and loyalty commits');
  assert.ok(online.includes('customer_id: memberCustomerId,'), 'promo validate');
});
