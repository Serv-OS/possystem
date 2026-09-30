import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suppressReaderTip } from './readerTipRule.js';

test('the reader decides for dine in, takeaway, collection and drive thru (Barnsley, 30 Sep)', () => {
  for (const t of ['dine-in', 'takeaway', 'collection', 'drive-thru', 'delivery', undefined, '']) {
    assert.equal(suppressReaderTip(t), false, String(t));
  }
});

test('a bar tab is still suppressed (the bar flow is left as it was)', () => {
  assert.equal(suppressReaderTip('bar-tab'), true);
});
