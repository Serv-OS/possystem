// src/backoffice/sections/stock/PickASite.jsx
//
// MULTI SITE STOCK (v5.11.89, Drop 1, map 3.4): a screen that works one site at a time (Counts,
// Wastage, Transfers, Areas, Order pad, Orders, Invoices, Price changes, Recipes, Batches,
// Inventory > Reports) shows this on All sites or a group, in place of the screen. Pressing a site
// moves the picker there. A one site company never sees it (StockSiteGate).

import { useStockScope } from '../../StockScope';
import { Btn } from '../msm/msmUi';
import { ui } from '../msm/msmStyle';

export default function PickASite() {
  const sc = useStockScope();
  const sites = sc.scopeSites || [];
  const closedIds = new Set((sc.closedSites || []).map((s) => s.id));
  const pick = (id) => sc.setChoice(closedIds.has(id) ? { kind: 'site', id, closed: true } : { kind: 'site', id });
  return (
    <div style={{ ...ui.page, background: 'var(--bg0)' }} data-testid="stock-pick-a-site">
      <div style={{ ...ui.card, maxWidth: 640 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 12 }}>This screen works one site at a time.</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {sites.map((s) => <Btn key={s.id} kind="soft" onClick={() => pick(s.id)}>{s.name || 'Site'}</Btn>)}
          {sites.length === 0 && <div style={{ ...ui.sub }}>No site is in your list.</div>}
        </div>
      </div>
    </div>
  );
}
