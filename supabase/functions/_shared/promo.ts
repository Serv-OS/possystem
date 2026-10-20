// supabase/functions/_shared/promo.ts
// Shared promo-code helpers: human-readable, non-guessable code generation + reward→discount mapping.
import { promoDiscountForBasket } from './promoMath.js';

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
  include_category_ids?: string[] | null; exclude_category_ids?: string[] | null;
};

// Map an offer's reward to a discount the till applies through its existing discount slot.
// amount is in major currency units (matches closed_checks numeric(10,2)).
// v5.11.81: the one promo maths (_shared/promoMath.js), here and in the apps. With a subtotal alone
// it is exactly the old answer; with the basket's lines it honours the offer's category rules and
// prices a free item, and a free delivery code takes the delivery fee off.
export function computeDiscount(offer: Offer, subtotal: number): {
  type: string; value: number; amount: number; label: string; item_id?: string | null;
} {
  return promoDiscountForBasket(offer, { subtotal });
}

/** v5.11.81: the same for a whole basket ({ subtotal, lines, deliveryFee }). */
export function computeDiscountForBasket(offer: Offer, basket: { subtotal?: number; lines?: unknown[] | null; deliveryFee?: number }): {
  type: string; value: number; amount: number; label: string; item_id?: string | null; missing?: boolean; points?: number;
} {
  return promoDiscountForBasket(offer, basket || {});
}
