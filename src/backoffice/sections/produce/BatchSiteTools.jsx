/**
 * The strip over a MULTI SITE company's one site Batches screen (multi site stock Drop 2, v5.11.91,
 * contract 3.3): Prep list (today's suggested amounts, with Done ticks) and Print labels (the batch
 * label and the PPDS label on the Label printer role). The children (produce/BatchesSite.jsx,
 * today's screen) render under it unchanged.
 *
 * The Batch and prep grid's Prep list button leaves an open record on the scope (go('batches',
 * { open: { prepList: true } })) before it asks which site, so the prep list is open when this
 * strip first renders for that site. A one site company never gets the strip (Batches.jsx routes
 * them straight to BatchesSite).
 */

import { useEffect, useState } from 'react';
import { useStockScope } from '../../StockScope';
import { Btn } from '../stock/stockUi';
import PrepList from './PrepList';
import BatchLabels from './BatchLabels';

const strip = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '10px 26px 0', background: 'var(--bg0)' };
const inner = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '8px 12px', borderRadius: 10, background: 'var(--bg2)', color: 'var(--t3)', fontSize: 13, width: '100%', boxSizing: 'border-box' };

export default function BatchSiteTools({ siteId, orgCtx, children }) {
  const sc = useStockScope();
  const [prepOpen, setPrepOpen] = useState(() => !!sc.peekOpen?.('batches')?.prepList);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const take = sc.takeOpen;
  useEffect(() => { take?.('batches'); }, [take, siteId]);

  if (!sc.multi) return children;
  const siteName = sc.siteName(siteId) || 'this site';
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg0)' }}>
      <div style={strip}>
        <div style={inner} data-testid="batch-site-tools">
          <span style={{ flex: '1 1 200px', minWidth: 0 }}>Batches at <b style={{ color: 'var(--t1)' }}>{siteName}</b>. Every batch made here is logged on this screen.</span>
          <Btn small kind="soft" onClick={() => setPrepOpen(true)}>Prep list</Btn>
          <Btn small kind="soft" onClick={() => setLabelsOpen(true)}>Print labels</Btn>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
      {prepOpen && <PrepList siteId={siteId} onClose={() => setPrepOpen(false)} />}
      {labelsOpen && <BatchLabels siteId={siteId} madeBy={orgCtx?.userName || null} onClose={() => setLabelsOpen(false)} />}
    </div>
  );
}
