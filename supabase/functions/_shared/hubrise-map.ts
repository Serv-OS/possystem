// supabase/functions/_shared/hubrise-map.ts
//
// Pure mappers between the ServOS data model and HubRise:
//   1. buildCatalog()        ServOS menus/items/modifiers -> HubRise catalog `data` document
//   2. orderToQueueRow()     a HubRise order -> a ServOS order_queue row (source='hubrise')
//   3. status mapping        ServOS queue status <-> HubRise OrderStatus (monotonic-safe)
//
// HubRise catalog cross-refs are client-supplied strings, so we reuse our own
// menu_item / category / modifier-group / option ids as the HubRise `ref`s. That
// means an inbound order's sku_ref IS our menu_item id — no reverse lookup table.

import { toMoney, parseMoney } from './hubrise.ts';

const displayName = (it: any) => it?.menu_name || it?.name || 'Item';

// Defensive E.164 normalisation for inbound phone numbers. HubRise recommends E.164 and will make
// it mandatory; some channels still send local format. Conservative: keep already-+ numbers, map a
// UK national 0-prefix to +44 (ServOS is UK-primary), and otherwise pass through unchanged rather
// than guess a country code. Never throws.
function toE164(raw: unknown): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.startsWith('+')) return '+' + s.slice(1).replace(/[^\d]/g, '');
  const digits = s.replace(/[^\d]/g, '');
  if (!digits) return '';
  if (digits.startsWith('44')) return '+' + digits;        // already country-coded sans +
  if (digits.startsWith('0')) return '+44' + digits.slice(1); // UK national -> E.164
  return s; // unknown format — leave verbatim (we still store + display it)
}

// HubRise encodes order times in the STORE's timezone with that store's UTC offset
// ("…14:30:00+02:00"), so the wall-clock part IS already store-local. Extract a clean
// "HH:MM" (optionally "DD/MM HH:MM" when it's not the same calendar date as created_at) for
// display, instead of dumping the raw ISO. Returns null for ASAP/no time.
function hrTimeLabel(iso: unknown, createdIso?: unknown): string | null {
  const s = String(iso || '');
  const t = s.match(/T(\d{2}):(\d{2})/);
  if (!t) return null;
  const d = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const cd = String(createdIso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  const hhmm = `${t[1]}:${t[2]}`;
  // include the date only when the wanted day differs from the order-created day
  if (d && cd && d[0] !== cd[0]) return `${d[3]}/${d[2]} ${hhmm}`;
  return hhmm;
}

// ── 1. Catalog builder ───────────────────────────────────────────────────────

// Normalise a free-text allergen name from Menu Manager onto HubRise's EXACT allergen
// vocabulary (scraped from their catalog docs — the values are granular: gluten is split
// per grain, tree nuts per species; 'gluten' alone is REJECTED, verified live via a 422).
// A generic name expands to ALL its variants — over-declaring is the food-safe direction
// for allergy sufferers. Returns [] when nothing maps; the caller keeps those as tags so
// an unrecognised value can never abort the whole-document catalog PUT.
const HR_GLUTEN = ['gluten_barley', 'gluten_khorasan', 'gluten_oats', 'gluten_rye', 'gluten_spelt', 'gluten_wheat'];
const HR_NUTS = ['nuts_almond', 'nuts_brazil', 'nuts_cashew', 'nuts_hazelnut', 'nuts_macadamia_or_queensland', 'nuts_pecan', 'nuts_pistachio', 'nuts_walnut'];
function hubriseAllergen(raw: string): string[] {
  const k = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const MAP: Record<string, string[]> = {
    gluten: HR_GLUTEN, cereals_containing_gluten: HR_GLUTEN,
    wheat: ['gluten_wheat'], barley: ['gluten_barley'], oats: ['gluten_oats'],
    rye: ['gluten_rye'], spelt: ['gluten_spelt'],
    crustaceans: ['crustaceans'], crustacean: ['crustaceans'], shellfish: ['crustaceans'],
    eggs: ['eggs'], egg: ['eggs'],
    fish: ['fish'],
    peanuts: ['peanuts'], peanut: ['peanuts'],
    soybeans: ['soybeans'], soya: ['soybeans'], soy: ['soybeans'],
    milk: ['milk'], dairy: ['milk'], lactose: ['milk'],
    nuts: HR_NUTS, tree_nuts: HR_NUTS, nut: HR_NUTS,
    almonds: ['nuts_almond'], almond: ['nuts_almond'],
    hazelnuts: ['nuts_hazelnut'], hazelnut: ['nuts_hazelnut'],
    cashews: ['nuts_cashew'], cashew: ['nuts_cashew'],
    walnuts: ['nuts_walnut'], walnut: ['nuts_walnut'],
    pecans: ['nuts_pecan'], pistachios: ['nuts_pistachio'],
    celery: ['celery'],
    mustard: ['mustard'],
    sesame_seeds: ['sesame_seeds'], sesame: ['sesame_seeds'],
    sulphites: ['sulphur_dioxide_sulphites'], sulfites: ['sulphur_dioxide_sulphites'],
    sulphur_dioxide: ['sulphur_dioxide_sulphites'], sulphur_dioxide_sulphites: ['sulphur_dioxide_sulphites'], so2: ['sulphur_dioxide_sulphites'],
    lupin: ['lupin'],
    molluscs: ['molluscs'], mollusc: ['molluscs'], mollusks: ['molluscs'],
  };
  return MAP[k] ?? [];
}

export function buildCatalog(opts: {
  categories: any[];
  items: any[];
  modifierGroups: any[];
  currency: string;
  publishIds?: Set<string> | null;          // top-level item ids to publish (null = all online)
  itemMenuId?: Record<string, string | null>; // item id -> the HubRise-selected menu it belongs to (for tier pricing)
  channel?: string;                          // price channel to publish (default 'delivery')
  instructionGroups?: any[];                 // config-snapshot instruction defs [{id,name,options:[str]}] (cooking prefs etc.)
  imageIdByItem?: Record<string, string>;    // item id -> uploaded HubRise image id
}): { variants: any[]; categories: any[]; products: any[]; option_lists: any[]; deals: any[]; discounts: any[]; charges: any[] } {
  const ccy = opts.currency || 'GBP';
  const items = opts.items || [];
  const cats = opts.categories || [];
  const groups = opts.modifierGroups || [];
  const publishIds = opts.publishIds || null;
  const itemMenuId = opts.itemMenuId || {};
  const channel = opts.channel || 'delivery';
  const instrGroups = opts.instructionGroups || [];
  const imageIdByItem = opts.imageIdByItem || {};

  // Resolve the price for a given price channel, mirroring store.getItemPrice exactly:
  //   menu+channel -> menu.all -> channel default -> base. So HubRise publishes the
  // operator's DELIVERY price (and any per-menu "Deliveroo +X" tier), not the base price.
  const resolvePrice = (pricing: any, menuId: string | null): number => {
    const p = pricing || {};
    if (menuId && p.menus && p.menus[menuId]) {
      const t = p.menus[menuId];
      if (t[channel] != null) return t[channel];
      if (t.all != null) return t.all;
    }
    if (p[channel] != null) return p[channel];
    return p.base != null ? p.base : (p.price != null ? p.price : 0);
  };

  // What we publish: live items visible online, sold on their own (sold_alone !== false —
  // this INCLUDES type='subitem' items that are also sold standalone, e.g. donuts), NOT a
  // variant child (children are published as their parent's skus), and — when a menu filter
  // is set — only items in one of the selected menus. (We deliberately do NOT exclude
  // type='subitem' here: a subitem with sold_alone=true is a real standalone product.)
  const publishable = (it: any) =>
    it && !it.archived && it.sold_alone !== false && !it.parent_id &&
    (!it.visibility || it.visibility.online !== false) &&
    (!publishIds || publishIds.has(String(it.id)));

  const childrenOf = (parentId: string) =>
    items.filter((c) => c.parent_id === parentId && !c.archived);

  // Publish per-service-type tax rates with each product so the channel-side rates can
  // never drift from what our tax engine books into reports. HubRise tax_rate is
  // PRODUCT-level: {delivery, collection, eat_in} decimal-string percentages ("20.0"),
  // all three keys present or the object omitted. Resolution mirrors lib/tax.js
  // resolveTaxRate exactly (per-order-type override -> item default rate; no resolve = 0,
  // which is also what the booking engine charges). An item with NO tax config at all
  // omits the object — "unspecified" must not become an affirmative 0% declaration.
  const taxRates = opts.taxRates || [];
  const rateById = new Map<string, any>(taxRates.map((r: any) => [String(r.id), r]));
  const HR_TAX_KEYS: Array<[string, string]> = [
    ['delivery', 'delivery'], ['collection', 'takeaway'], ['eat_in', 'dine-in'],
  ];
  const pctString = (frac: number): string => {
    const pct = Math.round(frac * 100 * 1000) / 1000;
    const s = String(pct);
    return s.includes('.') ? s : s + '.0';
  };
  const hasTaxConfig = (it: any): boolean =>
    !!it && (it.tax_rate_id != null || Object.keys(it.tax_overrides || {}).length > 0);
  // v5.5.857: mirror lib/tax.js resolveTaxRate exactly — no rate set = the venue's
  // DEFAULT rate (the item editor's "Use default", now honoured by the booking engine
  // too). A venue with no default rate keeps the old behaviour (0 / omitted).
  const defaultRate = taxRates.find((r: any) => r.is_default && r.active !== false) || null;
  const resolveTaxFrac = (it: any, orderType: string): number => {
    const ov = (it && it.tax_overrides) || {};
    const rid = ov[orderType] !== undefined ? ov[orderType] : (it ? it.tax_rate_id : null);
    const r = rid != null ? rateById.get(String(rid)) : defaultRate;
    return r && r.active !== false ? (parseFloat(r.rate) || 0) : 0;
  };
  const productTaxRate = (it: any, kids: any[]): Record<string, string> | null => {
    // Variant CHILDREN are the skus an inbound order books against, so they carry the
    // authoritative tax config — first child with any config wins, else the parent.
    // With a venue default rate every product resolves; only a venue with NO default
    // and an unconfigured item omits the object.
    const src = (kids || []).find(hasTaxConfig) || (hasTaxConfig(it) ? it : null) ||
                (defaultRate ? (it || null) : null);
    if (!src) return null;
    const out: Record<string, string> = {};
    for (const [hrKey, ours] of HR_TAX_KEYS) out[hrKey] = pctString(resolveTaxFrac(src, ours));
    return out;
  };

  // Link a modifier option to a sold-alone item by explicit itemId, else by NAME match
  // (the donut options carry itemId=null). The option then SHARES the item's ref, so an
  // inbound order's option maps to the real item (KDS routing) and 86/stock on the item
  // flows to the option. Falls back to the option's own id when there's no match.
  const itemIdByName = new Map<string, string>();
  for (const it of items) {
    if (it.archived || it.parent_id || it.sold_alone === false) continue;
    const nm = displayName(it).trim().toLowerCase();
    if (nm && !itemIdByName.has(nm)) itemIdByName.set(nm, String(it.id));
  }
  const resolveOptionRef = (o: any): string => {
    if (o.itemId) return String(o.itemId);
    const m = itemIdByName.get(String(o.name || '').trim().toLowerCase());
    return m || String(o.id);
  };

  // Categories — keep operator order; drop "special" (internal-only) groups.
  const categories = cats
    .filter((c) => c && !c.is_special)
    .map((c) => {
      const out: any = { ref: String(c.id), name: c.label || c.name || 'Category' };
      if (c.parent_id) out.parent_ref = String(c.parent_id);
      return out;
    });
  const catRefSet = new Set(categories.map((c) => c.ref));
  // Drop dangling parent_ref (parent was special/missing) so HubRise doesn't reject the tree.
  for (const c of categories) if (c.parent_ref && !catRefSet.has(c.parent_ref)) delete c.parent_ref;

  const groupIdSet = new Set((groups || []).map((g: any) => String(g.id)));
  const groupsById = new Map<string, any>((groups || []).map((g: any) => [String(g.id), g]));
  const usedGroupIds = new Set<string>();

  // HubRise option_lists are FLAT — an option cannot open another option_list. ServOS
  // supports NESTED modifier groups (an option's subGroupId opens a child group). To reflect
  // the menu as faithfully as a flat model allows, we FLATTEN: a sku's option_lists = its
  // assigned groups PLUS every nested sub-group reachable through them (transitively),
  // attached as sibling lists in parent-first order. Each group keeps its own min/max so
  // required choices stay required. Orphaned/deleted refs are skipped (no dangling ref →
  // no 422); cycles are guarded. The only thing a flat model can't preserve is the cascade
  // (a sub-list showing only after a specific parent option is chosen).
  const skuOptionRefs = (it: any): string[] => {
    const top: string[] = [];
    for (const a of (it.assigned_modifier_groups || [])) {
      const gid = a?.groupId ?? a?.id ?? a;
      if (gid != null && groupIdSet.has(String(gid))) top.push(String(gid));
    }
    const ordered: string[] = [];
    const seen = new Set<string>();
    const visit = (gid: string) => {
      gid = String(gid);
      if (seen.has(gid)) return;
      const g = groupsById.get(gid);
      if (!g) return;                         // missing/orphaned group → skip
      seen.add(gid); ordered.push(gid); usedGroupIds.add(gid);
      for (const o of (g.options || [])) { if (o?.subGroupId) visit(String(o.subGroupId)); }
    };
    top.forEach(visit);
    return ordered;
  };

  // Cooking instructions / preferences live in the config snapshot (instructionGroupDefs),
  // not the modifier_groups table. They're choice-lists ({id,name,options:[strings]}), so we
  // publish them as additional option_lists. min comes from the per-item assignment (so a
  // required cooking-temp stays required); single-select.
  const instrById = new Map<string, any>(instrGroups.map((g: any) => [String(g.id), g]));
  const usedInstrIds = new Set<string>();
  const instrMin: Record<string, number> = {};
  const instructionRefs = (it: any): string[] => {
    const refs: string[] = [];
    for (const a of (it.assigned_instruction_groups || [])) {
      const gid = a?.groupId ?? a?.id ?? a;
      if (gid != null && instrById.has(String(gid))) {
        const id = String(gid);
        refs.push(id); usedInstrIds.add(id);
        const m = Number(a?.min) || 0;
        if (m > (instrMin[id] || 0)) instrMin[id] = m;
      }
    }
    return refs;
  };

  const products: any[] = [];
  for (const it of items) {
    if (!publishable(it)) continue;
    const optionListRefs = [...skuOptionRefs(it), ...instructionRefs(it)];
    let skus: any[];
    const parentMenuId = itemMenuId[String(it.id)] ?? null;
    const kids = it.type === 'variants' ? childrenOf(String(it.id)) : [];
    if (it.type === 'variants') {
      skus = (kids.length ? kids : [it]).map((k) => ({
        ref: String(k.id),
        name: k === it ? undefined : displayName(k),
        price: toMoney(resolvePrice(k.pricing, itemMenuId[String(k.id)] ?? parentMenuId), ccy),
        ...(optionListRefs.length ? { option_list_refs: optionListRefs } : {}),
      }));
    } else {
      skus = [{
        ref: String(it.id),
        price: toMoney(resolvePrice(it.pricing, parentMenuId), ccy),
        ...(optionListRefs.length ? { option_list_refs: optionListRefs } : {}),
      }];
    }
    // No products[].ref — HubRise's reviewer (Peter's meeting, 10 Aug): the ref
    // that matters is products[].skus[].ref, which is where order matching and
    // the 86 push key from (an inbound order's sku_ref IS our menu_item id).
    // Nothing on either side ever read the product-level one.
    const product: any = {
      name: displayName(it),
      skus,
    };
    const taxRate = productTaxRate(it, kids);
    if (taxRate) product.tax_rate = taxRate;
    // Only reference a category that actually made it into the catalog (no dangling refs).
    const catRef = it.cat ? String(it.cat) : (Array.isArray(it.cats) && it.cats[0] ? String(it.cats[0]) : null);
    if (catRef && catRefSet.has(catRef)) product.category_ref = catRef;
    if (it.description) product.description = it.description;
    // v5.5.852 (HubRise sign-off): allergens belong in product.nutrition.allergens, not
    // tags. Names are normalised onto HubRise's EU-14 vocabulary; anything that doesn't
    // map stays as a TAG instead — the catalog is a whole-document PUT, so an invalid
    // allergen value must never be able to abort the entire publish. Info is never lost:
    // mapped -> nutrition, unmapped -> tags (as before).
    if (Array.isArray(it.allergens) && it.allergens.length) {
      const mapped: string[] = [];
      const unmapped: string[] = [];
      for (const raw of it.allergens) {
        const hits = hubriseAllergen(String(raw));
        if (hits.length) { for (const a of hits) if (!mapped.includes(a)) mapped.push(a); }
        else unmapped.push(String(raw));
      }
      if (mapped.length) product.nutrition = { allergens: mapped };
      if (unmapped.length) product.tags = unmapped;
    }
    const imgId = imageIdByItem[String(it.id)];
    if (imgId) product.image_ids = [imgId];
    products.push(product);
  }

  // Option lists for every referenced modifier group.
  const option_lists = groups
    .filter((g) => g && usedGroupIds.has(String(g.id)))
    .map((g) => ({
      ref: String(g.id),
      name: g.name || 'Options',
      min_selections: Number(g.min) || 0,
      max_selections: g.max == null ? null : Number(g.max),
      multiple_selection: g.selection_type !== 'single',
      options: (g.options || []).map((o: any) => ({
        ref: resolveOptionRef(o),
        name: o.name || 'Option',
        price: toMoney(o.price ?? 0, ccy),
      })),
    }));

  // Plus option_lists for the cooking-instruction groups (single-select; options are plain
  // strings so we synthesise refs). Appended after modifier lists.
  const instruction_lists = instrGroups
    .filter((g: any) => usedInstrIds.has(String(g.id)))
    .map((g: any) => ({
      ref: String(g.id),
      name: g.name || 'Choice',
      min_selections: instrMin[String(g.id)] || 0,
      max_selections: 1,
      multiple_selection: false,
      options: (g.options || []).map((txt: any, i: number) => ({
        ref: `${g.id}-${i}`,
        name: String(txt),
        price: toMoney(0, ccy),
      })),
    }));

  return { variants: [], categories, products, option_lists: [...option_lists, ...instruction_lists], deals: [], discounts: [], charges: [] };
}

// ── 2. Order -> order_queue row ──────────────────────────────────────────────

const SERVICE_TYPE_TO_QUEUE: Record<string, string> = {
  delivery: 'delivery',
  collection: 'collection',
  eat_in: 'dine-in',
};

/** HubRise OrderStatus -> ServOS queue status. */
export function hrToQueueStatus(hr: string): string {
  switch (hr) {
    case 'new':
    case 'received': return 'received';
    case 'accepted':
    case 'in_preparation': return 'prep';
    case 'awaiting_collection':
    case 'awaiting_shipment': // deprecated by HubRise → treat as awaiting_collection
    case 'in_delivery': return 'ready';
    case 'completed': return 'collected';
    case 'rejected':
    case 'cancelled':
    case 'delivery_failed': return 'cancelled';
    default: return 'received';
  }
}

export function orderToQueueRow(order: any, opts: { locationId: string }): { row: any; link: any } {
  const c = order.customer || {};
  const serviceType = order.service_type || 'collection';
  const type = SERVICE_TYPE_TO_QUEUE[serviceType] || 'collection';
  const ref = `HR-${order.id}`;
  // Decode payments[] fully. HubRise derives PAID from payments, but a non-empty list can be a
  // PARTIAL payment — paid means the sum of (non-deleted) payments covers the order total.
  // Each payment is {name, ref, amount, info?, deleted?}; deleted:true = removed entry.
  const total = parseMoney(order.total).amount;
  // Per-platform payment REF decode table (HubRise review, 10 Aug: 'Peter will
  // provide a list of hardcoded ref codes for every platform'). Keys are the
  // EXACT payments[].ref strings each platform sends, values are the tender
  // label our tills/reports show. Fill-in format, one line per code:
  //   'REF_CODE': 'Friendly label',
  // Unknown refs keep the platform's own name — nothing is ever dropped.
  const PLATFORM_PAYMENT_REFS: Record<string, string> = {
    // Deliveroo:   e.g. 'DELIVEROO': 'Paid online (Deliveroo)',
    // Uber Eats:   e.g. 'UBER_EATS': 'Paid online (Uber Eats)',
    // Just Eat:    e.g. 'JUST_EAT_ONLINE': 'Paid online (Just Eat)',
    // (awaiting Peter's list from the HubRise meeting)
  };
  const payments = (Array.isArray(order.payments) ? order.payments : [])
    .filter((p: any) => p && p.deleted !== true)
    .map((p: any) => ({
      name: (p.ref && PLATFORM_PAYMENT_REFS[String(p.ref)]) || p.name || p.type || 'Payment',
      ref: p.ref || null,
      amount: parseMoney(p.amount).amount,
    }));
  const paidAmount = +payments.reduce((s: number, p: any) => s + p.amount, 0).toFixed(2);
  const paid = payments.length > 0 && paidAmount >= total - 0.005; // epsilon for float pennies
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || 'HubRise customer';
  const channel = order.channel || order.created_by || 'HubRise';

  const items = (order.items || []).map((it: any) => ({
    itemId: it.sku_ref || null,
    name: [it.product_name, it.sku_name].filter(Boolean).join(' — ') || it.product_name || 'Item',
    qty: Math.round(Number(it.quantity) || 1),
    price: parseMoney(it.price).amount,
    mods: (it.options || []).map((op: any) => ({
      // removed:true = an ingredient TAKEN OFF (HubRise sends e.g. "Ingredient removed:
      // Mozzarella"). Displaying the bare name read as an ADDED topping — safety issue
      // for allergen removals — so the label carries the negation everywhere it prints.
      label: op.removed === true ? `No ${op.name}` : op.name,
      removed: op.removed === true,
      groupLabel: op.option_list_name || null,   // decoded for completeness; tickets deliberately print the option name only (v4.6.10)
      itemId: op.ref || null,
      qty: Number(op.quantity) || 1,
      price: parseMoney(op.price).amount,
    })),
    notes: it.customer_notes || '',
    dealLabel: it.deal_line?.label || null,
  }));

  // GPS coords (delivery): HubRise may carry lat/lng on the customer or its address block.
  const lat = c.latitude ?? c.lat ?? c.address?.latitude ?? c.address?.lat ?? null;
  const lng = c.longitude ?? c.lng ?? c.address?.longitude ?? c.address?.lng ?? null;
  const gps = (lat != null && lng != null) ? { lat: Number(lat), lng: Number(lng) } : null;

  // Charges (delivery fee, bag fee, service charge, tip) and order-level discounts. order.total
  // already nets these, but HubRise wants them decoded — keep them so the kitchen/floor + reports
  // can reconcile the headline total. Money strings -> numeric amounts.
  const charges = (order.charges || []).map((ch: any) => ({
    name: ch.name || ch.type || 'Charge',
    ref: ch.ref || null,
    type: ch.type || null,
    amount: parseMoney(ch.price).amount,
  }));
  const discounts = (order.discounts || []).map((d: any) => ({
    name: d.name || 'Discount',
    ref: d.ref || null,
    amount: parseMoney(d.price_off ?? d.price ?? d.amount).amount,
  }));

  const customer: any = {
    name,
    phone: toE164(c.phone),                              // E.164-normalised (verbatim kept if unknown format)
    phoneRaw: c.phone || '',                             // original, for reference
    phoneAccessCode: c.phone_access_code || c.access_code || null,
    email: c.email || '',
    address: serviceType === 'delivery'
      ? {
          line1: c.address_1 || '',
          line2: c.address_2 || '',
          city: c.city || '',
          postcode: c.postal_code || '',
          country: c.country || '',
          ...(gps ? { gps } : {}),                       // {lat,lng} when the channel supplies them
        }
      : null,
    notes: order.customer_notes || c.delivery_notes || '',
    deliveryNotes: c.delivery_notes || '',
    // Marketing opt-in flags from the embedded customer (decoded only; we don't action them on
    // inbound channel orders — kept so the row is complete and clears the cert decode requirement).
    marketingPrefs: {
      sms: c.sms_marketing ?? c.marketing?.sms ?? null,
      email: c.email_marketing ?? c.marketing?.email ?? null,
    },
    channel,
    collectionCode: order.collection_code || order.ref || null,
    serviceType,
    paid,
    ...(payments.length ? { payments } : {}),
    paidAmount,
    due: +(Math.max(0, total - paidAmount)).toFixed(2),
    ...(charges.length ? { charges } : {}),
    ...(discounts.length ? { discounts } : {}),
    source_label: channel,
    hubrise_order_id: order.id,
    hubrise_location_id: order.location_id || null,
  };

  const expectedIso = order.expected_time || order.confirmed_time || null;
  customer.expectedTime = expectedIso;   // full store-tz ISO (audit/accuracy); display uses the label below

  const row = {
    ref,
    location_id: opts.locationId,
    type,
    customer,
    items,
    total,
    status: hrToQueueStatus(order.status || 'new'),
    source: 'hubrise',
    is_asap: !!order.asap,
    // store-local "HH:MM" (or "DD/MM HH:MM" cross-day) — HubRise sends times in the store's tz/offset
    collection_time: order.asap ? null : hrTimeLabel(expectedIso, order.created_at),
    paid,
    created_at: order.created_at || new Date().toISOString(),
  };

  const link = {
    ref,
    location_id: opts.locationId,
    hubrise_order_id: order.id,
    hubrise_location_id: order.location_id || null,
    channel,
    service_type: serviceType,
    hr_status: order.status || 'new',
  };

  return { row, link };
}

// ── 3. ServOS -> HubRise status ──────────────────────────────────────────────

/** Map a ServOS queue status / action to a HubRise OrderStatus, honouring service type. */
export function queueToHrStatus(action: string, serviceType?: string): string | null {
  switch (action) {
    case 'accept':
    case 'accepted': return 'accepted';
    case 'prep':
    case 'in_preparation': return 'in_preparation';
    case 'ready': return serviceType === 'delivery' ? 'in_delivery' : 'awaiting_collection';
    case 'collected':
    case 'completed': return 'completed';
    case 'reject':
    case 'rejected': return 'rejected';
    case 'cancel':
    case 'cancelled': return 'cancelled';
    case 'delivery_failed': return 'delivery_failed';
    default: return null;
  }
}

/** Monotonic rank so a stale retried event can't regress current state. */
export function hrStatusRank(hr: string): number {
  const order: Record<string, number> = {
    new: 0, received: 1, accepted: 2, in_preparation: 3,
    awaiting_collection: 4, in_delivery: 4, completed: 5,
  };
  if (hr in order) return order[hr];
  // anomalies are terminal
  if (hr === 'rejected' || hr === 'cancelled' || hr === 'delivery_failed') return 9;
  return 0;
}
