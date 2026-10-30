// Whether a reader is linked to Adyen. PURE, no imports, so the till status page,
// Back Office and `npm test` all read the same rule.
//
// 13 Oct 2026, Coffee Boy Huddersfield: the till status page tested the wrong id, so every
// Adyen reader showed a red "Not connected, cannot take card" while it was taking payments.
// The one rule: a reader with an Adyen terminal id can take a card; one without cannot.

/**
 * 'Adyen', or null when the reader has no Adyen terminal id (then it cannot take a card).
 * @param {{ adyen_terminal_id?: string | null } | null | undefined} t
 * @returns {'Adyen' | null}
 */
export function terminalProcessor(t) {
  if (t?.adyen_terminal_id) return 'Adyen';
  return null;
}
