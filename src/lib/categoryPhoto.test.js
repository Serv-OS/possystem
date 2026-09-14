// Category photos: pure rules (lib/categoryPhoto.js).
// The two that protect data: categoryImageField never clears a photo, and
// railTileMode keeps today's text tiles when no category has a photo.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORY_PHOTO_MAX_URL,
  CATEGORY_PHOTO_MIN,
  PHOTO_MAX_BYTES,
  CATEGORY_PHOTO_COPY,
  CATEGORY_PHOTO_URL_PATTERN,
  categoryPhotoUrl,
  isMissingImageColumn,
  safeCssColor,
  tileAccentColor,
  categoryImageField,
  safeBrandHex,
  photoBlockBackground,
  railTileMode,
  tileSlot,
  checkPhotoFile,
  photoSizeWarning,
  categoryPhotoPath,
  peerPhotoTargets,
} from './categoryPhoto.js';

const URL_A = 'https://x.supabase.co/storage/v1/object/public/product-images/loc-1/categories/cat-1-1.jpg';
const URL_B = 'https://x.supabase.co/storage/v1/object/public/product-images/loc-1/categories/cat-1-2.jpg';
const URL_C = 'https://x.supabase.co/storage/v1/object/public/product-images/loc-2/categories/own-3.png';

test('categoryPhotoUrl accepts only a product-images category photo URL', () => {
  assert.equal(categoryPhotoUrl({ image: `  ${URL_A} ` }), URL_A);
  assert.equal(categoryPhotoUrl({ image: URL_C }), URL_C);
  for (const image of [
    null, undefined, '', '   ', 42,
    'http://x.co/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAA',
    'https://evil.example/a.jpg',                                                          // any other host and path
    'https://x.supabase.co/storage/v1/object/public/product-images/loc-1/item-1.jpg',      // unfenced item photo path
    'https://x.supabase.co/storage/v1/object/public/product-images/loc-1/categories/c-1.svg',
    'https://x.supabase.co/storage/v1/object/public/receipt-assets/loc-1/categories/c-1.jpg',
    'https://x.supabase.co/storage/v1/object/public/product-images/loc-1/categories/c-1.jpg?x=1',
    'https://x.supabase.co/storage/v1/object/public/product-images/a/b/categories/c-1.jpg',
    `${URL_A}\n`.replace('\n', '\nhttps://evil.example/x'),
  ]) {
    assert.equal(categoryPhotoUrl({ image }), null, `rejects ${String(image)}`);
  }
  assert.equal(categoryPhotoUrl(null), null);
  assert.equal(categoryPhotoUrl({}), null);
  const head = 'https://x.supabase.co/storage/v1/object/public/product-images/';
  const tail = '/categories/c-1.jpg';
  const exact = head + 'l'.repeat(CATEGORY_PHOTO_MAX_URL - head.length - tail.length) + tail;
  assert.equal(exact.length, 2048);
  assert.equal(categoryPhotoUrl({ image: exact }), exact);
  const over = head + 'l'.repeat(CATEGORY_PHOTO_MAX_URL - head.length - tail.length + 1) + tail;
  assert.equal(categoryPhotoUrl({ image: over }), null);
});

test('categoryPhotoUrl with an origin only shows photos from that project', () => {
  assert.equal(categoryPhotoUrl({ image: URL_A }, 'https://x.supabase.co'), URL_A);
  assert.equal(categoryPhotoUrl({ image: URL_A }, 'https://x.supabase.co/'), URL_A, 'a trailing slash is fine');
  const other = URL_A.replace('https://x.supabase.co', 'https://attacker.supabase.co');
  assert.equal(categoryPhotoUrl({ image: other }, 'https://x.supabase.co'), null);
  assert.equal(categoryPhotoUrl({ image: URL_A.replace('x.supabase.co', 'x.supabase.co.evil.io') }, 'https://x.supabase.co'), null);
});

test('every path categoryPhotoPath builds gives a URL the shape check accepts', () => {
  const re = new RegExp(CATEGORY_PHOTO_URL_PATTERN);
  for (const [loc, id, mime] of [['7218c716-1a2b-4c5d-9e8f-001122334455', 'cat-17000', 'image/jpeg'], ['loc-1', 'a/../b c', 'image/png'], ['loc-2', '', 'image/webp']]) {
    const url = `https://x.supabase.co/storage/v1/object/public/product-images/${categoryPhotoPath(loc, id, mime, 1757851200123)}`;
    assert.ok(re.test(url), url);
    assert.equal(categoryPhotoUrl({ image: url }), url);
  }
});

test('isMissingImageColumn only matches a missing image column', () => {
  assert.ok(isMissingImageColumn({ code: 'PGRST204', message: "Could not find the 'image' column of 'menu_categories' in the schema cache" }));
  assert.ok(isMissingImageColumn({ code: '42703', message: 'column menu_categories.image does not exist' }));
  assert.ok(!isMissingImageColumn({ code: 'PGRST204', message: "Could not find the 'tax_profile_id' column of 'menu_categories' in the schema cache" }));
  assert.ok(!isMissingImageColumn({ code: '23514', message: 'new row violates check constraint "menu_categories_image_shape"' }));
  assert.ok(!isMissingImageColumn({ message: 'Failed to fetch' }));
  assert.ok(!isMissingImageColumn(null));
});

test('categoryImageField writes the photo only when one is present', () => {
  assert.deepEqual(categoryImageField({ id: 'c1', label: 'Beer' }), {}, 'before the migration: no key, nothing sent');
  assert.deepEqual(categoryImageField({ id: 'c1', image: null }), {}, 'a stale tab holding null never clears');
  assert.deepEqual(categoryImageField({ id: 'c1', image: '' }), {});
  assert.deepEqual(categoryImageField({ id: 'c1', image: 'http://insecure/a.jpg' }), {});
  assert.deepEqual(categoryImageField({ id: 'c1', image: URL_A }), { image: URL_A });
  assert.deepEqual(categoryImageField(undefined), {});
});

test('safeBrandHex normalises free text brand colours', () => {
  assert.equal(safeBrandHex('#15C26A'), '#15c26a');
  assert.equal(safeBrandHex(' #fff '), '#ffffff');
  assert.equal(safeBrandHex('#11223344'), '#112233');
  for (const bad of ['red', '#12345', 'rgb(1,2,3)', '', null, undefined]) {
    assert.equal(safeBrandHex(bad), '#f97316', `falls back for ${String(bad)}`);
  }
  assert.equal(safeBrandHex('nope', '#ABC'), '#aabbcc');
  assert.equal(safeBrandHex('nope', 'also bad'), '#f97316');
});

test('photoBlockBackground is a brand gradient, or a solid block for a named or rgb colour', () => {
  assert.equal(photoBlockBackground('#fff'), 'linear-gradient(135deg, #ffffff, #ffffff99)');
  assert.equal(photoBlockBackground('red'), 'red', 'the same colour text tiles use');
  assert.equal(photoBlockBackground('rgb(21,194,106)'), 'rgb(21,194,106)');
  for (const bad of ['url(https://evil.example/x.png)', 'red; background:url(x)', '', null, undefined]) {
    assert.equal(photoBlockBackground(bad), 'linear-gradient(135deg, #f97316, #f9731699)', `falls back for ${String(bad)}`);
  }
});

test('safeCssColor and tileAccentColor accept colours and nothing else', () => {
  assert.equal(safeCssColor('#15C26A'), '#15c26a');
  assert.equal(safeCssColor(' Red '), 'red');
  assert.equal(safeCssColor('hsl(150, 80%, 42%)'), 'hsl(150, 80%, 42%)');
  assert.equal(safeCssColor('rgba(1,2,3,0.5)'), 'rgba(1,2,3,0.5)');
  for (const bad of ['url(x)', 'expression(alert(1))', 'red;', '#12345', '', null, 7]) {
    assert.equal(safeCssColor(bad), null, `rejects ${String(bad)}`);
  }
  assert.equal(tileAccentColor('red'), 'red');
  assert.equal(tileAccentColor('url(x)'), '#f97316');
});

test('railTileMode keeps text tiles unless the switch is on and a photo exists', () => {
  const withPhoto = [{ id: 'a' }, { id: 'b', image: URL_A }];
  assert.equal(railTileMode(false, withPhoto), 'text', 'switch off');
  assert.equal(railTileMode(undefined, withPhoto), 'photo', 'missing column reads as on');
  assert.equal(railTileMode(true, [{ id: 'a' }, { id: 'b', image: null }]), 'text', 'no photos');
  assert.equal(railTileMode(true, []), 'text');
  assert.equal(railTileMode(true, undefined), 'text');
  assert.equal(railTileMode(true, [{ id: 'a', image: 'http://x/a.jpg' }, { id: 'b', image: '' }]), 'text', 'only invalid URLs');
  const five = [{ id: '1' }, { id: '2' }, { id: '3', image: URL_B }, { id: '4' }, { id: '5' }];
  assert.equal(railTileMode(true, five), 'photo');
  assert.equal(railTileMode(true, five, 'https://x.supabase.co'), 'photo');
  assert.equal(railTileMode(true, five, 'https://other.supabase.co'), 'text', 'photos from another host do not count');
});

test('tileSlot gives the photo slot contents', () => {
  assert.equal(tileSlot({ image: URL_A }, 'text', '#fff'), null);
  assert.deepEqual(tileSlot({ image: URL_A }, 'photo', '#fff'), { url: URL_A, background: 'linear-gradient(135deg, #ffffff, #ffffff99)' });
  assert.deepEqual(tileSlot({ label: 'No photo' }, 'photo', '#fff'), { url: null, background: 'linear-gradient(135deg, #ffffff, #ffffff99)' });
  assert.deepEqual(tileSlot({ image: URL_A }, 'photo', '#fff', 'https://other.supabase.co'), { url: null, background: 'linear-gradient(135deg, #ffffff, #ffffff99)' }, 'another host shows the brand block');
});

test('checkPhotoFile allows JPG, PNG and WebP up to 5MB', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
    assert.equal(checkPhotoFile({ type, size: 1000 }), null);
  }
  assert.equal(checkPhotoFile({ type: 'image/jpeg', size: PHOTO_MAX_BYTES }), null);
  assert.equal(checkPhotoFile({ type: 'image/gif', size: 10 }), 'type');
  assert.equal(checkPhotoFile({ type: 'image/heic', size: 10 }), 'type');
  assert.equal(checkPhotoFile({ type: 'image/png', size: PHOTO_MAX_BYTES + 1 }), 'size');
  assert.equal(checkPhotoFile(null), 'type');
});

test('photoSizeWarning warns below 572 by 208 and never for unknown sizes', () => {
  assert.deepEqual(CATEGORY_PHOTO_MIN, { w: 572, h: 208 });
  assert.equal(photoSizeWarning(572, 208), null);
  assert.equal(photoSizeWarning(1200, 400), null);
  const w1 = photoSizeWarning(571, 208);
  assert.ok(w1 && w1.includes('571') && w1.includes('208'));
  const w2 = photoSizeWarning(572, 207);
  assert.ok(w2 && w2.includes('572') && w2.includes('207'));
  const small = photoSizeWarning(400, 150);
  assert.ok(small.includes('400') && !small.includes('tall'), 'wide but small: size note only');
  const tall = photoSizeWarning(1200, 1600);
  assert.equal(tall, CATEGORY_PHOTO_COPY.tallWarning, 'big portrait photo: tall note only');
  const both = photoSizeWarning(300, 400);
  assert.ok(both.includes('300') && both.includes(CATEGORY_PHOTO_COPY.tallWarning));
  assert.equal(photoSizeWarning(900, 600), null, 'ratio 1.5 is fine');
  assert.equal(photoSizeWarning(0, 0), null);
  assert.equal(photoSizeWarning(NaN, 300), null);
  assert.equal(photoSizeWarning(undefined, undefined), null);
});

test('categoryPhotoPath builds a fenced, unique path', () => {
  assert.equal(categoryPhotoPath('loc', 'cat-1', 'image/jpeg', 1700), 'loc/categories/cat-1-1700.jpg');
  assert.equal(categoryPhotoPath('loc', 'cat-1', 'image/png', 1700), 'loc/categories/cat-1-1700.png');
  assert.equal(categoryPhotoPath('loc', 'cat-1', 'image/webp', 1700), 'loc/categories/cat-1-1700.webp');
  assert.equal(categoryPhotoPath('loc', 'cat-1', 'image/gif', 1700), null);
  assert.equal(categoryPhotoPath('loc-demo', 'cat-1', 'image/jpeg', 1700), null);
  assert.equal(categoryPhotoPath('', 'cat-1', 'image/jpeg', 1700), null);
  assert.equal(categoryPhotoPath(null, 'cat-1', 'image/jpeg', 1700), null);
  const tricky = categoryPhotoPath('7218c716-aaaa', 'a/../b', 'image/jpeg', 5);
  const parts = tricky.split('/');
  assert.equal(parts.length, 3, 'no extra slash from the category id');
  assert.equal(parts[0], '7218c716-aaaa', 'segment 1 is the venue (the fence checks it)');
  assert.equal(parts[1], 'categories', 'segment 2 is categories (the fence checks it)');
  assert.ok(!parts[2].includes('..'));
});

test('peerPhotoTargets moves shared venues without touching their own photos', () => {
  const peers = [
    { id: 'p-empty', image: null },
    { id: 'p-blank', image: '' },
    { id: 'p-prev', image: URL_A },
    { id: 'p-own', image: URL_C },
    { id: 'p-next', image: URL_B },
  ];
  assert.deepEqual(peerPhotoTargets(peers, URL_A, URL_B), ['p-empty', 'p-blank', 'p-prev']);
  assert.deepEqual(peerPhotoTargets(peers, null, URL_B), ['p-empty', 'p-blank'], 'first upload fills empty peers only');
  assert.deepEqual(peerPhotoTargets(peers, URL_A, null), ['p-prev'], 'remove clears only peers on the old photo');
  assert.deepEqual(peerPhotoTargets(peers, null, null), []);
  assert.deepEqual(peerPhotoTargets(undefined, URL_A, URL_B), []);
});

test('screen text has no dashes and short sentences', () => {
  const texts = Object.values(CATEGORY_PHOTO_COPY).map(v => (typeof v === 'function' ? v(400, 150) : v));
  assert.ok(texts.length >= 20);
  for (const text of texts) {
    assert.equal(typeof text, 'string');
    assert.ok(!/[—–]/.test(text) && !text.includes(' - '), `no dash: ${text}`);
    for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
      assert.ok(sentence.length < 120, `sentence under 120: ${sentence}`);
    }
  }
});
