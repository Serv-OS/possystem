/**
 * stock/wasteReasons.js: the waste reasons a screen offers and the manager PIN rule (v5.11.96, multi
 * site stock Drop 3, contract 3.3 and map J5).
 *
 * The company list lives in stock_co_settings.waste_reasons (set on Stock settings); the database
 * answers it through stock_waste_reasons(p_loc) together with the PIN limit. An empty company list,
 * a database without Drop 3 (needsUpdate) or any failed read falls back to WASTE_REASONS, today's
 * list, so one site companies, the till and the phone keep exactly today's choices.
 *
 * Pure apart from useWasteReasons (React state only). The api is passed in (stockApi in the
 * browser) so this file never pulls in the browser client and node --test reads it directly.
 */

import { useEffect, useState } from 'react';

/** Today's reasons (moved here from waste.js, which re exports them unchanged). */
export const WASTE_REASONS = ['Spoilage', 'Out of date', 'Prep / trim', 'Over-production', 'Breakage / spill', 'Staff meal', 'Customer return', 'Training', 'Other'];

/** The reason the fresh close down books (contract 3.3). */
export const END_OF_DAY_REASON = 'End of day';

const clean = (list) => {
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    const t = String(r ?? '').trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
};

/**
 * The reasons and the PIN limit from one stockApi.wasteReasons answer:
 * { reasons, pinOver, currency, fromCompany }. Any answer that is not a usable company list
 * (error, needsUpdate, null reasons, an empty list) gives WASTE_REASONS and no PIN limit is known
 * (the database still asks for the PIN itself when a limit exists).
 */
export function reasonsFromAnswer(answer) {
  const d = answer && !answer.error && !answer.needsUpdate ? answer.data : null;
  const list = clean(d?.reasons);
  const pin = d?.pin_over == null || d.pin_over === '' ? null : Number(d.pin_over);
  return {
    reasons: list.length ? list : WASTE_REASONS,
    pinOver: Number.isFinite(pin) && pin >= 0 ? pin : null,
    currency: d?.currency || null,
    fromCompany: list.length > 0,
  };
}

/** The first reason a form starts on: the caller's wish when it is on the list, else the first. */
export function startReason(reasons, wish = null) {
  const list = Array.isArray(reasons) && reasons.length ? reasons : WASTE_REASONS;
  return wish && list.includes(wish) ? wish : list[0];
}

/**
 * Is this stock_record_waste answer the database asking for a manager PIN (or refusing one)?
 * Returns null for any other answer, else { state: 'needed' | 'wrong' | 'locked', words, limit }.
 */
export function pinAsk(res) {
  if (!res || res.ok !== false || !res.pin) return null;
  const state = ['needed', 'wrong', 'locked'].includes(res.pin) ? res.pin : 'needed';
  const fallback = state === 'locked' ? 'Too many wrong PINs. Wait 15 minutes, then try again.'
    : state === 'wrong' ? 'That PIN is not a manager at this venue.' : 'This waste needs a manager PIN.';
  return { state, words: String(res.error || fallback), limit: res.limit == null ? null : Number(res.limit) };
}

/** The company list as stock_save_settings saves it (waste_reasons): trimmed, no blanks, no repeats. */
export function reasonsToSave(list) {
  return clean(list);
}

/** Move one reason up (-1) or down (+1) in a list; the same list back when it cannot move. */
export function moveReason(list, index, step) {
  const to = index + step;
  if (!Array.isArray(list) || index < 0 || index >= list.length || to < 0 || to >= list.length) return list;
  const out = [...list];
  const [it] = out.splice(index, 1);
  out.splice(to, 0, it);
  return out;
}

/**
 * The reasons for a site: WASTE_REASONS straight away, then the company list once the database
 * answers. api is stockApi (or any object with wasteReasons(locationId)). Stale answers for an
 * earlier site are dropped.
 */
export function useWasteReasons(siteId, api) {
  const [state, setState] = useState(() => reasonsFromAnswer(null));
  useEffect(() => {
    let live = true;
    if (!siteId || !api || typeof api.wasteReasons !== 'function') return () => { live = false; };
    Promise.resolve(api.wasteReasons(siteId))
      .then((r) => { if (live) setState(reasonsFromAnswer(r)); })
      .catch(() => { if (live) setState(reasonsFromAnswer(null)); });
    return () => { live = false; };
  }, [siteId, api]);
  return state;
}
