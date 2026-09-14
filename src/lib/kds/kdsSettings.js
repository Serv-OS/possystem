// src/lib/kds/kdsSettings.js
//
// Per screen KDS settings (v5.8.66). Saved against the paired device in
// devices.kds_settings (Peter: "in the database", 14 Sep 2026) with a localStorage
// copy so the board paints instantly and still works before the migration is run.
// Pure: no React, no Supabase.

export const KDS_SETTINGS_VERSION = 1;

/** Switches under ON THE TICKET, in the order the settings sheet lists them. */
export const KDS_TOGGLES = [
  ['name',      'Name / table',          'Customer name or table number, own line, never truncated'],
  ['source',    'POS name',              'Where it came from — Till 1, Kiosk, Deliveroo'],
  ['staff',     'Staff name',            'Who sent the order from the till'],
  ['covers',    'Covers',                'Number of guests, for example 4 cv'],
  ['timer',     'Elapsed timer',         'Time since the order fired, with status colour'],
  ['course',    'Course / firing tag',   'Course 1, hold, immediate'],
  ['notes',     'Kitchen notes',         'Order notes from the till or the customer'],
  ['counts',    'Type counts in header', 'Tap a count to filter the board'],
  ['rail',      'To-make rail',          'Aggregated item quantities down the right'],
  ['heldToEnd', 'Held tickets to the end', 'Held tickets move after every live ticket'],
];

export const KDS_DEFAULTS = Object.freeze({
  v: KDS_SETTINGS_VERSION,
  colour: 'type',            // 'type' | 'status'
  density: 'comfortable',    // 'comfortable' | 'compact'
  caution: 10,               // minutes, green to orange (design default, Peter chose it)
  late: 15,                  // minutes, orange to red
  show: Object.freeze(Object.fromEntries(KDS_TOGGLES.map(([k]) => [k, true]))),
});

export const THRESHOLD_MAX = 120;

const int = (v) => {
  const n = typeof v === 'string' && v.trim() === '' ? NaN : Math.round(Number(v));
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Keep caution in 1 … late − 1 and late in caution + 1 … 120.
 * `changed` says which one the user just moved, so that one wins and the other
 * gives way (the design's stepper clamps). Anything unreadable falls back to the defaults.
 */
export function clampThresholds(caution, late, changed = null) {
  let c = int(caution);
  let l = int(late);
  if (!Number.isFinite(c)) c = KDS_DEFAULTS.caution;
  if (!Number.isFinite(l)) l = KDS_DEFAULTS.late;
  if (changed === 'caution') {
    c = Math.max(1, Math.min(THRESHOLD_MAX - 1, c));
    l = Math.max(c + 1, Math.min(THRESHOLD_MAX, l));
  } else {
    l = Math.max(2, Math.min(THRESHOLD_MAX, l));
    c = Math.max(1, Math.min(l - 1, c));
  }
  return { caution: c, late: l };
}

/** Any stored value (null, a string, an old shape) → a complete, valid settings object. */
export function normaliseKdsSettings(raw) {
  let src = raw;
  if (typeof src === 'string') { try { src = JSON.parse(src); } catch { src = null; } }
  if (!src || typeof src !== 'object' || Array.isArray(src)) src = {};
  const show = {};
  for (const [k] of KDS_TOGGLES) {
    show[k] = typeof src.show?.[k] === 'boolean' ? src.show[k] : KDS_DEFAULTS.show[k];
  }
  const { caution, late } = clampThresholds(src.caution ?? KDS_DEFAULTS.caution, src.late ?? KDS_DEFAULTS.late);
  return {
    v: KDS_SETTINGS_VERSION,
    colour: src.colour === 'status' ? 'status' : 'type',
    density: src.density === 'compact' ? 'compact' : 'comfortable',
    caution,
    late,
    show,
  };
}

/** The localStorage key: one per paired device, so two screens on one tablet never share. */
export function kdsSettingsStorageKey(deviceId) {
  return `rpos-kds-settings-${deviceId || 'local'}`;
}

/** PostgREST / Postgres wording for "that column is not there yet". */
export function isMissingColumnError(error, column) {
  const msg = `${error?.code || ''} ${error?.message || ''} ${error?.details || ''}`;
  if (/PGRST204|42703/.test(msg)) return !column || msg.includes(column);
  return /column .* does not exist|could not find the .* column/i.test(msg) && (!column || msg.includes(column));
}

/** Staff who can open the settings: role Manager, or the manager permission (MManagerPin rule). */
export function isManagerStaff(s) {
  if (!s || s.active === false) return false;
  return String(s.role || '').toLowerCase() === 'manager'
    || (Array.isArray(s.permissions) && s.permissions.includes('manager'));
}

/** The manager whose PIN this is, or null. Staff with no PIN can never match. */
export function matchManagerPin(staff, pin) {
  const p = String(pin ?? '');
  if (!p) return null;
  return (staff || []).find(s => isManagerStaff(s) && s.pin && String(s.pin) === p) || null;
}
