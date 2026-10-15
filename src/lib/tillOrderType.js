/**
 * tillOrderType.js: which order type a till starts on, and when a dine in order needs a flag
 * number. Peter, Coffee Boy, 30 Sep 2026.
 *
 *   Default order type: "Huddersfield have one POS that only does drive thru but it's defaulting
 *   to Dine in, not Drive thru, even though it's the only order type available on that POS."
 *   The device profile can name a default (device_profiles.default_order_type); without one the
 *   till works it out from the enabled types (defaultOrderTypeFor). The store applies it at boot,
 *   when a profile is applied or pushed, and every time a walk in order is cleared. Never on a
 *   floor table: a table is always dine in.
 *
 *   Flag number: "For coffee shops, a setting we can turn on so that on dine in orders it prompts
 *   for a table flag: they have several numbered signs, no fixed tables, so staff must be prompted
 *   to type that number, and then the KDS and production tickets say Table and the number typed."
 *   POS only, and staff must enter it (no skip). With the profile switch on
 *   (device_profiles.dine_in_flag_prompt) a dine in walk in order asks for the flag before it is
 *   sent or paid, whichever comes first (needsFlagPrompt). The order then carries the flag the
 *   way a kiosk order with a flag does (kioskStaffFlags.js kioskTicketLabels): "Table 30 · #09"
 *   on the kitchen screen and the paper ticket, "Table 30" on the receipt and in Orders.
 *
 * Pure: imports only kioskStaffFlags.js (itself import free), so node:test can load it
 * (tillOrderType.test.js).
 */
import { kioskShortRef } from './kioskStaffFlags.js';

/** The order types a device profile can enable (DeviceProfiles.jsx ORDER_TYPES plus delivery). */
export const ORDER_TYPE_KEYS = ['dine-in', 'takeaway', 'collection', 'delivery', 'drive-thru'];

/** device_profiles columns added by 20260930c_OPS_device_profile_default_order_type.sql. */
export const DEFAULT_ORDER_TYPE_COLUMN = 'default_order_type';
export const FLAG_PROMPT_COLUMN = 'dine_in_flag_prompt';

/** A flag is 1 to 4 digits, as the kiosk keypad takes it. Anything else is no flag. */
export const FLAG_MAX_DIGITS = 4;

/**
 * True once device_profiles has the two columns: a row read with select('*') carries them.
 * Back Office only shows the settings and sends the columns when this is true, so a save from
 * a Back Office loaded before the migration ran cannot fail on an unknown column.
 */
export function tillOrderColumnsReady(row) {
  return !!row && typeof row === 'object' && DEFAULT_ORDER_TYPE_COLUMN in row;
}

/** The two settings as the editor form holds them and as the table stores them. */
export const TILL_ORDER_FIELDS = [
  ['defaultOrderType', DEFAULT_ORDER_TYPE_COLUMN],
  ['dineInFlagPrompt', FLAG_PROMPT_COLUMN],
];

/**
 * The stale tab guard for the two columns (the v5.7.9 GUARDED_FIELDS class: a Back Office tab
 * that opened a profile before another tab set "Starts on" must not wipe it with a rename).
 * Returns the [formKey, column] pairs whose stored value must be kept on this save: the ones
 * this editor session did not touch. Nothing to keep while the columns are not there (the
 * fresh read must never name a missing column), and nothing when the caller cannot say what
 * was touched (today's full overwrite, as GUARDED_FIELDS does).
 */
export function tillOrderColumnsToKeep(touched, ready) {
  if (ready !== true || !(touched instanceof Set)) return [];
  return TILL_ORDER_FIELDS.filter(([formKey]) => !touched.has(formKey));
}

/**
 * The order type a till starts on. config is the till's deviceConfig (or a profile):
 *   enabledOrderTypes  the types the profile ticks
 *   defaultOrderType   the explicit default, or null for automatic
 * Rule: the explicit default when it is set AND enabled; else the only enabled type when there
 * is exactly one; else dine in when it is enabled; else the first enabled type. With no config,
 * or an empty list (a KDS profile), dine in, as before.
 */
export function defaultOrderTypeFor(config) {
  const enabled = Array.isArray(config?.enabledOrderTypes)
    ? config.enabledOrderTypes.filter(t => typeof t === 'string' && t)
    : [];
  const wanted = typeof config?.defaultOrderType === 'string' ? config.defaultOrderType : null;
  if (wanted && enabled.includes(wanted)) return wanted;
  if (enabled.length === 1) return enabled[0];
  if (!enabled.length || enabled.includes('dine-in')) return 'dine-in';
  return enabled[0];
}

/**
 * The default as Back Office stores it: a known type that is still enabled, else null
 * (automatic). Unticking the type that was the default falls back to automatic instead of
 * keeping a default the till could never show.
 */
export function cleanDefaultOrderType(value, enabledOrderTypes) {
  if (typeof value !== 'string' || !ORDER_TYPE_KEYS.includes(value)) return null;
  const enabled = Array.isArray(enabledOrderTypes) ? enabledOrderTypes : [];
  return enabled.includes(value) ? value : null;
}

/** 'Automatic (Dine in)' style text for the profile card and the editor. */
export function defaultOrderTypeSummary(config, labelOf = (t) => t) {
  const wanted = typeof config?.defaultOrderType === 'string' ? config.defaultOrderType : null;
  const enabled = Array.isArray(config?.enabledOrderTypes) ? config.enabledOrderTypes : [];
  const effective = defaultOrderTypeFor(config);
  if (wanted && enabled.includes(wanted)) return labelOf(effective);
  return `Automatic (${labelOf(effective)})`;
}

/** Digits only, at most FLAG_MAX_DIGITS, or null when nothing usable was typed. */
export function cleanFlagNumber(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '').slice(0, FLAG_MAX_DIGITS);
  return digits || null;
}

/**
 * Does this order need the flag prompt before it is sent or paid?
 *   deviceConfig.dineInFlagPrompt  the profile switch
 *   orderType                      the till's current type: only dine in asks
 *   activeTableId                  a floor table never asks, it has a table already
 *   walkInOrder.tableFlag          an order that already has its flag never asks again
 */
export function needsFlagPrompt({ deviceConfig, orderType, activeTableId, walkInOrder } = {}) {
  if (deviceConfig?.dineInFlagPrompt !== true) return false;
  if (orderType !== 'dine-in') return false;
  if (activeTableId) return false;
  return !cleanFlagNumber(walkInOrder?.tableFlag);
}

/**
 * The flag an order carries, or null. Only a dine in order has one: a flag typed before staff
 * switched the order to takeaway must never make a takeaway a table ticket (the same rule as
 * kioskTableForTicket).
 */
export function orderFlag(walkInOrder, orderType) {
  if (orderType !== 'dine-in') return null;
  return cleanFlagNumber(walkInOrder?.tableFlag);
}

/** "Table 30": the receipt, the closed check and the Orders badge. */
export function flagTableLabel(flag) {
  const f = cleanFlagNumber(flag);
  return f ? `Table ${f}` : null;
}

/**
 * "Table 30 · #09": the kds_tickets row (table_label) and the paper ticket header, the same
 * shape a kiosk flag order gets (kioskTicketLabels rule 2), so the KDS shows the table as the
 * headline with the receipt number beside it, and fireCourse, which finds a floor table's
 * tickets by table_label, can never pick one of these up (no floor table is named like that).
 * Without a ref, just "Table 30".
 */
export function flagTicketLabel(flag, ref) {
  const table = flagTableLabel(flag);
  if (!table) return null;
  const raw = ref == null ? '' : String(ref).trim().replace(/^#/, '');
  if (!raw) return table;
  return `${table} · #${kioskShortRef(raw)}`;
}
