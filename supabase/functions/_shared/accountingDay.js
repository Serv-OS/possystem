// supabase/functions/_shared/accountingDay.js
//
// THE NEUTRAL DAILY ACCOUNTING AGGREGATOR. One venue, one business day, summed per tender:
// what came in (sales) and what went back out (refunds), each split into goods, tax, tip and
// service. It knows nothing about Xero or QuickBooks; xero-sales turns the summary into Xero
// bank transactions (_shared/xeroPostingPlan.js) and a QuickBooks integration can turn the
// same summary into a journal entry. Pure JS with no imports, so `npm test`
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

// ── money ────────────────────────────────────────────────────────────────────

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

/**
 * Split one check's service and tax across its tenders in proportion to the bill money each
 * took, so a split check's service charge and VAT land with the tenders that paid them.
 * Returns per tender { ...tender, gross, service, tax, sales } where gross = amount + tip and
 * sales = amount - service (goods, tax included).
 */
export function checkTenderParts(row) {
  const { tenders, legacy, flags } = checkTenders(row);
  const amounts = tenders.map((t) => t.amount);
  const billTotal = amounts.reduce((a, b) => a + b, 0);
  const service = Math.min(Math.max(0, toMinor(row?.service)), billTotal);
  const tax = Math.min(checkTaxMinor(row), Math.max(0, billTotal - service));
  const svc = allocate(service, amounts);
  const tx = allocate(tax, amounts);
  return {
    legacy,
    flags,
    parts: tenders.map((t, i) => ({ ...t, gross: t.amount + t.tip, service: svc[i], tax: tx[i], sales: t.amount - svc[i] })),
  };
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
export function refundParts(entry, row) {
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
  let tax = entry?.taxAmount != null && entry.taxAmount !== ''
    ? Math.max(0, toMinor(entry.taxAmount))
    : Math.round((checkTaxMinor(row) * amount) / total);
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
  return { atMs, amount, parts, flags, skipped: false };
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
};

const MAX_IDS = 25;

function blankTotals() { return { count: 0, gross: 0, tip: 0, service: 0, tax: 0, sales: 0 }; }
function addTo(t, p) { t.gross += p.gross; t.tip += p.tip; t.service += p.service; t.tax += p.tax; t.sales += p.sales; }

/**
 * Build one business day.
 *   day         { ymd, fromMs, toMs } from businessDayWindow()
 *   saleRows    closed_checks rows that CLOSED inside the window
 *   refundRows  closed_checks rows with any refunds, closed before the window ended
 *   venue       { timezone, dayStart } for placing refunds on their own day
 * Returns { date, fromIso, toIso, sales:{totals, credits, byMethod[]}, refunds:{...same},
 * warnings[], empty } — every figure in minor units. `totals` is money only; `credits` sums the
 * loyalty and promo rows (discounts, never takings). byMethod rows are
 * { method, kind, processor, count, gross, tip, service, tax, sales }.
 */
/**
 * @param {{ day: { ymd: string, fromMs: number, toMs: number }, saleRows?: any[], refundRows?: any[], venue?: { timezone?: string, dayStart?: string } }} args
 * @returns {any}
 */
export function buildAccountingDay({ day, saleRows = [], refundRows = [], venue = {} }) {
  const warn = new Map();
  const flag = (code, id) => {
    const w = warn.get(code) || { code, message: WARN_TEXT[code] || code, count: 0, checkIds: [] };
    w.count += 1;
    if (id && w.checkIds.length < MAX_IDS && !w.checkIds.includes(id)) w.checkIds.push(id);
    warn.set(code, w);
  };
  // The method as the till wrote it stays apart, so an older mapping keyed by it still applies.
  const keyOf = (p) => `${p.method}|${p.processor || ''}|${p.rawMethod || ''}`;

  const sales = { totals: blankTotals(), credits: blankTotals(), byMethod: new Map() };
  const seen = new Set();
  for (const row of saleRows) {
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    const at = Date.parse(row.closed_at);
    if (!(at >= day.fromMs && at < day.toMs)) continue;
    if (isVoidedCheck(row)) { flag('voided_checks', row.id); continue; }
    const { parts, flags } = checkTenderParts(row);
    flags.forEach((f) => flag(f, row.id));
    sales.totals.count += 1;
    for (const p of parts) {
      if (!p.gross && !p.amount) continue;
      const k = keyOf(p);
      const g = sales.byMethod.get(k) || { method: p.method, kind: p.kind, processor: p.processor || null, rawMethods: [], ...blankTotals() };
      g.count += 1; addTo(g, p); addTo(MONEY_KINDS.has(p.kind) ? sales.totals : sales.credits, p);
      if (p.rawMethod && !g.rawMethods.includes(p.rawMethod)) g.rawMethods.push(p.rawMethod);
      sales.byMethod.set(k, g);
    }
  }

  const refunds = { totals: blankTotals(), credits: blankTotals(), byMethod: new Map() };
  const seenRefund = new Set();
  for (const row of refundRows) {
    if (!row || isVoidedCheck(row)) continue;
    const list = Array.isArray(row.refunds) ? row.refunds : [];
    list.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object') return;
      const rid = `${row.id}:${entry.id || i}`;
      if (seenRefund.has(rid)) return;
      seenRefund.add(rid);
      const r = refundParts(entry, row);
      let at = r.atMs;
      if (at == null) { at = Date.parse(row.closed_at); if (Number.isFinite(at) && at >= day.fromMs && at < day.toMs) flag('refund_no_time', row.id); }
      if (!(at >= day.fromMs && at < day.toMs)) return;
      r.flags.forEach((f) => flag(f, row.id));
      if (r.skipped) return;
      refunds.totals.count += 1;
      for (const p of r.parts) {
        if (!p.gross) continue;
        const k = keyOf(p);
        const g = refunds.byMethod.get(k) || { method: p.method, kind: p.kind, processor: p.processor || null, rawMethods: [], ...blankTotals() };
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
  return out;
}
