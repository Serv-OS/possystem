// src/lib/bookings/hostData.js
//
// HOST TOOLS data layer (16 Oct 2026, v5.11.70 host track). Every call the new
// host tools make: guest tags and visits, a booking's money and its refunds,
// the requests inbox, the pay link, and the manager PIN check. The host stand
// is a paired tablet the database refuses most of these tables, so the reads
// go through the booking-host edge function (fenced to the venue) and the
// refund goes through adyen-modify (booking_refund). Pure rules live in
// supabase/functions/_shared/bookingHost.js (tested).
//
// Every function answers { ok:false, error } in plain words rather than
// throwing. notDeployed: the function is not on the server yet, so the screen
// can say what waits for the deploy instead of failing silently.

import { supabase, isMock, getActiveLocationSync } from '../supabase';
import { useStore } from '../../store';
import { waitlistPinLogin } from '../waitlist/waitlistData';
import { isManagerRole, visibleTags } from '../../../supabase/functions/_shared/bookingHost.js';

const locId = () => getActiveLocationSync() || useStore.getState().currentLocationId || null;
const realLoc = (l) => !!l && l !== 'loc-demo';

const NOT_DEPLOYED = 'This needs the latest server update (booking-host). Ask for it to be deployed.';

async function invoke(fn, body) {
  if (isMock || !supabase) return { ok: false, error: 'Not connected, so this cannot run here.', offline: true };
  try {
    const { data, error } = await supabase.functions.invoke(fn, { body });
    if (error) {
      let msg = error.message || 'The server did not answer.';
      const status = error.context?.status ?? null;
      let ctx = null;
      try { ctx = await error.context?.json?.(); } catch { /* no body */ }
      if (ctx?.error) msg = ctx.error;
      // A function that is not deployed answers 404 { code: 'NOT_FOUND', message: 'Requested function was not found' }.
      if (status === 404 && (ctx?.code === 'NOT_FOUND' || /requested function/i.test(String(ctx?.message || msg)))) {
        return { ok: false, error: NOT_DEPLOYED, notDeployed: true };
      }
      // Keep the server's own answer on a non 2xx reply (adyen-modify answers a refund Adyen did
      // not confirm with 502 { pending: true }), so the screen can say "on its way".
      if (ctx && typeof ctx === 'object') return { ...ctx, ok: false, error: msg, status };
      return { ok: false, error: msg, status };
    }
    return data || { ok: false, error: 'The server sent nothing back.' };
  } catch (e) {
    return { ok: false, error: e?.message || 'The server could not be reached.' };
  }
}

const host = (action, payload = {}) => {
  const location_id = payload.location_id || locId();
  if (!realLoc(location_id)) return Promise.resolve({ ok: false, error: 'No venue is set on this device.' });
  return invoke('booking-host', { action, ...payload, location_id });
};

// ── guest tags and visits ────────────────────────────────────────────────────
// Cached per customer for five minutes, and one request in flight per id, so a
// diary of forty bookings asks once. A till can read customers itself, so when
// booking-host is not deployed yet the till still shows tags (no visit count).
const FACTS_TTL = 5 * 60 * 1000;
const factsCache = new Map(); // id -> { at, facts }
const inFlight = new Map();   // id -> promise

async function directFacts(ids) {
  if (isMock || !supabase) return {};
  try {
    const { data } = await supabase.from('customers').select('id, tags, no_shows').in('id', ids);
    const out = {};
    for (const c of data || []) out[c.id] = { tags: visibleTags(c.tags), visits: null, noShows: Number(c.no_shows) || 0 };
    return out;
  } catch { return {}; }
}

// The CRM id on a booking (customerId) or a till customer (customerId, or id).
export const customerIdOf = (c) => {
  const id = c?.customerId || c?.customer_id || c?.id || null;
  return id && /^[0-9a-f-]{36}$/i.test(String(id)) ? String(id) : null;
};

export function cachedGuestFacts(id) {
  const hit = id ? factsCache.get(id) : null;
  return hit && Date.now() - hit.at < FACTS_TTL ? hit.facts : null;
}

export async function loadGuestFacts(customerId) {
  const id = String(customerId || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const hit = cachedGuestFacts(id);
  if (hit) return hit;
  if (inFlight.has(id)) return inFlight.get(id);
  // 17 Oct 2026 (v5.11.73): the in flight entry is cleared even when something throws, so one
  // failed read is not handed to every later caller for that guest.
  const p = (async () => {
    try {
      let facts = null;
      const res = await host('guest_facts', { customer_ids: [id] });
      if (res?.ok) facts = res.facts?.[id] || { tags: [], visits: 0, noShows: 0 };
      else facts = (await directFacts([id]))[id] || null;
      if (facts) factsCache.set(id, { at: Date.now(), facts });
      return facts;
    } catch {
      return null;
    } finally { inFlight.delete(id); }
  })();
  inFlight.set(id, p);
  return p;
}

// ── a booking's money and refunds ────────────────────────────────────────────
export const loadBookingMoney = (bookingId) => host('money', { booking_id: bookingId });

export async function refundBookingPayment({ paymentId, amountMinor, managerPin = null, by = null }) {
  const location_id = locId();
  if (!realLoc(location_id)) return { ok: false, error: 'No venue is set on this device.' };
  const res = await invoke('adyen-modify', {
    action: 'booking_refund', location_id, booking_payment_id: paymentId, amount_minor: amountMinor,
    ...(managerPin ? { manager_pin: managerPin } : {}), ...(by ? { by } : {}),
  });
  if (res?.notDeployed) return { ok: false, error: 'Refunds need the latest adyen-modify on the server. Ask for it to be deployed.' };
  if (res && res.ok !== true && !res.error) return { ok: false, error: 'Refund NOT made. Try again.' };
  // An adyen-modify from before this release answers "action ... required" for booking_refund.
  if (res && !res.ok && /action \('capture'/.test(String(res.error || ''))) {
    return { ok: false, error: 'Refunds need the latest adyen-modify on the server. Ask for it to be deployed.' };
  }
  return res;
}

// ── the requests inbox ───────────────────────────────────────────────────────
export const loadRequests = () => host('requests');
export const acceptRequest = (requestId, { time = null, by = null } = {}) => host('request_accept', { request_id: requestId, time, by });
export const declineRequest = (requestId, { message = '', by = null, sendSms = true } = {}) =>
  host('request_decline', { request_id: requestId, message, by, send_sms: sendSms });

// ── pay link ─────────────────────────────────────────────────────────────────
export const sendPayLink = (bookingId, { packageId = null, kind = null, by = null } = {}) =>
  host('pay_link', { booking_id: bookingId, package_id: packageId, kind, by });

// ── manager PIN ──────────────────────────────────────────────────────────────
// The PIN never stays on the device: waitlist_pin_login checks it on the
// server and answers who it is. Only a manager may approve.
export async function checkManagerPin(pin) {
  const l = locId();
  if (!realLoc(l)) return { ok: false, error: 'No venue is set on this device.' };
  const data = await waitlistPinLogin(l, String(pin || ''));
  if (!data?.ok) return { ok: false, error: 'PIN not recognised.' };
  if (!isManagerRole(data.role)) return { ok: false, error: `${data.name || 'That PIN'} is not a manager. Ask a manager.` };
  return { ok: true, name: data.name || 'Manager', role: data.role };
}
