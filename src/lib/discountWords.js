// src/lib/discountWords.js
//
// v5.11.109: the automatic deal editor (Back Office, Discounts) says what a Buy X rule does in one
// plain sentence, live as the person types (Peter, 28 Oct 2026). The rules engine itself is
// lib/discountEngine.js; this file only words it. Pure, tested by discountWords.test.js.

/** "Donuts", "Donuts or Muffins", "Donuts, Muffins or Cakes", "any category". */
export function categoryNames(ids, categories) {
  const want = Array.isArray(ids) ? ids : [];
  const names = (categories || []).filter((c) => want.includes(c.id)).map((c) => String(c.label || c.name || '').trim()).filter(Boolean);
  if (!names.length) return 'any category';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

// "donuts" for one category, else "items from Donuts or Muffins", else "items".
function unitWords(ids, categories) {
  const want = Array.isArray(ids) ? ids : [];
  const cats = (categories || []).filter((c) => want.includes(c.id));
  if (cats.length === 1) return String(cats[0].label || cats[0].name || 'items').trim().toLowerCase();
  if (cats.length > 1) return `items from ${categoryNames(ids, categories)}`;
  return 'items';
}

const count = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** "10% off", "£1.50 off", "free". `each` adds "each" to an amount off more than one item. */
export function rewardWords(rule, sym = '£', { each = false } = {}) {
  const type = rule?.rewardType || 'percent';
  if (type === 'free') return 'free';
  const raw = rule?.rewardValue;
  const v = raw === '' || raw == null ? NaN : Number(raw);
  if (type === 'percent') return `${Number.isFinite(v) ? +v.toFixed(2) : '?'}% off`;
  return `${sym}${Number.isFinite(v) ? v.toFixed(2) : '?'} off${each ? ' each' : ''}`;
}

/**
 * The sentence for a Buy X get Y ('buy_x') or Buy X, discount the lot ('buy_x_all') rule.
 *   buy_x      "Customer buys 3 from Donuts at full price, then the next 1 from Donuts is 10% off.
 *               Needs 4 donuts in the basket."
 *   buy_x_all  "Customer buys 6 from Donuts and all 6 are 15% off. Needs 6 donuts in the basket.
 *               12 get it twice; with 7, the cheapest 6 get it."
 * rule: the editor's form (triggerType, triggerQty, rewardQty, rewardType, rewardValue,
 * triggerCategoryIds, rewardCategoryIds). sameRewardCats: the reward is on the trigger categories.
 */
export function ruleSentence(rule, categories, { sym = '£', sameRewardCats = true } = {}) {
  const x = count(rule?.triggerQty);
  const xs = x ?? '?';
  const from = categoryNames(rule?.triggerCategoryIds, categories);
  const units = unitWords(rule?.triggerCategoryIds, categories);
  if (rule?.triggerType === 'buy_x_all') {
    const off = rewardWords(rule, sym, { each: true });
    const all = x === 1 ? 'it is' : `all ${xs} are`;
    const more = x ? ` ${x * 2} get it twice; with ${x + 1}, the cheapest ${x} get it.` : '';
    return `Customer buys ${xs} from ${from} and ${all} ${off}. Needs ${xs} ${units} in the basket.${more}`;
  }
  const y = count(rule?.rewardQty);
  const ys = y ?? '?';
  const rewardIds = sameRewardCats || !(rule?.rewardCategoryIds || []).length ? rule?.triggerCategoryIds : rule.rewardCategoryIds;
  const to = categoryNames(rewardIds, categories);
  const verb = y === 1 ? 'is' : 'are';
  const off = rewardWords(rule, sym, { each: (y || 0) > 1 });
  const need = x && y ? x + y : '?';
  const needUnits = sameRewardCats || !(rule?.rewardCategoryIds || []).length ? units : 'items';
  return `Customer buys ${xs} from ${from} at full price, then the next ${ys} from ${to} ${verb} ${off}. Needs ${need} ${needUnits} in the basket.`;
}
