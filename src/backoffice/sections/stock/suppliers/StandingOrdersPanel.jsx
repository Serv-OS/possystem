// stock/suppliers/StandingOrdersPanel.jsx: the Standing orders block under a supplier's order rules
// (multi site stock Drop 3, v5.11.96, contract 3.2 and 4.2, map C16 and F5). Each site's standing
// orders with this supplier: what, which delivery days, sent by us at the order by time and
// changeable until then (or held by the supplier, no email). Add a standing order, Pause, Skip next.
// A site sets its own (site facts); the database refuses a day the supplier does not deliver.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../../store';
import { useStockScope } from '../../../StockScope';
import { stockApi } from '../../../../lib/stock/stockApi';
import { fetchInventoryItems } from '../../../../lib/stock/data';
import { siteRows } from '../../../../lib/stock/supplierListRules';
import { nextDelivery, dayWords } from '../../../../lib/stock/purchasingRules';
import { standingRowWords } from '../../../../lib/stock/purchasingWords';
import { buildScheduleCtx } from '../../../../lib/locationTime';
import { Btn, Pill, Field, Modal, ErrorLine, EmptyLine, ui } from '../stockUi';

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function StandingForm({ supplier, rows, initial, onDone, onClose }) {
  const [siteId, setSiteId] = useState(initial?.location_id || rows[0]?.site.id || '');
  const row = rows.find((r) => r.site.id === siteId) || null;
  const delivers = useMemo(() => [...new Set((row?.link?.rules || []).map((r) => Number(r.delivery_dow)))].sort(), [row]);
  const [name, setName] = useState(initial?.name || '');
  const [dows, setDows] = useState(initial?.delivery_dows || []);
  const [lines, setLines] = useState(() => (initial?.stock_standing_order_lines || []).map((l) => ({ inventory_item_id: l.inventory_item_id, supplier_product_id: l.supplier_product_id, qty_packs: String(l.qty_packs) })));
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let on = true;
    if (!siteId) return undefined;
    fetchInventoryItems(siteId).then((r) => { if (on) setItems((r.data || []).filter((i) => !i.archivedAt && (i.supplierProducts || []).some((p) => p.supplierId === row?.link?.site_supplier_id))); });
    return () => { on = false; };
  }, [siteId, row?.link?.site_supplier_id]);
  const spOf = (itemId) => (items.find((i) => i.id === itemId)?.supplierProducts || []).find((p) => p.supplierId === row?.link?.site_supplier_id) || null;
  const save = async () => {
    const good = lines.filter((l) => l.inventory_item_id && Number(l.qty_packs) > 0);
    if (!siteId || !dows.length || !good.length) { setError(new Error('Pick the site, at least one delivery day and one line.')); return; }
    setBusy(true); setError(null);
    const r = await stockApi.saveStandingOrder({
      ...(initial?.id ? { id: initial.id } : {}), location_id: siteId, supplier_id: row?.link?.site_supplier_id, name: name.trim() || null, delivery_dows: dows,
      active: initial?.active ?? true, paused_until: initial?.paused_until ?? null, note: initial?.note ?? null,
      lines: good.map((l) => ({ inventory_item_id: l.inventory_item_id, supplier_product_id: l.supplier_product_id || spOf(l.inventory_item_id)?.id || null, qty_packs: Number(l.qty_packs) })),
    }, initial?.row_version ?? null);
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    onDone?.();
  };
  return (
    <Modal title={initial?.id ? 'Standing order' : 'Add a standing order'} sub={`With ${supplier?.name || 'this supplier'}. Sent by us at the order by time, changeable until then.`} onClose={onClose} width={620} dirty
      footer={<><Btn onClick={onClose}>Cancel</Btn><span style={{ marginLeft: 'auto' }} /><Btn kind="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Btn></>}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Field label="Site">
          <select value={siteId} disabled={!!initial?.id} onChange={(e) => { setSiteId(e.target.value); setDows([]); setLines([]); }} style={{ ...ui.input, width: 200 }} aria-label="Site">
            {rows.map((r) => <option key={r.site.id} value={r.site.id}>{r.site.name}</option>)}
          </select>
        </Field>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily milk" style={{ ...ui.input, width: 220 }} aria-label="Name" /></Field>
      </div>
      <Field label="Delivery days" hint={delivers.length ? null : 'This supplier has no delivery days at this site yet.'}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {delivers.map((d) => (
            <label key={d} style={{ fontSize: 13, display: 'inline-flex', gap: 5, alignItems: 'center' }}>
              <input type="checkbox" checked={dows.includes(d)} onChange={(e) => setDows((ds) => (e.target.checked ? [...ds, d].sort() : ds.filter((x) => x !== d)))} /> {DAY[d]}
            </label>
          ))}
        </div>
      </Field>
      {lines.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
          <select value={l.inventory_item_id || ''} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, inventory_item_id: e.target.value, supplier_product_id: spOf(e.target.value)?.id || null } : x)))} style={{ ...ui.input, flex: 1 }} aria-label="Item">
            <option value="">Pick an item</option>
            {items.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
          </select>
          <input inputMode="decimal" value={l.qty_packs} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty_packs: e.target.value } : x)))} placeholder="Packs" style={{ ...ui.input, width: 90, textAlign: 'right' }} aria-label="Packs" />
          <Btn small kind="link" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove</Btn>
        </div>
      ))}
      <Btn small onClick={() => setLines((ls) => [...ls, { inventory_item_id: '', supplier_product_id: null, qty_packs: '1' }])}>Add a line</Btn>
      <ErrorLine error={error} />
    </Modal>
  );
}

export default function StandingOrdersPanel({ detail, reload }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const supplier = detail?.supplier || {};
  const held = supplier.order_method === 'held';
  const rows = useMemo(() => siteRows(sc.sites || [], detail?.sites || []).filter((r) => r.on && r.link?.site_supplier_id), [sc.sites, detail]);
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [names, setNames] = useState({});
  const fetchAll = useCallback(() => Promise.all(rows.slice(0, 50).map((r) => stockApi.standingOrders(r.site.id, r.link.site_supplier_id))), [rows]);
  const apply = useCallback((got) => {
    const bad = got.find((g) => g.error && !g.needsUpdate);
    setError(bad?.error || null);
    setList(got.flatMap((g) => (g.error ? [] : g.data || [])));
  }, []);
  const load = useCallback(() => fetchAll().then(apply), [fetchAll, apply]);
  useEffect(() => {
    let on = true;
    fetchAll().then((got) => { if (on) apply(got); });
    return () => { on = false; };
  }, [fetchAll, apply]);
  useEffect(() => {
    let on = true;
    const sites = [...new Set((list || []).map((so) => so.location_id))];
    if (!sites.length) return undefined;
    Promise.all(sites.map((id) => fetchInventoryItems(id))).then((all) => {
      if (on) setNames(Object.fromEntries(all.flatMap((r) => (r.data || []).map((i) => [i.id, i.name]))));
    });
    return () => { on = false; };
  }, [list]);
  const nextDay = (so) => {
    const row = rows.find((r) => r.site.id === so.location_id);
    const rules = (row?.link?.rules || []).filter((r) => (so.delivery_dows || []).includes(Number(r.delivery_dow)));
    return nextDelivery({ rules, nowVenue: buildScheduleCtx(null) })?.deliveryYmd || null;
  };
  const pause = async (so) => {
    const r = await stockApi.saveStandingOrder({ id: so.id, location_id: so.location_id, supplier_id: so.supplier_id, name: so.name, delivery_dows: so.delivery_dows, active: !so.active, paused_until: null, note: so.note,
      lines: (so.stock_standing_order_lines || []).map((l) => ({ inventory_item_id: l.inventory_item_id, supplier_product_id: l.supplier_product_id, qty_packs: Number(l.qty_packs) })) }, so.row_version ?? null);
    if (r.error) { showToast?.(r.error.message, 'error'); return; }
    showToast?.(so.active ? 'Paused. Nothing is sent until you start it again.' : 'Started again.', 'success');
    load(); reload?.();
  };
  const skipNext = async (so) => {
    const day = nextDay(so);
    if (!day) { showToast?.('No delivery coming up for this standing order.', 'info'); return; }
    const r = await stockApi.editStandingRun(so.id, day, { skip: true });
    showToast?.(r.error ? r.error.message : `Skipped the delivery on ${dayWords(day)}.`, r.error ? 'error' : 'success');
  };
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Standing orders</div>
        <span style={{ marginLeft: 'auto' }} />
        {rows.length > 0 && <Btn small kind="primary" onClick={() => setForm({})}>Add a standing order</Btn>}
      </div>
      <ErrorLine error={error} />
      {list === null ? <EmptyLine>Loading…</EmptyLine> : !list.length ? <EmptyLine>No standing orders with this supplier.</EmptyLine> : (
        <div style={{ display: 'grid', gap: 8 }}>
          {list.map((so) => (
            <div key={so.id} style={{ ...ui.card, padding: '10px 14px', borderRadius: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 320px', fontSize: 13 }}>
                {so.name ? <b>{so.name}. </b> : null}
                {standingRowWords({ siteName: sc.siteName(so.location_id), lines: (so.stock_standing_order_lines || []).map((l) => ({ qty_packs: l.qty_packs, name: names[l.inventory_item_id] || 'item' })), dows: so.delivery_dows, held })}
              </div>
              {!so.active && <Pill tone="neutral">Paused</Pill>}
              <Btn small onClick={() => setForm(so)}>Change</Btn>
              <Btn small onClick={() => pause(so)}>{so.active ? 'Pause' : 'Start again'}</Btn>
              {so.active && <Btn small onClick={() => skipNext(so)}>Skip next</Btn>}
            </div>
          ))}
        </div>
      )}
      {form && <StandingForm supplier={supplier} rows={rows} initial={form.id ? form : null} onDone={() => { setForm(null); load(); }} onClose={() => setForm(null)} />}
    </div>
  );
}
