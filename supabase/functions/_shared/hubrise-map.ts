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

// ── 1. Catalog builder ───────────────────────────────────────────────────────

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
    if (it.type === 'variants') {
      const kids = childrenOf(String(it.id));
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
    const product: any = {
      ref: String(it.id),
      name: displayName(it),
      skus,
    };
    // Only reference a category that actually made it into the catalog (no dangling refs).
    const catRef = it.cat ? String(it.cat) : (Array.isArray(it.cats) && it.cats[0] ? String(it.cats[0]) : null);
    if (catRef && catRefSet.has(catRef)) product.category_ref = catRef;
    if (it.description) product.description = it.description;
    if (Array.isArray(it.allergens) && it.allergens.length) product.tags = it.allergens.map(String);
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
  const paid = Array.isArray(order.payments) && order.payments.length > 0;
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || 'HubRise customer';
  const channel = order.channel || order.created_by || 'HubRise';

  const items = (order.items || []).map((it: any) => ({
    itemId: it.sku_ref || null,
    name: [it.product_name, it.sku_name].filter(Boolean).join(' — ') || it.product_name || 'Item',
    qty: Math.round(Number(it.quantity) || 1),
    price: parseMoney(it.price).amount,
    mods: (it.options || []).map((op: any) => ({
      label: op.name,
      itemId: op.ref || null,
      qty: Number(op.quantity) || 1,
      price: parseMoney(op.price).amount,
    })),
    notes: it.customer_notes || '',
    dealLabel: it.deal_line?.label || null,
  }));

  const customer: any = {
    name,
    phone: c.phone || '',
    email: c.email || '',
    address: serviceType === 'delivery'
      ? {
          line1: c.address_1 || '',
          line2: c.address_2 || '',
          city: c.city || '',
          postcode: c.postal_code || '',
          country: c.country || '',
        }
      : null,
    notes: order.customer_notes || c.delivery_notes || '',
    deliveryNotes: c.delivery_notes || '',
    channel,
    collectionCode: order.collection_code || order.ref || null,
    serviceType,
    paid,
    source_label: channel,
    hubrise_order_id: order.id,
    hubrise_location_id: order.location_id || null,
  };

  const row = {
    ref,
    location_id: opts.locationId,
    type,
    customer,
    items,
    total: parseMoney(order.total).amount,
    status: hrToQueueStatus(order.status || 'new'),
    source: 'hubrise',
    is_asap: !!order.asap,
    collection_time: order.expected_time || order.confirmed_time || null,
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
