// src/lib/emojiIcons.test.js: ServOS draws line icons, never emoji (5.12.42).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EMOJI_ICON, emojiName, stripEmoji } from './emojiIcons.js';

const iconsSrc = readFileSync(new URL('../components/ServOSIcons.jsx', import.meta.url), 'utf8');
const drawn = new Set([...iconsSrc.matchAll(/^\s{2}(\w+):\s/gm)].map((m) => m[1]));

test('every emoji maps to an icon ServOS can draw', () => {
  const missing = Object.entries(EMOJI_ICON).filter(([, name]) => !drawn.has(name));
  assert.deepEqual(missing, []);
});

test('saved emoji resolve with or without the variation mark', () => {
  assert.equal(emojiName('🍽'), 'utensils');
  assert.equal(emojiName('🍽️'), 'utensils');
  assert.equal(emojiName('⚠️'), 'warn');
  assert.equal(emojiName('🍸'), 'cocktail');
  assert.equal(emojiName('🦄'), null);
  assert.equal(emojiName(''), null);
});

test('stripEmoji takes picture emoji out and keeps real text', () => {
  assert.equal(stripEmoji('🍽 Main dining'), 'Main dining');
  assert.equal(stripEmoji('⚠️ Card declined'), 'Card declined');
  assert.equal(stripEmoji('Order ready 🎉'), 'Order ready');
  assert.equal(stripEmoji('🇬🇧 English'), 'English');
  assert.equal(stripEmoji('£5 off, café, ✓ Saved, ✕, ★'), '£5 off, café, ✓ Saved, ✕, ★');
  assert.equal(stripEmoji('Two  🍕  pizzas'), 'Two pizzas');
  assert.equal(stripEmoji(null), null);
});

// Customer screens draw line icons only (5.12.42). Comments may mention emoji; code may not.
// Plain text marks stay allowed: tick, cross, star, sparkle, bullet, arrows, backspace.
const CUSTOMER = [
  'src/surfaces/online', 'src/surfaces/qr', 'src/surfaces/catering', 'src/surfaces/gift', 'src/surfaces/customer',
  'src/surfaces/kiosk', 'src/surfaces/website', 'src/surfaces/KioskApp.jsx', 'src/surfaces/KioskSurface.jsx',
  'src/surfaces/KioskProductModal.jsx', 'src/surfaces/CustomerDisplaySurface.jsx', 'src/surfaces/CustomerBoot.jsx',
  'src/surfaces/GroupOrderSurface.jsx', 'src/surfaces/ReviewSurface.jsx', 'src/surfaces/WifiSurface.jsx',
  'src/surfaces/waitlist/WaitlistJoinSurface.jsx', 'src/lib/i18n.js', 'src/lib/tipping.js', 'src/lib/delivery/status.js',
  'src/components/AllergenChips.js',
];
const PICTURE = /[\u{1F000}-\u{1FAFF}]|[☀-⛿✀-➿⌚⌛⏩-⏺⭐⭕](?<![✓✕✗✦★☆•→⌫✖✔])/u;

test('customer screens have no picture emoji left', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = new URL('../../', import.meta.url).pathname;
  const files = [];
  const walk = (p) => {
    const abs = join(root, p);
    if (statSync(abs).isDirectory()) { for (const f of readdirSync(abs)) walk(join(p, f)); return; }
    if (/\.(jsx?|tsx?)$/.test(p) && !/\.test\./.test(p)) files.push(p);
  };
  CUSTOMER.forEach(walk);
  const found = [];
  for (const f of files) {
    readFileSync(join(root, f), 'utf8').split('\n').forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      const code = line.replace(/\/\/.*$/, '');
      if (PICTURE.test(code)) found.push(`${f}:${i + 1}: ${t.slice(0, 80)}`);
    });
  }
  assert.ok(files.length > 30, 'the customer screen list still finds its files');
  assert.deepEqual(found, []);
});
