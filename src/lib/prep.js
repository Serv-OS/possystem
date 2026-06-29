// src/lib/prep.js — scheduled batch cooks ("prep schedule").
//   prep_schedule — the recurring template, edited in Back Office (Operations → Prep schedule).
//   prep_log      — the daily completion, recorded from the Manager Kitchen tab ("Record").
// Location-fenced server-side by RLS (prep_schedule = users with location access; prep_log =
// ops_can_write, i.e. BO users OR a claimed ops/manager device). camelCase here ↔ snake_case in DB.
import { supabase, isMock } from './supabase';
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
  return { ok: true };
}
