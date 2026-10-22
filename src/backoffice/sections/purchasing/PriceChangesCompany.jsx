// purchasing/PriceChangesCompany.jsx: Purchasing > Price changes for a multi site company (multi site
// stock Drop 3, v5.11.96, contract 3.2 and 4.2). Tabs Supplier prices (every site) and Cost per unit
// (today's screen for the picked site). Arriving from a price rise alert focuses that row.

import { useEffect, useState } from 'react';
import { useStockScope } from '../../StockScope';
import { normFocus } from '../../../lib/stock/stockAlertLinks';
import { PageHead, TabBar, ui } from '../stock/stockUi';
import PickASite from '../stock/PickASite';
import SupplierPricesTab from './SupplierPricesTab';
import PriceChangesSite from './PriceChangesSite';

export default function PriceChangesCompany({ orgCtx = null }) {
  const sc = useStockScope();
  // { tab: 'supplier', supplierItemId, locationId } from the price_rise alert (peeked, taken once)
  const [focus] = useState(() => normFocus('price-changes', sc.peekOpen?.('price-changes') || null));
  const [tab, setTab] = useState(() => (focus?.tab === 'cost' ? 'cost' : 'supplier'));
  useEffect(() => { sc.takeOpen?.('price-changes'); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={ui.page}>
      <PageHead title="Price changes" sub="Every price change at every site, from invoices, edits and dated prices." />
      <TabBar tabs={[{ id: 'supplier', label: 'Supplier prices' }, { id: 'cost', label: 'Cost per unit' }]} value={tab} onChange={setTab} />
      {tab === 'supplier' && <SupplierPricesTab orgCtx={orgCtx} focus={focus} />}
      {tab === 'cost' && (sc.oneSite?.id ? <PriceChangesSite key={sc.oneSite.id} siteId={sc.oneSite.id} /> : <PickASite />)}
    </div>
  );
}
