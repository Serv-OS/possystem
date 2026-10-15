// Which card processor a reader is linked to. PURE, no imports, so the till status page,
// Back Office and `npm test` all read the same rule.
//
// 13 Oct 2026, Coffee Boy Huddersfield: the till status page tested the Ryft id only, so every
// Adyen reader showed a red "Not connected, cannot take card" while it was taking payments.

/**
 * 'Adyen', 'Ryft', or null when the reader is linked to neither (then it cannot take a card).
 * @param {{ adyen_terminal_id?: string | null, ryft_terminal_id?: string | null } | null | undefined} t
 * @returns {'Adyen' | 'Ryft' | null}
 */
export function terminalProcessor(t) {
  if (t?.adyen_terminal_id) return 'Adyen';
  if (t?.ryft_terminal_id) return 'Ryft';
  return null;
}
