// supabase/functions/_shared/promo.ts
// Shared promo-code helpers: human-readable, non-guessable code generation + reward→discount mapping.

// Crockford-ish alphabet minus ambiguous chars (no I, L, O, 0, 1).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// genCode('BDAY', 5) → "BDAY-7F3K9". Crypto-random suffix; prefix sanitised + uppercased.
export function genCode(prefix = '', length = 5): string {
  const n = Math.max(4, Math.min(12, Number(length) || 5));
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let suffix = '';
  for (let i = 0; i < n; i++) suffix += ALPHABET[bytes[i] % ALPHABET.length];
  const p = String(prefix || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  return p ? `${p}-${suffix}` : suffix;
}

export type Offer = {
  reward_type: string; reward_value: number; reward_item_id?: string | null; reward_label?: string | null;
};

// Map an offer's reward to a discount the till applies through its existing discount slot.
// amount is in major currency units (matches closed_checks numeric(10,2)).
export function computeDiscount(offer: Offer, subtotal: number): {
  type: string; value: number; amount: number; label: string; item_id?: string | null;
} {
  const v = Number(offer.reward_value) || 0;
  const sub = Math.max(0, Number(subtotal) || 0);
  switch (offer.reward_type) {
    case 'percent': {
      const amount = Math.round(sub * (v / 100) * 100) / 100;
      return { type: 'percent', value: v, amount, label: offer.reward_label || `${v}% off` };
    }
    case 'fixed': {
      const amount = Math.min(v, sub);
      return { type: 'amount', value: v, amount, label: offer.reward_label || `£${v.toFixed(2)} off` };
    }
    case 'free_item':
      return { type: 'free_item', value: v, amount: 0, item_id: offer.reward_item_id ?? null, label: offer.reward_label || 'Free item' };
    case 'free_delivery':
      return { type: 'free_delivery', value: 0, amount: 0, label: offer.reward_label || 'Free delivery' };
    case 'points_bonus':
      return { type: 'points_bonus', value: v, amount: 0, label: offer.reward_label || `${v} bonus points` };
    default:
      return { type: 'amount', value: 0, amount: 0, label: offer.reward_label || 'Offer' };
  }
}
