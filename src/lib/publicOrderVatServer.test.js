// publicOrderVatServer.test.js: the server books the VAT of a public order itself (20261009a), and
// the customer pages can read the venue's rates (20261009b).
// Run: `npm test`, or `node --test src/lib/publicOrderVatServer.test.js`.
//
// 8 Oct 2026 (VAT audit): Preston QR-4OGI7 (4.85) was booked with NO VAT because the page sent
// none and the server had no tax maths of its own. The maths themselves are proved on a local
// PostgreSQL with the real function texts (supabase/tests/public_order_vat/run.mjs, D8). This
// file pins what node can check without a database: the guard constants are the live texts' md5s,
// the alias table in SQL mirrors src/lib/taxRule.js, the rule is written where it must be, and
// the rollback and policy files are whole.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TAX_ORDER_TYPE_ALIASES } from './taxRule.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');
const MIG = read('../../supabase/migrations/20261009a_OPS_public_order_vat_server.sql');
const ROLL = read('../../supabase/migrations/20261009a_OPS_public_order_vat_server_ROLLBACK.sql');
const POL = read('../../supabase/migrations/20261009b_OPS_tax_rates_public_read.sql');
const POL_ROLL = read('../../supabase/migrations/20261009b_OPS_tax_rates_public_read_ROLLBACK.sql');
const LIVE_DIR = '../../supabase/tests/public_order_vat/live/';

// pg_proc.prosrc is exactly the text between the dollar quotes of CREATE FUNCTION.
const bodyOf = (sqlText) => {
  const a = sqlText.indexOf('$function$') + '$function$'.length;
  const b = sqlText.lastIndexOf('$function$');
  return sqlText.slice(a, b);
};
const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');

test('the guard constants are the md5 of the live function bodies this file was written against', () => {
  const row = md5(bodyOf(read(LIVE_DIR + '_public_order_check_row.20261002b.sql')));
  const tab = md5(bodyOf(read(LIVE_DIR + 'settle_qr_tab.20260927c.sql')));
  assert.equal(row, '767b8354a392322aaa6857055cbf9961', '_public_order_check_row as 20261002b left it');
  assert.equal(tab, '6a335ccfad4f783e2a9cb9b88928c1bb', 'settle_qr_tab as 20260927c left it');
  assert.ok(MIG.includes(`md5(v_row) <> '${row}' and position('20261009a' in v_row) = 0`), 'the guard checks the check row text, or its own version');
  assert.ok(MIG.includes(`md5(v_tab) <> '${tab}' and position('20261009a' in v_tab) = 0`), 'the guard checks the tab text, or its own version');
  // and the live text we carry really is those versions
  assert.ok(read(LIVE_DIR + '_public_order_check_row.20261002b.sql').includes('20261002b: THE VAT'));
  assert.ok(read(LIVE_DIR + 'settle_qr_tab.20260927c.sql').includes('20260927c: THE VAT'));
});

test('the rollback restores both live bodies byte for byte and drops the helpers', () => {
  const rowBody = bodyOf(read(LIVE_DIR + '_public_order_check_row.20261002b.sql'));
  const tabBody = bodyOf(read(LIVE_DIR + 'settle_qr_tab.20260927c.sql'));
  assert.ok(ROLL.includes(`as $fn$${rowBody}$fn$;`), 'the check row body is the live text');
  assert.ok(ROLL.includes(`as $fn$${tabBody}$fn$;`), 'the tab body is the live text');
  for (const fn of ['_public_order_vat(text, jsonb, text, numeric)', '_vat_for_lines(jsonb, jsonb, jsonb, text, numeric)', '_vat_order_type_key(text)', '_vat_round(numeric)']) {
    assert.ok(ROLL.includes(`drop function if exists public.${fn};`), `drops ${fn}`);
    assert.ok(MIG.includes(`revoke all on function public.${fn} from public, anon, authenticated;`), `${fn} is not callable from a phone`);
  }
  assert.ok(ROLL.includes("md5(p.prosrc) = '767b8354a392322aaa6857055cbf9961'") && ROLL.includes("md5(q.prosrc) = '6a335ccfad4f783e2a9cb9b88928c1bb'"), 'the visible check proves the old texts are back');
});

test('the SQL alias table mirrors taxRule.js TAX_ORDER_TYPE_ALIASES (change both together)', () => {
  const fn = MIG.slice(MIG.indexOf('create or replace function public._vat_order_type_key'), MIG.indexOf('$fn$;', MIG.indexOf('create or replace function public._vat_order_type_key')));
  for (const [from, to] of Object.entries(TAX_ORDER_TYPE_ALIASES)) {
    assert.match(fn, new RegExp(`when '${from}'\\s+then '${to}'`), `${from} -> ${to}`);
  }
  const whens = [...fn.matchAll(/when '([a-z-]+)'\s+then '([a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(whens.sort(), Object.keys(TAX_ORDER_TYPE_ALIASES).sort(), 'no alias in SQL that the till does not have');
  assert.ok(MIG.includes("MIRROR of src/lib/taxRule.js"), 'the SQL says where its twin lives');
});

test('the rule is written where it must be: one rounding, one share, never null at a venue with rates', () => {
  // one rounding (D3): half up to the penny, once, on the summed raw VAT after the share
  // 8 Oct 2026 (review): clamped to 8 decimals first (the till clamps pence to 6), so a numeric
  // quotient a hair under a half penny (8.30 at 20% with a 10% deal: 1.24499999999999997) rounds UP
  // to 1.25 as the till does, never down to 1.24.
  assert.ok(MIG.includes('select round(round(coalesce(p, 0), 8), 2);'), '_vat_round clamps to 8 decimals, then rounds half up to 2 places');
  assert.ok(MIG.includes(`'[{"itemId":"m-1790046914854_8e52e0fa","price":8.3,"qty":1}]', v_menu, v_rates, 'dine-in', 0.9) ->> 'total_tax')::numeric <> 1.25`), 'the self test pins the discounted half penny at 1.25');
  assert.ok(MIG.includes(`'{"order_pricing": {"goods_minor": 830, "auto_minor": 83}}'::jsonb);`), 'and the check row books it from the server\'s own order_pricing');
  assert.ok(MIG.includes('v_total_tax := public._vat_round(v_sum_tax * v_share);'), 'rounded once, after the share (taxShare.scaleTaxRecord then roundVat)');
  // the within 1p rule, and the server's figure otherwise, said so (D8)
  assert.equal((MIG.match(/abs\(v_page - \(v_srv ->> 'total_tax'\)::numeric\) <= 0\.01/g) || []).length, 2, 'both functions keep a page figure within 1p');
  assert.equal((MIG.match(/'reason', case when v_page is null then 'page-sent-none' else 'page-differs' end/g) || []).length, 2, 'both say why the server figure was booked');
  assert.equal((MIG.match(/'booked', 'server'/g) || []).length, 2);
  // the fallbacks (D4) are the till's words
  for (const reason of ['rate-not-found', 'override-rate-not-found', 'item-not-on-menu', 'custom-item', 'no-default-rate']) {
    assert.ok(MIG.includes(`'${reason}'`), reason);
  }
  assert.ok(MIG.includes("'source', 'fallback', 'reason', v_note,"), 'the fallback note has the shape taxRule.taxFallbackNote writes');
  // a size inherits the parent's rule the way the till does
  assert.ok(MIG.includes("if p is not null and v_ov = '{}'::jsonb then"), 'a size with no overrides reads its parent');
  // the self test carries the 14 live sales and the fault itself
  for (const ref of ['QR-N2IYX', 'QR-HAFUU', 'QR-186RY', 'QR-2ODON', 'QR-6CYF8', 'QR-PVON8', 'QR-FAUOB', 'QR-8IFJ5', 'QR-J99J4', 'QR-9AWBI', 'QR-6ZVYQ', 'QR-4OGI7', 'QR-WBDGS', 'QR-I6BI0']) {
    assert.ok(MIG.includes(`"ref":"${ref}"`), `${ref} is in the self test`);
  }
  assert.ok(MIG.includes('{"ref":"QR-186RY","vat":0.98,'), 'the half penny is 0.98 under the one rule');
  assert.ok(MIG.includes('{"ref":"QR-4OGI7","vat":0.81,'));
  assert.ok(MIG.includes("if v_n <> 14 then raise exception"));
  // the headers say who runs it
  assert.ok(MIG.includes('Peter runs this by hand') && POL.includes('Peter runs this by hand'));
});

test('the pages and the server agree on the shape of a record (source, booked, fallbacks)', () => {
  // The Xero daily invoice and the reports read tax_breakdown.breakdown[].rate.{id, rate, type}
  // and totalTax; the server writes exactly those keys, with the till's names.
  for (const key of ["'subtotal'", "'totalTax'", "'total'", "'exclusiveTax'", "'breakdown'", "'hasExclusiveTax'", "'source', 'server'"]) {
    assert.ok(MIG.includes(key), key);
  }
  for (const key of ["'id', k, 'code'", "'rate', trim_scale(v_pct)", "'type', coalesce(v_rate ->> 'type', 'inclusive')", "'isDefault'", "'appliesTo'", "'locationId'"]) {
    assert.ok(MIG.includes(key), key);
  }
});

test('20261009b lifts the tax_rates read policy of 20260907b, reads only, with its rollback', () => {
  const fence = read('../../supabase/migrations/20260907b_ops_rls_1_fences_and_rpcs.sql');
  assert.ok(fence.includes('create policy tax_rates_read on public.tax_rates\n  for select using (true);'), 'the policy as 20260907b wrote it');
  assert.ok(POL.includes('drop policy if exists tax_rates_read on public.tax_rates;\ncreate policy tax_rates_read on public.tax_rates\n  for select using (true);'), 'lifted as is');
  assert.doesNotMatch(POL, /for (all|insert|update|delete)/i, 'reads only: no write policy is touched');
  assert.doesNotMatch(POL, /drop policy if exists "Allow authenticated access"/, 'the existing policies stay');
  assert.ok(POL_ROLL.includes('drop policy if exists tax_rates_read on public.tax_rates;'));
  assert.doesNotMatch(POL_ROLL, /create policy/);
});

test('house style: no em or en dashes on screen or in the SQL', () => {
  for (const [name, text] of [['migration', MIG], ['rollback', ROLL], ['policy', POL], ['policy rollback', POL_ROLL]]) {
    assert.doesNotMatch(text, /[–—]/, `${name} has no em or en dash`);
  }
});
