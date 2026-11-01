// 5.12.9: the pure rules behind the page editor's pickers (link, menu, categories, colour, markdown toolbar).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOM_LINK, SERVOS_LINKS, categoryIds, categoryOptions, classifyHref, insertMarkdown, isHexColor, isWebAddress,
  linkOptions, menuOptions, normaliseHex, orderedPages, pageLabel, toggleCategory,
} from './blocks/editorFields.js';

const PAGES = [
  { id: 'p-menu', slug: 'menu', title: 'Menu', sort_order: 2 },
  { id: 'p-home', slug: '', title: 'Welcome', sort_order: 5 },
  { id: 'p-about', slug: 'about', title: 'Our story', sort_order: 1 },
  { id: 'p-untitled', slug: 'misc', title: '', sort_order: 9 },
  null, { slug: 'no-id' },
];

test('linkOptions: home first, pages by sort order, then the ServOS links, then Web address', () => {
  const opts = linkOptions(PAGES);
  assert.deepEqual(opts.slice(0, 4).map((o) => o.label), ['Home', 'Our story', 'Menu', '/misc']);
  assert.deepEqual(opts.slice(0, 4).map((o) => o.value), ['page:p-home', 'page:p-about', 'page:p-menu', 'page:p-untitled']);
  assert.deepEqual(opts.slice(4, 11).map((o) => o.value), ['servos:order', 'servos:catering', 'servos:book', 'servos:loyalty', 'servos:gift', 'servos:waitlist', '/blog']);
  assert.deepEqual(opts.slice(4, 11).map((o) => o.label), ['Order online', 'Catering', 'Book a table', 'Loyalty', 'Gift cards', 'Waitlist', 'Blog']);
  assert.deepEqual(opts.at(-1), { label: 'Web address', value: CUSTOM_LINK });
  assert.equal(opts.length, 4 + SERVOS_LINKS.length + 1);
  assert.deepEqual(linkOptions(null).map((o) => o.value).slice(0, 1), ['servos:order'], 'no pages: ServOS links still there');
  assert.equal(pageLabel({ slug: '/', title: 'x' }), 'Home');
  assert.deepEqual(orderedPages(PAGES).map((p) => p.id), ['p-home', 'p-about', 'p-menu', 'p-untitled']);
  const dash = new RegExp('[\\u2013\\u2014]');
  for (const o of opts) assert.ok(!dash.test(o.label), 'no dashes in labels');
});

test('classifyHref: pages by id, slug or site path; ServOS links; anything else is a web address with the value kept', () => {
  assert.deepEqual(classifyHref('page:p-menu', PAGES), { choice: 'page:p-menu', custom: '' });
  assert.deepEqual(classifyHref('page:about', PAGES), { choice: 'page:p-about', custom: '' }, 'page:<slug> selects the page');
  assert.deepEqual(classifyHref('/menu', PAGES), { choice: 'page:p-menu', custom: '' }, 'a site path of a page selects the page');
  assert.deepEqual(classifyHref('/', PAGES), { choice: 'page:p-home', custom: '' });
  assert.deepEqual(classifyHref('servos:gift', PAGES), { choice: 'servos:gift', custom: '' });
  assert.deepEqual(classifyHref('/blog', PAGES), { choice: '/blog', custom: '' });
  assert.deepEqual(classifyHref('page:gone', PAGES), { choice: CUSTOM_LINK, custom: 'page:gone' }, 'an unknown page keeps its value');
  assert.deepEqual(classifyHref('https://example.com/x', PAGES), { choice: CUSTOM_LINK, custom: 'https://example.com/x' });
  assert.deepEqual(classifyHref('mailto:hi@x.com', []), { choice: CUSTOM_LINK, custom: 'mailto:hi@x.com' });
  assert.deepEqual(classifyHref('servos:order:loc-1', PAGES), { choice: CUSTOM_LINK, custom: 'servos:order:loc-1' }, 'a venue pinned link is kept as typed');
  assert.deepEqual(classifyHref('', PAGES), { choice: CUSTOM_LINK, custom: '' });
  assert.deepEqual(classifyHref(null, null), { choice: CUSTOM_LINK, custom: '' });
  assert.deepEqual(classifyHref('/nowhere', PAGES), { choice: CUSTOM_LINK, custom: '/nowhere' });
  assert.ok(isWebAddress('https://a.b'));
  assert.ok(isWebAddress('tel:+441234'));
  assert.ok(isWebAddress('mailto:a@b.c'));
  assert.ok(!isWebAddress('example.com'));
  assert.ok(!isWebAddress('javascript:alert(1)'));
});

test('menuOptions: Live right now first, every menu by name, an unknown current id kept as Menu <id>', () => {
  const menu = { menus: [{ id: 'm-all', name: 'All day' }, { id: 'm-brunch', name: 'Brunch' }, { id: 'm-blank', name: '' }, null, { name: 'no id' }] };
  const opts = menuOptions(menu, 'follow');
  assert.deepEqual(opts.map((o) => o.value), ['follow', 'm-all', 'm-brunch', 'm-blank']);
  assert.equal(opts[0].label, 'Live right now (follows your menu times)');
  assert.equal(opts[1].label, 'All day');
  assert.equal(opts[3].label, 'Menu m-blank');
  assert.deepEqual(menuOptions(menu, 'm-gone').at(-1), { label: 'Menu m-gone', value: 'm-gone' });
  assert.deepEqual(menuOptions(null, '').map((o) => o.value), ['follow']);
  assert.deepEqual(menuOptions([{ id: 'x', name: 'X' }], 'x').map((o) => o.value), ['follow', 'x'], 'a plain list works too');
});

test('categoryOptions and toggleCategory: menu order kept, none ticked = all, junk dropped', () => {
  const menu = { categories: [{ id: 'c1', label: 'Pizza' }, { id: 'c2', label: 'Drinks' }, { id: 'c3', name: 'Sides' }, { id: 'c1', label: 'dupe' }, { label: 'no id' }, null] };
  const opts = categoryOptions(menu);
  assert.deepEqual(opts, [{ id: 'c1', label: 'Pizza' }, { id: 'c2', label: 'Drinks' }, { id: 'c3', label: 'Sides' }]);
  assert.deepEqual(categoryOptions(null), []);
  const order = opts.map((o) => o.id);
  let v = [];
  v = toggleCategory(v, 'c3', order);
  assert.deepEqual(v, [{ id: 'c3' }]);
  v = toggleCategory(v, 'c1', order);
  assert.deepEqual(v, [{ id: 'c1' }, { id: 'c3' }], 'kept in category order, not click order');
  v = toggleCategory(v, 'c3', order);
  assert.deepEqual(v, [{ id: 'c1' }]);
  v = toggleCategory(v, 'c1', order);
  assert.deepEqual(v, [], 'untick the last = all categories');
  assert.deepEqual(toggleCategory([{ id: 'zz' }, { id: 'c2' }], 'c1', order), [{ id: 'c1' }, { id: 'c2' }, { id: 'zz' }], 'ids the menu no longer has stay at the end');
  assert.deepEqual(toggleCategory('junk', 'c1', order), [{ id: 'c1' }]);
  assert.deepEqual(toggleCategory([{ id: 'c1' }, null, { nope: 1 }], '', order), [{ id: 'c1' }], 'no id = no change, junk dropped');
  assert.deepEqual(categoryIds([{ id: 'a' }, { id: '' }, 'x', null]), ['a']);
});

test('colour: only #rrggbb counts; hand typed #rgb or rrggbb are normalised, junk becomes none', () => {
  assert.ok(isHexColor('#c8493b'));
  assert.ok(isHexColor('#C8493B'));
  assert.ok(!isHexColor('#c84'));
  assert.ok(!isHexColor('c8493b'));
  assert.ok(!isHexColor(''));
  assert.ok(!isHexColor(null));
  assert.ok(!isHexColor('#c8493bff'));
  assert.equal(normaliseHex('C8493B'), '#c8493b');
  assert.equal(normaliseHex(' #abc '), '#aabbcc');
  assert.equal(normaliseHex('red'), '');
  assert.equal(normaliseHex(''), '');
});

test('insertMarkdown: bold, italic and link wrap the selection; heading and bullet work on whole lines and toggle off', () => {
  let r = insertMarkdown('hello world', 6, 11, 'bold');
  assert.equal(r.text, 'hello **world**');
  assert.equal(r.text.slice(r.start, r.end), 'world');
  r = insertMarkdown('hello', 5, 5, 'bold');
  assert.equal(r.text, 'hello**bold text**');
  assert.equal(r.text.slice(r.start, r.end), 'bold text');
  r = insertMarkdown('a b', 2, 3, 'italic');
  assert.equal(r.text, 'a *b*');
  r = insertMarkdown('see our menu', 8, 12, 'link', { target: 'page:p-menu' });
  assert.equal(r.text, 'see our [menu](page:p-menu)');
  assert.equal(r.text.slice(r.start, r.end), 'menu');
  r = insertMarkdown('', 0, 0, 'link', { target: '' });
  assert.equal(r.text, '[link text](https://)');
  r = insertMarkdown('one\ntwo\nthree', 5, 5, 'heading');
  assert.equal(r.text, 'one\n## two\nthree');
  assert.equal(r.text.slice(r.start, r.end), '## two');
  r = insertMarkdown(r.text, 5, 5, 'heading');
  assert.equal(r.text, 'one\ntwo\nthree', 'heading again takes it off');
  r = insertMarkdown('one\ntwo\nthree', 0, 13, 'bullet');
  assert.equal(r.text, '- one\n- two\n- three');
  r = insertMarkdown(r.text, 0, r.text.length, 'bullet');
  assert.equal(r.text, 'one\ntwo\nthree', 'bullet again takes it off');
  r = insertMarkdown('abc', 9, 99, 'bold');
  assert.equal(r.text, 'abc**bold text**', 'out of range selection is clamped');
  r = insertMarkdown('abc', 1, 2, 'nonsense');
  assert.deepEqual(r, { text: 'abc', start: 1, end: 2 });
  r = insertMarkdown(null, 0, 0, 'italic');
  assert.equal(r.text, '*italic text*');
});
