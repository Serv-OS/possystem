// requestAlerts.test.js: booking request alerts on every host stand screen (17 Oct 2026, v5.11.73).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requestAlert } from './requestAlerts.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const req = (id, over = {}) => ({ id, name: `Guest ${id}`, party: 10, ...over });

test('the first load raises nothing; a new request raises one alert and stays New', () => {
  let s = requestAlert({ res: { ok: true, rows: [req('a')] } });
  assert.equal(s.toast, null);
  assert.deepEqual([...s.unseen], []);
  s = requestAlert({ ...s, res: { ok: true, rows: [req('a'), req('b', { name: 'Freya Lennox', party: 12 })] } });
  assert.equal(s.toast, 'New booking request: Freya Lennox, party of 12');
  assert.deepEqual([...s.unseen], ['b']);
  // The next poll with nothing new: no second alert, still New.
  s = requestAlert({ ...s, res: { ok: true, rows: [req('a'), req('b')] } });
  assert.equal(s.toast, null);
  assert.deepEqual([...s.unseen], ['b']);
});

test('several at once are counted; answered ones stop being New; a failed poll changes nothing', () => {
  let s = requestAlert({ res: { ok: true, rows: [] } });
  s = requestAlert({ ...s, res: { ok: true, rows: [req('a'), req('b')] } });
  assert.equal(s.toast, '2 new booking requests');
  const before = s;
  s = requestAlert({ ...s, res: { ok: false, error: 'offline' } });
  assert.equal(s.seen, before.seen);
  assert.equal(s.toast, null);
  assert.deepEqual([...s.unseen].sort(), ['a', 'b']);
  // After the failure, the same two are not raised again.
  s = requestAlert({ ...s, res: { ok: true, rows: [req('a'), req('b')] } });
  assert.equal(s.toast, null);
  // 'a' accepted elsewhere: gone from the list, gone from New.
  s = requestAlert({ ...s, res: { ok: true, rows: [req('b')] } });
  assert.deepEqual([...s.unseen], ['b']);
});

test('a failed first load does not count as seen, so nothing is raised when it comes back', () => {
  let s = requestAlert({ res: { ok: false, error: 'not deployed', notDeployed: true } });
  assert.equal(s.seen, null);
  s = requestAlert({ ...s, res: { ok: true, rows: [req('a')] } });
  assert.equal(s.toast, null, 'what was already waiting is shown by the count, not raised');
});

test('the inbox lives in the top bar of the stand, on every screen, and only there', () => {
  const shell = read('../../surfaces/bookings/BookingsSurface.jsx');
  assert.match(shell, /import RequestsInbox from '\.\/RequestsInbox\.jsx';/);
  const bar = shell.slice(shell.indexOf('{/* top bar */}'), shell.indexOf('{/* screens'));
  assert.match(bar, /<RequestsInbox bar \/>/, 'in the top bar, outside every screen pane');
  // One poller: the Timeline header no longer mounts its own copy.
  assert.doesNotMatch(read('../../surfaces/bookings/DiaryScreen.jsx'), /<RequestsInbox/);
  const inbox = read('../../surfaces/bookings/RequestsInbox.jsx');
  assert.match(inbox, /requestAlert\(/);
  assert.match(inbox, /setUnseen\(new Set\(\)\)/, 'opening the inbox clears New');
});
