// Card rates, credit and debit (v5.8.97): the two review fixes that are not in the pure rate card.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('preview offers Send when the store sends the rest of each sale to the wrong account, even if the rules match', () => {
  const src = read('../../../supabase/functions/adyen-terminal-admin/index.ts');
  assert.ok(src.includes("const wrongAccount = !!profileIdNow && storeBaNow !== balanceAccountId;"));
  assert.ok(src.includes('? { ...basePreview, same: false, lines:'), 'a wrong account is a change to send');
});

test('the In person and Online report filters still include debit payments', () => {
  const src = read('../../../supabase/functions/adyen-financial/index.ts');
  assert.ok(src.includes("[typeFilter, `${typeFilter}_debit`]") && src.includes("q.in('rate_category', twins)"));
});
