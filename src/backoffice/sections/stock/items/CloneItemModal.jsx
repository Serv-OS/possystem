// src/backoffice/sections/stock/items/CloneItemModal.jsx
//
// MULTI SITE STOCK Drop 1 (contract decision 11): a copy of a company item with its packs, unit
// bridges and suppliers, at the sites ticked here (pre ticked from the picker). A company item with
// no site would be archived by the nightly step, so the copy always starts at one site at least.
// Steps, each through a save function: stock_save_item (create with sites), then each pack (parents
// first), each bridge, each supplier item, then its main supplier. A later step failing says what
// did not save, in the database's words: 'Item saved. Its packs did not save: <words>'.
// SKU and barcode are left empty on the copy, so scans and imports still find the first one.
// Each ticked site keeps how it gets the item (Purchased or made, Sold directly: cloneSiteKinds), so
// a copy of a made item is made too.

import { useMemo, useState } from 'react';
import { useStore } from '../../../../store';
import { useStockScope } from '../../../StockScope';
import { stockApi } from '../../../../lib/stock/stockApi';
import { cloneSiteKinds } from '../../../../lib/stock/itemPageRules';
import { Btn, Modal, Field, SiteChecklist, Notice, ui } from '../stockUi';

/** Packs in an order where a pack's parent is always saved before it. */
function parentsFirst(packs) {
  const left = [...packs];
  const out = [];
  const done = new Set();
  let guard = left.length + 1;
  while (left.length && guard-- > 0) {
    for (let i = 0; i < left.length; i++) {
      const p = left[i];
      if (!p.parent_pack_id || done.has(p.parent_pack_id) || !packs.some((x) => x.id === p.parent_pack_id)) {
        out.push(p); done.add(p.id); left.splice(i, 1); i--;
      }
    }
  }
  return [...out, ...left];
}

export default function CloneItemModal({ detail, sites, onDone, onClose }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const item = detail?.item || {};
  const list = useMemo(() => (sites || sc.sites || []).map((s) => ({ id: s.id, name: s.name })), [sites, sc.sites]);
  const preTicked = useMemo(() => {
    const inPicker = new Set((sc.scopeSites || []).map((s) => s.id));
    const ids = list.filter((s) => inPicker.has(s.id)).map((s) => s.id);
    return ids.length ? ids : list.map((s) => s.id);
  }, [list, sc.scopeSites]);
  const [name, setName] = useState(`${item.name || 'Item'} (copy)`);
  const [ids, setIds] = useState(preTicked);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const say = (words, tone = 'success') => { try { showToast?.(words, tone); } catch { /* no toast, no harm */ } };

  const run = async () => {
    setProblem(null);
    if (!name.trim()) { setProblem('Give the copy a name.'); return; }
    const ticked = list.filter((s) => ids.includes(s.id)).map((s) => s.id);
    if (!ticked.length) { setProblem('Tick at least one site.'); return; }
    const loc = ticked[0];
    setBusy(true);
    const fields = {
      location_id: loc, name: name.trim(), base_unit: item.base_unit,
      ...(item.category_id ? { category_id: item.category_id } : {}),
      type: item.type || null, shelf_life_days: item.shelf_life_days ?? null, purchase_vat_rate: item.purchase_vat_rate ?? null,
      allergens: Array.isArray(item.allergens) ? item.allergens : [], notes: item.notes || null,
      exclude_from_gp: item.exclude_from_gp === true, key_item: item.key_item === true, returns_to_shelf: item.returns_to_shelf === true,
    };
    // how each site gets it: the first site's kind goes to every site at once, then any site that differs
    const kinds = cloneSiteKinds(detail, ticked);
    const first = kinds[0];
    const made = await stockApi.saveItem({
      item: { ...fields, site: { kind: first.kind, is_sellable: first.is_sellable } },
      sites: ticked.map((id) => ({ location_id: id, on: true })),
    });
    if (made.error || !made.data?.id) { setBusy(false); setProblem(made.error?.message || 'The copy did not save. Try again.'); return; }
    const newId = made.data.id;
    let version = made.data.row_version ?? null;
    const failed = [];
    for (const k of kinds.slice(1).filter((x) => x.kind !== first.kind || x.is_sellable)) {
      const r = await stockApi.saveItem({ item: { id: newId, location_id: k.location_id, site: { kind: k.kind, is_sellable: k.is_sellable } }, version });
      if (r.error) { failed.push(`How ${list.find((s) => s.id === k.location_id)?.name || 'a site'} gets it did not save: ${r.error.message}`); break; }
      version = r.data?.row_version ?? version;
    }

    // packs, parents first, each pointing at the copy's own parent pack
    const packIds = {};
    for (const p of parentsFirst((detail?.packs || []).filter((x) => x && !x.archived_at))) {
      const r = await stockApi.savePack({
        item_id: newId, location_id: loc, name: p.name, qty_in_base: Number(p.qty_in_base),
        parent_pack_id: p.parent_pack_id ? (packIds[p.parent_pack_id] || null) : null,
        is_count_default: p.is_count_default === true, is_purchase_default: p.is_purchase_default === true,
      }, null);
      if (r.error) { failed.push(`Its packs did not save: ${r.error.message}`); break; }
      packIds[p.id] = r.data?.id || null;
    }
    for (const b of (detail?.bridges || []).filter((x) => x && !x.archived_at)) {
      const r = await stockApi.saveBridge({ item_id: newId, location_id: loc, from_qty: Number(b.from_qty), from_unit: b.from_unit, to_qty: Number(b.to_qty), to_unit: b.to_unit }, null);
      if (r.error) { failed.push(`Its unit bridges did not save: ${r.error.message}`); break; }
    }
    const siIds = {};
    for (const si of (detail?.supplier_items || []).filter((x) => x && !x.archived_at)) {
      const r = await stockApi.saveSupplierItem({
        item_id: newId, supplier_id: si.supplier_id, location_id: loc,
        supplier_sku: si.sku || null, supplier_product_name: si.supplier_product_name || null, pack_description: si.pack_description || null,
        pack_qty: Number(si.pack_qty) || 1, inner_qty: Number(si.inner_qty) || 1, inner_unit: si.inner_unit,
        pack_price: Number(si.pack_price) || 0, currency: si.currency, purchase_vat_rate: si.purchase_vat_rate ?? null,
        price_includes_tax: si.price_includes_tax === true,
      }, null, 'inventory');
      if (r.error) { failed.push(`Its suppliers did not save: ${r.error.message}`); break; }
      siIds[si.id] = r.data?.id || null;
    }
    const mainNew = item.main_supplier_item_id ? siIds[item.main_supplier_item_id] : null;
    if (mainNew) {
      const r = await stockApi.saveItem({ item: { id: newId, location_id: loc, main_supplier_item_id: mainNew }, version });
      if (r.error) failed.push(`Its main supplier did not save: ${r.error.message}`);
      else version = r.data?.row_version ?? version;
    }
    setBusy(false);
    const n = ticked.length;
    if (failed.length) say(`Item saved. ${failed.join(' ')}`, 'error');
    else say(`${name.trim()} saved. It is on ${n} site${n === 1 ? "'s" : "s'"} count sheet${n === 1 ? '' : 's'} and Order pad${n === 1 ? '' : 's'} now.`);
    onDone?.(newId);
  };

  return (
    <Modal title={`Clone ${item.name || 'item'}`} sub="A copy of this item with its packs and suppliers. Tick the sites it starts at." onClose={busy ? () => {} : onClose} width={560}
      footer={<><span style={{ flex: 1 }} /><Btn onClick={onClose} disabled={busy}>Cancel</Btn><Btn kind="primary" onClick={run} disabled={busy}>{busy ? 'Saving…' : 'Clone'}</Btn></>}>
      <Field label="Name" hint="SKU and barcode are left empty, so scans and imports still find the first one.">
        <input value={name} onChange={(e) => setName(e.target.value)} style={ui.input} />
      </Field>
      <Field label="Sites" hint="Pre ticked from the picker.">
        <SiteChecklist sites={list} value={ids} onChange={setIds}
          groups={(sc.groups || []).map((g) => ({ id: g.id, name: g.name, location_ids: g.locationIds || g.location_ids || [] }))} />
      </Field>
      {problem && <Notice tone="bad">{problem}</Notice>}
    </Modal>
  );
}
