// src/lib/bookings/serviceRulesRow.js
//
// 16 Oct 2026 (bookings audit section 3 item 6): the service period columns on booking_rules
// (migration 20261016e) as the app reads and writes them. Pure, so it is tested without a
// database (serviceRulesRow.test.js). Before the migration the columns are not on the row at all:
// servicePeriodsReady is false and the editors say so in words instead of saving.

export const SERVICE_RULE_COLUMNS = {
  servicePeriods: 'service_periods',
  closedWeekdays: 'closed_weekdays',
  dateBlocks: 'date_blocks',
  minNoticeMinutes: 'min_notice_minutes',
};

export const SERVICE_RULES_MISSING = 'Service periods need the database update 20261016e first. Until it is run the venue keeps its single service window, and this change was not saved.';

const arr = (v) => (Array.isArray(v) ? v : []);

// booking_rules row -> the camelCase fields. A row read before the migration has none of the
// columns: undefined fields stay out so a merge never blanks what the store already holds.
export function serviceRulesFromRow(r) {
  if (!r) return { servicePeriodsReady: false };
  const ready = Object.prototype.hasOwnProperty.call(r, 'service_periods');
  if (!ready) return { servicePeriodsReady: false };
  return {
    servicePeriodsReady: true,
    servicePeriods: arr(r.service_periods),
    closedWeekdays: arr(r.closed_weekdays).map(Number).filter((d) => d >= 1 && d <= 7),
    dateBlocks: arr(r.date_blocks),
    minNoticeMinutes: Math.max(0, Math.round(Number(r.min_notice_minutes) || 0)),
  };
}

// Does this rules patch write any of the new columns?
export const touchesServiceRules = (patch) => Object.keys(patch || {}).some((k) => k in SERVICE_RULE_COLUMNS);
