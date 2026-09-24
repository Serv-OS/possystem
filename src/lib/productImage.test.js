// productImage.test.js — the venue logo stands in for a missing product photo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { productImage, isDefaultImage, resolveDefaultProductImage } from './productImage.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const LOGO = 'https://cdn.example/logo.png';

test('a product with its own photo keeps it; one without gets the venue default', () => {
  assert.equal(productImage({ image: 'https://x/own.jpg' }, LOGO), 'https://x/own.jpg');
  assert.equal(productImage({ image: null }, LOGO), LOGO);
  assert.equal(productImage({}, null), null, 'no default set: nothing, exactly as before');
  assert.equal(isDefaultImage({}, LOGO), true);
  assert.equal(isDefaultImage({ image: 'https://x/own.jpg' }, LOGO), false);
});

test('only an https URL is honoured as the default', () => {
  assert.equal(resolveDefaultProductImage({ default_product_image: LOGO }), LOGO);
  assert.equal(resolveDefaultProductImage({ default_product_image: ' ' + LOGO + ' ' }), LOGO);
  assert.equal(resolveDefaultProductImage({ default_product_image: 'javascript:alert(1)' }), null);
  assert.equal(resolveDefaultProductImage({ default_product_image: 'http://insecure/x.png' }), null);
  assert.equal(resolveDefaultProductImage({}), null);
  assert.equal(resolveDefaultProductImage(null), null);
});

test('every customer-facing surface asks productImage, not item.image', () => {
  for (const f of ['../surfaces/POSSurface.jsx', '../surfaces/KioskApp.jsx', '../surfaces/KioskProductModal.jsx',
    '../surfaces/online/OnlineSurface.jsx', '../surfaces/online/OnlineItemSheet.jsx', '../surfaces/MenuBoardSurface.jsx']) {
    const src = read(f);
    assert.match(src, /from '\.\.\/(\.\.\/)?lib\/productImage'/, f + ' imports the resolver');
    assert.match(src, /productImage\(/, f + ' uses it');
  }
});

test('the choice is made in Appearance and mirrored to the ops venue row', () => {
  const app = read('../backoffice/sections/MenuAppearance.jsx');
  assert.doesNotMatch(app, /default_product_image_from_logo/, 'never a new branding key: the server allowlists them (23 Sep unknown_field)');
  assert.match(app, /useLogoAsDefault/);
  assert.match(app, /pos_settings/);
  const bridge = read('../sync/SyncBridge.jsx');
  assert.match(bridge, /setDefaultProductImage\(resolveDefaultProductImage\(locData\?\.pos_settings\)\)/);
});
