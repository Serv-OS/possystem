// src/lib/parity/fixtures.js: the golden parity baskets (v5.11.78, 18 Oct 2026).
//
// Peter, 18 Oct 2026: "make sure all channels are covered for everything we have built and
// found: catering, kiosk, online, QR, POS all need tax rules, stock rules, everything needs to
// align!" and "The POS receives the order and that should dictate how products, taxes,
// everything is handled".
//
// ONE menu, ONE set of rates, ONE list of baskets. Every parity test in this folder runs these
// same baskets through each channel's REAL money code (the till, table, bar tab, kiosk, online,
// QR, catering, MPOS, reader close, Table Pay, HubRise, ezCater, bookings and refunds) and asserts
// the figures the POS gives. Fixture rows only: no real venue names, takings or ids.
//
// Pure data plus two tiny builders. Imports only lib modules node can load (.js extensions).

import { mapMenuItemRow } from '../rowMapping.js';
import { buildLocalTaxCtx } from '../taxCompute.js';

// ── Rates ────────────────────────────────────────────────────────────────────
export const R20 = { id: 'r20', name: 'Standard Rate', code: 'VAT20', rate: 0.2, type: 'inclusive', is_default: true, isDefault: true, active: true };
export const R5 = { id: 'r5', name: 'Reduced Rate', code: 'VAT5', rate: 0.05, type: 'inclusive', is_default: false, isDefault: false, active: true };
export const R0 = { id: 'r0', name: 'Zero Rate', code: 'ZERO', rate: 0, type: 'inclusive', is_default: false, isDefault: false, active: true };
export const UK_RATES = [R20, R5, R0];
export const ctxUK = () => ({ taxRates: UK_RATES });

// US: a generated venue default (8.875% added on) plus a San Mateo stacked profile on food.
export const US_RATES = [
  { id: 'us', name: 'Sales Tax', code: 'US_SALES', rate: 0.08875, type: 'exclusive', is_default: true, isDefault: true, active: true },
];
const US_GEN = { id: 'p-sales', name: 'Sales Tax', active: true, generatedFromRateId: 'us', rounding: { mode: 'half_up', level: 'invoice' },
  lines: [{ id: 'g1', name: 'Sales Tax', lineType: 'rate', rate: 0.08875, mode: 'exclusive', compound: false, taxable: false, orderTypes: ['all'], active: true }] };
const US_SM = { id: 'p-sm', name: 'San Mateo', active: true, rounding: { mode: 'half_up', level: 'item' }, lines: [
  { id: 's1', name: 'CA state', lineType: 'rate', rate: 0.0725, mode: 'exclusive', compound: false, taxable: false, orderTypes: ['all'], active: true },
  { id: 's2', name: 'County', lineType: 'rate', rate: 0.02125, mode: 'exclusive', compound: false, taxable: false, orderTypes: ['all'], active: true },
  { id: 's3', name: 'City', lineType: 'rate', rate: 0.0025, mode: 'exclusive', compound: false, taxable: false, orderTypes: ['all'], active: true }] };
export const US_MENU = [
  { id: 'burger', name: 'Burger', cat: 'food', tax_rate_id: null, pricing: { base: 17 } },
  { id: 'soda', name: 'Soda', cat: 'drinks', tax_rate_id: null, pricing: { base: 10 } },
];
export const ctxUS = () => buildLocalTaxCtx({
  taxProfiles: [US_GEN, US_SM], menuItems: US_MENU,
  menuCategories: [{ id: 'food', tax_profile_id: 'p-sm' }],
  venueDefaultProfileId: 'p-sales', taxRates: US_RATES,
});

// ── Menu (raw snake rows, as the kiosk, online, QR, catering and HubRise read them) ─────────
// Latte: order type prices, a Lunch tier, priced options, takeaway zero rate override.
// Beer: a sized product (Half has its own tier on the Bar menu), sizes on "Use default" tax.
// Babyccino: a size with no rate of its own under a 5% parent.
// Toastie: the line contract case (5.35 + Chorizo 0.95 + Mushroom 0.30 = 6.60).
// Sandwich: cold food, takeaway zero rated. Burger/Fries/Coke: the meal deal.
export const MENU = [
  { id: 'latte', name: 'Latte', type: 'modifiable', cat: 'coffee', parent_id: null, assigned_modifier_groups: ['g-milk'],
    tax_rate_id: 'r20', tax_overrides: { takeaway: 'r0' },
    pricing: { base: 3.00, dineIn: 3.20, takeaway: 2.80, collection: 2.90, delivery: 3.50, menus: { lunch: { all: 2.50, takeaway: 2.40 } } } },
  { id: 'beer', name: 'Beer', type: 'variants', cat: 'beer', parent_id: null, tax_rate_id: 'r20', tax_overrides: {}, pricing: { base: 0 } },
  { id: 'beer-half', name: 'Half', type: 'simple', cat: 'beer', parent_id: 'beer', sort_order: 1, tax_rate_id: null, tax_overrides: {},
    pricing: { base: 2.85, takeaway: 3.01, collection: 3.02, menus: { bar: { all: 1.23 } } } },
  { id: 'beer-pint', name: 'Pint', type: 'simple', cat: 'beer', parent_id: 'beer', sort_order: 2, tax_rate_id: null, tax_overrides: {}, pricing: { base: 5.00 } },
  { id: 'baby', name: 'Babyccino', type: 'variants', cat: 'kids', parent_id: null, tax_rate_id: 'r5', tax_overrides: {}, pricing: { base: 0 } },
  { id: 'baby-l', name: 'Large', type: 'simple', cat: 'kids', parent_id: 'baby', sort_order: 1, tax_rate_id: null, tax_overrides: {}, pricing: { base: 2.10 } },
  { id: 'toastie', name: 'Toastie', type: 'modifiable', cat: 'food', parent_id: null, assigned_modifier_groups: ['g-toastie'],
    tax_rate_id: 'r20', tax_overrides: {}, pricing: { base: 5.35 } },
  { id: 'sarnie', name: 'Sandwich', type: 'simple', cat: 'cold', parent_id: null, tax_rate_id: 'r20', tax_overrides: { takeaway: 'r0', delivery: 'r0' }, pricing: { base: 4.50 } },
  { id: 'burger', name: 'Burger', type: 'simple', cat: 'mains', parent_id: null, tax_rate_id: 'r20', tax_overrides: {}, pricing: { base: 9.00 } },
  { id: 'fries', name: 'Fries', type: 'simple', cat: 'sides', parent_id: null, tax_rate_id: 'r20', tax_overrides: {}, pricing: { base: 3.50 } },
  { id: 'coke', name: 'Coke', type: 'simple', cat: 'drinks', parent_id: null, tax_rate_id: 'r20', tax_overrides: {}, pricing: { base: 2.50 } },
  { id: 'water', name: 'Tap water', type: 'simple', cat: 'drinks', parent_id: null, tax_rate_id: 'r0', tax_overrides: {}, pricing: { base: 0 } },
  // Added 19 Oct 2026 for the channel parity suite (none of the golden baskets use them):
  // a menu only item (priced only on the Bar menu's tier), a delivery platter, a zero rated soft
  // drink with a Bar override, and an option only sub item (oat milk).
  { id: 'shot', name: 'House shot', type: 'simple', cat: 'drinks', parent_id: null, tax_rate_id: 'r20', tax_overrides: {}, pricing: { base: 0, menus: { bar: { all: 5.00 } } } },
  { id: 'platter', name: 'Platter', type: 'simple', cat: 'food', parent_id: null, tax_rate_id: 'r20', tax_overrides: {}, pricing: { base: 90, delivery: 50 } },
  { id: 'squash', name: 'Squash', type: 'simple', cat: 'drinks', parent_id: null, tax_rate_id: 'r0', tax_overrides: { bar: 'r5' }, pricing: { base: 1.50 } },
  { id: 'oat', name: 'Oat milk', type: 'subitem', sold_alone: false, cat: 'coffee', parent_id: null, tax_rate_id: 'r20', tax_overrides: {}, pricing: { base: 0.40 } },
  // A product whose takeaway is zero rated, and a size added later with its own 20% rate and no
  // overrides of its own (the "add size" case): the size follows its product's takeaway rule.
  { id: 'cake', name: 'Cake', type: 'variants', cat: 'cold', parent_id: null, tax_rate_id: 'r20', tax_overrides: { takeaway: 'r0' }, pricing: { base: 0 } },
  { id: 'cake-slice', name: 'Slice', type: 'simple', cat: 'cold', parent_id: 'cake', sort_order: 1, tax_rate_id: 'r20', tax_overrides: {}, pricing: { base: 3.00 } },
];
export const STORE_MENU = MENU.map(mapMenuItemRow);     // the till and phone store rows (SyncBridge mapper)
export const raw = (id) => MENU.find((r) => r.id === id);
export const storeRow = (id) => STORE_MENU.find((r) => r.id === id);

export const MOD_GROUPS = [
  { id: 'g-milk', name: 'Milk', options: [{ id: 'o-oat', name: 'Oat', price: 0.5 }, { id: 'o-shot', name: 'Extra shot', price: 1.0 }] },
  { id: 'g-toastie', name: 'Toastie extras', options: [{ id: 'o-chorizo', name: 'Chorizo', price: 0.95 }, { id: 'o-mush', name: 'Mushroom', price: 0.30 }] },
];
export const optionOf = (id) => {
  for (const g of MOD_GROUPS) for (const o of g.options) if (o.id === id) return { ...o, groupId: g.id, groupLabel: g.name };
  return null;
};

// ── Auto discount rules (POS shape the engine reads) ────────────────────────────────────────
export const MEAL_DEAL = {
  id: 'r-meal', name: 'Meal deal', active: true, priority: 0,
  triggerType: 'bundle', rewardType: 'fixed_price', rewardValue: 12.00,
  triggerGroups: [{ categoryIds: ['mains'], qty: 1 }, { categoryIds: ['sides'], qty: 1 }, { categoryIds: ['drinks'], qty: 1 }],
  channels: { pos: true, online: true, qr: true, kiosk: true },
};
export const RULES = [MEAL_DEAL];

export const SERVICE_DEVICE = { serviceCharge: { enabled: true, rate: 12.5, applyTo: 'all', minCovers: 1 } };

// ── Baskets ─────────────────────────────────────────────────────────────────────────────────
// A line: { itemId, qty, opts: [option ids] }. Sizes name the size row as itemId.
export const BASKETS = [
  { id: 'sizes', orderType: 'takeaway', menuId: null, lines: [{ itemId: 'beer-half', qty: 2 }, { itemId: 'beer-pint', qty: 1 }] },
  { id: 'options', orderType: 'dine-in', menuId: null, lines: [{ itemId: 'toastie', qty: 1, opts: ['o-chorizo', 'o-mush'] }, { itemId: 'latte', qty: 1, opts: ['o-oat', 'o-shot', 'o-shot'] }] },
  { id: 'order-type-takeaway', orderType: 'takeaway', menuId: null, lines: [{ itemId: 'latte', qty: 2 }] },
  { id: 'order-type-collection', orderType: 'collection', menuId: null, lines: [{ itemId: 'latte', qty: 1 }, { itemId: 'beer-half', qty: 1 }] },
  { id: 'order-type-delivery', orderType: 'delivery', menuId: null, lines: [{ itemId: 'latte', qty: 1 }, { itemId: 'sarnie', qty: 1 }] },
  { id: 'order-type-drive-thru', orderType: 'drive-thru', menuId: null, lines: [{ itemId: 'latte', qty: 1 }, { itemId: 'sarnie', qty: 1 }] },
  { id: 'timed-menu', orderType: 'takeaway', menuId: 'lunch', lines: [{ itemId: 'latte', qty: 1, opts: ['o-oat'] }] },
  { id: 'timed-menu-size-tier', orderType: 'dine-in', menuId: 'bar', lines: [{ itemId: 'beer-half', qty: 2 }] },
  { id: 'vat-by-order-type', orderType: 'takeaway', menuId: null, lines: [{ itemId: 'sarnie', qty: 1 }, { itemId: 'toastie', qty: 1 }] },
  { id: 'size-follows-parent', orderType: 'collection', menuId: null, lines: [{ itemId: 'baby-l', qty: 1 }] },
  { id: 'zero-rate', orderType: 'dine-in', menuId: null, lines: [{ itemId: 'water', qty: 2 }, { itemId: 'coke', qty: 1 }] },
  { id: 'auto-discount', orderType: 'takeaway', menuId: null, lines: [{ itemId: 'burger', qty: 1 }, { itemId: 'fries', qty: 1 }, { itemId: 'coke', qty: 1 }] },
  { id: 'manual-discount', orderType: 'dine-in', menuId: null, lines: [{ itemId: 'burger', qty: 2 }], checkDiscounts: [{ id: 'd1', label: '10% off', type: 'percent', value: 10 }] },
  { id: 'promo-code', orderType: 'takeaway', menuId: null, lines: [{ itemId: 'burger', qty: 2 }], credits: { promo: 3.00 } },
  { id: 'loyalty-redeem', orderType: 'takeaway', menuId: null, lines: [{ itemId: 'latte', qty: 2 }], credits: { loyalty: 2.80 } },
  { id: 'gift-card', orderType: 'dine-in', menuId: null, lines: [{ itemId: 'burger', qty: 1 }], gift: 5.00 },
  { id: 'service-charge', orderType: 'dine-in', menuId: null, covers: 4, device: 'service', lines: [{ itemId: 'burger', qty: 4 }, { itemId: 'coke', qty: 4 }] },
  { id: 'tip', orderType: 'dine-in', menuId: null, lines: [{ itemId: 'toastie', qty: 1 }], tip: 1.00 },
  { id: 'deposit', orderType: 'dine-in', menuId: null, lines: [{ itemId: 'burger', qty: 2 }], deposit: 10.00 },
  { id: 'refund', orderType: 'dine-in', menuId: null, lines: [{ itemId: 'burger', qty: 1 }, { itemId: 'coke', qty: 1 }] },
  { id: 'us-stacked', region: 'us', orderType: 'takeaway', menuId: null, lines: [{ itemId: 'burger', qty: 1 }, { itemId: 'soda', qty: 1 }], checkDiscounts: [{ id: 'd5', label: '5 off', type: 'amount', value: 5 }] },
];
export const basket = (id) => BASKETS.find((b) => b.id === id);

/** The option rows a basket line picked, in the cart shape every surface stores ({id, label, price}). */
export const lineMods = (l) => (l.opts || []).map((id) => {
  const o = optionOf(id);
  return { id: o.id, name: o.name, label: o.name, groupLabel: o.groupLabel, price: o.price };
});
export const extraOf = (l) => lineMods(l).reduce((s, m) => s + m.price, 0);
