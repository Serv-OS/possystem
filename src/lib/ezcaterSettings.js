// src/lib/ezcaterSettings.js
//
// The pure parts of Back Office, Channels, 3rd Party orders, "ezCater connect
// and settings". The screen (src/backoffice/sections/EzcaterSettings.jsx) is a
// shell: fetch, render, send. Everything that can be wrong lives here and is
// tested in ezcaterSettings.test.js.
//
// THE TOKEN NEVER RESTS HERE. ezCater issues one static API token per API user,
// by email, and cannot re-issue it if it is lost. It is pasted once, handed to
// the edge function once, and stored server side in ezcater_connections (service
// role only). Nothing in this file logs it, caches it, or puts it in a message:
// trimToken and connectBody pass it straight through and forget it.
//
// PLAIN WORDS ONLY. errorWords is the single place a failure turns into
// something an operator can act on. A raw Postgres code, a GraphQL dump or an
// "Edge Function returned a non-2xx status code" must never reach the screen.

import { isMatchingOff } from './ezcaterItemRows.js';

// ----------------------------------------------------------------------------
// Small shared bits
// ----------------------------------------------------------------------------

const textOf = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

/** Trim to a string, or '' for anything that is not text. Never throws. */
export function trimText(v) {
  if (typeof v === 'string') return v.trim();
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
  return '';
}

/**
 * The API token, ready to send.
 *
 * A pasted token arrives with a trailing newline or a leading space more often
 * than not, and ezCater answers an unhelpful 401 to both. Trim once, here, so
 * the screen and the tests agree on what was sent.
 */
export function trimToken(raw) {
  return trimText(raw);
}

/** A date an operator can read, or '' when there is nothing to show. */
export function whenWords(iso) {
  const raw = trimText(iso);
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  try { return d.toLocaleString(); } catch { return ''; }
}

// ----------------------------------------------------------------------------
// The API address (live, or a sandbox the operator types in)
// ----------------------------------------------------------------------------
//
// ezCater publish ONE address in their docs, https://api.ezcater.com/graphql,
// and no sandbox address at all. An owner with a sandbox account is given theirs
// by ezCater in an email, so the only way we can know it is for the operator to
// paste it. Empty means the live API, which is what every existing connection
// has and what the column defaults to.

export const EZ_LIVE_HOST = 'api.ezcater.com';
export const EZ_LIVE_API = 'https://api.ezcater.com/graphql';

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

/**
 * Check an operator typed API address before it is stored.
 *
 * https only. A sandbox address carries the same API token as everything else,
 * so sending it over http would put the token on the wire in clear.
 *
 * Returns { value, error }: value null means "use the live API", which is the
 * right answer for an empty box.
 */
export function validateApiUrl(raw) {
  const url = trimText(raw);
  if (!url) return { value: null, error: null };
  let parsed = null;
  try { parsed = new URL(url); } catch { parsed = null; }
  if (!parsed) return { value: null, error: 'That is not a web address. Paste the address ezCater gave you, or leave the box empty for the live ezCater API.' };
  if (parsed.protocol !== 'https:') {
    return { value: null, error: 'The API address has to start with https://. Your ezCater token travels with every call, so we will not send it over a plain http address.' };
  }
  return { value: url, error: null };
}

/**
 * Live or sandbox, worked out from the host and nothing else.
 *
 * ANYTHING that is not api.ezcater.com is sandbox, including an address we
 * cannot parse. Guessing the other way would let a sandbox connection sit on a
 * venue's Back Office looking live while no real order ever arrives.
 */
export function apiEnvironment(apiUrl) {
  const url = trimText(apiUrl);
  if (!url) {
    return {
      env: 'live',
      label: 'Live',
      tone: 'ok',
      host: EZ_LIVE_HOST,
      url: EZ_LIVE_API,
      text: 'Using the live ezCater API. Real orders arrive here.',
    };
  }
  const host = hostOf(url);
  if (host === EZ_LIVE_HOST) {
    return { env: 'live', label: 'Live', tone: 'ok', host, url, text: 'Using the live ezCater API. Real orders arrive here.' };
  }
  return {
    env: 'sandbox',
    label: 'Sandbox',
    tone: 'warn',
    host: host || null,
    url,
    text: host
      ? 'This venue is talking to ' + host + ', not the live ezCater API. Test orders only.'
      : 'We cannot read that address, so this is not the live ezCater API. Test orders only.',
  };
}

// ----------------------------------------------------------------------------
// Is this connected?
// ----------------------------------------------------------------------------

/** The status object out of any answer the function gives us. Never null. */
export function statusFrom(answer) {
  const s = answer && typeof answer === 'object' ? answer.status : null;
  return s && typeof s === 'object' ? s : { connected: false };
}

/**
 * THE RULE. Connected means the function said connected AND the row is not in
 * an error state.
 *
 * The edge function already sets status to 'error' when the reused subscriber is
 * still pointing at somebody else's webhook, because no order can arrive in that
 * state. Trusting a stray `connected: true` next to that would be exactly the
 * "Back Office says connected while nothing arrives" failure that is called out
 * in the function's own comments.
 */
export function isConnected(status) {
  if (!status || typeof status !== 'object') return false;
  if (status.connected !== true) return false;
  const s = trimText(status.status);
  return s === '' || s === 'connected';
}

/** The name to call this connection in a sentence. Never empty. */
export function connectionName(status) {
  return trimText(status && status.label) || 'your ezCater account';
}

/**
 * One line about where we stand, with a tone for the colour.
 *
 * ok    connected and working
 * warn  we were connected and something is wrong, so no order can arrive
 * off   nothing set up yet
 */
export function statusWords(status) {
  if (!isConnected(status)) {
    const s = trimText(status && status.status);
    if (s === 'error') {
      return {
        tone: 'warn',
        text: 'ezCater is set up but something went wrong, so orders are not arriving. Try "Re-register for orders", and connect again with your API token if that does not fix it.',
      };
    }
    return { tone: 'off', text: 'Not connected to ezCater yet.' };
  }
  const when = whenWords(status.connected_at);
  const name = connectionName(status);
  return { tone: 'ok', text: when ? 'Connected as ' + name + ', since ' + when + '.' : 'Connected as ' + name + '.' };
}

/**
 * True when the answer means "ezCater is not switched on here yet" rather than
 * "that broke": no tables, no migration, or the edge function not deployed.
 *
 * The same test the item matching card uses. The patterns are about a missing
 * table or a missing function, not about which table, so they cover
 * ezcater_connections exactly as they cover ezcater_item_links. One rule, one
 * place, so the two halves of this screen can never disagree about whether
 * ezCater exists.
 */
export function isSetupOff(err) {
  return isMatchingOff(err);
}

// ----------------------------------------------------------------------------
// Errors, in words
// ----------------------------------------------------------------------------

// Anything that smells like a machine talking. A message matching this is
// summarised rather than shown.
const CODEY = /\b(?:PGRST\d+|42P\d\d|42703|23\d{3})\b|\b\d{3}\b|non-2xx|status code|violates|constraint|null value|syntax error|graphql|\bjson\b|\{|\}|<|>/i;

const GENERIC = 'We could not finish that. Nothing was changed. Try again in a moment.';

/**
 * One sentence an operator can act on. NEVER a raw code, and never the token.
 *
 * The token cannot reach here: the edge function's own failure text for a bad
 * token is "ezCater rejected the token: <what ezCater said>", which carries
 * ezCater's words and not ours, and this function replaces that whole sentence
 * anyway.
 */
export function errorWords(err) {
  const code = trimText(err && err.code);
  const raw = textOf(err && err.message ? err.message : typeof err === 'string' ? err : '');
  const low = raw.toLowerCase();

  // Not switched on yet is not a failure, and must never read like one.
  if (isSetupOff(err)) return 'ezCater is not switched on for this venue yet.';

  if (code === 'schema_mismatch' || /their system does not have/.test(low)) {
    return 'We asked ezCater for something their system does not have. That is our bug, not your setup, and nothing was changed.';
  }
  if (code === 'feature_not_enabled' || /feature_not_enabled|has not enabled this feature|not enabled for your brand/.test(low)) {
    return 'ezCater has not switched this on for your account. Ask ezCater to enable it, then try again.';
  }
  if (/rejected the token|ezcater rejected/.test(low)) {
    return 'ezCater did not accept that API token. Check you copied the whole token from the Partner Portal, then try again.';
  }
  if (/no access to this location/.test(low)) return 'You do not have access to this venue.';
  if (/unauthorized|invalid token|jwt|not signed in/.test(low)) {
    return 'Your Back Office sign in has expired. Sign in again, then try once more.';
  }
  if (/not connected/.test(low)) return 'ezCater is not connected yet. Paste your API token above first.';
  if (/api_token required/.test(low)) return 'Paste your ezCater API token first.';
  if (/caterer_uuid required/.test(low)) return 'We could not tell which ezCater location that was. Press Refresh list and try again.';
  if (/failed to fetch|network|timeout|offline/.test(low)) {
    return 'We could not reach the server. Check the connection and try again.';
  }
  if (!raw) return GENERIC;

  // Anything left that reads like a sentence a person wrote is shown as it is.
  // Anything that reads like a machine is summarised, because a Postgres code
  // on a settings screen tells an operator nothing they can do.
  if (raw.length <= 160 && raw.includes(' ') && !CODEY.test(raw)) {
    return /[.!?]$/.test(raw) ? raw : raw + '.';
  }
  return GENERIC;
}

// ----------------------------------------------------------------------------
// Caterers
// ----------------------------------------------------------------------------
//
// A caterer is an ezCater location. One API user can see many, and a caterer is
// what maps to one ServOS venue. Three states matter on this screen:
//
//   here      mapped to the venue Back Office is showing. Orders come to us.
//   unmapped  ezCater knows about it, or the webhook has seen it, and nobody
//             has claimed it. This is the one the operator has to act on.
//   other     mapped to a different venue. Shown so nobody wonders where it
//             went, never actionable from here.

export const UNNAMED_CATERER = 'Unnamed caterer';

const WHERE_TEXT = {
  here: 'Orders come to this venue',
  unmapped: 'Not set up yet',
  other: 'Set up on another venue',
};

const WHERE_ORDER = { here: 0, unmapped: 1, other: 2 };

function shapeCaterer(raw, locationId) {
  const uuid = trimText(raw.caterer_uuid !== undefined ? raw.caterer_uuid : raw.catererUuid);
  if (!uuid) return null;
  const rowLoc = trimText(raw.location_id !== undefined ? raw.location_id : raw.locationId) || null;
  const mine = !!rowLoc && !!trimText(locationId) && rowLoc === trimText(locationId);
  const where = mine ? 'here' : (rowLoc ? 'other' : 'unmapped');
  const name = trimText(raw.caterer_name !== undefined ? raw.caterer_name : raw.catererName)
    || trimText(raw.brand_name !== undefined ? raw.brand_name : raw.brandName)
    || UNNAMED_CATERER;
  return {
    catererUuid: uuid,
    name,
    named: name !== UNNAMED_CATERER,
    locationId: rowLoc,
    where,
    whereText: WHERE_TEXT[where],
    mapped: where === 'here',
    // The DB defaults, so a caterer the connect answer describes (which carries
    // neither column) reads the same as the row that is about to be written.
    autoAccept: (raw.auto_accept !== undefined ? raw.auto_accept : raw.autoAccept) === true,
    active: raw.active !== false,
    currency: trimText(raw.currency) || null,
    firstSeenAt: trimText(raw.first_seen_at !== undefined ? raw.first_seen_at : raw.firstSeenAt) || null,
    mappedAt: trimText(raw.mapped_at !== undefined ? raw.mapped_at : raw.mappedAt) || null,
  };
}

/**
 * Every caterer worth showing, from any answer the function gives us.
 *
 * status answers { caterers, unmapped }, list_caterers answers every caterer on
 * the connection in one list, and connect_token answers what the token could
 * see with no mapping on it at all. All three go through here so the screen has
 * one shape to render and the same row can never appear twice.
 */
export function catererRows(answer, locationId) {
  const lists = [];
  if (Array.isArray(answer)) lists.push(answer);
  else if (answer && typeof answer === 'object') {
    if (Array.isArray(answer.caterers)) lists.push(answer.caterers);
    if (Array.isArray(answer.unmapped)) lists.push(answer.unmapped);
  }

  const byUuid = new Map();
  for (const list of lists) {
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const row = shapeCaterer(raw, locationId);
      if (!row) continue;
      const prev = byUuid.get(row.catererUuid);
      // The row that knows the most wins: mapped here beats mapped elsewhere
      // beats not mapped, and a real name beats the placeholder. The same
      // caterer must never appear twice in the list, whichever answer it came
      // from.
      const better = !prev
        || WHERE_ORDER[row.where] < WHERE_ORDER[prev.where]
        || (row.where === prev.where && row.named && !prev.named);
      if (better) byUuid.set(row.catererUuid, prev ? { ...prev, ...row } : row);
    }
  }

  return [...byUuid.values()].sort((a, b) => {
    const w = WHERE_ORDER[a.where] - WHERE_ORDER[b.where];
    if (w) return w;
    const n = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    if (n) return n;
    return a.catererUuid.localeCompare(b.catererUuid);
  });
}

/** Just the rows in one state, in the order catererRows put them. */
export const caterersWhere = (rows, where) => (rows || []).filter((r) => r && r.where === where);

/** The line above the list, in plain words. */
export function catererLine(rows) {
  const list = rows || [];
  if (!list.length) return 'No ezCater locations yet. Press Refresh list to ask ezCater again.';
  const here = list.filter((r) => r.where === 'here').length;
  if (!here) return 'No ezCater location sends orders to this venue yet. Pick one below.';
  return here === 1
    ? 'One ezCater location sends its orders to this venue.'
    : here + ' ezCater locations send their orders to this venue.';
}

// ----------------------------------------------------------------------------
// Payload builders, camelCase in, snake_case out
// ----------------------------------------------------------------------------

/**
 * The connect_token body, or an error to show instead.
 *
 * The token is trimmed and handed on. It is never returned in the error, never
 * logged and never kept.
 */
export function connectBody({ token, label, apiUrl } = {}) {
  const apiToken = trimToken(token);
  if (!apiToken) return { error: 'Paste the API token ezCater gave you first.' };
  const url = validateApiUrl(apiUrl);
  if (url.error) return { error: url.error };
  const body = { api_token: apiToken, label: trimText(label) || null };
  // Only sent when there is one. A null would ask the edge function to write a
  // column that may not exist yet, for no gain.
  if (url.value) body.api_url = url.value;
  return { body };
}

/** map_caterer. The placeholder name is never written to the DB as a real name. */
export function mapBody({ catererUuid, name } = {}) {
  const uuid = trimText(catererUuid);
  if (!uuid) return { error: 'We could not tell which ezCater location that was. Press Refresh list and try again.' };
  const clean = trimText(name);
  return { body: { caterer_uuid: uuid, caterer_name: clean && clean !== UNNAMED_CATERER ? clean : null } };
}

/** unmap_caterer. */
export function unmapBody({ catererUuid } = {}) {
  const uuid = trimText(catererUuid);
  if (!uuid) return { error: 'We could not tell which ezCater location that was. Press Refresh list and try again.' };
  return { body: { caterer_uuid: uuid } };
}

/**
 * set_policy. Only the keys actually being changed are sent: the edge function
 * writes a patch, and sending a key with a stale value would quietly overwrite
 * somebody else's change.
 */
export function policyPayload(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  const uuid = trimText(patch.catererUuid);
  if (uuid) out.caterer_uuid = uuid;
  if (typeof patch.autoAccept === 'boolean') out.auto_accept = patch.autoAccept;
  if (typeof patch.active === 'boolean') out.active = patch.active;
  if (typeof patch.acceptEnabled === 'boolean') out.accept_enabled = patch.acceptEnabled;
  if (typeof patch.menusEnabled === 'boolean') out.menus_enabled = patch.menusEnabled;
  return out;
}

// ----------------------------------------------------------------------------
// The switches, and what each one really means
// ----------------------------------------------------------------------------
//
// accept_enabled is RECORDED, never inferred. ezCater gate order accept and
// reject per brand and there is no call that reports it, so the only honest
// source is what ezCater told the operator in writing.

export const SWITCH_HELP = {
  autoAccept: 'New ezCater orders go straight to the kitchen. Leave this off and staff accept each order themselves.',
  active: 'Turn this off to stop taking orders for this ezCater location without disconnecting.',
  acceptEnabled: 'Tick this only if ezCater have told you in writing that accept and reject are switched on for your account. We cannot find that out ourselves.',
};

/** Whether the three-state feature gate is on, off, or never answered. */
export function gateWords(value) {
  if (value === true) return 'ezCater have switched accept and reject on for this account.';
  if (value === false) return 'ezCater have not switched accept and reject on. Staff accept orders in the ezCater Partner Portal.';
  return 'Nobody has said yet whether ezCater switched accept and reject on for this account.';
}
