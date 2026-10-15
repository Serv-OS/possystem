// ownerDetail.test.js: the Owner app's venue screen, the part that is not drawing.
//
// 5 Oct 2026: tap a venue card for its seven reports. The app ships before the function is
// deployed, so the tests that matter most here are the ones for an answer that is NOT what
// was asked for: an old function, another venue, another period.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DETAIL_NEEDS_UPDATE, groupTarget, venueTarget, detailRequest, detailKey, canDetail, readDetail, detailRange,
  hourLabel, hourChart, hoursLineWords, weekChart, shareRows, paymentMix, paymentLabel, orderTypeLabel, channelLabel,
  labourView, nothingSold,
} from './ownerDetail.js';

const read = (p) => fs.readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

const leeds = venueTarget({ ops_location_id: 'leeds', name: 'Leeds', currency: 'GBP' });
const group = groupTarget('GBP', 6);
const range = { from: '2026-10-05', to: '2026-10-05', cmp_from: '2026-09-28', cmp_to: '2026-09-28', cmp_time: '14:00' };
const venueAnswer = (id = 'leeds', period = 'today') => ({
  ok: true, api: 2, period,
  detail: { scope: { kind: 'venue', currency: 'GBP', other_currencies: [], locations: [{ ops_location_id: id, name: 'Leeds', range }] }, range, totals: { orders: 3 } },
});
const groupAnswer = (currency = 'GBP', period = 'today') => ({
  ok: true, api: 2, period,
  detail: { scope: { kind: 'group', currency, other_currencies: [], locations: [{ ops_location_id: 'a' }, { ops_location_id: 'b' }] }, range: null },
});

test('what the function is asked for', () => {
  assert.deepEqual(detailRequest(leeds, 'week'), { period: 'week', detail: 'leeds' });
  assert.deepEqual(detailRequest(group, 'month'), { period: 'month', detail: 'group', currency: 'GBP' });
  // One currency and an older answer that named none: the function picks the only one.
  assert.deepEqual(detailRequest(groupTarget(null, 2), 'today'), { period: 'today', detail: 'group' });
  assert.deepEqual(detailRequest(leeds, 'nonsense'), { period: 'today', detail: 'leeds' });
});

test('an answer is kept under the venue, currency and period it was asked with', () => {
  const keys = new Set([
    detailKey(leeds, 'today'), detailKey(leeds, 'week'), detailKey(leeds, 'month'),
    detailKey(venueTarget({ ops_location_id: 'york', name: 'York', currency: 'GBP' }), 'today'),
    detailKey(group, 'today'), detailKey(groupTarget('USD', 1), 'today'),
  ]);
  assert.equal(keys.size, 6);
  assert.equal(detailKey(leeds, 'today'), detailKey({ ...leeds }, 'today'));
});

test('an old function: no detail in the answer means the update line, never the snapshot', () => {
  // A function from before the detail call ignores `detail` and answers the plain snapshot.
  const snapshot = { ok: true, period: 'today', locations: [{ ops_location_id: 'leeds', today: { net_sales: 500 } }], rollup: { net_sales: 500 } };
  assert.deepEqual(readDetail(snapshot, leeds, 'today'), { state: 'needs_update', detail: null });
  assert.deepEqual(readDetail(snapshot, group, 'week'), { state: 'needs_update', detail: null });
  assert.equal(readDetail(null, leeds, 'today').state, 'needs_update');
  assert.equal(readDetail({ detail: 'yes' }, leeds, 'today').state, 'needs_update');
  assert.equal(canDetail(snapshot), false, 'it sends no feature list, so it is not asked at all');
  assert.equal(canDetail({ features: ['period', 'business_day', 'compare', 'by_currency', 'detail'] }), true);
  assert.equal(DETAIL_NEEDS_UPDATE, 'More reports need a ServOS update');
});

test('only an answer for this venue and this period is drawn', () => {
  assert.equal(readDetail(venueAnswer(), leeds, 'today').state, 'ok');
  assert.equal(readDetail(venueAnswer('york'), leeds, 'today').state, 'mismatch', 'another venue');
  assert.equal(readDetail(venueAnswer('leeds', 'week'), leeds, 'today').state, 'mismatch', 'another period');
  assert.equal(readDetail(groupAnswer(), leeds, 'today').state, 'mismatch', 'the group, for a venue');
  assert.equal(readDetail(venueAnswer(), group, 'today').state, 'mismatch', 'a venue, for the group');
  assert.equal(readDetail(groupAnswer('GBP'), group, 'today').state, 'ok');
  assert.equal(readDetail(groupAnswer('USD'), group, 'today').state, 'mismatch', 'dollars are never shown as the pound group');
  assert.equal(readDetail(groupAnswer('USD'), groupTarget(null, 2), 'today').state, 'ok', 'no currency asked: the function chose');
  assert.equal(readDetail(venueAnswer(), leeds, 'today').detail.totals.orders, 3);
});

test('the dates for the words: the shared ones, or the one venue\'s', () => {
  assert.equal(detailRange(venueAnswer().detail), range);
  assert.equal(detailRange({ range: null, scope: { locations: [{ range }] } }), range);
  // A group whose venues sit on different dates has no one range.
  assert.equal(detailRange(groupAnswer().detail), null);
  assert.equal(detailRange(null), null);
});

test('sales by hour: bars and the comparison on one scale', () => {
  assert.equal(hourLabel(6), '6am');
  assert.equal(hourLabel(12), '12pm');
  assert.equal(hourLabel(0), '12am');
  assert.equal(hourLabel(23), '11pm');
  const c = hourChart([
    { hour: 7, net: 50, orders: 10, cmp_net: 100 },
    { hour: 8, net: 200, orders: 40, cmp_net: 150 },
    { hour: 9, net: 0, orders: 0, cmp_net: 400 },
  ]);
  assert.equal(c.max, 400, 'the scale covers the comparison too, so the line never leaves the chart');
  assert.deepEqual(c.rows.map((r) => [r.label, r.h, r.ch]), [['7am', 0.125, 0.25], ['8am', 0.5, 0.375], ['9am', 0, 1]]);
  assert.equal(c.peak.label, '8am');
  assert.equal(c.hasCmp, true);
  const none = hourChart([]);
  assert.deepEqual([none.rows.length, none.max, none.peak, none.hasCmp], [0, 0, null, false]);
  assert.equal(hourChart(null).rows.length, 0);
  assert.equal(hourChart([{ hour: 7, net: 5, orders: 1, cmp_net: 0 }]).hasCmp, false);
  // The faint line is the comparison's whole day, and says so.
  assert.equal(hoursLineWords('today', range), 'last Monday, whole day');
  assert.equal(hoursLineWords('week', range), 'same days last week');
  assert.equal(hoursLineWords('month', range), 'same days last month');
});

test('week by day: a day that has not come yet is not a day of nothing', () => {
  const c = weekChart([
    { dow: 'Mon', date: '2026-10-05', net: 300, last_net: 600 },
    { dow: 'Tue', date: '2026-10-06', net: null, last_net: 450 },
  ]);
  assert.equal(c.max, 600);
  assert.deepEqual(c.rows[0], { dow: 'Mon', date: '2026-10-05', net: 300, last: 600, w: 0.5, lw: 1 });
  assert.equal(c.rows[1].net, null, 'drawn as a dash');
  assert.equal(c.rows[1].w, 0);
  assert.equal(c.rows[1].lw, 0.75);
  assert.equal(weekChart(null).max, 0);
});

test('shares add up from the rows that are worth something', () => {
  const rows = shareRows([{ type: 'takeaway', net: 300 }, { type: 'dine-in', net: 100 }, { type: 'delivery', net: 0 }], 'net');
  assert.deepEqual(rows.map((r) => [r.type, r.share, r.w]), [['takeaway', 75, 1], ['dine-in', 25, 1 / 3]]);
  assert.deepEqual(shareRows(null, 'net'), []);
});

test('payment mix: loyalty and promo credit are never takings', () => {
  const mix = paymentMix([
    { kind: 'card', amount: 900, checks: 90, money: true },
    { kind: 'cash', amount: 100, checks: 12, money: true },
    { kind: 'loyalty', amount: 40, checks: 8, money: false },
    { kind: 'promo', amount: 0, checks: 0, money: false },
  ]);
  assert.deepEqual(mix.money.map((p) => [p.label, p.share]), [['Card', 90], ['Cash', 10]], 'the shares are of money taken only');
  assert.deepEqual(mix.credits.map((p) => [p.label, p.amount]), [['Loyalty', 40]]);
  assert.deepEqual(paymentMix(null), { money: [], credits: [] });
});

test('plain words for kinds, types and channels, and a kind nobody listed still reads', () => {
  assert.equal(paymentLabel('gift_card'), 'Gift card');
  assert.equal(paymentLabel('promo'), 'Promo credit');
  assert.equal(paymentLabel('some_new_kind'), 'Some new kind');
  assert.equal(orderTypeLabel('dine-in'), 'Eat in');
  assert.equal(orderTypeLabel('drive-thru'), 'Drive thru');
  assert.equal(orderTypeLabel('click-and-collect'), 'Click and collect');
  assert.equal(channelLabel('pos'), 'Till');
  assert.equal(channelLabel('qr'), 'QR');
  assert.equal(channelLabel(null), 'Other');
});

test('labour: over only against the venue\'s own target; no timesheets means no card', () => {
  assert.equal(labourView(null), null);
  const over = labourView({ cost: 320, hours: 28.5, shifts: 4, net_sales: 1000, pct: 32, target_pct: 28 });
  assert.equal(over.over, true);
  assert.equal(over.w, 1);
  assert.equal(over.tw, 0.875);
  const under = labourView({ cost: 200, hours: 18, shifts: 3, net_sales: 1000, pct: 20, target_pct: 28 });
  assert.equal(under.over, false);
  assert.ok(Math.abs(under.w - 20 / 28) < 1e-9);
  // A group has no single target, so it is never marked over.
  const grp = labourView({ cost: 900, hours: 80, shifts: 12, net_sales: 2000, pct: 45, target_pct: null });
  assert.deepEqual([grp.over, grp.target, grp.tw], [false, null, null]);
  // Timesheets but no sales yet: no percent, not "Infinity%".
  assert.equal(labourView({ cost: 50, hours: 4, shifts: 1, net_sales: 0, pct: null, target_pct: 28 }).pct, null);
});

test('nothing at all in the period', () => {
  assert.equal(nothingSold({ totals: { orders: 0 }, hours: [], week: [{ net: 0, last_net: 0 }], exceptions: {}, labour: null }), true);
  assert.equal(nothingSold({ totals: { orders: 0 }, hours: [], week: [{ net: null, last_net: 80 }], exceptions: {}, labour: null }), false);
  assert.equal(nothingSold({ totals: { orders: 2 }, hours: [], week: [], exceptions: {}, labour: null }), false);
  assert.equal(nothingSold({ totals: { orders: 0 }, hours: [], week: [], exceptions: { voids: { count: 1 } }, labour: null }), false);
});

test('the venue screen: tap to open, a clear back, and never another venue\'s or period\'s numbers', () => {
  const surface = read('../surfaces/OwnerSurface.jsx');
  const screen = read('../surfaces/owner/OwnerDetail.jsx');
  const reports = read('../surfaces/owner/OwnerReports.jsx');

  // Every venue card and every group card opens the screen.
  assert.ok(surface.includes('onOpen={() => openDetail(venueTarget(l))}'));
  assert.ok(surface.includes('openDetail(groupTarget('));
  assert.ok(surface.includes("role: 'button', tabIndex: 0"), 'a card is a button to a keyboard and a screen reader too');
  // Back: the button, and the phone's own back, close it.
  assert.ok(surface.includes('onBack={closeDetail} backLabel="Back"'));
  assert.ok(surface.includes("window.addEventListener('popstate', onPop);"));
  assert.ok(surface.includes('ownerDetail: true'));
  assert.ok(screen.includes('<button onClick={onBack} style={backBtn} aria-label={backLabel}>'));
  // The same three chips drive it, and the arrow refreshes it.
  assert.ok(surface.includes('<OwnerDetail target={open} period={period} supported={canDetail(data)} tick={tick}'));
  assert.ok(surface.includes('const refresh = useCallback(() => { load(period); setTick((n) => n + 1); }, [load, period]);'));

  // The call is raced against a timer and a late answer is dropped.
  assert.ok(screen.includes("supabase.functions.invoke('owner-snapshot', { body: detailRequest(target, period) })"));
  assert.ok(screen.includes("period === 'month' ? MONTH_DETAIL_TIMEOUT_MS : DETAIL_TIMEOUT_MS, 'Owner reports')"));
  assert.ok(screen.includes('if (mine !== seq.current) return;'));
  assert.ok(screen.includes('return () => { clearInterval(t); seq.current += 1; };'), 'an answer on its way when the chip changes is dropped');
  // Only an answer asked for with this venue and period is drawn.
  assert.ok(screen.includes('const mine = got?.key === key ? got : null;'));
  assert.ok(screen.includes("const detail = mine?.state === 'ok' ? mine.detail : null;"));
  assert.ok(screen.includes("if (r.state === 'mismatch') throw new Error("));
  // An old function: the line, and it is not even asked.
  assert.ok(screen.includes("const needsUpdate = !supported || mine?.state === 'needs_update';"));
  assert.ok(screen.includes('if (!supported) return undefined;'));
  assert.ok(screen.includes('{DETAIL_NEEDS_UPDATE}'));
  // Loading and failure are said out loud.
  assert.ok(screen.includes('{!needsUpdate && !detail && !failed && ('));
  assert.ok(screen.includes('e instanceof TimeoutError'));
  assert.ok(screen.includes('<button style={linkBtn} onClick={load}>Try again</button>'));

  // The seven reports, and labour hides itself with no timesheets.
  for (const title of ['Sales by hour', 'Week by day', 'Payment mix', 'Order types and channels', 'Discounts, voids and refunds', 'Top items', 'Labour against sales']) {
    assert.ok(reports.includes(`title="${title}"`), title);
  }
  assert.ok(reports.includes('if (!v) return null;'));
  // 8 Oct 2026: the Sales mix card sits second, right after Sales by hour, and a function from
  // before the mix (no detail.mix) gets no card at all.
  const hoursAt = reports.indexOf('<HoursCard hours={detail.hours} period={period} range={range} m={m} />');
  const mixAt = reports.indexOf('<SalesMixCard mix={detail.mix} period={period} m={m} />');
  const weekAt = reports.indexOf('<WeekCard week={detail.week} m={m} />');
  assert.ok(hoursAt > 0 && hoursAt < mixAt && mixAt < weekAt, 'Sales mix is the second card');
  assert.ok(reports.includes('title="Sales mix"'));
  assert.ok(reports.includes('if (!mix) return null;'));
  // Void reasons are not in the database: the card says so and never makes one up.
  assert.ok(reports.includes('if (e.reasons == null) {'));
  // No chart library: nothing imported but React and the app's own files.
  const bar = read('../surfaces/owner/MixBar.jsx');
  for (const src of [screen, reports, bar]) {
    for (const m of src.matchAll(/from '([^']+)'/g)) assert.ok(m[1] === 'react' || m[1].startsWith('.'), `unexpected import ${m[1]}`);
  }
});

// The two long dashes, built from their codes so this file carries neither of them itself.
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

test('no em or en dash is used as punctuation in the words on screen', () => {
  for (const p of ['./ownerCompare.js', './ownerDetail.js', './ownerMix.js', '../surfaces/owner/OwnerDetail.jsx', '../surfaces/owner/OwnerReports.jsx', '../surfaces/owner/MixBar.jsx']) {
    assert.doesNotMatch(read(p), LONG_DASHES, p);
  }
});
