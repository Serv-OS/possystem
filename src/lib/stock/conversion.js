/**
 * conversion.js — the unit-conversion engine. v5.11.64: the engine lives in
 * supabase/functions/_shared/stockConversion.js so manager-approve (a receive from the Manager
 * app) and the browser convert with one copy; this file re-exports it.
 */
export * from '../../../supabase/functions/_shared/stockConversion.js';
