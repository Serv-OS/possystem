// src/staff/docTemplates.js
//
// The built in offer letter and contract (moved here from wfData.js in 5.12.57, unchanged words), and
// which of them a venue is offered. PURE: no imports, so src/lib/payLawBatch4.test.js reads it.
//
// 5.12.57: each built in carries a country. The offer letter is country neutral (pay, employment type
// and start date only), so every venue gets it. The contract is the UK statement of main terms (5.6
// weeks holiday, statutory notice) and is offered only at UK venues. A venue outside the UK is
// offered its own saved templates first, so the first of its own is the one preselected; a US venue
// with no contract of its own is told to add one (Workforce settings, Contracts and letters). A UK
// venue's list is exactly as before: the built ins, then its own.

// Built-in starting templates so there's always something to send. Editable copies
// are created in wf_doc_templates the first time the operator saves a change.
export const DEFAULT_TEMPLATES = [
  { id: 'builtin-offer', kind: 'offer', name: 'Standard offer letter', contractType: null, isDefault: true, builtin: true, country: null,
    body: `Dear {{first_name}},

We're delighted to offer you the position of {{position}} at {{business_name}}.

• Rate of pay: {{rate}}
• Employment type: {{contract_type}}
• Proposed start date: {{start_date}}

We're really pleased to have you joining the team. Please reply to this email to accept, and we'll send your contract to sign and get you set up.

Warm regards,
{{business_name}}` },
  { id: 'builtin-contract', kind: 'contract', name: 'Statement of main terms (UK)', contractType: null, isDefault: true, builtin: true, country: 'UK',
    body: `STATEMENT OF MAIN TERMS OF EMPLOYMENT

This statement sets out the main terms of your employment with {{business_name}} ("the Employer").

Employee: {{full_name}}
Position: {{position}}
Employment type: {{contract_type}}
Start date: {{start_date}}
Rate of pay: {{rate}}
Average weekly hours: {{weekly_hours}}
Place of work: {{business_name}}

1. Pay is calculated and paid in line with the Employer's normal payroll schedule.
2. Holiday accrues in line with statutory entitlement (5.6 weeks per year, pro rata).
3. Either party may end this employment by giving the statutory minimum notice.
4. You agree to follow the Employer's policies and procedures while employed.

By signing below you confirm you have read, understood and agree to these terms of employment.

Signed: {{full_name}}     Date: {{today}}` },
];

/**
 * The templates a venue is offered, built ins and its own saved ones, of one kind (or all).
 *   UK      every built in for the UK, then its own (as before)
 *   other   its own first, then the built ins for every country (the offer letter); never the UK contract
 */
export function templatesForVenue(saved = [], { kind = null, country = 'UK' } = {}) {
  const builtins = DEFAULT_TEMPLATES.filter((t) => !t.country || t.country === country);
  const all = country === 'UK' ? [...builtins, ...(saved || [])] : [...(saved || []), ...builtins];
  return kind ? all.filter((t) => t.kind === kind) : all;
}

/** What onboarding says when a venue has no template of a kind to offer. */
export function noTemplateWords(kind) {
  return kind === 'contract'
    ? 'No contract to send yet. Add your contract in Workforce settings, Contracts and letters.'
    : 'No offer letter to send yet. Add one in Workforce settings, Contracts and letters.';
}
