/**
 * kioskFixtures: sample data for the DEV only new kiosk design preview
 * (/?mode=kiosk&kioskPreview=1). Shapes match the raw Supabase rows KioskApp loads
 * (menu_categories, menu_items, modifier_groups, device_profiles), so the screens meet the
 * same data they will see on a real kiosk. Content follows the design README sample menu.
 * Never used in production (the preview is left out of production builds).
 */

export const FIXTURE_LOCATION_ID = 'preview-location';
export const FIXTURE_COMPANY_ID = 'preview-company';

// The README 3 by 3 logo mark, as an inline SVG, for the "logo on" preview option.
const MOSAIC = ['#9DD3C4', '#4A2E1C', '#E9C84D', '#7FA86A', '#0F5F52', '#E24E2B', '#EFE4D9', '#7FA86A', '#0F5F52'];
export const FIXTURE_LOGO_URL = /* @__PURE__ */ (() => {
  const mosaicSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="84" height="84" viewBox="0 0 84 84">${
  MOSAIC.map((c, i) => `<rect x="${(i % 3) * 29}" y="${Math.floor(i / 3) * 29}" width="26" height="26" fill="${c}"/>`).join('')
}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(mosaicSvg)}`;
})();

export const FIXTURE_CATEGORIES = [
  { id: 'pizza', label: 'Stone baked pizza', sort_order: 0, parent_id: null, is_special: false },
  { id: 'plates', label: 'Small plates', sort_order: 1, parent_id: null, is_special: false },
  { id: 'salads', label: 'Salads', sort_order: 2, parent_id: null, is_special: false },
  { id: 'draught', label: 'Draught', sort_order: 3, parent_id: null, is_special: false },
  { id: 'cocktails', label: 'Cocktails', sort_order: 4, parent_id: null, is_special: false },
  { id: 'zero', label: 'Zero proof', sort_order: 0, parent_id: 'cocktails', is_special: false },
  { id: 'soft', label: 'Soft drinks', sort_order: 5, parent_id: null, is_special: false },
  { id: 'coffee', label: 'Coffee and tea', sort_order: 6, parent_id: null, is_special: false },
  { id: 'desserts', label: 'Desserts', sort_order: 7, parent_id: null, is_special: false },
];

// Alcohol is flagged by category (Challenge 21 settings), not by item.
export const FIXTURE_ALCOHOL_CATEGORY_IDS = ['draught', 'cocktails'];

export const FIXTURE_MODIFIER_GROUPS = [
  {
    id: 'mg-extras', name: 'Add anything?', selection_type: 'multiple', min: 0, max: 3,
    options: [
      { id: 'o-mozz', name: 'Extra mozzarella', price: 1.5, allergens: ['milk'] },
      { id: 'o-honey', name: 'Chilli honey', price: 1 },
      { id: 'o-rocket', name: 'Rocket', price: 1 },
    ],
  },
  {
    id: 'mg-base', name: 'Base', selection_type: 'single', min: 1, max: 1,
    options: [
      { id: 'o-classic', name: 'Classic', price: 0 },
      { id: 'o-sourdough', name: 'Sourdough', price: 1 },
    ],
  },
  {
    id: 'mg-box', name: 'Pick your 3', selection_type: 'quantity', min: null, max: 3,
    options: [
      { id: 'o-glazed', name: 'Glazed', price: 0, allergens: ['gluten', 'milk'] },
      { id: 'o-filled', name: 'Filled', price: 0.5, subGroupId: 'mg-filling' },
      { id: 'o-sugar', name: 'Cinnamon sugar', price: 0 },
    ],
  },
  {
    id: 'mg-filling', name: 'Filling', selection_type: 'single', min: 1, max: 1,
    options: [
      { id: 'o-jam', name: 'Raspberry jam', price: 0 },
      { id: 'o-custard', name: 'Custard', price: 0.2, allergens: ['eggs', 'milk'] },
    ],
  },
  {
    id: 'mg-milk', name: 'Milk', selection_type: 'single', min: 0, max: 1,
    options: [
      { id: 'o-oat', name: 'Oat milk', price: 0.4 },
      { id: 'o-shot', name: 'Extra shot', price: 0.6 },
    ],
  },
];

// #__NO_SIDE_EFFECTS__ marks these helpers as pure, so a production build drops every
// fixture along with the preview.
const item = /* #__NO_SIDE_EFFECTS__ */ (id, cat, name, price, description, extra = {}) => ({
  id, cat, cats: null, name, price, description, sort_order: 0, parent_id: null, archived: false,
  allergens: [], image: null, visibility: { kiosk: true }, ...extra,
});

export const FIXTURE_ITEMS = [
  item('p1', 'pizza', 'Margherita', 9.5, 'Fior di latte, basil, San Marzano', { allergens: ['milk', 'gluten'], assigned_modifier_groups: ['mg-extras'] }),
  item('p2', 'pizza', 'Diavola', 12, 'Spicy salami, chilli, oregano', { allergens: ['milk', 'gluten'], assigned_modifier_groups: ['mg-base', 'mg-extras'], sort_order: 1 }),
  item('p3', 'pizza', 'Funghi', 11.5, 'Mixed mushroom, thyme, taleggio', { allergens: ['milk', 'gluten'], sort_order: 2 }),
  item('s1', 'plates', 'Garlic dough balls', 5.5, 'Six, with garlic butter', { allergens: ['milk', 'gluten'] }),
  item('s2', 'plates', 'Padron peppers', 6, 'Sea salt, lemon', { sort_order: 1 }),
  item('l1', 'salads', 'Caesar', 9, 'Baby gem, anchovy dressing', { allergens: ['fish', 'eggs', 'milk', 'gluten'] }),
  item('d1', 'draught', 'Lager', 0, 'Crisp 4.6% house lager', { allergens: ['gluten'] }),
  item('d1-half', 'draught', 'Half', 3.1, '', { parent_id: 'd1', sort_order: 0 }),
  item('d1-pint', 'draught', 'Pint', 5.3, '', { parent_id: 'd1', sort_order: 1 }),
  item('c1', 'cocktails', 'Negroni', 9.5, 'Gin, campari, vermouth'),
  item('c2', 'zero', 'Nojito', 6, 'Lime, mint, soda'),
  item('f1', 'soft', 'Cola', 2.8, 'Bottled, 330ml'),
  item('k1', 'coffee', 'Flat white', 0, 'Double shot', { allergens: ['milk'], assigned_modifier_groups: ['mg-milk'] }),
  item('k1-reg', 'coffee', 'Regular', 3.2, '', { parent_id: 'k1', sort_order: 0 }),
  item('k1-lg', 'coffee', 'Large', 3.8, '', { parent_id: 'k1', sort_order: 1 }),
  item('z1', 'desserts', 'Tiramisu', 6.5, 'Mascarpone, espresso', { allergens: ['milk', 'eggs', 'gluten'] }),
  item('z2', 'desserts', 'Doughnut box', 7.5, 'Any three, freshly made', { allergens: ['gluten'], assigned_modifier_groups: ['mg-box'], sort_order: 1 }),
];

// Stock states for the preview's "Stock" option: Funghi low, Padron peppers out of their
// daily count, Tiramisu 86'd, and the Half of lager sold out.
export const FIXTURE_DAILY_COUNTS = {
  p3: { remaining: 2, par: 10 },
  s2: { remaining: 0, par: 5 },
  'd1-half': { remaining: 0, par: 20 },
};
export const FIXTURE_EIGHTY_SIX = ['z1'];

const zone = /* #__NO_SIDE_EFFECTS__ */ (sectionId, label, prefix, n) => ({
  sectionId, label, tables: Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, label: `${prefix}${i + 1}`, section: sectionId, sortOrder: 0 })),
});

export const FIXTURE_TABLE_STATES = {
  zones: { status: 'ok', groups: [zone('bar', 'Bar', 'B', 15), zone('main', 'Main dining', 'T', 11), zone('terrace', 'Terrace', 'P', 8)] },
  flat: { status: 'ok', groups: [{ sectionId: null, label: null, tables: zone(null, null, 'T', 12).tables }] },
  empty: { status: 'empty', groups: [] },
  failed: { status: 'failed', groups: [] },
  loading: { status: 'loading', groups: [] },
};

/** A device_profiles row for the preview, with the new design switched on. */
export function fixtureProfile(overrides = {}) {
  return {
    id: 'preview-profile',
    kiosk_new_design: true,
    kiosk_brand_name: 'Oven and Tap',
    kiosk_brand_color: null,
    kiosk_brand_logo_url: null,
    kiosk_attract_video_url: null,
    kiosk_table_mode: 'either',
    kiosk_loyalty_enabled: true,
    kiosk_sms_enabled: true,
    kiosk_allergen_required: false,
    kiosk_category_photos: true,
    kiosk_idle_timeout_sec: 60,
    kiosk_avg_wait_minutes: 8,
    kiosk_tip_presets: [10, 12.5, 15],
    ...overrides,
  };
}

// ── Stage C: Review and pay fixtures ────────────────────────────────────────

// Venue tipping rows (platform.locations.tipping_config) for the preview's Tipping option.
export const FIXTURE_TIPPING = {
  venue: { ok: true, row: { tipping_config: { kiosk: { on: true, pct: [10, 12.5, 15], default: null, custom: false } } } },
  venueDefault: { ok: true, row: { tipping_config: { kiosk: { on: true, pct: [5, 10, 15], default: 10, custom: false } } } },
  off: { ok: true, row: { tipping_config: { kiosk: { on: false, pct: [10], default: null, custom: false } } } },
  failed: { ok: false, row: null },
};

// Codes the preview understands. Gift codes are 16 characters (spaces and dashes are ignored).
export const FIXTURE_GIFT_CARDS = {
  GIFT000011112222: { card_id: 'gc-preview-1', code_last4: '2222', status: 'active', balance: 2000 },
  GIFTEMPTY0000000: { card_id: 'gc-preview-2', code_last4: '0000', status: 'active', balance: 0 },
  GIFTFROZEN000000: { card_id: 'gc-preview-3', code_last4: '0000', status: 'frozen', balance: 1500 },
};
export const FIXTURE_PROMOS = {
  SAVE5: { amount: 5, label: '£5 off', min_spend: 10 },
  BIGSAVE: { amount: 40, label: '£40 off', min_spend: 0 },
};
export const FIXTURE_OTP_CODE = '123456';

/** The loyalty-otp verify reply for the preview. The personal details are there on purpose:
 *  the screens must never show them. */
export function fixtureVerifyReply(phone) {
  return {
    verified: true,
    customer: { id: 'preview-customer', name: 'Private Person', email: 'private@example.com', phone },
    loyalty: {
      points_balance: 1250,
      tier: { name: 'Gold' },
      stamp_rewards: [{ program_id: 'sp-coffee', name: 'Free flat white', reward_type: 'free_item', reward_config: { eligible_items: [{ id: 'k1', name: 'Flat white' }] }, available: 1 }],
      rewards_available: [
        { id: 'rw-3off', name: '£3 off your order', points_cost: 300, reward_type: 'discount_fixed', reward_value: { amount_minor: 300 } },
        { id: 'rw-10pc', name: '10% off', points_cost: 500, reward_type: 'discount_percent', reward_value: { percent: 10 } },
        { id: 'rw-old', name: 'Reward with no value', points_cost: 100, reward_type: 'discount_fixed' },
      ],
    },
    stamp_cards: [],
    gift_cards: [{ id: 'linked', last4: '9999', balance: 5000 }],
  };
}

// Menu translations (v5.8.82): a few Spanish rows, the shape menu_translations holds, so the
// preview shows venue text following the language pill. Real venues get every row from the
// menu-translate edge function.
export const FIXTURE_MENU_TRANSLATIONS = {
  es: [
    { entity_type: 'category', entity_id: 'pizza', text: { name: 'Pizza al horno de piedra', en: 'Stone baked pizza' } },
    { entity_type: 'category', entity_id: 'plates', text: { name: 'Raciones', en: 'Small plates' } },
    { entity_type: 'category', entity_id: 'salads', text: { name: 'Ensaladas', en: 'Salads' } },
    { entity_type: 'category', entity_id: 'draught', text: { name: 'De barril', en: 'Draught' } },
    { entity_type: 'item', entity_id: 'p1', text: { name: 'Margherita', description: 'Fior di latte, albahaca, San Marzano', en: 'Margherita' } },
    { entity_type: 'item', entity_id: 'p2', text: { name: 'Diavola', description: 'Salami picante, guindilla, orégano', en: 'Diavola' } },
    { entity_type: 'item', entity_id: 'p3', text: { name: 'Funghi', description: 'Setas variadas, tomillo, taleggio', en: 'Funghi' } },
    { entity_type: 'modifier_group', entity_id: 'mg-milk', text: { name: 'Leche', en: 'Milk' } },
    { entity_type: 'modifier_option', entity_id: 'o-oat', text: { name: 'Leche de avena', en: 'Oat milk' } },
  ],
};
