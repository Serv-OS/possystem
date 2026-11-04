// src/backoffice/sections/stock/useSiteCurrency.js
//
// 5.12.57: the currency of the site a stock screen shows (rules in lib/stock/siteMoney.js). Only the
// active venue sets the Back Office currency now, so a screen on a site PICKED in the site picker
// draws its money in that site's currency through these, or a US site picked while signed in at a
// UK site reads in pounds. The signed in venue is the active currency, exactly as before. Another
// site: the stock scope's currency for it, else its location config (one read per site, which no
// longer touches the active currency), else the active currency.
//
//   useSiteCurrency(siteId)   'GBP' | 'USD' | 'EUR'
//   useSiteMoney(siteId)      { code, symbol, money, signedMoney, moneyMinor, currencySymbol } for that
//                             site: a screen takes them in place of the lib/currency imports
//   SiteCurrencyContext       the screen's site currency for the pieces it draws (its Provider wraps
//                             the screen; it draws no HTML of its own)
//   useSiteMoneyHere()        the same helpers for the context's currency (none: the active venue's)
//   useSiteCurrencyOf()       (siteId) => code from the scope alone, for a list of many sites
//   useSiteSymbolOf()         (siteId, own) => '£' | '$' | '€': a row's own currency when it has one,
//                             else its site's

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useStockScope } from '../../StockScope';
import { getActiveLocationSync } from '../../../lib/supabase';
import { getLocationConfig } from '../../../lib/locationTime';
import { siteCurrencyCode, scopeCurrency, moneyIn, knownCode } from '../../../lib/stock/siteMoney';
import { currencySymbol } from '../../../lib/currency';

export const SiteCurrencyContext = createContext(null);

function homeOf(sc) {
  if (sc?.homeSite) return String(sc.homeSite);
  let active = null;
  try { active = getActiveLocationSync(); } catch { /* no venue yet */ }
  return active && typeof active !== 'object' ? String(active) : null;
}

export function useSiteCurrency(siteId) {
  const sc = useStockScope();
  const home = homeOf(sc);
  const id = siteId == null || siteId === '' ? null : String(siteId);
  const needRead = !!id && id !== home && !scopeCurrency(sc, id);
  const [read, setRead] = useState(null);   // { siteId, currency }
  useEffect(() => {
    if (!needRead) return undefined;
    let live = true;
    getLocationConfig(id).then((cfg) => { if (live) setRead({ siteId: id, currency: cfg?.currency || null }); }).catch(() => {});
    return () => { live = false; };
  }, [needRead, id]);
  return siteCurrencyCode(id, { scope: sc, homeId: home, configCurrency: read && read.siteId === id ? read.currency : null });
}

export function useSiteMoney(siteId) {
  const code = useSiteCurrency(siteId);
  return useMemo(() => moneyIn(code), [code]);
}

export function useSiteMoneyHere() {
  const code = useContext(SiteCurrencyContext);
  return useMemo(() => moneyIn(code), [code]);
}

export function useSiteCurrencyOf() {
  const sc = useStockScope();
  const home = homeOf(sc);
  return (siteId) => siteCurrencyCode(siteId, { scope: sc, homeId: home });
}

export function useSiteSymbolOf() {
  const of = useSiteCurrencyOf();
  return (siteId, own = null) => currencySymbol(knownCode(own) || of(siteId));
}
