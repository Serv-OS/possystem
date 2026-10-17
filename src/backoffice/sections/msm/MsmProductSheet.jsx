// src/backoffice/sections/msm/MsmProductSheet.jsx
//
// MULTI SITE MENU (v5.11.75): one product, everything about it, in a side panel: names,
// description, category (or a new one), size of, the group price and VAT, allergens, where it shows
// (till, kiosk, online, delivery), modifier groups, photo, item code, and a table of every site:
// on or off, the price there (blank follows the group price), GP, and any value that site keeps as
// its own (with "Use the group's").
//
// Also makes new products: "Add product" (sold at the sites ticked) and "Add site only extra"
// (one site only). Peter: "add items then say these items need to be on the POS by X date and
// time": a new product goes into the draft; publish it now or schedule the draft for a time.
//
// Save stages the changes (MultiSiteMenu.jsx stage). Nothing is live until the draft is published.

import { useEffect, useMemo, useState } from 'react';
import { ALLERGENS } from '../../../data/seed';
import { categoryTree, categoryPath, priceInput, price2, defaultFor } from '../../../lib/msm/msmGrid';
import {
  productUpdate, newProductChanges, newCategoryChange, siteActiveChange, sitePriceChange, groupValueChange,
  removeProductChange, restoreProductChange, taxChoices, productProblems,
} from '../../../lib/msm/msmEdit';
import { marginFor } from '../../../lib/msm/msmMargin';
import { Btn, Pill, Switch, Sheet, Field, Notice } from './msmUi';
import { ui, money } from './msmStyle';

const newId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)));

const VIS = [['pos', 'Till'], ['kiosk', 'Kiosk'], ['online', 'Online'], ['onlineDelivery', 'Delivery']];
const KEPT_WORDS = { cat: 'category', cats: 'extra categories', image: 'photo', name: 'name', menu_name: 'menu name', receipt_name: 'receipt name', kitchen_name: 'kitchen name', description: 'description', tax_rate_id: 'VAT rate', allergens: 'allergens', tags: 'tags', visibility: 'where it shows', sold_alone: 'sold on its own', item_code: 'item code', assigned_modifier_groups: 'modifier groups', type: 'type', parent_id: 'size of' };

function keptValueWords(col, v) {
  if (v == null || v === '') return 'none';
  if (Array.isArray(v)) return v.length ? `${v.length} set` : 'none';
  if (typeof v === 'object') return 'its own';
  if (col === 'cat') return 'its own category';
  return String(v).slice(0, 40);
}

export default function MsmProductSheet({ live, eff, ix, sites, ctx, stage, editable, costs, channel, productId, create, siteOnly, onClose, onCreated }) {
  const p = productId ? ix.products.get(productId) : null;
  const tree = useMemo(() => categoryTree(ix), [ix]);
  const taxes = useMemo(() => taxChoices(eff), [eff]);
  const blank = useMemo(() => ({
    name: '', menu_name: '', receipt_name: '', kitchen_name: '', description: '', category_id: '', parent_product_id: '',
    default_price: '', tax_rate_name: taxes[0]?.name ?? null, tax_rate_percent: taxes[0]?.percent ?? null,
    allergens: [], visibility: { pos: true, kiosk: true, online: true, onlineDelivery: true }, modifier_groups: [], image: '', item_code: '', sold_alone: true, type: 'simple',
  }), [taxes]);
  const fromProduct = (x) => ({
    name: x.name || '', menu_name: x.menu_name || '', receipt_name: x.receipt_name || '', kitchen_name: x.kitchen_name || '', description: x.description || '',
    category_id: x.category_id || '', parent_product_id: x.parent_product_id || '', default_price: price2(x.default_price),
    tax_rate_name: x.tax_rate_name ?? null, tax_rate_percent: x.tax_rate_percent ?? null, allergens: x.allergens || [],
    visibility: x.visibility || { pos: true, kiosk: true, online: true, onlineDelivery: true }, modifier_groups: x.modifier_groups || [],
    image: x.image || '', item_code: x.item_code || '', sold_alone: x.sold_alone !== false, type: x.type || 'simple',
  });
  const [form, setForm] = useState(() => (p ? fromProduct(p) : blank));
  // The per site table starts from what the grid shows (the sheet is opened afresh per product).
  const [siteForm, setSiteForm] = useState(() => {
    const out = {};
    for (const s of sites) {
      const ps = p ? ix.sites.get(`${p.id}|${s.id}`) : null;
      out[s.id] = ps
        ? { exists: true, active: ps.active !== false, price: ps.price == null ? '' : price2(ps.price) }
        : { exists: false, active: create ? (siteOnly ? s.id === siteOnly : true) : false, price: '' };
    }
    return out;
  });
  // What the sheet opened with: closing with changes typed asks first (Escape, a tap outside).
  const [startForm] = useState(form);
  const [startSites] = useState(siteForm);
  const [moreNames, setMoreNames] = useState(false);
  const [newCat, setNewCat] = useState(null);     // { label, parent_id, route_like_id }
  const [words, setWords] = useState('');
  const [saving, setSaving] = useState(false);
  const [showGp, setShowGp] = useState(false);

  useEffect(() => { if (showGp) costs.load(sites.map((s) => s.id)); }, [showGp, costs, sites]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const priceOk = priceInput(form.default_price);
  const groupPrice = priceOk.ok && priceOk.value != null ? priceOk.value : null;
  const visibleSites = siteOnly || p?.site_only_location_id ? sites.filter((s) => s.id === (siteOnly || p.site_only_location_id)) : sites;

  const fieldsOut = () => {
    const f = { ...form };
    f.default_price = groupPrice;
    f.parent_product_id = f.parent_product_id || null;
    f.category_id = f.category_id || null;
    f.menu_name = f.menu_name || f.name;
    for (const k of ['receipt_name', 'kitchen_name', 'image', 'item_code']) f[k] = String(f[k] || '').trim() || null;
    return f;
  };

  const save = async () => {
    setWords('');
    const changes = [];
    let catId = form.category_id;
    if (newCat) {
      const cid = newId();
      const c = newCategoryChange(ctx, { id: cid, label: newCat.label, parent_id: newCat.parent_id || null, route_like_id: newCat.route_like_id || null });
      if (c.words) { setWords(c.words); return; }
      changes.push(c.change);
      catId = cid;
    }
    const fields = { ...fieldsOut(), category_id: catId || null };
    if (create) {
      const id = newId();
      const chosen = visibleSites.filter((s) => siteForm[s.id]?.active).map((s) => {
        const pr = priceInput(siteForm[s.id]?.price);
        return { location_id: s.id, active: true, price: pr.ok ? pr.value : null };
      });
      const bad = visibleSites.find((s) => siteForm[s.id]?.active && !priceInput(siteForm[s.id]?.price).ok);
      if (bad) { setWords(`The price at ${bad.name} is not a price.`); return; }
      const ctxNew = newCat ? { ...ctx, eff: { ...eff, categories: [...(eff.categories || []), { id: catId, label: newCat.label }] } } : ctx;
      const r = newProductChanges(ctxNew, { id, fields: { ...fields, site_only_location_id: siteOnly || null }, sites: chosen });
      if (r.words) { setWords(r.words); return; }
      changes.push(...r.changes);
      setSaving(true);
      const res = await stage(changes, { done: `${fields.name} is in the draft${siteOnly ? ` for ${sites.find((s) => s.id === siteOnly)?.name}` : ` at ${chosen.length} site${chosen.length === 1 ? '' : 's'}`}. Publish now, or schedule the draft for the time it must be on the tills.` });
      setSaving(false);
      if (res?.ok) onCreated?.(id);
      return;
    }
    // An existing product: its own fields, then each site.
    if (newCat && !fields.category_id) { setWords('Pick a category.'); return; }
    const ctxEdit = newCat ? { ...ctx, eff: { ...eff, categories: [...(eff.categories || []), { id: catId, label: newCat.label }] } } : ctx;
    const pu = productUpdate(ctxEdit, p.id, fields);
    if (pu.words) { setWords(pu.words); return; }
    if (pu.change) changes.push(pu.change);
    // Site prices are worked out against the group price as it will be after this save.
    const effAfter = pu.change ? { ...eff, products: eff.products.map((x) => (x.id === p.id ? { ...x, ...pu.change.after } : x)) } : eff;
    const ctxSites = { live, eff: effAfter };
    for (const s of visibleSites) {
      const sf = siteForm[s.id];
      if (!sf) continue;
      const pr = priceInput(sf.price);
      if (!pr.ok) { setWords(`The price at ${s.name} is not a price.`); return; }
      if (!sf.exists) {
        if (!sf.active) continue;
        const a = siteActiveChange(ctxSites, p.id, s.id, true);
        if (a.words) { setWords(a.words); return; }
        if (a.change && pr.value != null && pr.value !== Number(effAfter.products.find((x) => x.id === p.id)?.default_price)) a.change.after.price = pr.value;
        if (a.change) changes.push(a.change);
        continue;
      }
      const a = siteActiveChange(ctxSites, p.id, s.id, sf.active);
      if (a.change) changes.push(a.change);
      const pc = sitePriceChange(ctxSites, p.id, s.id, pr.value, null);
      if (pc.words) { setWords(`${s.name}: ${pc.words}`); return; }
      if (pc.change) changes.push(pc.change);
    }
    if (!changes.length) { onClose(); return; }
    setSaving(true);
    const res = await stage(changes, { done: `${fields.name}: ${changes.length} change${changes.length === 1 ? '' : 's'} in the draft.` });
    setSaving(false);
    if (res?.ok) onClose();
  };

  const remove = async () => {
    const r = p.archived ? restoreProductChange(ctx, p.id) : removeProductChange(ctx, p.id);
    if (r.words) { setWords(r.words); return; }
    setSaving(true);
    const res = await stage([r.change], { done: p.archived ? `${p.name} comes back when the draft is published.` : `${p.name} comes off every site when the draft is published. Nothing is deleted.` });
    setSaving(false);
    if (res?.ok) onClose();
  };

  const toGroupValue = async (loc, col) => {
    const r = groupValueChange(ctx, p.id, loc, col);
    if (r.change) await stage([r.change], { done: `${sites.find((s) => s.id === loc)?.name} will use the group's ${KEPT_WORDS[col] || col} once published.` });
  };

  if (!create && !p) return <Sheet title="Product" onClose={onClose}><Notice>That product is no longer in the group menu.</Notice></Sheet>;
  const problems = create ? productProblems({ ...fieldsOut(), category_id: newCat ? 'new' : form.category_id }, ctx) : [];
  const title = create ? (siteOnly ? `New site only extra: ${sites.find((s) => s.id === siteOnly)?.name || ''}` : 'New product') : (p.menu_name || p.name);
  const sizesOf = [...ix.products.values()].filter((x) => !x.archived && !x.parent_product_id && x.id !== p?.id && x.type !== 'subitem').sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const groups = eff.groups || [];

  return (
    <Sheet title={title} width={640} onClose={onClose}
      dirty={editable && !saving && (!!newCat || JSON.stringify(form) !== JSON.stringify(startForm) || JSON.stringify(siteForm) !== JSON.stringify(startSites))}
      dirtyWords={create ? 'Close without adding it? What you typed is lost.' : 'Close without saving? Your changes are not in the draft.'}
      sub={create ? 'Goes into the draft. It reaches the tills when the draft is published, now or at a time you choose.' : `${categoryPath(ix, p.category_id) || 'No category'}${p.site_only_location_id ? ' · site only extra' : ''}${p.archived ? ' · removed' : ''}`}
      footer={editable ? (
        <>
          <Btn kind="primary" disabled={saving || (create && problems.length > 0)} onClick={save}>{saving ? 'Saving…' : create ? 'Add to the draft' : 'Save to the draft'}</Btn>
          <Btn onClick={onClose}>Cancel</Btn>
          <div style={{ flex: 1 }} />
          {!create && <Btn kind="danger" disabled={saving} onClick={remove}>{p.archived ? 'Bring back' : 'Remove from every site'}</Btn>}
        </>
      ) : <span style={ui.sub}>You can look but not change the group menu.</span>}>
      {words && <div style={{ marginBottom: 12 }}><Notice tone="bad">{words}</Notice></div>}
      <fieldset disabled={!editable} style={{ border: 'none', padding: 0, margin: 0 }}>
        <Field label="Name">
          <input style={ui.input} value={form.name} maxLength={120} onChange={(e) => set('name', e.target.value)} placeholder="Like Gingerbread latte" />
        </Field>
        {!moreNames && <Btn small kind="link" style={{ marginTop: -8, marginBottom: 8 }} onClick={() => setMoreNames(true)}>Menu, receipt and kitchen names</Btn>}
        {moreNames && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <Field label="On the menu"><input style={ui.input} value={form.menu_name} placeholder={form.name} onChange={(e) => set('menu_name', e.target.value)} /></Field>
            <Field label="On the receipt"><input style={ui.input} value={form.receipt_name} placeholder={form.name} onChange={(e) => set('receipt_name', e.target.value)} /></Field>
            <Field label="In the kitchen"><input style={ui.input} value={form.kitchen_name} placeholder={form.name} onChange={(e) => set('kitchen_name', e.target.value)} /></Field>
          </div>
        )}
        <Field label="Description">
          <textarea style={{ ...ui.input, minHeight: 58, resize: 'vertical' }} value={form.description} onChange={(e) => set('description', e.target.value)} />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Category">
            {!newCat ? (
              <>
                <select style={ui.input} value={form.category_id} onChange={(e) => { if (e.target.value === '__new') { setNewCat({ label: '', parent_id: '', route_like_id: form.category_id || '' }); } else set('category_id', e.target.value); }}>
                  <option value="">Pick a category</option>
                  {tree.map((t) => <option key={t.id} value={t.id}>{'  '.repeat(t.depth)}{t.label}</option>)}
                  <option value="__new">+ New category…</option>
                </select>
              </>
            ) : (
              <div style={{ ...ui.card, padding: 12, boxShadow: 'none' }}>
                <input autoFocus style={{ ...ui.input, marginBottom: 8 }} placeholder="New category name, like Christmas" value={newCat.label} onChange={(e) => setNewCat({ ...newCat, label: e.target.value })} />
                <span style={ui.label}>Under</span>
                <select style={{ ...ui.input, marginBottom: 8 }} value={newCat.parent_id} onChange={(e) => setNewCat({ ...newCat, parent_id: e.target.value })}>
                  <option value="">Top level</option>
                  {tree.map((t) => <option key={t.id} value={t.id}>{'  '.repeat(t.depth)}{t.label}</option>)}
                </select>
                {!newCat.parent_id && (
                  <>
                    <span style={ui.label}>Prints like</span>
                    <select style={{ ...ui.input, marginBottom: 4 }} value={newCat.route_like_id} onChange={(e) => setNewCat({ ...newCat, route_like_id: e.target.value })}>
                      <option value="">Pick a category</option>
                      {tree.map((t) => <option key={t.id} value={t.id}>{'  '.repeat(t.depth)}{t.label}</option>)}
                    </select>
                    <div style={{ ...ui.sub, fontSize: 11.5, marginBottom: 6 }}>Its tickets go to the same printers and kitchen screens as that category, at every site.</div>
                  </>
                )}
                <Btn small kind="link" onClick={() => setNewCat(null)}>Use an existing category</Btn>
              </div>
            )}
          </Field>
          <Field label="Size of" hint="Leave blank unless this is a size of another product.">
            <select style={ui.input} value={form.parent_product_id} onChange={(e) => set('parent_product_id', e.target.value)}>
              <option value="">Not a size</option>
              {sizesOf.map((x) => <option key={x.id} value={x.id}>{x.menu_name || x.name}</option>)}
            </select>
          </Field>
          <Field label={`Group price${channel ? ' (In store)' : ''}`} hint="Every site charges this unless it has its own price below.">
            <input style={{ ...ui.input, width: 140 }} inputMode="decimal" placeholder="0.00" value={form.default_price} onChange={(e) => set('default_price', e.target.value)} />
            {!priceOk.ok && <div style={{ ...ui.err, marginTop: 4 }}>{priceOk.words}</div>}
          </Field>
          <Field label="VAT" hint="Matched to each site's own rate by name and rate.">
            <select style={ui.input} value={form.tax_rate_percent == null ? '' : `${form.tax_rate_name || ''}|${form.tax_rate_percent}`}
              onChange={(e) => { const [n, pc] = e.target.value.split('|'); set('tax_rate_name', n || null); setForm((f) => ({ ...f, tax_rate_name: n || null, tax_rate_percent: pc === undefined || pc === '' ? null : Number(pc) })); }}>
              <option value="">No VAT rate</option>
              {taxes.map((t) => <option key={t.label} value={`${t.name || ''}|${t.percent}`}>{t.label}</option>)}
            </select>
          </Field>
        </div>
        {form.type === 'subitem' && <div style={{ marginBottom: 12 }}><Notice>Sold as an option (a milk, a syrup, an extra). When its price or name changes, the option follows at every site.</Notice></div>}

        {/* Every site */}
        <div style={{ ...ui.row, margin: '6px 0 8px' }}>
          <div style={{ ...ui.h2, flex: 1 }}>{visibleSites.length === 1 && (siteOnly || p?.site_only_location_id) ? 'The site' : 'Sites'}</div>
          {!create && <label style={{ ...ui.row, fontSize: 12.5, cursor: 'pointer' }}><input type="checkbox" checked={showGp} onChange={(e) => setShowGp(e.target.checked)} /> Show GP</label>}
        </div>
        <div style={{ border: '1px solid var(--bdr)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
          {visibleSites.map((s, i) => {
            const sf = siteForm[s.id] || { exists: false, active: false, price: '' };
            const ps = p ? ix.sites.get(`${p.id}|${s.id}`) : null;
            const pr = priceInput(sf.price);
            const charge = pr.ok && pr.value != null ? pr.value : groupPrice;
            const kept = ps?.kept && typeof ps.kept === 'object' ? Object.entries(ps.kept) : [];
            const costMap = costs.byLoc[s.id];
            const gp = showGp && ps && costMap ? marginFor({ price: charge, vatPct: Number(form.tax_rate_percent) || 0, cost: costMap.get(ps.venue_item_id) ?? null }) : null;
            const elsewhere = p?.site_only_location_id && p.site_only_location_id !== s.id;
            return (
              <div key={s.id} style={{ padding: '10px 12px', borderTop: i ? '1px solid var(--bdr)' : 'none', opacity: sf.active ? 1 : 0.7 }}>
                <div style={{ ...ui.row }}>
                  <Switch on={sf.active} disabled={!editable || elsewhere} onChange={(v) => setSiteForm((m) => ({ ...m, [s.id]: { ...sf, active: v } }))} />
                  <div style={{ flex: 1, fontSize: 13, fontWeight: 650 }}>
                    {s.name}
                    {!sf.exists && !create && <span style={{ ...ui.sub, marginLeft: 8 }}>{sf.active ? 'will be added here' : 'not sold here'}</span>}
                  </div>
                  <input aria-label={`Price at ${s.name}`} style={{ ...ui.input, width: 110, textAlign: 'right', borderColor: pr.ok ? 'var(--bdr2)' : 'var(--red)' }} inputMode="decimal"
                    disabled={!editable || !sf.active} placeholder={groupPrice != null ? `${price2(groupPrice)} (group)` : 'group price'}
                    value={sf.price} onChange={(e) => setSiteForm((m) => ({ ...m, [s.id]: { ...sf, price: e.target.value } }))} />
                </div>
                {(gp || kept.length > 0) && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6, paddingLeft: 44 }}>
                    {gp && <Pill tone={gp.noRecipe ? 'neutral' : 'acc'}>{gp.noRecipe ? 'No recipe' : `${gp.words} · cost ${money(gp.cost)}`}</Pill>}
                    {kept.map(([col, v]) => (
                      <span key={col} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <Pill tone="blue" title="This site keeps its own value; publishing never changes it there">Keeps its own {KEPT_WORDS[col] || col}: {keptValueWords(col, v)}</Pill>
                        {editable && <Btn small kind="link" onClick={() => toGroupValue(s.id, col)}>Use the group's</Btn>}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <Field label="Allergens">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {ALLERGENS.map((a) => {
              const on = (form.allergens || []).includes(a.id);
              return <button key={a.id} type="button" onClick={() => set('allergens', on ? form.allergens.filter((x) => x !== a.id) : [...(form.allergens || []), a.id])}
                style={{ padding: '5px 10px', borderRadius: 20, border: `1px solid ${on ? 'var(--amber, #F5A623)' : 'var(--bdr2)'}`, background: on ? 'color-mix(in srgb, var(--amber, #F5A623) 16%, transparent)' : 'transparent', color: on ? 'var(--t1)' : 'var(--t3)', fontSize: 12, fontWeight: 650, cursor: 'pointer', fontFamily: 'inherit' }}>{a.label}</button>;
            })}
          </div>
        </Field>
        <Field label="Shows on">
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            {VIS.map(([k, l]) => (
              <label key={k} style={{ ...ui.row, fontSize: 13, cursor: 'pointer' }}>
                <Switch small on={form.visibility?.[k] !== false} onChange={(v) => set('visibility', { ...(form.visibility || {}), [k]: v })} /> {l}
              </label>
            ))}
          </div>
        </Field>
        {groups.length > 0 && (
          <Field label="Modifier groups" hint="The groups themselves are edited in each site's Menu Manager.">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
              {groups.map((g) => {
                const on = (form.modifier_groups || []).some((m) => m.groupId === g.id);
                return (
                  <label key={g.id} style={{ ...ui.row, fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={on} onChange={() => set('modifier_groups', on ? form.modifier_groups.filter((m) => m.groupId !== g.id) : [...(form.modifier_groups || []), { groupId: g.id }])} />
                    {g.name}
                  </label>
                );
              })}
            </div>
          </Field>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
          <Field label="Photo (web address)">
            <div style={{ ...ui.row }}>
              {form.image && <img src={form.image} alt="" style={{ width: 38, height: 38, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--bdr)' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
              <input style={ui.input} value={form.image} placeholder="https://" onChange={(e) => set('image', e.target.value)} />
            </div>
          </Field>
          <Field label="Item code"><input style={ui.input} value={form.item_code} onChange={(e) => set('item_code', e.target.value)} /></Field>
        </div>
        {create && problems.length > 0 && <div style={{ ...ui.sub, color: 'var(--t3)' }}>To add it: {problems.join(' ')}</div>}
        {!create && p && <div style={{ ...ui.sub, fontSize: 11.5, marginTop: 6 }}>Group price now {money(defaultFor(p))}. Changes save to the draft, not to the tills.</div>}
      </fieldset>
    </Sheet>
  );
}
