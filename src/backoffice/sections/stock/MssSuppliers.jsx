// src/backoffice/sections/stock/MssSuppliers.jsx
//
// MULTI SITE STOCK (v5.11.80): Suppliers and the price list (plan 4.2, 4.9, 5.2). The company's
// suppliers with each site's account number, order email, delivery days, cut off and minimum order
// (set when the supplier first reaches a site; after that they are the site's own and it keeps
// them). The price list: item, pack, SKU, company price, each site's price (grey follows the company
// price). Change prices by percent or amount, at the company price or chosen sites, preview first.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Btn, Pill, Switch, Sheet, Modal, Field, Segmented, SiteChecklist } from '../msm/msmUi';
import { ui, money } from '../msm/msmStyle';
import { ratePercent, parseRatePercent, newId } from '../../../lib/stock/company/stockCompanyRules';
import { t, UNITS, fmtNum, numOrNull } from './mssShared';
import { Pager } from './mssCommon';

export default function MssSuppliers(props) {
  const [view, setView] = useState('prices');
  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <Segmented small value={view} onChange={setView} options={[{ value: 'prices', label: 'Price list' }, { value: 'suppliers', label: 'Suppliers' }]} />
      </div>
      {view === 'prices' ? <PriceList {...props} /> : <SupplierList {...props} />}
    </div>
  );
}

function SupplierList({ api, orgId, canEdit, sites, draft, stage, setNote, reload }) {
  const [page, setPage] = useState({ rows: [], total: 0 });
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(null);
  const load = useCallback(async () => {
    const r = await api.suppliersPage(orgId, { search: search.trim() || null, offset, limit: 100 });
    if (r.ok) setPage({ rows: r.data?.rows || [], total: Number(r.data?.total) || 0 }); else setNote({ tone: 'bad', text: r.words });
  }, [api, orgId, search, offset, setNote]);
  useEffect(() => { const h = setTimeout(load, 250); return () => clearTimeout(h); }, [load, reload]);
  const staged = useMemo(() => new Set((draft || []).filter((c) => c.target === 'supplier' || c.target === 'supplier_site').map((c) => c.entity_id)), [draft]);
  const newOnes = (draft || []).filter((c) => c.target === 'supplier' && c.data?._new);
  return (
    <div>
      <div style={t.bar}>
        <input value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} placeholder="Search suppliers" style={{ ...ui.input, width: 240 }} />
        <span style={{ flex: 1 }} />
        <Pager offset={offset} limit={100} total={page.total} onChange={setOffset} />
        {canEdit && <Btn small kind="primary" onClick={() => setOpen({ create: true })}>Add supplier</Btn>}
      </div>
      {newOnes.length > 0 && <div style={{ ...t.grey, marginBottom: 8 }}>New in the draft: {newOnes.map((c) => c.data.name).join(', ')}</div>}
      <div style={t.scroll}>
        <table style={t.table}>
          <thead><tr><th style={t.th}>Supplier</th><th style={t.th}>Prices</th><th style={t.th}>Every site</th>{sites.map((s) => <th key={s.id} style={t.th}>{s.name}</th>)}</tr></thead>
          <tbody>
            {page.rows.map((r) => (
              <tr key={r.id} onClick={() => setOpen({ row: r })} style={{ cursor: 'pointer' }}>
                <td style={t.td}><b>{r.name}</b> {staged.has(r.id) && <Pill tone="warn">In the draft</Pill>} {r.archived && <Pill>Archived</Pill>}<div style={t.grey}>{[r.contact_name, r.contact_email, r.phone].filter(Boolean).join(' · ')}</div></td>
                <td style={t.td}>{r.prices}</td>
                <td style={t.td}>{r.all_sites ? 'Yes' : ''}</td>
                {sites.map((s) => {
                  const x = r.sites?.[s.id];
                  const on = x ? !!x.active : !!r.all_sites;
                  return <td key={s.id} style={{ ...t.td, ...t.grey }}>{on ? (x?.account_number || 'on') : 'off'}</td>;
                })}
              </tr>
            ))}
            {!page.rows.length && <tr><td style={t.td} colSpan={3 + sites.length}>No suppliers yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {open && <SupplierSheet api={api} orgId={orgId} canEdit={canEdit} sites={sites} stage={stage} row={open.row} create={!!open.create} onClose={() => setOpen(null)} />}
    </div>
  );
}

function SupplierSheet({ canEdit, sites, stage, row, create, onClose }) {
  const id = useMemo(() => row?.id || newId(), [row]);
  const init = { name: row?.name || '', contact_name: row?.contact_name || '', contact_email: row?.contact_email || '', phone: row?.phone || '',
    payment_terms_days: row?.payment_terms_days ?? '', notes: row?.notes || '', all_sites: !!row?.all_sites };
  const [f, setF] = useState(init);
  const [siteVals, setSiteVals] = useState({});   // locationId -> { active, account_number, order_email, delivery_days, cutoff_time, min_order_value }
  const [err, setErr] = useState('');
  const dirty = JSON.stringify(f) !== JSON.stringify(init) || Object.keys(siteVals).length > 0;
  const setSite = (loc, k, v) => setSiteVals((m) => ({ ...m, [loc]: { ...(m[loc] || {}), [k]: v } }));
  const save = async () => {
    if (!f.name.trim()) { setErr('A supplier needs a name.'); return; }
    const data = { name: f.name.trim(), contact_name: f.contact_name.trim() || null, contact_email: f.contact_email.trim() || null, phone: f.phone.trim() || null,
      payment_terms_days: numOrNull(f.payment_terms_days), notes: f.notes.trim() || null, all_sites: !!f.all_sites };
    const changes = [{ target: 'supplier', entity_id: id, data: create ? { ...data, _new: true } : data }];
    for (const [loc, v] of Object.entries(siteVals)) {
      const d = { ...v };
      if ('delivery_days' in d) d.delivery_days = String(d.delivery_days || '').split(',').map((x) => x.trim()).filter(Boolean);
      if ('min_order_value' in d) d.min_order_value = numOrNull(d.min_order_value);
      changes.push({ target: 'supplier_site', entity_id: id, location_id: loc, data: d });
    }
    const r = await stage(changes, `${data.name}: in the draft.`);
    if (r.ok) onClose();
  };
  return (
    <Sheet title={create ? 'New supplier' : row.name} sub="Head office details; each site's own account and ordering details below" onClose={onClose} width={720} dirty={dirty}
      footer={canEdit ? <><Btn kind="primary" onClick={save}>Add to draft</Btn>{!create && !row.archived && <Btn kind="danger" onClick={async () => { const r = await stage([{ target: 'supplier', entity_id: id, data: { archived: true } }], `${row.name}: archived in the draft.`); if (r.ok) onClose(); }}>Archive</Btn>}</> : null}>
      {err && <div style={{ ...ui.err, marginBottom: 10 }}>{err}</div>}
      <fieldset disabled={!canEdit} style={{ border: 'none', padding: 0, margin: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} style={ui.input} /></Field>
          <Field label="Head office contact"><input value={f.contact_name} onChange={(e) => setF({ ...f, contact_name: e.target.value })} style={ui.input} /></Field>
          <Field label="Head office email" hint="Not the order email: each site orders to its own"><input value={f.contact_email} onChange={(e) => setF({ ...f, contact_email: e.target.value })} style={ui.input} /></Field>
          <Field label="Phone"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} style={ui.input} /></Field>
          <Field label="Payment terms (days)"><input type="number" min="0" value={f.payment_terms_days} onChange={(e) => setF({ ...f, payment_terms_days: e.target.value })} style={ui.input} /></Field>
        </div>
        <label style={{ ...ui.row, fontSize: 13, marginBottom: 12 }}><input type="checkbox" checked={f.all_sites} onChange={(e) => setF({ ...f, all_sites: e.target.checked })} /> On at every site</label>
        <Field label="Notes"><textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} style={{ ...ui.input, minHeight: 44 }} /></Field>
        <div style={ui.label}>Each site</div>
        <div style={{ ...t.grey, marginBottom: 6 }}>Account number, order email, delivery days, cut off and minimum order go to a site when the supplier first reaches it. After that they are the site's own: change them there.</div>
        <table style={t.table}>
          <thead><tr><th style={t.th}>Site</th><th style={t.th}>On</th><th style={t.th}>Account</th><th style={t.th}>Order email</th><th style={t.th}>Delivery days</th><th style={t.th}>Cut off</th><th style={t.th}>Min order</th></tr></thead>
          <tbody>
            {sites.map((s) => {
              const live = row?.sites?.[s.id] || {};
              const v = { ...live, ...(siteVals[s.id] || {}) };
              const fixed = !!live.set_at_site;
              const on = siteVals[s.id]?.active ?? (row?.sites?.[s.id] ? !!live.active : !!f.all_sites);
              return (
                <tr key={s.id}>
                  <td style={t.td}>{s.name}</td>
                  <td style={t.td}><Switch small on={on} onChange={(x) => setSite(s.id, 'active', x)} /></td>
                  {['account_number', 'order_email', 'delivery_days', 'cutoff_time', 'min_order_value'].map((k) => (
                    <td key={k} style={t.td}>
                      {fixed ? <span style={t.grey}>{Array.isArray(v[k]) ? v[k].join(', ') : (v[k] ?? '')}</span>
                        : <input value={Array.isArray(v[k]) ? v[k].join(', ') : (v[k] ?? '')} onChange={(e) => setSite(s.id, k, e.target.value)} style={{ ...ui.input, padding: '4px 6px', fontSize: 12 }} />}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </fieldset>
    </Sheet>
  );
}

function PriceList({ api, orgId, canEdit, sites, draft, stage, setNote, reload }) {
  const [page, setPage] = useState({ rows: [], total: 0 });
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [tool, setTool] = useState(false);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    const r = await api.pricesPage(orgId, { search: search.trim() || null, offset, limit: 100 });
    if (r.ok) setPage({ rows: r.data?.rows || [], total: Number(r.data?.total) || 0 }); else setNote({ tone: 'bad', text: r.words });
  }, [api, orgId, search, offset, setNote]);
  useEffect(() => { const h = setTimeout(load, 250); return () => clearTimeout(h); }, [load, reload]);
  const stagedPrice = useMemo(() => {
    const m = new Map();
    for (const c of draft || []) {
      if (c.target === 'sp' && c.data && 'pack_price' in c.data) m.set(`${c.entity_id}|`, c.data.pack_price);
      if (c.target === 'sp_site' && c.data && 'pack_price' in c.data) m.set(`${c.entity_id}|${c.location_id}`, c.data.pack_price);
    }
    return m;
  }, [draft]);
  const setCompany = (r, text) => {
    const v = numOrNull(text);
    if (v == null || v < 0 || v === Number(r.pack_price)) return;
    stage([{ target: 'sp', entity_id: r.id, data: { pack_price: v } }], `${r.item_name} from ${r.supplier_name}: ${money(v)} company price, in the draft.`);
  };
  const setSite = (r, loc, text) => {
    const v = text === '' ? null : numOrNull(text);
    if (text !== '' && (v == null || v < 0)) return;
    stage([{ target: 'sp_site', entity_id: r.id, location_id: loc, data: { pack_price: v } }],
      v == null ? `${r.item_name}: ${sites.find((s) => s.id === loc)?.name} follows the company price again, in the draft.` : `${r.item_name}: ${money(v)} at ${sites.find((s) => s.id === loc)?.name}, in the draft.`);
  };
  return (
    <div>
      <div style={t.bar}>
        <input value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} placeholder="Search item, supplier or supplier SKU" style={{ ...ui.input, width: 280 }} />
        <span style={{ flex: 1 }} />
        <Pager offset={offset} limit={100} total={page.total} onChange={setOffset} />
        {canEdit && <Btn small onClick={() => setTool(true)}>Change prices</Btn>}
        {canEdit && <Btn small kind="primary" onClick={() => setAdding(true)}>Add a price</Btn>}
      </div>
      <div style={t.scroll}>
        <table style={t.table}>
          <thead><tr><th style={t.th}>Item</th><th style={t.th}>Supplier</th><th style={t.th}>Pack</th><th style={t.th}>Company price</th>{sites.map((s) => <th key={s.id} style={t.th}>{s.name}</th>)}</tr></thead>
          <tbody>
            {page.rows.map((r) => {
              const cp = stagedPrice.has(`${r.id}|`) ? stagedPrice.get(`${r.id}|`) : r.pack_price;
              return (
                <tr key={r.id}>
                  <td style={t.td}><b>{r.item_name}</b><div style={t.grey}>{r.supplier_sku || ''}</div></td>
                  <td style={t.td}>{r.supplier_name}</td>
                  <td style={t.td}>{r.pack_description || `${fmtNum(r.pack_qty)} x ${fmtNum(r.inner_qty)} ${r.inner_unit}`}{r.purchase_tax_rate != null && <div style={t.grey}>VAT {ratePercent(r.purchase_tax_rate)}{r.price_includes_tax ? ', price includes it' : ''}</div>}</td>
                  <td style={t.td}>
                    {canEdit ? <input key={`${r.id}-${cp}`} defaultValue={cp} onBlur={(e) => setCompany(r, e.target.value)} style={{ ...ui.input, width: 90, padding: '4px 6px', fontSize: 12, ...(stagedPrice.has(`${r.id}|`) ? { borderColor: 'var(--amber, #F5A623)' } : {}) }} /> : money(cp)}
                  </td>
                  {sites.map((s) => {
                    const x = r.sites?.[s.id] || {};
                    const key = `${r.id}|${s.id}`;
                    const own = stagedPrice.has(key) ? stagedPrice.get(key) : x.pack_price;
                    return (
                      <td key={s.id} style={t.td}>
                        {canEdit ? <input key={`${key}-${own}`} defaultValue={own ?? ''} placeholder={money(cp)} onBlur={(e) => { if (String(e.target.value) !== String(own ?? '')) setSite(r, s.id, e.target.value.trim()); }}
                          style={{ ...ui.input, width: 86, padding: '4px 6px', fontSize: 12, ...(stagedPrice.has(key) ? { borderColor: 'var(--amber, #F5A623)' } : {}) }} />
                          : <span style={own == null ? t.grey : undefined}>{money(own ?? cp)}</span>}
                        {x.linked && x.live_price != null && Number(x.live_price) !== Number(own ?? cp) && <div style={t.grey}>live {money(x.live_price)}</div>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {!page.rows.length && <tr><td style={t.td} colSpan={4 + sites.length}>No supplier prices yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <div style={{ ...t.grey, marginTop: 8 }}>A site price left empty (grey) follows the company price. A price is never a cost: each site's cost follows its own rule.</div>
      {tool && <ChangePrices api={api} orgId={orgId} sites={sites} setNote={setNote} onDone={() => { setTool(false); load(); }} onClose={() => setTool(false)} />}
      {adding && <AddPrice api={api} orgId={orgId} stage={stage} onClose={() => setAdding(false)} />}
    </div>
  );
}

function ChangePrices({ api, orgId, sites, setNote, onDone, onClose }) {
  const [mode, setMode] = useState('pct');
  const [amount, setAmount] = useState('');
  const [where, setWhere] = useState('company');
  const [chosen, setChosen] = useState([]);
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');
  const args = () => {
    const v = Number(amount);
    if (!Number.isFinite(v) || v === 0) return null;
    return { pct: mode === 'pct' ? v : null, amount: mode === 'amount' ? v : null, sites: where === 'company' ? null : chosen };
  };
  const run = async (doIt) => {
    const a = args();
    if (!a) { setErr('Type a percent or an amount.'); return; }
    if (where === 'sites' && !chosen.length) { setErr('Pick at least one site.'); return; }
    const r = await api.changePrices(orgId, { ...a, preview: !doIt });
    if (!r.ok) { setErr(r.words); return; }
    if (doIt) { setNote({ tone: 'good', text: `${r.data.staged} prices changed in the draft. Nothing changes at any site until you publish.` }); onDone(); }
    else setPreview(r.data);
  };
  return (
    <Modal title="Change prices" sub="Preview first. Prices go into the draft; nothing changes at any site until you publish." onClose={onClose}
      footer={<><Btn onClick={() => run(false)}>Preview</Btn><Btn kind="primary" disabled={!preview} onClick={() => run(true)}>Add to draft</Btn></>}>
      {err && <div style={{ ...ui.err, marginBottom: 8 }}>{err}</div>}
      <div style={{ ...ui.row, marginBottom: 12, flexWrap: 'wrap' }}>
        <Segmented small value={mode} onChange={(v) => { setMode(v); setPreview(null); }} options={[{ value: 'pct', label: 'By percent' }, { value: 'amount', label: 'By amount' }]} />
        <input value={amount} onChange={(e) => { setAmount(e.target.value); setPreview(null); }} placeholder={mode === 'pct' ? '5 or -3' : '0.25'} style={{ ...ui.input, width: 110 }} />
        <Segmented small value={where} onChange={(v) => { setWhere(v); setPreview(null); }} options={[{ value: 'company', label: 'Company price' }, { value: 'sites', label: 'Chosen sites only' }]} />
      </div>
      {where === 'sites' && <SiteChecklist sites={sites} value={chosen} onChange={(v) => { setChosen(v); setPreview(null); }} />}
      {preview && (
        <div style={{ marginTop: 12 }}>
          <div style={ui.label}>{preview.total} price{preview.total === 1 ? '' : 's'} (first {Math.min(200, preview.total)} shown)</div>
          <table style={t.table}><tbody>
            {(preview.rows || []).map((x) => (
              <tr key={`${x.sp_id}|${x.location_id || ''}`}><td style={t.td}>{x.item_name}</td><td style={t.td}>{x.supplier_name}</td>
                <td style={t.td}>{x.location_id ? sites.find((s) => s.id === x.location_id)?.name : 'Company'}</td>
                <td style={t.td}>{money(x.old_price)} to <b>{money(x.new_price)}</b></td></tr>
            ))}
          </tbody></table>
        </div>
      )}
    </Modal>
  );
}

function AddPrice({ api, orgId, stage, onClose }) {
  const [itemQ, setItemQ] = useState('');
  const [items, setItems] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [f, setF] = useState({ item: null, supplier_id: '', supplier_sku: '', pack_description: '', pack_qty: '1', inner_qty: '1', inner_unit: 'each', pack_price: '', includes: false, vat: '', first: false });
  const [err, setErr] = useState('');
  useEffect(() => { api.suppliersPage(orgId, { limit: 200 }).then((r) => { if (r.ok) setSuppliers(r.data?.rows || []); }); }, [api, orgId]);
  useEffect(() => {
    if (!itemQ.trim()) return undefined;
    const h = setTimeout(() => api.itemsPage(orgId, { search: itemQ.trim(), limit: 20 }).then((r) => { if (r.ok) setItems(r.data?.rows || []); }), 250);
    return () => clearTimeout(h);
  }, [api, orgId, itemQ]);
  const save = async () => {
    const price = Number(f.pack_price); const rate = parseRatePercent(f.vat);
    if (!f.item || !f.supplier_id) { setErr('Pick an item and a supplier.'); return; }
    if (!(price >= 0) || f.pack_price === '') { setErr('Type the pack price.'); return; }
    if (Number.isNaN(rate)) { setErr('VAT must be a percent such as 20, or empty.'); return; }
    const r = await stage([{ target: 'sp', entity_id: newId(), data: { _new: true, item_id: f.item.id, supplier_id: f.supplier_id, supplier_sku: f.supplier_sku.trim() || null,
      pack_description: f.pack_description.trim() || null, pack_qty: Number(f.pack_qty) || 1, inner_qty: Number(f.inner_qty) || 1, inner_unit: f.inner_unit,
      pack_price: price, price_includes_tax: f.includes, purchase_tax_rate: rate, first_choice: f.first } }], `${f.item.name}: a new price in the draft.`);
    if (r.ok) onClose();
  };
  return (
    <Sheet title="Add a supplier price" onClose={onClose} width={560} footer={<Btn kind="primary" onClick={save}>Add to draft</Btn>}>
      {err && <div style={{ ...ui.err, marginBottom: 8 }}>{err}</div>}
      <Field label="Stock item">
        {f.item ? <div style={ui.row}><b>{f.item.name}</b> ({f.item.base_unit}) <Btn small onClick={() => setF({ ...f, item: null })}>Change</Btn></div>
          : <><input value={itemQ} onChange={(e) => setItemQ(e.target.value)} placeholder="Search a company item" style={ui.input} />
            {(itemQ.trim() ? items : []).map((i) => <div key={i.id} onClick={() => setF({ ...f, item: i, inner_unit: i.base_unit })} style={{ padding: '5px 4px', cursor: 'pointer', fontSize: 13 }}>{i.name} <span style={t.grey}>{i.base_unit}</span></div>)}</>}
      </Field>
      <Field label="Supplier">
        <select value={f.supplier_id} onChange={(e) => setF({ ...f, supplier_id: e.target.value })} style={ui.input}>
          <option value="">Pick a supplier</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="Supplier SKU"><input value={f.supplier_sku} onChange={(e) => setF({ ...f, supplier_sku: e.target.value })} style={ui.input} /></Field>
        <Field label="Pack"><input value={f.pack_description} onChange={(e) => setF({ ...f, pack_description: e.target.value })} placeholder="Case 6 x 1 l" style={ui.input} /></Field>
        <Field label="Packs"><input type="number" min="0" value={f.pack_qty} onChange={(e) => setF({ ...f, pack_qty: e.target.value })} style={ui.input} /></Field>
        <Field label="Each holds"><div style={ui.row}><input type="number" min="0" value={f.inner_qty} onChange={(e) => setF({ ...f, inner_qty: e.target.value })} style={ui.input} />
          <select value={f.inner_unit} onChange={(e) => setF({ ...f, inner_unit: e.target.value })} style={{ ...ui.input, width: 90 }}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select></div></Field>
        <Field label="Pack price"><input value={f.pack_price} onChange={(e) => setF({ ...f, pack_price: e.target.value })} style={ui.input} /></Field>
        <Field label="Purchase VAT %"><input value={f.vat} onChange={(e) => setF({ ...f, vat: e.target.value })} placeholder="20" style={ui.input} /></Field>
      </div>
      <label style={{ ...ui.row, fontSize: 13 }}><input type="checkbox" checked={f.includes} onChange={(e) => setF({ ...f, includes: e.target.checked })} /> The price includes VAT</label>
      <label style={{ ...ui.row, fontSize: 13, marginTop: 6 }}><input type="checkbox" checked={f.first} onChange={(e) => setF({ ...f, first: e.target.checked })} /> First choice when the item first reaches a site (after that each site keeps its own preferred supplier)</label>
    </Sheet>
  );
}
