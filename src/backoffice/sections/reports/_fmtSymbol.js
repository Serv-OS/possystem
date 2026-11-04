// src/backoffice/sections/reports/_fmtSymbol.js
//
// 5.12.57: the symbol a report's money format prints ("$" for a US site's fmt), so a chart label
// follows the site on screen, not the signed in one (BOReports hands another site's reports that
// site's fmt). No fmt, or one that prints no symbol: the active venue's. Kept out of _charts.jsx so
// that file only exports components. PURE: node:test loads it (src/lib/typedPoundGuard.test.js).
import { currencySymbol } from '../../../lib/currency.js';

export function fmtSymbol(fmt) {
  if (typeof fmt !== 'function') return currencySymbol();
  const sym = String(fmt(0) ?? '').replace(/[\d\s.,+-]/g, '');
  return sym || currencySymbol();
}
