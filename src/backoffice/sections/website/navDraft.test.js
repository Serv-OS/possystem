// 5.12.8: the Header and navigation card's pure half (navDraft.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoNavRows, navRowsFrom, navPatchFrom, moveRow, headerDraft, MAX_NAV_ITEMS } from './navDraft.js';
import { navProblems, settingsProblems } from '../../../../supabase/functions/_shared/websiteRules.js';

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
  assert.deepEqual(headerDraft(null), { brand: 'logo', cta: 'none', sticky: true });
  assert.deepEqual(headerDraft({ settings: { header: { brand: 'both', cta: 'book', sticky: false } } }), { brand: 'both', cta: 'book', sticky: false });
  assert.deepEqual(headerDraft({ settings: { header: { brand: 'x', cta: 'y', sticky: 'z' } } }), { brand: 'logo', cta: 'none', sticky: true });
  assert.deepEqual(settingsProblems({ header: { brand: 'both', cta: 'order', sticky: true } }), []);
  assert.deepEqual(settingsProblems({ header: null }), []);
  assert.equal(settingsProblems({ header: 'x' }).length, 1);
  const bad = settingsProblems({ header: { brand: 'huge', cta: 'buy', sticky: 'yes', colour: 'red' } });
  assert.equal(bad.length, 4, bad.join(' | '));
});
