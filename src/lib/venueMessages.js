// src/lib/venueMessages.js: messages from ServOS to venues, the reads and the one write a venue
// can make (Got it). The rules are in lib/venueMessageRules.js; the table and its fence are in
// supabase/migrations/20261005a_OPS_venue_messages.sql.
//
// WHY (Peter, 5 Oct 2026): "a POP UP from the admin: send a message ... 'Hi, I have just made an
// update, you need to do XYZ'."
//
// BEFORE THE DATABASE UPDATE HAS RUN the table and the function are missing. Every read then
// answers "nothing to show" and says so once in the console: a till never sees an error for a
// feature it does not have yet.
//
// Training mode: these calls are not sales, so they are never switched off there. A till in
// training still shows the message and can still confirm it.
import { supabase, isMock } from './supabase';
import { isMissingVenueMessages, CONFIRM_TIMEOUT_MS } from './venueMessageRules';

// The columns a venue may read (the grant in 20261005a). Never '*': the sender's identity
// columns are not readable, and asking for them makes the whole read fail.
export const VENUE_MESSAGE_COLUMNS = 'id, broadcast_id, location_id, kind, title, body, sent_at, resent_at, confirmed_at, confirmed_by, confirmed_via, confirmed_device_name, withdrawn_at';

const realLocation = (id) => !!id && id !== 'loc-demo';
let warnedMissing = false;
const noteMissing = () => {
  if (warnedMissing) return;
  warnedMissing = true;
  console.info('[venue messages] waiting for the database update (20261005a). Nothing to show yet.');
};

/**
 * This venue's messages sent in the last `days` days, plus anything older still waiting.
 * @returns {Promise<{ok:boolean, ready:boolean, rows:Array<object>}>} ok false = the read failed
 *   (keep what is on screen); ready false = the database update has not run (show nothing).
 */
export async function fetchVenueMessages(locationId, { days = 30 } = {}) {
  if (isMock || !supabase || !realLocation(locationId)) return { ok: true, ready: false, rows: [] };
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const [recent, open] = await Promise.all([
      supabase.from('venue_messages').select(VENUE_MESSAGE_COLUMNS)
        .eq('location_id', locationId).gte('sent_at', since).order('sent_at', { ascending: false }).limit(200),
      supabase.from('venue_messages').select(VENUE_MESSAGE_COLUMNS)
        .eq('location_id', locationId).is('confirmed_at', null).is('withdrawn_at', null).order('sent_at', { ascending: true }).limit(50),
    ]);
    const error = recent.error || open.error;
    if (error) {
      if (isMissingVenueMessages(error)) { noteMissing(); return { ok: true, ready: false, rows: [] }; }
      console.warn('[venue messages] read failed', error.message);
      return { ok: false, ready: true, rows: [] };
    }
    const seen = new Set();
    const rows = [];
    for (const r of [...(open.data || []), ...(recent.data || [])]) {
      if (!r || !r.id || seen.has(r.id)) continue;
      seen.add(r.id);
      rows.push(r);
    }
    return { ok: true, ready: true, rows };
  } catch (e) {
    console.warn('[venue messages] read threw', e?.message);
    return { ok: false, ready: true, rows: [] };
  }
}

/**
 * Got it. The server decides who may (venue_message_confirm) and records the name: for Back
 * Office it is the login's own name, for a till the name sent here (the member of staff signed in).
 * @returns {Promise<{ok:boolean, state?:string, already?:boolean, confirmedBy?:string, confirmedAt?:string, reason?:string}>}
 */
export async function confirmVenueMessage(id, name, { timeoutMs = CONFIRM_TIMEOUT_MS } = {}) {
  if (isMock || !supabase || !id) return { ok: false, reason: 'offline' };
  let timer = null;
  try {
    // A request on a half open connection can hang for minutes. Give up after 15 seconds so the
    // caller is free to try again on its next read (the tap is still saved; a send that did
    // arrive after all answers "already" next time).
    const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve({ data: null, error: { message: 'timed out', timedOut: true } }), timeoutMs); });
    const { data, error } = await Promise.race([
      supabase.rpc('venue_message_confirm', { p_id: id, p_name: name || null }),
      timedOut,
    ]);
    if (error) {
      if (isMissingVenueMessages(error)) return { ok: false, reason: 'needs_update' };
      console.warn('[venue messages] confirm failed', error.message);
      return { ok: false, reason: 'failed' };
    }
    if (!data || data.ok !== true) return { ok: false, reason: (data && data.reason) || 'failed' };
    return {
      ok: true, state: data.state, already: data.already === true,
      confirmedBy: data.confirmed_by || null, confirmedAt: data.confirmed_at || null,
    };
  } catch (e) {
    console.warn('[venue messages] confirm threw', e?.message);
    return { ok: false, reason: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Live changes for one venue's messages. Realtime applies the table's read rule to each
 * listener, so a device only ever hears its own venue. `onRow` gets the new database row;
 * `onSubscribed` fires on every (re)connect so the caller reads again and catches anything
 * sent while it was not listening. Returns the unsubscribe.
 */
export function subscribeVenueMessages(locationId, { onRow, onSubscribed } = {}) {
  if (isMock || !supabase || !realLocation(locationId)) return () => {};
  let channel = null;
  try {
    channel = supabase
      .channel(`venue_messages:${locationId}:${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'venue_messages', filter: `location_id=eq.${locationId}`,
      }, (payload) => {
        try { if (payload?.new?.id) onRow?.(payload.new); } catch { /* a listener never breaks the channel */ }
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') { try { onSubscribed?.(); } catch { /* noop */ } }
      });
  } catch (e) {
    console.warn('[venue messages] live channel failed', e?.message);
  }
  return () => {
    try { if (channel) supabase.removeChannel(channel); } catch { /* noop */ }
  };
}
