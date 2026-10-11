// supabase/functions/_shared/stableId.js
//
// One id from one piece of text, the same every time (8 Oct 2026). The Xero gap notice and the
// daily VAT check write a venue message once per site and day whatever runs them: the id is
// worked out from the site and the day, and venue_messages is unique on (broadcast_id,
// location_id), so a second write is a no op. A 128 bit FNV-1a style mix laid out as a UUID
// (version 4, variant 10xx, so the column takes it). Nothing cryptographic is needed here.
// PURE: imports nothing; runs in Node and Deno.

export function stableUuid(text) {
  const t = String(text ?? '');
  let a = 0x811c9dc5, b = 0x01000193, c = 0xcbf29ce4, d = 0x84222325;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t.charCodeAt(i);
    a = Math.imul(a ^ ch, 16777619) >>> 0;
    b = Math.imul(b ^ ch, 16777619) >>> 0;
    c = Math.imul(c ^ (ch + 1), 16777619) >>> 0;
    d = Math.imul(d ^ (ch + 2), 16777619) >>> 0;
    a = (a + c) >>> 0; c = (c ^ (a >>> 7)) >>> 0;
    b = (b + d) >>> 0; d = (d ^ (b >>> 11)) >>> 0;
  }
  const hex = [a, b, c, d].map((x) => x.toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
