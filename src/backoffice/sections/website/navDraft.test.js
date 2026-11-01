// 5.12.8: the Header and navigation card's pure half (navDraft.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoNavRows, navRowsFrom, navPatchFrom, moveRow, headerDraft, MAX_NAV_ITEMS } from './navDraft.js';
import { navProblems, settingsProblems, themeProblems } from '../../../../supabase/functions/_shared/websiteRules.js';

const pages = [
  { id: 'p1', slug: '', title: 'Home', kind: 'home', status: 'published' },
  { id: 'p2', slug: 'menu', title: 'Menu', kind: 'menu', status: 'published' },
  { id: 'p3', slug: 'leeds', title: 'Leeds', kind: 'location', status: 'published' },
  { id: 'p4', slug: 'story', title: 'Our story', kind: 'custom', status: 'draft' },
];

test('no saved nav: the automatic list (published pages, no venue pages), marked auto', () => {
  const { rows, auto } = navRowsFrom({ nav: [] }, pages);
  assert.equal(auto, true);
  assert.deepEqual(rows.map((r) => [r.label, r.page_id]), [['Home', 'p1'], ['Menu', 'p2']]);
  assert.deepEqual(autoNavRows(null), []);
});

test('saved nav: rows by id or slug, link rows kept, a missing page keeps its id so the owner sees it', () => {
  const site = { nav: [{ label: 'Home', kind: 'page', page_id: 'p1' }, { label: 'Food', kind: 'page', page_id: 'menu' }, { label: 'Insta', kind: 'link', href: 'https://instagram.com/x' }, { label: 'Old', kind: 'page', page_id: 'gone' }, null] };
  const { rows, auto } = navRowsFrom(site, pages);
  assert.equal(auto, false);
  assert.deepEqual(rows.map((r) => [r.label, r.kind, r.page_id, r.href]), [['Home', 'page', 'p1', ''], ['Food', 'page', 'p2', ''], ['Insta', 'link', '', 'https://instagram.com/x'], ['Old', 'page', 'gone', '']]);
});

test('navPatchFrom: what the server accepts, and plain problems for the rest', () => {
  const good = navPatchFrom([{ label: ' Home ', kind: 'page', page_id: 'p1' }, { label: 'Insta', kind: 'link', href: 'https://instagram.com/x' }, { label: 'Menu', kind: 'link', href: '/menu' }]);
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.nav, [{ label: 'Home', kind: 'page', page_id: 'p1' }, { label: 'Insta', kind: 'link', href: 'https://instagram.com/x' }, { label: 'Menu', kind: 'link', href: '/menu' }]);
  assert.deepEqual(navProblems(good.nav), [], 'the server agrees');
  const bad = navPatchFrom([{ label: '', kind: 'page', page_id: 'p1' }, { label: 'x'.repeat(61), kind: 'page', page_id: 'p1' }, { label: 'No page', kind: 'page', page_id: '' }, { label: 'No link', kind: 'link', href: '' }, { label: 'Odd', kind: 'link', href: 'javascript:alert(1)' }]);
  assert.equal(bad.errors.length, 5);
  assert.match(bad.errors[0], /Item 1 needs a label/);
  assert.match(bad.errors[4], /starts with https/);
  const many = navPatchFrom(Array.from({ length: MAX_NAV_ITEMS + 1 }, (_, i) => ({ label: `L${i}`, kind: 'link', href: '/x' })));
  assert.match(many.errors[0], /at most 30/);
});

test('moveRow swaps neighbours and never falls off an end', () => {
  const rows = ['a', 'b', 'c'];
  assert.deepEqual(moveRow(rows, 0, 1), ['b', 'a', 'c']);
  assert.deepEqual(moveRow(rows, 2, -1), ['a', 'c', 'b']);
  assert.equal(moveRow(rows, 0, -1), rows);
  assert.equal(moveRow(rows, 2, 1), rows);
});

test('headerDraft fills defaults; the server validates settings.header the same way', () => {
  assert.deepEqual(headerDraft(null), { brand: 'logo', cta: 'none', sticky: true, logo_size: 'normal' });
  assert.deepEqual(headerDraft({ settings: { header: { brand: 'both', cta: 'book', sticky: false, logo_size: 'xlarge' } } }), { brand: 'both', cta: 'book', sticky: false, logo_size: 'xlarge' });
  assert.deepEqual(headerDraft({ settings: { header: { brand: 'x', cta: 'y', sticky: 'z', logo_size: 'giant' } } }), { brand: 'logo', cta: 'none', sticky: true, logo_size: 'normal' });
  assert.deepEqual(settingsProblems({ header: { brand: 'both', cta: 'order', sticky: true, logo_size: 'large' } }), []);
  // 5.12.15: the server accepts the four logo sizes and nothing else.
  assert.equal(settingsProblems({ header: { logo_size: 'giant' } }).length, 1);
  assert.deepEqual(settingsProblems({ header: null }), []);
  assert.equal(settingsProblems({ header: 'x' }).length, 1);
  const bad = settingsProblems({ header: { brand: 'huge', cta: 'buy', sticky: 'yes', colour: 'red' } });
  assert.equal(bad.length, 4, bad.join(' | '));
});


// ── 5.12.12 nav dropdowns ───────────────────────────────────────────────────────
test('dropdown rows: locations and group come back as rows and go out as nav items; an empty group is refused', () => {
  const pages = [{ id: 'p1', slug: '', title: 'Home', kind: 'home', status: 'published' }, { id: 'p2', slug: 'menu', title: 'Menu', kind: 'menu', status: 'published' }, { id: 'p3', slug: 'leeds', title: 'Leeds', kind: 'location', status: 'published' }];
  const site = { nav: [{ label: 'Locations', kind: 'locations' }, { label: 'More', kind: 'group', children: [{ label: 'Menu', kind: 'page', page_id: 'menu' }, { label: 'News', kind: 'link', href: '/blog' }] }] };
  const { rows, auto } = navRowsFrom(site, pages);
  assert.equal(auto, false);
  assert.deepEqual(rows[0], { label: 'Locations', kind: 'locations', page_id: '', href: '' });
  assert.equal(rows[1].kind, 'group');
  assert.deepEqual(rows[1].page_ids, ['p2'], 'a slug child is matched to its page id');
  assert.equal(rows[1].links.length, 1);
  const out = navPatchFrom(rows, { p1: 'Home', p2: 'Menu', p3: 'Leeds' });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.nav[0], { label: 'Locations', kind: 'locations' });
  assert.deepEqual(out.nav[1], { label: 'More', kind: 'group', children: [{ label: 'Menu', kind: 'page', page_id: 'p2' }, { label: 'News', kind: 'link', href: '/blog' }] });
  const bad = navPatchFrom([{ label: 'Empty', kind: 'group', page_ids: [], links: [] }]);
  assert.equal(bad.errors.length, 1);
  assert.ok(bad.errors[0].includes('nothing in it'));
});


// ── 5.12.15: site colours the server accepts ────────────────────────────────────────────────
test('themeProblems accepts bg_color, card_color and text_color as hex or null and refuses anything else', () => {
  assert.deepEqual(themeProblems({ mood: 'light', bg_color: '#1A237E', card_color: null, text_color: '#ffffff' }), []);
  assert.equal(themeProblems({ bg_color: 'blue' }).length, 1);
  assert.equal(themeProblems({ bg_color: '#fff' }).length, 1, 'six digits only, like brand_color');
  assert.equal(themeProblems({ page_color: '#ffffff' }).length, 1, 'an unknown theme key is refused');
});
