// src/lib/venueDatesBatch8.test.js
//
// 5.12.57 (US basics batch 8): dates, times and time zones follow the venue. The helper
// (supabase/functions/_shared/venueDates.js, re exported with the active venue by src/lib/venueDates.js)
// gives a UK venue exactly what the screens wrote before and a US venue its own words and clock; pay
// period labels follow the country; and a guard keeps the fixed files from going back to en-GB words,
// a forced 24 hour clock or a London fallback for every venue.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dayText, dateNumeric, timeText, dateTimeText, localeDateString, localeTimeString, localeString,
  venueCountry, venueLocale, uses12h, weekStartYmd, workweekStartDow, venueToday, hhmmText,
} from '../../supabase/functions/_shared/venueDates.js';
import * as browser from './venueDates.js';
import { fmtYmd, fmtVenueTime, fmtVenueDateTime, countName } from './venueDate.js';
import { payPeriod, weekRangeLabel, buildWeek, weekStartOf } from '../staff/wfWeek.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');

// 3 Nov 2026 14:05 UTC: 14:05 in London (GMT, after the clocks went back), 07:05 in Denver (MST).
const T = '2026-11-03T14:05:00Z';

test('GBP: the words a UK venue read before, byte for byte', () => {
  assert.equal(dayText('2026-11-03', { venue: 'GBP' }), '3 Nov 2026');
  assert.equal(dayText('2026-11-03'), '3 Nov 2026');                       // no venue: the UK, as before
  assert.equal(timeText(T, 'Europe/London', 'GBP'), '14:05');
  assert.equal(timeText('14:05', null, 'GBP'), '14:05');
  assert.equal(dateNumeric('2026-11-03', 'GBP'), '03/11/2026');
  assert.equal(dateTimeText(T, 'Europe/London', 'GBP'), '3 Nov 2026 14:05');
  // the mechanical swaps call exactly what the screens called: toLocale...('en-GB', the same options)
  const d = new Date(T);
  for (const o of [
    { day: 'numeric', month: 'short', year: 'numeric' },
    { weekday: 'short', day: 'numeric', month: 'short' },
    { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/London' },
    undefined,
  ]) assert.equal(localeDateString(d, o, 'GBP'), d.toLocaleDateString('en-GB', o));
  for (const o of [{ hour: '2-digit', minute: '2-digit' }, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/London' }, undefined]) {
    assert.equal(localeTimeString(d, o, 'GBP'), d.toLocaleTimeString('en-GB', o));
  }
  const o = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' };
  assert.equal(localeString(d, o, 'GBP'), d.toLocaleString('en-GB', o));
  // Ireland read en-GB before too
  assert.equal(localeDateString(d, { day: 'numeric', month: 'short', year: 'numeric' }, 'EUR'), d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }));
});

test('USD: month first and a 12 hour clock', () => {
  assert.equal(dayText('2026-11-03', { venue: 'USD' }), 'Nov 3, 2026');
  assert.equal(dateNumeric('2026-11-03', 'USD'), '11/03/2026');
  assert.equal(timeText('14:05', null, 'USD'), '2:05 PM');
  assert.equal(timeText('2026-11-03T21:05:00Z', 'America/Denver', 'USD'), '2:05 PM');
  assert.equal(hhmmText('00:30', 'USD'), '12:30 AM');
  assert.equal(hhmmText('12:00', 'USD'), '12:00 PM');
  // a forced 24 hour clock from a UK screen becomes 12 hour, never "02:05 PM", and a plain space
  const s = localeTimeString(new Date('2026-11-03T21:05:00Z'), { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Denver' }, 'USD');
  assert.equal(s, '2:05 PM');
  assert.equal(dayText('2026-11-03', { venue: 'USD', weekday: true, year: false }), 'Tue, Nov 3');
  // the venue can be given as a currency, a country, a locale or a row
  for (const v of ['USD', 'US', 'en-US', { currency: 'USD' }, { country: 'United States' }]) assert.equal(venueCountry(v), 'US');
  assert.equal(venueLocale('USD'), 'en-US');
  assert.equal(venueLocale('GBP'), 'en-GB');
  assert.equal(uses12h('EUR'), false);
});

test('a time on the venue clock in America/Denver, from a UTC instant', () => {
  // 3 Nov 2026 14:05 UTC is 7:05 AM in Denver; 4 Nov 05:30 UTC is still 3 Nov there (10:30 PM)
  assert.equal(timeText(T, 'America/Denver', 'USD'), '7:05 AM');
  assert.equal(timeText(T, 'America/Denver', 'GBP'), '07:05');
  assert.equal(dayText('2026-11-04T05:30:00Z', { venue: 'USD', tz: 'America/Denver' }), 'Nov 3, 2026');
  assert.equal(dateNumeric('2026-11-04T05:30:00Z', 'USD', 'America/Denver'), '11/03/2026');
  assert.equal(dateTimeText('2026-11-04T05:30:00Z', 'America/Denver', 'USD'), 'Nov 3, 2026 10:30 PM');
  assert.equal(venueToday('America/Denver', new Date('2026-11-04T05:30:00Z')), '2026-11-03');
  // summer: MDT (UTC-6)
  assert.equal(timeText('2026-07-01T20:00:00Z', 'America/Denver', 'USD'), '2:00 PM');
  // no zone: nothing, never the laptop's clock or a fixed other city
  assert.equal(timeText(T, null, 'USD'), '');
  assert.equal(dateTimeText(T, '', 'USD'), '');
  assert.equal(dayText(T, { venue: 'USD' }), '');
});

test('the browser helper reads the active venue: London for a UK venue with no zone yet, nothing for a US one', () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  try {
    store.set('rpos-active-currency', 'GBP');
    assert.equal(browser.activeTimezone(), 'Europe/London');
    assert.equal(browser.timeText(T), '14:05');
    assert.equal(browser.dayText('2026-11-03'), '3 Nov 2026');
    store.set('rpos-active-currency', 'USD');
    assert.equal(browser.activeTimezone(), null);
    assert.equal(browser.timeText(T), '');                          // no zone known: no time
    assert.equal(browser.dayText('2026-11-03'), 'Nov 3, 2026');      // a plain day needs no clock
    browser.setActiveTimezone('America/Denver');
    assert.equal(browser.timeText(T), '7:05 AM');
    assert.equal(browser.dateNumeric('2026-11-03'), '11/03/2026');
    assert.equal(browser.venueStamp('2026-11-04T05:30:00Z', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }), 'Nov 3, 10:30 PM');
    browser.setActiveTimezone('Not/AZone');                           // an unknown zone is never saved
    assert.equal(browser.activeTimezone(), 'America/Denver');
    // the stock words follow the active venue too
    assert.equal(fmtYmd('2026-10-16'), 'Oct 16, 2026');
    assert.equal(fmtYmd('2026-10-16', { weekday: true }), 'Fri, Oct 16, 2026');
    assert.equal(fmtVenueTime('2026-10-15T21:05:00Z', 'America/Denver'), '3:05 PM');
    assert.equal(fmtVenueDateTime('2026-10-15T21:05:00Z', 'America/Denver'), 'Oct 15, 2026 3:05 PM');
    assert.equal(countName('2026-10-15T21:05:00Z', 'America/Denver'), 'Count Oct 15, 2026 · Full');
    store.set('rpos-active-currency', 'GBP');
    assert.equal(fmtYmd('2026-10-16', { weekday: true }), 'Fri 16 Oct 2026');
    assert.equal(fmtVenueDateTime('2026-10-15T21:05:00Z', 'Europe/London'), '15 Oct 2026 22:05');
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage;
  }
});

test('pay period labels per country', () => {
  const ref = new Date(2026, 10, 10);
  assert.equal(payPeriod({ payPeriodType: 'monthly', payPeriodStartDay: 1 }, ref).label, '1 Nov 2026 \u2013 30 Nov 2026');        // UK exactly as before
  assert.equal(payPeriod({ payPeriodType: 'monthly', payPeriodStartDay: 1, country: 'UK' }, ref).label, '1 Nov 2026 \u2013 30 Nov 2026');
  assert.equal(payPeriod({ payPeriodType: 'monthly', payPeriodStartDay: 1, country: 'US' }, ref).label, 'Nov 1, 2026 to Nov 30, 2026');
  assert.equal(payPeriod({ payPeriodType: 'semimonthly', country: 'US' }, ref).label, 'Nov 1, 2026 to Nov 15, 2026');
  assert.equal(payPeriod({ payPeriodType: 'weekly', payPeriodAnchor: '2026-11-02', country: 'US' }, ref).label, 'Nov 9, 2026 to Nov 15, 2026');
  assert.equal(payPeriod({ payPeriodType: 'weekly', payPeriodAnchor: '2026-11-02' }, ref).label, '9 Nov 2026 \u2013 15 Nov 2026');
  const wk = { startIso: '2026-11-02', endIso: '2026-11-08' };
  assert.equal(weekRangeLabel(wk), '2\u20138 Nov');
  assert.equal(weekRangeLabel(wk, 'US'), 'Nov 2 to 8');
  assert.equal(weekRangeLabel({ startIso: '2026-10-26', endIso: '2026-11-01' }, 'US'), 'Oct 26 to Nov 1');
});

test('work week start: Monday unless the venue says otherwise', () => {
  assert.equal(weekStartYmd('2026-11-04'), '2026-11-02');            // Wed: Monday 2 Nov
  assert.equal(weekStartYmd('2026-11-04', 0), '2026-11-01');         // a Sunday week
  assert.equal(weekStartYmd('2026-11-01', 1), '2026-10-26');         // a Sunday in a Monday week
  assert.equal(workweekStartDow({}), 1);
  assert.equal(workweekStartDow({ workweekStart: 0 }), 0);
  assert.equal(workweekStartDow({ workweekStart: 9 }), 1);
  assert.equal(buildWeek(weekStartOf(new Date(2026, 10, 4))).startIso, '2026-11-02');
  const sun = buildWeek(null, 0);
  assert.equal(new Date(sun.startIso + 'T00:00:00').getDay(), 0);
  assert.equal(sun.days[0].label, 'Sun');
  assert.equal(buildWeek(weekStartOf(new Date(2026, 10, 4), 0)).startIso, '2026-11-01');
});

// THE GUARD. Every file batch 8 fixed. A line in one of them that formats with en-GB
// (toLocaleDateString('en-GB', toLocaleTimeString('en-GB', or toLocaleString('en-GB' with a date or
// time option on the line; number grouping alone is the same in en-US), forces a 24 hour clock
// (hour12: false), or falls back to a fixed city (|| or ?? 'Europe/London', 'America/New_York')
// fails, UNLESS the same line picks by the venue (it names 'en-US', uses12h, venueLocale,
// venueCountry, isUs, a country, or a us flag) or carries a "batch 8 ok:" comment saying why (a UK
// only branch, clock numbers read for arithmetic, an input's 24 hour value).
const FIXED = [
  // Workforce and staff
  'src/backoffice/sections/Workforce.jsx',
  'src/backoffice/sections/workforce/WfPayroll.jsx', 'src/backoffice/sections/workforce/WfTimesheets.jsx',
  'src/backoffice/sections/workforce/WfRota.jsx', 'src/backoffice/sections/workforce/WfTronc.jsx',
  'src/backoffice/sections/workforce/WfLeave.jsx', 'src/backoffice/sections/workforce/WfCompliance.jsx',
  'src/backoffice/sections/workforce/WfTraining.jsx', 'src/backoffice/sections/workforce/WfAnnouncements.jsx',
  'src/backoffice/sections/workforce/WfOnboarding.jsx', 'src/backoffice/sections/workforce/WfSettings.jsx',
  'src/backoffice/sections/workforce/WfChat.jsx', 'src/backoffice/sections/reports/PayrollReport.jsx',
  'src/staff/wfWeek.js', 'src/staff/wfData.js', 'src/staff/ClockCard.jsx', 'src/surfaces/TimeClockSurface.jsx',
  'supabase/functions/staff-portal/index.ts', 'supabase/functions/workforce-clock/index.ts',
  // Reports, owner, manager, Adyen, AI tools
  'src/backoffice/sections/reports/_filters.js', 'src/backoffice/sections/reports/ZReport.jsx',
  'src/backoffice/sections/reports/BookingsReport.jsx', 'src/backoffice/sections/reports/DailyTrading.jsx',
  'src/backoffice/sections/reports/Shifts.jsx', 'src/backoffice/sections/reports/_bookingSites.js',
  'src/backoffice/sections/reports/CashDrawer.jsx', 'src/backoffice/sections/reports/Exceptions.jsx',
  'src/backoffice/sections/reports/LoyaltyReport.jsx', 'src/backoffice/sections/reports/AdyenPayments.jsx',
  'src/backoffice/sections/reports/AdyenPayouts.jsx', 'src/backoffice/sections/reports/AdyenStatements.jsx',
  'src/backoffice/sections/reports/AdyenDisputes.jsx', 'src/backoffice/sections/reports/BookingPaymentsReport.jsx',
  'src/backoffice/sections/EODClose.jsx', 'src/backoffice/sections/Transactions.jsx', 'src/backoffice/sections/BOReports.jsx',
  'src/surfaces/manager/ManagerTeam.jsx', 'src/surfaces/manager/ManagerHome.jsx', 'src/surfaces/manager/ManagerKitchen.jsx',
  'src/surfaces/OwnerSurface.jsx', 'src/surfaces/owner/OwnerDetail.jsx', 'src/lib/ownerStock.js', 'src/lib/ownerPeriod.js',
  'src/lib/aiTools.js', 'src/lib/payments/venueTime.js', 'supabase/functions/manager-snapshot/index.ts',
  'supabase/functions/_shared/ownerSnapshot.js',
  // Receipts, settings, marketing
  'src/lib/printer.js', 'src/components/ReceiptModal.jsx', 'src/lib/printDoc.js', 'src/lib/sendReceipt.js',
  'src/backoffice/sections/ReceiptBranding.jsx', 'src/backoffice/sections/LocationSettings.jsx',
  'src/backoffice/sections/MenuBoards.jsx', 'src/backoffice/sections/Challenge21Report.jsx',
  'src/backoffice/sections/CompanyAdmin.jsx', 'src/backoffice/sections/WaitlistInsights.jsx',
  'src/backoffice/sections/SignInSecurity.jsx', 'src/backoffice/sections/CashDrawers.jsx',
  'src/backoffice/sections/operations/OpsCompliance.jsx', 'src/backoffice/BackOfficeApp.jsx',
  'src/backoffice/sections/stock/LockPeriodModal.jsx', 'src/backoffice/sections/marketing/Campaigns.jsx',
  'src/backoffice/sections/marketing/Workflows.jsx', 'src/backoffice/sections/marketing/Compliance.jsx',
  'src/backoffice/sections/marketing/Promotions.jsx', 'src/backoffice/sections/marketing/QuickSend.jsx',
  'src/backoffice/sections/marketing/MarketingReports.jsx', 'src/backoffice/sections/marketing/Forms.jsx',
  // Stock
  'supabase/functions/_shared/purchasingRules.js', 'src/lib/stock/purchasingWords.js', 'src/lib/stock/dashboardRules.js',
  'src/lib/stock/goLiveRules.js', 'src/lib/stock/supplierListRules.js', 'src/lib/stock/reportView.js',
  'src/lib/stock/reportRules.js', 'src/lib/stock/kitchenRules.js', 'src/lib/stock/batchLabel.js', 'src/lib/stock/venueZone.js',
  'src/backoffice/sections/produce/KitchenPlan.jsx', 'src/backoffice/sections/produce/CentralKitchen.jsx',
  'src/backoffice/sections/purchasing/InvoiceInbox.jsx', 'src/backoffice/sections/purchasing/InvoicesSite.jsx',
  'src/backoffice/sections/purchasing/usePaged.js', 'src/backoffice/sections/purchasing/OrderPadHeaderLine.jsx',
  'src/backoffice/sections/stock/suppliers/SupplierChangesTab.jsx', 'src/backoffice/sections/produce/RecipeList.jsx',
  'src/backoffice/sections/stock/items/CompanyItemList.jsx',
  // the helpers themselves
  'src/lib/venueDates.js', 'supabase/functions/_shared/venueDates.js', 'src/lib/venueDate.js',
];

const BAD = [
  [/toLocaleDateString\(\s*'en-GB'/, "toLocaleDateString('en-GB'"],
  [/toLocaleTimeString\(\s*'en-GB'/, "toLocaleTimeString('en-GB'"],
  [/toLocaleString\(\s*'en-GB'.*\b(weekday|day|month|year|hour|minute|timeZone)\b/, "toLocaleString('en-GB' with a date or time"],
  [/hour12:\s*false/, 'hour12: false'],
  [/(\|\||\?\?)\s*'Europe\/London'/, "a 'Europe/London' fallback"],
  [/(\|\||\?\?|:)\s*'America\/New_York'/, "an 'America/New_York' fallback"],
];
const GATED = /en-US|uses12h|venueLocale|venueCountry|isUs|\bcountry\b|\bus\b|batch 8 ok:/;

test('guard: the fixed files format by the venue, never fixed en-GB words, a forced 24 hour clock or London for all', () => {
  const found = [];
  for (const rel of FIXED) {
    const abs = path.join(ROOT, rel);
    assert.ok(fs.existsSync(abs), `${rel} is on the batch 8 list but not in the tree`);
    fs.readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;                     // a comment line names the old way
      for (const [re, what] of BAD) if (re.test(line) && !GATED.test(line)) found.push(`${rel}:${i + 1} ${what}: ${line.trim().slice(0, 110)}`);
    });
  }
  assert.deepEqual(found, [], `formatted the UK way for every venue:\n${found.join('\n')}`);
});

test('guard: the new helper files have no long dashes', () => {
  for (const rel of ['src/lib/venueDates.js', 'supabase/functions/_shared/venueDates.js', 'src/lib/venueDatesBatch8.test.js', 'src/lib/stock/venueZone.js']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(text, /[\u2013\u2014]/, rel);   // the UK words this test pins are written as \u escapes
  }
});
