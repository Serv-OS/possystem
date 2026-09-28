/**
 * approveError.test.js: the Manager app reads manager-approve's own refusal.
 * Run: `npm test`, or `node --test src/lib/manager/approveError.test.js`.
 *
 * supabase-js answers any non-2xx from an edge function with the same "Edge Function returned a
 * non-2xx status code" and puts the server's { error } in the Response (error.context). Until
 * v5.10.2 the Manager app showed that string for a wrong PIN, so the Team and Kitchen tabs'
 * "wrong PIN: ask again" check (/pin|not allowed|approve/i) never matched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approveErrorMessage } from './approveError.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const httpError = (body) => ({ name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code', context: new Response(JSON.stringify(body), { status: 403 }) });

test('the server\'s own refusal comes through, not the transport message', async () => {
  assert.equal(await approveErrorMessage(httpError({ error: 'PIN not recognised' })), 'PIN not recognised');
  assert.equal(await approveErrorMessage(httpError({ error: 'not allowed to approve' })), 'not allowed to approve');
  assert.equal(await approveErrorMessage(httpError({ error: 'already clocked out' })), 'already clocked out');
  // Every PIN refusal manager-approve can give matches the tabs' ask-again check.
  for (const e of ['PIN not recognised', 'PIN required', 'not allowed to approve']) assert.match(await approveErrorMessage(httpError({ error: e })), /pin|not allowed|approve/i);
});

test('no JSON body, no body, no context: the transport message, never a throw', async () => {
  assert.equal(await approveErrorMessage({ message: 'Edge Function returned a non-2xx status code', context: new Response('<html>', { status: 502 }) }), 'Edge Function returned a non-2xx status code');
  assert.equal(await approveErrorMessage(httpError({})), 'Edge Function returned a non-2xx status code');
  assert.equal(await approveErrorMessage({ message: 'Failed to send a request to the Edge Function' }), 'Failed to send a request to the Edge Function');
  assert.equal(await approveErrorMessage(null), 'Could not save');
});

test('both manager-approve callers in data.js read the server message', () => {
  const src = fs.readFileSync(path.join(here, 'data.js'), 'utf8');
  assert.match(src, /import \{ approveErrorMessage \} from '\.\/approveError\.js';/);
  const calls = src.split("supabase.functions.invoke('manager-approve'").slice(1);
  assert.equal(calls.length, 2, 'managerApprove and managerRaisePO');
  for (const c of calls) {
    const tail = c.slice(0, c.indexOf('return data;'));
    assert.match(tail, /if \(error\) return \{ ok: false, error: await approveErrorMessage\(error\) \};/);
  }
});
