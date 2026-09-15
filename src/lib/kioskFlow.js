/**
 * kioskFlow.js: pure rules for the new kiosk design (five screens: start, menu,
 * review and pay, card, done, with the tap to start screen kept in front).
 *
 * Pure: NO imports, so node:test can load it (kioskFlow.test.js).
 *
 * THE FLAG
 * The new design shows only when BOTH are true:
 *   1. this build says it is ready (KIOSK_NEW_DESIGN_READY), and
 *   2. the kiosk profile has kiosk_new_design === true.
 * A profile row from before the migration has no kiosk_new_design key, which reads as
 * undefined, which means off. So every kiosk keeps today's design until the owner runs
 * 20260915_OPS_kiosk_redesign.sql AND switches a profile on AND a ready build ships.
 * The Back Office switch also only shows when the build is ready.
 */

// true from the last build stage (card and done). It still only lets a profile switch the
// new design on: with kiosk_new_design off or missing, every kiosk keeps today's design.
export const KIOSK_NEW_DESIGN_READY = true;

// Decision 17: every new line is set up for translation, the kiosk LAUNCHES IN ENGLISH and is
// translated after. Until the k2 keys are translated the new design hides the language pill
// (a picked language would give screens that are half translated) and starts in English.
export const KIOSK_LANGUAGE_PICKER = false;

// The design canvas, in design px (portrait kiosk).
export const KIOSK_CANVAS_WIDTH = 1080;
export const KIOSK_CANVAS_HEIGHT = 1920;

/** True only when this build is ready AND the profile asked for the new design. */
export function kioskNewDesignOn(profile, { ready = KIOSK_NEW_DESIGN_READY } = {}) {
  return ready === true && profile?.kiosk_new_design === true;
}

const V2_SCREENS = new Set(['attract', 'start', 'menu', 'review', 'pay', 'done']);

/**
 * Which new design screen shows for the shared engine screen value.
 * 'gift' is set by submitOrder when a gift card only order is aborted, and in the new
 * design that lands back on Review and pay. Anything unknown shows tap to start, so a
 * kiosk can never get stuck on a blank screen.
 */
export function resolveV2Screen(screen) {
  if (screen === 'gift') return 'review';
  return V2_SCREENS.has(screen) ? screen : 'attract';
}

export const KIOSK_TABLE_MODES = Object.freeze(['enter', 'either', 'dispense', 'none']);

/**
 * How the start screen works for the profile's kiosk_table_mode, set per kiosk in Back Office
 * (Peter, 15 Sep 2026: "Choose a table number that loads the table plan / Type a table number /
 * Customer picks up a flag and enters that number, we find the flag to give them their meal").
 * The stored values are unchanged (a database check allows only these four):
 *   either   : TABLE PLAN. Eat in shows the venue's tables to pick from ("no table" allowed, as
 *              before). With no tables set up, or the list unreadable, the keypad instead.
 *   enter    : TYPE A TABLE NUMBER. Eat in shows the keypad.
 *   dispense : FLAG NUMBER. The customer takes a numbered flag and types its number on the
 *              keypad. It is kept as the table number, so tickets say "Table 12" (Peter's call).
 *              Before v5.8.76 this went straight to the menu and asked for nothing.
 *   none     : Take away only.
 * An unknown or missing mode is read as 'either', as today.
 */
export function kioskStartModel(tableMode) {
  const mode = KIOSK_TABLE_MODES.includes(tableMode) ? tableMode : 'either';
  if (mode === 'none') {
    return {
      mode,
      takeawayOnly: true,
      tiles: ['takeaway'],
      titleKey: 'k2.start.titleTakeawayOnly',
      eatInSubKey: null,
      eatInLeadsTo: null,
      allowNoTable: false,
      tableEntry: null,
      numberKind: null,
    };
  }
  return {
    mode,
    takeawayOnly: false,
    tiles: ['dineIn', 'takeaway'],
    titleKey: 'k2.start.title',
    eatInSubKey: mode === 'dispense' ? 'k2.start.eatInSubFlag' : 'k2.start.eatInSub',
    eatInLeadsTo: 'table',
    allowNoTable: mode === 'either',
    // 'plan' shows the table plan (keypad only when there are no tables); 'keypad' always types.
    tableEntry: mode === 'either' ? 'plan' : 'keypad',
    // What the number is: a table, or the number on a flag the customer picked up.
    numberKind: mode === 'dispense' ? 'flag' : 'table',
  };
}

/** The start screen headline key for the model and the step showing ('mode' | 'table'). */
export function kioskStartTitleKey(model, step) {
  if (step === 'table' && model && !model.takeawayOnly) return model.numberKind === 'flag' ? 'k2.start.titleEatInFlag' : 'k2.start.titleEatIn';
  return model?.titleKey || 'k2.start.title';
}

/** Where the customer goes after the start screen: back to Review and pay, or the menu. */
export function nextAfterStart({ returnTo } = {}) {
  return returnTo === 'review' ? 'review' : 'menu';
}

/**
 * The table list state from a fetchKioskTables result (lib/kioskTables.js).
 * 'failed' and 'empty' both show the keypad, which is today's fallback: a customer must
 * always be able to order even when the table list cannot be read.
 */
export function kioskTableStatus(result) {
  if (!result || result.ok !== true) return 'failed';
  return Array.isArray(result.tables) && result.tables.length ? 'ok' : 'empty';
}

/**
 * One keypad press. key: a single digit, 'clear' or 'del'. Anything else is ignored.
 * Digits stop at maxLength.
 */
export function keypadNext(value, key, maxLength) {
  const cur = typeof value === 'string' ? value.replace(/\D/g, '') : '';
  if (key === 'clear') return '';
  if (key === 'del') return cur.slice(0, -1);
  if (typeof key === 'string' && /^\d$/.test(key)) {
    const max = Number.isFinite(maxLength) && maxLength > 0 ? maxLength : Infinity;
    return cur.length < max ? cur + key : cur;
  }
  return cur;
}

/**
 * v5.8.80: a physical keyboard key for the keypad: '0' to '9', 'del' (Backspace or Delete),
 * 'enter' (Enter), or null for anything else. Numpad digits arrive as the same e.key values.
 */
export function keypadKeyFromKeyboard(key) {
  if (typeof key !== 'string') return null;
  if (/^[0-9]$/.test(key)) return key;
  if (key === 'Backspace' || key === 'Delete') return 'del';
  if (key === 'Enter') return 'enter';
  return null;
}

/**
 * Viewport tracking for the canvas. maxVh is the tallest height seen at this width while
 * the customer is typing, so the on screen keyboard never shrinks the layout. A width
 * change (rotation) or a resize while not typing starts again from the current height.
 */
export function nextViewport(prev, vw, vh, typing = false) {
  const w = Number(vw) > 0 ? Number(vw) : KIOSK_CANVAS_WIDTH;
  const h = Number(vh) > 0 ? Number(vh) : KIOSK_CANVAS_HEIGHT;
  if (!prev || prev.vw !== w || !typing) return { vw: w, vh: h, maxVh: h };
  return { vw: w, vh: h, maxVh: Math.max(Number(prev.maxVh) || 0, h) };
}

/**
 * The canvas box for a viewport. The layout is always 1080 design px wide and is drawn
 * at `scale` (CSS zoom).
 *   Portrait at the design shape or taller: fills the width, and the canvas is taller
 *   than 1920 so the screen fills top to bottom.
 *   Wider than the design shape (landscape, or a squat tablet): 1920 tall, centred,
 *   with the ground colour on both sides.
 */
export function kioskCanvasSize({ vw, vh, maxVh } = {}) {
  const W = KIOSK_CANVAS_WIDTH;
  const H = KIOSK_CANVAS_HEIGHT;
  const w = Number(vw) > 0 ? Number(vw) : W;
  const h = Math.max(Number(vh) > 0 ? Number(vh) : 0, Number(maxVh) > 0 ? Number(maxVh) : 0) || H;
  const byWidth = w / W;
  const byHeight = h / H;
  if (byWidth <= byHeight) {
    return { scale: byWidth, width: W, height: h / byWidth, offsetX: 0, landscape: false };
  }
  return { scale: byHeight, width: W, height: H, offsetX: (w - W * byHeight) / 2, landscape: true };
}

/**
 * The start screen footer line: points when loyalty is on, otherwise the ready text line
 * when the text switch is on, otherwise nothing. The only rewards mention before checkout.
 */
export function kioskStartFooterKey({ loyaltyEnabled, smsEnabled } = {}) {
  if (loyaltyEnabled === true) return 'k2.start.footerPoints';
  if (smsEnabled === true) return 'k2.start.footerText';
  return null;
}

/**
 * The menu header mode block: { titleKey, subKey, vars }.
 * Eat in with a table shows the table, eat in with no table says sit anywhere,
 * take away says collect at the counter.
 */
export function kioskModeLabels({ orderType, tableNumber } = {}) {
  if (orderType === 'dineIn') {
    const table = typeof tableNumber === 'string' ? tableNumber.trim() : '';
    return table
      ? { titleKey: 'k2.menu.eatIn', subKey: 'k2.menu.table', vars: { table } }
      : { titleKey: 'k2.menu.eatIn', subKey: 'k2.menu.anywhere', vars: {} };
  }
  return { titleKey: 'k2.menu.takeaway', subKey: 'k2.menu.collect', vars: {} };
}

/**
 * Whether resetSession may run for this reason (build spec D1).
 * In the new design every reset names its reason ('cancel', 'idle', 'done', 'countdown',
 * 'staff'). The one caller with no reason is submitOrder's 30 second timer, which is never
 * cleared and could wipe the NEXT customer's basket (F2); the done screen has its own
 * countdown instead, so that call is ignored. Today's kiosk (newDesign false) resets for
 * every call exactly as before.
 */
export function kioskResetAllowed(reason, newDesign) {
  if (newDesign !== true) return true;
  return reason !== undefined;
}

// The card screen phases that pause the idle timer: the reader is live, the order is
// saving, or the customer has been asked to fetch a member of staff (lib/kioskPay.js).
const IDLE_PAUSED_PHASES = new Set(['connecting', 'waiting', 'saving', 'askStaff']);

/** True when the card screen phase must pause the idle timer. */
export function kioskIdlePaused(phase) {
  return IDLE_PAUSED_PHASES.has(phase);
}

// README 8: "Screen resets automatically in Ns", from 20.
export const KIOSK_DONE_COUNTDOWN = 20;

/** One second off the done screen countdown. Stops at 0. */
export function nextCountdown(n) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v - 1 : 0;
}

/**
 * The done screen (README 8, decisions 8, 9, 16).
 *   orderType      'dineIn' | 'takeaway'
 *   tableNumber    the table, or ''
 *   textSent       the phone went to submitOrder (the customer asked for the ready text)
 *   pointsMasked   the masked number, or '' when no number was given
 *   loyaltyEnabled points are on at this kiosk
 *   hasAlcohol     the order has alcohol
 * Returns { messageKey, messageVars, pointsKey, pointsVars, showAlcohol }.
 * pointsKey is null when there is no points line. It says "will be added", never "added":
 * points are earned after this screen shows.
 */
export function kioskDoneModel({ orderType = null, tableNumber = '', textSent = false, pointsMasked = '', loyaltyEnabled = false, hasAlcohol = false } = {}) {
  const table = typeof tableNumber === 'string' ? tableNumber.trim() : String(tableNumber ?? '').trim();
  let messageKey;
  let messageVars = {};
  if (orderType === 'dineIn') {
    if (table) { messageKey = 'k2.done.eatInTable'; messageVars = { table }; } else messageKey = textSent === true ? 'k2.done.eatInAnywhereText' : 'k2.done.eatInAnywhere';
  } else {
    messageKey = textSent === true ? 'k2.done.takeawayText' : 'k2.done.takeaway';
  }
  const showPoints = loyaltyEnabled === true && typeof pointsMasked === 'string' && pointsMasked.length > 0;
  return {
    messageKey,
    messageVars,
    pointsKey: showPoints ? 'k2.done.points' : null,
    pointsVars: showPoints ? { masked: pointsMasked } : {},
    showAlcohol: hasAlcohol === true,
  };
}

/**
 * Whether the done screen must earn points itself (build spec 4.4). submitOrder attributes
 * the order whenever it is given a phone, which the new design only does for the ready
 * text. A customer who gave a number for points only needs the flow to attribute it.
 */
export function kioskPointsOnlyAttribution({ loyaltyEnabled = false, phoneE164 = null, submittedPhone = '' } = {}) {
  return loyaltyEnabled === true && typeof phoneE164 === 'string' && phoneE164.length > 0 && !submittedPhone;
}
