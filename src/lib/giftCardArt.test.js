// Peter, 18 Sep 2026: "on the back end we have this artwork you can upload for gift
// cards but it doesnt show on the front end". Back Office saved it as
// online_branding.gift.card_art_url and nothing on the customer side read it. The
// preview also showed a fixed £25/£50/£75 while the live page showed six other amounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildGiftTheme, giftPresetsFor, normaliseGiftLimits, GIFT_DEFAULT_LIMITS, PRESET_AMOUNTS } from '../surfaces/gift/giftTheme.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('the theme carries the gift card art saved in Back Office', () => {
  const t = buildGiftTheme({ name: 'Coffee Boy', online_branding: { gift: { card_art_url: 'https://x/art.jpg' } } });
  assert.equal(t.cardArt, 'https://x/art.jpg');
  assert.equal(buildGiftTheme({ name: 'x', online_branding: {} }).cardArt, null);
  assert.equal(buildGiftTheme({ name: 'x', online_branding: { gift: { card_art_url: 'javascript:alert(1)' } } }).cardArt, null, 'only http(s)');
});

test('the live page shows the art', () => {
  const page = read('../surfaces/gift/GiftPurchaseSurface.jsx');
  assert.ok(page.includes('{t.cardArt && ('), 'rendered when set');
  assert.ok(page.includes('src={t.cardArt}'));
});

test('presets are the standard list without any the checkout would refuse', () => {
  assert.deepEqual(giftPresetsFor(GIFT_DEFAULT_LIMITS), PRESET_AMOUNTS);
  assert.deepEqual(giftPresetsFor({ minMinor: 2000, maxMinor: 5000 }), [2000, 2500, 5000]);
  assert.deepEqual(giftPresetsFor({ minMinor: 20000, maxMinor: 30000 }), [20000], 'never empty');
});

test('limits default exactly as gift-checkout-session enforces them', () => {
  assert.deepEqual(normaliseGiftLimits(null), { minMinor: 500, maxMinor: 50000 });
  assert.deepEqual(normaliseGiftLimits({ min_minor: 1000, max_minor: 20000 }), { minMinor: 1000, maxMinor: 20000 });
  assert.deepEqual(normaliseGiftLimits({ min_minor: 9000, max_minor: 100 }), { minMinor: 500, maxMinor: 50000 }, 'nonsense falls back');
  const fn = read('../../supabase/functions/gift-checkout-session/index.ts');
  assert.ok(fn.includes('config.min_card_value_minor || 500') && fn.includes('config.max_card_value_minor || 50000'), 'the same defaults as the checkout');
});

test('the Back Office preview uses the same art, amounts and limits as the live page', () => {
  const bo = read('../backoffice/sections/MenuAppearance.jsx');
  assert.ok(!bo.includes("['£25', '£50', '£75']"), 'no fixed amounts');
  assert.ok(bo.includes('giftPresetsFor(limits)') && bo.includes('fetchGiftLimits(companyId)'));
  assert.ok(bo.includes('const cardArt = t.cardArt;'));
  const pub = read('../../supabase/functions/gift-branding-public/index.ts');
  assert.ok(pub.includes('min_minor: data?.min_card_value_minor') && pub.includes('max_minor: data?.max_card_value_minor'), 'the public call passes the limits');
});

test('gift card art is company wide: saving it copies it to the company gift settings, merged', () => {
  const bo = read('../backoffice/sections/MenuAppearance.jsx');
  const i = bo.indexOf('export async function syncCompanyGiftArt(');
  const fn = bo.slice(i, bo.indexOf('\n}\n', i));
  assert.ok(fn.includes("action: 'get'") && fn.includes("action: 'branding'"), 'reads then writes the company config');
  assert.ok(fn.includes('{ ...current, card_art_url: next }'), 'merges over the current company branding');
  assert.ok(fn.includes("return 'no_gift_cards'"), 'a company without gift cards is left alone');
  const save = bo.slice(bo.indexOf('const saveAll = async () => {'), bo.indexOf('if (loading) return'));
  assert.ok(save.indexOf('syncCompanyGiftArt(opsLocId') > save.indexOf('patchBranding(opsLocId'), 'after the site save');
});

test('a site with no art of its own falls back to the company art', () => {
  const t = buildGiftTheme({ name: 'Coffee Boy Leeds', online_branding: {} }, { card_art_url: 'https://x/company-art.jpg' });
  assert.equal(t.cardArt, 'https://x/company-art.jpg');
  const own = buildGiftTheme({ name: 'Preston', online_branding: { gift: { card_art_url: 'https://x/preston.jpg' } } }, { card_art_url: 'https://x/company-art.jpg' });
  assert.equal(own.cardArt, 'https://x/preston.jpg', 'a site\'s own art wins');
});
