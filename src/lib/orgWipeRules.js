// src/lib/orgWipeRules.js: delete an organisation and wipe all its data, the app side (5 Nov 2026).
// The rules live in supabase/functions/_shared/orgWipeRules.js (the org-admin function uses the
// same file), re-exported here for the Company Admin screen.
export * from '../../supabase/functions/_shared/orgWipeRules.js';
