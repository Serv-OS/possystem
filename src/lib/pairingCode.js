// src/lib/pairingCode.js
//
// Human pairing code shown on an unassigned TV (menu board or order screen). The
// operator types it into Back Office. 8 characters from a 30 symbol alphabet with no
// I, L, O, U, 0 or 1, formatted XXXX-XXXX, about 39 bits.
//
// Uses crypto.getRandomValues with rejection sampling: 240 is 8 x 30, so a byte of
// 240 or more is skipped and `byte % 30` stays uniform. Math.random is used only when
// the browser has no crypto at all. NO imports, so node:test can load it.

export const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const LIMIT = 240; // largest multiple of 30 that fits in a byte
const MAX_ROUNDS = 64;

function cryptoBytes(n) {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (!c || typeof c.getRandomValues !== 'function') return null;
  return c.getRandomValues(new Uint8Array(n));
}

function mathRandomCode() {
  let out = '';
  for (let i = 0; i < 8; i++) out += PAIRING_ALPHABET[Math.floor(Math.random() * PAIRING_ALPHABET.length)];
  return out;
}

const format = (s) => `${s.slice(0, 4)}-${s.slice(4, 8)}`;

/**
 * A fresh XXXX-XXXX code. `randomBytes(n)` may be injected for tests; it returns an
 * array like of n bytes, or null when no secure source exists.
 */
export function generatePairingCode(randomBytes = cryptoBytes) {
  let out = '';
  for (let round = 0; round < MAX_ROUNDS && out.length < 8; round++) {
    let bytes = null;
    try { bytes = randomBytes(16); } catch { bytes = null; }
    if (!bytes || typeof bytes.length !== 'number') return format(mathRandomCode());
    for (let i = 0; i < bytes.length && out.length < 8; i++) {
      const b = Number(bytes[i]);
      if (!Number.isInteger(b) || b < 0 || b >= LIMIT) continue;
      out += PAIRING_ALPHABET[b % PAIRING_ALPHABET.length];
    }
  }
  // A broken source that only ever gives rejected bytes: finish with Math.random.
  while (out.length < 8) out += PAIRING_ALPHABET[Math.floor(Math.random() * PAIRING_ALPHABET.length)];
  return format(out);
}
