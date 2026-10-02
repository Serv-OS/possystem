// paxAutoCheck.test.js (30 Sep 2026): the card screen's reader auto check must never fire into a
// live tender. With kickRace.js the screen mounts while the customer is paying, so the 8 s
// 'wedged' check (v5.7.37) is gated behind this pure rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { shouldAutoCheckReader, KICK_SETTLE_LIMIT_MS } from './paxAutoCheck.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const T0 = Date.parse('2026-09-30T11:42:50.400Z');   // Huddersfield: job 97c6176c sent to the reader
const base = { status: 'charging', processor: 'adyen', kickPending: true, dispatchedAt: T0 };

test('the limit is 130 s: past Adyen\'s 120 s cardholder window, with margin', () => {
  assert.equal(KICK_SETTLE_LIMIT_MS, 130_000);
});

test('false while the kick is pending and under 130 s (the customer is paying: PIN, retries, a slow tap)', () => {
  for (const s of [0, 8_000, 17_000, 39_100, 60_000, 119_999, 129_999]) {
    assert.equal(shouldAutoCheckReader({ ...base, now: T0 + s }), false, `${s} ms in`);
    assert.equal(shouldAutoCheckReader({ ...base, status: 'unknown', now: T0 + s }), false, `unknown, ${s} ms in`);
  }
});

test('true at 130 s or more after dispatched_at, even with the kick still out (a tender cannot be live)', () => {
  assert.equal(shouldAutoCheckReader({ ...base, now: T0 + 130_000 }), true);
  assert.equal(shouldAutoCheckReader({ ...base, now: T0 + 300_000 }), true);
  assert.equal(shouldAutoCheckReader({ ...base, status: 'unknown', now: T0 + 130_000 }), true);
});

test('true as soon as the kick has settled (answered or failed): charging now means wedged, as before', () => {
  assert.equal(shouldAutoCheckReader({ ...base, kickPending: false, now: T0 + 1 }), true);
  assert.equal(shouldAutoCheckReader({ ...base, kickPending: false, status: 'unknown', now: T0 }), true);
  assert.equal(shouldAutoCheckReader({ status: 'charging', processor: 'adyen', kickPending: undefined, dispatchedAt: null, now: Date.now() }), true, 'no kick handed over (the server won the claim): the old rule');
});

test('never for a non Adyen job, or a status that is not charging or unknown', () => {
  for (const processor of ['ryft', 'stripe', null, undefined]) {
    assert.equal(shouldAutoCheckReader({ ...base, processor, kickPending: false, now: T0 + 999_999 }), false, String(processor));
  }
  for (const status of ['pending', 'claimed', 'tipping', 'charging_unsent', 'approved', 'reconciled', 'declined', 'cancelled', 'expired']) {
    assert.equal(shouldAutoCheckReader({ ...base, status, kickPending: false, now: T0 + 999_999 }), false, status);
  }
});

test('dispatched_at as an ISO string or a Date works; an unknown time with the kick out never opens the gate', () => {
  assert.equal(shouldAutoCheckReader({ ...base, dispatchedAt: new Date(T0).toISOString(), now: T0 + 130_000 }), true);
  assert.equal(shouldAutoCheckReader({ ...base, dispatchedAt: new Date(T0), now: T0 + 129_000 }), false);
  assert.equal(shouldAutoCheckReader({ ...base, dispatchedAt: null, now: T0 + 999_999 }), false, 'the screen passes a fallback time; no time at all is not a reason to poke the reader');
  assert.equal(shouldAutoCheckReader({ ...base, dispatchedAt: 'garbage', now: T0 }), false);
  assert.equal(shouldAutoCheckReader({ ...base, now: undefined }), false);
  assert.equal(shouldAutoCheckReader(), false);
});

test('both times come from ONE clock: a server dispatched_at read by a till 3 min ahead would open the gate at mount, so the screen never passes one', () => {
  // The rule itself only subtracts; the screen (below) anchors on its own mount time.
  const serverDispatchedAt = T0;
  const skewedTillNow = T0 + 183_000;   // a Sunmi 3 minutes ahead, 3 s after the send
  assert.equal(shouldAutoCheckReader({ ...base, dispatchedAt: serverDispatchedAt, now: skewedTillNow }), true, 'this is the trap the wiring test below forbids');
  const mountedAt = skewedTillNow;
  assert.equal(shouldAutoCheckReader({ ...base, dispatchedAt: mountedAt, now: mountedAt + 129_999 }), false);
  assert.equal(shouldAutoCheckReader({ ...base, dispatchedAt: mountedAt, now: mountedAt + 130_000 }), true);
});

// ── wiring: PaxTerminal ────────────────────────────────────────────────────

test('wiring: PaxTerminal gates the 8 s auto check and the Check card machine button behind the rule', () => {
  const px = read('../../surfaces/PaxTerminal.jsx');
  assert.match(px, /import \{ shouldAutoCheckReader, KICK_SETTLE_LIMIT_MS \} from '\.\.\/lib\/payments\/paxAutoCheck';/);
  assert.match(px, /const wedged = shouldAutoCheckReader\(\{ status, processor, kickPending: kickOpen, dispatchedAt: mountedMs, now: kickClock \}\);/);
  // Review 30 Sep: the anchor is this till's own mount time, never the server's dispatched_at or created_at.
  assert.ok(px.includes('const mountedMs = mountedAtRef.current;'));
  assert.ok(!px.includes('const dispatchedMs'), 'no server timestamp is compared with Date.now()');
  assert.ok(!/dispatched_at \|\| job\?\.created_at/.test(px));
  // The old ungated definition is gone.
  assert.ok(!px.includes("const wedged = processor === 'adyen' && (status === 'charging' || status === 'unknown');"));
  // The timers and the button both hang off `wedged`.
  const timers = px.slice(px.indexOf('// ── v5.7.37: auto-rescue'), px.indexOf('// ── v5.11.16: an amount mismatch'));
  assert.match(timers, /if \(!wedged\) return undefined;/);
  assert.match(timers, /\}, 8_000\);/);
  assert.match(px, /\{wedged && \(\s*<button className="btn"[^>]*onClick=\{\(\) => runReaderCheck\(false\)\}>/);
  assert.equal((px.match(/\{wedged && \(/g) || []).length, 1, 'one gated button');
  // The kick handed over from the checkout: a late answered refusal is shown, a transport error is not.
  assert.match(px, /export default function PaxTerminal\(\{ job: initialJob, terminalLabel, onComplete, onBack, onFailed, kickPending = false, kick = null, advisory = null \}\)/);
  assert.match(px, /if \(o\?\.kickError && o\?\.kickAnswered\) setKickRefusal\(/);
  // Review 30 Sep: a late TRANSPORT failure (kickError set, kickAnswered false) does NOT settle the gate;
  // the customer may still be paying and the 130 s clock decides. Only an accepted kick or an answered
  // refusal settles it.
  assert.ok(px.includes('if (!o?.kickError || o?.kickAnswered) setKickSettled(true);'));
  assert.equal((px.match(/setKickSettled\(true\)/g) || []).length, 1, 'one way to settle the gate: the fn answered');
  // An adopted live job (kickPending with no kick promise) keeps the gate shut until the clock too.
  assert.ok(px.includes('const [kickSettled, setKickSettled] = useState(!kickPending);'));
  assert.ok(px.includes('const kickOpen = !!kickPending && !kickSettled;'));
  assert.match(px, /\{status === 'charging_unsent' && job\?\.last_error && !blocked && \(/);
  // The 130 s clock re-renders once so a still open kick can pass the line.
  assert.match(px, /mountedMs \+ KICK_SETTLE_LIMIT_MS - Date\.now\(\)/);
  // Peter's words while the customer pays.
  assert.ok(px.includes("'Customer is paying on the card machine. Keep this screen open, it finishes by itself.'"));
  assert.ok(px.includes("'Cancel payment'"));
});
