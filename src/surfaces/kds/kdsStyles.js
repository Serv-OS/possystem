// src/surfaces/kds/kdsStyles.js
//
// Design tokens for the kitchen display (v5.8.66), exactly as the design handoff
// (design_handoff_kds/README.md). The board is always dark, whatever the till theme.

export const SANS = "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif";
export const MONO = "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace";

export const C = {
  root: '#0C0E0D', header: '#111413', card: '#161A18', rail: '#101312', modal: '#141816', sheet: '#121514',
  line: 'rgba(255,255,255,.09)', row: 'rgba(255,255,255,.07)', modalEdge: 'rgba(255,255,255,.12)',
  text: '#FFFFFF', item: '#F2F5F3', setting: '#EDF2EF', railItem: '#D7DEDA', ghost: '#C9D2CD',
  ident: '#AEB8B3', meta1: '#8C968F', meta2: '#7E8A84', meta3: '#6F7A74', empty: '#5C6560',
  bump: '#22C55E', bumpInk: '#06210F', bumpHover: '#2FD96C', mods: '#8FE3B4',
  allergen: '#FFC46B', note: '#FFD79A', railQty: '#4ADE80', clock: '#9AA5A0',
};

/** Ghost button in the header: Recall last, History, Settings. */
export const ghostBtn = (active = false) => ({
  border: `1px solid ${active ? C.bump : 'rgba(255,255,255,.18)'}`,
  background: active ? 'rgba(34,197,94,.15)' : 'transparent',
  color: active ? C.mods : C.ghost,
  borderRadius: 999, padding: '11px 20px', minHeight: 44,
  font: `600 15px ${SANS}`, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
  whiteSpace: 'nowrap',
});

/** Header count pill (type counts, station buttons). */
export const pill = (active, colour) => {
  const c = colour || '#4ADE80';
  return {
    appearance: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
    borderRadius: 999, padding: '8px 14px 8px 12px', minHeight: 44, font: `600 15px ${SANS}`,
    border: `1px solid ${active ? c : 'rgba(255,255,255,.14)'}`,
    background: active ? `${c}22` : 'transparent',
    color: active ? '#fff' : C.ident,
  };
};

/** Segmented chip in the settings sheet. */
export const chip = (active) => ({
  flex: 1, appearance: 'none', cursor: 'pointer', borderRadius: 12, padding: '13px 10px', minHeight: 44,
  font: `700 15px ${SANS}`,
  border: `1px solid ${active ? C.bump : 'rgba(255,255,255,.14)'}`,
  background: active ? 'rgba(34,197,94,.15)' : 'transparent',
  color: active ? C.mods : C.ident,
});

export const monoLabel = {
  font: `700 12px ${MONO}`, letterSpacing: '.16em', color: C.meta3,
};

/** kfade, the one animation in the design. The LATE pulse Peter kept uses the existing
 *  global `pulse` keyframes (globals.css), so it looks exactly as it did before. */
export const KDS_KEYFRAMES = `
@keyframes kdsKfade { from { opacity: 0; transform: scale(.97) } to { opacity: 1; transform: none } }
`;
export const LATE_PULSE = 'pulse 1.4s ease-in-out infinite';
