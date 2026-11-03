// src/lib/cashDenominations.js: the notes and coins a drawer is counted in, per venue currency (5.12.46).
// Pure, no imports, so node --test can load it.
//
// Before 5.12.46 the till's cash in, cash up, the Back Office cash drawers and End of day only knew
// UK notes and coins, so a US venue saw "£20 notes" and had no quarters, dimes or nickels. Each
// currency now has its own set. A count is saved as { "<value>": count } exactly as before, so old
// UK counts read the same.

const SETS = {
  GBP: [
    { value: 50, label: '£50 notes', short: '£50' },
    { value: 20, label: '£20 notes', short: '£20' },
    { value: 10, label: '£10 notes', short: '£10' },
    { value: 5, label: '£5 notes', short: '£5' },
    { value: 2, label: '£2 coins', short: '£2' },
    { value: 1, label: '£1 coins', short: '£1' },
    { value: 0.5, label: '50p coins', short: '50p' },
    { value: 0.2, label: '20p coins', short: '20p' },
    { value: 0.1, label: '10p coins', short: '10p' },
    { value: 0.05, label: '5p coins', short: '5p' },
    { value: 0.02, label: '2p coins', short: '2p' },
    { value: 0.01, label: '1p coins', short: '1p' },
  ],
  USD: [
    { value: 100, label: '$100 bills', short: '$100' },
    { value: 50, label: '$50 bills', short: '$50' },
    { value: 20, label: '$20 bills', short: '$20' },
    { value: 10, label: '$10 bills', short: '$10' },
    { value: 5, label: '$5 bills', short: '$5' },
    { value: 2, label: '$2 bills', short: '$2' },
    { value: 1, label: '$1 bills', short: '$1' },
    { value: 0.25, label: 'Quarters (25¢)', short: '25¢' },
    { value: 0.1, label: 'Dimes (10¢)', short: '10¢' },
    { value: 0.05, label: 'Nickels (5¢)', short: '5¢' },
    { value: 0.01, label: 'Pennies (1¢)', short: '1¢' },
  ],
  EUR: [
    { value: 100, label: '€100 notes', short: '€100' },
    { value: 50, label: '€50 notes', short: '€50' },
    { value: 20, label: '€20 notes', short: '€20' },
    { value: 10, label: '€10 notes', short: '€10' },
    { value: 5, label: '€5 notes', short: '€5' },
    { value: 2, label: '€2 coins', short: '€2' },
    { value: 1, label: '€1 coins', short: '€1' },
    { value: 0.5, label: '50c coins', short: '50c' },
    { value: 0.2, label: '20c coins', short: '20c' },
    { value: 0.1, label: '10c coins', short: '10c' },
    { value: 0.05, label: '5c coins', short: '5c' },
    { value: 0.02, label: '2c coins', short: '2c' },
    { value: 0.01, label: '1c coins', short: '1c' },
  ],
};

/** The notes and coins for a currency code, biggest first. Unknown codes get the UK set. */
export function denominationsFor(code) {
  return SETS[String(code || '').toUpperCase()] || SETS.GBP;
}

/** Short label for one value in a currency ('£20', '25¢', '50p'); a value not in the set reads as money. */
export function denominationLabel(value, code) {
  const v = Number(value);
  const hit = denominationsFor(code).find((d) => Math.abs(d.value - v) < 1e-9);
  if (hit) return hit.short;
  const sym = { USD: '$', EUR: '€' }[String(code || '').toUpperCase()] || '£';
  return `${sym}${v.toFixed(v < 1 ? 2 : 0)}`;
}

/** Total of a count { value: count } in major units, added up in pennies so 3 x 0.10 is 0.30. */
export function countTotal(counts) {
  let minor = 0;
  for (const [v, n] of Object.entries(counts || {})) {
    const c = Math.max(0, Math.floor(Number(n) || 0));
    minor += Math.round(Number(v) * 100) * c;
  }
  return minor / 100;
}

/** Values present in a saved count (any currency), biggest first. */
export function countedValues(counts) {
  return Object.keys(counts || {}).map(Number).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => b - a);
}
