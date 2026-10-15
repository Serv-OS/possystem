// supabase/functions/_shared/venueMessageRules.js
//
// MESSAGES FROM SERVOS TO VENUES: the rules, with no database and no browser in them.
//
// WHY (Peter, 5 Oct 2026): "we need to be able to send a notification, like a message, to all
// customers or certain customers asking them to do things, like a POP UP from the admin: send a
// message, in this case saying 'Hi, I have just made an update, you need to do XYZ'."
// "Customers" are ServOS's customers: the venues. His calls: it pops up in Back Office AND on
// tills, it stays until someone taps Got it, admin sees WHO did and when (one confirmation
// clears it for that venue), and he sends to chosen companies or venues.
//
// One row per message per venue lives in public.venue_messages
// (20261005a_OPS_venue_messages.sql). This file is shared by the venue-messages-admin edge
// function (it checks every send again on the server) and by the app (src/lib/venueMessageRules.js
// re-exports it), so the admin screen and the server can never disagree about what is allowed.
//
// PURE. No imports, so node tests load it directly.

export const MESSAGE_MAX = 600;
export const TITLE_MAX = 80;
export const NAME_MAX = 80;
export const MAX_VENUES_PER_SEND = 500;
export const KINDS = Object.freeze(['info', 'action']);
export const KIND_LABEL = Object.freeze({ info: 'Info', action: 'Action needed' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// Control characters other than a line break have no place in a message or a name.
const stripControl = (s, keepNewlines) => {
  let out = '';
  for (const ch of String(s == null ? '' : s)) {
    const c = ch.codePointAt(0);
    if (c === 10 && keepNewlines) { out += ch; continue; }
    if (c === 9) { out += ' '; continue; }
    if (c < 32 || c === 127) continue;
    out += ch;
  }
  return out;
};

/** A title or a name on one line: no control characters, single spaces, trimmed. */
export function oneLine(text) {
  return stripControl(String(text == null ? '' : text).replace(/\r\n?|\n/g, ' '), false).replace(/\s+/g, ' ').trim();
}

/**
 * The message text as it is stored: line breaks kept (Windows ones made plain), no other
 * control characters, no trailing spaces on a line, never more than one blank line in a row.
 */
export function cleanBody(text) {
  const lines = stripControl(String(text == null ? '' : text).replace(/\r\n?/g, '\n'), true)
    .split('\n').map((l) => l.replace(/\s+$/, ''));
  const out = [];
  for (const l of lines) {
    if (l === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(l);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/**
 * Check a draft. Too long is REFUSED, never cut: a message that lost its last line without the
 * sender knowing is worse than one that was not sent.
 * @returns {{ok:true,title:string|null,body:string,kind:string}|{ok:false,error:string}}
 */
export function cleanDraft(draft) {
  const d = draft || {};
  const title = oneLine(d.title);
  const body = cleanBody(d.body);
  const kind = String(d.kind || 'info');
  if (!KINDS.includes(kind)) return { ok: false, error: 'Choose Info or Action needed.' };
  if (!body) return { ok: false, error: 'Write the message first.' };
  if ([...body].length > MESSAGE_MAX) return { ok: false, error: `The message is too long. Keep it to ${MESSAGE_MAX} characters.` };
  if ([...title].length > TITLE_MAX) return { ok: false, error: `The title is too long. Keep it to ${TITLE_MAX} characters.` };
  return { ok: true, title: title || null, body, kind };
}

/**
 * Are these the same message (kind, title and text)? A send that is tried again under the same
 * broadcast id must carry the same words: one id is one text, always.
 */
export function sameMessage(a, b) {
  if (!a || !b) return false;
  return String(a.kind || 'info') === String(b.kind || 'info')
    && (a.title || null) === (b.title || null)
    && String(a.body || '') === String(b.body || '');
}

/**
 * What the admin screen says after a send. `sent` is how many venues were asked for, `written`
 * how many rows the server really added: fewer when this was a second try of a send whose reply
 * was lost (those venues already have it). Never claims a send that wrote nothing.
 */
export function sendResultLine({ sent = 0, written = null } = {}) {
  const n = Number(sent) || 0;
  const w = written == null ? n : Math.max(0, Math.min(n, Number(written) || 0));
  const venues = (k) => (k === 1 ? '1 venue' : `${k} venues`);
  const live = 'It is on their tills and Back Office now.';
  if (w === 0) return `Already sent: ${n === 1 ? 'that venue has' : `all ${venues(n)} have`} this message. Nothing was sent twice.`;
  if (w < n) return `Sent to ${venues(w)}. The other ${n - w} already had it. ${live}`;
  return `Sent to ${venues(n)}. ${live}`;
}

/**
 * Ticked companies and ticked venues become one list of venue ids.
 *   * a ticked company means every venue of that company in `venues`;
 *   * a venue id that is not in `venues` is dropped (and counted), never sent to;
 *   * each venue once, in the order of `venues`.
 * `venues` is the server's own list on the server, so a made up id can never be written.
 * @param {{companyIds?:string[], venueIds?:string[], venues:Array<{id:string, org_id?:string|null}>}} input
 * @returns {{venueIds:string[], unknown:number}}
 */
export function expandRecipients(input) {
  const { companyIds = [], venueIds = [], venues = [] } = input || {};
  const companies = new Set((companyIds || []).filter(Boolean).map(String));
  const wanted = new Set((venueIds || []).filter(Boolean).map(String));
  const known = new Set();
  const out = [];
  for (const v of venues || []) {
    if (!v || !v.id) continue;
    const id = String(v.id);
    if (known.has(id)) continue;
    known.add(id);
    if (wanted.has(id) || (v.org_id != null && companies.has(String(v.org_id)))) out.push(id);
  }
  let unknown = 0;
  for (const id of wanted) if (!known.has(id)) unknown += 1;
  return { venueIds: out, unknown };
}

/** Where one venue's copy of a message stands. Withdrawn wins: it is gone everywhere. */
export function venueStatus(row) {
  if (!row) return 'waiting';
  if (row.withdrawn_at) return 'withdrawn';
  if (row.confirmed_at) return 'confirmed';
  return 'waiting';
}

/** Still to be shown at the venue: not confirmed and not withdrawn. */
export function isOpenMessage(row) {
  return !!row && !!row.id && venueStatus(row) === 'waiting';
}

const timeOf = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };

/**
 * The Sent list: the per venue rows grouped into messages, newest message first, each with its
 * counts. "4 of 6 confirmed" is confirmed of total; a withdrawn message keeps the confirmations
 * it had.
 * @param {Array<object>} rows venue_messages rows
 * @param {Array<{id:string,name?:string,org_id?:string|null,org_name?:string,timezone?:string}>} venues
 */
export function rollupBroadcasts(rows, venues = []) {
  const byVenue = new Map((venues || []).filter((v) => v && v.id).map((v) => [String(v.id), v]));
  const groups = new Map();
  for (const r of rows || []) {
    if (!r || !r.broadcast_id) continue;
    const key = String(r.broadcast_id);
    let g = groups.get(key);
    if (!g) {
      g = {
        broadcastId: key, title: r.title || null, body: r.body || '', kind: r.kind === 'action' ? 'action' : 'info',
        sentAt: r.sent_at || null, sentByName: r.sent_by_name || null, resentAt: null, withdrawnAt: null,
        total: 0, confirmed: 0, waiting: 0, withdrawn: false, venues: [],
      };
      groups.set(key, g);
    }
    if (timeOf(r.sent_at) && (!g.sentAt || timeOf(r.sent_at) < timeOf(g.sentAt))) g.sentAt = r.sent_at;
    if (timeOf(r.resent_at) > timeOf(g.resentAt)) g.resentAt = r.resent_at;
    if (timeOf(r.withdrawn_at) > timeOf(g.withdrawnAt)) g.withdrawnAt = r.withdrawn_at;
    const v = byVenue.get(String(r.location_id)) || null;
    g.total += 1;
    if (r.confirmed_at) g.confirmed += 1;
    else if (!r.withdrawn_at) g.waiting += 1;
    g.venues.push({
      id: r.id, locationId: String(r.location_id), status: venueStatus(r),
      venueName: (v && v.name) || 'Venue removed', companyName: (v && v.org_name) || '',
      timezone: (v && v.timezone) || null,
      confirmedBy: r.confirmed_by || null, confirmedAt: r.confirmed_at || null, confirmedVia: r.confirmed_via || null,
      // The login behind a Back Office Got it. The name is a label a login can edit; this is not.
      confirmedEmail: r.confirmed_email || null,
      confirmedDevice: r.confirmed_device_name || null, resentAt: r.resent_at || null,
    });
  }
  const out = [...groups.values()];
  for (const g of out) {
    // Withdrawn as a whole only when no venue is still waiting and something was withdrawn.
    g.withdrawn = g.waiting === 0 && g.venues.some((x) => x.status === 'withdrawn');
    g.venues.sort((a, b) => (a.companyName.localeCompare(b.companyName) || a.venueName.localeCompare(b.venueName)));
  }
  out.sort((a, b) => timeOf(b.sentAt) - timeOf(a.sentAt));
  return out;
}

/** "4 of 6 confirmed", and what is left to wait for. */
export function countsLine(g) {
  if (!g) return '';
  const base = `${g.confirmed} of ${g.total} confirmed`;
  if (g.withdrawn) return `${base}, withdrawn`;
  if (g.total > 0 && g.confirmed === g.total) return `${base}, all done`;
  return base;
}

/** The one confirm question: "Send to 6 venues?" */
export function sendQuestion(count) {
  const n = Number(count) || 0;
  return n === 1 ? 'Send to 1 venue?' : `Send to ${n} venues?`;
}
