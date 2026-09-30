// customerDisplayBrand.test.js: the customer display has its own branding, separate from the
// kiosk's (Peter, 30 Sep 2026). Own value wins, else the kiosk value, else the default; and once
// any own value is set the kiosk no longer reaches the display.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DISPLAY_BRAND_COLUMN,
  DEFAULT_DISPLAY_NAME,
  DEFAULT_ACCENT_DARK,
  DEFAULT_ACCENT_LIGHT,
  EMPTY_DISPLAY_BRAND,
  normaliseHex,
  cleanDisplayBrand,
  displayBrandIsSet,
  displayBrandForDb,
  displayBrandFromKiosk,
  badDisplayBrandColours,
  mergeDisplayBrand,
  hasDisplayBrandColumn,
  isLightColour,
  resolveDisplayBrand,
} from './customerDisplayBrand.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const KIOSK = {
  kiosk_brand_name: 'Coffee Boy Kiosk',
  kiosk_brand_color: '#f97316',
  kiosk_brand_logo_url: 'https://cdn.example/kiosk-logo.png',
  kiosk_brand_bg_color: '#0e0e10',
};
const IMG = 'https://cdn.example/slide-1.png';
const withOwn = (brand) => ({ ...KIOSK, customer_display_images: [IMG], [DISPLAY_BRAND_COLUMN]: brand });

// ── The resolver ──────────────────────────────────────────────────────────────

test('own value wins over the kiosk value', () => {
  const look = resolveDisplayBrand(withOwn({ name: 'Coffee Boy', color: '#15C26A', logoUrl: 'https://cdn.example/display-logo.png' }), { placeName: 'Leeds' });
  assert.equal(look.name, 'Coffee Boy');
  assert.equal(look.color, '#15c26a');
  assert.equal(look.logoUrl, 'https://cdn.example/display-logo.png');
  assert.equal(look.source, 'own');
  assert.deepEqual(look.from, { name: 'own', color: 'own', logo: 'own', bg: 'default' });
});

test('nothing of its own set: the kiosk value', () => {
  for (const own of [undefined, null, {}, { ...EMPTY_DISPLAY_BRAND }, { name: '   ', color: 'nonsense' }]) {
    const look = resolveDisplayBrand(withOwn(own), { placeName: 'Leeds' });
    assert.equal(look.source, 'kiosk', JSON.stringify(own));
    assert.equal(look.name, 'Coffee Boy Kiosk');
    assert.equal(look.color, '#f97316');
    assert.equal(look.logoUrl, 'https://cdn.example/kiosk-logo.png');
    assert.deepEqual(look.from, { name: 'kiosk', color: 'kiosk', logo: 'kiosk', bg: 'default' });
  }
});

test('no own and no kiosk value: the default', () => {
  const dark = resolveDisplayBrand({}, { theme: 'dark', placeName: 'Leeds' });
  assert.equal(dark.name, 'Leeds', 'the paired venue name');
  assert.equal(dark.color, DEFAULT_ACCENT_DARK);
  assert.equal(dark.logoUrl, '');
  assert.equal(dark.bgColor, null);
  assert.deepEqual(dark.from, { name: 'default', color: 'default', logo: 'default', bg: 'default' });
  const light = resolveDisplayBrand({}, { theme: 'light' });
  assert.equal(light.name, DEFAULT_DISPLAY_NAME, 'no venue name either');
  assert.equal(light.color, DEFAULT_ACCENT_LIGHT);
  assert.equal(resolveDisplayBrand(null).name, DEFAULT_DISPLAY_NAME);
  assert.equal(resolveDisplayBrand(undefined, undefined).color, DEFAULT_ACCENT_DARK);
});

test('once any own field is set, an empty field is the default, never the kiosk value', () => {
  // Review, 30 Sep: field by field fallback kept an empty field tied to the kiosk, so a kiosk
  // change still reached the display and "no logo" could not be chosen while the kiosk had one.
  const look = resolveDisplayBrand(withOwn({ name: 'Coffee Boy' }), { theme: 'dark', placeName: 'Leeds' });
  assert.equal(look.source, 'own');
  assert.equal(look.name, 'Coffee Boy');
  assert.equal(look.color, DEFAULT_ACCENT_DARK, 'standard green, not the kiosk orange');
  assert.equal(look.logoUrl, '', 'the Serv OS mark, not the kiosk logo');
  assert.deepEqual(look.from, { name: 'own', color: 'default', logo: 'default', bg: 'default' });
  // An empty own name is the venue name, not the kiosk name.
  const noName = resolveDisplayBrand(withOwn({ color: '#15c26a' }), { placeName: 'Leeds' });
  assert.equal(noName.name, 'Leeds');
  assert.equal(noName.from.name, 'default');
  // A kiosk change no longer reaches the display.
  const own = { name: 'Coffee Boy', bgColor: '#f4f0e6' };
  const before = resolveDisplayBrand(withOwn(own));
  const after = resolveDisplayBrand({ ...withOwn(own), kiosk_brand_color: '#000000', kiosk_brand_logo_url: 'https://cdn.example/new.png', kiosk_brand_name: 'New kiosk' });
  assert.deepEqual(after, before);
});

test('with no own branding the display looks exactly as it did before (the kiosk values)', () => {
  // The rule CustomerDisplaySurface used before 30 Sep 2026, copied here as the reference.
  const before = (profile, theme, placeName) => {
    const dark = theme !== 'light';
    return {
      color: profile?.kiosk_brand_color || (dark ? '#46E08C' : '#0E9E55'),
      logoUrl: profile?.kiosk_brand_logo_url || '',
      name: profile?.kiosk_brand_name || placeName || 'Serv OS',
      dark,
    };
  };
  const profiles = [
    {}, KIOSK, { ...KIOSK, customer_display_images: [IMG] }, { customer_display_images: null },
    { ...KIOSK, [DISPLAY_BRAND_COLUMN]: null }, { ...KIOSK, [DISPLAY_BRAND_COLUMN]: {} },
    { kiosk_brand_color: 'red' }, { kiosk_brand_name: 'Only a name' }, { kiosk_brand_logo_url: 'https://x/y.png' },
  ];
  for (const p of profiles) {
    for (const theme of ['dark', 'light', undefined, 'weird']) {
      for (const placeName of ['', 'Leeds']) {
        const now = resolveDisplayBrand(p, { theme, placeName });
        const was = before(p, theme, placeName);
        const at = JSON.stringify({ p, theme, placeName });
        assert.equal(now.color, was.color, at);
        assert.equal(now.logoUrl, was.logoUrl, at);
        assert.equal(now.name, was.name, at);
        assert.equal(now.dark, was.dark, at);
        assert.equal(now.bgColor, null, 'background untouched');
      }
    }
  }
});

test('background: own colour picks the text palette; the kiosk background is never used', () => {
  const cream = resolveDisplayBrand(withOwn({ bgColor: '#F4F0E6' }), { theme: 'dark' });
  assert.equal(cream.bgColor, '#f4f0e6');
  assert.equal(cream.dark, false, 'dark text on a light background even when the till is dark');
  assert.equal(cream.color, DEFAULT_ACCENT_LIGHT, 'the standard accent for a light background');
  assert.equal(cream.from.bg, 'own');
  const navy = resolveDisplayBrand(withOwn({ bgColor: '#101a3a' }), { theme: 'light' });
  assert.equal(navy.dark, true, 'light text on a dark background even when the till is light');
  assert.equal(navy.color, DEFAULT_ACCENT_DARK);
  const none = resolveDisplayBrand(KIOSK, { theme: 'light' });
  assert.equal(none.bgColor, null, 'kiosk_brand_bg_color is not the display background');
  assert.equal(none.dark, false);
});

// ── Cleaning and the editor helpers ───────────────────────────────────────────

test('isLightColour and normaliseHex', () => {
  assert.equal(isLightColour('#ffffff'), true);
  assert.equal(isLightColour('#fff'), true);
  assert.equal(isLightColour('#F4F6F2'), true);
  assert.equal(isLightColour('#0F1211'), false);
  assert.equal(isLightColour('#15C26A'), true);
  assert.equal(isLightColour(''), false);
  assert.equal(isLightColour('junk'), false);
  assert.equal(normaliseHex('#ABC'), '#aabbcc');
  assert.equal(normaliseHex('15C26A'), '#15c26a');
  assert.equal(normaliseHex(' #15c26a '), '#15c26a');
  for (const bad of ['', null, undefined, '#12', '#15C26', '#1234567', 'red', 'rgb(1,2,3)', 'url(x)', 42]) assert.equal(normaliseHex(bad), '', String(bad));
});

test('cleaning: bad colours, unsafe logo links and long names never reach the display', () => {
  const b = cleanDisplayBrand({ name: '  Coffee Boy  ', color: 'red', bgColor: '#12', logoUrl: 'javascript:alert(1)' });
  assert.deepEqual(b, { name: 'Coffee Boy', color: '', bgColor: '', logoUrl: '' });
  assert.equal(cleanDisplayBrand({ name: 'x'.repeat(200) }).name.length, 60);
  assert.equal(cleanDisplayBrand({ logoUrl: 'http://cdn.example/a.png' }).logoUrl, 'http://cdn.example/a.png');
  assert.deepEqual(cleanDisplayBrand(null), { ...EMPTY_DISPLAY_BRAND });
  assert.deepEqual(cleanDisplayBrand(['x']), { ...EMPTY_DISPLAY_BRAND });
  assert.deepEqual(cleanDisplayBrand('x'), { ...EMPTY_DISPLAY_BRAND });
  assert.equal(displayBrandIsSet({ name: '   ' }), false, 'spaces are not a name');
  assert.equal(displayBrandIsSet({ color: 'nonsense' }), false);
  assert.equal(displayBrandIsSet({ bgColor: '#000' }), true);
  // An own colour that is not one is dropped; with nothing else set the kiosk look stays.
  assert.equal(resolveDisplayBrand(withOwn({ color: 'nope' })).color, '#f97316');
});

test('what Back Office writes: the cleaned fields, or null when none is set', () => {
  assert.equal(displayBrandForDb(undefined), null);
  assert.equal(displayBrandForDb({ ...EMPTY_DISPLAY_BRAND }), null);
  assert.equal(displayBrandForDb({ name: '  ', color: '#15C26' }), null, 'a typo is not stored');
  assert.deepEqual(displayBrandForDb({ name: ' Coffee Boy ', color: '#15C26A' }), { name: 'Coffee Boy', color: '#15c26a', bgColor: '', logoUrl: '' });
});

test('Save waits while a colour field holds something that is not a colour code', () => {
  // Review, 30 Sep: "#15C26" was dropped on save without a word and the tab kept showing it.
  assert.deepEqual(badDisplayBrandColours({ color: '#15C26' }), ['color']);
  assert.deepEqual(badDisplayBrandColours({ color: '#15C26A', bgColor: 'cream' }), ['bgColor']);
  assert.deepEqual(badDisplayBrandColours({ color: '', bgColor: '  ' }), [], 'empty is fine');
  assert.deepEqual(badDisplayBrandColours({ color: 'fff' }), [], 'three digits without # is a colour');
  assert.deepEqual(badDisplayBrandColours(undefined), []);
});

test('Start from the kiosk branding copies name, accent and logo, never a background', () => {
  assert.deepEqual(
    displayBrandFromKiosk({ name: 'Coffee Boy Kiosk', color: '#F97316', logoUrl: 'https://cdn.example/kiosk-logo.png', bgColor: '#000000' }),
    { name: 'Coffee Boy Kiosk', color: '#f97316', bgColor: '', logoUrl: 'https://cdn.example/kiosk-logo.png' },
  );
  assert.deepEqual(displayBrandFromKiosk({ color: 'orange' }), { ...EMPTY_DISPLAY_BRAND }, 'a kiosk colour that is not a code is left out');
  assert.deepEqual(displayBrandFromKiosk(null), { ...EMPTY_DISPLAY_BRAND });
});

test('a stale Back Office tab that changes one field keeps the fields set elsewhere', () => {
  // Tab A opened this morning with nothing set. Tab B has since set a name and a logo.
  const base = {};
  const theirs = { name: 'Set in Tab B', logoUrl: 'https://cdn.example/b.png' };
  // Tab A picks an accent colour only.
  assert.deepEqual(mergeDisplayBrand(base, { color: '#15C26A' }, theirs),
    { name: 'Set in Tab B', color: '#15c26a', bgColor: '', logoUrl: 'https://cdn.example/b.png' });
  // Clearing a field this tab changed wins (Remove logo).
  assert.deepEqual(mergeDisplayBrand({ logoUrl: 'https://cdn.example/a.png' }, { logoUrl: '' }, { name: 'B', logoUrl: 'https://cdn.example/a.png' }),
    { name: 'B', color: '', bgColor: '', logoUrl: '' });
  // A field this tab changed wins over a change made elsewhere.
  assert.equal(mergeDisplayBrand({ name: 'Old' }, { name: 'Mine' }, { name: 'Theirs' }).name, 'Mine');
  // Nothing changed elsewhere: exactly what this tab holds.
  const mine = { name: 'Coffee Boy', color: '#15c26a', bgColor: '#f4f0e6', logoUrl: 'https://cdn.example/m.png' };
  assert.deepEqual(mergeDisplayBrand({ name: 'Coffee Boy' }, mine, { name: 'Coffee Boy' }), mine);
  // Retyping the same value in another case is not a change.
  assert.equal(mergeDisplayBrand({ color: '#15c26a' }, { color: '#15C26A' }, { color: '#000000' }).color, '#000000');
});

test('the column check: the editor shows only once the migration has run', () => {
  assert.equal(hasDisplayBrandColumn({ id: 'p1', [DISPLAY_BRAND_COLUMN]: null }), true, 'present but not set');
  assert.equal(hasDisplayBrandColumn({ id: 'p1', kiosk_brand_name: 'x' }), false);
  assert.equal(hasDisplayBrandColumn(null), false);
  assert.equal(DISPLAY_BRAND_COLUMN, 'customer_display_brand');
});

// ── Code that is already running: old displays and old Back Office tabs ───────

test('customer_display_images still holds only images, so old displays and old Back Office tabs are safe', () => {
  // Review, 30 Sep: old Back Office code (still on some tills for days) renders every entry of
  // customer_display_images as <img src>, and writes back the array it loaded. The branding is
  // therefore its own column, which old code never selects or writes.
  const bo = read('../backoffice/sections/DeviceProfiles.jsx');
  const toDbRow = bo.slice(bo.indexOf('const toDbRow = (p, locId) => ({'), bo.indexOf('\n  });', bo.indexOf('const toDbRow')));
  assert.match(toDbRow, /customer_display_images: p\.customerDisplayImages \|\| \[\],/, 'the images array is written as before');
  assert.match(toDbRow, /\.\.\.\(brandColumnReady \? \{ \[DISPLAY_BRAND_COLUMN\]: displayBrandForDb\(p\.customerDisplayBrand\) \} : \{\}\)/,
    'the branding goes to its own column, and only once the column exists');
  assert.doesNotMatch(toDbRow, /kiosk_/, 'Back Office device profiles never writes the kiosk branding');
  // Nothing puts branding into the images list.
  for (const m of bo.matchAll(/customerDisplayImages: \[([^\]]*)\]/g)) assert.doesNotMatch(m[1], /brand|logo/i, m[0]);
  assert.doesNotMatch(bo, /joinDisplayImages|kind: *'display_brand'/);
  // The old display path and the old Back Office path, applied to what the new code stores.
  const stored = [IMG, { url: 'https://cdn.example/slide-2.png' }];
  const oldDisplay = stored.map(x => (typeof x === 'string' ? x : x?.url)).filter(Boolean);
  assert.deepEqual(oldDisplay, [IMG, 'https://cdn.example/slide-2.png']);
  // Old Back Office: <img src={url}> per entry, and a "No images" hint when the list is empty.
  const oldBoTiles = (imgs) => imgs.map(url => String(url));
  assert.deepEqual(oldBoTiles(['https://cdn.example/a.png']), ['https://cdn.example/a.png']);
  assert.equal(oldBoTiles([]).length, 0, 'the "No images" hint still shows with no images');
});

test('before the migration runs nothing breaks', () => {
  const bo = read('../backoffice/sections/DeviceProfiles.jsx');
  // Readiness: null until loaded, then true or false from the row itself.
  assert.match(bo, /useState\(isMock \? true : null\)/);
  assert.match(bo, /setBrandColumnReady\(hasDisplayBrandColumn\(profileData\[0\]\)\)/);
  // The clobber guard reads and keeps the column only once it exists.
  assert.match(bo, /\.\.\.\(brandColumnReady \? \[\['customerDisplayBrand', DISPLAY_BRAND_COLUMN, cleanDisplayBrand\]\] : \[\]\)/);
  assert.match(bo, /The customer display's own branding needs a database update before it can be set here\./);
  // The display asks for the column and, if the read fails, reads exactly what it read before.
  const disp = read('../surfaces/CustomerDisplaySurface.jsx');
  assert.match(disp, /const cols = 'kiosk_brand_name,kiosk_brand_color,kiosk_brand_bg_color,kiosk_brand_logo_url,kiosk_banners,customer_display_images';/);
  assert.match(disp, /let res = await read\(`\$\{cols\},\$\{DISPLAY_BRAND_COLUMN\}`\);\s*if \(res\.error\) res = await read\(cols\);/);
  // The migration adds the column (and the rollback removes it).
  const up = read('../../supabase/migrations/20260930b_OPS_customer_display_branding.sql');
  assert.match(up, /alter table public\.device_profiles add column if not exists customer_display_brand jsonb;/);
  const down = read('../../supabase/migrations/20260930b_OPS_customer_display_branding_ROLLBACK.sql');
  assert.match(down, /alter table public\.device_profiles drop column if exists customer_display_brand;/);
});

test('pins: the display reads its branding through the resolver; Back Office writes, guards and says it', () => {
  const disp = read('../surfaces/CustomerDisplaySurface.jsx');
  assert.match(disp, /import \{ resolveDisplayBrand, DISPLAY_BRAND_COLUMN \} from '\.\.\/lib\/customerDisplayBrand'/);
  assert.match(disp, /const look = resolveDisplayBrand\(profile, \{/);
  assert.doesNotMatch(disp, /profile\?\.kiosk_brand_(color|name|logo_url)/, 'no direct kiosk reads left on the display');
  const bo = read('../backoffice/sections/DeviceProfiles.jsx');
  assert.match(bo, /Using the kiosk branding until you set this\./);
  assert.match(bo, /This profile has no kiosk branding, so the display shows the venue name and the standard look until you set this\./);
  assert.match(bo, /mergeDisplayBrand\(opened\.customerDisplayBrand, updated\.customerDisplayBrand, existing\.data\[DISPLAY_BRAND_COLUMN\]\)/);
  assert.match(bo, /onSave\(form, touchedRef\.current, profile\)/, 'the editor passes the profile it opened with');
  assert.match(bo, /putLocal\(\{ \.\.\.updated, \.\.\.kept \}\)/, 'the tab keeps what was stored, not its stale copy');
  assert.match(bo, /badBrandColours\.length > 0/, 'Save waits on a colour typo');
  // The kiosk is unaffected: it never reads or writes the display's branding.
  for (const f of ['../backoffice/sections/KioskSettings.jsx', '../surfaces/KioskApp.jsx']) {
    assert.doesNotMatch(read(f), /customer_display_images|customer_display_brand|customerDisplayBrand/, f);
  }
});
