// src/backoffice/sections/stock/items/ItemSuppliersTab.jsx
//
// MULTI SITE STOCK Drop 1 (mockup scrItem 'suppliers'): one row per company supplier item of this
// stock item. Supplier, Their name, SKU, Pack, Company price (in the pack people use, with the
// supplier's own pack price under it), Next price (the earliest waiting dated price), Main, Status
// (Available or Paused).
//   + Add another supplier  a side panel: a supplier from the company list or a new one, their name,
//                           SKU, pack, packs per case, price, VAT; stock_save_supplier_item in the
//                           company form (a new supplier first through stock_save_supplier).
//   Main                    sets main_supplier_item_id through stock_save_item.
//   What is in it           (Drop 2, contract 3.4) an expander under each row: the 14 allergens, May
//                           contain, Diets, the ingredient list and nutrition per 100 g on THAT
//                           supplier item (items/WhatIsInIt.jsx), because each site's allergens come
//                           from what it buys.
//   The allergen rule       (Drop 2) every supplier item on one stock item must declare the same
//                           allergens. When two differ (stock_item_detail facts.differ) a Notice
//                           says which has what, with 'Make it a new item' (items/MakeNewItemModal.jsx).
// A login that cannot change company records sees the table and no buttons (LockLine on ItemPage).

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../../store';
import { useStockScope } from '../../../StockScope';
import { stockApi } from '../../../../lib/stock/stockApi';
import { UNITS, DIMENSIONS } from '../../../../lib/stock/units';
import { countPackOf, packAmount, packPrice, moneyText } from '../../../../lib/stock/packPrice';
import { nextPriceWords, vatChoices, sameRate, queuedNote } from '../../../../lib/stock/itemPageRules';
import { allergenWords, differRule, factsOf } from '../../../../lib/stock/factsRules';
import { Btn, Pill, Sheet, Field, Notice, TableWrap, Th, Td, EmptyLine, useConfirm, ui } from '../stockUi';
import WhatIsInIt from './WhatIsInIt';
import MakeNewItemModal from './MakeNewItemModal';

const UNIT_OPTS = Object.entries(UNITS).map(([code, u]) => ({ code, ...u }));
const DIM_ORDER = [DIMENSIONS.COUNT, DIMENSIONS.WEIGHT, DIMENSIONS.VOLUME];
const small = { fontSize: 11.5, color: 'var(--t4)', marginTop: 3, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };
const linkBtn = { background: 'none', border: 'none', padding: 0, color: 'var(--t1)', fontWeight: 700, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', fontSize: 13 };
const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

const packWords = (si) => si?.pack_description || `${Number(si?.pack_qty) || 1} x ${Number(si?.inner_qty) || 1} ${si?.inner_unit || ''}`.trim();

const blankRow = (baseUnit) => ({
  id: null, supplier_id: '', newSupplier: '', supplier_product_name: '', supplier_sku: '', inner_qty: '1', inner_unit: baseUnit || 'each',
  pack_qty: '1', pack_description: '', pack_price: '', purchase_vat_rate: null, price_includes_tax: false, paused: false, rowVersion: null,
});

export default function ItemSuppliersTab({ detail, editable = false, reload, homeSiteId = null, tz = null }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const storeRates = useStore((s) => s.taxRates);
  const item = detail?.item || {};
  const countPack = countPackOf(detail);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [openFacts, setOpenFacts] = useState(() => new Set());
  const [makeNew, setMakeNew] = useState(null);
  const [confirm, confirmDialog] = useConfirm();
  const say = (words, tone = 'success') => { try { showToast?.(words, tone); } catch { /* no toast, no harm */ } };
  const rows = (detail?.supplier_items || []).filter((s) => s && !s.archived_at);
  const currencyHere = (sc.siteById && typeof sc.siteById.get === 'function' ? sc.siteById.get(homeSiteId)?.currency : null) || null;
  // the allergen rule: two live supplier items with different allergen sets (the database's facts.differ)
  const rule = differRule(detail?.facts, item.name);
  const ruleSi = rule ? (rows.find((s) => s.id === rule.supplierItemId) || rows.find((s) => s.supplier_name === rule.supplierB) || null) : null;
  const toggleFacts = (id) => setOpenFacts((set) => { const next = new Set(set); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const cols = 9 + (editable ? 1 : 0);

  const makeMain = async (si) => {
    setBusy(true);
    const r = await stockApi.saveItem({ item: { id: item.id, location_id: homeSiteId || undefined, main_supplier_item_id: si.id }, version: detail?.row_version ?? item.row_version ?? null });
    setBusy(false);
    if (r.error) { say(r.error.message, 'error'); reload?.(); return; }
    const note = queuedNote(r.queued);
    say(`Main supplier: ${si.supplier_name}.${note ? ` ${note}` : ''}`);
    reload?.();
  };
  const remove = async (si) => {
    const ok = await confirm({ title: `Take ${si.supplier_name} off ${item.name}?`, words: 'No site can order it from this supplier after this. Its price history is kept.', yes: 'Take it off', no: 'Go back', danger: true });
    if (!ok) return;
    setBusy(true);
    const r = await stockApi.archiveSupplierItem(si.id, si.row_version ?? null, true, 'inventory');
    setBusy(false);
    if (r.error) { say(r.error.message, 'error'); reload?.(); return; }
    say(`${si.supplier_name} is off ${item.name}. Its history is kept.`);
    reload?.();
  };

  const factorOf = (si) => {
    const shown = packAmount(si.unit_price, countPack);
    return num(si.pack_price) > 0 && shown > 0 ? num(si.pack_price) / shown : null;
  };

  return (
    <div>
      {rule && (
        <div style={{ marginBottom: 12 }}>
          <Notice tone="warn" actions={editable && ruleSi ? [{ label: 'Make it a new item', kind: 'primary', onClick: () => setMakeNew(ruleSi), disabled: busy }] : null}>
            {rule.words}
          </Notice>
        </div>
      )}
      {rows.length === 0 ? (
        <div style={ui.card}><EmptyLine>No supplier yet. {editable ? 'Press + Add another supplier to add one.' : ''}</EmptyLine></div>
      ) : (
        <TableWrap minWidth={1100}>
          <thead>
            <tr>
              <Th>Supplier</Th>
              <Th>Their name</Th>
              <Th>SKU</Th>
              <Th>Pack</Th>
              <Th right>Company price</Th>
              <Th>Next price</Th>
              <Th>Main</Th>
              <Th>What is in it</Th>
              <Th>Status</Th>
              {editable && <Th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((si) => {
              const main = item.main_supplier_item_id === si.id;
              const each = packPrice(si.unit_price, countPack, si.currency);
              const facts = factsOf(si);
              const open = openFacts.has(si.id);
              return (
                <Fragment key={si.id}>
                  <tr>
                    <Td strong>
                      {sc.canOpen?.('suppliers') && si.supplier_id
                        ? <button type="button" style={linkBtn} title={`Open ${si.supplier_name} in Suppliers`} onClick={() => sc.go('suppliers', { open: { id: si.supplier_id, tab: 'items' } })}>{si.supplier_name}</button>
                        : si.supplier_name}
                    </Td>
                    <Td>{si.supplier_product_name || <span style={{ color: 'var(--t4)' }}>None</span>}</Td>
                    <Td>{si.sku || ''}</Td>
                    <Td>{packWords(si)}</Td>
                    <Td right num>
                      {each || moneyText(si.pack_price, si.currency)}
                      {each && <div style={small}>{moneyText(si.pack_price, si.currency)} for {packWords(si)}{si.price_includes_tax ? ' (VAT in)' : ''}</div>}
                    </Td>
                    <Td grey={!si.next_price}>{nextPriceWords(si.next_price, si.currency, countPack, factorOf(si))}</Td>
                    <Td>
                      {main ? <span aria-label="Main supplier" style={{ color: 'var(--acc)', fontWeight: 800 }}>✓</span>
                        : (editable ? <Btn small kind="link" disabled={busy} onClick={() => makeMain(si)}>Make main</Btn> : null)}
                    </Td>
                    <Td>
                      <button type="button" style={linkBtn} aria-expanded={open} onClick={() => toggleFacts(si.id)}>{open ? 'Hide' : 'What is in it'}</button>
                      <div style={{ ...small, whiteSpace: 'normal', maxWidth: 220 }}>
                        {facts.allergens.length ? allergenWords(facts.allergens) : 'No allergens yet'}
                        {facts.checked_at ? '' : ' · Not checked yet'}
                      </div>
                    </Td>
                    <Td>{si.paused ? <Pill tone="warn">Paused</Pill> : <Pill tone="good">Available</Pill>}</Td>
                    {editable && (
                      <Td>
                        <div style={{ ...ui.row, gap: 4, justifyContent: 'flex-end' }}>
                          <Btn small kind="ghost" disabled={busy} onClick={() => setEditing(rowOf(si))}>Edit</Btn>
                          <Btn small kind="ghost" disabled={busy} onClick={() => remove(si)}>Take off</Btn>
                        </div>
                      </Td>
                    )}
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={cols} style={{ padding: 0, borderBottom: '1px solid var(--bdr)', background: 'var(--bg1)' }}>
                        <WhatIsInIt key={`${si.id}:${si.row_version ?? 0}`} detail={detail} supplierItem={si} editable={editable} reload={reload} tz={tz}
                          onMakeNewItem={editable && rows.length > 1 ? (s) => setMakeNew(s) : null} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </TableWrap>
      )}
      {editable && (
        <div style={{ marginTop: 12 }}>
          <Btn small kind="soft" disabled={busy || !!item.archived_at} onClick={() => setEditing(blankRow(item.base_unit))}>+ Add another supplier</Btn>
        </div>
      )}
      {editing && (
        <SupplierPackSheet detail={detail} start={editing} homeSiteId={homeSiteId} currency={currencyHere}
          rates={storeRates || []} onClose={() => setEditing(null)}
          onSaved={(words, tone) => { setEditing(null); say(words, tone); reload?.(); }} />
      )}
      {makeNew && (
        <MakeNewItemModal detail={detail} supplierItem={makeNew} onClose={() => setMakeNew(null)}
          onDone={() => { setMakeNew(null); reload?.(); }} />
      )}
      {confirmDialog}
    </div>
  );
}

function rowOf(si) {
  return {
    id: si.id, supplier_id: si.supplier_id, supplierName: si.supplier_name, newSupplier: '', supplier_product_name: si.supplier_product_name || '',
    supplier_sku: si.sku || '', inner_qty: String(si.inner_qty ?? 1), inner_unit: si.inner_unit || 'each', pack_qty: String(si.pack_qty ?? 1),
    pack_description: si.pack_description || '', pack_price: si.pack_price == null ? '' : String(si.pack_price), purchase_vat_rate: num(si.purchase_vat_rate),
    price_includes_tax: si.price_includes_tax === true, paused: si.paused === true, rowVersion: si.row_version ?? null,
  };
}

/** The supplier pack editor: a supplier from the company list (or a new one), the pack and its price. */
function SupplierPackSheet({ detail, start, homeSiteId, currency, rates, onClose, onSaved }) {
  const sc = useStockScope();
  const item = detail?.item || {};
  const companyEditor = !!sc.canEditCompany('inventory');
  const [row, setRow] = useState(start);
  const [search, setSearch] = useState('');
  const [list, setList] = useState({ rows: [], busy: true, error: null });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const upd = (k, v) => setRow((r) => ({ ...r, [k]: v }));
  const isNew = !row.id;
  const orgId = item.org_id || sc.orgId || null;
  const vatList = vatChoices(rates, row.purchase_vat_rate ?? item.purchase_vat_rate);
  const dirty = JSON.stringify(row) !== JSON.stringify(start);

  useEffect(() => {
    if (!isNew || !orgId) return undefined;
    let live = true;
    const t = setTimeout(() => {
      stockApi.suppliersPage({ orgId, sites: null, search: search.trim() || null, filters: null, after: null }).then((r) => {
        if (live) setList({ rows: r.data?.rows || [], busy: false, error: r.error || null });
      });
    }, search ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [isNew, orgId, search]);

  const onSiteIds = useMemo(() => (detail?.sites || []).filter((s) => s.on_here).map((s) => s.location_id), [detail]);

  const save = async () => {
    setProblem(null);
    const packQty = Number(row.pack_qty);
    const innerQty = Number(row.inner_qty);
    const price = Number(row.pack_price);
    if (isNew && !row.supplier_id && !row.newSupplier.trim()) { setProblem('Pick a supplier, or type the name of a new one.'); return; }
    if (!(innerQty > 0) || !(packQty > 0)) { setProblem('Give the pack a size and how many come in a case.'); return; }
    if (String(row.pack_price).trim() === '' || !Number.isFinite(price) || price < 0) { setProblem('Type the price of one case, such as 8.70.'); return; }
    setBusy(true);
    let supplierId = row.supplier_id;
    let madeSupplier = false;
    if (isNew && !supplierId) {
      // a new supplier: a company supplier at the sites the item is on, or a local supplier of a
      // local item (a site manager finishing their own local item)
      const local = !companyEditor && item.local_location_id ? item.local_location_id : null;
      const sites = local ? null : (onSiteIds.length ? onSiteIds : [homeSiteId]).filter(Boolean).map((id) => ({ location_id: id, on: true }));
      const r = await stockApi.saveSupplier({ supplier: { name: row.newSupplier.trim(), location_id: local || homeSiteId }, sites, section: 'inventory' });
      if (r.error) { setBusy(false); setProblem(r.error.message); return; }
      supplierId = r.data?.id || null;
      madeSupplier = true;
      if (!supplierId) { setBusy(false); setProblem('The supplier did not save. Try again.'); return; }
    }
    const si = {
      ...(row.id ? { id: row.id } : { item_id: item.id, supplier_id: supplierId }),
      location_id: homeSiteId || undefined,
      supplier_product_name: row.supplier_product_name.trim() || null,
      supplier_sku: row.supplier_sku.trim() || null,
      pack_qty: packQty, inner_qty: innerQty, inner_unit: row.inner_unit,
      pack_description: row.pack_description.trim() || `${packQty} x ${innerQty} ${row.inner_unit}`,
      pack_price: Math.round(price * 10000) / 10000,
      purchase_vat_rate: row.purchase_vat_rate ?? null,
      price_includes_tax: row.price_includes_tax === true,
      ...(row.id ? { paused: row.paused === true } : {}),
      ...(isNew && currency ? { currency } : {}),
    };
    const r = await stockApi.saveSupplierItem(si, row.id ? row.rowVersion : null, 'inventory');
    setBusy(false);
    if (r.error) {
      if (madeSupplier) { onSaved(`Supplier saved. The supplier pack did not save: ${r.error.message}`, 'error'); return; }
      setProblem(r.error.message);
      return;
    }
    const partial = r.data?.partial || null;
    const note = queuedNote(r.queued);
    onSaved(partial || `Saved. Changed at every site straight away.${note ? ` ${note}` : ''}`, partial ? 'warning' : 'success');
  };

  return (
    <Sheet title={isNew ? '+ Add another supplier' : `Edit ${start.supplierName || 'supplier'}`} sub={item.name} onClose={busy ? () => {} : onClose} width={560} dirty={dirty && !busy}
      footer={<><span style={{ flex: 1 }} /><Btn onClick={onClose} disabled={busy}>Cancel</Btn><Btn kind="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Btn></>}>
      {isNew ? (
        <>
          <Field label="Supplier" hint={list.error ? list.error.message : null}>
            <input placeholder="Search suppliers" value={search} onChange={(e) => setSearch(e.target.value)} style={{ ...ui.input, marginBottom: 6 }} />
            <select value={row.supplier_id} onChange={(e) => upd('supplier_id', e.target.value)} style={ui.input} disabled={!!row.newSupplier.trim()}>
              <option value="">{list.busy ? 'Loading…' : 'Pick a supplier'}</option>
              {list.rows.filter((s) => !s.archived_at).map((s) => <option key={s.id} value={s.id}>{s.name}{s.local_location_id ? ' (local)' : ''}</option>)}
            </select>
          </Field>
          <Field label="Or a new supplier" hint={companyEditor ? 'It can order at every site this item is on. Add its account number later on the supplier page.' : 'A local supplier of your site.'}>
            <input value={row.newSupplier} onChange={(e) => upd('newSupplier', e.target.value)} placeholder="Name of the new supplier" style={ui.input} />
          </Field>
        </>
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
        <Field label="Their name"><input value={row.supplier_product_name} onChange={(e) => upd('supplier_product_name', e.target.value)} style={ui.input} /></Field>
        <Field label="SKU"><input value={row.supplier_sku} onChange={(e) => upd('supplier_sku', e.target.value)} style={ui.input} /></Field>
        <Field label="Pack size">
          <div style={{ ...ui.row, gap: 6 }}>
            <input type="number" min="0" step="any" value={row.inner_qty} onChange={(e) => upd('inner_qty', e.target.value)} style={{ ...ui.input, width: 90 }} />
            <select value={row.inner_unit} onChange={(e) => upd('inner_unit', e.target.value)} style={{ ...ui.input, width: 'auto' }}>
              {DIM_ORDER.map((dim) => (
                <optgroup key={dim} label={dim[0] + dim.slice(1).toLowerCase()}>
                  {UNIT_OPTS.filter((u) => u.dimension === dim).map((u) => <option key={u.code} value={u.code}>{u.code}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
        </Field>
        <Field label="Packs per case"><input type="number" min="1" step="any" value={row.pack_qty} onChange={(e) => upd('pack_qty', e.target.value)} style={ui.input} /></Field>
        <Field label="Pack words" hint="What the invoice calls it, for example 6 x 2 L. Empty: worked out for you.">
          <input value={row.pack_description} onChange={(e) => upd('pack_description', e.target.value)} placeholder={`${row.pack_qty || 1} x ${row.inner_qty || 1} ${row.inner_unit}`} style={ui.input} />
        </Field>
        <Field label="Price of one case">
          <input type="number" min="0" step="any" value={row.pack_price} onChange={(e) => upd('pack_price', e.target.value)} placeholder="8.70" style={ui.input} />
        </Field>
        <Field label="VAT">
          <select value={vatList.find((v) => sameRate(v.value, row.purchase_vat_rate))?.label || 'None set'} style={ui.input}
            onChange={(e) => upd('purchase_vat_rate', vatList.find((v) => v.label === e.target.value)?.value ?? null)}>
            {vatList.map((v) => <option key={v.label} value={v.label}>{v.label}</option>)}
          </select>
        </Field>
        <Field label=" ">
          <label style={{ ...ui.row, fontSize: 13, color: 'var(--t2)', marginTop: 8 }}>
            <input type="checkbox" checked={row.price_includes_tax} onChange={(e) => upd('price_includes_tax', e.target.checked)} /> The price includes VAT
          </label>
        </Field>
      </div>
      {!isNew && (
        <label style={{ ...ui.row, fontSize: 13, color: 'var(--t2)', marginBottom: 12 }}>
          <input type="checkbox" checked={row.paused} onChange={(e) => upd('paused', e.target.checked)} /> Paused: no site can order it from this supplier for now
        </label>
      )}
      <div style={ui.sub}>The price here is the company price. A site with its own price keeps it (the Sites tab).</div>
      {problem && <div style={{ marginTop: 10 }}><Notice tone="bad">{problem}</Notice></div>}
    </Sheet>
  );
}
