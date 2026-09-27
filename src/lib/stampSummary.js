// stampSummary.js: a member's stamp cards as the customer display and the till show them (v5.9.89).
//
// Peter, 27 Sep 2026: "once a customer logs in it shows how many stamps they currently have". The
// customer display said "Welcome back, Simon! 0 points" at Coffee Boy, a stamps venue, and never
// showed the stamps (the lookup already returned them). The portal already shows them.

/** Cards from loyalty-balance stamp_cards, cleaned: { id, name, icon, have, need, ready, reward }. */
export function stampSummary(cards) {
  return (Array.isArray(cards) ? cards : [])
    .map((c) => {
      const need = Math.max(0, Math.floor(Number(c?.stamps_required) || 0));
      if (!need) return null;
      const have = Math.min(need, Math.max(0, Math.floor(Number(c?.stamps_collected) || 0)));
      return {
        id: String(c?.id ?? c?.program_id ?? c?.name ?? ''),
        name: String(c?.name || 'Stamp card'),
        icon: String(c?.icon || '☕'),
        have, need,
        ready: Math.max(0, Math.floor(Number(c?.rewards_available) || 0)),
        reward: String(c?.reward_description || ''),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.ready - a.ready) || (b.have - a.have));
}

/** One boolean per stamp position, true when filled; at most 20 positions (a longer card shows the count). */
export function stampDots(have, need) {
  const n = Math.min(20, Math.max(0, Math.floor(Number(need) || 0)));
  const h = Math.min(n, Math.max(0, Math.floor(Number(have) || 0)));
  return Array.from({ length: n }, (_, i) => i < h);
}

/** The short line staff see under the customer's name: "☕ 2/9" (plus "· 1 free" when one is ready). */
export function stampChip(summary) {
  const s = Array.isArray(summary) ? summary[0] : null;
  if (!s) return '';
  return `${s.icon} ${s.have}/${s.need}${s.ready ? ` · ${s.ready} free` : ''}`;
}

/** What the display's points line should do: show points only when the venue runs points. */
export function showPoints({ pointsEnabled = true, points } = {}) {
  return pointsEnabled !== false && points != null;
}
