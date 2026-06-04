// src/lib/customerDisplay.js
//
// Customer-facing DEDICATED display (Sunmi D3 Pro rear screen / external monitor).
// Live cart + payment status over a Supabase Realtime *broadcast* channel.
//
// This is the sibling of readerDisplay.js — same "customer display" subsystem, a
// different destination. readerDisplay.js pushes to the WisePOS E's own screen;
// this pushes to a separate screen running the ?mode=customer-display surface.
// Which destination a terminal uses is chosen by device_profiles.customer_display_mode
// (off | reader | screen | auto).
//
// Channel: `display:<deviceId>` where deviceId is the POS terminal's ops device id
// (localStorage 'rpos-device'.id). Broadcast is ephemeral (no DB row) + low-latency,
// and works whether the display is the same physical device (D3 Pro main+rear) or a
// separate screen bound to a till via ?till=<deviceId>.

import { supabase, isMock } from './supabase';

// ── Destination mode (per terminal) ─────────────────────────────────────────
// device_profiles.customer_display_mode, cached in localStorage so cart-change
// checks are synchronous. 'auto' (default) = drive both reader + screen and let
// whichever hardware is present render it; 'reader' / 'screen' / 'off' are explicit.
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

/** Which till the display mirrors: explicit ?till=<deviceId> override, else this device. */
export function getDisplayTargetId() {
  try {
    const t = new URLSearchParams(window.location.search).get('till');
    if (t) return t;
  } catch { /* no window */ }
  return getOwnDeviceId();
}

function channelName(deviceId) { return `display:${deviceId}`; }

// ── Publisher (POS side) ────────────────────────────────────────────────────
// Keep one channel; remember the latest payload and (re)send it on (re)subscribe
// so a display that opens mid-sale catches up on the next publish/heartbeat.
const _pub = { channel: null, deviceId: null, joined: false, latest: null };

function _doSend(payload) {
  try { _pub.channel?.send({ type: 'broadcast', event: 'display', payload }); } catch { /* offline */ }
}

function _ensurePub(deviceId) {
  if (_pub.channel && _pub.deviceId === deviceId) return;
  if (_pub.channel) { try { supabase.removeChannel(_pub.channel); } catch { /* noop */ } }
  _pub.channel = supabase.channel(channelName(deviceId), { config: { broadcast: { ack: false } } });
  _pub.deviceId = deviceId;
  _pub.joined = false;
  _pub.channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      _pub.joined = true;
      if (_pub.latest) _doSend(_pub.latest); // flush latest to anyone listening
    }
  });
}

/**
 * Publish the current display state. Call on cart change + payment-state change.
 * @param {{items?:Array, total?:number, currency?:string, state?:string, meta?:object}} payload
 *   state: 'idle' | 'active' | 'paying' | 'approved' | 'declined'
 */
export function publishDisplay(payload = {}) {
  if (isMock || !supabase) return;
  const deviceId = getOwnDeviceId();
  if (!deviceId) return;
  _pub.latest = payload;
  _ensurePub(deviceId);
  if (_pub.joined) _doSend(payload);
}

/** Reset the display to its idle / attract state. */
export function clearDisplay() {
  publishDisplay({ items: [], total: 0, state: 'idle' });
}

// ── Subscriber (display side) ───────────────────────────────────────────────
/**
 * Subscribe to a till's display broadcast. Returns an unsubscribe fn.
 * @param {string} deviceId  the POS terminal's ops device id to mirror
 * @param {(payload:object)=>void} onState
 */
export function subscribeDisplay(deviceId, onState) {
  if (!supabase || !deviceId) return () => {};
  const ch = supabase
    .channel(channelName(deviceId), { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'display' }, (msg) => { try { onState(msg.payload || {}); } catch { /* noop */ } })
    .subscribe();
  return () => { try { supabase.removeChannel(ch); } catch { /* noop */ } };
}
