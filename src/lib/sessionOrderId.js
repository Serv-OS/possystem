// src/lib/sessionOrderId.js
//
// The id a table's order (the session) is born with. 16 Oct 2026, bookings audit item 6.
//
// It used to be ORD-<counter> with the counter starting at 1000 on every page load, so every
// till, the host stand and the kiosk minted ORD-1001 for their first table after a reload. Live
// at Provo the same day: ORD-1001 on T1 and ORD-1001 on T2 at once. SessionReconciler reads one
// session id on two tables as a MOVE, so a shared id could clear a live table.
//
// Now: ORD-<device>-<time>-<random>. The ORD- prefix stays (nothing parses the rest, but the
// prefix is what staff and logs know). device is a short tag kept per browser, time is epoch
// milliseconds in base 36, random is 4 base 36 characters. Two devices cannot share a tag
// except by a 1 in 1.7 million chance, and then they would also need the same millisecond and
// the same 4 random characters.
//
// Pure: the clock, the random source and the storage are passed in, so the tests run under
// node with no browser.

const TAG_KEY = 'rpos-order-device-tag';
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomChars(n, rand) {
  let out = '';
  for (let i = 0; i < n; i++) out += B36[Math.floor(Math.abs(Number(rand()) || 0) * 36) % 36];
  return out;
}

// The device tag: read from storage, or made once and kept. Storage that throws or is absent
// (private window, node) still gets a tag for this page load.
export function deviceOrderTag({ storage = null, rand = Math.random } = {}) {
  try {
    const kept = storage?.getItem?.(TAG_KEY);
    if (kept && /^[0-9a-z]{4}$/.test(kept)) return kept;
  } catch { /* fall through to a fresh tag */ }
  const tag = randomChars(4, rand);
  try { storage?.setItem?.(TAG_KEY, tag); } catch { /* this page load keeps it in memory */ }
  return tag;
}

export function mintSessionOrderId({ tag, now = Date.now(), rand = Math.random } = {}) {
  const t = Math.max(0, Math.floor(Number(now) || 0)).toString(36);
  const d = /^[0-9a-z]{4}$/.test(String(tag || '')) ? String(tag) : randomChars(4, rand);
  return `ORD-${d}-${t}-${randomChars(4, rand)}`;
}

// A minter for one device: the time part never repeats or goes backwards within a page load (a
// second id in the same millisecond, or after the clock steps back, takes the last time plus
// one), so ids from one page load are always different, whatever the random part says.
export function makeSessionOrderIdMinter({ tag, clock = Date.now, rand = Math.random } = {}) {
  let last = -1;
  return () => {
    let t = Math.floor(Number(clock()) || 0);
    if (t <= last) t = last + 1;
    last = t;
    return mintSessionOrderId({ tag, now: t, rand });
  };
}

// The browser wiring: one tag and one minter per page load, made lazily so a test import never
// touches storage.
let _mint = null;
export function newSessionOrderId() {
  if (!_mint) {
    let storage = null;
    try { storage = typeof window !== 'undefined' ? window.localStorage : null; } catch { storage = null; }
    _mint = makeSessionOrderIdMinter({ tag: deviceOrderTag({ storage }) });
  }
  return _mint();
}
