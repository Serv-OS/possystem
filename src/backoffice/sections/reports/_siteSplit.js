// The parts of the site split kit that are not components (see SiteSplit.jsx for the ones
// that draw, and src/lib/reportSplit.js for the maths). Peter, 5 Oct 2026: "make every
// report we have multi site when sites are connected together".

import { useMemo } from 'react';
import { toCsv, downloadCsv } from './_csv';
import { siteParts, currencyBlocks, withSiteColumn } from '../../../lib/reportSplit.js';

// One part per site (its rows, its own clock, currency and comparison) and the currency
// blocks they fall into. Takes the report's own props.
export function useParts({ sites, scope, checks, prevChecks, kdsTickets, compare, range, fmt, daySums }) {
  // Daily trend is handed its comparison on the range, the others as `compare`.
  const cmp = compare ?? range?.compare ?? null;
  return useMemo(() => {
    const parts = siteParts({ sites, scope, checks, prevChecks, tickets: kdsTickets, compare: cmp, fmt, daySums });
    return { parts, blocks: currencyBlocks(parts), fromSums: daySums?.available === true };
  }, [sites, scope, checks, prevChecks, kdsTickets, cmp, fmt, daySums]);
}

// Every multi site CSV has Site as its first column. rows must carry siteName.
export function exportSites(name, rows, columns) {
  downloadCsv(`${name}-by-site-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows, withSiteColumn(columns)));
}

export const titleSt = { fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', margin:'0 0 8px' };
