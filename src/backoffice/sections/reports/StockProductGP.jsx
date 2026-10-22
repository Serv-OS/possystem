// src/backoffice/sections/reports/StockProductGP.jsx
//
// MULTI SITE STOCK, Drop 4a (contract 3.4, web-reports): Product GP and menu engineering. Per
// product: sold, net sales after spread discounts and rewards, plate cost, GP and GP %, a column per
// site (Side by side) or the company total; the Plate cost spread tab (lowest and highest site); the
// Menu engineering tab (Star, Plowhorse, Puzzle, Dog, the rule in src/lib/stock/menuEngineering.js).
// Product GP adds up to site GP because both read the same spread net. 'Plate cost not known before
// <day>' where a site's takes start inside the window. Every figure is stock_report_product_gp's.

import { useState } from 'react';
import { StockReportFrame, SiteTotalsTable, DrillTable, StockLoading, StockError, useStockReport } from './_stockKit';
import { TabBar, Pill } from '../stock/stockUi';
import { useExportFlow } from './ExportStatus';
import { col, withSites, siteNameOf, siteLabel, toggleSort, sortLoaded, notesOf, dayWords, fmtPct, fmtInt, initialPick, initialSite } from '../../../lib/stock/reportView.js';
import { classifyProducts, engineeringSummary, pivotBySite, spreadPct, plateCostNotes, CLASSES, CLASS_WORDS } from '../../../lib/stock/menuEngineering.js';
import { money } from '../../../lib/currency';

const TITLE = 'Product GP and menu engineering';
const SUB = 'Per product: sold, net sales after spread discounts and rewards, plate cost from the takes, GP. Adds up to site GP.';

const TOTALS = [
  col('sales_net', 'Sales', 'money'), col('theo_cost', 'Plate cost', 'money'), col('gp', 'GP', 'money'), col('gp_pct', 'GP %', 'pct'),
  col('products', 'Products', 'int'), col('_known_from', 'Plate cost known from', 'text'),
];
const GP_COLS = [
  col('name', 'Product'), col('_type', 'Type'), col('sold_qty', 'Sold', 'qty'), col('sales_net', 'Net sales', 'money'),
  col('theo_cost', 'Plate cost', 'money'), col('gp', 'GP', 'money'), col('gp_pct', 'GP %', 'pct'),
];
const SPREAD_COLS = [
  col('name', 'Product'), col('plate_cost_avg', 'Plate cost, average', 'money'), col('plate_cost_low', 'Lowest', 'money'), col('_low_site', 'At'),
  col('plate_cost_high', 'Highest', 'money'), col('_high_site', 'At'), col('_spread', 'Spread', 'text'),
];
const ENG_COLS = [
  col('name', 'Product'), col('_type', 'Type'), col('sold_qty', 'Sold', 'qty'), col('popularity_share', 'Share of units', 'pct'),
  col('_gp_unit', 'GP per unit', 'text'), col('gp_pct', 'GP %', 'pct'), col('_class', 'Class'),
];
const TABS = [{ id: 'gp', label: 'Product GP' }, { id: 'spread', label: 'Plate cost spread' }, { id: 'engineering', label: 'Menu engineering' }];
const TYPE_WORDS = { food: 'Food', drink: 'Drink', other: 'Other' };
const SORT_KEYS = { _type: 'type', _low_site: 'plate_cost_low_site', _high_site: 'plate_cost_high_site', _gp_unit: 'gp_per_unit', _class: 'class', _spread: '_spread_n' };
const PLATE_LINE = 'Plate cost not known before';

export default function StockProductGP({ orgId, sites, siteById, range, compare, layout, initialOpts, onExport, onShare, api }) {
  const [tab, setTab] = useState(() => initialPick(initialOpts, 'view', TABS.map((tb) => tb.id), 'gp'));
  const [sort, setSort] = useState(null);
  const [site, setSite] = useState(() => initialSite(initialOpts, sites));

  // Side by side on the GP tab reads one row per product per site and pivots them; every other view is the company total per product.
  const perSite = tab === 'gp' && layout === 'side' && !site;
  const level = perSite ? 'site_product' : site ? 'site_product' : 'product';
  const opts = { level, view: tab, site: site || undefined };
  const args = { orgId, sites, from: range.fromDay, to: range.toDay, opts, compare };
  const rep = useStockReport(api, 'product_gp', args) || {};
  const { meta, totals, rows, next, loading, error, then, thenLoaded, capped, more, moreBusy } = rep;
  const ex = useExportFlow({ api, report: 'product_gp', label: TITLE, args, meta, totals, rows, next, onExport });
  const share = () => onShare?.(opts);

  const nameOf = (id) => siteNameOf(meta, siteById, id);
  const shownTotals = (totals || []).map((t) => ({ ...t, _known_from: t.known_from ? dayWords(t.known_from) : (t.location_id == null ? '' : 'No takes yet') }));
  const base = withSites(rows, meta, siteById);
  const currency = (() => {
    const set = new Set(base.map((r) => r.currency).filter(Boolean));
    return set.size === 1 ? [...set][0] : (meta?.currencies?.length === 1 ? meta.currencies[0] : undefined);
  })();
  const oneCurrency = !meta?.mixed_currency;
  const sitesInRows = [...new Set(base.map((r) => r.location_id).filter((x) => x != null))];
  const pivot = perSite ? pivotBySite(base, sitesInRows.length ? sitesInRows : sites, 'gp_pct') : null;
  const pivotCols = pivot ? [...GP_COLS, ...pivot.sites.map((id) => col(`site:${id}`, `${nameOf(id)} GP %`, 'pct'))] : null;
  const classed = tab === 'engineering' ? classifyProducts(base) : null;
  const summary = classed ? engineeringSummary(classed) : null;
  const shownRows = (pivot ? pivot.rows : (classed || base)).map((r) => ({
    ...r,
    _type: TYPE_WORDS[r.type] || r.type || '',
    _low_site: siteLabel(meta, siteById, r.plate_cost_low_site),
    _high_site: siteLabel(meta, siteById, r.plate_cost_high_site),
    _spread: fmtPct(spreadPct(r.plate_cost_low, r.plate_cost_high)),
    _spread_n: spreadPct(r.plate_cost_low, r.plate_cost_high),
    _gp_unit: r.gp_per_unit == null ? '' : money(r.gp_per_unit, r.currency || currency),
    _class: r.class && r.class !== 'Unknown' ? r.class : CLASS_WORDS.Unknown.label,
  }));
  // The plate cost lines are printed under the totals, one per site, so the rules line does not repeat them.
  const notes = notesOf(meta, [PLATE_LINE]);
  const plateNotes = plateCostNotes(meta?.windows, { withNone: true });
  const cols = tab === 'spread' ? SPREAD_COLS : tab === 'engineering' ? ENG_COLS : (pivotCols || GP_COLS);

  return (
    <StockReportFrame title={TITLE} sub={SUB} meta={meta} extraLines={notes} onExport={ex.run} exportLabel={ex.atOnce ? 'Export CSV' : 'Export all rows as a file'} onShare={onShare ? share : undefined}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <TabBar tabs={TABS} value={tab} onChange={(t) => { setTab(t); setSort(null); }} />
      </div>

      {error && <StockError error={error} />}
      {loading && !totals && !error && <StockLoading words="Reading the product day totals" />}

      {totals && (
        <>
          <SiteTotalsTable meta={meta} totals={shownTotals} columns={TOTALS} layout={layout} onSite={(id) => { setSite(id); setSort(null); }} then={then?.totals || null} thenLoaded={thenLoaded} compare={compare} />
          <div style={{ display: 'grid', gap: 4, fontSize: 12.5, color: 'var(--t3)', margin: '8px 2px' }}>
            {plateNotes.map((n) => (
              <div key={n.location_id}>
                {n.day
                  ? `${nameOf(n.location_id)}: ${PLATE_LINE} ${dayWords(n.day)}. Those days are left out of the product figures, never shown as 100% GP.`
                  : `${nameOf(n.location_id)}: plate cost not known yet. No sale has taken stock off there, so no GP is shown.`}
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0 10px' }}>
            <b style={{ fontSize: 14 }}>
              {tab === 'gp' ? (site ? `Products at ${nameOf(site)}` : perSite ? 'Products, a GP % column per site' : 'Products, company total') : tab === 'spread' ? 'The same product at each site' : 'Menu engineering'}
            </b>
            {site && <Pill tone="neutral" style={{ cursor: 'pointer' }} title="Back to every site"><span onClick={() => { setSite(null); setSort(null); }}>Every site</span></Pill>}
            {tab === 'gp' && perSite && !oneCurrency && <span style={{ fontSize: 12, color: 'var(--t4)' }}>Shown per currency: the company cells add sites of one currency only.</span>}
          </div>

          {tab === 'engineering' && summary && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 12 }}>
              {[...CLASSES, 'Unknown'].map((c) => (
                <div key={c} style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 12, color: 'var(--t3)', display: 'flex', gap: 6, alignItems: 'center' }}><Pill tone={CLASS_WORDS[c].tone}>{CLASS_WORDS[c].label}</Pill></span>
                  <span style={{ fontSize: 22, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtInt(summary[c].count)}</span>
                  <span style={{ fontSize: 12, color: 'var(--t4)' }}>{CLASS_WORDS[c].blurb} {CLASS_WORDS[c].action}</span>
                  {c !== 'Unknown' && oneCurrency && <span style={{ fontSize: 12, color: 'var(--t3)' }}>GP {money(summary[c].gp, currency)}</span>}
                </div>
              ))}
            </div>
          )}

          <DrillTable columns={cols} rows={sortLoaded(shownRows, sort, SORT_KEYS)} next={next} onMore={more} busy={moreBusy} capped={capped} sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))} />
        </>
      )}
      {ex.panel}
    </StockReportFrame>
  );
}
