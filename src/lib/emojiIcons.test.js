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

// The whole app draws line icons (5.12.42 customer screens, 5.12.43 everything else). Comments may
// mention emoji; code may not. Plain text marks stay allowed (tick, cross, star, sparkle, bullet,
// arrows, backspace, list, pause bars). KEEP lists files that hold emoji as SAVED DATA on purpose:
// seed and demo rows, icon pickers that save emoji, default icons written to the database, markers the
// kitchen code reads. Every place those values show draws them through EmojiIcon or stripEmoji.
const KEEP = new Set([
  'src/backoffice/components/MenuImportModal.jsx',
  'src/backoffice/sections/DeviceRegistry.jsx',
  'src/backoffice/sections/DiscountManager.jsx',
  'src/backoffice/sections/FloorPlanBuilder.jsx',
  'src/backoffice/sections/LoyaltyManager.jsx',
  'src/backoffice/sections/MenuManager.jsx',
  'src/backoffice/sections/MenuVisualizer.jsx',
  'src/backoffice/sections/PrintRouting.jsx',
  'src/backoffice/sections/msm/MsmGroupSheet.jsx',
  'src/data/seed.js',
  'src/lib/categoryForm.js',
  'src/lib/changelog.js',
  'src/lib/counterOrder.js',
  'src/lib/customerLookup.js',
  'src/lib/kds/kdsTicket.js',
  'src/lib/menuItemWrite.js',
  'src/lib/msm/msmDemo.js',
  'src/lib/msm/msmFixture.js',
  'src/lib/rowMapping.js',
  'src/lib/sectionPlan.js',
  'src/lib/stampSummary.js',
  'src/staff/chatModel.js',
  'src/store/index.js',
  'src/surfaces/BarSurface.jsx',
  'src/surfaces/OrdersHub.jsx',
  'src/surfaces/TablesSurface.jsx',
  'src/surfaces/kds/KDSSurface.jsx',
  'src/surfaces/kds/KdsTicketCard.jsx',
  'src/sync/SyncBridge.jsx',
]);
const PICTURE = /[\u{1F000}-\u{1FAFF}]|[\u2600-\u26FF\u2700-\u27BF\u231A\u231B\u23E9-\u23FA\u2B50\u2B55](?<![\u2713\u2715\u2717\u2726\u2605\u2606\u2022\u2192\u232B\u2716\u2714\u270E\u2630\u275A])/u;

test('no picture emoji anywhere in the app outside saved data', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = new URL('../../', import.meta.url).pathname;
  const files = [];
  const walk = (p) => {
    const abs = join(root, p);
    if (statSync(abs).isDirectory()) { for (const f of readdirSync(abs)) walk(join(p, f)); return; }
    if (/\.(jsx?|tsx?)$/.test(p) && !/\.test\./.test(p) && !KEEP.has(p) && p !== 'src/lib/emojiIcons.js') files.push(p);
  };
  walk('src');
  const found = [];
  for (const f of files) {
    readFileSync(join(root, f), 'utf8').split('\n').forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*')) return;
      if (PICTURE.test(line.replace(/\/\/.*$/, ''))) found.push(`${f}:${i + 1}: ${t.slice(0, 80)}`);
    });
  }
  assert.ok(files.length > 500, 'the scan still finds the app');
  assert.deepEqual(found, []);
});

// 5.12.45: the cash count screen used <Icon> while its import sat inside a comment, so the till's
// cash in, cash up and Back Office cash drawers crashed. ESLint's no-undef does not look at JSX
// names, so this test does: every file that draws an icon imports it for real (comments ignored).
test('every file that draws an icon really imports it', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = new URL('../../', import.meta.url).pathname;
  const files = [];
  const walk = (p) => {
    const abs = join(root, p);
    if (statSync(abs).isDirectory()) { for (const f of readdirSync(abs)) walk(join(p, f)); return; }
    if (/\.jsx?$/.test(p) && !/\.test\./.test(p)) files.push(p);
  };
  walk('src');
  const missing = [];
  for (const f of files) {
    const code = readFileSync(join(root, f), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const imported = new Set();
    for (const m of code.matchAll(/^import\s*(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"][^'"]+['"]/gm)) {
      if (m[1]) imported.add(m[1]);
      for (const part of (m[2] || '').split(',')) { const n = part.trim().split(/\s+as\s+/).pop(); if (n) imported.add(n); }
    }
    for (const name of ['Icon', 'EmojiIcon']) {
      const used = new RegExp(`<${name}[\\s/>]`).test(code);
      const local = new RegExp(`(function|const|let|var)\\s+${name}\\b`).test(code);
      if (used && !local && !imported.has(name)) missing.push(`${f}: draws <${name}> without importing it`);
    }
  }
  assert.ok(files.length > 500);
  assert.deepEqual(missing, []);
});
