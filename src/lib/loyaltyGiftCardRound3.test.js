// Round three of the 18 Sep 2026 loyalty and gift card audit (Peter: "Yes, fix and deploy").
// Pins every rule:
//   A. the money holes, enforced now: an anonymous session cannot issue, import, bulk create,
//      fulfil unpaid, reverse, void, configure or enrol; staff can, by the database's own rule
//   B. staff = user_accessible_locations() (user_locations plus the super admin arm since 20260918d),
//      and a kiosk pairing code is cleared on the row so a second tablet cannot steal the link
//   C. earn from the server's closed check; refund refuses a member token; the portal refresh
//      passes under enforce; a bad member token falls back to the device arm; gift-redeem checks
//      idempotency before authority
//   D. the log: fire and forget, rate limited, a purge, and a read only report
//   E. GB and US phones match on their digits
// Edge functions cannot run under node, so their decisions live in pure _shared modules tested
// here, and the wiring is pinned by reading the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { decideStaffAccess, accessibleLocations } from '../../supabase/functions/_shared/staffAccess.ts';
import {
  decideGiftStaffOnly, decideGiftReverseAuthority, decideGiftFulfilAuthority, decideGiftCardIdAuthority,
} from '../../supabase/functions/_shared/gift-authority.ts';
import {
  stripeSessionProvesPurchase, ryftSessionProvesPurchase, purchaseProcessor,
} from '../../supabase/functions/_shared/giftPurchaseProof.ts';
import { decideLoyaltyAuthority, applyAuthorityMode, authorityLogRow } from '../../supabase/functions/_shared/loyalty-authority.ts';
import {
  decideEarnSource, earnItemsFromCheck, checkCapMinor, checkBelongsToMember, checkItemIds, checkIsEarnable,
} from '../../supabase/functions/_shared/earnFromCheck.ts';
import { phonesMatch, phoneShape, cardBelongsToPhone, giftCardRecipientFilter, normaliseMemberPhone } from '../../supabase/functions/_shared/giftCardMatch.ts';
import { createAuthorityLogLimiter } from '../../supabase/functions/_shared/authorityLogLimiter.ts';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const fnSrc = (name) => code(read(`../../supabase/functions/${name}/index.ts`));

const anon = { id: '00000000-0000-4000-8000-00000000a0a0', is_anonymous: true };
const user = { id: '00000000-0000-4000-8000-0000000057af', is_anonymous: false };
const CO = '11111111-1111-4111-8111-111111111111';
const CO2 = '22222222-2222-4222-8222-222222222222';
const OPS_LOC = '33333333-3333-4333-8333-333333333333';
const PLAT_LOC = '44444444-4444-4444-8444-444444444444';
const OTHER_LOC = '55555555-5555-4555-8555-555555555555';

const staffFacts = (over = {}) => ({
  user, role: 'owner', userLocationIds: [], companyRoleCompanyIds: [],
  locationKeys: [PLAT_LOC, OPS_LOC], companyId: CO, companyOpsLocationIds: [], ...over,
});

// ── B1. Staff is the database's own rule ─────────────────────────────────────
test('staff: the same rule as user_accessible_locations() (user_locations only), plus super_admin and a company role', () => {
  // An anonymous session is never staff, whatever rows it has.
  assert.equal(decideStaffAccess(staffFacts({ user: anon, role: 'super_admin', userLocationIds: [OPS_LOC] })).ok, false);
  assert.equal(decideStaffAccess(staffFacts({ user: null })).ok, false);
  // user_locations row (the Ops id, reached from the Platform id the caller sent).
  assert.deepEqual(decideStaffAccess(staffFacts({ userLocationIds: [OPS_LOC] })), { ok: true, via: 'user_locations' });
  // Lockdown step 1 (a): a profile venue is NEVER access. It was self writable, so round three's
  // user_profiles arm made every gift card admin gate spoofable. A fact of that name is ignored.
  assert.deepEqual(decideStaffAccess(staffFacts({ profileLocationId: OPS_LOC })), { ok: false, via: null });
  assert.equal(decideStaffAccess(staffFacts({ locationKeys: [], companyOpsLocationIds: [OPS_LOC], profileLocationId: OPS_LOC })).ok, false);
  assert.deepEqual(decideStaffAccess(staffFacts({ role: 'super_admin' })), { ok: true, via: 'super_admin' });
  assert.deepEqual(decideStaffAccess(staffFacts({ companyRoleCompanyIds: [CO] })), { ok: true, via: 'company_role' });
  // Not staff: another venue's rows, another company's role.
  assert.equal(decideStaffAccess(staffFacts({ userLocationIds: [OTHER_LOC], companyRoleCompanyIds: [CO2] })).ok, false);
  // Company level (no location): any of the company's venues, or a company role.
  const co = { locationKeys: [], companyOpsLocationIds: [OPS_LOC] };
  assert.equal(decideStaffAccess(staffFacts({ ...co, userLocationIds: [OPS_LOC] })).ok, true);
  assert.equal(decideStaffAccess(staffFacts({ ...co, userLocationIds: [OTHER_LOC] })).ok, false);
  assert.deepEqual([...accessibleLocations({ userLocationIds: ['a', 'b'], profileLocationId: 'c' })].sort(), ['a', 'b']);
});

test('staff parity: the SQL user_accessible_locations() that runs last (20260918d) is user_locations plus the super admin arm, and callerIsStaffFor never reads the profile venue', () => {
  const sql = read('../../supabase/migrations/20260918d_OPS_profile_venue_lock.sql');
  const i = sql.search(/create or replace function public\.user_accessible_locations\(\)/i);
  assert.ok(i >= 0);
  const body = sql.slice(i, sql.indexOf('$function$;', i)).toLowerCase();
  assert.ok(/from\s+public\.user_locations\s+ul\s+where\s+ul\.user_id\s*=\s*auth\.uid\(\)/.test(body), 'user_locations arm');
  assert.ok(/union\s+select l\.id::text from public\.locations l where public\.is_super_admin\(\)/.test(body), 'the verified super admin reaches every venue');
  assert.ok(!/user_profiles/.test(body), 'no profile arm');
  assert.ok(/returns setof text\s+language sql\s+stable/.test(body), 'same signature and stability');
  assert.ok(!/security definer/.test(body), 'still security invoker');
  assert.ok(!/profileLocationId/.test(read('../../supabase/functions/_shared/staffAccess.ts')), 'the pure rule has no profile arm');
  const u = code(read('../../supabase/functions/_shared/loyalty-utils.ts'));
  const fn = u.slice(u.indexOf('export async function callerIsStaffFor'), u.indexOf('const UUID_ONLY'));
  assert.ok(fn.includes("from('user_profiles').select('role').eq('id', user.id)"), 'reads only the role');
  assert.ok(!/location_id'\)\.eq\('id'/.test(fn) && !/profileLocationId/.test(fn), 'never the profile venue');
  assert.ok(fn.includes("from('user_locations').select('location_id').eq('user_id', user.id)"), 'reads user_locations');
  assert.ok(fn.includes("from('user_company_roles').select('company_id').eq('user_id', user.id)"), 'reads company roles');
  assert.ok(fn.includes('return decideStaffAccess({'), 'decided by the pure rule');
  assert.ok(fn.includes('if (!user || user.is_anonymous || !user.id) return false;'));
});

// ── A1, A4. Staff only: issue, import, bulk create, config, void, resend ─────
test('an anonymous session cannot issue, import, bulk create, configure, void or resend; staff can', () => {
  assert.equal(decideGiftStaffOnly({ user: anon, staff: true }).ok, false, 'anonymous is never staff');
  assert.equal(decideGiftStaffOnly({ user: anon, staff: false }).status, 403);
  assert.equal(decideGiftStaffOnly({ user: null, staff: false }).status, 401);
  assert.equal(decideGiftStaffOnly({ user, staff: false }).reason, 'no_location_access');
  assert.deepEqual(decideGiftStaffOnly({ user, staff: true }), { ok: true });

  for (const fn of ['gift-issue', 'gift-import', 'gift-bulk-create', 'gift-config', 'gift-void', 'gift-resend']) {
    const src = fnSrc(fn);
    const gate = src.indexOf(`requireStaff({\n    fn: '${fn}',`);
    assert.ok(gate > 0, `${fn}: calls requireStaff with its own name`);
    assert.ok(src.indexOf('if (refused) return refused;', gate) > gate, `${fn}: stops when refused`);
    for (const write of ["from('gift_cards')", "from('gift_brand_config')", "from('gift_card_transactions')", 'generateCode()']) {
      const at = src.indexOf(write);
      if (at >= 0) assert.ok(at > gate, `${fn}: ${write} comes after the staff check`);
    }
  }
  // gift-issue: a body org_id can no longer point a card at another company.
  const issue = fnSrc('gift-issue');
  assert.ok(issue.includes("if (org_id && String(org_id) !== String(companyId)) {"));
  // gift-config never hands out the HMAC secret.
  const cfg = fnSrc('gift-config');
  assert.ok(!/return json\(\{ config(: (data|config))? \}\)/.test(cfg), 'every config reply is stripped');
  assert.equal((cfg.match(/withoutSecret\(/g) || []).length >= 6, true);
});

test('requireStaff is the one staff gate: callerIsStaffFor, then decideGiftStaffOnly, and a refusal is logged', () => {
  const u = code(read('../../supabase/functions/_shared/loyalty-utils.ts'));
  const fn = u.slice(u.indexOf('export async function requireStaff'), u.indexOf('// ── Company resolution'));
  assert.ok(fn.includes('await callerIsStaffFor(p.caller, p.locationId, p.companyId)'));
  assert.ok(fn.includes('decideGiftStaffOnly({ user: p.caller, staff }, p.what)'));
  assert.ok(fn.includes('recordAuthority(authorityLogRow({'));
});

test('Back Office, the only caller of the staff only gift functions, sends a signed in session and the venue', () => {
  const gc = read('../backoffice/sections/GiftCards.jsx');
  assert.ok(gc.includes("const { data: session } = await supabase.auth.getSession();"));
  assert.ok(gc.includes('body: JSON.stringify({ ...body, location_id: body?.location_id || locationId }),'));
  for (const fn of ["'gift-issue'", "'gift-bulk-create'", "'gift-import'", "'gift-void'", "'gift-resend'", "'gift-config'", "'gift-fulfill'"]) {
    assert.ok(gc.includes(`callGift(${fn}`), `${fn} is called through callGift`);
  }
  const lm = read('../backoffice/sections/LoyaltyManager.jsx');
  assert.ok(lm.includes("callLoyalty('loyalty-config', form)") && lm.includes("callLoyaltyPatch('loyalty-rewards'") && lm.includes("callLoyaltyDelete('loyalty-rewards'"));
});

// ── A5. loyalty-config and loyalty-rewards writes ─────────────────────────────
test('loyalty-config and loyalty-rewards: every write is staff only, reads stay as they were', () => {
  const cfg = fnSrc('loyalty-config');
  const get = cfg.indexOf("if (req.method === 'GET') {");
  const post = cfg.indexOf("if (req.method === 'POST') {");
  const gate = cfg.indexOf("requireStaff({\n      fn: 'loyalty-config',");
  assert.ok(get > 0 && post > get && gate > post, 'the gate is in the POST branch, GET untouched');
  assert.ok(cfg.indexOf(".from('loyalty_config')\n      .update(updates)") > gate);

  const rw = fnSrc('loyalty-rewards');
  const rget = rw.indexOf("if (req.method === 'GET') {");
  const rgate = rw.indexOf("requireStaff({\n    fn: 'loyalty-rewards',");
  assert.ok(rget > 0 && rgate > rget, 'GET answers before the gate');
  for (const m of ["if (req.method === 'POST') {", "if (req.method === 'PATCH') {", "if (req.method === 'DELETE') {"]) {
    assert.ok(rw.indexOf(m) > rgate, `${m} is behind the gate`);
  }
});

// ── A2. gift-fulfill: paid only, proven by the processor ─────────────────────
const purchase = { id: 'pur-1', amount_minor: 2500, currency: 'gbp', processor: 'stripe' };
test('gift-fulfill: only the webhook (service role) or staff; anonymous and outsiders are refused', () => {
  assert.deepEqual(decideGiftFulfilAuthority({ serviceRole: true, user: null, staff: false }), { ok: true, via: 'webhook' });
  assert.deepEqual(decideGiftFulfilAuthority({ serviceRole: false, user, staff: true }), { ok: true, via: 'staff' });
  assert.equal(decideGiftFulfilAuthority({ serviceRole: false, user: anon, staff: false }).ok, false);
  assert.equal(decideGiftFulfilAuthority({ serviceRole: false, user: anon, staff: true }).ok, false, 'anonymous is never staff');
  assert.equal(decideGiftFulfilAuthority({ serviceRole: false, user, staff: false }).status, 403);
});

test('an unpaid purchase never fulfils; a paid one (Stripe or Ryft) still does', () => {
  const paid = { payment_status: 'paid', metadata: { purchase_id: 'pur-1' }, amount_total: 2500, currency: 'gbp' };
  assert.deepEqual(stripeSessionProvesPurchase(paid, purchase), { ok: true }, 'a paid online purchase still fulfils');
  assert.equal(stripeSessionProvesPurchase({ ...paid, payment_status: 'unpaid' }, purchase).reason, 'not_paid');
  assert.equal(stripeSessionProvesPurchase({ ...paid, metadata: { purchase_id: 'pur-2' } }, purchase).reason, 'session_not_for_purchase');
  assert.equal(stripeSessionProvesPurchase({ ...paid, amount_total: 500 }, purchase).reason, 'amount_short');
  assert.equal(stripeSessionProvesPurchase({ ...paid, currency: 'usd' }, purchase).reason, 'currency_mismatch');
  assert.equal(stripeSessionProvesPurchase(null, purchase).ok, false);

  const ps = { status: 'Captured', metadata: { purchase_id: 'pur-1' }, amount: 2500, currency: 'GBP' };
  assert.deepEqual(ryftSessionProvesPurchase(ps, purchase), { ok: true });
  assert.equal(ryftSessionProvesPurchase({ ...ps, status: 'Approved' }, purchase).reason, 'not_paid', 'captured money only');
  assert.equal(ryftSessionProvesPurchase({ ...ps, status: 'PendingPayment' }, purchase).ok, false);
  assert.equal(ryftSessionProvesPurchase({ ...ps, metadata: {} }, purchase).ok, false);

  assert.equal(purchaseProcessor({ processor: 'stripe' }), 'stripe');
  assert.equal(purchaseProcessor({ processor: 'ryft' }), 'ryft');
  assert.equal(purchaseProcessor({ processor: 'adyen' }), null, 'Adyen has no gift purchase flow: unverifiable, refused');
});

test('gift-fulfill wiring: authority, then processor proof, then a claim, THEN a code; the code only to staff', () => {
  const src = fnSrc('gift-fulfill');
  const who = src.indexOf('decideGiftFulfilAuthority({ serviceRole, user: caller, staff })');
  const proof = src.indexOf('const proof = await provePurchasePaid(purchase);');
  const claim = src.indexOf(".update({ status: 'fulfilling', updated_at: claimedAt })");
  const gen = src.indexOf('const code = generateCode();');
  assert.ok(who > 0 && proof > who && claim > proof && gen > claim, 'order: who, proof, claim, code');
  assert.ok(src.includes("}, 402);"), 'unproven payment: 402, nothing issued');
  // The proof reads the processor, with the merchant account from OUR table, never the row.
  assert.ok(src.includes(".from('merchant_stripe_accounts').select('stripe_account_id').eq('location_id', purchase.location_id)"));
  assert.ok(src.includes(".from('merchant_ryft_accounts').select('ryft_account_id').eq('location_id', purchase.location_id)"));
  assert.ok(!src.includes('stripeAccount: String(purchase.stripe_account_id)'));
  // The company check runs for EVERY caller now (the row is anon writable).
  assert.ok(!/if \(callerUserId\) \{\n\s+const \{ data: loc \}/.test(src));
  assert.ok(src.includes('...(callerUserId ? { code: formatCode(normalized) } : {}),'), 'the webhook never gets the code');
  assert.ok(/releaseClaim\(\)/.test(src.slice(gen)), 'a failure hands the claim back');
  // The Stripe webhook only marks a PAID session paid.
  const wh = fnSrc('stripe-webhook-connect');
  assert.ok(wh.includes("(session as any).payment_status !== 'paid'"));
});

// ── A3. gift-reverse-redeem ───────────────────────────────────────────────────
test('gift-reverse-redeem: staff or a claimed till of the company; never the customer who made the spend', () => {
  assert.equal(decideGiftReverseAuthority({ user: anon, staff: false, deviceCompanyId: null, companyId: CO }).ok, false,
    'an anonymous session (the online or kiosk customer who made the spend) is refused');
  assert.equal(decideGiftReverseAuthority({ user: anon, staff: false, deviceCompanyId: CO2, companyId: CO }).reason, 'device_other_company');
  assert.deepEqual(decideGiftReverseAuthority({ user: anon, staff: false, deviceCompanyId: CO, companyId: CO }), { ok: true, via: 'device' });
  assert.deepEqual(decideGiftReverseAuthority({ user, staff: true, deviceCompanyId: null, companyId: CO }), { ok: true, via: 'staff' });
  assert.equal(decideGiftReverseAuthority({ user, staff: false, deviceCompanyId: null, companyId: CO }).ok, false);
  assert.equal(decideGiftReverseAuthority({ user: null, staff: false, deviceCompanyId: null, companyId: CO }).status, 401);
});

test('gift-reverse-redeem wiring: authority before any read, the refund row is the claim, the balance moves by compare and swap', () => {
  const src = fnSrc('gift-reverse-redeem');
  const gate = src.indexOf('decideGiftReverseAuthority({');
  assert.ok(gate > 0 && src.indexOf(".from('gift_card_transactions')") > gate, 'nothing read before the gate');
  const claim = src.indexOf("type: 'refund',");
  const move = src.indexOf(".update({ balance_minor: nb, status: ns })");
  assert.ok(claim > 0 && move > claim, 'claim first, then the balance');
  assert.ok(src.includes(".eq('balance_minor', cur.balance_minor)"), 'compare and swap');
  assert.ok(src.includes("if (txErr?.code === '23505') {"), 'a second reversal of the same spend is already_reversed');
  assert.ok(src.includes("await platformAdmin.from('gift_card_transactions').delete().eq('id', claim.id);"), 'claim released if the balance cannot move');
  assert.ok(src.includes("const refundKey = `refund:${original_idempotency_key}`;"), 'never twice for one spend');
});

test('the till refund and the dead card machine job still reverse (device or staff), and say so when refused', () => {
  const store = read('../store/index.js');
  assert.ok(store.includes('const r = await reverseGiftCard(leg, {'), 'refundCheck and the terminal job undo use the shared call');
  assert.ok(store.includes('get().showToast?.(giftReversalFailedMessage(leg, r.error'), 'a refused reversal is shown, not swallowed');
  const gc = read('./giftCommit.js');
  assert.ok(gc.includes('...(deviceHint() ? { device_hint: deviceHint() } : {}),'), 'the till names itself for the log');
});

// ── A6. loyalty-enroll ────────────────────────────────────────────────────────
test('loyalty-enroll: no longer open; service role, the member, staff or a device, and only this company\'s customers', () => {
  const src = fnSrc('loyalty-enroll');
  const svc = src.indexOf('const serviceRole = isServiceRoleRequest(req);');
  const gate = src.indexOf("fn: 'loyalty-enroll',");
  const bonus = src.indexOf('ensureMembership(customerId, companyId, config)');
  assert.ok(svc > 0 && gate > svc && bonus > gate, 'who is decided before any bonus');
  assert.ok(src.includes("modeOverride: 'enforce',"), 'enforced now');
  assert.ok(src.includes("if (!caller && !memberToken) return json({ error: 'Unauthorized' }, 401);"), 'no session at all: 401');
  assert.ok(src.includes('if (!customerInCompany(customer, orgIds)) {'), "another company's customer is refused");
  assert.ok(src.indexOf('if (!customerInCompany(customer, orgIds)) {') < bonus);
  // Its one caller still works: wifi-capture calls it with the service role key.
  const wifi = read('../../supabase/functions/wifi-capture/index.ts');
  assert.ok(/fetch\(`\$\{FN_BASE\}\/loyalty-enroll`, \{\s*method: 'POST', headers: \{ 'Content-Type': 'application\/json', 'Authorization': `Bearer \$\{SERVICE_KEY\}` \}/.test(wifi));
  const u = code(read('../../supabase/functions/_shared/loyalty-utils.ts'));
  assert.ok(u.includes("const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';") && u.includes('return !!key && raw === key;'));
});

// ── A7. loyalty-member-lookup ─────────────────────────────────────────────────
test('loyalty-member-lookup: enforced now, every customer read fenced to the venue org', () => {
  const src = fnSrc('loyalty-member-lookup');
  assert.ok(src.includes("modeOverride: 'enforce',"));
  assert.ok(src.includes(".eq('id', uuidOr0(custId))\n    .eq('org_id', orgId)"), 'customer_id from the body is read inside the org only');
  assert.ok(src.includes("if (!orgId) return json({ found: false, error: 'Customer not found' }, 404);"));
  assert.ok(src.includes('.or(`ops_location_id.eq.${uuidOr0(location_id)},id.eq.${uuidOr0(location_id)}`)'), 'no filter injection');
  assert.ok(src.indexOf("modeOverride: 'enforce',") < src.indexOf('ensureMembership(custId, companyId, config)'), 'never enrols before the gate');
});

// ── C2, C3, C4. The loyalty decision ──────────────────────────────────────────
const base = { customerId: 'cust-1', companyId: CO, memberTokenSent: false, memberSession: null, staffHasLocation: false, deviceCompanyId: null };
const good = { customerId: 'cust-1', companyId: CO };

test('portal refresh passes under enforce: a good member token with NO session is the member', () => {
  const d = decideLoyaltyAuthority({ ...base, user: null, memberTokenSent: true, memberSession: good });
  assert.deepEqual(d, { ok: true, via: 'member', callerKind: 'member' });
  assert.equal(applyAuthorityMode(d, 'enforce').allow, true);
  // A bad token with no session is still refused, with the member reason.
  assert.equal(decideLoyaltyAuthority({ ...base, user: null, memberTokenSent: true, memberSession: null }).reason, 'member_token_invalid');
  assert.equal(decideLoyaltyAuthority({ ...base, user: null }).reason, 'no_session');
  // The wiring: loyalty-otp refresh sends only x-member-token; loyalty-balance passes it through.
  const otp = code(read('../../supabase/functions/loyalty-otp/index.ts'));
  assert.ok(otp.includes("const balRes = await fetch(balanceUrl, { headers: { 'x-member-token': token } });"));
  const bal = fnSrc('loyalty-balance');
  assert.ok(bal.includes("memberToken: req.headers.get('x-member-token'),"));
  const u = code(read('../../supabase/functions/_shared/loyalty-utils.ts'));
  assert.ok(u.includes('const deviceCompanyId = (memberGood || staffHasLocation || !p.caller) ? null : await callerDeviceCompany(p.caller.id);'), 'no session: no device lookup');
});

test('a bad or expired member token falls back to the device or staff arm', () => {
  for (const memberSession of [null, { customerId: 'cust-9', companyId: CO }]) {
    assert.deepEqual(decideLoyaltyAuthority({ ...base, user: anon, memberTokenSent: true, memberSession, deviceCompanyId: CO }), { ok: true, via: 'device', callerKind: 'device' });
    assert.deepEqual(decideLoyaltyAuthority({ ...base, user, memberTokenSent: true, memberSession, staffHasLocation: true }), { ok: true, via: 'staff', callerKind: 'staff' });
    const refused = decideLoyaltyAuthority({ ...base, user: anon, memberTokenSent: true, memberSession });
    assert.equal(refused.ok, false);
    assert.equal(refused.callerKind, 'member', 'the log says a member token was the problem');
  }
  // checkLoyaltyAuthority gathers the staff and device facts even when a token was sent.
  const u = code(read('../../supabase/functions/_shared/loyalty-utils.ts'));
  assert.ok(u.includes('const staffHasLocation = memberGood ? false : await callerIsStaffFor(p.caller, p.locationId, p.companyId);'));
});

test('loyalty-refund is a till action: a member token never passes it', () => {
  const own = { ...base, user: anon, memberTokenSent: true, memberSession: good, memberAllowed: false };
  const d = decideLoyaltyAuthority(own);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'member_token_not_accepted');
  assert.equal(applyAuthorityMode(d, 'enforce').allow, false);
  // Even with no session at all.
  assert.equal(decideLoyaltyAuthority({ ...own, user: null }).ok, false);
  // The till that carries a stale member token still refunds.
  assert.deepEqual(decideLoyaltyAuthority({ ...own, deviceCompanyId: CO }), { ok: true, via: 'device', callerKind: 'device' });
  const src = fnSrc('loyalty-refund');
  const gate = src.slice(src.indexOf("fn: 'loyalty-refund',"), src.indexOf('if (!gate.allow) return gate.response!;'));
  assert.ok(gate.includes('memberAllowed: false,'));
  const u = code(read('../../supabase/functions/_shared/loyalty-utils.ts'));
  assert.ok(u.includes('const memberSession = memberTokenSent && memberAllowed'), 'the token is not even verified when not accepted');
});

// ── C5. gift-redeem: idempotency before authority ────────────────────────────
test('gift-redeem answers a retry of a debit that landed before it asks for authority', () => {
  const src = fnSrc('gift-redeem');
  const idem = src.indexOf('if (existingTx) {');
  const auth = src.indexOf('decideGiftCardIdAuthority({');
  const debit = src.indexOf("rpc('redeem_gift_card_atomic'");
  assert.ok(idem > 0 && auth > idem && debit > auth, 'idempotency, then authority, then the debit');
  // A customer's typed code still spends at every checkout: proved by code, no authority asked.
  assert.ok(src.includes('if (card) provedByCode = true;'));
  assert.ok(decideGiftCardIdAuthority({ user: anon, staff: false, deviceCompanyId: CO, companyId: CO, memberTokenSent: false, memberSession: null, cardOnMemberPhone: false }).ok);
});

// ── C1. loyalty-earn from the server's closed check ──────────────────────────
const check = {
  id: 'chk-1', location_id: OPS_LOC, subtotal: 12.5, total: 12.5, status: 'paid',
  customer: { name: 'Sam', phone: '07931 123456' },
  items: [
    { itemId: 'latte-l', parentId: 'latte', name: 'Latte (L)', price: 3.5, qty: 2 },
    { itemId: 'cake', name: 'Cake', price: 4, qty: 1, cat: 'body-says-coffee' },
    { itemId: 'void-thing', name: 'Voided', price: 100, qty: 1, voided: true },
    { itemId: 'gc', name: 'Gift card', price: 20, qty: 1, isGiftCard: true },
  ],
};
const menu = [
  { id: 'latte', cat: 'coffee' },
  { id: 'latte-l', cat: 'sandwiches', parent_id: 'latte' },
  { id: 'cake', cat: 'bakery' },
];

test('earn uses the server\'s closed check, not the body', () => {
  const items = earnItemsFromCheck(check, menu);
  assert.equal(items.length, 3, 'voided lines never earn');
  assert.equal(items[0].cat, 'coffee', "a variant takes its parent's category from the menu");
  assert.equal(items[1].cat, 'bakery', 'the menu wins over what the check line says');
  assert.equal(items[2].isGiftCard, true);
  assert.equal(checkCapMinor(check), 1250);
  assert.equal(checkCapMinor({ subtotal: 10, total: 0 }), 1000, 'a gift card only order still has its subtotal');
  assert.deepEqual(checkItemIds(check).sort(), ['cake', 'gc', 'latte', 'latte-l']);
  assert.equal(checkIsEarnable(check), true);
  assert.equal(checkIsEarnable({ ...check, refunded: true }), false);
  assert.equal(checkIsEarnable({ ...check, status: 'voided' }), false);

  // enforce: a check that does not exist is refused (retryable), voided refused, a stranger's refused
  assert.deepEqual(
    (({ use, status, code, retryable }) => ({ use, status, code, retryable }))(decideEarnSource({ mode: 'enforce', check: null, via: 'device', member: null })),
    { use: 'refuse', status: 409, code: 'check_not_found', retryable: true });
  assert.equal(decideEarnSource({ mode: 'enforce', check: { ...check, voided: true }, via: 'device', member: null }).use, 'refuse');
  const stranger = { customerId: 'cust-9', phone: '+447000000000' };
  assert.equal(decideEarnSource({ mode: 'enforce', check, via: 'member', member: stranger }).code, 'check_not_this_member');
  // the member's own check, by proven phone (typed differently) or customer id
  assert.deepEqual(decideEarnSource({ mode: 'enforce', check, via: 'member', member: { customerId: 'c', phone: '+447931123456' } }), { use: 'check', record: null });
  assert.equal(checkBelongsToMember({ ...check, customer_id: 'c-7' }, { customerId: 'c-7', phone: null }), true);
  assert.equal(checkBelongsToMember(check, { customerId: 'c-7', phone: null }), false);
  // tills and staff pick the customer: not asked
  assert.deepEqual(decideEarnSource({ mode: 'enforce', check, via: 'device', member: null }), { use: 'check', record: null });
  // report: nothing breaks today; missing rows are recorded and earned the old way
  assert.deepEqual(decideEarnSource({ mode: 'report', check: null, via: null, member: null }), { use: 'body', record: 'check_not_found' });
  assert.deepEqual(decideEarnSource({ mode: 'report', check, via: 'member', member: stranger }), { use: 'check', record: 'check_not_this_member' });
});

test('loyalty-earn wiring: reads its check at the location, earns from it, one earn per check, claim first', () => {
  const src = fnSrc('loyalty-earn');
  const gate = src.indexOf('if (!gate.allow) return gate.response!;');
  const chk = src.indexOf(".from('closed_checks')");
  assert.ok(chk > gate, 'the check is read after the fence');
  assert.ok(src.includes(".eq('id', String(closed_check_id))\n    .in('location_id', locKeys)"), 'at THIS location');
  assert.ok(src.includes('items = earnItemsFromCheck(check as CheckRow, menu);'));
  assert.ok(src.includes('if (cap > 0) qualifyingMinor = Math.min(qualifyingMinor, cap);'), 'never more than the check says');
  assert.ok(src.includes(".eq('closed_check_id', String(closed_check_id))\n      .eq('company_id', companyId)\n      .eq('type', 'earn')"), 'one earn per check whatever the key');
  const claim = src.indexOf("const { data: claim, error: claimErr } = await opsAdmin.from('loyalty_transactions').insert({");
  const bal = src.indexOf('const nb = await updateBalance(membership.id, pointsEarned);');
  assert.ok(claim > 0 && bal > claim, 'the ledger claim goes in before the balance moves');
  // Every caller sends the closed_checks id: the till (orderRecord.id) and online (checkId, was the ref).
  const store = read('../store/index.js');
  assert.ok(store.includes('closed_check_id: orderRecord.id || orderRecord.ref,'));
  assert.ok(read('./customerLookup.js').includes('closed_check_id: orderRecord.checkId || orderRecord.ref || `online-${Date.now()}`,'));
  assert.equal((read('../surfaces/online/OnlineCheckout.jsx').match(/orderRecord: \{ ref, checkId, total:/g) || []).length, 2, 'both online paths');
  // and they wait and retry while the row lands
  assert.ok(store.includes("if (code !== 'check_not_found') break;"));
  assert.ok(read('./customerLookup.js').includes("if (code !== 'check_not_found') break;"));
});

// ── B2. The kiosk pairing code ────────────────────────────────────────────────
// A model of the LIVE claim_device (20260713c): the first row holding the code (not removed)
// gets device_uid = the caller. This is the rule that made keeping the code a theft.
function liveClaimDevice(rows, code, uid) {
  const r = rows.find((d) => d.pairing_code === String(code).trim().toUpperCase() && d.status !== 'removed');
  if (!r) return null;
  r.device_uid = uid;
  return r.location_id;
}
// What KioskSurface.tryPair does: claim, then clear the code on the row.
function kioskPair(rows, typed, uid) {
  const loc = liveClaimDevice(rows, typed, uid);
  const r = rows.find((d) => d.pairing_code === typed.trim().toUpperCase() && d.type === 'kiosk');
  if (r) r.pairing_code = null;
  return loc;
}

test('a kiosk pairing code is cleared on the row and a second tablet cannot steal the link', () => {
  const rows = [{ id: 'k1', type: 'kiosk', status: 'awaiting_pairing', pairing_code: 'BAKER-3225', location_id: OPS_LOC, device_uid: null }];
  assert.equal(kioskPair(rows, 'baker-3225', 'uid-first'), OPS_LOC);
  assert.equal(rows[0].device_uid, 'uid-first');
  assert.equal(rows[0].pairing_code, null, 'single use');
  assert.equal(liveClaimDevice(rows, 'BAKER-3225', 'uid-second'), null, 'the same code on a second tablet finds nothing');
  assert.equal(rows[0].device_uid, 'uid-first', 'the first kiosk keeps its link (and its Ryft card payments)');

  const ks = read('../surfaces/KioskSurface.jsx');
  const claim = ks.indexOf("await supabase.rpc('claim_device', { p_code: codeNorm });");
  const clear = ks.indexOf('pairing_code: null,');
  assert.ok(claim > 0 && clear > claim, 'claimed with the typed code, THEN the code is cleared on the row');
  assert.ok(!ks.includes('KIOSK_CODE_KEY') && !ks.includes('claimPairedDeviceOnBoot'), 'no stored code, no boot re-claim');
  const sb = read('./supabase.js');
  assert.ok(!sb.includes('_claimKiosk'));
});

// ── D. The log ────────────────────────────────────────────────────────────────
test('the log is never awaited on the till path and cannot flood', () => {
  let t = 0;
  const lim = createAuthorityLogLimiter({ windowMs: 1000, perKey: 2, perVenueAnonymous: 3, global: 5, now: () => t });
  const k = { fn: 'loyalty-earn', reason: 'anonymous_no_device', callerId: 'a', locationId: 'L', anonymous: true };
  assert.equal(lim.admit(k).write, true);
  assert.equal(lim.admit(k).write, true);
  assert.equal(lim.admit(k).write, false, 'per caller cap');
  assert.equal(lim.admit({ ...k, callerId: 'b' }).write, true);
  assert.equal(lim.admit({ ...k, callerId: 'c' }).write, false, 'anonymous flood against one venue is sampled');
  assert.equal(lim.admit({ ...k, anonymous: false, callerId: 'staff-x' }).write, true, 'a signed in caller is not caught by the venue sample');
  assert.equal(lim.admit({ ...k, fn: 'gift-redeem', callerId: 'z' }).write, true);
  assert.equal(lim.admit({ ...k, fn: 'gift-list', callerId: 'y' }).write, false, 'global cap');
  t = 1500;
  const next = lim.admit(k);
  assert.equal(next.write, true, 'a new window');
  assert.equal(next.suppressedBefore, 1, 'what was dropped rides on the next row');
  assert.ok(lim.suppressedTotal() >= 3);

  const u = code(read('../../supabase/functions/_shared/loyalty-utils.ts'));
  assert.ok(u.includes('export function recordAuthority(row: Record<string, unknown>): void {'), 'returns at once');
  assert.ok(u.includes('rt.waitUntil(job)'), 'the insert runs after the response');
  for (const f of ['loyalty-earn', 'gift-redeem', 'gift-list', 'gift-lookup', 'gift-reverse-redeem', 'gift-fulfill']) {
    assert.ok(!fnSrc(f).includes('await recordAuthority('), `${f} does not wait on the log`);
  }
  const row = authorityLogRow({ fn: 'x', mode: 'report', outcome: 'would_refuse', decision: { ok: false }, user: anon, deviceHint: '66666666-6666-4666-8666-666666666666' });
  assert.equal(row.detail.device_hint, '66666666-6666-4666-8666-666666666666');
  assert.equal(authorityLogRow({ fn: 'x', mode: 'report', outcome: 'would_refuse', decision: { ok: false }, user: anon, deviceHint: "x' or 1=1" }).detail, null, 'a hint that is not an id is dropped');
});

test('the log has a retention purge and a read only report grouped by function, reason and venue', () => {
  const sql = read('../../supabase/migrations/20260918_OPS_caller_authority_log.sql');
  assert.ok(sql.includes('create or replace function public.purge_caller_authority_log(p_keep_days integer default 30)'));
  assert.ok(sql.includes('revoke all on function public.purge_caller_authority_log(integer) from public, anon, authenticated;'));
  assert.ok(sql.includes('ops_location_id  uuid') && sql.includes('venue_name       text'));
  assert.ok(!/\bbegin;|\bcommit;/i.test(sql), 'no transaction wrapper (the SQL editor chokes on it)');
  const rep = read('../../supabase/queries/caller_authority_report.sql');
  assert.ok(!/\b(insert|update|delete|drop|alter|create)\b/i.test(code(rep).replace(/--.*$/gm, '')), 'read only');
  assert.ok(rep.includes("coalesce(l.name, a.venue_name, a.location_id, '(no venue sent)')   as venue,"), 'one venue name for ops and platform ids');
  assert.ok(rep.includes('group by 1, 2, 3, 4, 5, 6, 7'), 'by venue, function, reason ...');
  assert.ok(rep.includes("left join public.devices d\n       on d.id::text = a.detail->>'device_hint'"), 'names the till or kiosk to re-pair');
  // The till sends its own id as device_hint.
  assert.ok(read('./supabase.js').includes('export const localDeviceHint = () => {'));
  assert.ok(read('../store/index.js').includes('const payload = hint && !body.device_hint ? { ...body, device_hint: hint } : body;'));
});

// ── E. GB and US phones ───────────────────────────────────────────────────────
test('owners see their cards: GB and US numbers match on their digits, no invented country code', () => {
  // GB
  assert.ok(phonesMatch('+44 (0) 7931 123456', '+447931123456'), 'the bracketed trunk 0');
  assert.ok(phonesMatch('07931 123 456', '+447931123456'));
  assert.ok(phonesMatch('447931123456', '+447931123456'));
  assert.ok(phonesMatch('7931 123456', '+447931123456'), 'typed without the 0');
  // US
  assert.ok(phonesMatch('(415) 555-0123', '+14155550123'));
  assert.ok(phonesMatch('415.555.0123', '+14155550123'));
  assert.ok(phonesMatch('1 415 555 0123', '+14155550123'));
  assert.ok(phonesMatch('+1 (415) 555-0123', '+14155550123'));
  // never across countries
  assert.equal(phonesMatch('07021234567', '+17021234567'), false, 'a trunk 0 is never a US number');
  assert.equal(phonesMatch('+447021234567', '+17021234567'), false);
  assert.equal(phonesMatch('(702) 555-4567', '+447025554567'), false, 'a US shaped number is not a UK one');
  assert.ok(phonesMatch('(702) 555-4567', '+17025554567'));
  assert.equal(phonesMatch('123456', '+44123456'), false, 'too short to mean anything');
  assert.equal(phonesMatch(null, '+14155550123'), false);
  // other countries written in full, or nationally with a trunk 0
  assert.ok(phonesMatch('06 12 34 56 78', '+33612345678'));
  assert.equal(phoneShape('+44 (0) 7931 123456').nsn, '7931123456');

  // the card match uses it
  assert.ok(cardBelongsToPhone({ recipient_phone: '(415) 555-0123' }, '+14155550123'), 'US card reaches its owner');
  assert.ok(cardBelongsToPhone({ recipient_phone: '+44 (0) 7931 123456' }, '+447931123456'));
  assert.equal(cardBelongsToPhone({ recipient_phone: '(415) 555-0199' }, '+14155550123'), false);
  // and the wide net fetches it
  assert.equal(giftCardRecipientFilter('+14155550123'), 'recipient_phone.ilike.%4%1%5%5%5%5%0%1%2%3%');
  assert.equal(giftCardRecipientFilter('+447931123456'), 'recipient_phone.ilike.%7%9%3%1%1%2%3%4%5%6%');
  // the app's own normaliser is unchanged (customers.phone is written with it)
  assert.equal(normaliseMemberPhone('07931 123 456'), '+447931123456');
});
