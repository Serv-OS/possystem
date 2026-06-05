// src/lib/customerDisplay.js
//
// Customer-facing DEDICATED display (Sunmi D3 Pro rear screen / external monitor).
// Two-way over ONE Supabase Realtime *broadcast* channel per till (`display:<deviceId>`):
//   POS  → display : 'display' (live cart + state), 'loyalty' (lookup result)
//   display → POS  : 'customer-phone' (customer typed their number for rewards)
//
// Sibling of readerDisplay.js (which targets the WisePOS E screen). Destination is
// chosen per terminal via device_profiles.customer_display_mode (off|reader|screen|auto).

import { supabase, isMock } from './supabase';

// ── Destination mode (per terminal) ─────────────────────────────────────────
const MODE_KEY = 'rpos-customer-display-mode';
export function cacheCustomerDisplayMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode || 'auto'); } catch { /* noop */ }
}
export function getCustomerDisplayMode() {
  try { return localStorage.getItem(MODE_KEY) || 'auto'; } catch { return 'auto'; }
}
export const displayUsesScreen = (m = getCustomerDisplayMode()) => m === 'screen' || m === 'auto';
export const displayUsesReader = (m = getCustomerDisplayMode()) => m === 'reader' || m === 'auto';

export function getOwnDeviceId() {
  try { return JSON.parse(localStorage.getItem('rpos-device') || 'null')?.id || null; } catch { return null; }
}
/** Which till the display mirrors: ?till=<deviceId> override, else this device. */
export function getDisplayTargetId() {
  try { const t = new URLSearchParams(window.location.search).get('till'); if (t) return t; } catch { /* no window */ }
  return getOwnDeviceId();
}
function channelName(deviceId) { return `display:${deviceId}`; }

// ── POS side: one channel — sends 'display'/'loyalty', receives 'customer-phone'
const _pub = { channel: null, deviceId: null, joined: false, latest: null, onPhone: null, onRedeem: null };

function _send(event, payload) { try { _pub.channel?.send({ type: 'broadcast', event, payload }); } catch { /* offline */ } }

function _ensurePub(deviceId) {
  if (_pub.channel && _pub.deviceId === deviceId) return;
  if (_pub.channel) { try { supabase.removeChannel(_pub.channel); } catch { /* noop */ } }
  _pub.channel = supabase.channel(channelName(deviceId), { config: { broadcast: { self: false, ack: false } } });
  _pub.deviceId = deviceId;
  _pub.joined = false;
  _pub.channel.on('broadcast', { event: 'customer-phone' }, (m) => {
    try { if (_pub.onPhone) _pub.onPhone(m.payload?.phone); } catch { /* noop */ }
  });
  _pub.channel.on('broadcast', { event: 'redeem-reward' }, (m) => {
    try { if (_pub.onRedeem) _pub.onRedeem(m.payload?.reward); } catch { /* noop */ }
  });
  _pub.channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') { _pub.joined = true; if (_pub.latest) _send('display', _pub.latest); }
  });
}

/** Publish the current display state (cart + state). */
export function publishDisplay(payload = {}) {
  if (isMock || !supabase) return;
  const deviceId = getOwnDeviceId();
  if (!deviceId) return;
  _pub.latest = payload;
  _ensurePub(deviceId);
  if (_pub.joined) _send('display', payload);
}

/** Reset the display to idle. */
export function clearDisplay() { publishDisplay({ items: [], total: 0, state: 'idle' }); }

/** Push a loyalty lookup result to the display ({ known, name, points, smsSent }). */
export function publishLoyalty(result) {
  if (isMock || !supabase) return;
  const deviceId = getOwnDeviceId();
  if (!deviceId) return;
  _ensurePub(deviceId);
  if (_pub.joined) _send('loyalty', result);
  else setTimeout(() => _send('loyalty', result), 800);
}

/** POS: register a handler for when the customer types their phone on the display. */
export function onCustomerPhone(cb) {
  if (isMock || !supabase) return () => {};
  const deviceId = getOwnDeviceId();
  if (!deviceId) return () => {};
  _ensurePub(deviceId);
  _pub.onPhone = cb;
  return () => { _pub.onPhone = null; };
}

// ── Display side: one channel — receives 'display'/'loyalty', sends 'customer-phone'
const _sub = { channel: null };

/** Subscribe to a till's broadcast. onState(cart/state), onLoyalty(result). */
export function subscribeDisplay(deviceId, onState, onLoyalty) {
  if (!supabase || !deviceId) return () => {};
  const ch = supabase.channel(channelName(deviceId), { config: { broadcast: { self: false } } });
  ch.on('broadcast', { event: 'display' }, (m) => { try { onState(m.payload || {}); } catch { /* noop */ } });
  ch.on('broadcast', { event: 'loyalty' }, (m) => { try { onLoyalty && onLoyalty(m.payload || {}); } catch { /* noop */ } });
  ch.subscribe();
  _sub.channel = ch;
  return () => { try { supabase.removeChannel(ch); } catch { /* noop */ } _sub.channel = null; };
}

/** Display: the customer entered their phone number for rewards. */
export function publishCustomerPhone(phone) {
  if (!phone || !_sub.channel) return;
  try { _sub.channel.send({ type: 'broadcast', event: 'customer-phone', payload: { phone } }); } catch { /* noop */ }
}

/** Display: the customer tapped a reward to use it. */
export function publishRedeemReward(reward) {
  if (!reward || !_sub.channel) return;
  try { _sub.channel.send({ type: 'broadcast', event: 'redeem-reward', payload: { reward } }); } catch { /* noop */ }
}

/** POS: register a handler for when the customer taps a reward on the display. */
export function onRedeemReward(cb) {
  if (isMock || !supabase) return () => {};
  const deviceId = getOwnDeviceId();
  if (!deviceId) return () => {};
  _ensurePub(deviceId);
  _pub.onRedeem = cb;
  return () => { _pub.onRedeem = null; };
}

// ── Loyalty enabled? (gates the phone-capture keypad on the display) ─────────
export async function isLoyaltyEnabled() {
  try {
    if (isMock || !supabase) return false;
    const dev = JSON.parse(localStorage.getItem('rpos-device') || 'null');
    const locationId = dev?.locationId;
    if (!locationId) return false;
    const { data: s } = await supabase.auth.getSession();
    const token = s?.session?.access_token;
    if (!token) return false;
    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/loyalty-config?location_id=${encodeURIComponent(locationId)}`,
      { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return false;
    const j = await res.json();
    return !!j?.enabled;
  } catch { return false; }
}
