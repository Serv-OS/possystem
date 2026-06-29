// src/lib/nudge.js — manager → tills "nudge" for a stalled table.
// One-way Supabase realtime broadcast on `nudge:<locationId>`. The tills subscribe in lib/realtime.js
// (startRealtime) and pop a toast + chime. No DB write — a transient "go check this table" ping.
//
// Mirrors the PROVEN customerDisplay broadcast pattern exactly: a PERSISTENT channel (subscribed once,
// reused) with { broadcast: { self:false, ack:false } }, flushing the latest payload on join. The old
// create-subscribe-send-remove-after-800ms approach raced the teardown against the send and dropped it.
import { supabase, isMock } from './supabase';

const _pub = { channel: null, loc: null, joined: false, pending: null };

function _flush() {
  if (!_pub.channel || _pub.pending == null) return;
  try { _pub.channel.send({ type: 'broadcast', event: 'nudge', payload: _pub.pending }); } catch { /* offline */ }
  _pub.pending = null;
}

function _ensure(locationId) {
  if (_pub.channel && _pub.loc === locationId) return;
  if (_pub.channel) { try { supabase.removeChannel(_pub.channel); } catch { /* noop */ } }
  _pub.loc = locationId; _pub.joined = false;
  _pub.channel = supabase.channel(`nudge:${locationId}`, { config: { broadcast: { self: false, ack: false } } });
  _pub.channel.subscribe((status) => { if (status === 'SUBSCRIBED') { _pub.joined = true; _flush(); } });
}

/** Ping the tills about a stalled table. payload: { table, covers, waitMins, by }. */
export function sendNudge(locationId, payload = {}) {
  if (isMock || !supabase || !locationId) return;
  _ensure(locationId);
  _pub.pending = payload;          // keep only the latest; flushed now if joined, else on SUBSCRIBED
  if (_pub.joined) _flush();
}
