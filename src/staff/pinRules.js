// src/staff/pinRules.js (5.12.91): a till PIN picked for the manager, and the text that carries it.
// Pure, no imports: node --test (src/staff/pinRules.test.js).
//
// WHY (HR feedback batch 2, 24 Nov 2026): giving a new starter till access meant leaving Onboarding,
// thinking of a four digit number nobody else has, typing it, then telling the person by hand. The
// Back Office now offers one that is free at the site and can text it to them.

/** PINs anyone would guess: one digit four times (0000), a run up or down (1234, 4321, 9012), or a
 *  pair twice (1212). Never offered by Generate; a manager may still type one. */
export function weakPin(pin) {
  const p = String(pin || '');
  if (!/^\d{4}$/.test(p)) return true;
  if (/^(\d)\1{3}$/.test(p)) return true;
  const d = p.split('').map(Number);
  const step = (n) => d.every((x, i) => i === 0 || (x - d[i - 1] + 10) % 10 === n);
  if (step(1) || step(9)) return true;
  if (p.slice(0, 2) === p.slice(2)) return true;
  return false;
}

/**
 * A four digit PIN no active till user at the site has, and that is not an easy guess.
 * taken: the PINs in use (strings). random: () => a number from 0 up to but not including 1.
 * Returns '' only if every PIN is taken (a site would need thousands of till users).
 */
export function generatePin(taken = [], random = Math.random) {
  const used = new Set((taken || []).map((x) => String(x || '')));
  for (let i = 0; i < 400; i++) {
    const p = String(Math.floor(random() * 10000)).padStart(4, '0');
    if (!used.has(p) && !weakPin(p)) return p;
  }
  // Unlucky or nearly full: take the first free one in order.
  for (let n = 0; n < 10000; n++) {
    const p = String(n).padStart(4, '0');
    if (!used.has(p) && !weakPin(p)) return p;
  }
  return '';
}

/** The PINs active till users at the site hold (staffMembers: the Team list), leaving one person out. */
export function takenPins(staffMembers, exceptId = null) {
  return (staffMembers || []).filter((m) => m && m.active !== false && m.id !== exceptId && m.pin).map((m) => String(m.pin));
}

/** The text message that carries a PIN. Short enough for one text, and says not to share it. */
export function pinMessage({ name, pin, venueName } = {}) {
  const first = String(name || '').trim().split(/\s+/)[0];
  const hi = first ? `Hi ${first}, your` : 'Your';
  const at = venueName ? ` at ${venueName}` : '';
  return `${hi} till PIN${at} is ${pin}. Use it to sign in at the till and to clock in. Keep it to yourself.`;
}

/** What the Back Office says after trying to text a PIN. answer: { ok, skipped } or an Error. */
export function pinSentWords(name, answer) {
  const first = String(name || 'them').trim().split(/\s+/)[0] || 'them';
  if (answer instanceof Error) return `The text to ${first} did not send (${answer.message || 'error'}). Tell them the PIN yourself.`;
  if (answer?.skipped === 'no-mobile') return `${first} has no mobile number on their staff record, so tell them the PIN yourself.`;
  if (answer?.skipped === 'no-record') return `${first} has no Workforce staff record with a mobile number, so tell them the PIN yourself.`;
  return `PIN sent to ${first} by text.`;
}
