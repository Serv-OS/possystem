// supabase/functions/_shared/lightspeedSuggest.js
//
// "COPY MY LIGHTSPEED SETUP" (30 Sep 2026). Coffee Boy's Xero already holds Lightspeed's daily
// sales invoices, with the accounts, the Location tracking category and the payment accounts
// the accountant set up. xero-config reads the most recent of them (read only) and this file
// turns what Lightspeed used into suggestions for the site's ServOS mapping. Nothing is saved:
// the Back Office lists each suggestion with a tick box and the person saves.
//
// Pure JS, no imports, so `npm test` loads exactly what ships.
//
// Lightspeed posts either APPROVED invoices (payments applied as Xero payments) or DRAFT style
// "$0 invoices with payments appearing as line items" (negative lines on payment accounts);
// both are read.
//
// Site safety (30 Sep 2026 review): payment (clearing) accounts are per site, so they are only
// suggested from invoices that carry THIS site's tracking option. When no option clearly names
// the site, the person chooses it and the invoices are read again; until then no payment
// account is suggested. Categories go to a sales group only on an exact name match, and each
// pair is listed so it can be checked.

const lc = (s) => String(s ?? '').toLowerCase();
const words = (s) => lc(s).split(/[^a-z0-9]+/).filter(Boolean);
const toMinor = (v) => Math.round((Number(v) || 0) * 100);

/** A Xero date ("/Date(1759104000000+0000)/" or "2026-09-29T00:00:00") as YYYY-MM-DD, or null. */
export function xeroDate(v) {
  const s = String(v ?? '');
  const m = /\/Date\((-?\d+)/.exec(s);
  if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
  const d = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return d ? d[1] : null;
}

const refOf = (a) => (a ? (a.Code || a.AccountID || null) : null);

/** What a line is, from its description, amount and account. */
export function classifyLine(line, account) {
  const d = lc(line?.Description);
  const amount = toMinor(line?.LineAmount ?? (Number(line?.UnitAmount || 0) * Number(line?.Quantity ?? 1)));
  const payAcct = account && (String(account.Type || '').toUpperCase() === 'BANK' || account.EnablePaymentsToAccount === true);
  if (/rounding|over\s*\/?\s*short|variance|discrepan/.test(d)) return 'unmatched';
  if (amount < 0 && payAcct) return 'payment';
  if (/\btips?\b|gratuit/.test(d)) return 'tip';
  if (/service\s*charge/.test(d)) return 'service';
  if (/gift|voucher/.test(d) && amount >= 0) return 'gift';
  if (amount < 0 || /discount|promo|\bcomp\b|complimentary|staff|loyal|reward/.test(d)) return 'discount';
  return 'sales';
}

/** A sales group name from a Lightspeed line: dates, numbers and tax words taken out. */
export function groupNameOf(description) {
  let s = String(description ?? '');
  s = s.replace(/\b\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\b/g, ' ')
    .replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/gi, ' ')
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi, ' ')
    .replace(/\(?\b\d+(\.\d+)?\s*%\)?/g, ' ')
    .replace(/\b(vat|tax|inc|incl|excl?|zero\s*rated|standard|reduced|rate|sales|lightspeed|total)\b/gi, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(/[-:|()[\]]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

const keyOf = (text) => lc(text).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');

function discountGroupOf(text) {
  const s = lc(text);
  if (/staff|employee|team/.test(s)) return 'staff';
  if (/\bcomp\b|complimentary|waste|100\s*%/.test(s)) return 'comp';
  if (/loyal|reward|stamp|points/.test(s)) return 'loyalty';
  if (/promo|code|voucher|coupon/.test(s)) return 'promo';
  return 'customer';
}

/** Which ServOS money kind a payment account or reference reads as, or null. */
export function paymentKindOf(text) {
  const s = lc(text);
  if (/deliveroo/.test(s)) return 'other:deliveroo';
  if (/uber/.test(s)) return 'other:uber_eats';
  if (/just\s*eat/.test(s)) return 'other:just_eat';
  if (/gift|voucher/.test(s)) return 'gift_card';
  if (/cash|till|float/.test(s)) return 'cash';
  if (/card|visa|master|amex|adyen|credit|debit|contactless|lightspeed\s*pay|payments?\s*clearing|pdq|terminal/.test(s)) return 'card';
  return null;
}

const most = (counts) => {
  let best = null, n = -1;
  for (const [k, v] of counts) if (v > n || (v === n && String(k) < String(best))) { best = k; n = v; }
  return best;
};

/**
 * The site's tracking option: the tracking category Lightspeed used most, and the option whose
 * name matches the site name once the brand words shared with sibling sites are dropped. No
 * clear match, no suggestion (the options are listed).
 */
/**
 * @param {any[]} invoices
 * @param {any[]} trackingCategories
 * @param {string | undefined} siteName
 * @param {(string | undefined)[]} [siblingNames]
 * @param {{ optionId?: string | null, optionName?: string | null } | null} [option]
 * @returns {any}
 */
export function suggestTracking(invoices, trackingCategories, siteName, siblingNames = [], option = null) {
  const cats0 = Array.isArray(trackingCategories) ? trackingCategories : [];
  // The option the person chose for this site: its own category, whatever the invoices use most.
  if (option && (option.optionId || option.optionName)) {
    for (const c of cats0) {
      const o = (c.Options || []).find((x) => (option.optionId && x.TrackingOptionID === option.optionId) || (option.optionName && x.Name === option.optionName));
      if (!o) continue;
      const options = (c.Options || []).filter((x) => String(x.Status || 'ACTIVE').toUpperCase() === 'ACTIVE').map((x) => ({ id: x.TrackingOptionID, name: x.Name }));
      return { categoryId: c.TrackingCategoryID || null, categoryName: c.Name || null, optionId: o.TrackingOptionID || null, optionName: o.Name || null, confidence: 'chosen', options };
    }
  }
  const counts = new Map();
  for (const inv of invoices || []) for (const l of inv?.LineItems || []) for (const t of l?.Tracking || []) {
    const k = t.TrackingCategoryID || t.Name;
    if (k) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const cats = Array.isArray(trackingCategories) ? trackingCategories : [];
  let catKey = most(counts);
  let cat = cats.find((c) => c.TrackingCategoryID === catKey || c.Name === catKey) || null;
  if (!cat && cats.length === 1) cat = cats[0];
  if (!cat) cat = cats.find((c) => /location|site|store|venue|branch|outlet/i.test(c.Name || '')) || null;
  if (!cat) return { categoryId: null, categoryName: null, optionId: null, optionName: null, confidence: 'none', options: [] };
  const options = (cat.Options || []).filter((o) => String(o.Status || 'ACTIVE').toUpperCase() === 'ACTIVE').map((o) => ({ id: o.TrackingOptionID, name: o.Name }));
  const sibs = (siblingNames || []).map(words).filter((w) => w.length);
  const own = words(siteName);
  const brand = sibs.length ? own.filter((w) => sibs.every((s) => s.includes(w))) : [];
  const mine = own.filter((w) => !brand.includes(w));
  const scored = options.map((o) => {
    const ow = words(o.name);
    const hit = mine.filter((w) => ow.includes(w) || ow.some((x) => x.length >= 4 && (x.startsWith(w) || w.startsWith(x)))).length;
    return { o, hit };
  }).filter((x) => x.hit > 0).sort((a, b) => b.hit - a.hit);
  const clear = scored.length && (scored.length === 1 || scored[0].hit > scored[1].hit);
  const pick = clear ? scored[0].o : null;
  return {
    categoryId: cat.TrackingCategoryID || null, categoryName: cat.Name || null,
    optionId: pick?.id || null, optionName: pick?.name || null,
    confidence: pick ? 'high' : 'none', options,
  };
}

/**
 * Suggestions from Lightspeed's invoices. Arguments are Xero's own objects:
 *   invoices [{ InvoiceID, InvoiceNumber, Reference, Date, Contact, Status, LineItems:[{ Description, LineAmount,
 *             UnitAmount, Quantity, AccountCode, AccountID, TaxType, Tracking }] }]
 *   payments [{ Invoice:{ InvoiceID }, Account:{ AccountID, Code }, Amount, Reference, Status }]
 *   accounts [{ AccountID, Code, Name, Type, Class, EnablePaymentsToAccount, Status }]
 *   trackingCategories [{ TrackingCategoryID, Name, Status, Options:[{ TrackingOptionID, Name, Status }] }]
 *   site { name }, siblings [{ name }], categories [{ id, label }] (this venue's ServOS categories)
 *   option { optionId, optionName } this site's tracking option, when the person chose it
 */
/**
 * @param {{ invoices?: any[], payments?: any[], accounts?: any[], trackingCategories?: any[], site?: { name?: string }, siblings?: { name?: string }[], categories?: { id: string, label?: string }[], option?: { optionId?: string | null, optionName?: string | null } | null }} [args]
 * @returns {any}
 */
export function suggestFromLightspeed({ invoices = [], payments = [], accounts = [], trackingCategories = [], site = {}, siblings = [], categories = [], option = null } = {}) {
  const accs = Array.isArray(accounts) ? accounts : [];
  const byCode = new Map(accs.filter((a) => a.Code).map((a) => [String(a.Code).toUpperCase(), a]));
  const byId = new Map(accs.map((a) => [a.AccountID, a]));
  const accOf = (l) => (l?.AccountID && byId.get(l.AccountID)) || (l?.AccountCode && byCode.get(String(l.AccountCode).toUpperCase())) || null;
  const all = (Array.isArray(invoices) ? invoices : []).filter((i) => i && String(i.Status || '').toUpperCase() !== 'DELETED' && String(i.Status || '').toUpperCase() !== 'VOIDED');
  const tracking = suggestTracking(all, trackingCategories, site?.name, (siblings || []).map((s) => s?.name), option);
  const mineOnly = tracking.optionName
    ? all.filter((inv) => (inv.LineItems || []).some((l) => (l.Tracking || []).some((t) => t.Option === tracking.optionName || t.TrackingOptionID === tracking.optionId)))
    : all;
  const used = mineOnly.length ? mineOnly : all;
  // Only this site's own invoices say where ITS money goes.
  const siteOnly = !!(tracking.optionName && mineOnly.length);

  const groups = new Map();
  const discounts = new Map();
  const tips = new Map(), service = new Map(), gift = new Map();
  const clearing = new Map();   // kind -> Map(account ref -> amount)
  const unmatched = [];
  const tally = (map, ref, amt) => { if (ref) map.set(ref, (map.get(ref) || 0) + Math.abs(amt)); };
  const addClearing = (kind, ref, amt) => {
    if (!kind || !ref) return false;
    const m = clearing.get(kind) || new Map();
    m.set(ref, (m.get(ref) || 0) + Math.abs(amt));
    clearing.set(kind, m);
    return true;
  };
  for (const inv of used) {
    for (const l of inv.LineItems || []) {
      const a = accOf(l);
      const ref = refOf(a) || l.AccountCode || l.AccountID || null;
      const amt = toMinor(l.LineAmount ?? (Number(l.UnitAmount || 0) * Number(l.Quantity ?? 1)));
      const kind = classifyLine(l, a);
      if (kind === 'payment') {
        const pk = paymentKindOf(`${l.Description || ''} ${a?.Name || ''}`);
        if (!addClearing(pk, ref, amt)) unmatched.push({ description: l.Description || '', account: ref, amount: amt / 100 });
      } else if (kind === 'tip') tally(tips, ref, amt);
      else if (kind === 'service') tally(service, ref, amt);
      else if (kind === 'gift') tally(gift, ref, amt);
      else if (kind === 'discount') {
        const dg = discountGroupOf(l.Description);
        const m = discounts.get(dg) || new Map();
        tally(m, ref, amt);
        discounts.set(dg, m);
      } else if (kind === 'unmatched') unmatched.push({ description: l.Description || '', account: ref, amount: amt / 100 });
      else {
        const name = groupNameOf(l.Description) || (a?.Name || 'Sales');
        const key = keyOf(name) || 'sales';
        const g = groups.get(key) || { key, name, accounts: new Map(), taxTypes: new Set(), lines: 0, amount: 0 };
        g.accounts.set(ref, (g.accounts.get(ref) || 0) + 1);
        if (l.TaxType) g.taxTypes.add(l.TaxType);
        g.lines += 1; g.amount += amt;
        groups.set(key, g);
      }
    }
  }
  // Approved invoices: the payments applied to them.
  const ids = new Set(used.map((i) => i.InvoiceID).filter(Boolean));
  for (const p of Array.isArray(payments) ? payments : []) {
    if (!p || !ids.has(p?.Invoice?.InvoiceID) || String(p.Status || 'AUTHORISED').toUpperCase() === 'DELETED') continue;
    const a = (p.Account?.AccountID && byId.get(p.Account.AccountID)) || (p.Account?.Code && byCode.get(String(p.Account.Code).toUpperCase())) || null;
    const ref = refOf(a) || p.Account?.Code || p.Account?.AccountID || null;
    const pk = paymentKindOf(`${p.Reference || ''} ${a?.Name || ''}`);
    if (!addClearing(pk, ref, toMinor(p.Amount))) unmatched.push({ description: `Payment ${p.Reference || ''}`.trim(), account: ref, amount: Number(p.Amount) || 0 });
  }

  const top = (map) => (map && map.size ? most(map) : null);
  const groupList = [...groups.values()].sort((a, b) => b.amount - a.amount || a.key.localeCompare(b.key))
    .map((g) => ({ key: g.key, name: g.name, account: most(g.accounts), taxTypes: [...g.taxTypes].sort(), lines: g.lines, amount: g.amount / 100 }));
  const discountAccounts = {};
  for (const [dg, m] of discounts) discountAccounts[dg] = top(m);
  const clearingOut = {};
  if (siteOnly) for (const [k, m] of clearing) clearingOut[k] = top(m);

  // ServOS categories to groups: exact name matches only ("Coffee Beans" is not "Coffee"), each
  // pair listed for the person to check.
  const norm = (s) => words(s).join(' ');
  const categoryGroups = {};
  const categoryPairs = [];
  for (const c of Array.isArray(categories) ? categories : []) {
    const label = norm(c?.label);
    if (!label || label.length < 3) continue;
    const g = groupList.find((x) => norm(x.name) === label);
    if (!g) continue;
    categoryGroups[c.id] = g.key;
    categoryPairs.push({ id: c.id, label: c.label, group: g.key, groupName: g.name });
  }

  const dates = used.map((i) => xeroDate(i.DateString || i.Date)).filter(Boolean).sort();
  return {
    source: {
      contacts: [...new Set(used.map((i) => i.Contact?.Name).filter(Boolean))],
      count: used.length,
      from: dates[0] || null,
      to: dates[dates.length - 1] || null,
      numbers: used.map((i) => i.InvoiceNumber).filter(Boolean).slice(0, 12),
      siteOnly,
    },
    tracking,
    groups: groupList,
    discounts: { accounts: discountAccounts },
    tipsAccount: top(tips),
    serviceAccount: top(service),
    // The gift card liability is the company's (one for every site), so any site's will do.
    giftLiabilityAccount: top(gift) || top(clearing.get('gift_card')) || null,
    clearing: clearingOut,
    // Payment accounts seen, left out until the invoices are this site's own.
    clearingSkipped: !siteOnly && clearing.size > 0,
    categoryGroups,
    categoryPairs,
    lastLightspeedDate: dates[dates.length - 1] || null,
    unmatched: unmatched.slice(0, 20),
  };
}
