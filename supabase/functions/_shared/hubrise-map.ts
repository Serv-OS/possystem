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
}): { variants: any[]; categories: any[]; products: any[]; option_lists: any[]; deals: any[]; discounts: any[]; charges: any[] } {
  const ccy = opts.currency || 'GBP';
  const items = opts.items || [];
  const cats = opts.categories || [];
  const groups = opts.modifierGroups || [];

  // What we publish to channels: live items visible online, sold on their own, and
  // NOT a child of another item (variant children are published as their parent's
  // skus, never as standalone products — that would duplicate the sku ref).
  const publishable = (it: any) =>
    it && !it.archived && it.type !== 'subitem' && it.sold_alone !== false && !it.parent_id &&
    (!it.visibility || it.visibility.online !== false);

  const childrenOf = (parentId: string) =>
    items.filter((c) => c.parent_id === parentId && !c.archived);

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

  // Which modifier groups are actually referenced by a published item.
  const usedGroupIds = new Set<string>();
  const skuOptionRefs = (it: any): string[] => {
    const refs: string[] = [];
    for (const a of (it.assigned_modifier_groups || [])) {
      const gid = a?.groupId ?? a?.id ?? a;
      if (gid != null) { refs.push(String(gid)); usedGroupIds.add(String(gid)); }
    }
    return refs;
  };

  const products: any[] = [];
  for (const it of items) {
    if (!publishable(it)) continue;
    const optionListRefs = skuOptionRefs(it);
    let skus: any[];
    if (it.type === 'variants') {
      const kids = childrenOf(String(it.id));
      skus = (kids.length ? kids : [it]).map((k) => ({
        ref: String(k.id),
        name: k === it ? undefined : displayName(k),
        price: toMoney(k.pricing?.base ?? k.price ?? 0, ccy),
        ...(optionListRefs.length ? { option_list_refs: optionListRefs } : {}),
      }));
    } else {
      skus = [{
        ref: String(it.id),
        price: toMoney(it.pricing?.base ?? it.price ?? 0, ccy),
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
        ref: String(o.id),
        name: o.name || 'Option',
        price: toMoney(o.price ?? 0, ccy),
      })),
    }));

  return { variants: [], categories, products, option_lists, deals: [], discounts: [], charges: [] };
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
