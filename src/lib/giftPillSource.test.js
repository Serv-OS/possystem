// src/lib/giftPillSource.test.js (29 Oct 2026, v5.11.114): the Back Office Gift cards pill reads the
// same answer the public gift page reads (gift-branding-public), never the Platform table directly,
// whose row policy hides the row from the Back Office login and left the pill OFF at a venue that was ON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Online ordering gift pill asks gift-branding-public, not gift_brand_config', () => {
  const src = readFileSync(new URL('../backoffice/sections/OnlineOrdering.jsx', import.meta.url), 'utf8');
  assert.ok(src.includes("callGiftPublic('gift-branding-public', { company_id: row.company_id })"));
  assert.ok(src.includes('setGiftOn(!!g?.enabled)'));
  assert.ok(!src.includes("from('gift_brand_config')"), 'no direct read of the fenced table');
});
