// src/lib/reviewLink.test.js: review ask texts link to the venue's ServOS address (5.12.44).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reviewCardLink } from '../../supabase/functions/_shared/reviewLink.js';

test('a venue slug links to its own ServOS review page', () => {
  assert.equal(reviewCardLink('habitum'), 'https://habitum.serv-os.app/review');
  assert.equal(reviewCardLink('coffee-boy-leeds'), 'https://coffee-boy-leeds.serv-os.app/review');
  assert.equal(reviewCardLink(' Habitum '), 'https://habitum.serv-os.app/review');
});

test('the dev tier root can be set', () => {
  assert.equal(reviewCardLink('habitum', 'dev.serv-os.app'), 'https://habitum.dev.serv-os.app/review');
  assert.equal(reviewCardLink('habitum', 'https://dev.serv-os.app/'), 'https://habitum.dev.serv-os.app/review');
});

test('a slug that cannot be a subdomain falls back to the app address', () => {
  assert.equal(reviewCardLink('app'), 'https://app.serv-os.app/?loc=app&surface=review');
  assert.equal(reviewCardLink('cafe_one'), 'https://app.serv-os.app/?loc=cafe_one&surface=review');
  assert.equal(reviewCardLink(''), null);
  assert.equal(reviewCardLink(null), null);
});

test('the review sender never uses the old temporary address', () => {
  const src = readFileSync(new URL('../../supabase/functions/review-request/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /possystem-liard/);
  assert.match(src, /reviewCardLink\(slug, CARD_ROOT\)/);
});
