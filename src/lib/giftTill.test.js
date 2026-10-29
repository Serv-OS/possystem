// src/lib/giftTill.test.js
//
// Drop C (v5.11.118, 29 Oct 2026): selling gift cards at the till, the server side.
//   1. The pure rules gift-load applies (supabase/functions/_shared/giftTill.js): every
//      loadDecision branch, the code gate, the idempotency helper, the status list.
//   2. Wiring: gift-bulk-create makes blank cards, gift-issue lets a paired till print a card
//      (channel 'pos') and hands back the code, gift-load exists with both actions, the Platform
//      migration adds the three words and relaxes the amount check, the rollback reverses them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadDecision, isGiftCardCode, cleanGiftCardCode, isLoadAmount, loadIdempotencyKey, existingLoad,
  loadRefusalStatus, cardsForCheck,
  GIFT_STATUS_BLANK, GIFT_TX_LOAD, GIFT_SOURCE_POS, GIFT_CHANNEL_POS,
} from '../../supabase/functions/_shared/giftTill.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const fnSrc = (name) => code(read(`../../supabase/functions/${name}/index.ts`));

const C1 = 'c1111111-1111-1111-1111-111111111111';
const C2 = 'c2222222-2222-2222-2222-222222222222';
const blank = { id: 'card-b', company_id: C1, status: 'blank', initial_amount_minor: 0, balance_minor: 0, expires_at: null };
const active = { id: 'card-a', company_id: C1, status: 'active', initial_amount_minor: 2000, balance_minor: 1250, expires_at: null };

// ══ 1. Constants ═══════════════════════════════════════════════════════════
test('the words the migration adds are the words the function writes', () => {
  assert.equal(GIFT_STATUS_BLANK, 'blank');
  assert.equal(GIFT_TX_LOAD, 'load');
  assert.equal(GIFT_SOURCE_POS, 'pos');
  assert.equal(GIFT_CHANNEL_POS, 'pos');
});

// ══ 2. The code gate ════════════════════════════════════════════════════════
test('isGiftCardCode: 16 letters or digits after stripping spaces and dashes, any alphabet', () => {
  assert.ok(isGiftCardCode('ABCDEFGHJKLMNPQR'));
  assert.ok(isGiftCardCode('ABCD EFGH JKLM NPQR'), 'spaces (the slip format)');
  assert.ok(isGiftCardCode('abcd-efgh-jklm-npqr'), 'dashes and lower case');
  assert.ok(isGiftCardCode('C24689C27769AA08'), 'hex with 0 and 1 (imported or seeded)');
  assert.equal(isGiftCardCode('ABCDEFGHJKLMNPQ'), false, '15 is too short');
  assert.equal(isGiftCardCode('ABCDEFGHJKLMNPQRS'), false, '17 is too long');
  assert.equal(isGiftCardCode('SUMMER10'), false, 'a promo code');
  assert.equal(isGiftCardCode('ABCD!FGHJKLMNPQR'), false, 'punctuation');
  assert.equal(isGiftCardCode(''), false);
  assert.equal(isGiftCardCode(null), false);
  assert.equal(isGiftCardCode(1234567890123456), false, 'a number is not a code');
  assert.equal(cleanGiftCardCode(' ab-cd ef '), 'ABCDEF');
});

test('isLoadAmount: a positive whole number of minor units', () => {
  assert.ok(isLoadAmount(1));
  assert.ok(isLoadAmount(2500));
  assert.equal(isLoadAmount(0), false);
  assert.equal(isLoadAmount(-500), false);
  assert.equal(isLoadAmount(12.5), false);
  assert.equal(isLoadAmount('2500'), false);
  assert.equal(isLoadAmount(NaN), false);
  assert.equal(isLoadAmount(Infinity), false);
});

// ══ 3. loadDecision, every branch ══════════════════════════════════════════
test('a blank card becomes active with exactly the amount', () => {
  assert.deepEqual(loadDecision(blank, 2500, { companyId: C1 }), { ok: true, mode: 'activate', balanceAfter: 2500 });
});

test('an active card is topped up: balance + amount', () => {
  assert.deepEqual(loadDecision(active, 2500, { companyId: C1 }), { ok: true, mode: 'topup', balanceAfter: 3750 });
});

test('an active card with a future expiry still tops up; a past expiry is refused as expired', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  const future = { ...active, expires_at: '2027-01-01T00:00:00Z' };
  const past = { ...active, expires_at: '2026-01-01T00:00:00Z' };
  assert.equal(loadDecision(future, 100, { companyId: C1, now }).ok, true);
  const r = loadDecision(past, 100, { companyId: C1, now });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
});

test('missing card: not_found', () => {
  const r = loadDecision(null, 2500, { companyId: C1 });
  assert.deepEqual(r, { ok: false, reason: 'not_found', message: 'Card not found' });
  assert.equal(loadDecision(undefined, 2500).reason, 'not_found');
});

test('a card of another company is "not found" (never says the card exists)', () => {
  const r = loadDecision({ ...blank, company_id: C2 }, 2500, { companyId: C1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'other_company');
  assert.equal(r.message, 'Card not found');
  assert.equal(loadRefusalStatus(r.reason), 404);
});

test('voided, expired and redeemed cards are refused with a plain message', () => {
  for (const [status, reason] of [['voided', 'voided'], ['expired', 'expired'], ['redeemed', 'redeemed']]) {
    const r = loadDecision({ ...active, status }, 2500, { companyId: C1 });
    assert.equal(r.ok, false, status);
    assert.equal(r.reason, reason);
    assert.ok(typeof r.message === 'string' && r.message.length > 10, `${status} has a message`);
    assert.equal(loadRefusalStatus(r.reason), 409);
  }
});

test('an amount of 0, a negative, a fraction or a string is refused before any status is looked at', () => {
  for (const bad of [0, -100, 12.5, '2500', null, undefined, NaN]) {
    const r = loadDecision(blank, bad, { companyId: C1 });
    assert.equal(r.ok, false, String(bad));
    assert.equal(r.reason, 'bad_amount');
    assert.equal(loadRefusalStatus(r.reason), 400);
  }
});

test('an unknown status is refused, never loaded', () => {
  const r = loadDecision({ ...active, status: 'pending' }, 100, { companyId: C1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_status');
});

test('the order of refusals: company before amount before status', () => {
  assert.equal(loadDecision({ ...active, company_id: C2, status: 'voided' }, 0, { companyId: C1 }).reason, 'other_company');
  assert.equal(loadDecision({ ...active, status: 'voided' }, 0, { companyId: C1 }).reason, 'bad_amount');
});

test('no companyId given: the company check is skipped (the function always passes one)', () => {
  assert.equal(loadDecision(blank, 100).ok, true);
});

// ══ 4. Idempotency as a pure helper ════════════════════════════════════════
test('the load key is one per check and card', () => {
  assert.equal(loadIdempotencyKey('chk-1', 'card-a'), 'giftload:chk-1:card-a');
  assert.notEqual(loadIdempotencyKey('chk-1', 'card-a'), loadIdempotencyKey('chk-2', 'card-a'));
  assert.notEqual(loadIdempotencyKey('chk-1', 'card-a'), loadIdempotencyKey('chk-1', 'card-b'));
});

test('existingLoad finds the load this check already made and ignores everything else', () => {
  const rows = [
    { type: 'issue', card_id: 'card-a', order_id: 'chk-1', amount_minor: 2000 },
    { type: 'load', card_id: 'card-a', order_id: 'chk-0', amount_minor: 500, idempotency_key: 'giftload:chk-0:card-a' },
    { type: 'load', card_id: 'card-a', order_id: 'chk-1', amount_minor: 2500, idempotency_key: 'giftload:chk-1:card-a', balance_after_minor: 3750 },
    { type: 'load', card_id: 'card-b', order_id: 'chk-1', amount_minor: 1000, idempotency_key: 'giftload:chk-1:card-b' },
    { type: 'redeem', card_id: 'card-a', order_id: 'chk-1', amount_minor: -100 },
  ];
  const hit = existingLoad(rows, 'chk-1', 'card-a');
  assert.equal(hit.amount_minor, 2500);
  assert.equal(hit.balance_after_minor, 3750);
  assert.equal(existingLoad(rows, 'chk-9', 'card-a'), null, 'a new check loads again');
  assert.equal(existingLoad(rows, 'chk-1', 'card-c'), null, 'another card for the same check');
  assert.equal(existingLoad([], 'chk-1', 'card-a'), null);
  assert.equal(existingLoad(null, 'chk-1', 'card-a'), null);
});

test('existingLoad matches by key alone when the order id was stored differently', () => {
  const rows = [{ type: 'load', card_id: 'card-a', order_id: null, idempotency_key: 'giftload:chk-1:card-a', amount_minor: 1 }];
  assert.ok(existingLoad(rows, 'chk-1', 'card-a'));
});

// ══ 5. status: the cards of a check ═════════════════════════════════════════
test('cardsForCheck lists issue and load rows with the card last 4 and live balance, newest first', () => {
  const rows = [
    { type: 'load', card_id: 'card-a', amount_minor: 2500, balance_after_minor: 3750, created_at: '2026-10-29T10:00:00Z', gift_cards: { code_last4: 'NPQR', balance_minor: 3700, status: 'active' } },
    { type: 'issue', card_id: 'card-n', amount_minor: 1000, balance_after_minor: 1000, created_at: '2026-10-29T10:05:00Z', gift_cards: { code_last4: 'WXYZ', balance_minor: 1000, status: 'active' } },
    { type: 'redeem', card_id: 'card-a', amount_minor: -50, created_at: '2026-10-29T10:06:00Z', gift_cards: { code_last4: 'NPQR' } },
  ];
  const out = cardsForCheck(rows);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.card_id), ['card-n', 'card-a']);
  assert.equal(out[1].type, 'load');
  assert.equal(out[1].amount_minor, 2500);
  assert.equal(out[1].balance_minor, 3700, 'the live card balance, not the balance at load time');
  assert.equal(out[1].code_last4, 'NPQR');
  assert.equal(out[0].type, 'issue');
  assert.deepEqual(cardsForCheck([]), []);
  assert.deepEqual(cardsForCheck(null), []);
});

test('cardsForCheck falls back to the ledger balance when the card join is missing', () => {
  const out = cardsForCheck([{ type: 'load', card_id: 'x', amount_minor: 500, balance_after_minor: 500, gift_cards: null }]);
  assert.equal(out[0].balance_minor, 500);
  assert.equal(out[0].code_last4, null);
});

// ══ 6. Wiring ═══════════════════════════════════════════════════════════════
test('gift-bulk-create: blank: true makes 0 value blank cards with no ledger row, and still needs staff', () => {
  const src = fnSrc('gift-bulk-create');
  assert.ok(src.includes("const blank = (body as any).blank === true;"), 'reads blank');
  assert.ok(src.includes("const amountMinor = blank ? 0 : Math.round(Number(amount));"), 'no amount when blank');
  assert.ok(src.includes("status: blank ? 'blank' : 'active',"), 'status blank');
  assert.ok(src.includes("source: 'bulk',"), 'source stays bulk');
  assert.ok(src.includes('if (blank) {\n        results.push({ code: formatCode(code), code_last4: last4, card_id: card.id });\n        continue;\n      }'), 'no issue row for a blank card');
  assert.ok(src.includes("requireStaff({\n    fn: 'gift-bulk-create'"), 'still staff only');
  assert.ok(src.indexOf('requireStaff({') < src.indexOf("from('gift_cards')"), 'gate before any card write');
  assert.ok(src.includes('blank,\n  });'), 'the reply says whether the batch was blank');
});

test('gift-issue: channel pos goes through callerStaffOrDevice, marks the card pos, names the check, returns the code and balance page', () => {
  const src = fnSrc('gift-issue');
  assert.ok(src.includes("import { requireStaff, callerStaffOrDevice, recordAuthority, deviceHintOf } from '../_shared/loyalty-utils.ts';"));
  assert.ok(src.includes("import { decideGiftTillAuthority } from '../_shared/gift-authority.ts';"));
  assert.ok(src.includes("const isTill = channel === 'pos';"));
  assert.ok(src.includes("if (isTill && !location_id) return json({ error: 'location_id required for a till issue' }, 400);"));
  assert.ok(src.includes("const who = await callerStaffOrDevice(caller, (location_id as string) || null, String(companyId));"));
  assert.ok(src.includes("decideGiftTillAuthority({ user: caller, staff: who.staff, device: who.device, deviceReason: who.deviceReason }, 'issue gift cards at the till')"));
  assert.ok(src.includes("const refused = isTill ? await tillRefusal() : await requireStaff({\n    fn: 'gift-issue'"), 'Back Office stays staff only');
  assert.ok(src.includes('if (refused) return refused;'));
  assert.ok(src.indexOf('const refused = isTill') < src.indexOf("from('gift_brand_config')"), 'gate before any read');
  assert.ok(src.includes("...(isTill ? { source: 'pos' } : {}),"), 'source pos only for the till');
  assert.ok(src.includes('issued_at_location_id: location_id || null,'));
  assert.ok(src.includes("order_id: isTill ? String(closed_check_id) : null,"), 'the issue row names the check');
  assert.ok(src.includes('staff_id: staff_id || null,'));
  assert.ok(src.includes('code: formatCode(code),'), 'the plain code for the slip');
  assert.ok(src.includes('code_last4: last4,'));
  assert.ok(src.includes('balance_minor: amountMinor,'));
  assert.ok(src.includes('balance_url: balanceUrl,'));
  assert.ok(src.includes('`https://${data.online_slug}.serv-os.app/gift/balance`'), 'the public balance page');
  assert.ok(src.includes('const balanceUrl = isTill ? await balanceUrlFor((location_id as string) || null) : null;'), 'Back Office gets null');
});

test('gift-load: exists, gate before any read, both actions, the pure rules, one load per check and card', () => {
  const src = fnSrc('gift-load');
  assert.ok(src.includes("from '../_shared/giftTill.js'"), 'uses the pure rules');
  for (const name of ['loadDecision', 'isGiftCardCode', 'loadIdempotencyKey', 'existingLoad', 'loadRefusalStatus', 'cardsForCheck']) {
    assert.ok(src.includes(name + '('), `calls ${name}`);
  }
  assert.ok(src.includes("if (action !== 'load' && action !== 'status')"), 'two actions');
  assert.ok(src.includes("if (action === 'status') {"));
  assert.ok(src.includes("const who = await callerStaffOrDevice(caller, location_id, companyId);"));
  assert.ok(src.includes("decideGiftTillAuthority({ user: caller, staff: who.staff, device: who.device, deviceReason: who.deviceReason }, 'load gift cards')"));
  const gate = src.indexOf('const who = await callerStaffOrDevice(');
  for (const later of ["from('gift_card_transactions')", "from('gift_brand_config')", "from('gift_cards')"]) {
    assert.ok(src.indexOf(later) > gate, `${later} after the gate`);
  }
  assert.ok(src.includes("if (!isGiftCardCode(code)) return json({ error: 'Enter the full 16 character gift card code.', code: 'bad_code' }, 400);"));
  assert.ok(src.includes(".eq('code_lookup', lookup)\n    .eq('company_id', companyId)"), 'HMAC lookup within the company');
  assert.ok(src.includes(".eq('code_plain', normalized)\n      .eq('company_id', companyId)"), 'code_plain fallback within the company');
  assert.ok(src.includes("if (!card) return json({ error: 'Card not found', code: 'not_found' }, 404);"));
  assert.ok(src.indexOf('const prior = existingLoad(') < src.indexOf('const decision = loadDecision('), 'already loaded is answered before the rules');
  assert.ok(src.includes('if (prior) return loadReply(card, prior, true);'), 'a second call returns the first result');
  assert.ok(src.includes('type: GIFT_TX_LOAD,'));
  assert.ok(src.includes('channel: GIFT_CHANNEL_POS,'));
  assert.ok(src.includes('order_id: closedCheckId,'));
  assert.ok(src.includes('idempotency_key: idemKey,'), 'the ledger row is the claim');
  assert.ok(src.includes("if (txErr?.code === '23505')"), 'a racing load reads the winner');
  assert.ok(src.includes('patch.initial_amount_minor = amountMinor;'), 'activation sets the initial amount');
  assert.ok(src.includes('patch.issued_at = nowIso;'));
  assert.ok(src.includes('patch.issued_at_location_id = location_id;'));
  assert.ok(src.includes(".eq('balance_minor', cur.balance_minor)"), 'compare and swap');
  assert.ok(src.includes("...(already ? { already: true } : {}),"));
  assert.ok(src.includes("in('type', ['issue', GIFT_TX_LOAD])"), 'status lists issues and loads of the check');
  assert.ok(src.includes("cards: cardsForCheck(rows)"));
});

test('gift-authority: the till arm is staff or a bound device, never an unbound session', async () => {
  const { decideGiftTillAuthority } = await import('../../supabase/functions/_shared/gift-authority.ts');
  const staff = { id: 'u1', is_anonymous: false };
  const till = { id: 'd1', is_anonymous: true };
  assert.deepEqual(decideGiftTillAuthority({ user: staff, staff: true, device: false }), { ok: true, via: 'staff' });
  assert.deepEqual(decideGiftTillAuthority({ user: till, staff: false, device: true }), { ok: true, via: 'device' });
  const unbound = decideGiftTillAuthority({ user: till, staff: false, device: false, deviceReason: 'not_bound' });
  assert.equal(unbound.ok, false);
  assert.equal(unbound.status, 403);
  assert.equal(unbound.reason, 'device_not_bound');
  const other = decideGiftTillAuthority({ user: till, staff: false, device: false, deviceReason: 'other_venue' }, 'load gift cards');
  assert.equal(other.reason, 'device_other_venue');
  assert.match(other.error, /load gift cards/);
  assert.equal(decideGiftTillAuthority({ user: { id: 'u2', is_anonymous: false }, staff: false, device: false }).reason, 'no_location_access');
  assert.equal(decideGiftTillAuthority({ user: null, staff: false, device: false }).status, 401);
  assert.equal(decideGiftTillAuthority({ user: { id: 'a', is_anonymous: true }, staff: true, device: false }).ok, false, 'an anonymous session is never staff');
});

test('the Platform migration adds blank, pos and load and lets a card start at 0; the rollback reverses every one', () => {
  const up = read('../../supabase/migrations/20261108a_PLATFORM_gift_till.sql');
  assert.ok(up.includes('check (initial_amount_minor >= 0)'), 'amount check relaxed');
  assert.ok(up.includes("'expired'::text, 'blank'::text]"), 'status adds blank');
  assert.ok(up.includes("'import'::text, 'pos'::text]"), 'source adds pos');
  assert.ok(up.includes("'void'::text, 'load'::text]"), 'type adds load');
  for (const kept of ["'active'::text", "'redeemed'::text", "'voided'::text", "'manual'::text", "'online'::text", "'bulk'::text", "'issue'::text", "'redeem'::text", "'refund'::text"]) {
    assert.ok(up.includes(kept), `keeps ${kept}`);
  }
  assert.ok(up.includes('-- VERIFY (read only):'), 'verify block');
  assert.doesNotMatch(up, /\b(grant|revoke)\b/i, 'no new grants');
  assert.doesNotMatch(up, /create policy/i, 'no new policies');

  const down = read('../../supabase/migrations/20261108a_PLATFORM_gift_till_ROLLBACK.sql');
  assert.ok(down.includes('check (initial_amount_minor > 0)'));
  assert.ok(down.includes("'voided'::text, 'expired'::text]))"), 'status without blank');
  assert.ok(!down.includes("'blank'::text]"), 'rollback drops blank from the list');
  assert.ok(down.includes("'bulk'::text, 'import'::text]))"), 'source without pos');
  assert.ok(!down.includes("'pos'::text]"));
  assert.ok(down.includes("'refund'::text, 'void'::text]))"), 'type without load');
  assert.ok(!down.includes("'load'::text]"));
  assert.ok(down.includes("where status = 'blank' or source = 'pos' or initial_amount_minor = 0"), 'refuses while new rows exist');
  assert.ok(down.includes("where type = 'load'"));
});

test('Back Office bulk create offers blank cards for the till', () => {
  const src = readFileSync(new URL('../backoffice/sections/GiftCards.jsx', import.meta.url), 'utf8');
  assert.ok(src.includes('Blank cards for the POS'), 'Peter: it is the POS, not the till');
  assert.ok(src.includes('...(batchId ? { batch_id: batchId } : {})') && src.includes('const next = Number(res.remaining ?? 0);'), 'Back Office keeps calling until the batch is done');
  assert.ok(src.includes('...(blank ? { blank: true } : {})'), 'sends blank: true to gift-bulk-create');
  assert.ok(src.includes("const amountMinor = blank ? 0 : Math.round(parseFloat(amount) * 100);"));
});

test('bulk create makes at most 20 cards a call and answers remaining, so a big batch never hits the time limit', () => {
  const src = readFileSync(new URL('../../supabase/functions/gift-bulk-create/index.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('const PER_CALL = 20;') && src.includes('const todo = Math.min(qty, PER_CALL);'));
  assert.ok(src.includes('for (let i = 0; i < todo; i++) {'), 'the loop runs todo, not qty');
  assert.ok(src.includes('remaining: Math.max(0, qty - todo)'));
  assert.ok(src.includes("(body as any).batch_id ? String((body as any).batch_id) : crypto.randomUUID()"), 'a continued batch keeps its id');
});
