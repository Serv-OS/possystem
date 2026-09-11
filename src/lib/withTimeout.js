// src/lib/withTimeout.js
//
// Race a promise against a timer. A hung network call or a stalled auth lock on a woken
// iPad or Android TV would otherwise freeze a single flight poll forever.
// Resolves or rejects like the promise; after `ms` it rejects with a TimeoutError instead.
// The timer is always cleared. NO imports, so node:test can load it.

export class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label || 'Request'} timed out after ${ms} ms`);
    this.name = 'TimeoutError';
    this.code = 'TIMEOUT';
  }
}

export function withTimeout(promise, ms, label, timers = { setTimeout, clearTimeout }) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = timers.setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer != null) timers.clearTimeout(timer);
  });
}
