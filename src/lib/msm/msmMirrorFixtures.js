// src/lib/msm/msmMirrorFixtures.js: ONE list of tax profile cases with the answer to "is this still a
// generated copy of the item's own rate?" Three implementations must agree with it (design review
// blocker 3): src/lib/taxCompute.js isLegacyMirror (what the till's engine does),
// supabase/functions/_shared/msmTax.js isMirrorProfile (what the planner plans), and
// public.msm__is_legacy_mirror (what the database allows). The first two are pinned in
// msmTax.test.js; the database in supabase/tests/multi_site_menu/run.mjs, from this same file.
// Raw database rows (snake case), made up ids.

const RATE = 'c1000000-0000-4000-8000-000000000001';
const OTHER = 'c1000000-0000-4000-8000-000000000002';
const LOC = '11111111-0000-4000-8000-0000000a0001';
const rate = (extra = {}) => ({ id: RATE, location_id: LOC, name: 'VAT', rate: 20, type: 'inclusive', active: true, ...extra });
const line = (extra = {}) => ({ name: 'VAT', line_type: 'rate', rate: 20, mode: 'inclusive', compound: false, taxable: false, tax_basis: 'pre_discount', order_types: ['all'], active: true, tax_service_charge: null, tax_delivery_fee: null, ...extra });
const profile = (extra = {}) => ({ location_id: LOC, name: 'VAT', rounding: { mode: 'half_up', level: 'invoice' }, active: true, sort_order: 0, generated_from_rate_id: RATE, ...extra });

export const MIRROR_RATE_ID = RATE;
export const MIRROR_OTHER_RATE_ID = OTHER;
export const MIRROR_LOCATION = LOC;

// itemRate: the item's rate after the write (the publish rule adds "the copy is of THIS rate").
export const MIRROR_CASES = [
  { name: 'a verbatim inclusive copy', rate: rate(), profile: profile(), lines: [line()], itemRate: RATE, expect: true },
  { name: 'a verbatim exclusive copy (US defaults: post discount, service on)', rate: rate({ type: 'exclusive' }), profile: profile(), lines: [line({ mode: 'exclusive', tax_basis: 'post_discount' })], itemRate: RATE, expect: true },
  { name: 'an exclusive copy whose basis was left pre discount is a real profile', rate: rate({ type: 'exclusive' }), profile: profile(), lines: [line({ mode: 'exclusive', tax_basis: 'pre_discount' })], itemRate: RATE, expect: false },
  { name: 'the item is on another rate', rate: rate(), profile: profile(), lines: [line()], itemRate: OTHER, expect: false },
  { name: 'its source rate is switched off', rate: rate({ active: false }), profile: profile(), lines: [line()], itemRate: RATE, expect: false },
  { name: 'rounding per item', rate: rate(), profile: profile({ rounding: { mode: 'half_up', level: 'item' } }), lines: [line()], itemRate: RATE, expect: false },
  { name: 'two active lines', rate: rate(), profile: profile(), lines: [line(), line({ name: 'Levy', rate: 1 })], itemRate: RATE, expect: false },
  { name: 'a second line switched off still counts as one', rate: rate(), profile: profile(), lines: [line(), line({ name: 'Old', active: false })], itemRate: RATE, expect: true },
  { name: 'a different rate on the line', rate: rate(), profile: profile(), lines: [line({ rate: 17.5 })], itemRate: RATE, expect: false },
  { name: 'limited to an order type', rate: rate(), profile: profile(), lines: [line({ order_types: ['takeaway'] })], itemRate: RATE, expect: false },
  { name: 'compound', rate: rate(), profile: profile(), lines: [line({ compound: true })], itemRate: RATE, expect: false },
  { name: 'taxable', rate: rate(), profile: profile(), lines: [line({ taxable: true })], itemRate: RATE, expect: false },
  { name: 'mode changed from the rate', rate: rate(), profile: profile(), lines: [line({ mode: 'exclusive' })], itemRate: RATE, expect: false },
  { name: 'service charge taxed on an inclusive copy', rate: rate(), profile: profile(), lines: [line({ tax_service_charge: true })], itemRate: RATE, expect: false },
  { name: 'delivery fee taxed', rate: rate(), profile: profile(), lines: [line({ tax_delivery_fee: true })], itemRate: RATE, expect: false },
  { name: 'not generated from a rate (a real profile)', rate: rate(), profile: profile({ generated_from_rate_id: null }), lines: [line()], itemRate: RATE, expect: false },
  { name: 'a per unit line', rate: rate(), profile: profile(), lines: [line({ line_type: 'per_unit' })], itemRate: RATE, expect: false },
];
