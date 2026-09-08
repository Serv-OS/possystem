// src/lib/prep.js — scheduled batch cooks ("prep schedule").
//   prep_schedule — the recurring template, edited in Back Office (Operations → Prep schedule).
//   prep_log      — the daily completion, recorded from the Manager Kitchen tab ("Record").
// Location-fenced server-side by RLS (prep_schedule = users with location access; prep_log =
// ops_can_write, i.e. BO users OR a claimed ops/manager device). camelCase here ↔ snake_case in DB.
import { supabase, isMock } from './supabase';
import { produceBatch, ensureTodaysPlannedBatches, completePlannedBatch } from './stock/production';
import { isTrainingMode } from './trainingMode';

const schedFromRow = (r) => ({
  id: r.id,
  name: r.name,
  qty: r.qty != null ? Number(r.qty) : null,
  unit: r.unit || '',
  dueTime: r.due_time ? String(r.due_time).slice(0, 5) : '',
  daysOfWeek: Array.isArray(r.days_of_week) ? r.days_of_week : [],
  active: r.active !== false,
  sortOrder: r.sort_order ?? 0,
  outputItemId: r.output_item_id || null, recipeId: r.recipe_id || null,
});

/** All prep-schedule items for a location (Back Office editor). */
export async function fetchPrepSchedule(locationId) {
  if (isMock || !supabase || !locationId) return { data: [], error: null };
  const { data, error } = await supabase.from('prep_schedule').select('*').eq('location_id', locationId).order('sort_order');
  return { data: (data || []).map(schedFromRow), error };
}

/** Create/update a prep-schedule item (Back Office). */
export async function savePrepItem(item, locationId) {
  if (isMock || !supabase || !locationId) return { data: null, error: null };
  const row = {
    location_id: locationId,
    name: (item.name || '').trim(),
    qty: item.qty === '' || item.qty == null ? null : Number(item.qty),
    unit: item.unit || null,
    due_time: item.dueTime || null,
    days_of_week: Array.isArray(item.daysOfWeek) && item.daysOfWeek.length ? item.daysOfWeek : null,
    active: item.active !== false,
    sort_order: item.sortOrder ?? 0,
    // v5.5.931: the link that makes a scheduled cook REAL — which made item (and its
    // batch recipe) this cook produces. Null = legacy free-text row, logs only.
    output_item_id: item.outputItemId || null,
    recipe_id: item.recipeId || null,
    updated_at: new Date().toISOString(),
  };
  const real = item.id && !String(item.id).startsWith('tmp-');
  if (real) row.id = item.id;
  const q = real ? supabase.from('prep_schedule').upsert(row, { onConflict: 'id' }) : supabase.from('prep_schedule').insert(row);
  const { data, error } = await q.select().maybeSingle();
  return { data: data ? schedFromRow(data) : null, error };
}

export async function deletePrepItem(id, locationId) {
  if (isMock || !supabase || !locationId) return { error: null };
  return supabase.from('prep_schedule').delete().eq('location_id', locationId).eq('id', id);
}

/** Record (or update) today's completion of a scheduled prep cook, from the Manager Kitchen tab.
 *  Training-gated (commit path); one row per schedule item per day (upsert). */
export async function recordPrep({ scheduleId, name, prepDate, actualQty, unit, operator }, locationId) {
  if (isMock || !supabase || !locationId) return { ok: false, error: 'offline' };
  if (isTrainingMode()) return { ok: true, training: true };
  const row = {
    location_id: locationId, schedule_id: scheduleId || null, name: name || 'Prep', prep_date: prepDate,
    actual_qty: actualQty == null || actualQty === '' ? null : Number(actualQty), unit: unit || null,
    recorded_by: operator?.id || null, recorded_by_name: operator?.name || null, recorded_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('prep_log').upsert(row, { onConflict: 'location_id,schedule_id,prep_date' });
  if (error) return { ok: false, error: error.message };
  // v5.5.931 — A LINKED COOK PRODUCES A REAL BATCH. If the schedule row names a recipe,
  // recording the cook consumes the ingredients and stocks the output at true cost via
  // the SAME produceBatch path Back Office uses. The log row above stays the source of
  // "done today" for the Manager app; the batch is the stock truth. Best-effort by
  // design: a batch failure must never un-record the cook (staff DID make the food) —
  // it reports back so the caller can surface "logged, but stock not updated".
  let produced = null, produceError = null;
  if (scheduleId) {
    try {
      const { data: sched } = await supabase.from('prep_schedule')
        .select('recipe_id, output_item_id').eq('location_id', locationId).eq('id', scheduleId).maybeSingle();
      if (sched?.recipe_id && actualQty != null && actualQty !== '' && Number(actualQty) > 0) {
        // v5.5.933: the schedule MATERIALISES a planned batch each cook-day — complete THAT
        // row rather than minting a parallel one, so the Batches queue and the Manager app
        // are two views of the same work item. ensure… is idempotent (unique per day).
        await ensureTodaysPlannedBatches(locationId);
        const { data: planned } = await supabase.from('production_batches').select('id')
          .eq('location_id', locationId).eq('schedule_id', scheduleId)
          .eq('planned_for', prepDate).neq('status', 'CANCELLED').maybeSingle();
        if (planned?.id) {
          const { data: batch, error: bErr } = await completePlannedBatch(planned.id, Number(actualQty), locationId);
          if (bErr) produceError = bErr.message; else produced = batch;
        } else {
          const { data: batch, error: bErr } = await produceBatch({
            recipeId: sched.recipe_id, actualQty: Number(actualQty), outputUnit: unit || undefined,
            notes: `Scheduled cook — ${name || 'prep'}`,
          }, locationId);
          if (bErr) produceError = bErr.message; else produced = batch;
        }
      }
    } catch (e) { produceError = e?.message || 'batch production failed'; }
  }
  return { ok: true, produced, produceError };
}
