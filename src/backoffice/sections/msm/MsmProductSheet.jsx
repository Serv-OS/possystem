// src/backoffice/sections/msm/MsmProductSheet.jsx
//
// MULTI SITE MENU (v5.11.75): one product, everything about it, in a side panel: names,
// description, category (or a new one), size of, the group price and VAT, allergens, where it shows,
// option groups, photo, item code, and a table of every site: on or off, the price there (blank
// follows the group price), GP, and any value that site keeps as its own (with "Use the group's").
//
// Also makes new products: "Add product" sold at every site (sites can be turned off) or at one site
// only. Peter: "add items then say these items need to be on the POS by X date and time": a new
// product goes into the draft; publish it now or schedule the draft for a time.
//
// ROUND 2 (17 Oct 2026; Peter: "set tax and price per order type ... a bit more idiot proof"):
//   * What is this?  A product, or a sub item (used inside option groups), with "Also sold on its
//     own" (Menu Manager's rule: becoming a sub item turns it off, becoming a product turns it on).
//   * Prices by order type (Eat in, Takeaway, Collection, Drive thru; Delivery is a platform price
//     set by the platform's own menu): one box per order type the company sells, group and per site;
//     blank shows what it falls back to, from the till's own chain (lib/msm/msmOrderTypes.js).
//   * VAT by order type (Eat in, Takeaway, Delivery, Bar tab when sold): "Same as the product's VAT"
//     or one of the sites' own rates, with a live example worked out by the real VAT engine.
//   * No "Shows on" switches (Peter, UI issue 2): which menu feeds which platform is chosen at each
//     site, as in the normal menu builder; publish leaves each site's visibility as it is.
//   * Option groups ticked and put in order here; built on the Option groups tab.
//   * A sub item whose price or name changes: "Donut is also an option in Choose 3 Donuts (0.00).
//     Option prices are set separately." Nothing follows by itself.
//   * Before "Add to draft": what it does in sentences, and the warnings that need a tick.
//
// Save stages the changes (MultiSiteMenu.jsx stage). Nothing is live until the draft is published.

import { useEffect, useMemo, useState } from 'react';
import { ALLERGENS } from '../../../data/seed';
import { categoryTree, categoryPath, priceInput, price2, defaultFor, noPriceWords } from '../../../lib/msm/msmGrid';
import {
  productUpdate, newProductChanges, newCategoryChange, siteActiveChange, sitePriceChange,
  removeProductChange, restoreProductChange, taxChoices, productProblems, renameFields,
} from '../../../lib/msm/msmEdit';
import * as groupEdit from '../../../lib/msm/msmGroupEdit';
import { groupTickSiteRows } from '../../../lib/msm/msmGroupView';
import { sheetSaveBlocked } from '../../../lib/msm/msmPublishView';
import { isOptionOnlyItem } from '../../../lib/menuRules';
import { shownPriceTypes, shownTaxTypes, groupTypeFallback, siteTypeFallback, siteRateChoices, choiceToRate, rateToChoice, sitesMissingRate, vatExample, examplePrice } from '../../../lib/msm/msmOrderTypes';
import { PRICE_TYPE_WORDS, PRICE_TYPE_HELP, TAX_TYPE_WORDS, TAX_TYPE_HELP, HELP, colWord, keptValueWords, sizeVatWords } from '../../../lib/msm/msmWords';
import { summarise } from '../../../lib/msm/msmSummary';
import { riskChecks, allTicked } from '../../../lib/msm/msmRisk';
import { marginFor } from '../../../lib/msm/msmMargin';
import { ORDER_TYPE_TAX_KEYS, samePrice, sameValue, pctText, noPriceAt } from '../../../../supabase/functions/_shared/msmModel.js';
import { Btn, Pill, Switch, Sheet, Field, Notice, Segmented, SummaryBox, ConfirmTicks } from './msmUi';
import { ui, money } from './msmStyle';
import { draftCount } from '../../../lib/msm/msmStatus';
import { useConfirm } from './useConfirm';
import MsmPhotoField from './MsmPhotoField';
import MenuItemFactsPanel from '../stock/MenuItemFactsPanel';   // v5.11.93 (multi site stock Drop 2)

const newId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)));

const EXAMPLE_TYPES = [['dine-in', 'Eat in'], ['takeaway', 'Takeaway'], ['collection', 'Collection'], ['delivery', 'Delivery']];
const gidOf = (a) => (typeof a === 'string' ? a : a?.groupId ?? a?.id ?? null);
const chText = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v != null).map(([k, v]) => [k, price2(v)]));

// A product made sold (a sub item switched to sold on its own, or to A product) that shows nowhere
// gets the normal "shows everywhere", as a new product does: publish writes it whole at each site.
const ALL_ON = { pos: true, kiosk: true, online: true, onlineDelivery: true };
function withSoldVisibility(f) {
  if (isOptionOnlyItem(f)) return f;
  const v = f.visibility && typeof f.visibility === 'object' ? f.visibility : null;
  return v && Object.values(v).some((x) => x === true) ? f : { ...f, visibility: ALL_ON };
}

export default function MsmProductSheet({ live, eff, ix, sites, ctx, stage, editable, costs, productId, create, ratesByLoc = {}, sales, openGroup, openProduct, onClose, onCreated }) {
  const p = productId ? ix.products.get(productId) : null;
  const tree = useMemo(() => categoryTree(ix), [ix]);
  const rateChoices = useMemo(() => {
    const fromSites = siteRateChoices(ratesByLoc, sites.map((s) => s.id));
    const known = new Set(fromSites.map((x) => x.value));
    const fromMenu = taxChoices(eff).map((t) => ({ ...t, value: rateToChoice(t) })).filter((t) => !known.has(t.value));
    return [...fromSites, ...fromMenu];
  }, [ratesByLoc, sites, eff]);
  const orderTypes = useMemo(() => shownPriceTypes(eff), [eff]);
  const taxTypes = useMemo(() => shownTaxTypes(eff), [eff]);
  const [allTypes, setAllTypes] = useState(false);
  const priceTypes = allTypes ? [...orderTypes.types, ...orderTypes.hidden] : orderTypes.types;

  const firstRate = rateChoices[0] || null;
  const blank = useMemo(() => ({
    name: '', menu_name: '', receipt_name: '', kitchen_name: '', description: '', category_id: '', parent_product_id: '',
    default_price: '', tax_rate_name: firstRate?.name ?? null, tax_rate_percent: firstRate?.percent ?? null, tax_by_type: {},
    allergens: [], visibility: { pos: true, kiosk: true, online: true, onlineDelivery: true }, modifier_groups: [], image: '', item_code: '', sold_alone: true, type: 'simple',
    default_channels: {},
  }), [firstRate]);
  const fromProduct = (x) => ({
    name: x.name || '', menu_name: x.menu_name || '', receipt_name: x.receipt_name || '', kitchen_name: x.kitchen_name || '', description: x.description || '',
    category_id: x.category_id || '', parent_product_id: x.parent_product_id || '', default_price: price2(x.default_price),
    tax_rate_name: x.tax_rate_name ?? null, tax_rate_percent: x.tax_rate_percent ?? null, tax_by_type: x.tax_by_type || {}, allergens: x.allergens || [],
    visibility: x.visibility || { pos: true, kiosk: true, online: true, onlineDelivery: true }, modifier_groups: x.modifier_groups || [],
    image: x.image || '', item_code: x.item_code || '', sold_alone: x.type === 'subitem' ? x.sold_alone === true : x.sold_alone !== false, type: x.type || 'simple',
    default_channels: chText(x.default_channels),
  });
  const [form, setForm] = useState(() => (p ? fromProduct(p) : blank));
  // The per site table starts from what the grid shows (the sheet is opened afresh per product).
  const [siteForm, setSiteForm] = useState(() => {
    const out = {};
    for (const s of sites) {
      const ps = p ? ix.sites.get(`${p.id}|${s.id}`) : null;
      out[s.id] = ps
        ? { exists: true, active: ps.active !== false, price: ps.price == null ? '' : price2(ps.price), channels: chText(ps.channel_prices) }
        : { exists: false, active: !!create, price: '', channels: {} };
    }
    return out;
  });
  // What the sheet opened with: closing with changes typed asks first (Escape, a tap outside).
  const [startForm] = useState(form);
  const [startSites] = useState(siteForm);
  const [ids] = useState(() => ({ product: newId(), category: newId() }));
  const [moreNames, setMoreNames] = useState(false);
  const [newCat, setNewCat] = useState(null);     // { label, parent_id, route_like_id }
  const [words, setWords] = useState('');
  const [saving, setSaving] = useState(false);
  const [showGp, setShowGp] = useState(false);
  const [ticked, setTicked] = useState(() => new Set());
  const [example, setExample] = useState(() => ({ loc: sites[0]?.id || null, type: 'takeaway' }));
  const [factsOpen, setFactsOpen] = useState(false);   // v5.11.93: the per site facts panels read only once opened
  const [confirm, confirmDialog] = useConfirm();

  useEffect(() => { if (showGp) costs.load(sites.map((s) => s.id)); }, [showGp, costs, sites]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setSite = (loc, patch) => setSiteForm((m) => ({ ...m, [loc]: { ...m[loc], ...patch } }));
  const priceOk = priceInput(form.default_price);
  const groupPrice = priceOk.ok && priceOk.value != null ? priceOk.value : null;
  // Every site, always: a product on at one site is a normal product (Peter, UI issue 6).
  const visibleSites = sites;
  const isSub = form.type === 'subitem';
  const optionOnly = isSub && !form.sold_alone;
  const siteName = useMemo(() => new Map(sites.map((s) => [s.id, s.name])), [sites]);

  // The group's order type prices as numbers (blank = none).
  const groupChannels = () => {
    const out = { ...(p?.default_channels || {}) };
    for (const k of priceTypes) { const r = priceInput(form.default_channels?.[k] ?? ''); out[k] = r.ok ? r.value : null; }
    for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
    if (Object.keys(out).length) return out;
    // Nothing set: keep the row exactly as it is ({ dineIn: null, ... } and null say the same).
    const was = p?.default_channels;
    return was && Object.values(was).every((v) => v == null) ? was : null;
  };

  const fieldsOut = () => {
    const f = { ...form };
    f.default_price = groupPrice;
    f.parent_product_id = f.parent_product_id || null;
    f.category_id = f.category_id || null;
    f.menu_name = f.menu_name || f.name;
    for (const k of ['receipt_name', 'kitchen_name', 'image', 'item_code']) f[k] = String(f[k] || '').trim() || null;
    f.default_channels = groupChannels();
    const tbt = {};
    for (const k of ORDER_TYPE_TAX_KEYS) if (form.tax_by_type?.[k]) tbt[k] = form.tax_by_type[k];
    f.tax_by_type = Object.keys(tbt).length ? tbt : null;
    return f;
  };

  // ── The changes the sheet stages (worked out every render, so the summary is always true) ──
  const plan = (() => {
    const changes = [];
    const bad = (w) => ({ changes: [], words: w });
    if (!priceOk.ok) return bad(priceOk.words);
    for (const k of priceTypes) { const r = priceInput(form.default_channels?.[k] ?? ''); if (!r.ok) return bad(`The group ${PRICE_TYPE_WORDS[k]} price is not a price.`); }
    let catId = form.category_id;
    if (newCat) {
      const c = newCategoryChange(ctx, { id: ids.category, label: newCat.label, parent_id: newCat.parent_id || null, route_like_id: newCat.route_like_id || null });
      if (c.words) return bad(c.words);
      changes.push(c.change);
      catId = ids.category;
    }
    const fields = { ...fieldsOut(), category_id: catId || null };
    const effCat = newCat ? { ...eff, categories: [...(eff.categories || []), { id: catId, label: newCat.label }] } : eff;
    if (create) {
      const chosen = [];
      for (const s of visibleSites) {
        const sf = siteForm[s.id];
        if (!sf?.active) continue;
        const pr = priceInput(sf.price);
        if (!pr.ok) return bad(`The price at ${s.name} is not a price.`);
        chosen.push({ location_id: s.id, active: true, price: pr.value });
      }
      const r = newProductChanges({ ...ctx, eff: effCat }, { id: ids.product, fields: { ...fields, site_only_location_id: null }, sites: chosen });
      if (r.words) return bad(r.words);
      changes.push(...r.changes);
      // Order type prices of each new site, set straight on its create.
      for (const c of changes) {
        if (c.target !== 'product_site') continue;
        const ch = {};
        for (const k of priceTypes) { const v = priceInput(siteForm[c.location_id]?.channels?.[k] ?? ''); if (v.ok && v.value != null) ch[k] = v.value; }
        if (Object.keys(ch).length) c.after.channel_prices = ch;
      }
      // Its option groups switched on at the sites it is sold at, where they have no options yet
      // (no row means off: the group would land there empty).
      if (!isOptionOnlyItem(fields)) changes.push(...groupTickSiteRows(ctx, [], fields.modifier_groups, chosen.map((c) => c.location_id), groupEdit));
      return { changes, words: '', id: ids.product, chosen: chosen.length, fields };
    }
    // An existing product: its own fields, then each site.
    const pu = productUpdate({ ...ctx, eff: effCat }, p.id, fields);
    if (pu.words) return bad(pu.words);
    if (pu.change) changes.push(pu.change);
    // Site prices are worked out against the group as it will be after this save.
    const effAfter = pu.change ? { ...eff, products: eff.products.map((x) => (x.id === p.id ? { ...x, ...pu.change.after } : x)) } : eff;
    const ctxSites = { live, eff: effAfter };
    const prodAfter = effAfter.products.find((x) => x.id === p.id);
    for (const s of visibleSites) {
      const sf = siteForm[s.id];
      if (!sf) continue;
      const pr = priceInput(sf.price);
      if (!pr.ok) return bad(`The price at ${s.name} is not a price.`);
      if (!sf.exists) {
        if (!sf.active) continue;
        const a = siteActiveChange(ctxSites, p.id, s.id, true);
        if (a.words) return bad(a.words);
        if (a.change && pr.value != null && !samePrice(pr.value, prodAfter?.default_price)) a.change.after.price = pr.value;
        if (a.change) changes.push(a.change, ...(a.extra || []));
        continue;
      }
      const a = siteActiveChange(ctxSites, p.id, s.id, sf.active);
      if (a.change) changes.push(a.change, ...(a.extra || []));
      const pc = sitePriceChange(ctxSites, p.id, s.id, pr.value, null);
      if (pc.words) return bad(`${s.name}: ${pc.words}`);
      if (pc.change) changes.push(pc.change);
      // Order type prices: only the order types shown here change; a price equal to what it falls
      // back to is stored as "follows" (blank).
      const ps = effAfter.productSites.find((x) => x.product_id === p.id && x.location_id === s.id);
      const cur = { ...(ps?.channel_prices || {}) };
      const next = { ...cur };
      for (const k of priceTypes) {
        const v = priceInput(sf.channels?.[k] ?? '');
        if (!v.ok) return bad(`The ${PRICE_TYPE_WORDS[k]} price at ${s.name} is not a price.`);
        const fall = siteTypeFallback(prodAfter, { ...ps, channel_prices: { ...next, [k]: null } }, k, pr.value).value;
        if (v.value == null || samePrice(v.value, fall)) delete next[k]; else next[k] = v.value;
      }
      for (const k of Object.keys(next)) if (next[k] == null) delete next[k];
      if (!sameValue(Object.keys(cur).length ? Object.fromEntries(Object.entries(cur).filter(([, v]) => v != null)) : {}, next)) {
        const liveS = (live?.productSites || []).find((x) => x.product_id === p.id && x.location_id === s.id);
        changes.push({ target: 'product_site', entity_id: p.id, location_id: s.id, op: 'update', after: { channel_prices: Object.keys(next).length ? next : null }, before: { channel_prices: liveS?.channel_prices ?? null } });
      }
    }
    // A group newly ticked here: its options switched on at the sites this product will be sold at,
    // where they have no row yet (the same rule as Add to products; round 2 review).
    if (!optionOnly) {
      const sellLocs = visibleSites.filter((s) => siteForm[s.id]?.active).map((s) => s.id);
      changes.push(...groupTickSiteRows(ctx, p.modifier_groups, fields.modifier_groups, sellLocs, groupEdit));
    }
    // One row per product site (price, on or off, order type prices), and one product row.
    const merged = [];
    for (const c of changes) {
      const m = merged.find((x) => x.target === c.target && x.entity_id === c.entity_id && (x.location_id || null) === (c.location_id || null) && (x.op === c.op || c.target === 'product'));
      if (m && (c.target === 'product_site' || (c.target === 'product' && m.op === 'update' && c.op === 'update'))) { Object.assign(m.after, c.after); Object.assign(m.before, c.before); } else merged.push({ ...c, after: { ...c.after }, before: { ...(c.before || {}) } });
    }
    return { changes: merged, words: '', fields };
  })();

  // The summary and the ticks read names and last week's sales from the group menu as the grid shows
  // it (new products and groups are named from their own change rows).
  const lines = summarise(plan.changes, eff, { siteNames: siteName });
  const risks = riskChecks(plan.changes, eff, sales ?? null, null, { siteNames: siteName, ratesByLoc });
  const ready = allTicked(risks, ticked);

  const save = async () => {
    if (plan.words) { setWords(plan.words); return; }
    if (!plan.changes.length) { onClose(); return; }
    setWords('');
    setSaving(true);
    const nm = plan.fields?.name || form.name;
    const done = create
      ? `${nm} is in the draft${optionOnly ? ' as a sub item (only an option)' : ` at ${plan.chosen} site${plan.chosen === 1 ? '' : 's'}`}. Publish now, or schedule the draft for the time it must be on the tills.`
      : `${nm}: in the draft (${draftCount(plan.changes, eff).words}).`;
    const res = await stage(plan.changes, { done });
    setSaving(false);
    if (!res?.ok) return;
    if (create) onCreated?.(plan.id); else onClose();
  };

  const remove = async () => {
    if (!p.archived) {
      const yes = await confirm({
        title: `Take ${p.menu_name || p.name} off every site?`,
        words: 'It is turned off when you publish. Nothing is deleted; you can bring it back.',
        yes: 'Take it off every site', no: 'Keep it', danger: true,
      });
      if (!yes) return;
    }
    const r = p.archived ? restoreProductChange(ctx, p.id) : removeProductChange(ctx, p.id);
    if (r.words) { setWords(r.words); return; }
    setSaving(true);
    const res = await stage([r.change], { done: p.archived ? `${p.name} comes back when the draft is published.` : `${p.name} comes off every site when the draft is published. Nothing is deleted.`, undo: true });
    setSaving(false);
    if (res?.ok) onClose();
  };

  // "Use the group's" for a column a site keeps. VAT by order type gives back only the four order
  // type keys; the site's other keys (counter, drive thru, collection) are only noted, never written.
  const toGroupValue = async (loc, col) => {
    const ps = ix.sites.get(`${p.id}|${loc}`);
    if (!ps?.kept) return;
    const kept = { ...ps.kept };
    if (col === 'tax_overrides') {
      const rest = Object.fromEntries(Object.entries(kept.tax_overrides || {}).filter(([k]) => !ORDER_TYPE_TAX_KEYS.includes(k)));
      if (Object.keys(rest).length) kept.tax_overrides = rest; else delete kept.tax_overrides;
    } else delete kept[col];
    const liveS = (live?.productSites || []).find((x) => x.product_id === p.id && x.location_id === loc);
    const change = { target: 'product_site', entity_id: p.id, location_id: loc, op: 'update', after: { kept }, before: { kept: ps.kept } };
    // VAT changes always need a tick (design 5.4 and 6.5): giving back a site's own VAT by order
    // type says what it becomes, and asks first.
    const vat = riskChecks([change], eff, null, null, { siteNames: siteName, ratesByLoc }).filter((r) => r.code === 'vat');
    if (vat.length) {
      const yes = await confirm({ title: `Use the group's VAT at ${siteName.get(loc)}?`, words: vat.map((r) => r.words).join('\n\n'), yes: 'Yes, I have checked', no: 'Keep the site\'s' });
      if (!yes) return;
    }
    await stage([{ ...change, before: { kept: liveS?.kept ?? {} } }],
      { done: `${siteName.get(loc)} will use the group's ${colWord(col)} once published.`, undo: true });
  };

  if (!create && !p) return <Sheet title="Product" onClose={onClose}><Notice>That product is no longer in the group menu.</Notice></Sheet>;
  const problems = create ? productProblems({ ...fieldsOut(), category_id: newCat ? 'new' : form.category_id }, ctx) : [];
  const title = create ? 'New product' : (p.menu_name || p.name);
  const sizesOf = [...ix.products.values()].filter((x) => !x.archived && !x.parent_product_id && x.id !== p?.id && x.type !== 'subitem').sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const groups = (eff.groups || []).filter((g) => !g.archived);
  // Two groups with one name (each site had its own when the menu was brought in) say which sites
  // they are at, so the list never shows the same name twice with nothing to tell them apart.
  const nameCount = new Map();
  for (const g of groups) nameCount.set(String(g.name).trim().toLowerCase(), (nameCount.get(String(g.name).trim().toLowerCase()) || 0) + 1);
  const groupLabel = (g) => {
    if ((nameCount.get(String(g.name).trim().toLowerCase()) || 0) < 2) return g.name;
    const at = (eff.groupSites || []).filter((r) => r.group_id === g.id).map((r) => siteName.get(r.location_id)).filter(Boolean);
    return `${g.name} (${at.length ? at.join(', ') : 'no site yet'})`;
  };
  const picked = (form.modifier_groups || []).map(gidOf).filter(Boolean);
  const dirty = !!newCat || JSON.stringify(form) !== JSON.stringify(startForm) || JSON.stringify(siteForm) !== JSON.stringify(startSites);
  const usedAsOption = p ? groupEdit.optionsUsingProduct(ctx, p.id) : [];
  const subChanged = !!p && usedAsOption.length > 0 && (form.name !== startForm.name || form.default_price !== startForm.default_price);
  const isSizeForm = !!form.parent_product_id;
  const parentOfForm = isSizeForm ? ix.products.get(form.parent_product_id) || null : null;
  const sizesOfThis = p ? [...ix.products.values()].filter((x) => x.parent_product_id === p.id && !x.archived) : [];
  // Priced by its sizes: typed so, or with live sizes under it (17 Oct recheck: as Menu Manager shows
  // it and publish writes it, its own Standard price is never charged or written).
  const isVariants = form.type === 'variants' || sizesOfThis.length > 0;
  // A size's VAT example reads its product's VAT by order type (what the till charges).
  const tbt = (isSizeForm ? parentOfForm?.tax_by_type : form.tax_by_type) || {};
  const productRate = form.tax_rate_percent == null ? null : { name: form.tax_rate_name, percent: form.tax_rate_percent };
  const missingFor = (rate) => sitesMissingRate(rate, ratesByLoc, visibleSites.map((s) => s.id)).map((l) => siteName.get(l));
  const exSite = example.loc && visibleSites.some((s) => s.id === example.loc) ? example.loc : visibleSites[0]?.id;
  const exPs = p && exSite ? ix.sites.get(`${p.id}|${exSite}`) : null;
  // The price the till charges for the picked order type there (its own box, else what it falls
  // back to), never the Standard price for every order type (round 2 review).
  const exPrice = (() => {
    const sf = siteForm[exSite] || {};
    const pr = priceInput(sf.price);
    const ch = {};
    for (const [k, v] of Object.entries(sf.channels || {})) { const r = priceInput(v ?? ''); if (r.ok && r.value != null) ch[k] = r.value; }
    return examplePrice(example.type, { default_price: groupPrice, default_channels: groupChannels() || {} }, { price: pr.ok ? pr.value : null, channel_prices: ch });
  })();
  const ex = exSite ? vatExample({ product: { name: form.menu_name || form.name || 'This product', tax_rate_name: form.tax_rate_name, tax_rate_percent: form.tax_rate_percent }, taxByType: tbt, kept: exPs?.kept?.tax_overrides || null, rates: ratesByLoc[exSite], orderType: example.type, price: exPrice, siteName: siteName.get(exSite) }) : null;

  return (
    <Sheet title={title} width={680} onClose={onClose}
      dirty={editable && !saving && dirty}
      dirtyWords={create ? 'Close without adding it? What you typed is lost.' : 'Close without saving? Your changes are not in the draft.'}
      sub={create ? 'Goes into the draft. It reaches the tills when the draft is published, now or at a time you choose.' : `${categoryPath(ix, p.category_id) || (isSub ? 'Sub item' : 'No category')}${p.archived ? ' · removed' : ''}`}
      footer={editable ? (
        <>
          <Btn kind="primary" disabled={sheetSaveBlocked({ saving, problems: create && problems.length > 0, words: plan.words, changes: plan.changes.length, create, ready, salesReading: sales === undefined })} onClick={save} data-testid="msm-product-save">
            {saving ? 'Adding…' : create ? 'Add to draft' : plan.changes.length ? `Add to draft: ${draftCount(plan.changes, eff).words}` : 'No changes yet'}
          </Btn>
          <Btn onClick={onClose}>Cancel</Btn>
          <div style={{ flex: 1 }} />
          {!create && <Btn kind="danger" disabled={saving} onClick={remove}>{p.archived ? 'Bring back' : 'Remove from every site'}</Btn>}
        </>
      ) : <span style={ui.sub}>You can look but not change the group menu.</span>}>
      {confirmDialog}
      {words && <div style={{ marginBottom: 12 }}><Notice tone="bad">{words}</Notice></div>}
      {/* min-width 0: a fieldset is as wide as its widest child by default, which pushed fields
          past the sheet's right edge (Peter, UI issue 5). */}
      <fieldset disabled={!editable} style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }}>
        <Field label="What is this?" hint={isSub ? HELP.subItem : 'A product customers buy, like a Latte.'}>
          <Segmented value={form.type === 'subitem' ? 'subitem' : 'product'} onChange={(v) => setForm((f) => withSoldVisibility({ ...f, type: v === 'subitem' ? 'subitem' : (f.type === 'subitem' ? 'simple' : f.type), sold_alone: v !== 'subitem' }))}
            options={[{ value: 'product', label: 'A product' }, { value: 'subitem', label: 'A sub item (used inside option groups)' }]} />
        </Field>
        {isSub && (
          <Field label="Also sold on its own" hint={HELP.soldAlone}>
            <Switch on={!!form.sold_alone} disabled={!editable} onChange={(v) => setForm((f) => withSoldVisibility({ ...f, sold_alone: v }))} />
          </Field>
        )}
        <Field label="Name">
          {/* The menu, receipt and kitchen names that still say the old name follow it (17 Oct
              verification: a rename left the till button, receipt and ticket on the old name). */}
          <input style={ui.input} value={form.name} maxLength={120} onChange={(e) => { const v = e.target.value; setForm((f) => renameFields(f, v)); }} placeholder="Like Gingerbread latte" />
        </Field>
        {!moreNames && <Btn small kind="link" style={{ marginTop: -8, marginBottom: 8 }} onClick={() => setMoreNames(true)}>Menu, receipt and kitchen names</Btn>}
        {moreNames && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            <Field label="On the menu" hint="Blank uses the name."><input style={ui.input} value={form.menu_name} placeholder={form.name} onChange={(e) => set('menu_name', e.target.value)} /></Field>
            <Field label="On the receipt" hint="Blank uses the name."><input style={ui.input} value={form.receipt_name} placeholder={form.name} onChange={(e) => set('receipt_name', e.target.value)} /></Field>
            <Field label="In the kitchen" hint="On kitchen screens and tickets."><input style={ui.input} value={form.kitchen_name} placeholder={form.name} onChange={(e) => set('kitchen_name', e.target.value)} /></Field>
          </div>
        )}
        <Field label="Description" hint="Shown on the kiosk and online.">
          <textarea style={{ ...ui.input, minHeight: 58, resize: 'vertical' }} value={form.description} onChange={(e) => set('description', e.target.value)} />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <Field label="Category" hint={optionOnly ? 'Not needed: a sub item only used as an option is never on a menu.' : 'Where it sits on the till, kiosk and online.'}>
            {!newCat ? (
              <select style={ui.input} value={form.category_id} onChange={(e) => { if (e.target.value === '__new') { setNewCat({ label: '', parent_id: '', route_like_id: form.category_id || '' }); } else set('category_id', e.target.value); }}>
                <option value="">{optionOnly ? 'No category' : 'Pick a category'}</option>
                {tree.map((t) => <option key={t.id} value={t.id}>{'  '.repeat(t.depth)}{t.label}</option>)}
                <option value="__new">+ New category…</option>
              </select>
            ) : (
              <div style={{ ...ui.card, padding: 12, boxShadow: 'none' }}>
                <input autoFocus style={{ ...ui.input, marginBottom: 8 }} placeholder="New category name, like Christmas" value={newCat.label} onChange={(e) => setNewCat({ ...newCat, label: e.target.value })} />
                <span style={ui.label}>Under</span>
                <select style={{ ...ui.input, marginBottom: 8 }} value={newCat.parent_id} onChange={(e) => setNewCat({ ...newCat, parent_id: e.target.value })}>
                  <option value="">Top level</option>
                  {tree.map((t) => <option key={t.id} value={t.id}>{'  '.repeat(t.depth)}{t.label}</option>)}
                </select>
                {!newCat.parent_id && (
                  <>
                    <span style={ui.label}>Prints like</span>
                    <select style={{ ...ui.input, marginBottom: 4 }} value={newCat.route_like_id} onChange={(e) => setNewCat({ ...newCat, route_like_id: e.target.value })}>
                      <option value="">Pick a category</option>
                      {tree.map((t) => <option key={t.id} value={t.id}>{'  '.repeat(t.depth)}{t.label}</option>)}
                    </select>
                    <div style={{ ...ui.sub, fontSize: 11.5, marginBottom: 6 }}>Its tickets go to the same printers and kitchen screens as that category, at every site.</div>
                  </>
                )}
                <Btn small kind="link" onClick={() => setNewCat(null)}>Use an existing category</Btn>
              </div>
            )}
          </Field>
          <Field label="Is this a size of another product?" hint="For example Large of Latte. Leave it as Not a size otherwise.">
            <select style={ui.input} value={form.parent_product_id} onChange={(e) => {
              const v = e.target.value;
              set('parent_product_id', v);
              // A new size is sold where its product is (17 Oct verification: it defaulted to every
              // site, and publish then blocked at a site that does not sell the product).
              if (create && v) setSiteForm((m) => Object.fromEntries(Object.entries(m).map(([loc, sf]) => { const pps = ix.sites.get(`${v}|${loc}`); return [loc, { ...sf, active: !!pps && pps.active !== false }]; })));
            }}>
              <option value="">Not a size</option>
              {sizesOf.map((x) => <option key={x.id} value={x.id}>{x.menu_name || x.name}</option>)}
            </select>
          </Field>
          {isVariants ? (
            <Field label="Price" hint="A product with sizes is never charged itself: each size has its own price.">
              <div style={{ ...ui.sub, fontSize: 12.5 }}>Priced by its sizes: open a size to change its price.</div>
              {sizesOfThis.length > 0 && openProduct && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  {sizesOfThis.map((x) => <Btn key={x.id} small kind="soft" onClick={() => openProduct(x.id)}>{x.menu_name || x.name}</Btn>)}
                </div>
              )}
            </Field>
          ) : (
          <Field label={isSub && !form.sold_alone ? 'Its own price' : 'Standard price'} hint={optionOnly ? 'Never charged: when picked as an option it costs what the option says.' : 'Every site charges this unless it has its own price below.'}>
            <input style={{ ...ui.input, width: 140 }} inputMode="decimal" placeholder="0.00" value={form.default_price} onChange={(e) => set('default_price', e.target.value)} />
            {!priceOk.ok && <div style={{ ...ui.err, marginTop: 4 }}>{priceOk.words}</div>}
          </Field>
          )}
          <Field label="VAT" hint="Each site uses its own VAT rate with this name.">
            <select style={ui.input} value={productRate ? rateToChoice(productRate) : ''}
              onChange={(e) => { const r = choiceToRate(e.target.value); setForm((f) => ({ ...f, tax_rate_name: r?.name ?? null, tax_rate_percent: r?.percent ?? null })); }}>
              <option value="">No VAT rate</option>
              {productRate && !rateChoices.some((t) => t.value === rateToChoice(productRate)) && <option value={rateToChoice(productRate)}>{productRate.name || 'VAT'} ({pctText(productRate.percent)})</option>}
              {rateChoices.map((t) => <option key={t.value} value={t.value}>{t.label}{t.sites != null && t.sites < sites.length ? ` (at ${t.sites} of ${sites.length} sites)` : ''}</option>)}
            </select>
            {productRate && missingFor(productRate).length > 0 && <div style={{ ...ui.err, marginTop: 4 }}>{missingFor(productRate).join(', ')} {missingFor(productRate).length === 1 ? 'has' : 'have'} no rate like this. Add it in Settings, Tax, or {missingFor(productRate).length === 1 ? 'that site' : 'those sites'} cannot be published.</div>}
          </Field>
        </div>

        {subChanged && (
          <div style={{ marginBottom: 12 }}>
            <Notice tone="info" actions={openGroup ? [{ label: 'Change the option prices too', onClick: () => openGroup(usedAsOption[0].group?.id) }] : null}>
              {p.menu_name || p.name} is also an option in {usedAsOption.slice(0, 3).map((u) => `${u.group?.name || 'a group'} (${money(u.option.price)})`).join(' and ')}{usedAsOption.length > 3 ? ` and ${usedAsOption.length - 3} more` : ''}. Option prices are set separately.
            </Notice>
          </div>
        )}

        {/* Every site: straight under the price, so Add to draft is never pressed without seeing
            where it is sold (17 Oct verification). */}
        <div style={{ ...ui.row, margin: '6px 0 8px' }}>
          <div style={{ ...ui.h2, flex: 1 }}>{optionOnly ? 'Sites (used as an option)' : 'Sold at'}</div>
          {!create && <label style={{ ...ui.row, fontSize: 12.5, cursor: 'pointer' }}><input type="checkbox" checked={showGp} onChange={(e) => setShowGp(e.target.checked)} /> Show GP</label>}
        </div>
        {optionOnly ? (
          <div style={{ ...ui.sub, marginBottom: 16 }}>A sub item only used as an option goes to each site where an option needs it, when published. It is never on a menu by itself.</div>
        ) : (
          <div style={{ border: '1px solid var(--bdr)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
            {visibleSites.map((s, i) => {
              const sf = siteForm[s.id] || { exists: false, active: false, price: '', channels: {} };
              const ps = p ? ix.sites.get(`${p.id}|${s.id}`) : null;
              const pr = priceInput(sf.price);
              const charge = pr.ok && pr.value != null ? pr.value : groupPrice;
              // "No price" is shown in words (17 Oct recheck), never as a setting the site keeps.
              const kept = ps?.kept && typeof ps.kept === 'object' ? Object.entries(ps.kept).filter(([col]) => col !== 'no_price') : [];
              const noPrice = !!ps && noPriceAt(p, ps) && !sf.price;
              const costMap = costs.byLoc[s.id];
              const gp = showGp && ps && costMap ? marginFor({ price: charge, vatPct: Number(form.tax_rate_percent) || 0, cost: costMap.get(ps.venue_item_id) ?? null }) : null;
              const elsewhere = false;
              const ownTypeKeys = Object.keys(ps?.kept?.tax_overrides || {}).filter((k) => ['drive-thru', 'collection'].includes(k) && ps.kept.tax_overrides[k] != null);
              return (
                <div key={s.id} style={{ padding: '10px 12px', borderTop: i ? '1px solid var(--bdr)' : 'none', opacity: sf.active ? 1 : 0.7 }}>
                  <div style={{ ...ui.row }}>
                    <Switch on={sf.active} disabled={!editable || elsewhere} title={sf.active ? `Sold at ${s.name}: turn off` : `Not sold at ${s.name}: turn on`} onChange={(v) => setSite(s.id, { active: v })} />
                    <div style={{ flex: 1, fontSize: 13, fontWeight: 650 }}>
                      {s.name}
                      {!sf.exists && !create && <span style={{ ...ui.sub, marginLeft: 8 }}>{sf.active ? 'will be sold here' : 'not sold here'}</span>}
                      {sf.exists && !sf.active && <span style={{ ...ui.sub, marginLeft: 8 }}>turned off here</span>}
                    </div>
                    {!isVariants && (
                      <input aria-label={`Price at ${s.name}`} style={{ ...ui.input, width: 120, textAlign: 'right', fontWeight: sf.price ? 750 : 500, borderColor: pr.ok ? 'var(--bdr2)' : 'var(--red)' }} inputMode="decimal"
                        disabled={!editable || !sf.active} placeholder={noPrice ? 'No price' : groupPrice != null ? price2(groupPrice) : 'group price'}
                        value={sf.price} onChange={(e) => setSite(s.id, { price: e.target.value })} />
                    )}
                    {!isVariants && sf.price && editable && sf.active && <Btn small kind="link" onClick={() => setSite(s.id, { price: '' })}>Use group price</Btn>}
                  </div>
                  {sf.active && !isVariants && priceTypes.length > 0 && (
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6, paddingLeft: 44 }}>
                      {priceTypes.map((k) => {
                        const fb = siteTypeFallback({ ...p, default_price: groupPrice, default_channels: groupChannels() || {} }, { ...(ps || {}), channel_prices: { ...(sf.channels || {}), [k]: null } }, k, pr.ok ? pr.value : null);
                        const r = priceInput(sf.channels?.[k] ?? '');
                        return (
                          <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--t2)' }} title={fb.words}>
                            {PRICE_TYPE_WORDS[k]}
                            <input aria-label={`${PRICE_TYPE_WORDS[k]} price at ${s.name}`} inputMode="decimal" style={{ ...ui.input, width: 76, padding: '4px 7px', textAlign: 'right', fontWeight: sf.channels?.[k] ? 750 : 500, borderColor: r.ok ? 'var(--bdr2)' : 'var(--red)' }}
                              placeholder={fb.value != null ? price2(fb.value) : ''} value={sf.channels?.[k] ?? ''} onChange={(e) => setSite(s.id, { channels: { ...(sf.channels || {}), [k]: e.target.value } })} />
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {(gp || kept.length > 0 || ownTypeKeys.length > 0 || (noPrice && !isVariants)) && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6, paddingLeft: 44 }}>
                      {noPrice && !isVariants && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <Pill tone="warn" title="Publishing never gives it a price there until you set one">{noPriceWords(s.name)}. Type a price to sell it there.</Pill>
                          {editable && <Btn small kind="link" onClick={() => toGroupValue(s.id, 'no_price')}>Use the group price</Btn>}
                        </span>
                      )}
                      {gp && <Pill tone={gp.noRecipe ? 'neutral' : 'acc'}>{gp.noRecipe ? 'No recipe' : `${gp.words} · cost ${money(gp.cost)}`}</Pill>}
                      {kept.filter(([col, v]) => !(col === 'tax_overrides' && !Object.keys(v || {}).some((k) => ORDER_TYPE_TAX_KEYS.includes(k)))).map(([col, v]) => (
                        <span key={col} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <Pill tone="blue" title="This site keeps its own value; publishing never changes it there">{s.name} keeps its own {colWord(col)}{col === 'tax_overrides' ? '' : `: ${keptValueWords(col, v, { rates: ratesByLoc[s.id] })}`}</Pill>
                          {editable && <Btn small kind="link" onClick={() => toGroupValue(s.id, col)}>Use the group's</Btn>}
                        </span>
                      ))}
                      {ownTypeKeys.length > 0 && tbt.takeaway && (
                        <span style={{ ...ui.sub, fontSize: 11.5 }}>{s.name} has its own {ownTypeKeys.map((k) => (k === 'drive-thru' ? 'Drive thru' : 'Collection')).join(' and ')} VAT on this, so the group Takeaway VAT will not reach {ownTypeKeys.length === 1 ? 'it' : 'them'} there.</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Prices by order type */}
        {!optionOnly && !isVariants && (
          <div style={{ ...ui.card, boxShadow: 'none', padding: 14, marginBottom: 14 }}>
            <div style={{ ...ui.row, marginBottom: 4 }}>
              <div style={{ ...ui.h2, flex: 1, margin: 0 }}>Prices by order type</div>
              {orderTypes.hidden.length > 0 && <Btn small kind="link" onClick={() => setAllTypes((x) => !x)}>{allTypes ? 'Show fewer order types' : priceTypes.length ? 'Show every order type' : 'Set a price for an order type'}</Btn>}
            </div>
            <div style={{ ...ui.sub, fontSize: 11.5, marginBottom: priceTypes.length ? 10 : 0 }}>
              {priceTypes.length ? 'Blank uses what it falls back to, shown in grey. The till, kiosk and online all read these.' : 'Every order type charges the Standard price. That is the usual way.'}
            </div>
            {priceTypes.map((k) => {
              const fb = groupTypeFallback({ ...p, default_price: groupPrice, default_channels: groupChannels() || {}, [k]: undefined }, k);
              const r = priceInput(form.default_channels?.[k] ?? '');
              return (
                <div key={k} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderTop: '1px solid var(--bdr)' }}>
                  <div style={{ width: 120, fontSize: 13, fontWeight: 700 }}>{PRICE_TYPE_WORDS[k]}</div>
                  <input aria-label={`Group ${PRICE_TYPE_WORDS[k]} price`} inputMode="decimal" style={{ ...ui.input, width: 110, textAlign: 'right', borderColor: r.ok ? 'var(--bdr2)' : 'var(--red)' }}
                    placeholder={fb.value != null ? price2(fb.value) : ''} value={form.default_channels?.[k] ?? ''} onChange={(e) => set('default_channels', { ...(form.default_channels || {}), [k]: e.target.value })} />
                  <div style={{ ...ui.sub, fontSize: 11.5, flex: 1 }}>{PRICE_TYPE_HELP[k]}</div>
                </div>
              );
            })}
          </div>
        )}

        {/* VAT by order type (a size uses its product's: it is never written on a size) */}
        {!optionOnly && isSizeForm && (
          <div style={{ ...ui.card, boxShadow: 'none', padding: 14, marginBottom: 14 }}>
            <div style={{ ...ui.h2, marginBottom: 4 }}>VAT by order type</div>
            <div style={{ ...ui.sub, fontSize: 12.5 }}>
              {sizeVatWords({ size: true, product: parentOfForm ? (parentOfForm.menu_name || parentOfForm.name) : 'its product', taxByType: parentOfForm?.tax_by_type || null })}
              {parentOfForm && openProduct && <> <Btn small kind="link" onClick={() => openProduct(parentOfForm.id)}>Open {parentOfForm.menu_name || parentOfForm.name}</Btn></>}
            </div>
            {ex && <div data-testid="msm-vat-example" style={{ fontSize: 13, fontWeight: 650, marginTop: 6, color: ex.ok ? 'var(--t1)' : 'var(--red)' }}>{ex.words}</div>}
          </div>
        )}
        {!optionOnly && !isSizeForm && (
          <div style={{ ...ui.card, boxShadow: 'none', padding: 14, marginBottom: 14 }}>
            <div style={{ ...ui.h2, marginBottom: 4 }}>VAT by order type</div>
            <div style={{ ...ui.sub, fontSize: 11.5, marginBottom: 10 }}>Most products use their VAT for everything. Set one only where it differs, for example cold food taken away.{sizesOfThis.length ? ` ${sizeVatWords({ size: false, sizes: sizesOfThis.length })}` : ''}</div>
            {taxTypes.map((k) => {
              const v = tbt[k] || null;
              const miss = v ? missingFor(v) : [];
              return (
                <div key={k} style={{ padding: '6px 0', borderTop: '1px solid var(--bdr)' }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ width: 120 }}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{TAX_TYPE_WORDS[k]}</div>
                      <div style={{ ...ui.sub, fontSize: 11 }}>{TAX_TYPE_HELP[k]}</div>
                    </div>
                    <select aria-label={`${TAX_TYPE_WORDS[k]} VAT`} style={{ ...ui.input, width: 'auto', minWidth: 240, flex: 1 }} value={v ? rateToChoice(v) : ''}
                      onChange={(e) => { const r = choiceToRate(e.target.value); const next = { ...tbt }; if (r) next[k] = r; else delete next[k]; set('tax_by_type', next); }}>
                      <option value="">Same as the product's VAT{productRate ? ` (${productRate.name || 'VAT'} ${pctText(productRate.percent)})` : ''}</option>
                      {v && !rateChoices.some((t) => t.value === rateToChoice(v)) && <option value={rateToChoice(v)}>{v.name} ({pctText(v.percent)})</option>}
                      {rateChoices.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </div>
                  {miss.length > 0 && <div style={{ ...ui.err, marginTop: 4 }}>{miss.join(', ')} {miss.length === 1 ? 'does' : 'do'} not have {v.name}. Add it in {miss.length === 1 ? `${miss[0]}'s` : "each site's"} Settings, Tax, or {miss.length === 1 ? 'that site' : 'those sites'} cannot be published. Or pick "Same as the product's VAT".</div>}
                </div>
              );
            })}
            {ex && (
              <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'var(--bg2)' }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ ...ui.label, margin: 0 }}>Try it</span>
                  <select aria-label="Example order type" style={{ ...ui.input, width: 'auto', padding: '4px 8px' }} value={example.type} onChange={(e) => setExample({ ...example, type: e.target.value })}>
                    {EXAMPLE_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                  {visibleSites.length > 1 && (
                    <select aria-label="Example site" style={{ ...ui.input, width: 'auto', padding: '4px 8px' }} value={exSite || ''} onChange={(e) => setExample({ ...example, loc: e.target.value })}>
                      {visibleSites.map((s) => <option key={s.id} value={s.id}>at {s.name}</option>)}
                    </select>
                  )}
                </div>
                <div data-testid="msm-vat-example" style={{ fontSize: 13, fontWeight: 650, color: ex.ok ? 'var(--t1)' : 'var(--red)' }}>{ex.words}</div>
                <div style={{ ...ui.sub, fontSize: 11 }}>Worked out by the same VAT rules the tills use. Collection and Drive thru use Takeaway.</div>
              </div>
            )}
          </div>
        )}

        {!optionOnly && groups.length > 0 && (
          <Field label="Option groups" hint="Tick the questions the till asks for this product, and put them in order. Build and change the groups themselves on the Option groups tab. Cooking preferences are set at each site in Menu Manager.">
            {picked.length > 0 && (
              <div style={{ border: '1px solid var(--bdr)', borderRadius: 10, marginBottom: 8 }}>
                {picked.map((gid, i) => {
                  const g = (eff.groups || []).find((x) => x.id === gid);
                  const mv = (to) => { const list = [...form.modifier_groups]; const [x] = list.splice(i, 1); list.splice(to, 0, x); set('modifier_groups', list); };
                  return (
                    <div key={gid} style={{ ...ui.row, padding: '6px 10px', borderTop: i ? '1px solid var(--bdr)' : 'none', fontSize: 13 }}>
                      <span style={{ ...ui.sub, width: 18 }}>{i + 1}</span>
                      <span style={{ flex: 1, minWidth: 0, fontWeight: 650, overflowWrap: 'anywhere' }}>{g ? groupLabel(g) : 'An option group'}{g?.archived ? ' (removed)' : ''}</span>
                      {openGroup && g && <Btn small kind="link" onClick={() => openGroup(gid)}>Open</Btn>}
                      <Btn small kind="ghost" disabled={i === 0} onClick={() => mv(i - 1)} aria-label="Move up">▲</Btn>
                      <Btn small kind="ghost" disabled={i === picked.length - 1} onClick={() => mv(i + 1)} aria-label="Move down">▼</Btn>
                      <Btn small kind="ghost" onClick={() => set('modifier_groups', form.modifier_groups.filter((m) => gidOf(m) !== gid))} aria-label="Take it off">×</Btn>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6 }}>
              {groups.filter((g) => !picked.includes(g.id)).map((g) => (
                <label key={g.id} title={groupLabel(g)} style={{ ...ui.row, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer', minWidth: 0 }}>
                  <input type="checkbox" checked={false} style={{ marginTop: 2 }} onChange={() => set('modifier_groups', [...(form.modifier_groups || []), { groupId: g.id }])} />
                  <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{groupLabel(g)}</span>
                </label>
              ))}
            </div>
          </Field>
        )}

        <Field label="Allergens">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {ALLERGENS.map((a) => {
              const on = (form.allergens || []).includes(a.id);
              return <button key={a.id} type="button" onClick={() => set('allergens', on ? form.allergens.filter((x) => x !== a.id) : [...(form.allergens || []), a.id])}
                style={{ padding: '5px 10px', borderRadius: 20, border: `1px solid ${on ? 'var(--amber, #F5A623)' : 'var(--bdr2)'}`, background: on ? 'color-mix(in srgb, var(--amber, #F5A623) 16%, transparent)' : 'transparent', color: on ? 'var(--t1)' : 'var(--t3)', fontSize: 12, fontWeight: 650, cursor: 'pointer', fontFamily: 'inherit' }}>{a.label}</button>;
            })}
          </div>
        </Field>
        {/* v5.11.93 (multi site stock Drop 2): read only, per site in reach, what the stock recipe linked
            at each site adds (menu_item_stock_facts). One read per site, only once opened. */}
        {p && !create && (
          <details style={{ marginBottom: 14 }} onToggle={(e) => setFactsOpen(e.currentTarget.open)}>
            <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 650 }}>From the recipe at each site</summary>
            <div style={{ ...ui.sub, marginTop: 6 }}>These come from the stock recipe linked at each site and are added to what is ticked above on every channel. They are never removed by themselves.</div>
            {factsOpen && visibleSites.map((s) => {
              const ps = ix.sites.get(`${p.id}|${s.id}`);
              return ps?.venue_item_id ? <MenuItemFactsPanel key={s.id} locationId={s.id} menuItemId={ps.venue_item_id} siteName={s.name} /> : null;
            })}
          </details>
        )}
        <div style={{ marginBottom: 14 }}>
          <MsmPhotoField value={form.image} productId={productId || ids.product} disabled={!editable} onChange={(url) => set('image', url)} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <Field label="Item code" hint="For barcodes and stock."><input style={ui.input} value={form.item_code} onChange={(e) => set('item_code', e.target.value)} /></Field>
        </div>
        {create && problems.length > 0 && <div style={{ ...ui.sub, color: 'var(--t3)' }}>To add it: {problems.join(' ')}</div>}
        {!create && p && <div style={{ ...ui.sub, fontSize: 11.5, marginTop: 6 }}>Group price now {money(defaultFor(p))}. Changes go into the draft, not to the tills.</div>}
      </fieldset>

      {editable && dirty && (
        <div style={{ display: 'grid', gap: 10, marginTop: 16 }}>
          {plan.words ? <Notice tone="bad">{plan.words}</Notice> : <SummaryBox lines={lines} empty={<div style={ui.sub}>{plan.changes.length ? 'These changes go into the draft.' : 'Nothing changed yet.'}</div>} />}
          {!plan.words && <ConfirmTicks risks={risks} ticked={ticked} onChange={setTicked} />}
          {sales === undefined && <div style={ui.sub}>Checking last week's sales, a few seconds.</div>}
        </div>
      )}
    </Sheet>
  );
}
