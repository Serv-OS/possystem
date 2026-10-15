// hourBar.js: the pixel height of one bar in the Back Office hour charts (5 Oct 2026).
// Peter: "make sure bar graphs are actually bar graphs". The bars were a PERCENT of a column that
// had no height of its own, so every bar collapsed to its 2px border. Pixels cannot collapse.

export const HOUR_BAR_TRACK_PX = 104;   // a 140 tall chart, less the value label and the hour label

/** In proportion to the tallest bar, never under 4px when there is a value, 0 when there is none. */
export function hourBarHeightPx(val, max, track = HOUR_BAR_TRACK_PX) {
  const v = Number(val) || 0;
  if (v <= 0) return 0;
  const m = Math.max(Number(max) || 0, v);
  return Math.max(4, Math.round((v / m) * track));
}
