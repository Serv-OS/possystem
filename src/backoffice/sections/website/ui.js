// src/backoffice/sections/website/ui.js
//
// Shared inline styles for the website builder screens. Same tokens and shapes as
// MenuAppearance.jsx's S object (radius 14 cards, 10 inputs, 8 buttons) so the fifth
// tab looks like the other four. BO tokens only, never literal brand colours.

export const W = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  h2: { fontSize: 15, fontWeight: 800, color: 'var(--t1)', margin: 0 },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18 },
  card: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 18, marginBottom: 16 },
  cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 },
  label: { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 6 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)' },
  textarea: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '10px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', minHeight: 120, resize: 'vertical', lineHeight: 1.5 },
  field: { marginBottom: 14 },
  btn: { padding: '9px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  ghost: { padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  danger: { padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', background: 'var(--red-d)', color: 'var(--red)', border: '1px solid var(--red-b)' },
  seg: (on) => ({ padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', border: `1px solid ${on ? 'var(--acc)' : 'var(--bdr2)'}`, background: on ? 'var(--acc)' : 'transparent', color: on ? '#0b0c10' : 'var(--t2)' }),
  tab: (on) => ({ padding: '8px 13px', borderRadius: 10, cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', border: `1px solid ${on ? 'var(--acc)' : 'var(--bdr)'}`, background: on ? 'var(--acc-d, rgba(232,116,60,.12))' : 'var(--bg1)', color: on ? 'var(--acc)' : 'var(--t2)' }),
  hint: { fontSize: 11.5, color: 'var(--t4)', marginTop: 5, lineHeight: 1.5 },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  pill: (tone) => ({
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px', borderRadius: 999, fontSize: 11.5, fontWeight: 700,
    background: tone === 'good' ? 'var(--grn-d)' : tone === 'bad' ? 'var(--red-d)' : tone === 'warn' ? 'var(--acc-d)' : 'var(--bg3)',
    color: tone === 'good' ? 'var(--grn)' : tone === 'bad' ? 'var(--red)' : tone === 'warn' ? 'var(--acc)' : 'var(--t2)',
    border: `1px solid ${tone === 'good' ? 'var(--grn-b)' : tone === 'bad' ? 'var(--red-b)' : tone === 'warn' ? 'var(--acc-b)' : 'var(--bdr)'}`,
  }),
  chip: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700, background: 'var(--bg3)', color: 'var(--t2)', border: '1px solid var(--bdr)' },
  listRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: '1px solid var(--bdr)' },
  topBar: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', marginBottom: 14 },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { textAlign: 'left', fontSize: 11.5, color: 'var(--t3)', fontWeight: 700, padding: '6px 8px', borderBottom: '1px solid var(--bdr)' },
  td: { padding: '8px', borderBottom: '1px solid var(--bdr)', color: 'var(--t1)', verticalAlign: 'middle' },
  switchRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 0', borderTop: '1px solid var(--bdr)' },
  toggle: (on) => ({ width: 38, height: 22, borderRadius: 999, border: 'none', cursor: 'pointer', position: 'relative', background: on ? 'var(--acc)' : 'var(--bg3)', transition: 'background .15s' }),
  knob: (on) => ({ position: 'absolute', top: 3, left: on ? 19 : 3, width: 16, height: 16, borderRadius: 999, background: on ? '#0b0c10' : 'var(--t3)', transition: 'left .15s' }),
};
