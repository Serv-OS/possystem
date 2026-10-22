// src/backoffice/sections/stock/items/ItemDetailsTab.jsx
//
// MULTI SITE STOCK Drop 1 (mockup scrItem 'details'): the company fields of one stock item. Name,
// Category (the company list, with + New category), Type, Base unit (locked once a site has stock,
// counts, pars or orders on it), SKU, Barcode, Purchase VAT (by rate: "VAT 20%" at one site and
// "Standard Rate 20%" at another are one choice), Shelf life, Notes, the three ticks and the
// allergens as today. Save sends only what changed, with the version this screen loaded
// (stock_save_item): every site changes straight away, no publish. When someone saved first, the
// SavedFirstModal shows only the fields THEY changed that this screen says otherwise (onTopRows) and
// nothing is overwritten; "Save mine on top" sends this screen against their version, so each listed
// field goes back to what the table calls Yours and their other changes stay. When nothing of theirs
// clashes, the screen saves again on their version with no question.
// A login that cannot change company records sees every field greyed (never hidden) under the lock
// line drawn by ItemPage.
// Drop 2 (contract 3.4): in a multi site company the allergens come from the supplier items (what
// each site buys), so the chips become one read only line, 'Allergens: Milk, Gluten · from
// Freshways (3 sites)', with 'Change them on the Suppliers tab'. The chips stay editable only when
// the item has no supplier item (stock_item_detail facts.source 'item').

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../../store';
import { ALLERGENS } from '../../../../data/seed';
import { useStockScope } from '../../../StockScope';
import { stockApi } from '../../../../lib/stock/stockApi';
import { UNITS, DIMENSIONS } from '../../../../lib/stock/units';
import {
  ITEM_TYPES, FIELD_WORDS, detailsDraft, detailsPatch, onTopRows, vatChoices, sameRate, queuedNote, factsLine,
} from '../../../../lib/stock/itemPageRules';
import { Btn, Pill, Field, ui } from '../stockUi';
import SavedFirstModal from '../SavedFirstModal';
import CategoriesModal from './CategoriesModal';

const UNIT_OPTS = Object.entries(UNITS).map(([code, u]) => ({ code, ...u }));
const DIM_ORDER = [DIMENSIONS.COUNT, DIMENSIONS.WEIGHT, DIMENSIONS.VOLUME];
const NEW_CATEGORY = '__new_category__';
const DETAIL_WORDS = Object.freeze(Object.fromEntries(['name', 'category_id', 'type', 'base_unit', 'sku', 'barcode', 'purchase_vat_rate',
  'shelf_life_days', 'notes', 'exclude_from_gp', 'key_item', 'returns_to_shelf', 'allergens'].map((k) => [k, FIELD_WORDS[k]])));

const off = (locked) => (locked ? { opacity: 0.55, cursor: 'not-allowed' } : null);
const tickRow = { display: 'flex', gap: 7, alignItems: 'center', fontSize: 13, color: 'var(--t2)' };

export default function ItemDetailsTab({ detail, editable = false, reload, homeSiteId = null, onTab = null }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const storeRates = useStore((s) => s.taxRates);
  const item = useMemo(() => detail?.item || {}, [detail]);
  const orgId = item.org_id || sc.orgId || null;
  const locked = !editable;
  const unitLocked = detail?.unit_locked === true;
  // the allergens come from the supplier items: one read only line instead of the chips (multi site only)
  const allergenLine = sc.multi ? factsLine(detail) : null;
  const [draft, setDraft] = useState(() => detailsDraft(item));
  const [cats, setCats] = useState({ rows: [], error: null, loading: true });
  const [catsTry, setCatsTry] = useState(0);
  const [catsOpen, setCatsOpen] = useState(false);
  const [rates, setRates] = useState(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(null);
  const upd = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const say = (words, tone = 'success') => { try { showToast?.(words, tone); } catch { /* no toast, no harm */ } };

  useEffect(() => {
    if (!orgId) return undefined;
    let live = true;
    stockApi.categories(orgId).then((r) => { if (live) setCats({ rows: r.data || [], error: r.error || null, loading: false }); });
    return () => { live = false; };
  }, [orgId, catsTry]);

  // Purchase VAT by rate: every rate of the company's sites' tax rows (stockApi.siteTaxRates). Until
  // that read answers (or if it fails), the signed in venue's rates and the item's own.
  const siteIds = useMemo(() => (sc.sites || []).map((s) => s.id), [sc.sites]);
  useEffect(() => {
    if (typeof stockApi.siteTaxRates !== 'function' || !siteIds.length) return undefined;
    let live = true;
    stockApi.siteTaxRates(siteIds).then((r) => { if (live && Array.isArray(r?.data)) setRates(r.data); });
    return () => { live = false; };
  }, [siteIds]);
  const vatList = vatChoices(rates || storeRates || [], item.purchase_vat_rate);

  const catName = (id) => cats.rows.find((c) => c.id === id)?.name || (id && id === item.category_id ? (item.category_name || item.category || '') : '');
  const catOptions = useMemo(() => {
    const list = cats.rows.map((c) => ({ id: c.id, name: c.name }));
    if (item.category_id && !list.some((c) => c.id === item.category_id)) list.unshift({ id: item.category_id, name: item.category_name || item.category || 'This category' });
    return list;
  }, [cats.rows, item.category_id, item.category_name, item.category]);

  // Someone saved first: read their version, list only what THEY changed that this screen says
  // otherwise. Nothing of theirs clashes: save again on their version (once), no question.
  const openConflict = async (c, again = true) => {
    const fresh = await stockApi.itemDetail(item.id);
    const freshItem = fresh.data?.item || null;
    if (!freshItem) { say(fresh.error?.message || c.message || 'Someone saved this first. Reload it, then save again.', 'error'); return false; }
    const names = Object.fromEntries(cats.rows.map((x) => [x.id, x.name]));
    if (freshItem.category_id && !names[freshItem.category_id]) names[freshItem.category_id] = freshItem.category_name || freshItem.category || '';
    if (item.category_id && !names[item.category_id]) names[item.category_id] = item.category_name || item.category || '';
    if (draft.category_id && !names[draft.category_id]) names[draft.category_id] = catName(draft.category_id);
    const rows = onTopRows(detailsDraft(item), draft, detailsDraft(freshItem), DETAIL_WORDS, { names });
    const version = fresh.data?.row_version ?? freshItem.row_version ?? c.row_version ?? null;
    if (!rows.length && again) return save(version, false, freshItem, false);
    setConflict({ byName: c.by_name || 'Someone', at: c.at || null, rows, version, fresh: freshItem });
    return false;
  };

  // base: the item this screen's changes are measured against (the item it read, or after someone
  // saved first, their version, so "Save mine on top" sends exactly what the table calls Yours).
  const save = async (versionOverride = null, onTop = false, base = item, again = true) => {
    const { patch, error } = detailsPatch(draft, base);
    if (error) { say(error, 'error'); return false; }
    if (!Object.keys(patch).length) {
      if (base !== item) { setConflict(null); say('Nothing to save: the item already says what this screen says.', 'info'); reload?.(); return !onTop; }
      say('Nothing changed.', 'info');
      return true;
    }
    setSaving(true);
    const r = await stockApi.saveItem({ item: { id: item.id, location_id: homeSiteId || undefined, ...patch }, version: versionOverride ?? detail?.row_version ?? item.row_version ?? null });
    setSaving(false);
    if (r.conflict) { await openConflict(r.conflict, again && !onTop); return false; }
    if (r.error) { say(r.error.message, 'error'); return false; }
    const note = queuedNote(r.queued);
    // after "Save mine on top" SavedFirstModal says 'Saved on top of <First>'s version...' itself
    if (!onTop) say(`Saved. Changed at every site straight away.${note ? ` ${note}` : ''}`);
    setConflict(null);
    reload?.();
    return true;
  };

  const field = { ...ui.input, ...off(locked) };
  return (
    <div style={ui.card}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0 16px', maxWidth: 900 }}>
        <Field label="Name"><input value={draft.name} disabled={locked} onChange={(e) => upd('name', e.target.value)} style={field} /></Field>
        <Field label="Category" hint={cats.error ? cats.error.message : null}>
          <select value={draft.category_id || ''} disabled={locked} style={field}
            onChange={(e) => { if (e.target.value === NEW_CATEGORY) { setCatsOpen(true); return; } upd('category_id', e.target.value || null); }}>
            <option value="">{cats.loading ? 'Loading…' : 'No category'}</option>
            {catOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            {!locked && sc.canEditCompany('inventory') && <option value={NEW_CATEGORY}>+ New category</option>}
          </select>
        </Field>
        <Field label="Type">
          <select value={draft.type || ''} disabled={locked} onChange={(e) => upd('type', e.target.value || null)} style={field}>
            <option value="">Not set</option>
            {ITEM_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </Field>
        <Field label="Base unit" hint={unitLocked ? 'Locked: a site has stock, counts, pars or orders on it.' : null}>
          <select value={draft.base_unit || ''} disabled={locked || unitLocked} onChange={(e) => upd('base_unit', e.target.value)} style={{ ...field, ...off(locked || unitLocked) }}>
            {DIM_ORDER.map((dim) => (
              <optgroup key={dim} label={dim[0] + dim.slice(1).toLowerCase()}>
                {UNIT_OPTS.filter((u) => u.dimension === dim).map((u) => <option key={u.code} value={u.code}>{u.label} ({u.code})</option>)}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="SKU"><input value={draft.sku} disabled={locked} onChange={(e) => upd('sku', e.target.value)} style={field} /></Field>
        <Field label="Barcode"><input value={draft.barcode} disabled={locked} onChange={(e) => upd('barcode', e.target.value)} style={field} /></Field>
        <Field label="Purchase VAT" hint="The VAT you pay when you buy it. Cost and GP always use the price without VAT.">
          <select value={vatList.find((v) => sameRate(v.value, draft.purchase_vat_rate))?.label || 'None set'} disabled={locked} style={field}
            onChange={(e) => upd('purchase_vat_rate', vatList.find((v) => v.label === e.target.value)?.value ?? null)}>
            {vatList.map((v) => <option key={v.label} value={v.label}>{v.label}</option>)}
          </select>
        </Field>
        <Field label="Shelf life (days)"><input type="number" min="0" step="1" value={draft.shelf_life_days} disabled={locked} onChange={(e) => upd('shelf_life_days', e.target.value)} style={field} /></Field>
      </div>

      <Field label="Notes" style={{ maxWidth: 900 }}>
        <textarea value={draft.notes} disabled={locked} onChange={(e) => upd('notes', e.target.value)} style={{ ...field, minHeight: 60, resize: 'vertical' }} />
      </Field>

      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 14 }}>
        <label style={{ ...tickRow, ...off(locked) }}><input type="checkbox" disabled={locked} checked={draft.exclude_from_gp} onChange={(e) => upd('exclude_from_gp', e.target.checked)} /> Leave out of GP</label>
        <label style={{ ...tickRow, ...off(locked) }}><input type="checkbox" disabled={locked} checked={draft.key_item} onChange={(e) => upd('key_item', e.target.checked)} /> Key item (counted daily)</label>
        <label style={{ ...tickRow, ...off(locked) }}><input type="checkbox" disabled={locked} checked={draft.returns_to_shelf} onChange={(e) => upd('returns_to_shelf', e.target.checked)} /> Can go back on the shelf after a refund</label>
      </div>

      {allergenLine ? (
        <Field label="Allergens" hint="From the supplier items each site buys. Every recipe using this item reads them.">
          <div style={{ ...ui.lockline, gap: 8 }}>
            <span style={{ color: 'var(--t1)' }}>{allergenLine.words}</span>
            {allergenLine.needsCheck && <Pill tone="warn">Check again</Pill>}
            {typeof onTab === 'function'
              ? <Btn small kind="link" onClick={() => onTab('suppliers')}>{allergenLine.link}</Btn>
              : <span>{allergenLine.link}</span>}
          </div>
        </Field>
      ) : (
      <Field label="Allergens">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(ALLERGENS || []).map((a) => {
            const id = a.id || a;
            const lbl = a.label || a.name || a;
            const on = (draft.allergens || []).includes(id);
            return (
              <button key={id} type="button" disabled={locked} aria-pressed={on}
                onClick={() => upd('allergens', on ? draft.allergens.filter((x) => x !== id) : [...(draft.allergens || []), id])}
                style={{ fontSize: 12, padding: '5px 10px', borderRadius: 6, cursor: locked ? 'not-allowed' : 'pointer', background: on ? 'var(--bg3)' : 'var(--bg2)', color: on ? 'var(--t1)' : 'var(--t3)', border: '1px solid ' + (on ? 'var(--acc)' : 'var(--bdr)'), opacity: locked ? 0.55 : 1, fontFamily: 'inherit' }}>
                {lbl}
              </button>
            );
          })}
        </div>
      </Field>
      )}

      {editable && (
        <div style={{ ...ui.row, marginTop: 4 }}>
          <Btn kind="primary" onClick={() => save()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Btn>
        </div>
      )}

      {catsOpen && <CategoriesModal orgId={orgId} onClose={() => { setCatsOpen(false); setCatsTry((n) => n + 1); }} />}
      {conflict && (
        <SavedFirstModal byName={conflict.byName} at={conflict.at} rows={conflict.rows} busy={saving}
          onKeepTheirs={() => { setConflict(null); reload?.(); }}
          onSaveMine={() => save(conflict.version, true, conflict.fresh || item, false)}
          onClose={() => setConflict(null)} />
      )}
    </div>
  );
}
