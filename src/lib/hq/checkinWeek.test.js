/**
 * checkinWeek.test.js: weekly check ins.
 * Run: `node --test src/lib/hq/checkinWeek.test.js`.
 *
 * Pinned:
 *   1. A week starts on Monday unless told otherwise; Sunday 16 Nov 2026 belongs to Monday 10 Nov.
 *   2. The defaults are the six questions Mozz asked for; a company's own list replaces them.
 *   3. Answers are cleaned: blanks dropped, scores whole numbers 1 to 5, unknown keys dropped.
 *   4. The owner reads everything, a director only their own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  weekStartIso, weekLabel, DEFAULT_QUESTIONS, normaliseQuestions, cleanAnswers, scoreOf, hasAnswers, canReadCheckin,
} from './checkinWeek.js';

test('weekStartIso', () => {
  assert.equal(weekStartIso('2026-11-16'), '2026-11-16');   // a Monday
  assert.equal(weekStartIso('2026-11-15'), '2026-11-09');   // Sunday belongs to the Monday before
  assert.equal(weekStartIso('2026-11-15', 0), '2026-11-15'); // weeks starting Sunday
  assert.equal(weekStartIso('2026-11-19', 0), '2026-11-15');
  assert.equal(weekStartIso(new Date(2026, 10, 18)), '2026-11-16');
  assert.equal(weekStartIso('nonsense'), null);
});

test('weekLabel', () => {
  assert.equal(weekLabel('2026-11-16'), 'Week of Nov 16 to Nov 22');
  assert.equal(weekLabel('2026-11-30'), 'Week of Nov 30 to Dec 6');
  assert.equal(weekLabel('2026-11-16', 'en-GB'), 'Week of 16 Nov to 22 Nov');
  assert.equal(weekLabel(null), '');
});

test('questions: six defaults, own list replaces them, blanks dropped', () => {
  assert.equal(DEFAULT_QUESTIONS.length, 6);
  assert.equal(DEFAULT_QUESTIONS.filter((q) => q.type === 'score5').length, 1);
  assert.deepEqual(normaliseQuestions(null), [...DEFAULT_QUESTIONS]);
  assert.deepEqual(normaliseQuestions([]), [...DEFAULT_QUESTIONS]);
  const own = normaliseQuestions([{ id: 'x', label: ' One ', type: 'score5' }, { label: '' }, { label: 'Two', type: 'odd' }]);
  assert.deepEqual(own, [{ id: 'x', label: 'One', hint: '', type: 'score5' }, { id: 'q3', label: 'Two', hint: '', type: 'text' }]);
  for (const q of DEFAULT_QUESTIONS) assert.doesNotMatch(q.label + q.hint, /[–—]/, 'no long dashes in the questions');
});

test('cleanAnswers, scoreOf, hasAnswers', () => {
  const qs = normaliseQuestions(null);
  const cleaned = cleanAnswers({ needle: '  Sales up ', off_plan: '   ', confidence: '4', issue: 'none', bogus: 'x' }, qs);
  assert.deepEqual(cleaned, { needle: 'Sales up', confidence: 4, issue: 'none' });
  assert.equal(scoreOf(cleaned, qs), 4);
  assert.equal(scoreOf(cleanAnswers({ confidence: 9 }, qs), qs), null);
  assert.equal(scoreOf(cleanAnswers({ confidence: 2.5 }, qs), qs), null);
  assert.equal(hasAnswers(cleaned), true);
  assert.equal(hasAnswers(cleanAnswers({ needle: '  ' }, qs)), false);
});

test('canReadCheckin mirrors the database rule', () => {
  const row = { author_id: 'u1' };
  assert.equal(canReadCheckin(row, 'u1', false), true);
  assert.equal(canReadCheckin(row, 'u2', false), false);
  assert.equal(canReadCheckin(row, 'u2', true), true);
  assert.equal(canReadCheckin(null, 'u1', true), false);
  assert.equal(canReadCheckin(row, null, false), false);
});
