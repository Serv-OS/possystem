// The Z report's "SALES BY GROUP" block (8 Oct 2026, D4d): one line per sales group with its
// item sales and share, after the SALES block. Text only, so it prints black on the 74mm slip
// (globals.css strips every colour inside #zreport-print-area). ZReport.jsx only mounts it:
// that file is shared with another branch and stays small.
//
// The Z report is one site by design (the signed in site), so the groups come from the store's
// own categories plus the home site's Xero mapping, through the same resolver every Sales mix
// surface uses. The categories answer at once; the mapping landing only re renders.
//
//   checks   the Z report's rows      fmt   the home currency formatter      siteId   scope.homeId

import { useMemo } from 'react';
import { useStore } from '../../../store';
import { useSiteMappings } from './_siteMappings';
import { makeMixResolver, mixView, mixFromChecks } from '../../../../supabase/functions/_shared/salesMix.js';
import { slipModel } from '../../../lib/salesMixView.js';

// Copied from ZReport.jsx so that file stays small on the conflict branch.
const ROW = { display:'flex', justifyContent:'space-between', padding:'3px 0', fontSize:11, lineHeight:1.5 };
const DIV = { borderTop:'1px dashed currentColor', margin:'8px 0' };
const BOLD = { fontWeight:700 };
const TITLE = { fontSize:11, fontWeight:700, color:'var(--t2)', letterSpacing:'.06em', marginBottom:4 };
const FINE = { fontSize:9.5, color:'var(--t4)' };
const NONE = Object.freeze([]);

export default function ZReportGroups({ checks, fmt, siteId }) {
  const categories = useStore((s) => s.menuCategories) || NONE;
  const ids = useMemo(() => (siteId ? [String(siteId)] : NONE), [siteId]);
  const { mappings } = useSiteMappings(ids);
  const mapping = siteId ? mappings[String(siteId)] : null;
  const resolver = useMemo(() => makeMixResolver(mapping || {}, categories), [mapping, categories]);
  const view = useMemo(() => mixView(mixFromChecks(checks, resolver), null, resolver), [checks, resolver]);
  const model = slipModel(view);
  if (!model) return null;
  return (
    <>
      <div style={DIV}/>
      <div style={TITLE}>SALES BY GROUP</div>
      {model.rows.map((r) => (
        <div key={r.key} style={ROW}><span>{r.name} ({r.share}%)</span><span>{fmt(r.money)}</span></div>
      ))}
      <div style={{ ...ROW, ...BOLD }}><span>Item sales</span><span>{fmt(model.total)}</span></div>
      <div style={FINE}>before check discounts and refunds</div>
      {model.allOther && <div style={FINE}>No sales groups set. Set them up in Reports, Sales mix.</div>}
    </>
  );
}
