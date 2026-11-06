// src/lib/customerAppRules.js
//
// The customer app gateway rules (6 Nov 2026): refresh token hashing and rotation, the delete
// account report, the venue row, the tenant id pattern and the theme check. The one copy lives
// in supabase/functions/_shared/customerAppRules.js (the customer-app edge function imports it);
// this file re-exports it for the app and for node:test (customerAppRules.test.js).
export * from '../../supabase/functions/_shared/customerAppRules.js';
