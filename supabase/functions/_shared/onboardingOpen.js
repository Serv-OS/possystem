// supabase/functions/_shared/onboardingOpen.js
//
// How many onboarding steps are genuinely open, derived from EVIDENCE: the stored steps array goes
// stale (it predates POS access and bank details landing by other paths). An explicitly complete
// stored step still counts as done. One copy (v5.11.101) for staff-portal (the Time Clock's
// outstanding count, the staff app's open shifts), workforce-clock and the open shift rule: someone
// whose onboarding is not finished cannot claim a shift, as the rota will not schedule them
// (WfRota onboardingBlock). The database judge has the same rule (_wf_claim_problem, 20261031a).
//
// row:   the person's newest wf_onboarding row { meta, steps } (no row: nothing open)
// staff: their wf_staff row { bank_account_masked, pos_user_id }
// bankDetails: false at a US venue (the payroll provider holds bank details: the bank step is never open)

export function openOnboardingSteps(row, staff, bankDetails = true) {
  if (!row) return 0;
  const meta = row.meta || {};
  const done = {
    offer: !!(meta.offerAccepted || meta.offerSentAt),
    contract: !!meta.signature,
    rtw: !!meta.rtwPath,
    bank: !bankDetails || !!(meta.bankMasked || staff?.bank_account_masked),
    posUser: !!staff?.pos_user_id,
  };
  (Array.isArray(row.steps) ? row.steps : []).forEach((st) => {
    if (st?.status === 'complete' && st.key in done) done[st.key] = true;
  });
  return Object.values(done).filter(v => !v).length;
}
