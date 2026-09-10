/**
 * rateCard.js: the venue rate card editor's pure helpers, shared by the
 * Processing page and the go live flow (RateCardRows, 10 Sep 2026). No
 * network, no React.
 *
 * WHY (owner rule, 10 Sep 2026): "we set the rate that customers get charged
 * for the different card types". The four payment types are priced with a
 * percent and pence each, stored as jsonb { tier: { percent, fixed_pence } }
 * on merchant_adyen_accounts.rate_card (venue) and
 * platform_settings.default_adyen_rate_card (platform default). The editor
 * keeps every field as a string ('' for empty) so inputs stay controlled,
 * and these helpers turn that state into the jsonb and back.
 */

// The four payment types, in the order every screen lists them. Plain words,
// no dashes: In person, Online, Amex and business cards, Keyed in.
export const RATE_CARD_TIERS = Object.freeze([
  Object.freeze({ id: 'card_present', label: 'In person', note: 'credit and debit' }),
  Object.freeze({ id: 'card_not_present', label: 'Online', note: 'online orders' }),
  Object.freeze({ id: 'amex', label: 'Amex and business cards', note: null }),
  Object.freeze({ id: 'keyed', label: 'Keyed in', note: 'typed by hand' }),
]);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const empty = (v) => v === null || v === undefined || v === '';

// The editor state with nothing typed.
export const emptyCard = () => Object.fromEntries(RATE_CARD_TIERS.map((t) => [t.id, { percent: '', fixed_pence: '' }]));

// jsonb rate card → editor state ('' for null so inputs stay controlled).
// Either spelling of the pence is read (fixed_pence on the row, fixedPence
// as the flow carries it).
export function cardToState(card) {
  const st = emptyCard();
  if (!isObj(card)) return st;
  for (const t of RATE_CARD_TIERS) {
    const row = card[t.id];
    if (!isObj(row)) continue;
    const fixed = row.fixed_pence ?? row.fixedPence;
    st[t.id] = {
      percent: empty(row.percent) ? '' : String(row.percent),
      fixed_pence: empty(fixed) ? '' : String(fixed),
    };
  }
  return st;
}

// editor state → jsonb rate card ('' → null; the server sanitizes again).
export function stateToCard(st) {
  const s = isObj(st) ? st : {};
  return Object.fromEntries(RATE_CARD_TIERS.map((t) => {
    const row = isObj(s[t.id]) ? s[t.id] : {};
    const pct = empty(row.percent) ? null : Number(row.percent);
    const fix = empty(row.fixed_pence) ? null : Math.round(Number(row.fixed_pence));
    return [t.id, {
      percent: Number.isFinite(pct) ? pct : null,
      fixed_pence: Number.isFinite(fix) ? fix : null,
    }];
  }));
}

// Two editor states say the same card.
export const cardsEqual = (a, b) => JSON.stringify(stateToCard(a)) === JSON.stringify(stateToCard(b));

// A rate for a read only line: "1.40% + 5p", "1.40% + 5c" for a US venue,
// "Not set" when there is nothing.
export function fmtRate(pct, pence, currency) {
  if (empty(pct) && empty(pence)) return 'Not set';
  const minor = String(currency ?? '').toUpperCase() === 'USD' ? 'c' : 'p';
  return `${Number(pct ?? 0).toFixed(2)}% + ${Math.round(Number(pence ?? 0))}${minor}`;
}

// Is any field of the editor state typed (a venue override rather than the
// platform default)?
export function cardHasOverride(st) {
  const s = isObj(st) ? st : {};
  return RATE_CARD_TIERS.some((t) => {
    const row = isObj(s[t.id]) ? s[t.id] : {};
    return !empty(row.percent) || !empty(row.fixed_pence);
  });
}
