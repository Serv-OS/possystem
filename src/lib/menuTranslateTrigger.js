/**
 * menuTranslateTrigger.js: ask the menu-translate edge function to bring a venue's kiosk
 * translations up to date after a Back Office menu save (v5.8.82).
 *
 * Fire and forget, debounced per venue: a burst of saves (an import, a page of edits) becomes
 * one call twenty seconds after the last one. The function itself decides whether there is
 * anything to do (it only translates venues with a kiosk on the new design, and only rows
 * that are missing or whose English changed), so calling it for every save is cheap. pg_cron
 * calls it every ten minutes as well, so a lost call costs nothing but a short wait.
 */
import { supabase } from './supabase';

const DELAY_MS = 20_000;
const timers = new Map();

export function scheduleMenuTranslate(locationId, delay = DELAY_MS) {
  if (!locationId || locationId === 'loc-demo' || typeof supabase?.functions?.invoke !== 'function') return;
  const key = String(locationId);
  if (timers.has(key)) clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    Promise.resolve()
      .then(() => supabase.functions.invoke('menu-translate', { body: { location_id: key, reason: 'save' } }))
      .catch((e) => console.warn('[menu-translate] background run failed:', e?.message || e));
  }, delay));
}

/** For tests: pending venues. */
export function pendingMenuTranslate() {
  return Array.from(timers.keys());
}
