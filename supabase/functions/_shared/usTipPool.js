// usTipPool.js: who shares the tip pool, and what goes in it, at a US venue (5.12.57).
//
// Federal FLSA: managers and supervisors may not keep or receive pooled tips, and a service charge
// the venue adds to the bill is the venue's money: paid out it is wages, never tips. So at a US venue
//   * a position in the management group (wf_roles.grp 'mgmt': Supervisor, Duty Manager and the like)
//     shares nothing, nor does a position in the venue's no overtime (exempt) list (Workforce settings,
//     the same rule payroll uses: _shared/multiSiteOvertime.js overtimeRules; salaried positions
//     start ticked), and the Back Office refuses a tip pool weight above 0 for them;
//   * the suggested pool is the pooled card tips only, never the service charge.
// A UK (or Irish) venue is exactly as before: every position shares at its tronc weight and service
// charge joins the pool.
//
// PURE: imports only another pure _shared file; runs under node --test and in Deno.

import { overtimeRules } from './multiSiteOvertime.js';

/** Why a position is left out of a US tip pool ('manager' | 'exempt'), or null when it shares. */
export function tipPoolExclusion({ country = 'UK', grp = null, roleKey = null, payType = null, settings = null } = {}) {
  if (country !== 'US') return null;
  if (String(grp || '') === 'mgmt') return 'manager';
  if (roleKey && overtimeRules({ settings, roleKey, payType }).exempt) return 'exempt';
  return null;
}

/** The words for a left out position, for the Pay screen and the tip pool run. */
export function tipPoolExclusionWords(reason) {
  if (reason === 'manager') return 'Managers and supervisors cannot share the tip pool at a US venue (FLSA). Set the tip pool weight to 0.';
  if (reason === 'exempt') return 'Positions with no overtime (exempt) are managers in law and cannot share the tip pool at a US venue (FLSA). Set the tip pool weight to 0, or untick it in Workforce settings, Positions with no overtime.';
  return '';
}

/** The pool the till suggests for a week: card tips by the policy's pooled share, plus service charge outside the US. */
export function suggestedTipPool({ country = 'UK', cardTips = 0, serviceCharge = 0, pooledShare = 1 } = {}) {
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const card = (Number(cardTips) || 0) * (Number(pooledShare) || 0);
  return country === 'US' ? r2(card) : r2((Number(serviceCharge) || 0) + card);   // UK: the sum as it always was
}
