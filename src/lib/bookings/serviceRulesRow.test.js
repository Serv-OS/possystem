import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceRulesFromRow, touchesServiceRules, SERVICE_RULE_COLUMNS } from './serviceRulesRow.js';

test('a row from before the migration says not ready and carries no fields', () => {
  assert.deepEqual(serviceRulesFromRow({ location_id: 'x', service_start: '17:00:00' }), { servicePeriodsReady: false });
  assert.deepEqual(serviceRulesFromRow(null), { servicePeriodsReady: false });
});

test('a row after the migration maps every column, cleaned', () => {
  const r = serviceRulesFromRow({
    service_periods: [{ id: 'l', days: [1], start: '12:00', end: '15:00' }],
    closed_weekdays: [1, '7', 9],
    date_blocks: null,
    min_notice_minutes: '90',
  });
  assert.equal(r.servicePeriodsReady, true);
  assert.equal(r.servicePeriods.length, 1);
  assert.deepEqual(r.closedWeekdays, [1, 7]);
  assert.deepEqual(r.dateBlocks, []);
  assert.equal(r.minNoticeMinutes, 90);
});

test('touchesServiceRules spots a write to the new columns only', () => {
  assert.equal(touchesServiceRules({ pacingCap: 10 }), false);
  assert.equal(touchesServiceRules({ closedWeekdays: [1] }), true);
  assert.deepEqual(Object.values(SERVICE_RULE_COLUMNS), ['service_periods', 'closed_weekdays', 'date_blocks', 'min_notice_minutes']);
});
