// supabase/functions/_shared/otpName.js
//
// The one rule for the name in a loyalty code text (21 Oct 2026). Twilio stamps the Verify
// SERVICE's friendly name (at most 30 characters) into "Your <name> verification code is ...".
// A venue's code must carry the name set in Back Office for THAT venue, never another venue's.
//
// 22 Oct 2026 (v5.11.94): the rules moved to otpServiceRules.js with the rest of the service rules
// (what name a venue's service must carry, what to do when it is missing or drifted, who may run
// the nightly check). This file re-exports the two names PR 317 introduced so its callers and its
// test (src/lib/otpName.test.js) are unchanged.

export { twilioName, sameServiceName } from './otpServiceRules.js';
