// Round two of the 18 Sep 2026 loyalty and gift card audit. Pins every rule:
//   1. gift-list, gift-lookup search and gift-redeem by card_id are fenced NOW (staff or code holders)
//   2. loyalty-earn, loyalty-refund and loyalty-redeem apply one authority rule, REPORT FIRST
//      (LOYALTY_AUTHORITY_MODE, default report: allow everything, record what enforce would refuse)
//   3. loyalty-member-lookup and loyalty-balance give full detail only with authority
//   4. a member's gift cards are matched on NORMALISED phones ('07931 123 456' still reaches them)
//   5. a parked redemption replays after its member token expires; the kiosk re-claims its device
// Edge functions cannot run under node (Deno.serve, esm.sh), so their decisions live in pure
// _shared modules tested here, and the wiring is pinned by reading the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  decideLoyaltyAuthority, decideRedeemAuthority, loyaltyAuthorityMode, applyAuthorityMode, authorityLogRow,
} from '../../supabase/functions/_shared/loyalty-authority.ts';
import {
  createSessionToken, verifySessionToken, inspectSessionToken, memberTokenCoversCheck, SESSION_TTL_MS,
} from '../../supabase/functions/_shared/loyalty-session.ts';
import {
  normaliseMemberPhone, giftCardRecipientFilter, memberGiftCards, cardBelongsToPhone,
} from '../../supabase/functions/_shared/giftCardMatch.ts';
import {
  classifyGiftLookup, decideGiftLookupAuthority, decideGiftListAuthority, decideGiftCardIdAuthority,
  codeHolderView, isFullGiftCode,
} from '../../supabase/functions/_shared/gift-authority.ts';
import { limitedMemberReply, LIMITED_MEMBER_KEYS } from '../../supabase/functions/_shared/memberReply.ts';
import { setActiveMemberSession, memberTokenFor, activeMemberToken, MEMBER_GRACE_MS } from './memberSession.js';
import { stageGiftCard, commitGiftCard } from './giftCommit.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const fnSrc = (name) => code(read(`../../supabase/functions/${name}/index.ts`));

const anon = { id: '00000000-0000-4000-8000-00000000a0a0', is_anonymous: true };
const staffUser = { id: '00000000-0000-4000-8000-0000000057af', is_anonymous: false };
const CO = '11111111-1111-4111-8111-111111111111';
const base = { customerId: 'cust-1', companyId: CO, memberTokenSent: false, memberSession: null, staffHasLocation: false, deviceCompanyId: null };

// ── 2. The switch ────────────────────────────────────────────────────────────
test('LOYALTY_AUTHORITY_MODE: only the word "enforce" enforces; unset, blank or a typo is report', () => {
  assert.equal(loyaltyAuthorityMode(undefined), 'report');
  assert.equal(loyaltyAuthorityMode(null), 'report');
  assert.equal(loyaltyAuthorityMode(''), 'report');
  assert.equal(loyaltyAuthorityMode('report'), 'report');
  assert.equal(loyaltyAuthorityMode('enforced'), 'report', 'a typo never starts refusing tills');
  assert.equal(loyaltyAuthorityMode('true'), 'report');
  assert.equal(loyaltyAuthorityMode('enforce'), 'enforce');
  assert.equal(loyaltyAuthorityMode(' Enforce '), 'enforce');
});

// Every kind of caller the fence can meet.
const CASES = [
  { name: 'no session', i: { ...base, user: null } },
  { name: 'anonymous, no device, no token', i: { ...base, user: anon } },
  { name: 'device of another company', i: { ...base, user: anon, deviceCompanyId: 'other-co' } },
  { name: 'signed in user without the location', i: { ...base, user: staffUser } },
  { name: 'expired or forged member token', i: { ...base, user: anon, memberTokenSent: true } },
  { name: 'member token for somebody else', i: { ...base, user: anon, memberTokenSent: true, memberSession: { customerId: 'cust-2', companyId: CO } } },
  { name: 'claimed device', i: { ...base, user: anon, deviceCompanyId: CO }, ok: 'device' },
  { name: 'staff with the location', i: { ...base, user: staffUser, staffHasLocation: true }, ok: 'staff' },
  { name: 'the member themselves', i: { ...base, user: anon, memberTokenSent: true, memberSession: { customerId: 'cust-1', companyId: CO } }, ok: 'member' },
];

test('report mode NEVER refuses anything, and records exactly what enforce would refuse', () => {
  for (const c of CASES) {
    const d = decideLoyaltyAuthority(c.i);
    const r = applyAuthorityMode(d, 'report');
    assert.equal(r.allow, true, `${c.name}: report mode allows`);
    assert.equal(r.record, !c.ok, `${c.name}: recorded only when enforce would refuse`);
    assert.equal(r.outcome, c.ok ? 'allowed' : 'would_refuse', c.name);
  }
});

test('enforce mode refuses every caller without authority and lets the three real ones through', () => {
  for (const c of CASES) {
    const d = decideLoyaltyAuthority(c.i);
    const r = applyAuthorityMode(d, 'enforce');
    assert.equal(r.allow, !!c.ok, c.name);
    if (c.ok) assert.equal(d.via, c.ok, c.name);
    else assert.equal(r.outcome, 'refused', c.name);
  }
});

test('enforce refuses an anonymous caller with no device claim and no member token', () => {
  const d = decideLoyaltyAuthority({ ...base, user: anon });
  assert.equal(d.ok, false);
  assert.equal(d.status, 403);
  assert.equal(d.reason, 'anonymous_no_device');
  assert.equal(d.callerKind, 'anonymous');
  assert.deepEqual(applyAuthorityMode(d, 'enforce'), { allow: false, record: true, outcome: 'refused' });
  assert.equal(decideRedeemAuthority, decideLoyaltyAuthority, 'round one name still exported, same rule');
});

test('the record carries caller kind, company, location and reason, and nothing secret', () => {
  const d = decideLoyaltyAuthority({ ...base, user: anon });
  const row = authorityLogRow({
    fn: 'loyalty-earn', mode: 'report', outcome: 'would_refuse', decision: d, user: anon,
    companyId: CO, locationId: 'loc-1', customerId: 'cust-1', closedCheckId: 'chk-1', channel: 'pos',
  });
  assert.equal(row.fn, 'loyalty-earn');
  assert.equal(row.mode, 'report');
  assert.equal(row.outcome, 'would_refuse');
  assert.equal(row.caller_kind, 'anonymous');
  assert.equal(row.reason, 'anonymous_no_device');
  assert.equal(row.company_id, CO);
  assert.equal(row.location_id, 'loc-1');
  assert.equal(row.caller_id, anon.id);
  assert.equal(row.caller_anonymous, true);
  // Body values are text and clipped; ids must look like ids or they are dropped.
  const junk = authorityLogRow({ fn: 'x', mode: 'report', outcome: 'would_refuse', decision: d, user: { id: 'not-a-uuid' }, companyId: 'drop table', locationId: 'x'.repeat(500) });
  assert.equal(junk.caller_id, null);
  assert.equal(junk.company_id, null);
  assert.equal(junk.location_id.length, 80);
  assert.ok(!('member_token' in row) && !('token' in row) && !('phone' in row) && !('email' in row));
});

test('earn, redeem and refund all run the same fence before reading or moving anything', () => {
  for (const [fn, firstRead] of [
    ['loyalty-earn', "from('loyalty_transactions')"],
    ['loyalty-refund', "from('loyalty_transactions')"],
    ['loyalty-redeem', "from('stamp_card_programs')"],
  ]) {
    const src = fnSrc(fn);
    const fence = src.indexOf(`checkLoyaltyAuthority({\n    fn: '${fn}',`);
    assert.ok(fence > 0, `${fn}: calls checkLoyaltyAuthority with its own name`);
    const stop = src.indexOf('if (!gate.allow) return gate.response!;', fence);
    assert.ok(stop > fence, `${fn}: stops when enforce refuses`);
    assert.ok(src.indexOf(firstRead) > stop, `${fn}: ${firstRead} comes after the fence`);
    assert.ok(/memberToken: /.test(src.slice(fence, stop)), `${fn}: passes the member token`);
    assert.ok(/closedCheckId: closed_check_id/.test(src.slice(fence, stop)) || fn === 'loyalty-member-lookup');
  }
});

test('checkLoyaltyAuthority reads the switch per request, records via the log, and only enforce returns a refusal', () => {
  const src = code(read('../../supabase/functions/_shared/loyalty-utils.ts'));
  assert.ok(src.includes("loyaltyAuthorityMode(Deno.env.get('LOYALTY_AUTHORITY_MODE'))"));
  const body = src.slice(src.indexOf('export async function checkLoyaltyAuthority'));
  assert.ok(body.includes('const applied = applyAuthorityMode(decision, mode);'));
  assert.ok(body.includes('if (applied.record) {') && body.includes('await recordAuthority(authorityLogRow({'));
  assert.ok(body.includes('if (!applied.allow && !decision.ok) {'), 'only a refusal under enforce stops the call');
  assert.ok(src.includes("from('caller_authority_log').insert(row)"), 'writes to the new table');
  assert.ok(/console\.warn\('\[authority\]', JSON\.stringify\(row\)\)/.test(src), 'and to the function log, before the migration runs');
});

test('the migration creates the log table, service role only', () => {
  const sql = read('../../supabase/migrations/20260918_OPS_caller_authority_log.sql');
  assert.ok(sql.includes('create table if not exists public.caller_authority_log'));
  for (const col of ['fn ', 'mode ', 'outcome ', 'caller_kind ', 'reason ', 'company_id ', 'location_id ', 'channel ']) {
    assert.ok(sql.includes(`  ${col}`), `column ${col.trim()}`);
  }
  assert.ok(sql.includes('enable row level security'));
  assert.ok(sql.includes('revoke all on public.caller_authority_log from anon, authenticated;'));
});

// ── 5a. A parked redemption outlives its member token ────────────────────────
test('an expired member token still counts for the order it was live for, and nothing else', async () => {
  const secret = 's3cret';
  const issued = 1_800_000_000_000;
  const tok = await createSessionToken('cust-1', CO, '+447700900001', secret, issued);
  const later = issued + SESSION_TTL_MS + 3 * 24 * 60 * 60 * 1000; // replayed three days after expiry
  assert.equal(await verifySessionToken(tok, secret, later), null, 'expired for everything normal');
  const t = await inspectSessionToken(tok, secret, later);
  assert.equal(t.expired, true);
  assert.equal(t.issuedAt, issued);
  assert.equal(await inspectSessionToken(tok, 'wrong', later), null, 'a bad signature is never accepted');
  assert.equal(memberTokenCoversCheck(t.issuedAt, issued + 60 * 60 * 1000), true, 'order closed an hour after sign in');
  assert.equal(memberTokenCoversCheck(t.issuedAt, issued + SESSION_TTL_MS + 60 * 60 * 1000), false, 'order closed after the token died');
  assert.equal(memberTokenCoversCheck(t.issuedAt, issued - 60 * 60 * 1000), false, 'order closed before sign in');
  assert.equal(memberTokenCoversCheck(t.issuedAt, NaN), false);
  const src = code(read('../../supabase/functions/_shared/loyalty-utils.ts'));
  const m = src.slice(src.indexOf('export async function memberSessionFor'), src.indexOf('export async function checkLoyaltyAuthority'));
  assert.ok(m.includes(".from('closed_checks').select('closed_at').eq('id', checkId).eq('location_id', locId)"), 'the check is looked up server side, not taken from the caller');
  assert.ok(m.includes('memberTokenCoversCheck(t.issuedAt, Date.parse(chk.closed_at))'));
});

test('a parked redemption body carries the member token and an authority refusal stays retryable', () => {
  const cr = read('./commitRedemptions.js');
  assert.ok(cr.includes('member_token: String(memberTokenOf(spec))'));
  assert.ok(cr.includes("|| (res.status === 403 && j?.code === 'loyalty_authority')"), '403 from the fence is retryable');
  assert.ok(fnSrc('loyalty-redeem').includes('closedCheckId: closed_check_id,'), 'redeem hands the check id to the fence');
});

// ── 1. Gift cards, enforced now ──────────────────────────────────────────────
test('gift-list: a staff Back Office call still works; anonymous and outsiders are refused', () => {
  assert.deepEqual(decideGiftListAuthority({ user: staffUser, staff: true }), { ok: true });
  const a = decideGiftListAuthority({ user: anon, staff: false });
  assert.equal(a.ok, false); assert.equal(a.status, 403);
  assert.equal(decideGiftListAuthority({ user: anon, staff: true }).ok, false, 'an anonymous session is never staff');
  assert.equal(decideGiftListAuthority({ user: staffUser, staff: false }).ok, false);
  assert.equal(decideGiftListAuthority({ user: null, staff: false }).status, 401);

  const src = fnSrc('gift-list');
  const fence = src.indexOf('decideGiftListAuthority({ user: caller, staff })');
  assert.ok(fence > 0 && src.indexOf("from('gift_cards')") > fence, 'decided before the cards are read');
  // Both Back Office callers send the venue the staff check needs.
  assert.ok(read('../backoffice/sections/GiftCards.jsx').includes('body: JSON.stringify({ ...body, location_id: body?.location_id || locationId }),'));
  assert.ok(read('../backoffice/sections/Customers.jsx').includes('location_id: body?.location_id || getActiveLocationSync() || undefined'));
});

const FULL = 'ABCD EFGH JKLM NPQR';

test('a customer typing their full code at checkout still works (kiosk, online, till, split bill)', () => {
  for (const body of [
    { code: 'ABCDEFGHJKLMNPQR', location_id: 'l' },   // kiosk, online, till, split bill
    { search: FULL },                                // Back Office lookup box with a full code
  ]) {
    assert.equal(classifyGiftLookup(body), 'code');
    assert.deepEqual(decideGiftLookupAuthority('code', { user: anon, staff: false }), { ok: true, view: 'code_holder' });
  }
  assert.ok(isFullGiftCode(FULL));
  // Each checkout sends { code, location_id }, never a search.
  assert.ok(read('../surfaces/KioskApp.jsx').includes('body: JSON.stringify({ code: stripped, location_id: locationId }),'));
  assert.ok(read('../surfaces/kiosk/kioskApi.js').includes("postFunction('gift-lookup', { code, location_id: locationId })"));
  assert.ok(read('../surfaces/online/OnlineCheckout.jsx').includes('body: JSON.stringify({ code: clean, location_id: opsLocationId }),'));
  assert.ok(read('../surfaces/CheckoutModal.jsx').includes('body: JSON.stringify({ code: giftStripped, location_id: getActiveLocationSync() }),'));
  // And the debit: a code that resolves is proof of possession, no authority needed.
  const red = fnSrc('gift-redeem');
  assert.ok(red.indexOf('if (card) provedByCode = true;') < red.indexOf(".eq('id', card_id)"), 'code_plain and HMAC come before card_id');
  assert.ok(red.includes('if (card && !provedByCode) {'));
});

test('a code holder sees balance and status, never the email, note or history', () => {
  const full = { card_id: 'c', status: 'active', balance: 500, code_last4: 'NPQR', recipient_name: 'Sam', recipient_email: 's@x.com', note: 'n', recent_transactions: [{}] };
  const v = codeHolderView(full);
  assert.equal(v.balance, 500); assert.equal(v.card_id, 'c'); assert.equal(v.recipient_name, 'Sam', 'the till shows the name');
  assert.ok(!('recipient_email' in v) && !('note' in v) && !('recent_transactions' in v));
});

test('gift-lookup: search by name, email or last 4 is staff only (no stealing a card by name)', () => {
  for (const body of [{ search: 'Sam Smith' }, { search: 'sam@example.com' }, { search: 'NPQR' }, { code_last4: 'NPQR', email: 'sam@example.com' }]) {
    assert.equal(classifyGiftLookup(body), 'staff_search', JSON.stringify(body));
    const r = decideGiftLookupAuthority('staff_search', { user: anon, staff: false });
    assert.equal(r.ok, false); assert.equal(r.status, 403);
    assert.deepEqual(decideGiftLookupAuthority('staff_search', { user: staffUser, staff: true }), { ok: true, view: 'full' });
  }
  const src = fnSrc('gift-lookup');
  const fence = src.indexOf('const authority = decideGiftLookupAuthority(lookupKind, { user: caller, staff });');
  assert.ok(fence > 0 && src.indexOf("from('gift_cards')") > fence, 'decided before any card is read');
  assert.equal((src.match(/if \(fullSearch && !card/g) || []).length, 3, 'last 4, email and name steps are staff only');
  assert.ok(src.includes('return json(shape({'), 'single card reply is shaped for code holders');
});

test('gift-redeem by card_id alone: staff, a claimed device, or the member who owns the card', () => {
  const f = { user: anon, staff: false, deviceCompanyId: null, companyId: CO, memberTokenSent: false, memberSession: null, cardOnMemberPhone: false };
  const r = decideGiftCardIdAuthority(f);
  assert.equal(r.ok, false); assert.equal(r.status, 403); assert.equal(r.reason, 'card_id_without_code');
  assert.deepEqual(decideGiftCardIdAuthority({ ...f, user: staffUser, staff: true }), { ok: true, via: 'staff' });
  assert.deepEqual(decideGiftCardIdAuthority({ ...f, deviceCompanyId: CO }), { ok: true, via: 'device' });
  assert.equal(decideGiftCardIdAuthority({ ...f, deviceCompanyId: 'other' }).ok, false);
  const member = { ...f, memberTokenSent: true, memberSession: { companyId: CO, phone: '+447931123456' } };
  assert.deepEqual(decideGiftCardIdAuthority({ ...member, cardOnMemberPhone: true }), { ok: true, via: 'member' });
  assert.equal(decideGiftCardIdAuthority({ ...member, cardOnMemberPhone: false }).reason, 'member_not_card_owner');
  assert.equal(decideGiftCardIdAuthority({ ...member, memberSession: null }).reason, 'member_token_invalid');
  const src = fnSrc('gift-redeem');
  assert.ok(src.indexOf('if (card && !provedByCode) {') < src.indexOf("rpc('redeem_gift_card_atomic'"), 'decided before the debit');
  assert.ok(src.indexOf('if (card && !provedByCode) {') < src.indexOf("from('gift_card_transactions')"), 'and before the idempotency read');
  assert.ok(src.includes('cardOnMemberPhone: !!memberSession && cardBelongsToPhone(card, memberSession.phone),'));
});

test('the kiosk sends the member token with a linked gift card (its submitOrder is frozen, so via lib/memberSession)', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ applied: 500, remaining_balance: 0, idempotency_key: 'k', card_id: 'card-1' }) }; };
  try {
    setActiveMemberSession({ token: 'member-tok', customerId: 'cust-1' });
    const staged = stageGiftCard({ cardId: 'card-1', code: null, balanceMinor: 500, amountDueMinor: 500 });
    const r = await commitGiftCard(staged, { functionsUrl: 'https://x/functions/v1', token: 't', locationId: 'l', channel: 'kiosk', closedCheckId: 'chk-1' });
    assert.equal(r.ok, true);
    assert.equal(calls[0].body.card_id, 'card-1');
    assert.equal(calls[0].body.member_token, 'member-tok');
    setActiveMemberSession(null);
    calls.length = 0;
    await commitGiftCard(stageGiftCard({ cardId: 'card-1', code: 'ABCDEFGHJKLMNPQR', balanceMinor: 500, amountDueMinor: 500 }), { functionsUrl: 'https://x/functions/v1', token: 't', locationId: 'l', channel: 'pos', closedCheckId: 'chk-2' });
    assert.ok(!('member_token' in calls[0].body), 'no member, no token (the till)');
  } finally {
    globalThis.fetch = realFetch;
    setActiveMemberSession(null);
  }
});

// ── 4. Owners must still see their cards ─────────────────────────────────────
// PostgREST ilike, as a regex, to prove the wide net really fetches the stored row.
const ilike = (pattern, value) => new RegExp('^' + pattern.split('%').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i').test(value);

test('a card stored as "07931 123 456" still reaches its owner', () => {
  const owner = '+447931123456';   // the phone proven with the one time code (E.164)
  const stored = [
    { id: 'typed-spaces', recipient_phone: '07931 123 456', code_last4: 'AAAA', code_plain: 'X', balance_minor: 1000, initial_amount_minor: 1000 },
    { id: 'typed-intl', recipient_phone: '+44 7931 123456', code_last4: 'BBBB', code_plain: 'Y', balance_minor: 500, initial_amount_minor: 500 },
    { id: 'typed-dashes', recipient_phone: '07931-123-456', code_last4: 'CCCC', code_plain: 'Z', balance_minor: 200, initial_amount_minor: 200 },
    { id: 'someone-else', recipient_phone: '07931 123 457', code_last4: 'DDDD', code_plain: 'W', balance_minor: 900, initial_amount_minor: 900 },
    { id: 'email-only', recipient_phone: null, recipient_email: 'owner@example.com', code_last4: 'EEEE', code_plain: 'V', balance_minor: 900, initial_amount_minor: 900 },
  ];
  const filter = giftCardRecipientFilter(owner);
  const pattern = filter.replace('recipient_phone.ilike.', '');
  for (const id of ['typed-spaces', 'typed-intl', 'typed-dashes']) {
    assert.ok(ilike(pattern, stored.find((c) => c.id === id).recipient_phone), `${id} is fetched by the query`);
  }
  const seen = memberGiftCards(stored, owner).map((c) => c.id).sort();
  assert.deepEqual(seen, ['typed-dashes', 'typed-intl', 'typed-spaces'], 'matched on the normalised phone; a near miss and an email only card are not');
  assert.equal(cardBelongsToPhone(stored[0], owner), true);
  assert.equal(cardBelongsToPhone(stored[3], owner), false);
  assert.equal(cardBelongsToPhone(stored[4], owner), false, 'email only cards are never matched (email is unverified)');
});

test('the phone rule is the app\'s own rule (same as src/lib/customerLookup.js normalisePhone)', () => {
  const src = read('./customerLookup.js');
  const body = src.slice(src.indexOf('export function normalisePhone(raw) {'), src.indexOf('// Cache the org_id'));
  const appRule = new Function(`${body.replace('export ', '')}; return normalisePhone;`)();
  for (const p of ['07931 123 456', '+44 7931 123456', '447931123456', '07931-123-456', '(650) 555-0100', '+1 650 555 0100', '0203 123 4567', '', 'abc']) {
    assert.equal(normaliseMemberPhone(p), appRule(p), p);
  }
});

test('loyalty-member-lookup matches its gift card list on the normalised phone too', () => {
  const src = fnSrc('loyalty-member-lookup');
  assert.ok(src.includes('.filter(c => cardBelongsToPhone(c, customer.phone))'));
  assert.ok(src.includes("select('code_last4, balance_minor, status, expires_at, recipient_phone')"));
});

// ── 3. Personal data by phone ────────────────────────────────────────────────
test('the limited reply says only "member" and the points and stamps switches', () => {
  const r = limitedMemberReply({ enabled: true, points_enabled: false, stamps_enabled: true });
  assert.deepEqual(Object.keys(r).sort(), [...LIMITED_MEMBER_KEYS].sort());
  assert.equal(r.enrolled, true); assert.equal(r.points_enabled, false); assert.equal(r.stamps_enabled, true);
  assert.equal(limitedMemberReply({ enabled: false }).points_enabled, false, 'loyalty off turns both off');
  for (const k of ['name', 'phone', 'email', 'allergens', 'customer_id', 'member_code', 'points_balance', 'recent_transactions']) {
    assert.ok(!(k in r), `no ${k}`);
  }
});

test('loyalty-balance: summary for the sign in prompt, full detail only with authority (report first)', () => {
  const src = fnSrc('loyalty-balance');
  const summary = src.indexOf("if (url.searchParams.get('view') === 'summary') return json(limitedMemberReply(_cfg));");
  const gate = src.indexOf("fn: 'loyalty-balance',");
  const degrade = src.indexOf('if (!gate.allow) return json(limitedMemberReply(_cfg));');
  assert.ok(summary > 0 && gate > summary && degrade > gate);
  for (const later of ["from('loyalty_rewards')", "from('loyalty_transactions')", "from('stamp_card_programs')"]) {
    assert.ok(src.indexOf(later) > degrade, `${later} only after the fence`);
  }
  assert.ok(src.includes("memberToken: req.headers.get('x-member-token'),"));
  assert.ok(src.includes('if (locCompany instanceof Response || locCompany !== companyId) staffLocationId = null;'), 'a venue of another company does not count');
  // Online checkout asks for the summary and recognises a member by `enrolled`.
  const online = read('../surfaces/online/OnlineCheckout.jsx');
  assert.ok(online.includes('/loyalty-balance?view=summary&phone='));
  assert.ok(!/\?\.member_code/.test(online), 'nothing reads member_code off the prompt lookup any more');
  // The portal refresh proves the member with its token; the till sends its session and venue.
  assert.ok(code(read('../../supabase/functions/loyalty-otp/index.ts')).includes("fetch(balanceUrl, { headers: { 'x-member-token': token } })"));
  const cl = read('./customerLookup.js');
  assert.ok(cl.includes('+ `&location_id=${encodeURIComponent(locId)}`;'));
  assert.ok(cl.includes('authToken ? { headers: { authorization: `Bearer ${authToken}` } } : undefined'));
  assert.ok(code(read('../../supabase/functions/_shared/loyalty-utils.ts')).includes("'authorization, x-client-info, apikey, content-type, x-member-token'"), 'CORS lets the header through');
});

test('loyalty-member-lookup: full detail only with authority; the limited reply never enrols', () => {
  const src = fnSrc('loyalty-member-lookup');
  const gate = src.indexOf("fn: 'loyalty-member-lookup',");
  const limited = src.indexOf('return json(limitedMemberReply(cfg));');
  assert.ok(gate > 0 && limited > gate);
  assert.ok(src.indexOf('ensureMembership(custId') > limited, 'enrolment only after the fence');
  assert.ok(src.indexOf("select('id, name, phone, email, allergens')") < gate, 'the profile read is only used after the fence');
  assert.ok(src.indexOf('allergens: customer.allergens') > limited);
});

// ── 5. Device claims and the member token on the kiosk ───────────────────────
test('memberSession: a token only ever speaks for its own member, with a short grace after a reset', () => {
  const t0 = 1_000_000;
  setActiveMemberSession({ token: 'tok-a', customerId: 'cust-a' }, t0);
  assert.equal(memberTokenFor('cust-a', t0), 'tok-a');
  assert.equal(memberTokenFor('cust-b', t0), null, 'never for somebody else');
  assert.equal(memberTokenFor(null, t0), null);
  assert.equal(activeMemberToken(), 'tok-a');
  setActiveMemberSession(null, t0 + 1000);
  assert.equal(activeMemberToken(), null, 'gift cards: no grace');
  assert.equal(memberTokenFor('cust-a', t0 + 2000), 'tok-a', 'earn landing just after a reset');
  assert.equal(memberTokenFor('cust-a', t0 + 1000 + MEMBER_GRACE_MS + 1), null, 'grace ends');
  setActiveMemberSession({ token: 'tok-b', customerId: 'cust-b' }, t0 + 3000);
  assert.equal(memberTokenFor('cust-a', t0 + 3000), null, 'a new member ends the old grace');
  setActiveMemberSession(null);
});

test('the kiosk keeps the member token from verify and publishes it (outside the frozen blocks)', () => {
  const k = read('../surfaces/KioskApp.jsx');
  assert.ok(k.includes('token: data.token || null,'), 'ScreenLoyalty stores the token');
  assert.ok(read('../surfaces/kiosk/KioskOtpSheet.jsx').includes('token: data.token || null,'), 'the new design stores it too');
  assert.ok(k.includes('setActiveMemberSession(verifiedLoyalty?.token'));
  const submit = k.slice(k.indexOf('const submitOrder = useCallback('), k.indexOf('tableNumber, resetSession]);'));
  assert.ok(!submit.includes('setActiveMemberSession') && !submit.includes('memberToken'), 'submitOrder untouched (card path guard)');
});

test('the kiosk re-claims its device on every boot with the code it paired with', () => {
  const sb = read('./supabase.js');
  assert.ok(sb.includes('if (!dev) return _claimKiosk();'), 'claimPairedDeviceOnBoot covers kiosks');
  const kc = sb.slice(sb.indexOf('const _claimKiosk = async () => {'), sb.indexOf('const _claimDevice = async () => {'));
  assert.ok(kc.includes("supabase.rpc('claim_device', { p_code: code })"));
  assert.ok(!kc.includes("from('devices')"), 'never reads a code off the row (Back Office "new code" must still move a kiosk)');
  assert.ok(sb.includes("'rpos-kiosk-pairing-code',"), 'kept across a tenant wipe');
  const ks = read('../surfaces/KioskSurface.jsx');
  assert.ok(!ks.includes('pairing_code: null,'), 'the code is no longer cleared at pairing');
  assert.ok(ks.includes('localStorage.setItem(KIOSK_CODE_KEY, codeNorm)'));
  assert.ok(ks.includes('claimPairedDeviceOnBoot();'), 'loadPaired re-claims');
  assert.equal((ks.match(/localStorage\.removeItem\(KIOSK_CODE_KEY\)/g) || []).length, 2, 'unpair and a missing row forget it');
});

test('the till waits for its device claim before earn, redeem and refund, and re-claims once on a 403', () => {
  const store = read('../store/index.js');
  assert.ok(store.includes('setDeviceClaimHooks({ waitForClaim: () => whenDeviceClaimed(), reclaim: () => claimPairedDeviceOnBoot() });'));
  const helper = store.slice(store.indexOf('async function postLoyaltyWithDeviceClaim'), store.indexOf('async function postLoyaltyWithDeviceClaim') + 900);
  assert.ok(helper.indexOf('await whenDeviceClaimed();') < helper.indexOf('let res = await send();'));
  assert.ok(helper.includes('if (res && res.status === 403) {') && helper.includes('await claimPairedDeviceOnBoot();') && helper.includes('res = await send();'));
  assert.ok(store.includes("const res = await postLoyaltyWithDeviceClaim('loyalty-earn', earnBody);"));
  assert.ok(store.includes("const res = await postLoyaltyWithDeviceClaim('loyalty-refund', {"));
  assert.ok(store.includes('...(memberTokenFor(customerId) ? { member_token: memberTokenFor(customerId) } : {}),'), 'kiosk earn carries the member token');
  const cr = read('./commitRedemptions.js');
  const commit = cr.slice(cr.indexOf('export async function commitRedemption'));
  assert.ok(commit.indexOf('await _deviceHooks.waitForClaim();') < commit.indexOf('result = await post(call.fn, call.body, { functionsUrl, token });'), 'redeem waits for the claim');
  assert.ok(commit.includes('if (!o.ok && loyaltyCall && result.res?.status === 403 && _deviceHooks.reclaim) {'), 'and re-claims once on a 403');
});

test('online checkout passes the member token to earn as well as redeem', () => {
  const online = read('../surfaces/online/OnlineCheckout.jsx');
  assert.equal((online.match(/memberToken: loyalty\?\.token \|\| null,\n {8}memberCustomerId,/g) || []).length, 2, 'both attributeOnlineOrder calls');
  const cl = read('./customerLookup.js');
  assert.ok(cl.includes('...(memberToken && memberCustomerId && memberCustomerId === customerId ? { member_token: String(memberToken) } : {}),'));
});
