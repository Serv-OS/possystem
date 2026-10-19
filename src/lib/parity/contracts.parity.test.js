// contracts.parity.test.js: what v5.11.78 must never change, and how its SQL is shaped.
// Run: node --test src/lib/parity/contracts.parity.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kioskLineTaxRefs } from '../kioskLine.js';
import { cartUnitPrice } from '../menuPricing.js';
import { STORE_MENU } from './fixtures.js';
import { readRepo } from './src.js';

// The kiosk's tax references as they were on v5.11.75, verbatim (kioskLine.js). The card path is
// signed (kioskCardPathGuard): the kiosk now calls the shared size rule, and every figure it
// produces must be the same, apart from ONE change Peter signed off on 19 Oct 2026 (v5.11.81): a
// size with no tax profile of its own no longer takes its product's (the till's rule).
function oldKioskLineTaxRefs(l) {
  const item = l?.item || {};
  const v = l?.variant || null;
  const own = (row) => ({
    rate: row?.taxRateId ?? row?.tax_rate_id ?? null,
    ov: row?.taxOverrides ?? row?.tax_overrides ?? null,
    profile: row?.taxProfileId ?? row?.tax_profile_id ?? null,
  });
  const parent = own(item);
  if (!v) return { taxRateId: parent.rate || null, taxOverrides: parent.ov || {}, taxProfileId: parent.profile || null };
  const child = own(v);
  let taxRateId = child.rate || null;
  let taxOverrides = child.ov && typeof child.ov === 'object' ? child.ov : {};
  if (Object.keys(taxOverrides).length === 0) {
    taxOverrides = parent.ov && typeof parent.ov === 'object' ? parent.ov : {};
    if (!taxRateId) taxRateId = parent.rate || null;
  }
  return { taxRateId, taxOverrides, taxProfileId: child.profile || parent.profile || null };
}

test('the kiosk\'s tax references are exactly what they were, on every row shape (bar the v5.11.81 size profile rule)', () => {
  const rates = [null, 'r20', 'r5'];
  const ovs = [null, {}, { takeaway: 'r0' }];
  const profiles = [null, 'p1'];
  let n = 0;
  let m = 0;
  for (const pr of rates) for (const pov of ovs) for (const pp of profiles)
    for (const cr of rates) for (const cov of ovs) for (const cp of profiles) for (const sized of [true, false]) {
      const item = { id: 'p', tax_rate_id: pr, tax_overrides: pov, tax_profile_id: pp };
      const variant = sized ? { id: 'c', taxRateId: cr, taxOverrides: cov, taxProfileId: cp } : null;
      const l = { item, variant };
      const was = oldKioskLineTaxRefs(l);
      // v5.11.81: a size's own profile, never its product's (the till's rule); every other field as was.
      const want = sized ? { ...was, taxProfileId: cp || null } : was;
      assert.deepEqual(kioskLineTaxRefs(l), want, JSON.stringify(l));
      if (sized && !cp && pp) { assert.equal(was.taxProfileId, pp); m++; }
      n++;
    }
  assert.equal(n, 648);
  assert.equal(m, 81, 'the only rows that move: a size with no profile under a product with one');
});

test('the till line price helper is the till\'s own call, with its fallback', async () => {
  const { tillLineUnitPrice } = await import('../tillLine.js');
  for (const row of STORE_MENU) for (const ch of ['dine-in', 'takeaway', 'drive-thru', 'bar-tab']) for (const m of [null, 'bar', 'lunch']) {
    for (const lp of [null, undefined, 7.5]) assert.equal(tillLineUnitPrice(row, ch, m, lp, 3), cartUnitPrice(row, ch, m, lp, 3));
  }
});

test('migration 20261019a: ASCII only, one transaction, a guard, a visible check, and a rollback that puts back every function', () => {
  const fwd = readRepo('supabase/migrations/20261019a_OPS_channel_parity.sql');
  const back = readRepo('supabase/migrations/20261019a_OPS_channel_parity_ROLLBACK.sql');
  for (const [name, sql] of [['forward', fwd], ['rollback', back]]) {
    assert.equal([...sql].filter((ch) => ch.charCodeAt(0) > 127).length, 0, `${name}: ASCII only`);
    assert.match(sql, /^begin;$/m, `${name}: one transaction`);
    assert.match(sql, /^commit;$/m, name);
    assert.match(sql, /This (migration )?must be run against the OPS DB/, `${name}: the guard`);
    assert.match(sql, /\nselect\n[\s\S]+;\s*$/, `${name}: ends with the visible check`);
  }
  for (const fn of ['_public_order_check_row', 'settle_qr_tab', '_public_order_value']) {
    assert.match(fwd, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`), `forward replaces ${fn}`);
    assert.match(back, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`), `rollback restores ${fn}`);
  }
  assert.match(fwd, /create or replace function public\._order_line_folded\(p_line jsonb\)/);
  assert.match(back, /drop function if exists public\._order_line_folded\(jsonb\);/);
  assert.match(fwd, /revoke execute on function public\._order_line_folded\(jsonb\) from public, anon, authenticated;/, 'the helper is never callable from a browser');
  // Never a live tax calculation (central_tax_constraints.md): no new tax maths in the file.
  assert.doesNotMatch(fwd.replace(/CREATE OR REPLACE FUNCTION public\.(_public_order_check_row|settle_qr_tab|_public_order_value)\([\s\S]+?\$function\$;/g, ''), /_vat_for_lines|_public_order_vat\(/);
});

test('migration 20261020a: ASCII only, one transaction, a guard, a visible check, and a rollback that puts back every function it replaced', () => {
  const fwd = readRepo('supabase/migrations/20261020a_OPS_channel_parity_2.sql');
  const back = readRepo('supabase/migrations/20261020a_OPS_channel_parity_2_ROLLBACK.sql');
  for (const [name, sql] of [['forward', fwd], ['rollback', back]]) {
    assert.equal([...sql].filter((ch) => ch.charCodeAt(0) > 127).length, 0, `${name}: ASCII only`);
    assert.match(sql, /^begin;$/m, `${name}: one transaction`);
    assert.match(sql, /^commit;$/m, name);
    assert.match(sql, /This (migration )?must be run against the OPS DB/, `${name}: the guard`);
    assert.match(sql, /\nselect\n[\s\S]+;\s*$/, `${name}: ends with the visible check`);
  }
  for (const fn of ['_vat_for_lines', '_public_order_value', 'settle_qr_tab']) {
    assert.match(fwd, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`), `forward replaces ${fn}`);
    assert.match(back, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`), `rollback restores ${fn}`);
  }
  for (const fn of ['promo_release_atomic', 'venue_service_rule', '_menu_item_has_price']) {
    assert.match(fwd, new RegExp(`create or replace function public\\.${fn}\\(`), `forward adds ${fn}`);
    assert.match(back, new RegExp(`drop function if exists public\\.${fn}\\(`), `rollback drops ${fn}`);
  }
  assert.match(fwd, /alter table public\.promo_redemptions add column if not exists released_at timestamptz;/, 'additive, safe to run twice');
  assert.match(back, /alter table public\.promo_redemptions drop column if exists released_at;/);
  // Who may call what: the give back only through promo-redeem (service role), the rule by a QR guest.
  assert.match(fwd, /revoke all on function public\.promo_release_atomic\(text, text\[\], text, text\) from anon, authenticated;/);
  assert.match(fwd, /grant execute on function public\.venue_service_rule\(uuid\) to anon, authenticated, service_role;/);
  assert.match(fwd, /revoke all on function public\._menu_item_has_price\(jsonb, text, text\) from anon, authenticated;/);
  // Never a live tax calculation (central_tax_constraints.md).
  assert.doesNotMatch(fwd, /_vat_for_lines\(p_lines, v_menu/i, 'no new caller of the VAT maths');
});
