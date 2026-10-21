/**
 * stock/packPrice.js: prices and costs in the pack people use ("£1.38 a bottle", "£0.31 each"),
 * never pence per ml (multi site stock Drop 1, design B20).
 *
 * The database answers money per BASE unit (unit_price, unit_cost, current_cost, last paid
 * unit_cost). These helpers turn one of those into the pack staff count in: the item's count
 * default pack, or the base unit when it has no pack.
 *
 *   packAmount(unitPrice, pack)           unitPrice x pack.qty_in_base (null when either is missing)
 *   packPrice(unitPrice, pack, currency)  '£1.38 a bottle', '£0.31 each', '£6.20 an egg tray', ''
 *   packLabel(pack, baseUnit)             the unit people count in, in words: 'bottle', 'ml'
 *   packWordFor(qty, pack, baseUnit)      that word for a number of them: 'bottle', 'bottles', 'ml'
 *   packQtyWords(qty, pack, baseUnit)     '31 bottles', '1 bottle', '500 ml', '3 each'
 *   countPackOf(detailOrRow)              the count pack, or { name: baseUnit, qty_in_base: 1 }
 *
 * Pure (no browser, no database): packPrice.test.js drives it. Only the company Stock items
 * screens use it. One site companies keep today's per base unit figures (StockItemsSplit).
 */

import { currencySymbol } from '../currency.js';
import { isKnownUnit, normUnit } from './units.js';

const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/** The size of one pack in base units (accepts the database name or the screen name). */
function qtyOf(pack) {
  if (!pack) return null;
  const q = num(pack.qty_in_base ?? pack.qtyInBase);
  return q != null && q > 0 ? q : null;
}

/** unitPrice (per base unit) x the pack size in base units. Null when either is missing. */
export function packAmount(unitPrice, pack) {
  const u = num(unitPrice);
  const q = qtyOf(pack);
  if (u == null || q == null) return null;
  return Math.round(u * q * 1e6) / 1e6;
}

/**
 * Money with enough places to be true: 2 places normally ('£1.38'), up to 4 for a very small
 * amount ('£0.0007'), so a base unit cost never reads '£0.00'.
 */
export function moneyText(amount, currency) {
  const a = num(amount);
  if (a == null) return '';
  const sym = currencySymbol(currency);
  const abs = Math.abs(a);
  let body;
  if (abs === 0 || abs >= 0.1) body = abs.toFixed(2);
  else {
    body = abs.toFixed(4).replace(/0+$/, '');
    if (/\.\d$/.test(body)) body += '0';
  }
  return `${a < 0 ? '-' : ''}${sym}${body}`;
}

/** 'Bottle' reads 'bottle'; 'BBQ pack' and '2L bottle' stay as typed. */
function lowerFirst(name) {
  const s = String(name || '').trim();
  if (s.length > 1 && /[A-Z]/.test(s[0]) && /[a-z]/.test(s[1])) return s[0].toLowerCase() + s.slice(1);
  return s;
}

/** 'a' or 'an': 'an' before a vowel ('an egg tray'), 'a' for the words that sound like 'you' or 'won'. */
function article(word) {
  const w = String(word || '').toLowerCase();
  if (/^(uni|use|usu|eu|one)/.test(w)) return 'a';
  return /^[aeiou]/.test(w) ? 'an' : 'a';
}

const isEach = (name) => normUnit(name) === 'each';

/** The unit people count in, in words: the pack name ('bottle'), or the base unit ('ml'). */
export function packLabel(pack, baseUnit) {
  const name = String(pack?.name || '').trim();
  if (!name) return baseUnit || '';
  if (isEach(name)) return 'each';
  if (isKnownUnit(name)) return normUnit(name);
  return lowerFirst(name);
}

/** 'bottle' to 'bottles', 'glass' to 'glasses', 'berry' to 'berries'; a name ending in a number stays. */
function plural(word) {
  const w = String(word || '');
  if (!w || /\d\)?$/.test(w)) return w;
  if (/(s|x|z|ch|sh)$/i.test(w)) return `${w}es`;
  if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}

/**
 * The word for `qty` of the pack people count in: 'bottle' (1), 'bottles' (0, 2, 2.5), 'ml' and
 * the other units as they are, 'each' for an item counted each.
 */
export function packWordFor(qty, pack, baseUnit) {
  const word = packLabel(pack, baseUnit);
  if (!word || word === 'each' || isKnownUnit(word)) return word;
  const n = num(qty);
  return n != null && Math.abs(n) === 1 ? word : plural(word);
}

/**
 * A quantity in the pack people count in, in words: '31 bottles', '1 bottle', '500 ml', '3 each'
 * (qty is already in that pack: base units / pack.qty_in_base). '' when there is no number.
 */
export function packQtyWords(qty, pack, baseUnit) {
  const n = num(qty);
  if (n == null) return '';
  const q = String(Math.round(n * 1000) / 1000);
  const word = packWordFor(n, pack, baseUnit);
  return word ? `${q} ${word}` : q;
}

/**
 * The price of one pack in words: '£1.38 a bottle', '£0.31 each' (the pack is 'Each', or one of
 * an item counted each), '£0.0007 per ml' (no pack: the base unit), '' when there is no price.
 */
export function packPrice(unitPrice, pack, currency) {
  const amount = packAmount(unitPrice, pack);
  if (amount == null) return '';
  const money = moneyText(amount, currency);
  const name = String(pack?.name || '').trim();
  if (!name || isEach(name)) return `${money} each`;
  if (isKnownUnit(name)) return `${money} per ${normUnit(name)}`;
  const word = lowerFirst(name);
  return `${money} ${article(word)} ${word}`;
}

/**
 * The pack people count in for an item: the read's count_pack, else the live count default pack,
 * else the base unit itself ({ name: baseUnit, qty_in_base: 1 }). Takes a stock_item_detail answer
 * ({ item, count_pack, packs }) or a stock_items_page row ({ base_unit, count_pack }).
 */
export function countPackOf(detailOrRow) {
  const d = detailOrRow || {};
  const cp = d.count_pack || d.countPack || null;
  if (cp && qtyOf(cp) != null && String(cp.name || '').trim()) {
    return { id: cp.id ?? null, name: String(cp.name).trim(), qty_in_base: qtyOf(cp) };
  }
  const packs = Array.isArray(d.packs) ? d.packs : [];
  const p = packs.find((x) => x && !x.archived_at && (x.is_count_default || x.isCountDefault) && qtyOf(x) != null);
  if (p) return { id: p.id ?? null, name: String(p.name || '').trim(), qty_in_base: qtyOf(p) };
  const base = d.item?.base_unit || d.base_unit || d.baseUnit || 'each';
  return { id: null, name: base, qty_in_base: 1 };
}
