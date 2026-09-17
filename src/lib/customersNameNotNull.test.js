// customers.name is NOT NULL (Ops DB). Every edge function that creates or edits a customer must
// never write a null name, or the row is refused. A null here stopped every new loyalty sign up
// ("Failed to resolve customer", 17 Sep 2026) and every nameless delivery app customer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('loyalty sign up creates the customer with an empty name, never null', () => {
  const src = read('../../supabase/functions/loyalty-otp/index.ts');
  assert.ok(!/name:\s*null/.test(src), 'no customer insert writes name: null');
  assert.ok(src.includes("name: '',"), 'new sign up stores an empty name');
  assert.ok(src.includes('updates.name = body.name.trim();') && !src.includes('updates.name = body.name.trim() || null'), 'a cleared name is saved empty, not null');
  assert.ok(src.includes("if (insErr) {") && src.includes(".eq('phone', phone)"), 'a lost race re reads the customer instead of failing');
});

test('delivery app customers are created with an empty name when the order has none', () => {
  const src = read('../../supabase/functions/_shared/hubrise-ingest.ts');
  assert.ok(src.includes("name: name || '',"), 'hubrise insert never writes a null name');
});
