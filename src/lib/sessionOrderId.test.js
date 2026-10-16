// sessionOrderId.test.js: the order id a table is born with (16 Oct 2026, bookings audit item 6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceOrderTag, mintSessionOrderId, makeSessionOrderIdMinter } from './sessionOrderId.js';

const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};
const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

test('the id keeps the ORD- prefix and carries device, time and random parts', () => {
  const id = mintSessionOrderId({ tag: 'k3f9', now: 1792166402226, rand: seq(0.1, 0.2, 0.3, 0.4) });
  assert.match(id, /^ORD-k3f9-[0-9a-z]+-[0-9a-z]{4}$/);
  assert.equal(id.split('-')[2], (1792166402226).toString(36));
});

test('two devices booting at the same moment never mint the same first id (the ORD-1001 bug)', () => {
  const a = mintSessionOrderId({ tag: 'aaaa', now: 1000, rand: seq(0.5) });
  const b = mintSessionOrderId({ tag: 'bbbb', now: 1000, rand: seq(0.5) });
  assert.notEqual(a, b);
});

test('one device minting twice in the same millisecond still differs through the random part', () => {
  const r = seq(0.01, 0.02, 0.03, 0.04, 0.9, 0.8, 0.7, 0.6);
  const a = mintSessionOrderId({ tag: 'aaaa', now: 5, rand: r });
  const b = mintSessionOrderId({ tag: 'aaaa', now: 5, rand: r });
  assert.notEqual(a, b);
});

test('ten thousand ids from one page load are all different, even with the clock frozen', () => {
  const mint = makeSessionOrderIdMinter({ tag: 'test', clock: () => 1792166402226, rand: () => 0.5 });
  const ids = new Set();
  for (let i = 0; i < 10000; i++) ids.add(mint());
  assert.equal(ids.size, 10000);
});

test('a clock that steps backwards never repeats a time part', () => {
  const times = [5000, 4000, 4000, 6000];
  let i = 0;
  const mint = makeSessionOrderIdMinter({ tag: 'test', clock: () => times[i++], rand: () => 0 });
  const parts = [mint(), mint(), mint(), mint()].map((id) => parseInt(id.split('-')[2], 36));
  assert.deepEqual(parts, [5000, 5001, 5002, 6000]);
});

test('the device tag is made once and kept in storage', () => {
  const s = memStorage();
  const first = deviceOrderTag({ storage: s, rand: seq(0.1, 0.2, 0.3, 0.4) });
  assert.match(first, /^[0-9a-z]{4}$/);
  assert.equal(deviceOrderTag({ storage: s, rand: seq(0.9) }), first);
});

test('storage that throws or is missing still gives a tag', () => {
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.match(deviceOrderTag({ storage: broken }), /^[0-9a-z]{4}$/);
  assert.match(deviceOrderTag({ storage: null }), /^[0-9a-z]{4}$/);
});

test('a bad tag is replaced, never written into the id', () => {
  assert.match(mintSessionOrderId({ tag: 'NOT OK!', now: 1 }), /^ORD-[0-9a-z]{4}-1-[0-9a-z]{4}$/);
});
