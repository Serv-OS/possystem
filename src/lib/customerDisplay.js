// src/lib/customerDisplay.js
//
// Customer-facing DEDICATED display (Sunmi D3 Pro rear screen / external monitor).
// Two-way over ONE Supabase Realtime *broadcast* channel per till (`display:<deviceId>`):
//   POS  → display : 'display' (live cart + state), 'loyalty' (lookup result),
//                    'tip-request' (ask the customer to choose a gratuity)
//   display → POS  : 'customer-phone' (customer typed their number for rewards),
//                    'customer-tip'   (customer chose a gratuity)
//
// The tip round-trip exists because Ryft's terminal API has NO on-reader tip
// prompt (it takes one amount and reports back only that amount). So on Ryft the
// customer chooses the tip HERE, and the POS then charges bill+tip as a single
// amount. Stripe venues are unaffected — their reader still prompts.
//
// Sibling of readerDisplay.js (which targets the WisePOS E screen). Destination is
// chosen per terminal via device_profiles.customer_display_mode (off|reader|screen|auto).

import { supabase, isMock, ensureAuthToken } from './supabase';

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
const _pub = { channel: null, deviceId: null, joined: false, latest: null, onPhone: null, onRedeem: null, onTip: null };

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
  _pub.channel.on('broadcast', { event: 'customer-tip' }, (m) => {
    try { if (_pub.onTip) _pub.onTip(m.payload); } catch { /* noop */ }
  });
  _pub.channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') { _pub.joined = true; if (_pub.latest) _send('display', _pub.latest); }
  });
}

/** Publish the current display state (cart + state). Carries the POS light/dark
 *  theme so the rear screen matches the till (works cross-device too). */
export function publishDisplay(payload = {}) {
  if (isMock || !supabase) return;
  const deviceId = getOwnDeviceId();
  if (!deviceId) return;
  let theme = 'dark';
  try { theme = localStorage.getItem('rpos-theme') || 'dark'; } catch { /* default */ }
  const full = { ...payload, theme };
  _pub.latest = full;
  _ensurePub(deviceId);
  if (_pub.joined) _send('display', full);
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

/** POS → display: ask the customer to choose a gratuity.
 *  `cfg` carries the venue's own tipping rules (percentages / custom / smart
 *  threshold) so the display shows exactly what the operator configured, and
 *  `nonce` lets the POS ignore a stale reply from a previous sale. */
export function publishTipRequest({ total, cfg, nonce }) {
  if (isMock || !supabase) return;
  const deviceId = getOwnDeviceId();
  if (!deviceId) return;
  _ensurePub(deviceId);
  const send = () => _send('tip-request', { total, cfg, nonce });
  if (_pub.joined) send(); else setTimeout(send, 800);
}

/** POS: handler for the customer's gratuity choice. Payload { tip, nonce }. */
export function onCustomerTip(cb) {
  if (isMock || !supabase) return () => {};
  const deviceId = getOwnDeviceId();
  if (!deviceId) return () => {};
  _ensurePub(deviceId);
  _pub.onTip = cb;
  return () => { _pub.onTip = null; };
}

// ── Display side: one channel — receives 'display'/'loyalty', sends 'customer-phone'
const _sub = { channel: null };

/** Subscribe to a till's broadcast. onState(cart/state), onLoyalty(result). */
export function subscribeDisplay(deviceId, onState, onLoyalty, onTipRequest) {
  if (!supabase || !deviceId) return () => {};
  const ch = supabase.channel(channelName(deviceId), { config: { broadcast: { self: false } } });
  ch.on('broadcast', { event: 'display' }, (m) => { try { onState(m.payload || {}); } catch { /* noop */ } });
  ch.on('broadcast', { event: 'loyalty' }, (m) => { try { onLoyalty && onLoyalty(m.payload || {}); } catch { /* noop */ } });
  ch.on('broadcast', { event: 'tip-request' }, (m) => { try { onTipRequest && onTipRequest(m.payload || {}); } catch { /* noop */ } });
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

/** Display: the customer chose a gratuity (or declined — tip 0). */
export function publishCustomerTip(tip, nonce) {
  if (!_sub.channel) return;
  try { _sub.channel.send({ type: 'broadcast', event: 'customer-tip', payload: { tip, nonce } }); } catch { /* noop */ }
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
/**
 * Three-state: true/false = the venue's answer, null = COULD NOT ASK (no
 * pairing, no token, endpoint down). Callers must only trust a boolean —
 * broadcasting a null-collapsed `false` to the display suppressed the keypad
 * whenever this raced or failed at POS mount (v5.7.70).
 */
export async function isLoyaltyEnabled() {
  try {
    if (isMock || !supabase) return false;
    const dev = JSON.parse(localStorage.getItem('rpos-device') || 'null');
    const locationId = dev?.locationId;
    if (!locationId) return null;
    try { await ensureAuthToken(); } catch { /* getSession below may still hold one */ }
    const { data: s } = await supabase.auth.getSession();
    const token = s?.session?.access_token;
    if (!token) return null;
    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/loyalty-config?location_id=${encodeURIComponent(locationId)}`,
      { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const j = await res.json();
    // loyalty-config GET returns { config: { enabled, ... }, rewards, tiers } —
    // the flag lives at j.config.enabled, not the top level (j.enabled was always
    // undefined → keypad never showed). Fall back to j.enabled just in case.
    return !!(j?.config?.enabled ?? j?.enabled);
  } catch { return null; }
}
