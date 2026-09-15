// New kiosk design: the flag, the screen map, the start screen rules and the canvas
// (lib/kioskFlow.js).

import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  KIOSK_NEW_DESIGN_READY,
  kioskNewDesignOn,
  resolveV2Screen,
  KIOSK_TABLE_MODES,
  kioskStartModel,
  kioskStartTitleKey,
  nextAfterStart,
  kioskTableStatus,
  keypadNext,
  keypadKeyFromKeyboard,
  nextViewport,
  kioskCanvasSize,
  kioskStartFooterKey,
  kioskModeLabels,
  kioskResetAllowed,
  kioskIdlePaused,
  KIOSK_DONE_COUNTDOWN,
  nextCountdown,
  kioskDoneModel,
  kioskPointsOnlyAttribution,
} from './kioskFlow.js';

test('the build is ready, but only a profile switched on gets the new design', () => {
  assert.equal(KIOSK_NEW_DESIGN_READY, true);
  assert.equal(kioskNewDesignOn({ kiosk_new_design: true }), true);
  // Every profile from before the migration, and every profile left off, keeps today's kiosk.
  assert.equal(kioskNewDesignOn({}), false);
  assert.equal(kioskNewDesignOn({ kiosk_new_design: false }), false);
  assert.equal(kioskNewDesignOn(null), false);
});

test('kioskNewDesignOn needs BOTH a ready build and the profile switch', () => {
  const ready = { ready: true };
  assert.equal(kioskNewDesignOn({ kiosk_new_design: true }, ready), true);
  // Missing column (profile row from before the migration) means off.
  assert.equal(kioskNewDesignOn({ kiosk_brand_color: '#fff' }, ready), false);
  assert.equal(kioskNewDesignOn({ kiosk_new_design: false }, ready), false);
  assert.equal(kioskNewDesignOn({ kiosk_new_design: null }, ready), false);
  assert.equal(kioskNewDesignOn({ kiosk_new_design: 'true' }, ready), false);
  assert.equal(kioskNewDesignOn(null, ready), false);
  assert.equal(kioskNewDesignOn(undefined, ready), false);
  // Ready must be exactly true.
  assert.equal(kioskNewDesignOn({ kiosk_new_design: true }, { ready: false }), false);
  assert.equal(kioskNewDesignOn({ kiosk_new_design: true }, { ready: 1 }), false);
});

test('resolveV2Screen maps shared screen values, gift lands on review, unknown shows tap to start', () => {
  for (const s of ['attract', 'start', 'menu', 'review', 'pay', 'done']) assert.equal(resolveV2Screen(s), s);
  assert.equal(resolveV2Screen('gift'), 'review');
  for (const s of ['orderType', 'tableNumber', 'item', 'cart', 'tip', 'loyalty', '', null, undefined, 42]) {
    assert.equal(resolveV2Screen(s), 'attract');
  }
});

test('kioskStartModel covers every table mode, unknown reads as either', () => {
  assert.deepEqual(KIOSK_TABLE_MODES, ['enter', 'either', 'dispense', 'none']);

  // Peter, 15 Sep 2026: per kiosk, "Table plan / Type a table number / Flag number / Take away only".
  // Type a table number: the keypad, a table.
  const enter = kioskStartModel('enter');
  assert.deepEqual(enter.tiles, ['dineIn', 'takeaway']);
  assert.equal(enter.eatInLeadsTo, 'table');
  assert.equal(enter.allowNoTable, false);
  assert.equal(enter.eatInSubKey, 'k2.start.eatInSub');
  assert.equal(enter.tableEntry, 'keypad');
  assert.equal(enter.numberKind, 'table');

  // Table plan: the tables (keypad only as fallback), "no table" still allowed as before.
  const either = kioskStartModel('either');
  assert.equal(either.eatInLeadsTo, 'table');
  assert.equal(either.allowNoTable, true);
  assert.equal(either.eatInSubKey, 'k2.start.eatInSub');
  assert.equal(either.tableEntry, 'plan');
  assert.equal(either.numberKind, 'table');

  // Flag number: the keypad, the number on the flag (kept as the table number, so "Table 12").
  // Before v5.8.76 this went straight to the menu and asked for nothing.
  const dispense = kioskStartModel('dispense');
  assert.deepEqual(dispense.tiles, ['dineIn', 'takeaway']);
  assert.equal(dispense.eatInLeadsTo, 'table');
  assert.equal(dispense.allowNoTable, false);
  assert.equal(dispense.eatInSubKey, 'k2.start.eatInSubFlag');
  assert.equal(dispense.tableEntry, 'keypad');
  assert.equal(dispense.numberKind, 'flag');

  const none = kioskStartModel('none');
  assert.equal(none.takeawayOnly, true);
  assert.deepEqual(none.tiles, ['takeaway']);
  assert.equal(none.titleKey, 'k2.start.titleTakeawayOnly');
  assert.equal(none.eatInLeadsTo, null);
  assert.equal(none.tableEntry, null);

  for (const odd of [undefined, null, '', 'grid', 'ENTER']) {
    assert.deepEqual(kioskStartModel(odd), { ...either });
  }
});

test('kioskStartTitleKey switches to the eat in headline only on the table step', () => {
  assert.equal(kioskStartTitleKey(kioskStartModel('either'), 'mode'), 'k2.start.title');
  assert.equal(kioskStartTitleKey(kioskStartModel('either'), 'table'), 'k2.start.titleEatIn');
  assert.equal(kioskStartTitleKey(kioskStartModel('enter'), 'table'), 'k2.start.titleEatIn');
  assert.equal(kioskStartTitleKey(kioskStartModel('dispense'), 'table'), 'k2.start.titleEatInFlag');
  assert.equal(kioskStartTitleKey(kioskStartModel('none'), 'table'), 'k2.start.titleTakeawayOnly');
  assert.equal(kioskStartTitleKey(null, 'mode'), 'k2.start.title');
});

test('nextAfterStart returns to review only when the customer came from review', () => {
  assert.equal(nextAfterStart({ returnTo: 'review' }), 'review');
  assert.equal(nextAfterStart({ returnTo: null }), 'menu');
  assert.equal(nextAfterStart({}), 'menu');
  assert.equal(nextAfterStart(), 'menu');
});

test('kioskTableStatus: a failed or empty read gives the keypad', () => {
  assert.equal(kioskTableStatus({ ok: true, tables: [{ id: 1, label: 'T1' }] }), 'ok');
  assert.equal(kioskTableStatus({ ok: true, tables: [] }), 'empty');
  assert.equal(kioskTableStatus({ ok: false, tables: [] }), 'failed');
  assert.equal(kioskTableStatus(null), 'failed');
  assert.equal(kioskTableStatus({ ok: true }), 'empty');
});

test('keypadNext: digits up to the cap, clear, delete, junk ignored', () => {
  assert.equal(keypadNext('', '1', 4), '1');
  assert.equal(keypadNext('123', '4', 4), '1234');
  assert.equal(keypadNext('1234', '5', 4), '1234');
  assert.equal(keypadNext('12', 'del', 4), '1');
  assert.equal(keypadNext('', 'del', 4), '');
  assert.equal(keypadNext('12', 'clear', 4), '');
  assert.equal(keypadNext('12', 'x', 4), '12');
  assert.equal(keypadNext('12', '12', 4), '12');
  assert.equal(keypadNext('1a2', '3'), '123');
  assert.equal(keypadNext(null, '7', 11), '7');
});

test('kioskCanvasSize: the design size, half size, landscape and a taller phone', () => {
  assert.deepEqual(kioskCanvasSize({ vw: 1080, vh: 1920, maxVh: 1920 }), { scale: 1, width: 1080, height: 1920, offsetX: 0, landscape: false });
  assert.deepEqual(kioskCanvasSize({ vw: 540, vh: 960, maxVh: 960 }), { scale: 0.5, width: 1080, height: 1920, offsetX: 0, landscape: false });

  const land = kioskCanvasSize({ vw: 1920, vh: 1080, maxVh: 1080 });
  assert.equal(land.scale, 0.5625);
  assert.equal(land.height, 1920);
  assert.equal(land.landscape, true);
  assert.equal(land.offsetX, (1920 - 1080 * 0.5625) / 2);

  const tall = kioskCanvasSize({ vw: 1080, vh: 2340, maxVh: 2340 });
  assert.equal(tall.scale, 1);
  assert.equal(tall.height, 2340);

  // A squat portrait tablet is height limited: 1920 tall, centred.
  const tablet = kioskCanvasSize({ vw: 768, vh: 1024, maxVh: 1024 });
  assert.equal(tablet.height, 1920);
  assert.equal(tablet.landscape, true);

  // Junk falls back to the design size.
  assert.equal(kioskCanvasSize({}).scale, 1);
  assert.equal(kioskCanvasSize().height, 1920);
});

test('the on screen keyboard never shrinks the canvas', () => {
  let vp = nextViewport(null, 1080, 1920);
  assert.deepEqual(vp, { vw: 1080, vh: 1920, maxVh: 1920 });
  vp = nextViewport(vp, 1080, 1100, true);           // keyboard up while typing
  assert.equal(vp.maxVh, 1920);
  assert.deepEqual(kioskCanvasSize(vp), { scale: 1, width: 1080, height: 1920, offsetX: 0, landscape: false });
  vp = nextViewport(vp, 1080, 1920, false);          // keyboard down
  assert.equal(vp.maxVh, 1920);
  // Not typing: a real resize is followed.
  assert.equal(nextViewport({ vw: 1080, vh: 1920, maxVh: 1920 }, 1080, 1500, false).maxVh, 1500);
  // Rotation starts again even while typing.
  assert.equal(nextViewport({ vw: 1080, vh: 1920, maxVh: 1920 }, 1920, 1080, true).maxVh, 1080);
});

test('kioskStartFooterKey: points first, then the text line, else none', () => {
  assert.equal(kioskStartFooterKey({ loyaltyEnabled: true, smsEnabled: true }), 'k2.start.footerPoints');
  assert.equal(kioskStartFooterKey({ loyaltyEnabled: true, smsEnabled: false }), 'k2.start.footerPoints');
  assert.equal(kioskStartFooterKey({ loyaltyEnabled: false, smsEnabled: true }), 'k2.start.footerText');
  assert.equal(kioskStartFooterKey({ loyaltyEnabled: false, smsEnabled: false }), null);
  assert.equal(kioskStartFooterKey(), null);
});

test('kioskModeLabels for eat in with a table, eat in anywhere, and take away', () => {
  assert.deepEqual(kioskModeLabels({ orderType: 'dineIn', tableNumber: 'B5' }), { titleKey: 'k2.menu.eatIn', subKey: 'k2.menu.table', vars: { table: 'B5' } });
  assert.deepEqual(kioskModeLabels({ orderType: 'dineIn', tableNumber: '  ' }), { titleKey: 'k2.menu.eatIn', subKey: 'k2.menu.anywhere', vars: {} });
  assert.deepEqual(kioskModeLabels({ orderType: 'takeaway', tableNumber: 'B5' }), { titleKey: 'k2.menu.takeaway', subKey: 'k2.menu.collect', vars: {} });
  assert.equal(kioskModeLabels().subKey, 'k2.menu.collect');
});

test('kioskResetAllowed: a reset with no reason is ignored only in the new design', () => {
  // Today's kiosk resets for every call, exactly as before.
  assert.equal(kioskResetAllowed(undefined, false), true);
  assert.equal(kioskResetAllowed('cancel', false), true);
  // New design: submitOrder's 30 second timer (no reason) can never wipe the next basket.
  assert.equal(kioskResetAllowed(undefined, true), false);
  for (const reason of ['cancel', 'idle', 'done', 'countdown', 'staff']) assert.equal(kioskResetAllowed(reason, true), true);
});

test('kioskIdlePaused: the reader, saving and staff phases pause the idle timer', () => {
  for (const p of ['connecting', 'waiting', 'saving', 'askStaff']) assert.equal(kioskIdlePaused(p), true, p);
  for (const p of ['declined', 'covered', null, undefined, 'menu']) assert.equal(kioskIdlePaused(p), false, String(p));
});

test('nextCountdown: counts down from 20 and stops at 0', () => {
  assert.equal(KIOSK_DONE_COUNTDOWN, 20);
  let n = KIOSK_DONE_COUNTDOWN;
  for (let i = 0; i < 25; i++) n = nextCountdown(n);
  assert.equal(n, 0);
  assert.equal(nextCountdown(1), 0);
  assert.equal(nextCountdown(0), 0);
  assert.equal(nextCountdown(-3), 0);
  assert.equal(nextCountdown('x'), 0);
});

test('kioskDoneModel: the four messages', () => {
  assert.deepEqual(
    kioskDoneModel({ orderType: 'dineIn', tableNumber: 'T4' }).messageKey, 'k2.done.eatInTable');
  assert.deepEqual(kioskDoneModel({ orderType: 'dineIn', tableNumber: ' T4 ' }).messageVars, { table: 'T4' });
  assert.equal(kioskDoneModel({ orderType: 'dineIn', tableNumber: '' }).messageKey, 'k2.done.eatInAnywhere');
  assert.equal(kioskDoneModel({ orderType: 'takeaway', textSent: true }).messageKey, 'k2.done.takeawayText');
  assert.equal(kioskDoneModel({ orderType: 'takeaway', textSent: false }).messageKey, 'k2.done.takeaway');
  // Eat in with no table collects too, so a ready text is promised when one went through (decision 9).
  assert.equal(kioskDoneModel({ orderType: 'dineIn', tableNumber: '', textSent: true }).messageKey, 'k2.done.eatInAnywhereText');
});

test('kioskDoneModel: the points line needs loyalty and a number; the alcohol line follows the order', () => {
  const on = kioskDoneModel({ orderType: 'takeaway', pointsMasked: '•••• •••123', loyaltyEnabled: true });
  assert.equal(on.pointsKey, 'k2.done.points');
  assert.deepEqual(on.pointsVars, { masked: '•••• •••123' });
  assert.equal(kioskDoneModel({ orderType: 'takeaway', pointsMasked: '•••• •••123', loyaltyEnabled: false }).pointsKey, null);
  assert.equal(kioskDoneModel({ orderType: 'takeaway', pointsMasked: '', loyaltyEnabled: true }).pointsKey, null);
  assert.equal(kioskDoneModel({ orderType: 'takeaway', hasAlcohol: true }).showAlcohol, true);
  assert.equal(kioskDoneModel({ orderType: 'takeaway' }).showAlcohol, false);
});

test('kioskPointsOnlyAttribution: only a points number that did not go to submitOrder', () => {
  assert.equal(kioskPointsOnlyAttribution({ loyaltyEnabled: true, phoneE164: '+447700900123', submittedPhone: '' }), true);
  // The phone went to submitOrder for the ready text, which attributes it itself.
  assert.equal(kioskPointsOnlyAttribution({ loyaltyEnabled: true, phoneE164: '+447700900123', submittedPhone: '+447700900123' }), false);
  assert.equal(kioskPointsOnlyAttribution({ loyaltyEnabled: false, phoneE164: '+447700900123', submittedPhone: '' }), false);
  assert.equal(kioskPointsOnlyAttribution({ loyaltyEnabled: true, phoneE164: null, submittedPhone: '' }), false);
});

test('done: eat in with no table and a ready text says we will text', () => {
  assert.equal(kioskDoneModel({ orderType: 'dineIn', tableNumber: '', textSent: true }).messageKey, 'k2.done.eatInAnywhereText');
  assert.equal(kioskDoneModel({ orderType: 'dineIn', tableNumber: '', textSent: false }).messageKey, 'k2.done.eatInAnywhere');
  assert.equal(kioskDoneModel({ orderType: 'dineIn', tableNumber: '4', textSent: true }).messageKey, 'k2.done.eatInTable');
});

test('the old kiosk design asks for a number in every eat in mode, and only the plan loads tables', () => {
  const app = fs.readFileSync(new URL('../surfaces/KioskApp.jsx', import.meta.url), 'utf8');
  assert.match(app, /tableMode === 'enter' \|\| tableMode === 'either' \|\| tableMode === 'dispense'\)\) setScreen\('tableNumber'\)/);
  assert.match(app, /const keypadOnly = tableMode === 'enter' \|\| tableMode === 'dispense';/);
  assert.match(app, /if \(!keypadOnly && tableList && tableList\.tables\.length\)/);
  const settings = fs.readFileSync(new URL('../backoffice/sections/KioskSettings.jsx', import.meta.url), 'utf8');
  for (const label of ['Table plan', 'Type a table number', 'Flag number', 'Take away only']) assert.ok(settings.includes(`label: '${label}'`), label);
  assert.match(settings, /const TABLE_MODES_V2 = TABLE_MODES;/);
});

test('the new design shows the Menu screen hero banner at the top of the menu, and Back Office can set it', () => {
  const app = fs.readFileSync(new URL('../surfaces/KioskApp.jsx', import.meta.url), 'utf8');
  assert.match(app, /menuBanner: bannerFor\('menu'\) \|\| null,/);
  const menu = fs.readFileSync(new URL('../surfaces/kiosk/KioskMenuScreen.jsx', import.meta.url), 'utf8');
  assert.match(menu, /<KioskMenuBanner banner=\{menuBanner\} \/>/);
  assert.match(menu, /aspectRatio: '5 \/ 2'/);
  assert.match(menu, /onError=\{\(\) => setFailedUrl\(url\)\}/);
  const settings = fs.readFileSync(new URL('../backoffice/sections/KioskSettings.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(settings, /Banners and button wording are not used by the new kiosk design/);
  assert.match(settings, /title="Hero banner" desc="A promo image at the top of the menu\./);
});

test('the keypad takes a physical keyboard too: digits, Backspace or Delete, Enter', () => {
  for (const d of '0123456789') assert.equal(keypadKeyFromKeyboard(d), d);
  assert.equal(keypadKeyFromKeyboard('Backspace'), 'del');
  assert.equal(keypadKeyFromKeyboard('Delete'), 'del');
  assert.equal(keypadKeyFromKeyboard('Enter'), 'enter');
  for (const k of ['a', '+', ' ', 'Tab', 'Escape', '12', '', null, undefined, 5]) assert.equal(keypadKeyFromKeyboard(k), null, String(k));
  // Typed digits go through the same rule as the on screen keys (length cap).
  let v = '';
  for (const k of '077009001234') v = keypadNext(v, keypadKeyFromKeyboard(k), 11);
  assert.equal(v, '07700900123');
  const pad = fs.readFileSync(new URL('../surfaces/kiosk/KioskKeypad.jsx', import.meta.url), 'utf8');
  assert.match(pad, /window\.addEventListener\('keydown', onKey\)/);
  assert.match(pad, /if \(tag === 'input' \|\| tag === 'textarea'/);
});
