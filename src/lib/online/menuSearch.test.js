/**
 * menuSearch.test.js: the online page's menu search (5.12.34).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseQuery, matchesSearch, searchMenuRows, searchCountWords } from './menuSearch.js';

const rows = [
  { id: 1, name: 'Margherita', menu_name: 'Margherita Pizza', description: 'Tomato, mozzarella, basil' },
  { id: 2, name: 'Caesar Salad', description: 'Romaine, parmesan, croutons' },
  { id: 3, name: 'Crème brûlée', description: '' },
  { id: 4, name: 'Garlic Bread', description: null },
];

test('normaliseQuery trims, lowers and squashes spaces', () => {
  assert.equal(normaliseQuery('  Pizza   Marg '), 'pizza marg');
  assert.equal(normaliseQuery(null), '');
});

test('matchesSearch: name or description, every word, case and accents ignored', () => {
  assert.equal(matchesSearch(rows[0], 'pizza'), true);
  assert.equal(matchesSearch(rows[0], 'basil'), true);
  assert.equal(matchesSearch(rows[0], 'basil pizza'), true);
  assert.equal(matchesSearch(rows[0], 'basil salad'), false);
  assert.equal(matchesSearch(rows[2], 'creme brulee'), true);
  assert.equal(matchesSearch(rows[3], 'garlic'), true);
  assert.equal(matchesSearch(rows[3], ''), true);
});

test('matchesSearch reads the injected accessors, so the menu language is what is searched', () => {
  const es = { name: (r) => (r.id === 1 ? 'Pizza Margarita' : r.name), description: (r) => (r.id === 1 ? 'Tomate, mozzarella, albahaca' : r.description) };
  assert.equal(matchesSearch(rows[0], 'albahaca', es), true);
  assert.equal(matchesSearch(rows[0], 'basil', es), false);
});

test('matchesSearch: the section label counts, so "pizza" finds Pepperoni under Sourdough Pizza', () => {
  const section = (r) => (r.id === 1 ? ['Sourdough Pizza'] : []);
  assert.equal(matchesSearch({ id: 1, name: 'Pepperoni', description: 'Tomato, mozzarella' }, 'pizza', { section }), true);
  assert.equal(matchesSearch({ id: 2, name: 'Caesar Salad', description: '' }, 'pizza', { section }), false);
  assert.equal(matchesSearch({ id: 1, name: 'Pepperoni' }, 'pizza pepperoni', { section }), true);
  assert.equal(matchesSearch({ id: 1, name: 'Pepperoni' }, 'pizza', { section: () => 'Sourdough Pizza' }), true);
});

test('searchMenuRows keeps order, drops a repeated row, matches on an empty query return everything once', () => {
  assert.deepEqual(searchMenuRows(rows, 'a').map((r) => r.id), [1, 2, 4]);
  assert.deepEqual(searchMenuRows([...rows, rows[0]], '').map((r) => r.id), [1, 2, 3, 4]);
  assert.deepEqual(searchMenuRows(null, 'x'), []);
});

test('searchCountWords', () => {
  assert.equal(searchCountWords(0, ' Tacos '), "No results for 'tacos'");
  assert.equal(searchCountWords(1, 'x'), '1 result');
  assert.equal(searchCountWords(5, 'x'), '5 results');
});
