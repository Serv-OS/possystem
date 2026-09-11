// src/lib/orderScreen/orderScreenData.js
//
// Order screens: Supabase data layer for Back Office and the TV feed.
//
// Every function:
//   1. is isMock safe (supabase null means local dev, never touches the network)
//   2. is migration absent safe: before 20260911_OPS_order_status_displays.sql is applied a
//      missing table, column or function comes back as { absent: true }, never a throw
//   3. never throws, and returns { data, error, absent, message }
//      message is plain words, ready to show in Back Office.
//
// Writes check `.select('id')` for 0 rows, because RLS blocks silently.
// The TV never reads order_queue. It only calls order_status_feed (see fetchOrderScreenFeed).

import { supabase, isMock } from '../supabase';
import { reportSave } from '../saveHealth';
import { normaliseDisplay, normalisePairCode, isAbsentError, friendlyPairError } from './orderScreenStatus';
import { withTimeout } from '../withTimeout';

const ASSET_BUCKET = 'receipt-assets';
const ABSENT_MESSAGE = 'Order screens need a database update before you can use them. Ask ServOS support to switch them on.';
const NOT_LIVE = 'This needs a live connection to ServOS.';
const GENERIC_PAIR_FAIL = 'Could not pair the TV. Try again.';

/** A missing table, column or function: the migration is not applied yet. */
export function isFeatureAbsent(error) {
  return isAbsentError(error);
}

const ok = (data) => ({ data, error: null, absent: false, message: '' });
const fail = (error, message) => (isFeatureAbsent(error)
  ? { data: null, error, absent: true, message: ABSENT_MESSAGE }
  : { data: null, error, absent: false, message: message || 'Something went wrong. Try again.' });
const notLive = () => ({ data: null, error: new Error(NOT_LIVE), absent: false, message: NOT_LIVE });
const realLoc = (id) => !!id && id !== 'loc-demo';
// RLS blocks silently: a write that changed nothing means no access. Plain words for Back Office.
const ZERO_ROW_MESSAGES = {
  Save: 'Could not save. You may not have access to this venue.',
  Delete: 'Could not delete. You may not have access to this venue.',
  Remove: 'Could not remove the TV. You may not have access to this venue.',
};
const zeroRows = (data, what) => ((!data || data.length === 0)
  ? new Error(ZERO_ROW_MESSAGES[what] || 'Could not save. You may not have access to this venue.')
  : null);

async function guard(fn, message) {
  try { return await fn(); } catch (e) { return fail(e, message); }
}

// ── Configs ──────────────────────────────────────────────────────────────────

export async function listOrderDisplays(locationId) {
  if (isMock || !supabase || !realLoc(locationId)) return ok([]);
  return guard(async () => {
    const { data, error } = await supabase.from('order_status_displays')
      .select('*').eq('location_id', locationId).order('created_at');
    if (error) return fail(error, 'Could not load order screens. Try again.');
    return ok(data || []);
  }, 'Could not load order screens. Try again.');
}

/** Insert when there is no id, else update by id and location_id. Returns { data: { id } }. */
export async function saveOrderDisplay(display) {
  if (isMock || !supabase) return notLive();
  const loc = display?.location_id;
  if (!realLoc(loc)) return fail(new Error('No venue chosen'), 'Choose a venue at the top of Back Office first.');
  return guard(async () => {
    const n = normaliseDisplay(display);
    const row = {
      name: n.name.trim(), is_active: n.is_active, orientation: n.orientation, rotate: n.rotate,
      sections: n.sections, labels: n.labels, settings: n.settings, theme: n.theme,
    };
    let res;
    if (display.id) {
      res = await supabase.from('order_status_displays').update(row)
        .eq('id', display.id).eq('location_id', loc).select('id');
    } else {
      // org_id is carried onto the paired screen row; best effort, never blocks the save.
      let orgId = display.org_id || null;
      if (!orgId) {
        try {
          const { data: l } = await supabase.from('locations').select('org_id').eq('id', loc).maybeSingle();
          orgId = l?.org_id || null;
        } catch { orgId = null; }
      }
      res = await supabase.from('order_status_displays')
        .insert({ ...row, location_id: loc, org_id: orgId }).select('id');
    }
    const failure = res.error || zeroRows(res.data, 'Save');
    reportSave('order screen', failure);
    if (failure) return fail(failure, res.error ? 'Could not save. Try again.' : failure.message);
    return ok({ id: res.data[0].id });
  }, 'Could not save. Try again.');
}

/** Frees every TV showing this config first, then deletes it. */
export async function deleteOrderDisplay(id, locationId) {
  if (isMock || !supabase) return notLive();
  if (!id || !realLoc(locationId)) return fail(new Error('Missing id'), 'Could not delete. Try again.');
  return guard(async () => {
    const { data: tvs, error: listErr } = await supabase.from('menu_board_screens')
      .select('id').eq('order_display_id', id).eq('location_id', locationId);
    if (listErr) return fail(listErr, 'Could not delete. Try again.');
    for (const tv of tvs || []) {
      const { error } = await supabase.rpc('set_order_status_screen', { p_screen_id: tv.id, p_display_id: null });
      if (error) return fail(error, 'Could not free a TV that shows this order screen. Try again.');
    }
    const { data, error } = await supabase.from('order_status_displays').delete()
      .eq('id', id).eq('location_id', locationId).select('id');
    const failure = error || zeroRows(data, 'Delete');
    reportSave('order screen delete', failure);
    if (failure) return fail(failure, error ? 'Could not delete. Try again.' : failure.message);
    return ok({ id });
  }, 'Could not delete. Try again.');
}

// ── Paired TVs (menu_board_screens rows with an order_display_id, plus idle TVs) ────

/**
 * TVs at the venue that show an order screen, plus idle TVs (unpaired, no menu board), so
 * a TV unpaired here stays in the list and can be given an order screen again without
 * walking to it and retyping its code. set_order_status_screen accepts an idle row.
 */
export async function listOrderScreens(locationId) {
  if (isMock || !supabase || !realLoc(locationId)) return ok([]);
  return guard(async () => {
    const { data, error } = await supabase.from('menu_board_screens')
      .select('*').eq('location_id', locationId)
      .or('order_display_id.not.is.null,and(board_id.is.null,status.eq.unpaired)')
      .order('created_at');
    if (error) return fail(error, 'Could not load paired TVs. Try again.');
    return ok(data || []);
  }, 'Could not load paired TVs. Try again.');
}

export async function pairOrderScreen(code, displayId) {
  if (isMock || !supabase) return notLive();
  return guard(async () => {
    const { data, error } = await supabase.rpc('claim_order_status_screen', {
      p_code: normalisePairCode(code), p_display_id: displayId,
    });
    if (error) return { ...fail(error), message: friendlyPairError(error) };
    return ok(data);
  }, GENERIC_PAIR_FAIL);
}

/** displayId null unpairs the TV, so it shows its pairing code again. */
export async function setOrderScreen(screenId, displayId) {
  if (isMock || !supabase) return notLive();
  return guard(async () => {
    const { data, error } = await supabase.rpc('set_order_status_screen', {
      p_screen_id: screenId, p_display_id: displayId || null,
    });
    if (error) {
      const friendly = friendlyPairError(error);
      return { ...fail(error), message: friendly === GENERIC_PAIR_FAIL ? 'Could not change that TV. Try again.' : friendly };
    }
    return ok(data);
  }, 'Could not change that TV. Try again.');
}

export async function removeOrderScreen(screenId) {
  if (isMock || !supabase) return notLive();
  return guard(async () => {
    const { data, error } = await supabase.from('menu_board_screens').delete().eq('id', screenId).select('id');
    const failure = error || zeroRows(data, 'Remove');
    reportSave('order screen TV', failure);
    if (failure) return fail(failure, error ? 'Could not remove the TV. Try again.' : failure.message);
    return ok({ id: screenId });
  }, 'Could not remove the TV. Try again.');
}

// ── TV feed (Builder B's OrderStatusScreen calls this) ─────────────────────────────

/**
 * { data } on success, { absent: true } before the migration, { error } otherwise.
 * opts.timeoutMs > 0 aborts the request and gives up after that long, so a half open socket
 * after a TV wakes can never hang the caller (an error comes back instead).
 */
export async function fetchOrderScreenFeed(screenId, { timeoutMs = 0 } = {}) {
  if (isMock || !supabase) return { data: null, error: null, absent: true, message: '' };
  try {
    let q = supabase.rpc('order_status_feed', { p_screen_id: screenId });
    if (timeoutMs > 0 && typeof q.abortSignal === 'function'
        && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      q = q.abortSignal(AbortSignal.timeout(timeoutMs));
    }
    // The race also covers a stall before fetch starts (the client awaits the auth session).
    const { data, error } = timeoutMs > 0 ? await withTimeout(q, timeoutMs + 500, 'Order screen feed') : await q;
    if (error) {
      if (isFeatureAbsent(error)) return { data: null, error: null, absent: true, message: '' };
      return { data: null, error, absent: false, message: 'Cannot reach ServOS right now.' };
    }
    return ok(data);
  } catch (e) {
    return { data: null, error: e, absent: false, message: 'Cannot reach ServOS right now.' };
  }
}

// ── Venue setting: keep paid till orders in the queue ───────────────────────────────

export async function loadKeepPaidSetting(locationId) {
  if (isMock || !supabase || !realLoc(locationId)) return ok(false);
  return guard(async () => {
    const { data, error } = await supabase.from('locations').select('pos_settings').eq('id', locationId).maybeSingle();
    if (error) return fail(error, 'Could not load this setting.');
    return ok(data?.pos_settings?.order_screen_keep_paid === true);
  }, 'Could not load this setting.');
}

/** Read, modify, merge so other pos_settings keys survive. A failed read never writes. */
export async function saveKeepPaidSetting(locationId, value) {
  if (isMock || !supabase) return notLive();
  if (!realLoc(locationId)) return fail(new Error('No venue chosen'), 'Choose a venue at the top of Back Office first.');
  return guard(async () => {
    const { data: cur, error: readErr } = await supabase.from('locations').select('pos_settings').eq('id', locationId).maybeSingle();
    if (readErr) return fail(readErr, 'Could not save. Try again.');
    if (!cur) return fail(new Error('Venue not found'), 'Could not save. Try again.');
    const { data, error } = await supabase.from('locations').update({
      pos_settings: { ...(cur.pos_settings || {}), order_screen_keep_paid: value === true },
    }).eq('id', locationId).select('id');
    const failure = error || zeroRows(data, 'Save');
    reportSave('order screen setting', failure);
    if (failure) return fail(failure, 'Could not save. Try again.');
    return ok(value === true);
  }, 'Could not save. Try again.');
}

// ── Venue name (Back Office preview header when Header text is blank) ──────────────

export async function loadVenueName(locationId) {
  if (isMock || !supabase || !realLoc(locationId)) return ok('');
  return guard(async () => {
    const { data, error } = await supabase.from('locations').select('name').eq('id', locationId).maybeSingle();
    if (error) return fail(error, 'Could not load the venue name.');
    return ok(typeof data?.name === 'string' ? data.name : '');
  }, 'Could not load the venue name.');
}

// ── Names on the TV ────────────────────────────────────────────────────────────

/**
 * { data: true } when TVs may show names (order_status_names_enabled(): the order_queue
 * fence is in place), { data: false } while they show order numbers only. A failed or
 * missing call gives { data: null }, meaning unknown.
 */
export async function loadNamesEnabled() {
  if (isMock || !supabase) return ok(null);
  try {
    const { data, error } = await supabase.rpc('order_status_names_enabled');
    if (error) return { ...fail(error), data: null };
    return ok(typeof data === 'boolean' ? data : null);
  } catch (e) {
    return { ...fail(e), data: null };
  }
}

// ── Logo upload ────────────────────────────────────────────────────────────────

export const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export async function uploadOrderScreenLogo(locationId, file) {
  if (isMock || !supabase) return notLive();
  if (!file || !realLoc(locationId)) return fail(new Error('No file'), 'Choose an image to upload.');
  const ext = LOGO_TYPES[String(file.type || '').toLowerCase()];
  if (!ext) return fail(new Error('Unsupported logo type'), 'Choose a PNG, JPG or WebP picture.');
  return guard(async () => {
    // A new name every time and never upsert, so an upload can never replace another file.
    const path = `locations/${locationId}/orderscreen/${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from(ASSET_BUCKET).upload(path, file, { upsert: false, contentType: file.type });
    if (error) return fail(error, 'Could not upload the logo. Try again.');
    const { data } = supabase.storage.from(ASSET_BUCKET).getPublicUrl(path);
    if (!data?.publicUrl) return fail(new Error('No public URL'), 'Could not upload the logo. Try again.');
    return ok(`${data.publicUrl}?t=${Date.now()}`);
  }, 'Could not upload the logo. Try again.');
}
