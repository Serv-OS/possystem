// src/backoffice/sections/stock/items/MakeNewItemModal.jsx
//
// MULTI SITE STOCK Drop 2 (contract 3.4, decision 7): the allergen rule says every supplier item on
// one stock item must declare the same allergens. When one differs, it becomes its own stock item
// so each site buys what it says ("Brioche bun" and "Brioche bun, sesame (Hill Bakery)" are two
// items, and a site that buys the sesame bun gets its own recipe).
//   Make it   three saves, in order: stock_save_item (the new company item, the same base unit,
//             category and type, at the ticked sites), stock_save_supplier_item (a copy of this
//             supplier pack with its facts, under the new item), stock_archive_supplier_item (the
//             old pack is archived, never deleted: orders and invoices keep it). When a later save
//             fails the words say what did not happen and nothing is undone.
// No stock number moves: the new item starts at on hand 0 everywhere.

import { useMemo, useState } from 'react';
import { useStore } from '../../../../store';
import { useStockScope } from '../../../StockScope';
import { stockApi } from '../../../../lib/stock/stockApi';
import { checklistGroups, siteList, sortSites } from '../../../../lib/stock/itemListRules';
import { OLD_PACK_WORDS, allergenWords, factsOf, madeNewItemWords, makeNewItemPlan, newItemName, supplierItemSiteIds } from '../../../../lib/stock/factsRules';
import { Btn, Modal, SiteChecklist, Field, Notice, ui } from '../stockUi';

export default function MakeNewItemModal({ detail, supplierItem, onDone, onClose }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const item = detail?.item || {};
  const si = useMemo(() => supplierItem || {}, [supplierItem]);
  const facts = useMemo(() => factsOf(si), [si]);
  const sites = useMemo(() => sortSites(siteList(sc.sites, sc.siteName)), [sc.sites, sc.siteName]);
  const groups = useMemo(() => checklistGroups(sc.groups, sites.map((s) => s.id)), [sc.groups, sites]);
  const known = (ids) => (ids || []).filter((id) => sites.some((s) => s.id === id));
  const [name, setName] = useState(() => newItemName(item.name, si.supplier_name));
  const [chosen, setChosen] = useState(() => {
    const pre = known(supplierItemSiteIds(si));
    return pre.length ? pre : known((detail?.sites || []).filter((s) => s.on_here).map((s) => s.location_id));
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const say = (words, tone = 'success') => { try { showToast?.(words, tone); } catch { /* no toast, no harm */ } };

  const make = async () => {
    const plan = makeNewItemPlan(detail, si, { name, siteIds: chosen });
    if (plan.error) { setError(plan.error); return; }
    setBusy(true); setError('');
    const made = await stockApi.saveItem({ item: plan.item, sites: plan.sites, version: null });
    if (made.error) { setBusy(false); setError(made.error.message); return; }
    const id = made.data?.id || null;
    const at = plan.item.location_id;
    const missed = [];
    if (!id) missed.push('The new item saved but its id did not come back. Open it from the list to add the supplier pack.');
    if (id) {
      const copy = await stockApi.saveSupplierItem({ ...plan.si, item_id: id, location_id: at }, null, 'inventory');
      if (copy.error) missed.push(`The supplier pack did not copy under it: ${copy.error.message} The old pack stays where it is.`);
      else {
        const old = await stockApi.archiveSupplierItem(si.id, si.row_version ?? null, true, 'inventory');
        if (old.error) missed.push(`The old supplier pack was not archived: ${old.error.message}`);
      }
    }
    setBusy(false);
    say(madeNewItemWords(plan.item.name, si.supplier_name, missed), missed.length ? 'warning' : 'success');
    onDone?.(id, { missed });
  };

  return (
    <Modal title="Make it a new item" sub={`${si.supplier_name || 'This supplier'}'s ${item.name || 'item'}`} onClose={busy ? () => {} : onClose} width={620} dirty={!busy}
      footer={<><span style={{ flex: 1 }} /><Btn onClick={onClose} disabled={busy}>Cancel</Btn><Btn kind="primary" onClick={make} disabled={busy || !name.trim() || !chosen.length}>{busy ? 'Making…' : 'Make it'}</Btn></>}>
      <Notice tone="info">
        {si.supplier_name || 'This supplier'}'s pack says: allergens {allergenWords(facts.allergens)}{facts.may_contain.length ? `, may contain ${allergenWords(facts.may_contain)}` : ''}.
        {' '}It becomes its own stock item with the same base unit, category and type, so each site buys what it says.
      </Notice>
      <div style={{ height: 12 }} />
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" style={ui.input} autoFocus />
      </Field>
      <Field label="Sites" hint={`Pre ticked where ${si.supplier_name || 'this supplier'} delivers this now. Each ticked site gets the new item at once, on hand 0.`}>
        <SiteChecklist sites={sites} value={chosen} onChange={setChosen} groups={groups} />
      </Field>
      <div style={ui.sub}>{OLD_PACK_WORDS} Recipes at those sites still use {item.name || 'the old item'} until you swap the ingredient.</div>
      {error && <div style={{ ...ui.err, marginTop: 10 }}>{error}</div>}
    </Modal>
  );
}
