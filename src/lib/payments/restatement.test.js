/**
 * restatement.test.js: the SQL Peter runs to make the past match the bank
 * (supabase/data_fixes/20261015_PLATFORM_adyen_rates_restatement.sql), checked
 * as arithmetic and as text.
 *
 * The arithmetic is mirrored here exactly as the SQL writes it:
 *   floor(amount_minor * percent_bp / 10000 + 0.5) + fixed_minor
 * and the same formula is what adyenRules.feeFor applies to a legacy charge,
 * so the webhook's backfill and the restatement agree to the penny.
 *
 * The text checks pin the guards that make the file safe to run twice: live
 * rows only, before the venue's cutover only, fee_rule null only, the marker
 * written, the old figures kept, and no venue name or profile id in the file.
 * Run: `node --test src/lib/payments/restatement.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { feeFor, legacyCommission, stampForPayment, LEGACY_FEE_RULE } from './adyenRules.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');
const SQL = read('supabase/data_fixes/20261015_PLATFORM_adyen_rates_restatement.sql');
const DDL = read('supabase/migrations/20261015_PLATFORM_adyen_rates_cutover.sql');

// The SQL formula, line for line.
const sqlFee = (amount, bp, fixed = 0) => Math.floor((amount * bp) / 10000 + 0.5) + fixed;
const LEGACY = { percent_bp: 85, fixed_minor: 0, refund: 'none' };

test('the formula: floor(amount x 85 / 10000 + 0.5) on sample amounts, and feeFor agrees', () => {
  for (const [amount, fee] of [[100, 1], [250, 2], [955, 8], [1600, 14], [1000, 9], [7339, 62], [1, 0], [59, 1], [58, 0]]) {
    assert.equal(sqlFee(amount, 85), fee, String(amount));
    assert.equal(feeFor(amount, legacyCommission(LEGACY)), fee, String(amount));
  }
  // the demo venue's charge: 80 basis points plus 5
  assert.equal(sqlFee(1000, 80, 5), 13);
  assert.equal(feeFor(1000, legacyCommission({ percent_bp: 80, fixed_minor: 5 })), 13);
  assert.deepEqual(legacyCommission({ percent_bp: '85' }), { variablePercentage: 85, fixedAmount: 0 }, 'a number that arrives as text still counts');
  assert.deepEqual(legacyCommission({ percent_bp: 85 }), { variablePercentage: 85, fixedAmount: 0 });
  assert.equal(legacyCommission({}), null);
  assert.equal(legacyCommission(null), null);
});

test('which rows: fee_rule set is skipped; exactly rates_live_at is not restated, one second before is; a failed authorisation gets null', () => {
  const live = '2026-10-15T20:00:00Z';
  const venue = { rates_live_at: live, legacy_charge: LEGACY, adyen_rules: [] };
  // the where clause, mirrored: live, before the cutover, no fee_rule yet
  const restates = (row) => row.live === true && Date.parse(row.authorised_at) < Date.parse(live) && row.fee_rule === null;
  assert.equal(restates({ live: true, authorised_at: '2026-10-15T19:59:59Z', fee_rule: null }), true);
  assert.equal(restates({ live: true, authorised_at: live, fee_rule: null }), false);
  assert.equal(restates({ live: true, authorised_at: '2026-10-15T19:59:59Z', fee_rule: 'legacy_flat' }), false, 'never twice');
  assert.equal(restates({ live: true, authorised_at: '2026-10-15T19:59:59Z', fee_rule: 'adyen_rules:SC1' }), false);
  assert.equal(restates({ live: false, authorised_at: '2026-10-15T19:59:59Z', fee_rule: null }), false, 'test rows are not money');
  assert.equal(restates({ live: null, authorised_at: '2026-10-15T19:59:59Z', fee_rule: null }), false);
  // the webhook's answer for the same rows is the restatement's answer
  const facts = { currency: 'GBP', method: 'visa', variant: 'visastandarddebit', fundingSource: null, cardUsageType: 'unknown', cardRegion: null, shopperInteraction: 'POS' };
  const before = stampForPayment({ amountMinor: 955, authorisedAt: '2026-10-15T19:59:59Z', ok: true, facts }, venue, { rate_category: 'card_present', commission_minor: 9 });
  assert.deepEqual(before, { rate_category: 'card_present', commission_minor: sqlFee(955, 85), fee_rule: LEGACY_FEE_RULE, fee_refund_policy: 'none' });
  assert.equal(stampForPayment({ amountMinor: 955, authorisedAt: '2026-10-15T19:59:59Z', ok: false, facts }, venue, { rate_category: 'card_present', commission_minor: null }).commission_minor, null);
});

test('the batch: per payment half up does not land on batch gross x 0.85% exactly, and the residual is reported, not hidden', () => {
  // 850 payments shaped like the batch checked on 15 Oct 2026: gross 7339.32, bank deduction 62.38.
  let amounts = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 849; i += 1) amounts.push(Math.max(60, Math.round(300 + rnd() * 1400)));
  const target = 733932;
  const sum = amounts.reduce((s, a) => s + a, 0);
  amounts.push(Math.max(60, target - sum));
  amounts = amounts.map((a) => Math.max(1, a));
  const gross = amounts.reduce((s, a) => s + a, 0);
  const perPayment = amounts.reduce((s, a) => s + sqlFee(a, 85), 0);
  const batch = Math.round((gross * 85) / 10000);
  const residual = batch - perPayment;
  // the two differ by pence, never by pounds: this is the rounding the tie check must show
  assert.ok(Math.abs(residual) < 100, `residual ${residual}p on ${amounts.length} payments`);
  assert.notEqual(residual, 0, 'if they ever agreed exactly this test would be pointless; say so');
  // and the file says so where the tie check is
  assert.match(SQL, /pence of rounding per batch, never pounds/);
});

test('the SQL files: the guards, the marker, the kept figures, no names and no ids', () => {
  // DDL: the five columns, if not exists, commented
  for (const col of ['rates_live_at timestamptz', 'adyen_rules jsonb', 'legacy_charge jsonb', 'fee_rule text', 'fee_refund_policy text']) assert.match(DDL, new RegExp(`add column if not exists ${col}`), col);
  assert.equal((DDL.match(/comment on column/g) || []).length, 5);
  // the restatement's where clause
  const update = SQL.slice(SQL.indexOf('update public.adyen_payments p'));
  assert.match(update, /p\.live = true/);
  assert.match(update, /p\.authorised_at < v\.rates_live_at/);
  assert.match(update, /p\.fee_rule is null/);
  assert.match(update, /fee_rule = 'legacy_flat'/);
  assert.match(update, /fee_refund_policy = 'none'/);
  assert.match(update, /floor\(p\.amount_minor \* v\.bp \/ 10000 \+ 0\.5\) \+ v\.fixed/);
  assert.match(update, /case when p\.success then .* else null end/);
  assert.match(update, /'was_commission_minor', p\.commission_minor/);
  assert.match(update, /'was_rate_category', p\.rate_category/);
  assert.doesNotMatch(update, /set rate_category|rate_category =/, 'the card type chip is left as it is');
  // the venue list the update joins: live venues with both the charge and the cutover
  assert.match(SQL, /legacy_charge is not null and rates_live_at is not null/);
  // the preview select comes BEFORE the update, and the read only parts are marked
  assert.ok(SQL.indexOf('PART 2, PREVIEW') < SQL.indexOf('PART 3, THE RESTATEMENT'));
  assert.ok(SQL.indexOf('PART 0, READ ONLY') < SQL.indexOf('PART 1'));
  // the legacy charge statements are left for Peter to fill in, commented, with the profile id as a placeholder
  assert.match(SQL, /<PROFILE ID FROM PART 0>/);
  assert.match(SQL, /split_profile_id = '<PROFILE ID FROM PART 0>'/);
  // the repository is public: no profile id, no store id, no venue name, no bank figure
  for (const src of [SQL, DDL]) {
    assert.doesNotMatch(src, /SCNF[0-9A-Z]{10,}|\bST[0-9A-Z]{20,}|\bBA[0-9A-Z]{20,}|FranPOS_QSR/);
    assert.doesNotMatch(src, /Huddersfield|Barnsley|Coffee Boy|Leeds|Provo/i);
    assert.doesNotMatch(src, /7209|7202|7272|62\.38/);
    assert.doesNotMatch(src, /[–—]/, 'no dashes');
  }
});
