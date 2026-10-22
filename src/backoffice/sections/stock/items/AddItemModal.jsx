/**
 * Stock items > + Add item (multi site stock Drop 1, mockup "Add item"): name, category, type,
 * base unit, the pack people use, supplier and its pack, price, allergens, and the sites it starts
 * at (pre ticked from the picker). Saved straight away: it is on those sites' count sheets and
 * Order pads at once, on hand 0. No publish.
 *
 * A login without company rights (Stock control 'Their sites') adds a LOCAL item instead:
 * 'Add a local item (<site> only)', at that one site. Head office can make it a company item later.
 *
 * Three saves, in order: stock_save_item (with the sites, or local), stock_save_pack (the pack
 * people use as the count and buy default), stock_save_supplier_item when a supplier was picked.
 * When a later one fails the item stays saved and the words say what did not.
 */

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../../store';
import { ALLERGENS } from '../../../../data/seed';
import { UNITS, DIMENSIONS } from '../../../../lib/stock/units';
import { stockApi } from '../../../../lib/stock/stockApi';
import { ITEM_TYPES, MAX_ROWS, addItemPlan, addItemSavedWords, checklistGroups, queuedWords, siteList, sortSites } from '../../../../lib/stock/itemListRules';
import { KIND_CHOICES } from '../../../../lib/stock/itemPageRules';
import { useStockScope } from '../../../StockScope';
import { Btn, Modal, SiteChecklist, Field, ui } from '../stockUi';

const UNIT_GROUPS = [DIMENSIONS.COUNT, DIMENSIONS.WEIGHT, DIMENSIONS.VOLUME].map((dim) => ({
  dim, label: dim[0] + dim.slice(1).toLowerCase(),
  units: Object.entries(UNITS).filter(([, u]) => u.dimension === dim).map(([code, u]) => ({ code, label: u.label })),
}));

function UnitPick({ value, onChange, label }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} style={{ ...ui.input, width: 'auto', minWidth: 120 }}>
      {UNIT_GROUPS.map((g) => (
        <optgroup key={g.dim} label={g.label}>
          {g.units.map((u) => <option key={u.code} value={u.code}>{u.label} ({u.code})</option>)}
        </optgroup>
      ))}
    </select>
  );
}

const BLANK = {
  name: '', kind: 'PURCHASED', categoryId: '', type: '', baseUnit: 'each', packName: '', packSize: '',
  supplierId: '', supplierProductName: '', packQty: '1', innerQty: '', innerUnit: 'each', price: '', allergens: [],
};
const twoCol = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '0 16px' };

export default function AddItemModal({ orgCtx = null, local = false, presetSites = [], onSaved, onClose }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const orgId = sc.orgId;
  const sites = useMemo(() => sortSites(siteList(sc.sites, sc.siteName)), [sc.sites, sc.siteName]);
  const groups = useMemo(() => checklistGroups(sc.groups, sites.map((s) => s.id)), [sc.groups, sites]);
  const localSiteId = local ? (presetSites || [])[0] || sc.oneSite?.id || null : null;
  const localName = localSiteId ? sc.siteName(localSiteId) : '';
  const [form, setForm] = useState(BLANK);
  const [chosen, setChosen] = useState(() => (presetSites || []).filter((id) => sites.some((s) => s.id === id)));
  const [cats, setCats] = useState([]);
  const [sups, setSups] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const dirty = !!form.name.trim() || !!form.supplierId || !!form.packName;

  useEffect(() => {
    if (!orgId) return undefined;
    let live = true;
    stockApi.categories(orgId).then((r) => { if (live && !r.error) setCats((r.data || []).filter((c) => !c.archived_at)); });
    (async () => {
      const all = [];
      let after = null;
      for (let i = 0; i < MAX_ROWS / 100; i++) {
        const r = await stockApi.suppliersPage({ orgId, sites: localSiteId ? [localSiteId] : null, search: null, filters: localSiteId ? { can_order_at: localSiteId } : null, after });
        if (!live || r.error) break;
        all.push(...(r.data?.rows || []).filter((s) => !s.archived_at));
        after = r.data?.next || null;
        if (!after) break;
      }
      if (live) setSups(all.map((s) => ({ id: s.id, name: s.name })));
    })();
    return () => { live = false; };
  }, [orgId, localSiteId]);

  const save = async () => {
    const plan = addItemPlan(form, { local, siteIds: chosen, localSiteId });
    if (plan.error) { setError(plan.error); return; }
    // Drop 2 (contract 3.4): with a supplier picked, the allergen chips go on the supplier pack (what
    // is in it comes from what you buy); the database rolls them up to the item. With no supplier they
    // stay on the item as before.
    const allergensOnPack = !!(plan.si && Array.isArray(plan.item.allergens) && plan.item.allergens.length);
    if (allergensOnPack) { plan.si.allergens = plan.item.allergens; delete plan.item.allergens; }
    setBusy(true); setError('');
    const made = await stockApi.saveItem({ item: plan.item, sites: plan.sites, version: null });
    if (made.error) { setBusy(false); setError(made.error.message); return; }
    const id = made.data?.id;
    const at = plan.item.location_id;
    const missed = [];
    if (id && plan.pack) {
      const p = await stockApi.savePack({ ...plan.pack, item_id: id, location_id: at }, null);
      if (p.error) missed.push(`The pack people use did not save: ${p.error.message}`);
    }
    if (id && plan.si) {
      const s = await stockApi.saveSupplierItem({ ...plan.si, item_id: id, location_id: at }, null, 'inventory');
      if (s.error) missed.push(`The supplier${allergensOnPack ? ', its price and the allergens' : ' and its price'} did not save: ${s.error.message}`);
    }
    setBusy(false);
    const n = local ? 1 : (made.data?.sites || plan.sites || []).length;
    try {
      if (missed.length) showToast?.(`Item saved. ${missed.join(' ')}`, 'warning');
      else showToast?.(addItemSavedWords(plan.item.name, n), 'success');
      if (made.queued?.length) showToast?.(queuedWords(made.queued), 'info');
    } catch { /* no toast, no harm */ }
    onSaved?.({ id, item: made.data, missed, by: orgCtx?.userName || null });
  };

  const title = local ? `Add a local item (${localName || 'this site'} only)` : 'Add item';
  return (
    <Modal title={title} onClose={onClose} width={720} dirty={dirty && !busy}
      footer={<><span style={{ flex: 1 }} /><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={busy || !form.name.trim()} onClick={save}>{busy ? 'Saving…' : 'Save'}</Btn></>}>
      <div style={twoCol}>
        <Field label="Name">
          <input value={form.name} onChange={(e) => set('name', e.target.value)} aria-label="Name" style={ui.input} autoFocus />
        </Field>
        <Field label="Category">
          <select value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)} aria-label="Category" style={ui.input}>
            <option value="">No category</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Type">
          <select value={form.type} onChange={(e) => set('type', e.target.value)} aria-label="Type" style={ui.input}>
            <option value="">Pick a type</option>
            {ITEM_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </Field>
        <Field label="Base unit" hint="What stock is counted and costed in underneath.">
          <UnitPick value={form.baseUnit} onChange={(v) => setForm((f) => ({ ...f, baseUnit: v, innerUnit: f.innerQty ? f.innerUnit : v }))} label="Base unit" />
        </Field>
        <Field label="Purchased or made" hint={form.kind === 'MADE' ? 'Made here from other items, such as a batch or a prep. Its recipe goes on Recipes.' : 'Bought from a supplier.'}>
          <select value={form.kind} onChange={(e) => set('kind', e.target.value)} aria-label="Purchased or made" style={ui.input}>
            {KIND_CHOICES.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </Field>
      </div>

      <Field label="Pack people use" hint={`What people count in, for example a bottle of 2000 ${form.baseUnit}. Leave empty to count in ${form.baseUnit}.`}>
        <div style={{ ...ui.row, flexWrap: 'wrap' }}>
          <input value={form.packName} onChange={(e) => set('packName', e.target.value)} placeholder="bottle" aria-label="Pack people use: name" style={{ ...ui.input, width: 180 }} />
          <input type="number" min="0" step="any" value={form.packSize} onChange={(e) => set('packSize', e.target.value)} placeholder="Size" aria-label="Pack people use: size" style={{ ...ui.input, width: 110 }} />
          <span style={ui.sub}>{form.baseUnit}</span>
        </div>
      </Field>

      <div style={twoCol}>
        <Field label="Supplier">
          <select value={form.supplierId} onChange={(e) => set('supplierId', e.target.value)} aria-label="Supplier" style={ui.input}>
            <option value="">No supplier yet</option>
            {sups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        {form.supplierId && (
          <Field label="Their name for it">
            <input value={form.supplierProductName} onChange={(e) => set('supplierProductName', e.target.value)} aria-label="Their name for it" style={ui.input} />
          </Field>
        )}
      </div>
      {form.supplierId && (
        <>
          <Field label="Supplier pack" hint="How the supplier sells it, for example 6 x 2 l.">
            <div style={{ ...ui.row, flexWrap: 'wrap' }}>
              <input type="number" min="1" step="any" value={form.packQty} onChange={(e) => set('packQty', e.target.value)} aria-label="Packs in the supplier pack" style={{ ...ui.input, width: 80 }} />
              <span style={ui.sub}>x</span>
              <input type="number" min="0" step="any" value={form.innerQty} onChange={(e) => set('innerQty', e.target.value)} placeholder="2" aria-label="Each pack holds" style={{ ...ui.input, width: 90 }} />
              <UnitPick value={form.innerUnit} onChange={(v) => set('innerUnit', v)} label="Unit of each pack" />
            </div>
          </Field>
          <Field label="Price" hint="What the supplier charges for that pack, before VAT.">
            <input type="number" min="0" step="any" value={form.price} onChange={(e) => set('price', e.target.value)} aria-label="Price" style={{ ...ui.input, width: 140 }} />
          </Field>
        </>
      )}

      <Field label="Allergens">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(ALLERGENS || []).map((a) => {
            const on = form.allergens.includes(a.id);
            return (
              <button key={a.id} type="button" aria-pressed={on}
                onClick={() => set('allergens', on ? form.allergens.filter((x) => x !== a.id) : [...form.allergens, a.id])}
                style={{ fontSize: 12, padding: '5px 10px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', background: on ? 'var(--bg3)' : 'var(--bg2)', color: on ? 'var(--t1)' : 'var(--t3)', border: `1px solid ${on ? 'var(--acc)' : 'var(--bdr)'}` }}>
                {a.label}
              </button>
            );
          })}
        </div>
      </Field>

      {!local && (
        <Field label="Sites" hint="Pre ticked from the picker. Each ticked site gets it at once, on hand 0.">
          <SiteChecklist sites={sites} value={chosen} onChange={setChosen} groups={groups} />
        </Field>
      )}
      {local && <div style={ui.sub}>Only {localName || 'this site'} gets this item. Head office can make it a company item later.</div>}
      {error && <div style={{ ...ui.err, marginTop: 10 }}>{error}</div>}
    </Modal>
  );
}
