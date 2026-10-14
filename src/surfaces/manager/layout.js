// src/surfaces/manager/layout.js
//
// The Manager app's ONE layout decision, as a pure function of the live viewport width.
// No hooks, no browser globals: useLayout.js feeds it the width and hands the result to
// every screen through context. Height is accepted and ignored on purpose, so the on
// screen keyboard can never flip the layout.
//
// Bands: phone under 660 (today's layout, untouched), tablet 660 to 999 (left rail, sticky
// header, one column), wide from 1000 (two pane tab bodies), capped from 1272 (content
// held at 1120 and centred right of the rail).
//
// THE RULE the screens rely on: the result only ever feeds style values, one icon size and
// two words. A fragment that is SPREAD into an existing style literal is EMPTY on phone; a
// fragment used as a whole style on an element that has no style today is undefined on
// phone. Only s.shell and the three pane fragments carry a phone value. So a phone renders
// exactly what it rendered before this file existed, and a resize never re mounts anything.
//
// An override always uses the SAME key as the literal it replaces (padding over padding,
// flex over flex), never a longhand of a shorthand the literal sets.

export const BP = Object.freeze({ tablet: 660, wide: 1000 });
export const RAIL = 96;                 // 12 inset + 72 pill + 12 gap
export const GUTTER = Object.freeze({ tablet: 24, wide: 28 });
export const CONTENT_MAX = 1120;
export const CAP_MIN = 1272;            // RAIL + CONTENT_MAX + 2 * GUTTER.wide
export const CAP_KEYPAD = 440;
export const CAP_FORM = 520;
export const CAP_RUN = 640;
export const CAP_CTL = 360;
export const EMPTY = Object.freeze({});

export const cols = (n) => `repeat(${n}, minmax(0, 1fr))`;

const usable = (w) => typeof w === 'number' && Number.isFinite(w) && w > 0;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const env = (side) => `env(safe-area-inset-${side}, 0px)`;

/** 'phone' | 'tablet' | 'wide'. Anything that is not a positive finite number is a phone. */
export function bandFor(width) {
  if (!usable(width) || width < BP.tablet) return 'phone';
  return width < BP.wide ? 'tablet' : 'wide';
}

/** Width of the content column inside the Shell, in CSS points. */
export function contentWidthFor(width) {
  const band = bandFor(width);
  if (band === 'phone') return Math.min(480, usable(width) ? width : 390) - 28;
  if (band === 'tablet') return width - RAIL - 2 * GUTTER.tablet;
  return Math.min(CONTENT_MAX, width - RAIL - 2 * GUTTER.wide);
}

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  return Object.freeze(o);
};

const CONTENTS = { display: 'contents' };

function phoneFragments() {
  return {
    shell: { maxWidth: 480, paddingTop: env('top'), paddingRight: 14, paddingBottom: `calc(92px + ${env('bottom')})`, paddingLeft: 14 },
    header: EMPTY, switchUser: EMPTY, venueName: EMPTY, operatorLine: EMPTY, hit: EMPTY,
    navWrap: EMPTY, navPill: EMPTY, navBtn: EMPTY, navLabel: EMPTY,
    toastRail: EMPTY, toastPlain: EMPTY,
    screen: EMPTY,
    pairCard: EMPTY, pairLabel: EMPTY, pairCode: EMPTY, pairBody: EMPTY, pairBtn: EMPTY,
    pinBlock: EMPTY, pinVenue: EMPTY, pinTitle: EMPTY, pinDot: EMPTY, pinGrid: EMPTY, pinKey: EMPTY,
    span: EMPTY,
    title: EMPTY, heroValue: EMPTY, sectionLabel: EMPTY, statBox: EMPTY, statValue: EMPTY, statLabel: EMPTY,
    heroStatValue: EMPTY, heroStatLabel: EMPTY,
    tile: EMPTY, tileValue: EMPTY, tileLabel: EMPTY, tileSub: EMPTY,
    page2: undefined,
    pane: CONTENTS, paneA: CONTENTS, paneB: CONTENTS,
    statGrid: EMPTY, statGridSpan: EMPTY,
    rows: EMPTY, paneRows: EMPTY, textRows: EMPTY,
    opsTiles: EMPTY,
    capKeypad: undefined, capForm: undefined, capRun: undefined,
    ctl: EMPTY,
    lockCard: EMPTY, pinInput: EMPTY, editGrid: EMPTY, saveBtn: EMPTY, decideRow: EMPTY, decideBtn: EMPTY,
    orderSheet: EMPTY, cta: EMPTY, kitchenStats: EMPTY,
    homeSplit: undefined,
    homeHero: EMPTY, homeHeroTall: EMPTY, homeNeed: EMPTY, homeBento: EMPTY,
    needLine: EMPTY,
  };
}

function shellFor(wide, capped) {
  const g = wide ? GUTTER.wide : GUTTER.tablet;
  // Capped: the side space is a percentage of the Shell's containing block, which is the
  // viewport, so the content stays 1120 wide and the step at 1272 is seamless (28 each side).
  const spare = `(100% - ${RAIL + CONTENT_MAX}px) / 2`;
  return {
    maxWidth: 'none', overflowX: 'hidden', paddingTop: 0,
    paddingRight: capped ? `calc(${spare} + ${env('right')})` : `calc(${g}px + ${env('right')})`,
    paddingBottom: `calc(28px + ${env('bottom')})`,
    paddingLeft: capped ? `calc(${RAIL}px + ${spare} + ${env('left')})` : `calc(${RAIL + g}px + ${env('left')})`,
    scrollPaddingTop: `calc(76px + ${env('top')})`,
  };
}

function tabletFragments({ wide, capped, statCols, rowCols, textCols, tileCols }) {
  const rows = { display: 'grid', gridTemplateColumns: cols(rowCols), gap: 10 };
  return {
    // Shell, header, rail, toast
    shell: shellFor(wide, capped),
    header: { position: 'sticky', top: 0, zIndex: 20, background: 'var(--bg)', padding: `calc(14px + ${env('top')}) 4px 12px` },
    switchUser: { flex: '0 1 auto', marginRight: 'auto' },
    venueName: { fontSize: 17 },
    operatorLine: { fontSize: 11.5 },
    hit: { width: 44, height: 44 },
    navWrap: { top: 0, right: 'auto', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-start', padding: `calc(12px + ${env('top')}) 0 calc(12px + ${env('bottom')}) calc(12px + ${env('left')})` },
    navPill: { flexDirection: 'column', width: 72, maxWidth: 72, maxHeight: '100%', overflowY: 'auto', gap: 4, borderRadius: 24, justifyContent: 'flex-start' },
    navBtn: { flex: '0 0 auto', width: '100%', minHeight: 60, justifyContent: 'center', gap: 4, padding: '8px 2px', borderRadius: 18 },
    navLabel: { fontSize: 10.5 },
    toastRail: { left: 'calc(50% + 48px)', bottom: `calc(28px + ${env('bottom')})`, maxWidth: 520 },
    toastPlain: { bottom: `calc(28px + ${env('bottom')})` },
    // Boot, pair and PIN
    screen: { height: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch' },
    pairCard: { maxWidth: 440, padding: 36 },
    pairLabel: { fontSize: 14 },
    pairCode: { fontSize: 56 },
    pairBody: { fontSize: 15 },
    pairBtn: { fontSize: 15, padding: '14px 14px' },
    pinBlock: { width: 360 },
    pinVenue: { fontSize: 14 },
    pinTitle: { fontSize: 22 },
    pinDot: { width: 16, height: 16 },
    pinGrid: { gap: 12 },
    pinKey: { height: 72, fontSize: 26 },
    // Shared primitives (ui.jsx)
    span: { gridColumn: '1 / -1' },
    title: { fontSize: 26 },
    heroValue: { fontSize: 44 },
    sectionLabel: { fontSize: 12 },
    statBox: { padding: '14px 12px', minWidth: 0 },
    statValue: { overflowWrap: 'anywhere' },
    statLabel: { fontSize: 11.5 },
    // Home
    heroStatValue: { fontSize: 22 },
    heroStatLabel: { fontSize: 11 },
    tile: { minHeight: 128, padding: 18 },
    tileValue: { fontSize: 28 },
    tileLabel: { fontSize: 13.5 },
    // Four in a row (820 to 999): the sub line can wrap, so hold two lines to keep the numbers level.
    tileSub: !wide && statCols === 4 ? { fontSize: 12, minHeight: 32 } : { fontSize: 12 },
    homeSplit: wide ? { display: 'grid', gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 1fr)', gridTemplateRows: 'auto 1fr auto', columnGap: 16 } : undefined,
    homeHero: wide ? { gridColumn: 1, gridRow: 2 } : EMPTY,
    homeHeroTall: wide ? { gridColumn: 1, gridRow: '2 / span 2' } : EMPTY,
    homeNeed: wide ? { gridColumn: 1, gridRow: 3, alignSelf: 'start' } : EMPTY,
    homeBento: wide ? { gridColumn: 2, gridRow: '2 / span 2', gridTemplateColumns: cols(2), gridAutoRows: '1fr' } : EMPTY,
    needLine: { whiteSpace: 'normal' },
    // Two pane tab bodies (Reports, Team, Kitchen). The pane divs exist at every width.
    page2: wide ? { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', columnGap: 28, alignItems: 'start' } : undefined,
    pane: wide ? { minWidth: 0 } : CONTENTS,
    paneA: wide ? { minWidth: 0, order: 1 } : CONTENTS,
    paneB: wide ? { minWidth: 0, order: 2 } : CONTENTS,
    statGrid: wide ? EMPTY : { gridTemplateColumns: cols(statCols) },
    statGridSpan: wide ? { gridTemplateColumns: cols(4), gridColumn: '1 / -1' } : { gridTemplateColumns: cols(statCols) },
    // Lists. Any list with a one tap write stays one column and takes none of these.
    rows,
    paneRows: wide ? EMPTY : rows,
    textRows: { display: 'grid', gridTemplateColumns: cols(textCols), gap: 10 },
    // Ops
    opsTiles: { gridTemplateColumns: cols(tileCols), gap: 14 },
    capKeypad: { maxWidth: CAP_KEYPAD, margin: '0 auto' },
    capForm: { maxWidth: CAP_FORM, margin: '0 auto' },
    capRun: { maxWidth: CAP_RUN, margin: '0 auto' },
    ctl: { maxWidth: CAP_CTL },
    // Team
    lockCard: { maxWidth: 440 },
    pinInput: { flex: '0 1 220px' },
    editGrid: { gridTemplateColumns: 'repeat(3, minmax(0, 160px))' },
    saveBtn: { flex: '0 1 240px' },
    decideRow: { justifyContent: 'flex-end' },
    decideBtn: { flex: '0 1 160px' },
    // Kitchen
    orderSheet: wide ? EMPTY : { maxWidth: 560 },
    cta: wide ? EMPTY : { alignSelf: 'flex-start', minWidth: 280, padding: '12px 22px' },
    // The two Kitchen stat tiles sit above the two panes, so they share the pane gap on wide.
    kitchenStats: wide ? { gridColumn: '1 / -1', gap: 28 } : { gridColumn: '1 / -1' },
  };
}

const cache = new Map();

/**
 * The layout for a viewport. Memoised by band and column counts, so the SAME frozen object
 * comes back for every width that lays out the same way: a drag inside a band re renders
 * nothing. The content width is not stored on it (it varies inside one key).
 */
export function layoutFor(width, height) { // eslint-disable-line no-unused-vars
  const band = bandFor(width);
  const phone = band === 'phone';
  const wide = band === 'wide';
  const capped = wide && width >= CAP_MIN;
  const contentW = contentWidthFor(width);
  const statCols = phone ? 2 : contentW >= 660 ? 4 : 2;
  const rowCols = phone ? 1 : clamp(Math.floor((contentW + 10) / 320), 1, 3);
  const textCols = phone ? 1 : clamp(Math.floor((contentW + 10) / 440), 1, 2);
  const tileCols = phone ? 2 : contentW >= 900 ? 4 : contentW >= 560 ? 3 : 2;
  const key = `${band}|${capped ? 1 : 0}|${statCols}|${rowCols}|${textCols}|${tileCols}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const made = deepFreeze({
    key, band, phone, capped, panes: wide ? 2 : 1,
    statCols, rowCols, textCols, tileCols,
    navIcon: phone ? 20 : 24,
    deviceWord: phone ? 'phone' : 'device',
    s: phone ? phoneFragments() : tabletFragments({ wide, capped, statCols, rowCols, textCols, tileCols }),
  });
  cache.set(key, made);
  return made;
}

export const PHONE = layoutFor(390, 844);
