// src/backoffice/sections/stock/ShelfOrderEditor.jsx
//
// MULTI SITE STOCK (v5.11.96, Drop 3, contract 3.3 and 4.3, map I2): one site's own shelf order for a
// company count template. The company sets the list once; each site puts the items in the order it
// walks its shelves (stock_save_shelf_order). The company template never changes here, and nothing
// here moves a stock or count number.

import { useEffect, useState } from 'react';
import { useStore } from '../../../store';
import { stockApi } from '../../../lib/stock/stockApi';
import { moveItem } from '../../../lib/stock/countPlanRules';
import { useStockScope } from '../../StockScope';
import { Sheet, Btn, ui, ErrorLine, EmptyLine } from './stockUi';

export default function ShelfOrderEditor({ templateId, siteId, onClose }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const [items, setItems] = useState(null);     // [{ itemId, name, area }]
  const [missing, setMissing] = useState(0);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [drag, setDrag] = useState(null);

  useEffect(() => {
    let live = true;
    stockApi.templateForSite(templateId, siteId).then((r) => {
      if (!live) return;
      if (r.error) { setError(r.error); setItems([]); return; }
      const rows = Array.isArray(r.data?.items) ? r.data.items : [];
      setItems(rows.map((x) => ({ itemId: x.item_id, name: x.name || '(item)', area: x.area_name || x.area || '' })).filter((x) => x.itemId));
      setMissing(Array.isArray(r.data?.missing) ? r.data.missing.length : 0);
    });
    return () => { live = false; };
  }, [templateId, siteId]);

  const move = (from, to) => { setItems((list) => moveItem(list, from, to)); setDirty(true); };
  const save = async () => {
    setBusy(true);
    const r = await stockApi.saveShelfOrder(templateId, siteId, (items || []).map((x) => x.itemId));
    setBusy(false);
    if (r.error) { showToast?.(r.error.message, 'error'); return; }
    setDirty(false);
    showToast?.('Shelf order saved.', 'success');
    onClose?.();
  };

  return (
    <Sheet title={`Shelf order at ${sc.siteName(siteId) || 'this site'}`} sub="The company sets the list once. Each site drags items into its own shelf order." width={520} onClose={onClose} dirty={dirty && !busy}
      footer={<><Btn onClick={onClose} disabled={busy} style={{ marginLeft: 'auto' }}>Cancel</Btn><Btn kind="primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving...' : 'Save'}</Btn></>}>
      <ErrorLine error={error} />
      {items === null && <div style={{ fontSize: 13, color: 'var(--t3)' }}>Loading…</div>}
      {items && items.length === 0 && !error && <EmptyLine>None of this template's items are at this site.</EmptyLine>}
      {missing > 0 && <div style={{ ...ui.sub, marginBottom: 10 }}>{missing} item{missing === 1 ? ' is' : 's are'} on the template but not at this site.</div>}
      {(items || []).map((x, i) => (
        <div key={x.itemId} draggable onDragStart={() => setDrag(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (drag != null) move(drag, i); setDrag(null); }}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid var(--bdr)', borderRadius: 8, marginBottom: 4, background: drag === i ? 'var(--bg2)' : 'var(--bg1)', cursor: 'grab' }}>
          <span style={{ width: 24, fontSize: 12, color: 'var(--t3)', textAlign: 'right' }}>{i + 1}</span>
          <span style={{ flex: 1, fontSize: 13 }}>{x.name}{x.area && <span style={{ color: 'var(--t3)' }}> · {x.area}</span>}</span>
          <Btn small kind="soft" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={`Move ${x.name} up`}>Up</Btn>
          <Btn small kind="soft" disabled={i === items.length - 1} onClick={() => move(i, i + 1)} aria-label={`Move ${x.name} down`}>Down</Btn>
        </div>
      ))}
    </Sheet>
  );
}
