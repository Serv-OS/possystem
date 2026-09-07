import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveActiveMenu, isMenuActiveNow, buildMenuScheduleCtx } from './resolveActiveMenu.js';
import { resolveActiveMenu as resolveViaMposShim } from '../mpos/resolveActiveMenu.js';

// Fixed instants. 2026-09-07 is a Monday (ISO day 1). Evaluated in UTC unless a
// test says otherwise, so nowMinutes is simply the UTC wall clock.
const MON_1200 = new Date('2026-09-07T12:00:00Z');
const MON_0300 = new Date('2026-09-07T03:00:00Z');
const MON_2330 = new Date('2026-09-07T23:30:00Z');
const TUE_0100 = new Date('2026-09-08T01:00:00Z');
const SAT_1200 = new Date('2026-09-12T12:00:00Z');
const UTC = 'UTC';

const menu = (id, extra = {}) => ({ id, name: id, ...extra });
const lunchSched = { days: [1, 2, 3, 4, 5, 6, 7], from: '11:00', to: '15:00' };
const eveSched   = { days: [1, 2, 3, 4, 5, 6, 7], from: '17:00', to: '23:00' };

// ── buildMenuScheduleCtx ────────────────────────────────────────────────────
test('buildMenuScheduleCtx: evaluates the given instant in the venue timezone', () => {
  const ctx = buildMenuScheduleCtx(UTC, MON_1200);
  assert.equal(ctx.nowMinutes, 12 * 60);
  assert.equal(ctx.isoDay, 1);
  assert.equal(ctx.day, 1);
  assert.equal(ctx.ymd, '2026-09-07');
});

test('buildMenuScheduleCtx: no now falls back to the real clock without throwing', () => {
  const ctx = buildMenuScheduleCtx('Europe/London');
  assert.ok(ctx.nowMinutes >= 0 && ctx.nowMinutes < 1440);
  assert.ok(ctx.day >= 1 && ctx.day <= 7);
});

// ── isMenuActiveNow ─────────────────────────────────────────────────────────
test('isMenuActiveNow: no schedule is always on', () => {
  assert.equal(isMenuActiveNow(menu('m'), { nowMinutes: 0, isoDay: 7 }), true);
  assert.equal(isMenuActiveNow(menu('m', { schedule: null }), { nowMinutes: 0, isoDay: 7 }), true);
});

test('isMenuActiveNow: string days are coerced (the Provo donuts class)', () => {
  const m = menu('m', { schedule: { days: ['1', '2', '3'], from: '09:00', to: '17:00' } });
  assert.equal(isMenuActiveNow(m, { nowMinutes: 12 * 60, isoDay: 1 }), true);
  assert.equal(isMenuActiveNow(m, { nowMinutes: 12 * 60, isoDay: 6 }), false);
});

test('isMenuActiveNow: an empty days array means every day', () => {
  const m = menu('m', { schedule: { days: [], from: '11:00', to: '15:00' } });
  assert.equal(isMenuActiveNow(m, { nowMinutes: 12 * 60, isoDay: 1 }), true);
  assert.equal(isMenuActiveNow(m, { nowMinutes: 12 * 60, isoDay: 7 }), true);
  assert.equal(isMenuActiveNow(m, { nowMinutes: 16 * 60, isoDay: 7 }), false); // window still applies
});

test('isMenuActiveNow: an unparsable window keeps the menu visible', () => {
  const ctx = { nowMinutes: 3 * 60, isoDay: 1 };
  assert.equal(isMenuActiveNow(menu('m', { schedule: { from: '9', to: '17:00' } }), ctx), true);
  assert.equal(isMenuActiveNow(menu('m', { schedule: { from: 'nope', to: '17:00' } }), ctx), true);
  // numeric from/to used to throw inside the kiosk and MMenu memos
  assert.equal(isMenuActiveNow(menu('m', { schedule: { from: 9, to: 17 } }), ctx), true);
});

test('isMenuActiveNow: inclusive bounds and a window that crosses midnight', () => {
  const late = menu('m', { schedule: { from: '22:00', to: '02:00' } });
  assert.equal(isMenuActiveNow(late, { nowMinutes: 23 * 60 + 30, isoDay: 1 }), true);
  assert.equal(isMenuActiveNow(late, { nowMinutes: 1 * 60, isoDay: 2 }), true);
  assert.equal(isMenuActiveNow(late, { nowMinutes: 2 * 60, isoDay: 2 }), true);   // inclusive end
  assert.equal(isMenuActiveNow(late, { nowMinutes: 2 * 60 + 1, isoDay: 2 }), false);
  assert.equal(isMenuActiveNow(late, { nowMinutes: 22 * 60, isoDay: 1 }), true);      // inclusive start
  assert.equal(isMenuActiveNow(late, { nowMinutes: 21 * 60 + 59, isoDay: 1 }), false);
  assert.equal(isMenuActiveNow(late, { nowMinutes: 12 * 60, isoDay: 1 }), false);
  const lunch = menu('m', { schedule: lunchSched });
  assert.equal(isMenuActiveNow(lunch, { nowMinutes: 15 * 60, isoDay: 1 }), true);  // inclusive end
  assert.equal(isMenuActiveNow(lunch, { nowMinutes: 11 * 60, isoDay: 1 }), true);  // inclusive start
  assert.equal(isMenuActiveNow(lunch, { nowMinutes: 10 * 60 + 59, isoDay: 1 }), false);
});

test('isMenuActiveNow: days-only schedule ignores the clock, one-sided window is ignored', () => {
  // The normal weekend-menu shape: days, no times. On any minute of a listed day, off on others.
  const weekend = menu('m', { schedule: { days: [6, 7] } });
  assert.equal(isMenuActiveNow(weekend, { nowMinutes: 3 * 60, isoDay: 6 }), true);
  assert.equal(isMenuActiveNow(weekend, { nowMinutes: 23 * 60 + 59, isoDay: 7 }), true);
  assert.equal(isMenuActiveNow(weekend, { nowMinutes: 12 * 60, isoDay: 1 }), false);
  // Half-filled window (only from, or only to): not a window, the menu stays on.
  assert.equal(isMenuActiveNow(menu('m', { schedule: { from: '11:00' } }), { nowMinutes: 3 * 60, isoDay: 1 }), true);
  assert.equal(isMenuActiveNow(menu('m', { schedule: { to: '15:00' } }), { nowMinutes: 20 * 60, isoDay: 1 }), true);
  // days still apply alongside a one-sided window
  assert.equal(isMenuActiveNow(menu('m', { schedule: { days: [6, 7], from: '11:00' } }), { nowMinutes: 12 * 60, isoDay: 1 }), false);
  assert.equal(isMenuActiveNow(menu('m', { schedule: { days: [6, 7], to: '15:00' } }), { nowMinutes: 20 * 60, isoDay: 6 }), true);
});

// ── resolveActiveMenu: schedule handling end to end ─────────────────────────
test('resolve: days-only weekend menu wins on Saturday, the default on Monday', () => {
  const menus = [
    menu('main', { is_default: true }),
    menu('weekend', { priority: 5, schedule: { days: [6, 7] } }),
  ];
  assert.equal(resolveActiveMenu({ menus, timezone: UTC, now: SAT_1200 }), 'weekend');
  assert.equal(resolveActiveMenu({ menus, timezone: UTC, now: MON_1200 }), 'main');
  // string days, the shape a jsonb round trip can produce
  menus[1].schedule = { days: ['6', '7'] };
  assert.equal(resolveActiveMenu({ menus, timezone: UTC, now: SAT_1200 }), 'weekend');
  assert.equal(resolveActiveMenu({ menus, timezone: UTC, now: MON_1200 }), 'main');
});

test('resolve: string days resolve the scheduled menu on a matching day', () => {
  const menus = [
    menu('main', { is_default: true }),
    menu('lunch', { priority: 5, schedule: { days: ['1', '2', '3', '4', '5'], from: '11:00', to: '15:00' } }),
  ];
  assert.equal(resolveActiveMenu({ menus, timezone: UTC, now: MON_1200 }), 'lunch');
  assert.equal(resolveActiveMenu({ menus, timezone: UTC, now: SAT_1200 }), 'main');
});

test('resolve: empty days array is every day, not never', () => {
  const menus = [
    menu('main', { is_default: true }),
    menu('lunch', { priority: 5, schedule: { days: [], from: '11:00', to: '15:00' } }),
  ];
  assert.equal(resolveActiveMenu({ menus, timezone: UTC, now: SAT_1200 }), 'lunch');
  assert.equal(resolveActiveMenu({ menus, timezone: UTC, now: MON_0300 }), 'main');
});

test('resolve: unparsable window never hides the menu', () => {
  const menus = [
    menu('main', { is_default: true }),
    menu('odd', { priority: 5, schedule: { from: '9', to: '17:00' } }),
  ];
  assert.equal(resolveActiveMenu({ menus, timezone: UTC, now: MON_0300 }), 'odd');
});

test('resolve: midnight crossing window is on late and early, off midday', () => {
  const menus = [
    menu('main', { is_default: true }),
    menu('late', { priority: 5, schedule: { from: '22:00', to: '02:00' } }),
  ];
  assert.equal(resolveActiveMenu({ menus, timezone: UTC, now: MON_2330 }), 'late');
  assert.equal(resolveActiveMenu({ menus, timezone: UTC, now: TUE_0100 }), 'late');
  assert.equal(resolveActiveMenu({ menus, timezone: UTC, now: MON_1200 }), 'main');
});

test('resolve: venue timezone decides, never the process clock', () => {
  const prevTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    // 17:00Z on 7 Sep 2026 is 18:00 BST in London and 10:00 in Los Angeles.
    const at = new Date('2026-09-07T17:00:00Z');
    assert.equal(at.getHours(), 10, 'process clock is on LA time for this test');
    const menus = [
      menu('main', { is_default: true }),
      menu('evening', { priority: 5, schedule: eveSched }),
    ];
    assert.equal(resolveActiveMenu({ menus, timezone: 'Europe/London', now: at }), 'evening');
    // The same instant on a US Pacific venue is 10:00, so the evening menu is off.
    assert.equal(resolveActiveMenu({ menus, timezone: 'America/Los_Angeles', now: at }), 'main');
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
});

// ── resolveActiveMenu: the pin ──────────────────────────────────────────────
test('resolve: pinned menu on schedule wins over a higher priority menu', () => {
  const menus = [
    menu('main', { is_default: true }),
    menu('lunch', { priority: 9, schedule: lunchSched }),
    menu('bar', { priority: 0 }),
  ];
  assert.equal(resolveActiveMenu({ menus, pinnedMenuId: 'bar', timezone: UTC, now: MON_1200 }), 'bar');
});

test('resolve: pinned off schedule falls to the default, never the priority race', () => {
  const menus = [
    menu('main', { is_default: true }),
    menu('lunch', { priority: 5, schedule: lunchSched }),
    menu('bar', { schedule: eveSched }),
  ];
  assert.equal(resolveActiveMenu({ menus, pinnedMenuId: 'bar', timezone: UTC, now: MON_1200 }), 'main');
});

test('resolve: pinned off schedule with no default keeps the pin', () => {
  const menus = [
    menu('main', { priority: 0 }),
    menu('lunch', { priority: 5, schedule: lunchSched }),
    menu('bar', { schedule: eveSched }),
  ];
  assert.equal(resolveActiveMenu({ menus, pinnedMenuId: 'bar', timezone: UTC, now: MON_1200 }), 'bar');
});

test('resolve: a dangling or inactive pin is ignored and the race runs', () => {
  const menus = [
    menu('main', { is_default: true }),
    menu('lunch', { priority: 5, schedule: lunchSched }),
    menu('old', { is_active: false }),
  ];
  assert.equal(resolveActiveMenu({ menus, pinnedMenuId: 'deleted-menu', timezone: UTC, now: MON_1200 }), 'lunch');
  assert.equal(resolveActiveMenu({ menus, pinnedMenuId: 'old', timezone: UTC, now: MON_1200 }), 'lunch');
});

// ── resolveActiveMenu: priority and defaults ────────────────────────────────
test('resolve: equal priority tie goes to the default, not load order', () => {
  const menus = [
    menu('bar', { sort_order: 0 }),
    menu('main', { is_default: true, sort_order: 1 }),
  ];
  assert.equal(resolveActiveMenu({ menus, timezone: UTC, now: MON_1200 }), 'main');
  // camel spelling from the store reads the same
  const camel = [menu('bar'), menu('main', { isDefault: true })];
  assert.equal(resolveActiveMenu({ menus: camel, timezone: UTC, now: MON_1200 }), 'main');
});

test('resolve: equal priority tie with no default keeps load order (stable sort)', () => {
  // The pre-v5.7.12 rule the till still has for venues that never flagged a
  // default: the first live menu in the array wins. A third sort key (name, id)
  // would silently move which menu an un-flagged venue shows.
  const menus = [menu('bar'), menu('main')];
  assert.equal(resolveActiveMenu({ menus, timezone: UTC, now: MON_1200 }), 'bar');
  assert.equal(resolveActiveMenu({ menus: menus.slice().reverse(), timezone: UTC, now: MON_1200 }), 'main');
  // same with explicit equal priorities
  const prio = [menu('zeta', { priority: 2 }), menu('alpha', { priority: 2 })];
  assert.equal(resolveActiveMenu({ menus: prio, timezone: UTC, now: MON_1200 }), 'zeta');
});

test('resolve: higher priority beats the default when both are on', () => {
  const menus = [menu('main', { is_default: true, priority: 0 }), menu('happy', { priority: 3 })];
  assert.equal(resolveActiveMenu({ menus, timezone: UTC, now: MON_1200 }), 'happy');
});

test('resolve: nothing on and no default picks the highest priority live menu', () => {
  const menus = [
    menu('lunch', { priority: 5, schedule: lunchSched }),
    menu('evening', { priority: 7, schedule: eveSched }),
  ];
  assert.equal(resolveActiveMenu({ menus, timezone: UTC, now: MON_0300 }), 'evening');
});

test('resolve: nothing on with a default returns the default', () => {
  const menus = [
    menu('main', { is_default: true }),
    menu('lunch', { priority: 5, schedule: lunchSched }),
  ];
  // main has no schedule so it is on; give it one so nothing is on at 03:00
  menus[0].schedule = { from: '08:00', to: '20:00' };
  assert.equal(resolveActiveMenu({ menus, timezone: UTC, now: MON_0300 }), 'main');
});

test('resolve: null when there are no menus, even with a pin', () => {
  assert.equal(resolveActiveMenu({ menus: [], timezone: UTC, now: MON_1200 }), null);
  assert.equal(resolveActiveMenu({ menus: [], pinnedMenuId: 'menu-2', timezone: UTC, now: MON_1200 }), null);
  assert.equal(resolveActiveMenu({ menus: null, timezone: UTC, now: MON_1200 }), null);
  assert.equal(resolveActiveMenu({}), null);
});

test('resolve: inactive menus never win (both spellings)', () => {
  const menus = [menu('a', { isActive: false, priority: 9 }), menu('b', { is_active: false, priority: 8 }), menu('c')];
  assert.equal(resolveActiveMenu({ menus, timezone: UTC, now: MON_1200 }), 'c');
  // is_active NULL stays live (nullable column)
  assert.equal(resolveActiveMenu({ menus: [menu('n', { is_active: null })], timezone: UTC, now: MON_1200 }), 'n');
});

// ── resolveActiveMenu: category awareness (never-blank) ─────────────────────
test('resolve: an empty menu is skipped when categories are supplied', () => {
  const menus = [
    menu('main', { is_default: true, priority: 0 }),
    menu('newtest', { priority: 5 }),
  ];
  const categories = [{ id: 'c1', menu_id: 'main' }];
  assert.equal(resolveActiveMenu({ menus, categories, links: [], timezone: UTC, now: MON_1200 }), 'main');
  // without categories the caller opted out of the skip and priority wins
  assert.equal(resolveActiveMenu({ menus, timezone: UTC, now: MON_1200 }), 'newtest');
});

test('resolve: a pin to an empty menu is ignored', () => {
  const menus = [menu('main', { is_default: true }), menu('empty', { priority: 5 })];
  const categories = [{ id: 'c1', menuId: 'main' }];
  assert.equal(resolveActiveMenu({ menus, categories, links: [], pinnedMenuId: 'empty', timezone: UTC, now: MON_1200 }), 'main');
});

test('resolve: a links-only menu counts as non empty', () => {
  const menus = [menu('main', { is_default: true }), menu('bar', { priority: 5 })];
  const categories = [{ id: 'drinks', menu_id: 'main' }, { id: 'food', menu_id: 'main' }];
  const links = [{ menu_id: 'bar', category_id: 'drinks' }];
  assert.equal(resolveActiveMenu({ menus, categories, links, timezone: UTC, now: MON_1200 }), 'bar');
  // a link to a sub category or a special category does not make the menu non empty
  const cats2 = [{ id: 'drinks', menu_id: 'main' }, { id: 'beer', menu_id: 'main', parent_id: 'drinks' }, { id: 'spec', menu_id: 'main', is_special: true }];
  const links2 = [{ menu_id: 'bar', category_id: 'beer' }, { menu_id: 'bar', category_id: 'spec' }];
  assert.equal(resolveActiveMenu({ menus, categories: cats2, links: links2, timezone: UTC, now: MON_1200 }), 'main');
});

test('resolve: snake is_special categories do not make a menu non empty', () => {
  const menus = [menu('main', { is_default: true }), menu('specials', { priority: 5 })];
  const categories = [{ id: 'c1', menu_id: 'main' }, { id: 's1', menu_id: 'specials', is_special: true }];
  assert.equal(resolveActiveMenu({ menus, categories, links: [], timezone: UTC, now: MON_1200 }), 'main');
});

test('resolve: when every live menu is empty, all live menus are considered', () => {
  const menus = [menu('main', { is_default: true }), menu('other', { priority: 5 })];
  assert.equal(resolveActiveMenu({ menus, categories: [], links: [], timezone: UTC, now: MON_1200 }), 'other');
});

test('resolve: when every live menu is empty the pin is still honoured', () => {
  // A fresh build: menus exist, no category assigned yet. The pin is the
  // operator's intent and there is no non-empty menu to prefer over it.
  const menus = [menu('main', { is_default: true }), menu('bar', { priority: 5 })];
  assert.equal(resolveActiveMenu({ menus, categories: [], links: [], pinnedMenuId: 'bar', timezone: UTC, now: MON_1200 }), 'bar');
  assert.equal(resolveActiveMenu({ menus, categories: [], links: [], pinnedMenuId: 'bar', timezone: UTC, now: MON_0300 }), 'bar');
  // categories that name no live menu behave the same as none
  const strayCats = [{ id: 'c1', menu_id: 'deleted-menu' }];
  assert.equal(resolveActiveMenu({ menus, categories: strayCats, links: [], pinnedMenuId: 'bar', timezone: UTC, now: MON_1200 }), 'bar');
});

// ── the MPOS shim maps the old signature onto the shared chain ──────────────
test('mpos shim: deviceConfig.menuId becomes the pin and gains the hardening', () => {
  const menus = [
    menu('main', { isDefault: true }),
    menu('bar', { schedule: { days: ['1', '2', '3', '4', '5', '6', '7'], from: '17:00', to: '23:00' } }),
  ];
  assert.equal(resolveViaMposShim({ menus, deviceConfig: { menuId: 'bar' }, timezone: UTC, now: MON_1200 }), 'main');
  assert.equal(resolveViaMposShim({ menus, deviceConfig: { menuId: 'bar' }, timezone: UTC, now: new Date('2026-09-07T18:00:00Z') }), 'bar');
  assert.equal(resolveViaMposShim({ menus: [], deviceConfig: { menuId: 'bar' }, timezone: UTC }), null);
});
