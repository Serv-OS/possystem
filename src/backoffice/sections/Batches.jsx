/**
 * Batches (Produce > Batches, 'Batch and prep' for a multi site company): the router (multi site
 * stock Drop 2, v5.11.91, contract 3.1).
 *
 *   scope not loaded yet  the Loading line
 *   one site company      BatchesSite: today's screen, byte for byte
 *                         (src/lib/stock/oneSiteIdentityBatches.test.js proves it)
 *   All sites or a group  BatchHowGrid: batch and prep recipes by site, one choice per site
 *                         (Bought in, Made in batches here, Made to order here)
 *   one site picked       BatchesSite for that site inside BatchSiteTools (Prep list, Print labels),
 *                         keyed on the site so its mount loads run again on a picker change
 *
 * No StockSiteGate: on All sites the router shows the company view.
 */

import { useStockScope } from '../StockScope';
import BatchesSite from './produce/BatchesSite';
import BatchHowGrid from './produce/BatchHowGrid';
import BatchSiteTools from './produce/BatchSiteTools';

export default function Batches({ orgCtx = null, siteId = null } = {}) {
  const sc = useStockScope();
  if (!sc.ready) return <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>;
  if (!sc.multi) return <BatchesSite siteId={siteId} />;
  if (!sc.oneSite) return <BatchHowGrid orgCtx={orgCtx} />;
  return <BatchSiteTools siteId={sc.oneSite.id} orgCtx={orgCtx}><BatchesSite key={sc.oneSite.id} siteId={sc.oneSite.id} /></BatchSiteTools>;
}
