/**
 * venueDate.js: dates and times in the venue's words and timezone. v5.11.65: the body lives in
 * supabase/functions/_shared/venueDate.js so po-send (the supplier email) and the browser share
 * one copy; this file re-exports it. Pure, so Node's test runner loads it too.
 */
export * from '../../supabase/functions/_shared/venueDate.js';
