// supabase/functions/_shared/accountingDay.js
//
// THE NEUTRAL DAILY ACCOUNTING AGGREGATOR. One venue, one business day, summed per tender:
// what came in (sales) and what went back out (refunds), each split into goods, tax, tip and
// service. It knows nothing about Xero or QuickBooks; xero-sales turns the summary into Xero
// bank transactions (_shared/xeroPostingPlan.js) and a QuickBooks integration can turn the
// same summary into a journal entry. Pure JS whose only import is its sibling saleVat.js (the
// one refund VAT basis every report shares, 8 Oct 2026), so `npm test`
// loads the file the edge function ships. The day window comes from _shared/businessDay.js.
//
// Money is summed in MINOR units (pence, cents) end to end so a day's lines add up exactly.
//
// Three rules this file exists for (19 Sep 2026):
//   1. SALES belong to the venue business day the check CLOSED in (_shared/businessDay.js),
//      never a UTC day.
//   2. A check's money is read from closed_checks.tenders ([{method, amount, tip, ...}],
//      written by every till and web checkout from v5.9.11). An older row has no tenders and
//      falls back to its single method; an older SPLIT row cannot be split after the fact, so
//      it becomes one 'unallocated' tender and is flagged for the accountant.
//   3. REFUNDS belong to the business day of the refund itself (refunds[].timestamp), not the
//      day the check closed, and carry their own tip, service and tax portions.
// And since 28 Sep 2026, given the venue's tax rates, every figure is also split BY TAX RATE
// (byRate), so Xero gets one sales line per VAT rate (see "tax rates" below).
// 8 Oct 2026 (the VAT audit): a check with goods and NO VAT recorded (tax_amount null) at a
// venue that has rates is flagged tax_not_recorded once, and the day carries it in `holds`:
// the Xero plans refuse to post a day that holds one (it would post at VAT 0.00, as Preston
// QR-4OGI7 would have). Nothing is guessed; the sale is fixed first, then the day posts.

// ── money ────────────────────────────────────────────────────────────────────

import { refundTaxBasis } from './saleVat.js';

/** A major unit amount (pounds, dollars; number or numeric string) to integer minor units. */
export function toMinor(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export const fromMinor = (m) => Math.round(m) / 100;

/**
 * Split `total` (integer minor units, >= 0) across `weights` in proportion, as integers that
 * add up to exactly `total` (largest remainder; ties go to the earlier weight). All zero
 * weights put the whole amount on the first slot.
 */
export function allocate(total, weights) {
  const n = weights.length;
  if (!n) return [];
  const t = Math.round(total);
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const sum = w.reduce((a, b) => a + b, 0);
  if (sum <= 0) return w.map((_, i) => (i === 0 ? t : 0));
  const sign = t < 0 ? -1 : 1;
  const abs = Math.abs(t);
  const raw = w.map((x) => (abs * x) / sum);
  const out = raw.map(Math.floor);
  let left = abs - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % n, left--) out[order[k].i] += 1;
  return out.map((x) => x * sign);
}

// ── tender methods ───────────────────────────────────────────────────────────

/**
 * The accounting KIND of a tender method. Each money kind has its own default clearing
 * account, because each settles differently: card money arrives in a processor payout, cash
 * in the drawer, a gift card redemption spends money taken when the card was SOLD, a booking
 * deposit was taken online before the visit, and 'unallocated' is money we cannot place.
 * 'discount' (loyalty rewards, promo codes) is NOT money: it lowers the sale and is never
 * posted as takings.
 */
export const TENDER_KINDS = ['card', 'cash', 'gift_card', 'deposit', 'unallocated', 'other', 'discount'];
export const MONEY_KINDS = new Set(['card', 'cash', 'gift_card', 'deposit', 'unallocated', 'other']);

/** One spelling per method: trimmed, lower case, spaces as underscores, known aliases folded. */
export function canonicalMethod(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!s) return 'other';
  if (s === 'gift' || s === 'giftcard' || s === 'gift_card' || s === 'gift_cards') return 'gift_card';
  return s;
}

export function tenderKind(method) {
  const m = canonicalMethod(method);
  if (m === 'split' || m === 'unallocated') return 'unallocated';
  if (m.includes('loyalty') || m.includes('promo') || m.includes('reward') || m === 'discount') return 'discount';
  if (m.includes('cash')) return 'cash';
  if (m.includes('gift')) return 'gift_card';
  if (m.startsWith('booking') || m.includes('deposit') || m.includes('prepaid')) return 'deposit';
  if (/card|stripe|adyen|ryft|online|apple|google|contactless|visa|master|amex|terminal|pax|tap|credit|debit/.test(m)) return 'card';
  return 'other';
}

// ── one check ────────────────────────────────────────────────────────────────

/** True when the row is a cancelled sale that must not count (HubRise channel cancel today). */
export function isVoidedCheck(row) {
  return !!row?.voided || String(row?.status || '').toLowerCase() === 'voided';
}

/** The check's tax in minor units: stored tax_amount, else the legacy fallback from INVARIANTS.md. */
export function checkTaxMinor(row) {
  if (row?.tax_amount != null && row.tax_amount !== '') return Math.max(0, toMinor(row.tax_amount));
  return Math.max(0, toMinor(row?.total) - toMinor(row?.subtotal) - toMinor(row?.service) - toMinor(row?.tip));
}

/** True when the check booked a VAT figure at all (0 counts; null is "not recorded"). */
export function checkTaxRecorded(row) {
  const v = row?.tax_amount;
  return v != null && v !== '' && Number.isFinite(Number(v));
}

/**
 * 8 Oct 2026: the VAT booked on goods paid with loyalty or promo credit (the tenders this layer
 * reads as discounts), in minor units. The till books it; Xero, Daily trading and the apps take
 * it off. The Back Office Tax summary shows this amount beside its D1 line until the owner
 * decides the rule with his accountant.
 */
export function creditTaxMinor(row) {
  let out = 0;
  for (const p of checkTenderParts(row).parts) if (p.kind === 'discount') out += p.tax;
  return out;
}

const LIST_METHOD = /^\s*[a-z_ ]+:\s*\d+(?:\.\d+)?\s*(?:,\s*[a-z_ ]+:\s*\d+(?:\.\d+)?\s*)*$/i;

// What a legacy gift_card record says was really debited, in minor units.
function legacyGiftMinor(g) {
  if (!g || typeof g !== 'object') return 0;
  const legs = Array.isArray(g.legs) && g.legs.length ? g.legs : [g];
  return legs.filter((l) => l && !l.commit_error).reduce((s, l) => s + Math.max(0, Math.round(Number(l.applied) || 0)), 0);
}

// Booking credit legs a legacy row carries inside payment_intents ({ id:null, amountMinor, method }).
function legacyBookingLegs(row) {
  return (Array.isArray(row?.payment_intents) ? row.payment_intents : [])
    .filter((l) => l && /^booking/i.test(String(l.method || '')))
    .map((l) => ({ method: canonicalMethod(l.method), amount: Math.max(0, Math.round(Number(l.amountMinor) || 0)) }))
    .filter((l) => l.amount > 0);
}

/**
 * A row written before closed_checks.tenders. Only what the row itself proves is split out:
 *   'gift_card:10.00,loyalty:2.00,card:18.00'  the online card path's own list, read as written
 *   'gift_card+card', 'booking+cash'            the till's composite: the gift card (gift_card
 *                                               jsonb) and booking credit (payment_intents) are
 *                                               sized from the row, the rest is the last part
 *   'split', or a composite with a loyalty or promo credit the row never stored
 *                                               one 'unallocated' tender, flagged
 *   anything else                               one tender holding the whole check
 */
function legacyTenders(row, flags) {
  const raw = String(row?.payment_method || row?.method || 'other');
  const tip = Math.max(0, toMinor(row?.tip));
  const total = Math.max(0, toMinor(row?.total));
  const mk = (method, amount, tipM = 0) => ({
    method, kind: tenderKind(method), amount: Math.max(0, amount), tip: Math.max(0, tipM),
    processor: tenderKind(method) === 'card' ? (row?.processor || null) : null, pspRef: null, giftCardId: null,
  });
  const unallocated = (code) => { flags.push(code); return [mk('unallocated', total - tip, tip)]; };
  const source = String(row?.source || '').toLowerCase();
  const credits = () => {
    const out = [];
    const g = legacyGiftMinor(row?.gift_card);
    if (g > 0) out.push(mk('gift_card', g));
    const l = Math.max(0, Math.round(Number(row?.loyalty?.discount_value) || 0));   // minor units
    if (l > 0) out.push(mk('loyalty', l));
    const pr = Math.max(0, toMinor(row?.promo?.discount_value));                      // major units
    if (pr > 0) out.push(mk('promo', pr));
    return out;
  };

  // THE KIOSK writes no tenders: its card path is fingerprint guarded (kioskCardPathGuard.test.js,
  // owner sign off plus a hardware test to change). Its own fields prove the split exactly:
  // total is the CARD amount (tip included, net of every credit), gift_card.applied what the
  // gift card gave (minor), loyalty.discount_value (minor) and promo.discount_value (major).
  if (source === 'kiosk') {
    const t = Math.min(tip, total);
    const cr = credits();
    // A plain kiosk card sale keeps the method it was written with ('card-external'), so a
    // bank account the operator mapped to it before v5.9.11 still applies.
    const card = { ...mk('card', total - t, t), ...(cr.length ? {} : { rawMethod: String(row?.payment_method || row?.method || 'card') }) };
    return [...cr, ...(total > 0 ? [card] : [])];
  }
  // Online, gift card or reward only (no card charged; the card path always writes its list):
  // the gift card and loyalty credit from their own fields.
  if (source === 'online' && !String(row?.payment_method || '').includes(':')
      && ['gift_card', 'loyalty', 'split'].includes(canonicalMethod(row?.method))) {
    const out = credits();
    if (out.length) return out;
  }

  if (LIST_METHOD.test(raw) && raw.includes(':')) {
    const parts = raw.split(',').map((p) => { const i = p.lastIndexOf(':'); return { method: canonicalMethod(p.slice(0, i)), amount: toMinor(p.slice(i + 1)) }; });
    let tipLeft = tip;
    return parts.map((p) => {
      let t = 0;
      if (tipLeft > 0 && tenderKind(p.method) === 'card') { t = Math.min(tipLeft, p.amount); tipLeft -= t; }
      return mk(p.method, p.amount - t, t);
    });
  }

  const segs = raw.split('+').map(canonicalMethod).filter((x) => x && x !== 'other');
  if (segs.length > 1 || segs[0] === 'booking') {
    const base = segs[segs.length - 1];
    const credits = segs.slice(0, -1);
    const booking = legacyBookingLegs(row);
    if (segs.every((x) => x.startsWith('booking'))) {
      return booking.length ? booking.map((l) => mk(l.method, l.amount)) : unallocated('legacy_mixed_unallocated');
    }
    if (base === 'split' || credits.some((c) => c !== 'gift_card' && !c.startsWith('booking'))) return unallocated('legacy_mixed_unallocated');
    const out = [];
    if (credits.includes('gift_card')) { const g = legacyGiftMinor(row?.gift_card); if (g > 0) out.push(mk('gift_card', g)); }
    if (credits.some((c) => c.startsWith('booking'))) booking.forEach((l) => out.push(mk(l.method, l.amount)));
    const used = out.reduce((s, t) => s + t.amount, 0);
    const rest = Math.max(0, total - used);
    const t = Math.min(tip, rest);
    out.push(mk(base, rest - t, t));
    return out;
  }

  const method = segs[0] || canonicalMethod(raw);
  if (method === 'split') return unallocated('legacy_split_unallocated');
  // The operator's saved mapping may use the method exactly as the till wrote it.
  return [{ ...mk(method, total - tip, tip), rawMethod: raw }];
}

/**
 * The tenders that paid a check, normalised: [{ method, kind, amount, tip, processor,
 * pspRef, giftCardId }] in minor units, where `amount` is the bill money taken on that
 * tender (goods, tax and service) and `tip` the gratuity taken on it.
 * Returns { tenders, legacy, flags } — `legacy` when the row predates the tenders column.
 */
export function checkTenders(row) {
  const flags = [];
  const list = Array.isArray(row?.tenders) ? row.tenders.filter((t) => t && typeof t === 'object') : null;
  if (list && list.length) {
    const tenders = list.map((t) => {
      const method = canonicalMethod(t.method);
      return {
        method,
        kind: tenderKind(method),
        amount: Math.max(0, toMinor(t.amount)),
        tip: Math.max(0, toMinor(t.tip)),
        processor: t.processor || null,
        pspRef: t.psp_ref || null,
        giftCardId: t.gift_card_id || null,
      };
    });
    // A tip taken AFTER the close (US tip on the printed receipt: _shared/tip_capture.ts raises
    // closed_checks.tip and total, not the tenders) belongs on the card it was captured on.
    // Only when the tenders then fall short of the total, so a tip a gift card happened to
    // cover is never moved onto the card.
    let paid = tenders.reduce((s, t) => s + t.amount + t.tip, 0);
    const tipGap = Math.max(0, toMinor(row.tip)) - tenders.reduce((s, t) => s + t.tip, 0);
    const shortBy = toMinor(row.total) - paid;
    const card = tenders.find((t) => t.kind === 'card');
    if (tipGap > 0 && shortBy > 0 && card) { const add = Math.min(tipGap, shortBy); card.tip += add; paid += add; }
    // Tenders list everything that settled the bill, so they can exceed a surface's net
    // `total` (kiosk and online store the card amount there); they should never fall short.
    if (paid < toMinor(row.total) - 1) flags.push('tenders_short_of_total');
    return { tenders, legacy: false, flags };
  }
  return { tenders: legacyTenders(row, flags), legacy: true, flags };
}

// ── tax rates ────────────────────────────────────────────────────────────────
//
// 28 Sep 2026: Xero needs each sale split by VAT rate (one line per rate), or zero rated food
// posts with 20% VAT. A check's split is read from closed_checks.tax_breakdown (till, MPOS and
// bar closes save it) and used only as WEIGHTS: each tender's goods and tax are split with
// allocate(), so every total stays exact to the penny. Checks with no breakdown (kiosk,
// online, QR, catering) are split by what their booked tax implies, and flagged.
//
// A bucket is { key, pct, mode, rateId, name, code, zeroKind, isDefault }:
//   rate:<id>  a venue tax_rates row (inclusive)
//   pct:<p>    a percentage no venue rate has (another venue's rate, a deleted one)
//   none       goods with no rate at all
//   excl       all added-on (US) sales tax, one bucket so stacked lines never count twice
//   default    the venue's rates are unknown: today's single line

const pctOf = (rate) => Math.round(Number(rate) * 1e6) / 1e4;   // 0.2 -> 20, 0.08875 -> 8.875

/** What a 0% rate means for VAT, from its name or code: 'exempt', 'outside' the scope, or 'zero' rated. */
export function zeroKindOf(name, code) {
  const s = `${name || ''} ${code || ''}`;
  if (/exempt/i.test(s)) return 'exempt';
  if (/outside|out of scope|no\s*vat|non[- ]?vat/i.test(s)) return 'outside';
  return 'zero';
}

export const NONE_TAX_BUCKET = Object.freeze({ key: 'none', pct: 0, mode: 'none', rateId: null, name: 'No tax rate', code: '', zeroKind: null, isDefault: false });
export const EXCL_TAX_BUCKET = Object.freeze({ key: 'excl', pct: null, mode: 'exclusive', rateId: null, name: 'Added-on sales tax', code: '', zeroKind: null, isDefault: false });
export const DEFAULT_TAX_BUCKET = Object.freeze({ key: 'default', pct: null, mode: 'default', rateId: null, name: 'Default rate', code: '', zeroKind: null, isDefault: true });

const MODE_RANK = { inclusive: 0, default: 0, none: 1, exclusive: 2 };
/**
 * The one order buckets are listed and posted in: inclusive rates by percentage, highest
 * first, then goods with no rate, then added-on tax; ties by key. allocate() gives ties to the
 * earlier slot, so this order also fixes every split.
 */
export function compareTaxBuckets(a, b) {
  return (MODE_RANK[a.mode] ?? 0) - (MODE_RANK[b.mode] ?? 0)
    || (b.pct ?? -1) - (a.pct ?? -1)
    || String(a.key).localeCompare(String(b.key));
}

function rateBucket(r) {
  return { key: `rate:${r.id}`, pct: r.pct, mode: 'inclusive', rateId: r.id, name: r.name || `${r.pct}%`, code: r.code, zeroKind: r.pct === 0 ? r.zeroKind : null, isDefault: r.isDefault };
}

/**
 * The venue's tax_rates rows (inactive ones too: older checks point at them) made ready to
 * match: { rates[], byId, defaultRate, zeroRate, known, addedOn }. Rates are ordered active
 * first, then the default, then by id, so "the first rate at this percentage" is the same on
 * every run. `addedOn` marks a venue whose tax is added on top of prices (US): its default rate
 * is added-on, or, with no default, it has added-on rates and no inclusive rate above 0%.
 */
export function taxContext(taxRates) {
  const known = Array.isArray(taxRates);
  const rates = (known ? taxRates : [])
    .filter((r) => r && r.id != null && r.rate != null && r.rate !== '' && Number.isFinite(Number(r.rate)))
    .map((r) => {
      const pct = pctOf(r.rate);
      return {
        id: String(r.id), name: String(r.name || ''), code: String(r.code || ''), pct,
        mode: String(r.type || 'inclusive').toLowerCase() === 'exclusive' ? 'exclusive' : 'inclusive',
        isDefault: !!(r.is_default ?? r.isDefault), active: r.active !== false,
        zeroKind: pct === 0 ? zeroKindOf(r.name, r.code) : null,
      };
    })
    .sort((a, b) => (+b.active - +a.active) || (+b.isDefault - +a.isDefault) || a.id.localeCompare(b.id));
  const byId = new Map(rates.map((r) => [r.id, r]));
  const defaultRate = rates.find((r) => r.active && r.isDefault) || null;
  const zeroRate = rates.find((r) => r.active && r.mode === 'inclusive' && r.pct === 0 && r.zeroKind === 'zero') || null;
  const addedOn = defaultRate ? defaultRate.mode === 'exclusive'
    : rates.some((r) => r.active && r.mode === 'exclusive') && !rates.some((r) => r.active && r.mode === 'inclusive' && r.pct > 0);
  return { rates, byId, defaultRate, zeroRate, known, addedOn };
}

// The venue's bucket for one tax_breakdown entry. The entry's own rate id counts only when this
// venue has it at the SAME percentage: Leeds booked another venue's rate id for a while
// (unverified snapshot rates), and TaxManager hard deletes rates. Otherwise the first local rate
// with that percentage (a 0% one of the same kind first), else a bucket for the percentage.
function entryBucket(entry, ctx) {
  const r = entry?.rate;
  if (!r || typeof r !== 'object') return EXCL_TAX_BUCKET;   // a per unit levy (rate: null) is added-on tax
  if (String(r.type || 'inclusive').toLowerCase() === 'exclusive') return EXCL_TAX_BUCKET;
  const own = r.id != null ? ctx.byId.get(String(r.id)) : null;
  const pct = r.rate != null && r.rate !== '' && Number.isFinite(Number(r.rate)) ? pctOf(r.rate) : (own ? own.pct : null);
  if (pct == null) return { key: 'pct:unknown', pct: null, mode: 'inclusive', rateId: null, name: String(r.name || 'Unknown rate'), code: '', zeroKind: null, isDefault: false };
  if (own && own.mode === 'inclusive' && own.pct === pct) return rateBucket(own);
  const kind = pct === 0 ? zeroKindOf(r.name, r.code) : null;
  const same = ctx.rates.filter((x) => x.mode === 'inclusive' && x.pct === pct);
  const match = (kind && same.find((x) => x.zeroKind === kind)) || same[0];
  if (match) return rateBucket(match);
  return { key: `pct:${pct}`, pct, mode: 'inclusive', rateId: null, name: `${pct}%`, code: '', zeroKind: kind, isDefault: false };
}

// Copied from src/lib/taxShare.js (edge functions cannot import src): a frozen breakdown is
// usable when it carries a real number for the total tax.
function isUsableBreakdown(b) {
  return !!b && typeof b === 'object' && b.totalTax != null && Number.isFinite(Number(b.totalTax));
}

// A check with no usable breakdown: its booked tax taken at the venue default rate, the rest
// of the goods zero rated (or no rate when the venue has no 0% rate).
function impliedWeights(row, ctx, goods, tax) {
  const one = (bucket, flags, source = 'implied') => ({ weights: [{ bucket, gross: goods, tax }], source, flags });
  if (!ctx.known) return one(DEFAULT_TAX_BUCKET, [], 'default');                 // no rates loaded: exactly today
  const def = ctx.defaultRate;
  if (!def) return one(DEFAULT_TAX_BUCKET, ['tax_no_rates'], 'default');
  if (row?.tax_amount == null || row.tax_amount === '') return one(rateBucket(def), ['tax_not_recorded']);   // VAT unknown: the default rate, as before
  const zero = ctx.zeroRate ? rateBucket(ctx.zeroRate) : NONE_TAX_BUCKET;
  if (tax <= 0) return { weights: [{ bucket: zero, gross: goods, tax: 0 }], source: 'implied', flags: ['tax_split_estimated'] };
  const taxed = def.pct > 0 ? def
    : ctx.rates.filter((r) => r.active && r.mode === 'inclusive' && r.pct > 0).sort((a, b) => b.pct - a.pct)[0];
  if (!taxed) return one(rateBucket(def), ['tax_split_estimated']);
  const p = taxed.pct;
  let g = Math.min(goods, Math.round((tax * (100 + p)) / p));
  if (goods - g <= Math.ceil((100 + p) / (2 * p)) + 1) g = goods;   // rounding slop: 4p at 20%, 12p at 5%
  const weights = [{ bucket: rateBucket(taxed), gross: g, tax }];
  if (goods - g > 0) weights.push({ bucket: zero, gross: goods - g, tax: 0 });
  return { weights, source: 'implied', flags: ['tax_split_estimated'] };
}

/**
 * How one check's goods and tax divide between tax rates: { weights:[{bucket, gross, tax}],
 * source:'breakdown'|'implied'|'default', flags[] }. `goods` (bill money less service) and
 * `tax` (the booked tax, clamped) are in minor units; the weights are proportions only.
 */
export function checkRateWeights(row, ctx, goods, tax) {
  // 28 Sep 2026: a venue that adds tax on top (US) keeps today's ONE sales line, whatever its
  // checks' breakdowns say (a 0% rate made in TaxManager is 'inclusive' by default, and must
  // not split a US sale into a second line). Nothing is estimated, so nothing is flagged.
  if (ctx?.addedOn) return { weights: [{ bucket: EXCL_TAX_BUCKET, gross: goods, tax }], source: 'default', flags: [] };
  const t = row?.tax_breakdown;
  if (isUsableBreakdown(t) && Array.isArray(t.breakdown) && t.breakdown.length) {
    const acc = new Map();
    const put = (bucket, gross, tx) => {
      const w = acc.get(bucket.key) || { bucket, gross: 0, tax: 0 };
      w.gross += gross; w.tax += tx;
      acc.set(bucket.key, w);
    };
    let inclusiveGross = 0, taxSum = 0;
    for (const b of t.breakdown) {
      if (!b || typeof b !== 'object') continue;
      const bk = entryBucket(b, ctx);
      const x = Math.max(0, Number(b.tax) || 0) * 100;
      taxSum += x;
      // Stacked US lines each carry the full gross: added-on tax takes its goods from the remainder.
      if (bk.mode === 'exclusive') { put(bk, 0, x); continue; }
      const g = Math.max(0, Number(b.gross) || 0) * 100;
      inclusiveGross += g;
      put(bk, g, x);
    }
    const rest = Math.max(0, (Number(t.total) || 0) * 100 - inclusiveGross);
    const addedOn = !!t.hasExclusiveTax || acc.has('excl');
    if (rest >= 0.5) put(addedOn ? EXCL_TAX_BUCKET : NONE_TAX_BUCKET, rest, 0);
    const weights = [...acc.values()].sort((a, b) => compareTaxBuckets(a.bucket, b.bucket));
    if (weights.some((w) => w.gross > 0) || goods <= 0) {
      const off = Math.abs(Math.round(taxSum) - tax) > Math.max(2, Math.round(tax * 0.01));
      return { weights, source: 'breakdown', flags: off ? ['tax_breakdown_mismatch'] : [] };
    }
  }
  return impliedWeights(row, ctx, goods, tax);
}

/** Split `sales` and `tax` (minor units) by the weights: { [bucket key]: { sales, tax } }, each adding up exactly. */
export function splitByRate(sales, tax, weights) {
  const out = {};
  if (!Array.isArray(weights) || !weights.length) return out;
  const s = allocate(sales, weights.map((w) => w.gross));
  let tw = weights.map((w) => w.tax);
  // No tax on any weight but tax to place: on the taxed buckets by their goods.
  if (!tw.some((x) => x > 0)) tw = weights.map((w) => (w.bucket.pct > 0 || w.bucket.key === 'excl' || w.bucket.key === 'default' ? w.gross : 0));
  const t = allocate(tax, tw);
  weights.forEach((w, i) => {
    if (!s[i] && !t[i]) return;
    const e = out[w.bucket.key] || (out[w.bucket.key] = { sales: 0, tax: 0 });
    e.sales += s[i]; e.tax += t[i];
  });
  return out;
}

// A check's bill money, service and clamped tax in minor units, as its tenders took them.
function checkMoney(row, tenders) {
  const amounts = tenders.map((t) => t.amount);
  const billTotal = amounts.reduce((a, b) => a + b, 0);
  const service = Math.min(Math.max(0, toMinor(row?.service)), billTotal);
  const tax = Math.min(checkTaxMinor(row), Math.max(0, billTotal - service));
  return { amounts, billTotal, service, tax };
}

/**
 * Split one check's service and tax across its tenders in proportion to the bill money each
 * took, so a split check's service charge and VAT land with the tenders that paid them.
 * Returns per tender { ...tender, gross, service, tax, sales } where gross = amount + tip and
 * sales = amount - service (goods, tax included). Given a taxContext, each part also carries
 * byRate { [bucket key]: { sales, tax } } and the result the check's `buckets` and `rateSource`.
 */
export function checkTenderParts(row, taxCtx) {
  const { tenders, legacy, flags } = checkTenders(row);
  const { amounts, billTotal, service, tax } = checkMoney(row, tenders);
  const svc = allocate(service, amounts);
  const tx = allocate(tax, amounts);
  const parts = tenders.map((t, i) => ({ ...t, gross: t.amount + t.tip, service: svc[i], tax: tx[i], sales: t.amount - svc[i] }));
  if (!taxCtx) return { legacy, flags, parts };
  const w = checkRateWeights(row, taxCtx, billTotal - service, tax);
  for (const p of parts) p.byRate = splitByRate(p.sales, p.tax, w.weights);
  const all = [...flags, ...w.flags];
  // 8 Oct 2026: goods were sold and no VAT was booked at a venue that has rates. Flagged once
  // whatever the record says (a usable breakdown beside a null figure is still "not recorded").
  if (!checkTaxRecorded(row) && billTotal - service > 0 && taxCtx.known && taxCtx.rates.length && !all.includes('tax_not_recorded')) all.push('tax_not_recorded');
  return { legacy, flags: all, parts, buckets: w.weights.map((x) => x.bucket), rateSource: w.source };
}

// ── refunds ──────────────────────────────────────────────────────────────────

/** The instant (ms) a refund entry happened, or null when it carries no usable time. */
export function refundAtMs(entry) {
  const cands = [entry?.timestamp, entry?.at, entry?.created_at];
  for (const c of cands) {
    if (c == null || c === '') continue;
    const ms = typeof c === 'number' ? c : /^\d+$/.test(String(c)) ? Number(c) : Date.parse(c);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  const legAt = (entry?.legs || []).map((l) => l?.at).find((x) => Number.isFinite(Number(x)) && Number(x) > 0);
  return legAt != null ? Number(legAt) : null;
}

const OK_LEG = new Set(['succeeded', 'accepted']);

/**
 * One refunds[] entry turned into money by tender: { atMs, amount, parts:[{method, kind,
 * processor, gross, tip, service, tax, sales}], flags, skipped }.
 *
 * What an entry records (store.refundCheck since v5.6.79): amount (pounds, INCLUDES the tip,
 * service and tax portions), tipAmount, serviceAmount, taxAmount (a share of amount, may be
 * null), tenderMethod ('card' | 'cash' | ...), legs[] (card reversals, amountMinor + status),
 * cardStatus. Older entries have amount and tenderMethod only (their amount was the items);
 * a Ryft dashboard refund (source 'ryft_reconcile') has amount only.
 *
 * Rules, in order:
 *   - failed:true (the Adyen failure webhook) or cardStatus 'failed': no money moved, skipped.
 *   - card legs that succeeded are card money, up to the refund amount.
 *   - a FULL refund also puts back the check's gift card and loyalty or promo credit (the
 *     store reverses them), so those tenders take their share next.
 *   - tenderMethod 'cash': the rest is cash handed back.
 *   - otherwise the rest goes to the check's remaining tenders in proportion (a single
 *     tender takes all of it); with nothing to place it on, it is 'unallocated' and flagged.
 * Tip, service and tax: the entry's own figures; tax missing is the check's tax pro rata;
 * tip and service missing on an entry with no item list (a processor side refund) are the
 * check's pro rata too, flagged as estimated. An old item refund with no split is all goods.
 */
export function refundParts(entry, row, taxCtx) {
  const flags = [];
  const atMs = refundAtMs(entry);
  let amount = Math.max(0, toMinor(entry?.amount));
  const cardStatus = String(entry?.cardStatus || '').toLowerCase();
  if (entry?.failed === true) {
    return { atMs, amount, parts: [], flags: ['refund_failed'], skipped: true };
  }
  // 'pending' is written BEFORE the processor is called and replaced by the outcome after it
  // (store.refundCheck, cash included). Still pending means the till stopped mid refund:
  // nobody knows whether money moved, so it is not posted.
  if (cardStatus === 'pending' && canonicalMethod(entry?.tenderMethod) !== 'cash') {
    return { atMs, amount, parts: [], flags: ['refund_pending'], skipped: true };
  }
  if (amount <= 0) return { atMs, amount: 0, parts: [], flags, skipped: true };

  const legs = Array.isArray(entry?.legs) ? entry.legs.filter(Boolean) : [];
  const okLegs = legs.filter((l) => OK_LEG.has(String(l.status || '').toLowerCase()));
  const legMinor = okLegs.reduce((s, l) => s + Math.max(0, Math.round(Number(l.amountMinor) || 0)), 0);
  if ((cardStatus === 'partial' || cardStatus === 'failed') && legs.length) {
    // Card reversals that failed moved no money. What reached the card, plus any part the
    // entry never sent to a card (a gift card or credit put back), really went back.
    const failedMinor = legs.filter((l) => String(l.status || '').toLowerCase() === 'failed')
      .reduce((s, l) => s + Math.max(0, Math.round(Number(l.amountMinor) || 0)), 0);
    amount = Math.max(0, amount - failedMinor);
    if (amount <= 0) return { atMs, amount: 0, parts: [], flags: ['refund_failed'], skipped: true };
    if (failedMinor > 0) flags.push('refund_partly_failed');
  } else if (cardStatus === 'failed') {
    return { atMs, amount, parts: [], flags: ['refund_failed'], skipped: true };
  }

  // Components of the refund.
  const total = Math.max(1, toMinor(row?.total));
  const hasSplit = entry?.tipAmount != null || entry?.serviceAmount != null;
  let tip, service;
  if (hasSplit) {
    tip = Math.max(0, toMinor(entry.tipAmount));
    service = Math.max(0, toMinor(entry.serviceAmount));
  } else if (Array.isArray(entry?.items) && entry.items.length) {
    tip = 0; service = 0;   // an old item refund: the amount was the items
  } else {
    tip = Math.round((toMinor(row?.tip) * amount) / total);
    service = Math.round((toMinor(row?.service) * amount) / total);
    if (tip || service) flags.push('refund_split_estimated');
  }
  if (tip + service > amount) { const s = allocate(amount, [tip, service]); tip = s[0]; service = s[1]; }
  // 8 Oct 2026 (review): a refund entry with no VAT figure takes its share of the sale's VAT on
  // the SAME basis every report uses (saleVat.refundTaxBasis: the bill, or what the tenders
  // settled less tip when that is more). A reader close part paid by gift card or loyalty stores
  // `total` as the card part only, so pro rata on total alone gave the whole VAT back on a part
  // refund (1.67 where the Tax summary said 0.33) and the reports disagreed by pounds.
  const taxBasis = Math.max(1, toMinor(refundTaxBasis(row)));
  let tax = entry?.taxAmount != null && entry.taxAmount !== ''
    ? Math.max(0, toMinor(entry.taxAmount))
    : Math.min(checkTaxMinor(row), Math.round((checkTaxMinor(row) * amount) / taxBasis));
  tax = Math.min(tax, amount - tip - service);

  // Where the money went back.
  const { tenders } = checkTenders(row);
  const slices = [];   // { method, kind, processor, gross }
  let left = amount;
  const method = canonicalMethod(entry?.tenderMethod);
  const take = (m, kind, processor, g) => { if (g > 0) { slices.push({ method: m, kind, processor, gross: g }); left -= g; } };
  // 1. Card reversals that went through are card money.
  if (legMinor > 0) take('card', 'card', okLegs.find((l) => l.processor)?.processor || null, Math.min(left, legMinor));
  // 2. A full refund also puts back gift card balance and loyalty or promo credit (the
  //    store reverses them). On a check whose `total` is the bill (the till) that money is
  //    inside `amount`, so those tenders take their share first. On a check whose `total`
  //    is net of the credits (kiosk, online, reader closes) the refund amount never
  //    included them, so they go back ON TOP of it (`extra`).
  const extra = [];
  if (entry?.isFullRefund) {
    const credits = tenders.filter((x) => x.kind === 'gift_card' || x.kind === 'discount');
    let outside = Math.max(0, tenders.reduce((s0, x) => s0 + x.amount + x.tip, 0) - toMinor(row?.total));
    for (const t of credits) {
      const own = t.amount + t.tip;
      const beyond = Math.min(outside, own);
      if (beyond > 0) { extra.push({ method: t.method, kind: t.kind, processor: null, gross: beyond }); outside -= beyond; }
      if (own - beyond > 0 && left > 0) take(t.method, t.kind, null, Math.min(left, own - beyond));
    }
  }
  if (left > 0) {
    if (entry?.tenderMethod && tenderKind(method) === 'cash') {
      // 3. Staff chose cash: the rest was handed back from the drawer.
      take('cash', 'cash', null, left);
    } else {
      // 4. The rest goes to the check's remaining money tenders in proportion. Card legs,
      //    when the entry recorded any, already account for the card tenders; gift card and
      //    credit are only ever put back by a full refund (step 2).
      const usedKinds = new Set(slices.map((x) => x.kind));
      const pool = tenders.filter((t) => !(legs.length && t.kind === 'card') && !usedKinds.has(t.kind)
        && t.kind !== 'gift_card' && t.kind !== 'discount');
      const kind = tenderKind(method);
      if (pool.length) {
        const split = allocate(left, pool.map((t) => t.amount + t.tip || 1));
        pool.forEach((t, i) => take(t.method, t.kind, t.processor, split[i]));
        if (pool.some((t) => t.kind === 'unallocated')) flags.push('refund_unallocated');
      } else if (entry?.tenderMethod && tenders.some((t) => t.kind === kind) && MONEY_KINDS.has(kind) && kind !== 'unallocated') {
        take(method, kind, null, left);
      } else {
        take('unallocated', 'unallocated', null, left);
        flags.push('refund_unallocated');
      }
    }
  }

  // Spread service and tax over the slices in proportion to their money. Tips were taken
  // on cash and card, so they go back there (to credit or gift only when nothing else did).
  const w = slices.map((s) => s.gross);
  const tipW = slices.map((s) => (s.kind === 'gift_card' || s.kind === 'discount' ? 0 : s.gross));
  const tips = allocate(tip, tipW.some((x) => x > 0) ? tipW : w), svcs = allocate(service, w), taxes = allocate(tax, w);
  const parts = slices.map((s, i) => ({ ...s, tip: tips[i], service: svcs[i], tax: taxes[i], sales: s.gross - tips[i] - svcs[i] }));
  // Credit put back beyond the refund amount: goods, with the check's own tax share.
  if (extra.length) {
    const paidAll = Math.max(1, tenders.reduce((s0, x) => s0 + x.amount, 0));
    const checkTax = checkTaxMinor(row);
    for (const e of extra) {
      const tx = Math.min(e.gross, Math.round((checkTax * e.gross) / paidAll));
      parts.push({ ...e, tip: 0, service: 0, tax: tx, sales: e.gross });
      amount += e.gross;
    }
  }
  if (!taxCtx) return { atMs, amount, parts, flags, skipped: false };
  // 28 Sep 2026: goods and tax given back split by the check's own tax rates, pro rata (the
  // same rule refundMath uses for UK VAT), the credit put back on top included.
  const money = checkMoney(row, tenders);
  const rw = checkRateWeights(row, taxCtx, money.billTotal - money.service, money.tax);
  for (const p of parts) p.byRate = splitByRate(p.sales, p.tax, rw.weights);
  flags.push(...rw.flags);
  return { atMs, amount, parts, flags, skipped: false, buckets: rw.weights.map((x) => x.bucket), rateSource: rw.source };
}

// ── the day ──────────────────────────────────────────────────────────────────

const WARN_TEXT = {
  legacy_split_unallocated: 'Split bills closed before tender recording started. Their money is posted to Unallocated; move it to the right accounts in your books.',
  tenders_short_of_total: 'Checks whose recorded tenders come to less than the check total (for example a gift card that no longer had enough balance). The tenders are posted as taken.',
  legacy_mixed_unallocated: 'Older checks paid partly by loyalty or promo credit, recorded before tender recording started. Their money is posted to Unallocated; move it to the right accounts in your books.',
  refund_failed: 'Refunds that failed at the card processor. They are not posted.',
  refund_pending: 'Refunds whose card result was never saved (the till stopped part way through). They are not posted: check them against your card processor.',
  refund_partly_failed: 'Refunds where some card reversals failed. Only the money that went back is posted.',
  refund_split_estimated: 'Refunds with no tip or service breakdown (for example made in the processor dashboard). Their tip and service share is estimated from the check.',
  refund_unallocated: 'Refunds we could not place on a tender. They are posted to Unallocated.',
  refund_no_time: 'Refunds with no time recorded. They are dated by the check close time.',
  voided_checks: 'Cancelled checks left out of the day.',
  tax_split_estimated: 'Checks with no VAT breakdown saved (kiosk, online, QR and catering orders). Their VAT is taken to be at the venue default rate and the rest of the sale zero rated.',
  tax_not_recorded: 'Checks with no VAT amount recorded. The day is not posted to Xero until the VAT is filled in on each of them (the Back Office item rules). Nothing posts at VAT 0.',
  tax_breakdown_mismatch: 'Checks whose saved VAT breakdown does not add up to the VAT recorded on the check. The breakdown is still used to split the sale by rate.',
  tax_no_rates: 'Checks with no VAT breakdown at a venue with no default tax rate. They post at the Xero rate chosen for "Sales with no VAT breakdown" under Account mapping, as before.',
};

const MAX_IDS = 25;

function blankTotals() { return { count: 0, gross: 0, tip: 0, service: 0, tax: 0, sales: 0 }; }
function addRates(t, p) {
  if (!t.byRate || !p.byRate) return;
  for (const [k, v] of Object.entries(p.byRate)) {
    const e = t.byRate[k] || (t.byRate[k] = { sales: 0, tax: 0 });
    e.sales += v.sales; e.tax += v.tax;
  }
}
function addTo(t, p) { t.gross += p.gross; t.tip += p.tip; t.service += p.service; t.tax += p.tax; t.sales += p.sales; addRates(t, p); }

/**
 * Build one business day.
 *   day         { ymd, fromMs, toMs } from businessDayWindow()
 *   saleRows    closed_checks rows that CLOSED inside the window
 *   refundRows  closed_checks rows with any refunds, closed before the window ended
 *   venue       { timezone, dayStart } for placing refunds on their own day
 *   taxRates    the venue's tax_rates rows (28 Sep 2026); null leaves every figure unsplit
 * Returns { date, fromIso, toIso, sales:{totals, credits, byMethod[]}, refunds:{...same},
 * warnings[], empty } — every figure in minor units. `totals` is money only; `credits` sums the
 * loyalty and promo rows (discounts, never takings). byMethod rows are
 * { method, kind, processor, count, gross, tip, service, tax, sales }. Given taxRates, rows
 * and totals also carry byRate { [bucket key]: { sales, tax } }, and the day `taxBuckets`
 * (every bucket used, in posting order) and `defaultTaxBucket` (the venue default rate's).
 * A rate bucket only checks with no saved breakdown fed is marked `estimated`: the Xero plan
 * posts it at the default rate, as before, when it has no Xero match, instead of refusing
 * the day on a guess.
 */
/**
 * @param {{ day: { ymd: string, fromMs: number, toMs: number }, saleRows?: any[], refundRows?: any[], venue?: { timezone?: string, dayStart?: string }, taxRates?: any[] | null }} args
 * @returns {any}
 */
export function buildAccountingDay({ day, saleRows = [], refundRows = [], venue = {}, taxRates = null }) {
  const warn = new Map();
  const flag = (code, id) => {
    const w = warn.get(code) || { code, message: WARN_TEXT[code] || code, count: 0, checkIds: [] };
    w.count += 1;
    if (id && w.checkIds.length < MAX_IDS && !w.checkIds.includes(id)) w.checkIds.push(id);
    warn.set(code, w);
  };
  // The method as the till wrote it stays apart, so an older mapping keyed by it still applies.
  const keyOf = (p) => `${p.method}|${p.processor || ''}|${p.rawMethod || ''}`;
  const taxCtx = Array.isArray(taxRates) ? taxContext(taxRates) : null;
  const buckets = new Map();
  const fromBreakdown = new Set();   // bucket keys a saved tax_breakdown fed (real, not estimated)
  const noteBuckets = (list, source) => (list || []).forEach((b) => {
    if (!buckets.has(b.key)) buckets.set(b.key, b);
    if (source === 'breakdown') fromBreakdown.add(b.key);
  });
  const blank = () => (taxCtx ? { ...blankTotals(), byRate: {} } : blankTotals());

  const sales = { totals: blank(), credits: blank(), byMethod: new Map() };
  const seen = new Set();
  for (const row of saleRows) {
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    const at = Date.parse(row.closed_at);
    if (!(at >= day.fromMs && at < day.toMs)) continue;
    if (isVoidedCheck(row)) { flag('voided_checks', row.id); continue; }
    const { parts, flags, buckets: used, rateSource } = checkTenderParts(row, taxCtx);
    flags.forEach((f) => flag(f, row.id));
    noteBuckets(used, rateSource);
    sales.totals.count += 1;
    for (const p of parts) {
      if (!p.gross && !p.amount) continue;
      const k = keyOf(p);
      const g = sales.byMethod.get(k) || { method: p.method, kind: p.kind, processor: p.processor || null, rawMethods: [], ...blank() };
      g.count += 1; addTo(g, p); addTo(MONEY_KINDS.has(p.kind) ? sales.totals : sales.credits, p);
      if (p.rawMethod && !g.rawMethods.includes(p.rawMethod)) g.rawMethods.push(p.rawMethod);
      sales.byMethod.set(k, g);
    }
  }

  const refunds = { totals: blank(), credits: blank(), byMethod: new Map() };
  const seenRefund = new Set();
  for (const row of refundRows) {
    if (!row || isVoidedCheck(row)) continue;
    const list = Array.isArray(row.refunds) ? row.refunds : [];
    list.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object') return;
      const rid = `${row.id}:${entry.id || i}`;
      if (seenRefund.has(rid)) return;
      seenRefund.add(rid);
      const r = refundParts(entry, row, taxCtx);
      let at = r.atMs;
      if (at == null) { at = Date.parse(row.closed_at); if (Number.isFinite(at) && at >= day.fromMs && at < day.toMs) flag('refund_no_time', row.id); }
      if (!(at >= day.fromMs && at < day.toMs)) return;
      r.flags.forEach((f) => flag(f, row.id));
      if (r.skipped) return;
      noteBuckets(r.buckets, r.rateSource);
      refunds.totals.count += 1;
      for (const p of r.parts) {
        if (!p.gross) continue;
        const k = keyOf(p);
        const g = refunds.byMethod.get(k) || { method: p.method, kind: p.kind, processor: p.processor || null, rawMethods: [], ...blank() };
        g.count += 1; addTo(g, p); addTo(MONEY_KINDS.has(p.kind) ? refunds.totals : refunds.credits, p);
        refunds.byMethod.set(k, g);
      }
    });
  }

  const sortRows = (m) => [...m.values()].sort((a, b) => TENDER_KINDS.indexOf(a.kind) - TENDER_KINDS.indexOf(b.kind) || a.method.localeCompare(b.method));
  /** @type {any} */
  const out = {
    date: day.ymd,
    fromIso: new Date(day.fromMs).toISOString(),
    toIso: new Date(day.toMs).toISOString(),
    timezone: venue.timezone || null,
    dayStart: venue.dayStart || null,
    sales: { totals: sales.totals, credits: sales.credits, byMethod: sortRows(sales.byMethod) },
    refunds: { totals: refunds.totals, credits: refunds.credits, byMethod: sortRows(refunds.byMethod) },
    warnings: [...warn.values()],
  };
  const money = (g) => g.gross && MONEY_KINDS.has(g.kind);
  out.empty = !out.sales.byMethod.some(money) && !out.refunds.byMethod.some(money);
  // 8 Oct 2026: what stops the day posting. A sale with no VAT recorded at a venue with rates
  // is never posted at VAT 0 (plan Fix 4). The Xero plans copy each hold into `blocked`.
  out.holds = [];
  const notRecorded = warn.get('tax_not_recorded');
  if (notRecorded && taxCtx && taxCtx.known && taxCtx.rates.length) {
    const refs = saleRows.filter((r) => r && notRecorded.checkIds.includes(r.id)).map((r) => r.ref || r.id);
    const more = notRecorded.count > refs.length ? ` and ${notRecorded.count - refs.length} more` : '';
    out.holds.push({
      code: 'vat_not_recorded', count: notRecorded.count, checkIds: notRecorded.checkIds,
      message: `${notRecorded.count === 1 ? '1 sale has' : `${notRecorded.count} sales have`} no VAT recorded: ${refs.join(', ')}${more}. The day is not posted until the VAT is filled in on each sale. Nothing was posted.`,
    });
  }
  if (taxCtx) {
    const list = [...buckets.values()].sort(compareTaxBuckets)
      .map((b) => (b.mode === 'inclusive' && !fromBreakdown.has(b.key) ? { ...b, estimated: true } : b));
    const rank = new Map(list.map((b, i) => [b.key, i]));
    // byRate keys in posting order, so the summary reads the same whatever order rows came in.
    const tidy = (t) => { t.byRate = Object.fromEntries(Object.entries(t.byRate).sort(([a], [b]) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9) || a.localeCompare(b))); };
    for (const side of [out.sales, out.refunds]) { tidy(side.totals); tidy(side.credits); side.byMethod.forEach(tidy); }
    out.taxBuckets = list;
    const def = taxCtx.defaultRate;
    out.defaultTaxBucket = taxCtx.addedOn ? EXCL_TAX_BUCKET : !def ? DEFAULT_TAX_BUCKET : rateBucket(def);
  }
  return out;
}
