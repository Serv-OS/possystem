// src/lib/staffAuth.js
//
// Pure staff sign-in resolution — enforces the per-staff sign-in METHOD (PIN vs card). The security
// point: a staff member set to 'card' canNOT sign in with a PIN (even a shared/known one), so
// identity is tied to the physical card. A manager override (allowOverride) permits a one-off PIN
// sign-in for a card-staff who's lost their card. No I/O → unit-tested.
//
// staff: [{ id, name, pin, nfcCardId, authMethod, role, permissions }]
// authMethod ∈ 'pin' | 'card' | 'fingerprint' (default 'pin').

import { normalizeCardId } from './nfc.js';

/**
 * Resolve a sign-in attempt.
 * @param staff  the active staff list
 * @param input  { pin?, cardId?, allowOverride? }
 * @returns { ok, staff?, method?, reason? }
 *   method  : 'pin' | 'card' | 'override'
 *   reason  : 'card_unknown' | 'pin_unknown' | 'use_card'
 */
export function resolveSignIn(staff, { pin = null, cardId = null, allowOverride = false } = {}) {
  const list = Array.isArray(staff) ? staff : [];

  if (cardId) {
    const id = normalizeCardId(cardId);
    if (!id) return { ok: false, reason: 'card_unknown' };
    const m = list.find((s) => s.nfcCardId && normalizeCardId(s.nfcCardId) === id);
    return m ? { ok: true, staff: m, method: 'card' } : { ok: false, reason: 'card_unknown' };
  }

  if (pin) {
    const m = list.find((s) => s.pin && String(s.pin) === String(pin));
    if (!m) return { ok: false, reason: 'pin_unknown' };
    // Card-staff: a PIN is refused unless a manager has armed a one-off override.
    if (m.authMethod === 'card' && !allowOverride) return { ok: false, reason: 'use_card', staff: m };
    return { ok: true, staff: m, method: m.authMethod === 'card' ? 'override' : 'pin' };
  }

  return { ok: false, reason: 'pin_unknown' };
}

/** Can this staff member authorise a one-off sign-in override for someone else? (manager-ish) */
export function canOverride(s) {
  if (!s) return false;
  if (s.role === 'Manager') return true;
  const p = Array.isArray(s.permissions) ? s.permissions : [];
  return p.includes('staff') || p.includes('override') || p.includes('refund');
}
