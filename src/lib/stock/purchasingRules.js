/**
 * stock/purchasingRules.js — the PURE rules behind the Order pad, the Orders screen and the
 * Manager app's Raise order / Receive. v5.11.64: the body lives in
 * supabase/functions/_shared/purchasingRules.js so the edge functions (manager-approve,
 * manager-snapshot) and the browser run ONE copy (same pattern as _shared/businessDay.js).
 */
export * from '../../../supabase/functions/_shared/purchasingRules.js';
