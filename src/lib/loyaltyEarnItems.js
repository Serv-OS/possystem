// loyaltyEarnItems.js: the lines and channel a loyalty earn or refund is worked out from (v5.11.81).
//
// Moved out of store.attributeOrderToCustomer unchanged (the item mapping), so the part refund
// (store.refundCheck -> loyalty-refund) counts the stamps of the refunded lines with exactly the
// lines the earn counted. Two rules added:
//   - ONE earn channel label per surface (earnChannelFor). The till labelled an earn with the
//     order type ('dine-in', 'takeaway', 'delivery', 'drive-thru'), the kiosk 'kiosk', QR 'qr',
//     online 'online', and the till's own redeem 'pos'. Now every till surface (counter, table,
//     bar tab, handheld, a reader close) earns as 'pos', and each customer surface as itself.
//   - the part refund body (partRefundLoyaltyBody): the share of the goods the refund returned and
//     the lines it returned, under the refund's own id.
// PURE: no imports, runs under node --test.

const CUSTOMER_SURFACES = new Set(['kiosk', 'online', 'qr', 'catering', 'hubrise']);

/** The label an earn carries: the customer surface the order came from, else 'pos' (every till surface). */
export function earnChannelFor(orderRecord) {
  const ch = String(orderRecord?.channel || '').toLowerCase();
  if (CUSTOMER_SURFACES.has(ch)) return ch;
  const src = String(orderRecord?.source || '').toLowerCase();
  if (CUSTOMER_SURFACES.has(src)) return src;
  return 'pos';
}

/**
 * The lines loyalty-earn counts stamps and points from (store.attributeOrderToCustomer's mapping,
 * verbatim): a size takes its product's category (v5.5.259), a line with no category takes its menu
 * row's (or its product's), and comps, staff discounts and gift cards are flagged.
 */
export function loyaltyEarnItems(items, menuItems = []) {
  const menuById = new Map((Array.isArray(menuItems) ? menuItems : []).map((m) => [m.id, m]));
  return (Array.isArray(items) ? items : []).map((i) => {
    let cat = i.cat || i.category || null;
    if (i.parentId) {
      const parent = menuById.get(i.parentId);
      const parentCat = parent?.cat || parent?.cats?.[0] || null;
      if (parentCat) cat = parentCat;
    }
    if (!cat) {
      const mi = menuById.get(i.itemId || i.id);
      if (mi?.parentId) {
        const parent = menuById.get(mi.parentId);
        cat = parent?.cat || parent?.cats?.[0] || null;
      } else {
        cat = mi?.cat || mi?.cats?.[0] || null;
      }
    }
    return {
      name: i.name, qty: i.qty || 1, price: i.price || 0,
      cat,
      id: i.itemId || i.id || null,
      isComp: !!i.isComp,
      staffDiscount: !!i.isStaffDiscount,
      isGiftCard: !!i.isGiftCard,
    };
  });
}

/**
 * What a PART refund asks loyalty-refund to take back (_shared/loyaltyPartRefund.js): the refund's
 * id, the share of the check's goods money it returned (bd.itemsAmount over the goods the check
 * charged, 0..1) and the lines it returned at the quantity refunded.
 * @param {object} bd            refundMath.refundBreakdown for this refund
 * @param {number} chargedGoods  the goods money the check charged (refundMath: plan sum, else itemsBasis)
 */
export function partRefundLoyaltyBody({ refundId, bd, chargedGoods, refundItems = [], menuItems = [] } = {}) {
  const goods = Number(chargedGoods);
  const back = Number(bd?.itemsAmount);
  const share = goods > 0 && Number.isFinite(back) ? Math.max(0, Math.min(1, back / goods)) : 0;
  const lines = (Array.isArray(refundItems) ? refundItems : [])
    .filter((i) => i && Number(i.refundQty) > 0)
    .map((i) => ({ ...i, qty: Number(i.refundQty) }));
  return { part: true, refund_id: String(refundId || ''), share: Math.round(share * 1e6) / 1e6, items: loyaltyEarnItems(lines, menuItems) };
}
