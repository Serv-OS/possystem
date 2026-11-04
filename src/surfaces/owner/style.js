// src/surfaces/owner/style.js: the money format and the styles the Owner app's screens share.

import { currencyConfig } from '../../lib/currency.js';

// 5.12.57: formatted in the currency's own locale, so a US venue reads "$1,234" (en-GB printed
// "US$1,234") and a UK one still reads "£1,234". The fallback is the currency's own symbol.
export const money = (n, currency = 'GBP', dp = 0) => {
  try { return new Intl.NumberFormat(currencyConfig(currency).locale, { style: 'currency', currency, minimumFractionDigits: dp, maximumFractionDigits: dp }).format(Number(n) || 0); }
  catch { return `${currencyConfig(currency).symbol}${(Number(n) || 0).toFixed(dp)}`; }
};

/** The colour of a comparison line: green up, red down, grey when there is no percent. */
export const toneColor = (tone) => (tone === 'up' ? 'var(--grn)' : tone === 'down' ? 'var(--red)' : 'var(--t3)');

export const smallCaps = { fontSize: 10.5, color: 'var(--t4)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' };
export const periodChip = { padding: '9px 6px', borderRadius: 99, border: '1px solid var(--bdr)', background: 'var(--bg1)', color: 'var(--t2)', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' };
export const periodChipOn = { background: 'var(--acc)', border: '1px solid var(--acc)', color: '#0b0c10' };

/** A grey text button ("Show all 20"). */
export const linkBtn = { background: 'none', border: 'none', padding: '6px 0 0', color: 'var(--t3)', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', textDecoration: 'underline' };
