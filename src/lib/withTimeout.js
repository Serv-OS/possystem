// src/lib/withTimeout.js
//
// Race a promise against a timer. A hung network call or a stalled auth lock on a woken
// iPad or Android TV would otherwise freeze a single flight poll forever.
// Resolves or rejects like the promise; after `ms` it rejects with a TimeoutError instead.
// The timer is always cleared. NO imports, so node:test can load it.
//
// v5.8.59 — WHY THE DEFAULT TIMERS ARE WRAPPERS, NEVER `{ setTimeout, clearTimeout }`:
// in a browser setTimeout is a method of window, so calling it as `timers.setTimeout(...)`
// hands it a plain object as its receiver and Chrome throws "Illegal invocation". Node
// allows it, so every node test passed while, on real TVs, v5.8.56's menu board tick and
// order screen feed threw on their first line and were swallowed by their own catch: the
// screen kept showing its pairing code and never registered or heartbeated.

export class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label || 'Request'} timed out after ${ms} ms`);
    this.name = 'TimeoutError';
    this.code = 'TIMEOUT';
  }
}

// Arrow wrappers: inside them the call is a plain global call, which every engine accepts.
const DEFAULT_TIMERS = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export function withTimeout(promise, ms, label, timers = DEFAULT_TIMERS) {
  const setT = (timers && timers.setTimeout) || DEFAULT_TIMERS.setTimeout;
  const clearT = (timers && timers.clearTimeout) || DEFAULT_TIMERS.clearTimeout;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setT(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer != null) clearT(timer);
  });
}
