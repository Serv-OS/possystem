// src/lib/ownerMix.js: the Owner app's side of the Sales mix (8 Oct 2026).
//
// Peter: "the ability to report on bigger categories like say what is Food/drink/other split ...
// in hospitality a valued piece of data ... where this valuable data sits on top of a detailed
// report like in the owner app". The function (owner-snapshot, _shared/ownerSnapshot.js) sends
// each venue's and each currency's mix: item sales by sales group, whole percent shares that add
// to 100, the comparison span's share and the change in points. This file turns one of those
// blocks into what the screens draw:
//   cardBar     the thin bar under a card's sales figure: the top two named groups plus one fold,
//               the words "Food 62%  Drinks 31%  Other 7%" and "+3 pts" per segment
//   detailRows  the Sales mix card on the venue screen: a bar per group, "was 59% · +3 pts", and
//               the top three categories inside each group
// NO PERCENT IS WORKED OUT HERE OR ON THE SCREEN: shares and points are the function's, through
// the shared maths (_shared/salesMix.js barSegments, mixWords, ptsText), so the card, the Back
// Office report and the Xero invoice can never disagree. Colours are BY GROUP KEY (Food is always
// the accent, Drinks always blue), never by rank, so a group keeps its colour from card to card.
//
// AN OLD FUNCTION sends no 'mix' feature and no mix blocks: canMix (src/lib/ownerDetail.js) is
// false, no bar is drawn and the card is not rendered. Never a blank bar, never a made up split.
//
// PURE: node:test loads it.

import { ownerPeriod } from '../../supabase/functions/_shared/ownerPeriod.js';
import { barSegments, mixWords, ptsText, allOther, OTHER_NAME, GROUP_TONES, toneVar } from '../../supabase/functions/_shared/salesMix.js';
import { OTHER_GROUP } from '../../supabase/functions/_shared/accountingGroups.js';

export const ALL_OTHER_HINT = 'No sales groups set yet. Set them in Back Office, Reports, Sales mix.';

/** A tone name from the function ('acc', 'blu', 't3') as the CSS it is drawn with: salesMix.js's own, so the Back Office draws the same colours. */
export { toneVar };

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * The bar under a card's sales figure, or null when there is nothing to draw: no block (an old
 * function), no item sales, or `quiet` and every penny is Other sales (a venue card inside a
 * currency whose venues have no groups set at all: the group card carries the one hint).
 *   segments  up to three: the top two named groups by money and one fold (the single group it
 *             holds, or "Other" in grey), each with its colour and its "+3 pts" words ("0 pts"
 *             when nothing moved, '' with no comparison); or one grey "Other sales 100%" segment
 *             with no points when nothing is set up
 *   words     "Food 62%  Drinks 31%  Other 7%" (the bar's label for a screen reader)
 *   hint      the one line for a business with no groups set, when `hint` is asked for
 * @returns {{ segments: object[], words: string, hint: string|null, allOther: boolean } | null}
 */
export function cardBar(block, { hint = false, quiet = false } = {}) {
  if (!block || !(num(block.total) > 0)) return null;
  const all = allOther(block);
  if (quiet && all) return null;
  // Nothing set up: one grey segment, and never "0 pts" noise against a comparison that was all Other too.
  const segments = all
    ? [{ key: OTHER_GROUP, name: OTHER_NAME, share: 100, pts: null, ptsText: '', color: toneVar(GROUP_TONES.other) }]
    : barSegments(block, 3).map((s) => ({ key: s.key, name: s.name, share: s.share, pts: s.pts, ptsText: ptsText(s.pts), color: toneVar(s.tone) }));
  return { segments, words: mixWords(segments), hint: all && hint ? ALL_OTHER_HINT : null, allOther: all };
}

/**
 * Per currency, whether every venue's item sales are Other sales (nothing set up for that
 * currency's venues). From groupCards(data): [{ currency, rollup }]. The venue cards of such a
 * currency hide their bar and the group card says why, once.
 * @returns {Record<string, boolean>}
 */
export function allOtherByCurrency(groups) {
  const out = {};
  for (const g of Array.isArray(groups) ? groups : []) if (g?.currency) out[g.currency] = allOther(g.rollup?.mix);
  return out;
}

/**
 * The Sales mix card's rows: one per group in the function's order (money desc, Other sales last),
 * with the bar length against the biggest group, the colour by key, the comparison words and the
 * top three categories. `footer` names the share still in categories with no group, when some
 * but not all of it is.
 * @returns {{ empty: boolean, allOther: boolean, rows: object[], footer: string|null }}
 */
export function detailRows(mix) {
  if (!mix || !(num(mix.total) > 0)) return { empty: true, allOther: false, rows: [], footer: null };
  const all = allOther(mix);
  const groups = Array.isArray(mix.groups) ? mix.groups : [];
  const max = groups.reduce((m, g) => Math.max(m, num(g?.money)), 0);
  const rows = groups.map((g) => {
    const pts = g?.pts ?? null;
    return {
      key: g.key, name: g.name, money: num(g.money), share: num(g.share),
      w: max > 0 ? Math.max(0, Math.min(1, num(g.money) / max)) : 0,
      color: toneVar(g.tone), cmp_share: g?.cmp_share ?? null, pts,
      // "was 59% · +3 pts". Nothing when the comparison span had no item sales (the function sends
      // pts null then): "was 0%" would read as a share, and it was a day with no sales at all.
      wasText: pts == null ? '' : `was ${num(g.cmp_share)}% · ${ptsText(pts)}`,
      categories: (Array.isArray(g.categories) ? g.categories : []).map((c) => ({ id: c?.id ?? null, label: c?.label || 'No category', money: num(c?.money) })),
    };
  });
  const u = num(mix.unresolved_share);
  return { empty: false, allOther: all, rows, footer: !all && u > 0 && u < 100 ? `${u}% of item sales are in categories with no group yet.` : null };
}

const PERIOD_WORDS = { today: 'today', week: 'this week', month: 'this month' };

/** The grey line under the card's title: the basis in plain words, and what "was" means when there is a comparison. */
export function noteFor(period, hasCmp) {
  const base = `Item sales ${PERIOD_WORDS[ownerPeriod(period)]}, before check discounts and refunds.`;
  return hasCmp ? `${base} 'Was' is the share in the comparison period.` : base;
}
