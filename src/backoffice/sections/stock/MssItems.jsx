// src/backoffice/sections/stock/MssItems.jsx
//
// MULTI SITE STOCK (v5.11.80): the Stock items tab (plan 5.2). Items down the side, sites across the
// top; each box switches the item on or off at that site and shows that site's stock and cost in grey.
// Pages of 100 from the server (msm_stock_items_page: built for 5,000 items by 50 sites), search and
// filters on the server. Every switch and every save goes into the draft.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Btn, Pill, Switch, Sheet, Field, ConfirmDialog } from '../msm/msmUi';
import { ui, money } from '../msm/msmStyle';
import { mergeDraft, onAtSite, ratePercent, parseRatePercent, newId } from '../../../lib/stock/company/stockCompanyRules';
import { t, UNITS, AREA_KINDS, fmtNum, numOrNull } from './mssShared';
import { Pager } from './mssCommon';

const FILTERS = [['', 'Live'], ['not_everywhere', 'Not at every site'], ['nowhere', 'Not on anywhere'], ['archived', 'Archived']];

export default function MssItems({ api, orgId, canEdit, sites, draft, stage, setNote, reload }) {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState({ rows: [], total: 0 });
  const [busy, setBusy] = useState(true);
  const [open, setOpen] = useState(null);       // { id } | { create: true }
  useEffect(() => { const h = setTimeout(() => { setQ(search.trim()); setOffset(0); }, 300); return () => clearTimeout(h); }, [search]);

  // state is set only when the answer arrives (never synchronously inside the effect)
  const load = useCallback(() => api.itemsPage(orgId, { search: q || null, filter: filter || null, offset, limit: 100 }).then((r) => {
    setBusy(false);
    if (r.ok) setPage({ rows: r.data?.rows || [], total: Number(r.data?.total) || 0 });
    else setNote({ tone: 'bad', text: r.words });
  }), [api, orgId, q, filter, offset, setNote]);
  useEffect(() => { load(); }, [load, reload]);

  const rows = useMemo(() => mergeDraft(page.rows, draft), [page.rows, draft]);
  const newRows = useMemo(() => (draft || []).filter((c) => c.target === 'item' && c.data && c.data._new), [draft]);

  const toggleSite = (row, siteId) => stage([{ target: 'item_site', entity_id: row.id, location_id: siteId, data: { active: !onAtSite(row, siteId) } }],
    `${row.name}: ${onAtSite(row, siteId) ? 'off' : 'on'} at ${sites.find((s) => s.id === siteId)?.name || 'that site'}, in the draft.`);
  const toggleAll = (row) => stage([{ target: 'item', entity_id: row.id, data: { all_sites: !row.all_sites } }],
    `${row.name}: ${row.all_sites ? 'no longer' : 'now'} on at every site, in the draft.`);

  return (
    <div>
      <div style={t.bar}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, SKU, barcode or category" style={{ ...ui.input, width: 280 }} />
        <select value={filter} onChange={(e) => { setFilter(e.target.value); setOffset(0); }} style={{ ...ui.input, width: 'auto' }}>
          {FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {busy && <span style={t.grey}>Loading…</span>}
        <span style={{ flex: 1 }} />
        <Pager offset={offset} limit={100} total={page.total} onChange={setOffset} />
        {canEdit && <Btn kind="primary" small onClick={() => setOpen({ create: true })}>Add stock item</Btn>}
      </div>
      {newRows.length > 0 && (
        <div style={{ ...t.grey, marginBottom: 8 }}>New in the draft (not published): {newRows.slice(0, 6).map((c) => c.data.name).join(', ')}{newRows.length > 6 ? ` and ${newRows.length - 6} more` : ''}</div>
      )}
      <div style={t.scroll}>
        <table style={t.table}>
          <thead>
            <tr>
              <th style={{ ...t.th, left: 0, zIndex: 2, minWidth: 220 }}>Stock item</th>
              <th style={t.th}>Unit</th>
              <th style={t.th}>Every site</th>
              {sites.map((s) => <th key={s.id} style={{ ...t.th, minWidth: 110 }}>{s.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ ...t.td, cursor: 'pointer' }} onClick={() => setOpen({ id: r.id })}>
                  <div style={{ fontWeight: 650 }}>{r.name} {r.staged && <Pill tone="warn">In the draft</Pill>} {r.archived && <Pill>Archived</Pill>}</div>
                  <div style={t.grey}>{[r.category, r.sku, r.barcode, r.purchase_tax_rate != null ? `VAT ${ratePercent(r.purchase_tax_rate)}` : null].filter(Boolean).join(' · ')}</div>
                </td>
                <td style={t.td}>{r.base_unit}</td>
                <td style={t.td}><Switch small on={!!r.all_sites} disabled={!canEdit || r.archived} onChange={() => toggleAll(r)} ariaLabel={`${r.name} at every site`} /></td>
                {sites.map((s) => {
                  const site = r.sites?.[s.id] || {};
                  const on = onAtSite(r, s.id);
                  return (
                    <td key={s.id} style={t.td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Switch small on={on} disabled={!canEdit || r.archived} onChange={() => toggleSite(r, s.id)} ariaLabel={`${r.name} at ${s.name}`} />
                        {site.staged && <span title="In the draft" style={{ color: 'var(--amber, #F5A623)', fontWeight: 800 }}>•</span>}
                      </div>
                      {site.linked && <div style={t.grey}>{fmtNum(site.on_hand, r.base_unit)}{site.cost != null ? ` · ${money(site.cost)}` : ''}</div>}
                      {on && !site.linked && <div style={t.grey}>new here</div>}
                    </td>
                  );
                })}
              </tr>
            ))}
            {!rows.length && !busy && <tr><td style={t.td} colSpan={3 + sites.length}>No stock items here. Add one, import a file, or Start from a site (Set up).</td></tr>}
          </tbody>
        </table>
      </div>
      <div style={{ ...t.grey, marginTop: 8 }}>Grey figures are that site's own stock on hand and cost here: publishing never changes them.</div>
      {open && <ItemSheet api={api} orgId={orgId} canEdit={canEdit} draft={draft} stage={stage}
        id={open.id} create={!!open.create} onClose={() => setOpen(null)} />}
    </div>
  );
}

const blankItem = { name: '', base_unit: 'each', category: '', accounting_group: '', sku: '', barcode: '', shelf_life_days: '', vat: '', default_area_kind: '', allergens: '', returns_to_shelf: false, notes: '', all_sites: false };
const toForm = (i) => ({
  name: i.name || '', base_unit: i.base_unit || 'each', category: i.category || '', accounting_group: i.accounting_group || '', sku: i.sku || '',
  barcode: i.barcode || '', shelf_life_days: i.shelf_life_days ?? '', vat: i.purchase_tax_rate != null ? String(Number((i.purchase_tax_rate * 100).toFixed(3))) : '',
  default_area_kind: i.default_area_kind || '', allergens: (Array.isArray(i.allergens) ? i.allergens : []).join(', '), returns_to_shelf: !!i.returns_to_shelf,
  notes: i.notes || '', all_sites: !!i.all_sites,
});
function formToData(f) {
  const rate = parseRatePercent(f.vat);
  if (Number.isNaN(rate)) return { error: 'VAT must be a percent such as 20, or empty.' };
  if (!f.name.trim()) return { error: 'A stock item needs a name.' };
  return { data: {
    name: f.name.trim(), base_unit: f.base_unit, category: f.category.trim() || null, accounting_group: f.accounting_group.trim() || null,
    sku: f.sku.trim() || null, barcode: f.barcode.trim() || null, shelf_life_days: numOrNull(f.shelf_life_days), purchase_tax_rate: rate,
    default_area_kind: f.default_area_kind || null, allergens: f.allergens.split(',').map((x) => x.trim()).filter(Boolean),
    returns_to_shelf: !!f.returns_to_shelf, notes: f.notes.trim() || null, all_sites: !!f.all_sites,
  } };
}

function ItemSheet({ api, orgId, canEdit, draft, stage, id, create, onClose }) {
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(blankItem);
  const [orig, setOrig] = useState(blankItem);
  const [err, setErr] = useState('');
  const [asking, setAsking] = useState(null);
  const [pack, setPack] = useState({ name: '', qty: '', count: false, buy: false });
  const [bridge, setBridge] = useState({ fromQty: '1', fromUnit: 'each', toQty: '', toUnit: 'g' });
  const itemId = useMemo(() => id || newId(), [id]);
  const staged = useMemo(() => (draft || []).find((c) => c.target === 'item' && c.entity_id === itemId) || null, [draft, itemId]);

  useEffect(() => {
    let live = true;
    if (create || !id) return undefined;   // a new item starts blank (useState above)
    api.itemDetail(orgId, id).then((r) => {
      if (!live) return;
      if (!r.ok) { setErr(r.words); return; }
      setDetail(r.data);
      const f = toForm({ ...(r.data?.item || {}), ...(staged?.data || {}) });
      setForm(f); setOrig(f);
    });
    return () => { live = false; };
  }, [api, orgId, id, create, staged]);

  const dirty = JSON.stringify(form) !== JSON.stringify(orig);
  const upd = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const save = async () => {
    const d = formToData(form);
    if (d.error) { setErr(d.error); return; }
    const changed = create ? { ...d.data, _new: true } : Object.fromEntries(Object.entries(d.data).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(formToData(orig).data?.[k])));
    if (!create && !Object.keys(changed).length) { onClose(); return; }
    const r = await stage([{ target: 'item', entity_id: itemId, data: changed }], create ? `${d.data.name} added to the draft.` : `${d.data.name}: changes in the draft.`);
    if (r.ok) onClose();
  };
  const item = detail?.item || {};
  const used = detail?.used_in || {};
  // the database's own rule (msm_stock__unit_in_use): stock, movements, counts, pars, orders or the
  // site's own packs in that unit at any site fix it; before the sheet has loaded, on hand decides
  const lockedUnit = !create && (detail?.unit_locked != null ? !!detail.unit_locked : (detail?.sites || []).some((s) => s.linked && Number(s.on_hand) !== 0));
  const addPack = async () => {
    const qty = Number(pack.qty);
    if (!pack.name.trim() || !(qty > 0)) { setErr('A pack needs a name and how many base units it holds.'); return; }
    const r = await stage([{ target: 'pack', entity_id: newId(), data: { _new: true, item_id: itemId, name: pack.name.trim(), qty_in_base: qty, is_count_default: pack.count, is_purchase_default: pack.buy } }],
      `Pack ${pack.name.trim()} added to the draft.`);
    if (r.ok) setPack({ name: '', qty: '', count: false, buy: false });
  };
  const addBridge = async () => {
    if (!(Number(bridge.fromQty) > 0) || !(Number(bridge.toQty) > 0)) { setErr('A unit bridge needs two amounts above 0.'); return; }
    await stage([{ target: 'bridge', entity_id: newId(), data: { _new: true, item_id: itemId, from_qty: Number(bridge.fromQty), from_unit: bridge.fromUnit, to_qty: Number(bridge.toQty), to_unit: bridge.toUnit } }],
      'Unit bridge added to the draft.');
  };
  const held = (detail?.sites || []).filter((s) => s.linked && Number(s.on_hand) !== 0);

  return (
    <Sheet title={create ? 'New stock item' : (item.name || 'Stock item')} sub={create ? 'Off at every site until you switch it on.' : `Base unit ${item.base_unit || ''}`}
      onClose={onClose} width={660} dirty={dirty}
      footer={canEdit ? (<>
        <Btn kind="primary" onClick={save} disabled={!dirty && !create}>Add to draft</Btn>
        {!create && !item.archived && <Btn kind="danger" onClick={() => setAsking('archive')}>Archive</Btn>}
        {!create && item.archived && <Btn onClick={() => stage([{ target: 'item', entity_id: itemId, data: { archived: false } }], `${item.name} back in the draft.`)}>Bring back</Btn>}
        <span style={{ flex: 1 }} />
        {!create && <span style={t.grey}>Used in {used.recipes || 0} recipe{used.recipes === 1 ? '' : 's'} at {used.sites || 0} site{used.sites === 1 ? '' : 's'}</span>}
      </>) : <span style={t.grey}>You can look, not change.</span>}>
      {err && <div style={{ ...ui.err, marginBottom: 10 }}>{err}</div>}
      {staged && <div style={{ marginBottom: 10 }}><Pill tone="warn">This item has changes in the draft</Pill></div>}
      <fieldset disabled={!canEdit} style={{ border: 'none', padding: 0, margin: 0 }}>
        <Field label="Name"><input value={form.name} onChange={(e) => upd('name', e.target.value)} style={ui.input} /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <Field label="Base unit" hint={lockedUnit ? 'Fixed: a site has stock, counts, pars or orders of it in this unit' : 'Counted and costed in this'}>
            <select value={form.base_unit} disabled={lockedUnit} onChange={(e) => upd('base_unit', e.target.value)} style={ui.input}>{UNITS.map((u) => <option key={u} value={u}>{u}</option>)}</select>
          </Field>
          <Field label="Category"><input value={form.category} onChange={(e) => upd('category', e.target.value)} style={ui.input} /></Field>
          <Field label="Accounting group"><input value={form.accounting_group} onChange={(e) => upd('accounting_group', e.target.value)} style={ui.input} /></Field>
          <Field label="SKU"><input value={form.sku} onChange={(e) => upd('sku', e.target.value)} style={ui.input} /></Field>
          <Field label="Barcode" hint="Scans at every site"><input value={form.barcode} onChange={(e) => upd('barcode', e.target.value)} style={ui.input} /></Field>
          <Field label="Purchase VAT %"><input value={form.vat} onChange={(e) => upd('vat', e.target.value)} placeholder="20" style={ui.input} /></Field>
          <Field label="Shelf life (days)"><input type="number" min="0" value={form.shelf_life_days} onChange={(e) => upd('shelf_life_days', e.target.value)} style={ui.input} /></Field>
          <Field label="Usual area" hint="Where it lands at a site with one such area">
            <select value={form.default_area_kind} onChange={(e) => upd('default_area_kind', e.target.value)} style={ui.input}>{AREA_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </Field>
          <Field label="Allergens"><input value={form.allergens} onChange={(e) => upd('allergens', e.target.value)} placeholder="milk, nuts" style={ui.input} /></Field>
        </div>
        <label style={{ ...ui.row, fontSize: 13, marginBottom: 8 }}><input type="checkbox" checked={form.returns_to_shelf} onChange={(e) => upd('returns_to_shelf', e.target.checked)} /> Can go back on the shelf (sealed goods only: a refund returns it)</label>
        <label style={{ ...ui.row, fontSize: 13, marginBottom: 12 }}><input type="checkbox" checked={form.all_sites} onChange={(e) => upd('all_sites', e.target.checked)} /> On at every site (a site can still be switched off on its own)</label>
        <Field label="Notes"><textarea value={form.notes} onChange={(e) => upd('notes', e.target.value)} style={{ ...ui.input, minHeight: 50 }} /></Field>
      </fieldset>

      {create && <div style={t.grey}>Packs, unit bridges and prices can be added once the item is in the draft.</div>}
      {!create && <>
      <div style={{ ...ui.label, marginTop: 6 }}>Packs (count and buy units)</div>
      {(detail?.packs || []).map((p) => (
        <div key={p.id} style={{ ...ui.row, padding: '5px 0', borderTop: '1px solid var(--bdr)', fontSize: 13 }}>
          <span style={{ flex: 1 }}>{p.name}: {fmtNum(p.qty_in_base, item.base_unit)} {p.is_count_default && <Pill>count in this</Pill>} {p.is_purchase_default && <Pill>buy in this</Pill>} {p.archived && <Pill>archived</Pill>}</span>
          {canEdit && !p.archived && <Btn small kind="danger" onClick={() => stage([{ target: 'pack', entity_id: p.id, data: { archived: true } }], `Pack ${p.name}: off at every site, in the draft.`)}>Archive</Btn>}
        </div>
      ))}
      {canEdit && (
        <div style={{ ...ui.row, flexWrap: 'wrap', margin: '6px 0 14px' }}>
          <input value={pack.name} onChange={(e) => setPack((x) => ({ ...x, name: e.target.value }))} placeholder="Case, Bottle, Keg" style={{ ...ui.input, width: 150 }} />
          <input type="number" min="0" step="any" value={pack.qty} onChange={(e) => setPack((x) => ({ ...x, qty: e.target.value }))} placeholder={`holds (${form.base_unit})`} style={{ ...ui.input, width: 120 }} />
          <label style={{ fontSize: 12 }}><input type="checkbox" checked={pack.count} onChange={(e) => setPack((x) => ({ ...x, count: e.target.checked }))} /> count</label>
          <label style={{ fontSize: 12 }}><input type="checkbox" checked={pack.buy} onChange={(e) => setPack((x) => ({ ...x, buy: e.target.checked }))} /> buy</label>
          <Btn small onClick={addPack}>Add pack</Btn>
        </div>
      )}

      <div style={ui.label}>Unit bridges</div>
      {(detail?.bridges || []).map((b) => (
        <div key={b.id} style={{ ...ui.row, padding: '5px 0', borderTop: '1px solid var(--bdr)', fontSize: 13 }}>
          <span style={{ flex: 1 }}>{fmtNum(b.from_qty)} {b.from_unit} = {fmtNum(b.to_qty)} {b.to_unit} {b.archived && <Pill>archived</Pill>}</span>
          {canEdit && !b.archived && <Btn small kind="danger" onClick={() => stage([{ target: 'bridge', entity_id: b.id, data: { archived: true } }], 'Unit bridge off, in the draft.')}>Archive</Btn>}
        </div>
      ))}
      {canEdit && (
        <div style={{ ...ui.row, flexWrap: 'wrap', margin: '6px 0 14px' }}>
          <input type="number" min="0" step="any" value={bridge.fromQty} onChange={(e) => setBridge((x) => ({ ...x, fromQty: e.target.value }))} style={{ ...ui.input, width: 70 }} />
          <select value={bridge.fromUnit} onChange={(e) => setBridge((x) => ({ ...x, fromUnit: e.target.value }))} style={{ ...ui.input, width: 80 }}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select>
          <span>=</span>
          <input type="number" min="0" step="any" value={bridge.toQty} onChange={(e) => setBridge((x) => ({ ...x, toQty: e.target.value }))} style={{ ...ui.input, width: 70 }} />
          <select value={bridge.toUnit} onChange={(e) => setBridge((x) => ({ ...x, toUnit: e.target.value }))} style={{ ...ui.input, width: 80 }}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select>
          <Btn small onClick={addBridge}>Add bridge</Btn>
        </div>
      )}
      </>}

      {!create && (
        <>
          <div style={ui.label}>Supplier prices</div>
          {(detail?.prices || []).length === 0 && <div style={{ ...t.grey, marginBottom: 12 }}>None yet: add them in Suppliers and prices.</div>}
          {(detail?.prices || []).map((p) => (
            <div key={p.id} style={{ fontSize: 13, padding: '4px 0', borderTop: '1px solid var(--bdr)' }}>
              {p.supplier_name}: {p.pack_description || `${fmtNum(p.pack_qty)} x ${fmtNum(p.inner_qty)} ${p.inner_unit}`} at {money(p.pack_price)}{p.archived ? ' (archived)' : ''}
            </div>
          ))}
          <div style={{ ...ui.label, marginTop: 14 }}>Sites</div>
          <table style={t.table}>
            <thead><tr><th style={t.th}>Site</th><th style={t.th}>On</th><th style={t.th}>Made here</th><th style={t.th}>On hand</th><th style={t.th}>Cost here</th><th style={t.th}>Par</th></tr></thead>
            <tbody>
              {(detail?.sites || []).map((s) => (
                <tr key={s.location_id}>
                  <td style={t.td}>{s.name} {s.unlinked && <Pill>site's own</Pill>}</td>
                  <td style={t.td}><Switch small on={!!s.active} disabled={!canEdit} onChange={() => stage([{ target: 'item_site', entity_id: itemId, location_id: s.location_id, data: { active: !s.active } }], `${item.name}: ${s.active ? 'off' : 'on'} at ${s.name}, in the draft.`)} /></td>
                  <td style={t.td}><Switch small on={!!s.made_here} disabled={!canEdit} onChange={() => stage([{ target: 'item_site', entity_id: itemId, location_id: s.location_id, data: { made_here: !s.made_here } }], `${item.name}: ${s.made_here ? 'bought' : 'made'} at ${s.name}, in the draft.`)} /></td>
                  <td style={{ ...t.td, ...t.grey }}>{s.linked ? fmtNum(s.on_hand, item.base_unit) : 'not there yet'}</td>
                  <td style={{ ...t.td, ...t.grey }}>{s.cost != null ? money(s.cost) : ''}</td>
                  <td style={{ ...t.td, ...t.grey }}>{s.par != null ? fmtNum(s.par) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ ...t.grey, marginTop: 6 }}>On hand, cost and par are each site's own: read only here.</div>
        </>
      )}
      {asking === 'archive' && (
        <ConfirmDialog title={`Archive ${item.name}?`} danger yes="Archive it"
          words={held.length
            ? `It is archived at sites holding none. ${held.map((s) => `${s.name} holds ${fmtNum(s.on_hand, item.base_unit)}`).join('; ')}: it stays live there, with its pack and price, so it can be counted down. Count it to zero or write it off there; the next publish after that archives it.`
            : 'It is archived at every site when you publish. Its history stays.'}
          onYes={async () => { setAsking(null); const r = await stage([{ target: 'item', entity_id: itemId, data: { archived: true } }], `${item.name}: archived in the draft.`); if (r.ok) onClose(); }}
          onNo={() => setAsking(null)} />
      )}
    </Sheet>
  );
}
