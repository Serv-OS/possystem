// src/lib/kds/kdsFit.js
//
// Text sizing for narrow kitchen cards (v5.8.66). Pure, tested in kdsFit.test.js.
//
// Peter kept today's automatic columns (cards at least 240px, so 6 across on his big
// screen and 4 on his iPad) AND asked for the design's large text. At 240px the
// design sizes broke names mid word ("Mohamme d", "Christodo ulou"). His call
// (14 Sep 2026): keep the columns, shrink the text on narrow cards so words fit.
//
// Two layers:
//   1. cardScale: every size scales with the column width. At the design's own card
//      width (380px, 4 across on 1920 with the rail) the scale is exactly 1, so a
//      design sized card is pixel exact.
//   2. fitFontSize: a name or item still too wide for its line (one long word such
//      as "Christodoulou") steps down further, to a floor, so it never splits.

/** Card width in the design: (1920 − 300 rail − 44 padding − 3 × 18 gaps) / 4. */
export const DESIGN_CARD_WIDTH = 380;
export const MIN_CARD_WIDTH = 240;
export const GRID_GAP = 18;
const MIN_SCALE = 0.62;

/** Column width of an auto-fill grid (repeat(auto-fill, minmax(240px, 1fr))). */
export function gridColumnWidth(gridWidth, minCol = MIN_CARD_WIDTH, gap = GRID_GAP) {
  const w = Number(gridWidth);
  if (!Number.isFinite(w) || w <= 0) return DESIGN_CARD_WIDTH;
  const cols = Math.max(1, Math.floor((w + gap) / (minCol + gap)));
  return (w - gap * (cols - 1)) / cols;
}

/** 1 at the design width, smaller for narrower cards, never below MIN_SCALE, never above 1. */
export function cardScale(columnWidth) {
  const w = Number(columnWidth);
  if (!Number.isFinite(w) || w <= 0) return 1;
  const s = Math.min(1, Math.max(MIN_SCALE, w / DESIGN_CARD_WIDTH));
  return Math.round(s * 100) / 100;          // stable value, so memoised cards do not churn
}

/** A design size at this scale, never below the floor (kitchen text floor is 13px). */
export function scaled(base, scale, floor = 13) {
  return Math.max(floor, Math.round(base * scale));
}

/**
 * The words a browser may break between: spaces, and after a hyphen.
 * (No lookbehind regex: older Sunmi WebViews cannot parse it.)
 */
export function breakableWords(text) {
  return String(text ?? '')
    .split(/\s+/)
    .flatMap(w => w.match(/[^-]+-?|-/g) || [])
    .filter(Boolean);
}

/**
 * Font size so the widest word fits the available width.
 *   widestAtMax  the widest word's width measured at maxPx
 */
export function fitFontSize({ maxPx, minPx, available, widestAtMax }) {
  if (!(available > 0) || !(widestAtMax > 0) || widestAtMax <= available) return maxPx;
  const fitted = Math.floor(maxPx * (available / widestAtMax) * 2) / 2;   // half pixel steps
  return Math.max(minPx, Math.min(maxPx, fitted));
}
