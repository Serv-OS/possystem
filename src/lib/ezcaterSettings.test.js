/**
 * ezcaterSettings.test.js - the rules behind the Back Office ezCater
 * "Connect ezCater" screen. Run: `npm test`, or
 * `node --test src/lib/ezcaterSettings.test.js`.
 *
 * The screen itself is a shell. Everything that can be wrong lives here:
 *
 *   1. the token: trimmed, sent, and never anywhere else
 *   2. the API address: live, sandbox, and http refused on both sides
 *   3. "is this connected", which must never say yes while orders cannot arrive
 *   4. status to words, and errors to words that never carry a raw code
 *   5. caterer row shaping: here, unmapped, elsewhere, deduped and ordered
 *   6. the payload builders, camelCase in and snake_case out
 *   7. source checks: every action the screen sends is one the edge function
 *      implements, the screen is actually rendered, and the api_url column is
 *      read defensively so nothing breaks before the migration is run
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  EZ_LIVE_API, EZ_LIVE_HOST, UNNAMED_CATERER, SWITCH_HELP,
  trimText, trimToken, whenWords,
  validateApiUrl, apiEnvironment,
  statusFrom, isConnected, connectionName, statusWords, isSetupOff, errorWords,
  catererRows, caterersWhere, catererLine,
  connectBody, mapBody, unmapBody, policyPayload, gateWords,
} from './ezcaterSettings.js';

import { resolveEzcaterApi, isSandboxApi, EZCATER_API } from '../../supabase/functions/_shared/ezcater.ts';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

const LIB = read('./ezcater.js');
const SETTINGS = read('./ezcaterSettings.js');
const SCREEN = read('../backoffice/sections/EzcaterSettings.jsx');
const HUBRISE = read('../backoffice/sections/HubRise.jsx');
const CONNECT_FN = read('../../supabase/functions/ezcater-connect/index.ts');
const WEBHOOK_FN = read('../../supabase/functions/ezcater-webhook/index.ts');
const SHARED = read('../../supabase/functions/_shared/ezcater.ts');
const MIGRATION = read('../../supabase/migrations/20260917_OPS_ezcater_api_url.sql');

const LOC = 'loc-1';

// ---------------------------------------------------------------------------
// 1. the token
// ---------------------------------------------------------------------------

test('a pasted token is trimmed, because a trailing newline is a silent 401', () => {
  assert.equal(trimToken('  ez_live_abc123\n'), 'ez_live_abc123');
  assert.equal(trimToken('\tez_live_abc123  '), 'ez_live_abc123');
  assert.equal(trimToken('ez_live_abc123'), 'ez_live_abc123');
});

test('trimToken never throws on whatever the box hands it', () => {
  for (const junk of [null, undefined, '', '   ', 0, {}, [], () => {}]) {
    assert.equal(typeof trimToken(junk), 'string');
  }
  assert.equal(trimToken(null), '');
  assert.equal(trimToken({}), '');
});

test('connectBody refuses an empty token without naming anything secret', () => {
  const out = connectBody({ token: '   ', label: 'Main kitchen' });
  assert.equal(out.body, undefined);
  assert.match(out.error, /Paste the API token/);
});

test('connectBody builds the snake_case payload the function reads', () => {
  const { body, error } = connectBody({ token: '  tok-123 ', label: '  Main kitchen  ' });
  assert.equal(error, undefined);
  assert.deepEqual(body, { api_token: 'tok-123', label: 'Main kitchen' });
});

test('connectBody sends no label rather than an empty one', () => {
  assert.equal(connectBody({ token: 'tok-123', label: '   ' }).body.label, null);
  assert.equal(connectBody({ token: 'tok-123' }).body.label, null);
});

test('THE TOKEN IS NEVER IN AN ERROR, whatever is wrong', () => {
  const TOKEN = 'ez_live_supersecret';
  const built = connectBody({ token: TOKEN, apiUrl: 'http://sandbox.example.com/graphql' });
  assert.ok(built.error, 'an http address must be refused');
  assert.equal(built.error.includes(TOKEN), false);
  // And the same for every message the screen can show.
  for (const e of [{ message: 'ezCater rejected the token: ' + TOKEN }, { code: 'schema_mismatch' }, { message: 'Unauthorized' }]) {
    assert.equal(errorWords(e).includes(TOKEN), false, JSON.stringify(e));
  }
});

// ---------------------------------------------------------------------------
// 2. the API address: live, sandbox, and http
// ---------------------------------------------------------------------------

test('empty means the LIVE ezCater API, which is what everyone had before', () => {
  const env = apiEnvironment('');
  assert.equal(env.env, 'live');
  assert.equal(env.label, 'Live');
  assert.equal(env.tone, 'ok');
  assert.equal(env.host, EZ_LIVE_HOST);
  assert.equal(apiEnvironment(null).env, 'live');
  assert.equal(apiEnvironment(undefined).env, 'live');
  assert.equal(EZ_LIVE_API, EZCATER_API, 'the browser and the edge function must agree on the live address');
});

test('the published address is Live, on any path or port spelling', () => {
  assert.equal(apiEnvironment('https://api.ezcater.com/graphql').env, 'live');
  assert.equal(apiEnvironment('  https://API.EZCATER.COM/graphql  ').env, 'live');
  assert.equal(apiEnvironment('https://api.ezcater.com/graphql').tone, 'ok');
});

test('ANY other host is Sandbox, in amber, and says so', () => {
  const sandbox = apiEnvironment('https://api-sandbox.ezcater.com/graphql');
  assert.equal(sandbox.env, 'sandbox');
  assert.equal(sandbox.label, 'Sandbox');
  assert.equal(sandbox.tone, 'warn');
  assert.equal(sandbox.host, 'api-sandbox.ezcater.com');
  assert.match(sandbox.text, /api-sandbox\.ezcater\.com/);
  assert.match(sandbox.text, /Test orders only/);
  // An unknown host nobody has seen before is sandbox too. Guessing the other
  // way would leave a test connection sitting in Back Office looking live.
  const unknown = apiEnvironment('https://graphql.someone-else.example/api');
  assert.equal(unknown.env, 'sandbox');
  assert.equal(unknown.tone, 'warn');
  assert.equal(unknown.host, 'graphql.someone-else.example');
  // And so is an address we cannot even parse.
  const junk = apiEnvironment('not a url at all');
  assert.equal(junk.env, 'sandbox');
  assert.equal(junk.host, null);
});

test('an http address is REFUSED, because the token rides on every call', () => {
  const out = validateApiUrl('http://api-sandbox.ezcater.com/graphql');
  assert.equal(out.value, null);
  assert.match(out.error, /https/);
  // Every other way of not being https.
  for (const bad of ['ftp://x.example/graphql', 'api.ezcater.com/graphql', 'javascript:alert(1)', 'http://localhost:3000']) {
    assert.ok(validateApiUrl(bad).error, bad + ' must be refused');
    assert.equal(validateApiUrl(bad).value, null);
  }
});

test('validateApiUrl passes an https address through, and empty means live', () => {
  assert.deepEqual(validateApiUrl('  https://api-sandbox.ezcater.com/graphql '), { value: 'https://api-sandbox.ezcater.com/graphql', error: null });
  assert.deepEqual(validateApiUrl(''), { value: null, error: null });
  assert.deepEqual(validateApiUrl(null), { value: null, error: null });
});

test('connectBody only sends api_url when the operator typed one', () => {
  assert.equal('api_url' in connectBody({ token: 't' }).body, false, 'a null would ask for a column that may not exist yet');
  assert.equal('api_url' in connectBody({ token: 't', apiUrl: '   ' }).body, false);
  assert.equal(connectBody({ token: 't', apiUrl: 'https://s.example/graphql' }).body.api_url, 'https://s.example/graphql');
  // A bad address stops the whole connect rather than quietly going live.
  assert.match(connectBody({ token: 't', apiUrl: 'http://s.example/graphql' }).error, /https/);
});

test('THE EDGE FUNCTION AGREES: null is live, https passes, anything else throws', () => {
  assert.equal(resolveEzcaterApi(null), EZCATER_API);
  assert.equal(resolveEzcaterApi(undefined), EZCATER_API);
  assert.equal(resolveEzcaterApi('  '), EZCATER_API, 'a missing api_url column reads as undefined, and that is live');
  assert.equal(resolveEzcaterApi('https://api-sandbox.ezcater.com/graphql'), 'https://api-sandbox.ezcater.com/graphql');
  assert.throws(() => resolveEzcaterApi('http://api-sandbox.ezcater.com/graphql'), /https/);
  assert.throws(() => resolveEzcaterApi('nonsense'), /address/);
  // It must never fall back to production on a bad value: a sandbox token
  // pointed at the live API is exactly the mistake this whole column prevents.
  assert.throws(() => resolveEzcaterApi('http://x.example'), /https/);
});

test('the edge function knows a sandbox connection when it sees one', () => {
  assert.equal(isSandboxApi(null), false);
  assert.equal(isSandboxApi(''), false);
  assert.equal(isSandboxApi('https://api.ezcater.com/graphql'), false);
  assert.equal(isSandboxApi('https://api-sandbox.ezcater.com/graphql'), true);
  assert.equal(isSandboxApi('rubbish'), true);
});

// ---------------------------------------------------------------------------
// 3. is this connected
// ---------------------------------------------------------------------------

test('connected means the function said connected AND nothing is wrong', () => {
  assert.equal(isConnected({ connected: true, status: 'connected' }), true);
  assert.equal(isConnected({ connected: true }), true, 'an older answer with no status string is still connected');
});

test('isConnected says no to every not-connected shape', () => {
  assert.equal(isConnected(null), false);
  assert.equal(isConnected(undefined), false);
  assert.equal(isConnected({}), false);
  assert.equal(isConnected({ connected: false }), false);
  assert.equal(isConnected('yes'), false);
  assert.equal(isConnected({ connected: 'true' }), false, 'a string is not a yes');
  assert.equal(isConnected({ connected: 1 }), false);
});

test('A CONNECTION IN ERROR IS NOT CONNECTED, because no order can arrive', () => {
  // The edge function sets status error when the reused subscriber is still
  // pointing at somebody else's webhook. Back Office saying "Connected" over
  // the top of that is the exact failure the function warns about.
  assert.equal(isConnected({ connected: true, status: 'error' }), false);
  assert.equal(isConnected({ connected: true, status: 'disconnected' }), false);
});

test('statusFrom never hands the screen a null to render', () => {
  assert.deepEqual(statusFrom(null), { connected: false });
  assert.deepEqual(statusFrom({}), { connected: false });
  assert.deepEqual(statusFrom({ status: 'nonsense' }), { connected: false });
  assert.deepEqual(statusFrom({ status: { connected: true } }), { connected: true });
});

// ---------------------------------------------------------------------------
// 4. words
// ---------------------------------------------------------------------------

test('statusWords: not set up, working, and gone wrong', () => {
  assert.deepEqual(statusWords(null), { tone: 'off', text: 'Not connected to ezCater yet.' });
  assert.equal(statusWords({ connected: false }).tone, 'off');

  const ok = statusWords({ connected: true, status: 'connected', label: 'Main kitchen', connected_at: '2026-09-17T10:00:00Z' });
  assert.equal(ok.tone, 'ok');
  assert.match(ok.text, /^Connected as Main kitchen, since /);

  const bad = statusWords({ connected: false, status: 'error' });
  assert.equal(bad.tone, 'warn');
  assert.match(bad.text, /orders are not arriving/i);
});

test('an unnamed connection still reads as a sentence', () => {
  assert.equal(connectionName({}), 'your ezCater account');
  assert.equal(connectionName({ label: '  ' }), 'your ezCater account');
  assert.equal(connectionName({ label: ' Main kitchen ' }), 'Main kitchen');
  assert.equal(statusWords({ connected: true }).text, 'Connected as your ezCater account.');
});

test('whenWords shows a date, or nothing at all, never "Invalid Date"', () => {
  assert.equal(whenWords(null), '');
  assert.equal(whenWords(''), '');
  assert.equal(whenWords('not a date'), '');
  assert.ok(whenWords('2026-09-17T10:00:00Z').length > 0);
});

test('gateWords tells on, off and never answered apart', () => {
  assert.match(gateWords(true), /have switched accept and reject on/);
  assert.match(gateWords(false), /Partner Portal/);
  assert.match(gateWords(null), /Nobody has said yet/);
  assert.match(gateWords(undefined), /Nobody has said yet/);
});

test('every switch carries a plain line saying what it really does', () => {
  for (const key of ['autoAccept', 'active', 'acceptEnabled']) {
    assert.equal(typeof SWITCH_HELP[key], 'string');
    assert.ok(SWITCH_HELP[key].length > 20, key + ' needs a real sentence');
  }
  // accept_enabled is RECORDED, never inferred, and the help line has to say so.
  assert.match(SWITCH_HELP.acceptEnabled, /in writing/);
});

// ---------------------------------------------------------------------------
// 5. errors, in words
// ---------------------------------------------------------------------------

test('"not switched on yet" is never dressed up as a failure', () => {
  assert.equal(isSetupOff({ code: 'PGRST205' }), true);
  assert.equal(isSetupOff({ message: 'relation "public.ezcater_connections" does not exist' }), true);
  assert.equal(isSetupOff({ message: 'Failed to send a request to the Edge Function' }), true);
  assert.match(errorWords({ code: 'PGRST205' }), /not switched on/);
});

test('isSetupOff does NOT swallow a real failure', () => {
  assert.equal(isSetupOff(null), false);
  assert.equal(isSetupOff({ message: 'No access to this location' }), false);
  assert.equal(isSetupOff({ message: 'ezCater rejected the token: unauthorized' }), false);
});

test('errorWords turns the failures an operator will really hit into plain words', () => {
  assert.match(errorWords({ code: 'schema_mismatch' }), /our bug/);
  assert.match(errorWords({ code: 'feature_not_enabled' }), /Ask ezCater/);
  assert.match(errorWords({ message: 'ezCater has not enabled this feature for your brand. Contact integrations@ezcater.com.' }), /Ask ezCater/);
  assert.match(errorWords({ message: 'ezCater rejected the token: 401 unauthorized' }), /did not accept that API token/);
  assert.match(errorWords({ message: 'No access to this location' }), /do not have access/);
  assert.match(errorWords({ message: 'Invalid token' }), /sign in has expired/i);
  assert.match(errorWords({ message: 'not connected' }), /not connected yet/);
  assert.match(errorWords({ message: 'Failed to fetch' }), /could not reach the server/);
});

test('A RAW CODE NEVER REACHES THE SCREEN', () => {
  const codey = [
    { code: '23505', message: 'duplicate key value violates unique constraint "ezcater_caterers_pkey"' },
    { message: 'Edge Function returned a non-2xx status code' },
    { message: 'column "api_url" of relation "ezcater_connections" does not exist' },
    { message: '{"error":"boom","code":500}' },
    { message: 'null value in column "location_id" violates not-null constraint' },
  ];
  for (const e of codey) {
    const words = errorWords(e);
    assert.equal(/PGRST|non-2xx|violates|constraint|\{|\}/.test(words), false, 'leaked: ' + words);
    assert.ok(words.length > 10, 'still has to say something');
  }
});

test('a sentence a person wrote is shown as it is, with a full stop', () => {
  assert.equal(errorWords({ message: 'that item is not on this menu' }), 'that item is not on this menu.');
  assert.equal(errorWords({ message: 'Nothing was changed.' }), 'Nothing was changed.');
  assert.ok(errorWords(null).length > 10, 'even nothing at all gets a sentence');
  assert.ok(errorWords({}).length > 10);
});

// ---------------------------------------------------------------------------
// 6. caterer rows
// ---------------------------------------------------------------------------

const STATUS_ANSWER = {
  ok: true,
  status: { connected: true, status: 'connected', label: 'Main kitchen' },
  caterers: [
    { caterer_uuid: 'cat-here', caterer_name: 'Downtown Kitchen', location_id: LOC, auto_accept: true, active: true, mapped_at: '2026-09-17T09:00:00Z' },
  ],
  unmapped: [
    { caterer_uuid: 'cat-new', caterer_name: 'Airport Kitchen', location_id: null, first_seen_at: '2026-09-17T08:00:00Z' },
  ],
};

test('the status answer becomes rows the screen can render, in one shape', () => {
  const rows = catererRows(STATUS_ANSWER, LOC);
  assert.equal(rows.length, 2);
  const [mine, theirs] = rows;

  assert.equal(mine.catererUuid, 'cat-here');
  assert.equal(mine.name, 'Downtown Kitchen');
  assert.equal(mine.where, 'here');
  assert.equal(mine.mapped, true);
  assert.equal(mine.whereText, 'Orders come to this venue');
  assert.equal(mine.autoAccept, true);
  assert.equal(mine.active, true);

  assert.equal(theirs.where, 'unmapped');
  assert.equal(theirs.mapped, false);
  assert.equal(theirs.whereText, 'Not set up yet');
  // The DB defaults, so the row reads the same before and after it is written.
  assert.equal(theirs.autoAccept, false);
  assert.equal(theirs.active, true);
});

test('mapped here, unmapped, then somebody else, in that order', () => {
  const rows = catererRows({
    caterers: [
      { caterer_uuid: 'c-other', caterer_name: 'Zebra', location_id: 'loc-2' },
      { caterer_uuid: 'c-mine', caterer_name: 'Yankee', location_id: LOC },
      { caterer_uuid: 'c-free-b', caterer_name: 'Bravo' },
      { caterer_uuid: 'c-free-a', caterer_name: 'Alpha' },
    ],
  }, LOC);
  assert.deepEqual(rows.map((r) => r.where), ['here', 'unmapped', 'unmapped', 'other']);
  // Inside a group, by name, so the list does not reshuffle on every refresh.
  assert.deepEqual(rows.map((r) => r.name), ['Yankee', 'Alpha', 'Bravo', 'Zebra']);
  assert.equal(caterersWhere(rows, 'here').length, 1);
  assert.equal(caterersWhere(rows, 'unmapped').length, 2);
  assert.equal(caterersWhere(rows, 'other').length, 1);
});

test('the same caterer never appears twice, and the row that knows more wins', () => {
  const rows = catererRows({
    // list_caterers answers every caterer on the connection, so the mapped one
    // can arrive again from a second source in the same render.
    caterers: [{ caterer_uuid: 'cat-1', caterer_name: 'Downtown', location_id: LOC, auto_accept: true }],
    unmapped: [{ caterer_uuid: 'cat-1', caterer_name: null }],
  }, LOC);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].where, 'here');
  assert.equal(rows[0].name, 'Downtown');
  assert.equal(rows[0].autoAccept, true);
});

test('a caterer with no name is still listed, and never written back as one', () => {
  const rows = catererRows([{ caterer_uuid: 'cat-x' }], LOC);
  assert.equal(rows[0].name, UNNAMED_CATERER);
  assert.equal(rows[0].named, false);
  // The placeholder is ours, so it must not travel to the DB as a real name.
  assert.equal(mapBody({ catererUuid: 'cat-x', name: UNNAMED_CATERER }).body.caterer_name, null);
  // brand_name is the fallback when there is one.
  assert.equal(catererRows([{ caterer_uuid: 'c', brand_name: 'Big Brand' }], LOC)[0].name, 'Big Brand');
});

test('catererRows survives every shape the function can answer with', () => {
  assert.deepEqual(catererRows(null, LOC), []);
  assert.deepEqual(catererRows({}, LOC), []);
  assert.deepEqual(catererRows({ caterers: null }, LOC), []);
  assert.deepEqual(catererRows({ caterers: [null, 'nope', {}, { caterer_uuid: '  ' }] }, LOC), []);
  // connect_token answers uuid/name only, with no mapping at all.
  const fresh = catererRows({ caterers: [{ caterer_uuid: 'c1', caterer_name: 'New', store_number: '7', live: true }] }, LOC);
  assert.equal(fresh[0].where, 'unmapped');
});

test('a row cannot be "here" for a venue we do not know', () => {
  // A blank locationId must never make an unmapped caterer look adopted.
  const rows = catererRows({ caterers: [{ caterer_uuid: 'c1', location_id: null }] }, '');
  assert.equal(rows[0].where, 'unmapped');
  assert.equal(catererRows({ caterers: [{ caterer_uuid: 'c1', location_id: 'loc-2' }] }, '')[0].where, 'other');
});

test('the line above the list counts what is really wired up', () => {
  assert.match(catererLine([]), /No ezCater locations yet/);
  assert.match(catererLine(catererRows({ unmapped: [{ caterer_uuid: 'c1' }] }, LOC)), /Pick one below/);
  assert.match(catererLine(catererRows(STATUS_ANSWER, LOC)), /^One ezCater location sends/);
  const two = catererRows({ caterers: [{ caterer_uuid: 'a', location_id: LOC }, { caterer_uuid: 'b', location_id: LOC }] }, LOC);
  assert.match(catererLine(two), /^2 ezCater locations send/);
});

// ---------------------------------------------------------------------------
// 7. payload builders
// ---------------------------------------------------------------------------

test('map and unmap send the caterer uuid, or refuse in plain words', () => {
  assert.deepEqual(mapBody({ catererUuid: ' cat-1 ', name: 'Downtown' }).body, { caterer_uuid: 'cat-1', caterer_name: 'Downtown' });
  assert.deepEqual(unmapBody({ catererUuid: 'cat-1' }).body, { caterer_uuid: 'cat-1' });
  for (const bad of [{}, { catererUuid: '' }, { catererUuid: '   ' }, undefined]) {
    assert.ok(mapBody(bad).error, 'map must refuse ' + JSON.stringify(bad));
    assert.ok(unmapBody(bad).error, 'unmap must refuse ' + JSON.stringify(bad));
  }
});

test('policyPayload sends ONLY what is being changed', () => {
  // set_policy writes a patch. A key carrying a stale value would overwrite
  // somebody else's change on the next tick of a switch.
  assert.deepEqual(policyPayload({ catererUuid: 'cat-1', autoAccept: true }), { caterer_uuid: 'cat-1', auto_accept: true });
  assert.deepEqual(policyPayload({ catererUuid: 'cat-1', active: false }), { caterer_uuid: 'cat-1', active: false });
  assert.deepEqual(policyPayload({ acceptEnabled: true }), { accept_enabled: true });
  assert.deepEqual(policyPayload({ menusEnabled: false }), { menus_enabled: false });
  assert.deepEqual(policyPayload({}), {});
  assert.deepEqual(policyPayload(null), {});
  // Off is a real value and must survive. Anything that is not a boolean is not.
  assert.deepEqual(policyPayload({ autoAccept: false }), { auto_accept: false });
  assert.deepEqual(policyPayload({ autoAccept: 'yes', active: 1 }), {});
});

test('camelCase in, snake_case out, every time', () => {
  const keys = [
    ...Object.keys(policyPayload({ catererUuid: 'c', autoAccept: true, active: true, acceptEnabled: true, menusEnabled: true })),
    ...Object.keys(connectBody({ token: 't', label: 'l', apiUrl: 'https://s.example/g' }).body),
    ...Object.keys(mapBody({ catererUuid: 'c', name: 'n' }).body),
  ];
  for (const k of keys) assert.match(k, /^[a-z][a-z0-9_]*$/, k + ' is not snake_case');
  assert.equal(trimText(' a '), 'a');
});

// ---------------------------------------------------------------------------
// 8. source checks
// ---------------------------------------------------------------------------

const actionsSent = [...LIB.matchAll(/action:\s*'([a-z_]+)'/g)].map((m) => m[1]);
const actionsImplemented = [...CONNECT_FN.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]);

test('EVERY action the screen sends is one the edge function implements', () => {
  assert.ok(actionsSent.length >= 9, 'expected the whole lifecycle, got ' + actionsSent.join(', '));
  for (const action of actionsSent) {
    assert.ok(actionsImplemented.includes(action), 'ezcater-connect has no case for ' + action);
  }
});

test('the connect and settings lifecycle is actually wired up, not just planned', () => {
  for (const action of ['status', 'connect_token', 'list_caterers', 'map_caterer', 'unmap_caterer', 'set_policy', 'resubscribe', 'disconnect']) {
    assert.ok(actionsSent.includes(action), 'src/lib/ezcater.js never sends ' + action);
  }
});

test('the screen only calls wrappers src/lib/ezcater.js really exports', () => {
  const imported = (SCREEN.match(/import\s*\{([^}]+)\}\s*from\s*'\.\.\/\.\.\/lib\/ezcater'/) || [])[1];
  assert.ok(imported, 'the screen does not import the ezCater client at all');
  const names = imported.split(',').map((s) => s.trim()).filter(Boolean);
  assert.ok(names.length >= 7, 'expected the lifecycle wrappers, got ' + names.join(', '));
  for (const n of names) {
    assert.ok(new RegExp('export const ' + n + '\\b').test(LIB), 'src/lib/ezcater.js does not export ' + n);
  }
});

test('EzcaterSettings is rendered in HubRise.jsx, ABOVE the item matching card', () => {
  assert.match(HUBRISE, /import EzcaterSettings from '\.\/EzcaterSettings'/);
  const settingsAt = HUBRISE.indexOf('<EzcaterSettings');
  const matchingAt = HUBRISE.indexOf('<EzcaterItemMatching');
  assert.ok(settingsAt > 0, 'HubRise.jsx never renders <EzcaterSettings>');
  assert.ok(matchingAt > 0, 'HubRise.jsx no longer renders <EzcaterItemMatching>');
  assert.ok(settingsAt < matchingAt, 'connect comes before matching: you cannot match items for an account you have not connected');
  assert.match(HUBRISE, /<EzcaterSettings locationId=\{locId\} \/>/);
});

test('THE TOKEN IS NEVER STORED OR LOGGED', () => {
  // Three ways a secret leaks by accident, all of them banned outright here.
  // The member access, not the word: both files say in a comment that the token
  // never goes near browser storage, and that sentence is the point.
  assert.equal(/localStorage\.|sessionStorage\.|indexedDB\./.test(SCREEN), false, 'the screen must not store anything');
  assert.equal(/console\./.test(SCREEN), false, 'the screen must not log anything');
  assert.equal(/localStorage\.|console\./.test(SETTINGS), false, 'the pure rules must not store or log anything');
  // And it is dropped from the component as soon as it has been sent.
  assert.match(SCREEN, /setToken\(''\)/);
  // The box is a password box, so it is not shoulder-read or autofilled away.
  assert.match(SCREEN, /type="password"/);
});

test('no dynamic imports in the screen, they die silently in the bundle', () => {
  assert.equal(/import\s*\(/.test(SCREEN), false);
  assert.equal(/import\s*\(/.test(SETTINGS), false);
});

// ---------------------------------------------------------------------------
// 9. the api_url column, before and after the migration
// ---------------------------------------------------------------------------

test('the webhook reads api_url DEFENSIVELY, and works before the migration', () => {
  // Naming a column that is not there fails the WHOLE select, which is the same
  // trap as menu_items.item_code on the matching screen.
  assert.match(WEBHOOK_FN, /select\('id, api_token, api_url'\)/);
  assert.match(WEBHOOK_FN, /select\('id, api_token'\)/, 'there must be a select without the column to fall back to');
  assert.match(WEBHOOK_FN, /getOrder\(token, entityId, conn\?\.api_url \?\? null\)/);
});

test('connect_token names api_url ONLY when the operator typed an address', () => {
  assert.match(CONNECT_FN, /if \(apiUrl\) row\.api_url = apiUrl;/);
  assert.match(CONNECT_FN, /isAbsentColumn\(error, 'api_url'\)/, 'a missing column must be named, not swallowed');
  assert.match(CONNECT_FN, /20260917_OPS_ezcater_api_url\.sql/, 'the error has to say which file fixes it');
  // The connection read stays select('*'), so it never names the column at all.
  assert.match(CONNECT_FN, /from\('ezcater_connections'\)\s*\.select\('\*'\)/);
});

test('the live address is still the default everywhere', () => {
  assert.match(SHARED, /export const EZCATER_API = 'https:\/\/api\.ezcater\.com\/graphql'/);
  assert.match(SHARED, /fetch\(resolveEzcaterApi\(endpoint\)/, 'every call goes through the resolver');
  assert.match(MIGRATION, /add column if not exists api_url text/);
  assert.match(MIGRATION, /tbetcegmszzotrwdtqhi/);
  assert.match(MIGRATION, /Peter runs this by hand/);
  assert.match(MIGRATION, /NULL MEANS THE LIVE API/);
});

test('nothing written for this screen uses an em dash or an en dash', () => {
  // Peter is dyslexic and reads them as noise. A comma or a new sentence, always.
  // Built from escapes so this file passes its own rule.
  const DASHES = new RegExp('[\\u2014\\u2013]');
  const files = [
    ['ezcaterSettings.js', SETTINGS],
    ['EzcaterSettings.jsx', SCREEN],
    ['ezcaterSettings.test.js', read('./ezcaterSettings.test.js')],
    ['the migration', MIGRATION],
  ];
  for (const [name, src] of files) {
    assert.equal(DASHES.test(src), false, name + ' has an em dash or an en dash in it');
  }
});
