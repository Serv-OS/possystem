// src/backoffice/sections/stock/SiteMoney.jsx
//
// 5.12.57: reportKit's Money cell in a site's own currency. reportKit's Money draws the active
// venue's money (signedMoney with no code); a stock screen on a site picked in the site picker draws
// that site's: code when given, else the screen's SiteCurrencyContext (useSiteCurrency.js), else the
// active venue's. The same span and styles, so a site in the active venue's currency draws exactly
// what reportKit's Money draws.

import { useContext } from 'react';
import { signedMoney } from '../../../lib/currency';
import { SiteCurrencyContext } from './useSiteCurrency';

const numSt = { fontVariantNumeric:'tabular-nums' };

export function Money({ v, bold, muted, code = null }) {
  const here = useContext(SiteCurrencyContext);
  if (v == null) return <span style={{ color:'var(--t4)' }}>—</span>;
  const neg = Number(v) < 0;
  return (
    <span style={{ ...numSt, fontWeight: bold ? 700 : 500,
      color: neg ? 'var(--red)' : muted ? 'var(--t3)' : 'var(--t1)' }}>
      {signedMoney(v, code || here || undefined)}
    </span>
  );
}
