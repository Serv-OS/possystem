// src/backoffice/sections/stock/useSiteRegion.js
//
// 5.12.57 (US basics batch 7): the site based words and units of a stock screen (rules in
// lib/stock/stockRegion.js). The site's currency (useSiteCurrency) decides its country, so a US site
// picked while signed in at a UK venue reads 'tax' and offers US units. A UK site reads as before.
//
//   useStockUnitCodes()          Set of the unit codes in the database's stock_units (null until read)
//   useUnitPicks(siteId)         { list, usPending, code } for a unit picker at that site
//   useSiteTaxWords(siteId)      stockTaxWords for that site, plus code and us
//
// The units are read once per page load (stock_units is a small shared reference table). A failed
// read leaves the US units out (usPending), never breaks a picker.

import { useEffect, useMemo, useState } from 'react';
import { fetchStockUnits } from '../../../lib/stock/data';
import { unitPickList, stockTaxWords, isUsSite } from '../../../lib/stock/stockRegion';
import { useSiteCurrency } from './useSiteCurrency';

let unitCodes = null;      // Set once read
let unitRead = null;       // the one read in flight

function readUnitCodes() {
  if (unitCodes) return Promise.resolve(unitCodes);
  if (!unitRead) {
    unitRead = Promise.resolve()
      .then(() => fetchStockUnits())
      .then((r) => { unitCodes = new Set((r?.data || []).map((u) => String(u.code || '').trim().toLowerCase()).filter(Boolean)); return unitCodes; })
      .catch(() => { unitRead = null; return new Set(); });
  }
  return unitRead;
}

export function useStockUnitCodes(enabled = true) {
  const [codes, setCodes] = useState(unitCodes);
  useEffect(() => {
    if (!enabled || codes) return undefined;
    let live = true;
    readUnitCodes().then((c) => { if (live) setCodes(c); });
    return () => { live = false; };
  }, [enabled, codes]);
  return codes;
}

export function useUnitPicks(siteId = null) {
  const code = useSiteCurrency(siteId);
  const us = isUsSite(code);
  const codes = useStockUnitCodes(us);   // a UK site never needs the read
  return useMemo(() => ({ ...unitPickList(code, codes), code }), [code, codes]);
}

export function useSiteTaxWords(siteId = null) {
  const code = useSiteCurrency(siteId);
  return useMemo(() => ({ ...stockTaxWords(code), code, us: isUsSite(code) }), [code]);
}
