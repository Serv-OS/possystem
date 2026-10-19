// src/backoffice/sections/stock/mssShared.js
//
// MULTI SITE STOCK (v5.11.80): constants and small helpers shared by the Shared stock screens (kept
// out of mssCommon.jsx, which holds components only).

export const UNITS = Object.freeze(['each', 'dozen', 'g', 'kg', 'mg', 'oz', 'lb', 'ml', 'cl', 'l', 'floz', 'pt', 'gal']);

export const AREA_KINDS = Object.freeze([
  ['', 'None'], ['cellar', 'Cellar'], ['walk_in', 'Walk in fridge'], ['fridge', 'Fridge'], ['freezer', 'Freezer'],
  ['dry_store', 'Dry store'], ['bar', 'Bar'], ['kitchen', 'Kitchen'], ['other', 'Other'],
]);

export const t = {
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 },
  th: { textAlign: 'left', padding: '7px 8px', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: 'var(--bg1)' },
  td: { padding: '7px 8px', borderBottom: '1px solid var(--bdr)', verticalAlign: 'middle' },
  grey: { color: 'var(--t3)', fontSize: 11.5 },
  scroll: { overflow: 'auto', maxHeight: 'calc(100vh - 290px)', border: '1px solid var(--bdr)', borderRadius: 12 },
  bar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 },
};

export const fmtNum = (v, unit = '') => (v == null || !Number.isFinite(Number(v)) ? '' : `${Math.round(Number(v) * 1000) / 1000}${unit ? ` ${unit}` : ''}`);

export const fmtWhen = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
};

/** Text box to a number or null ("" stays null). */
export const numOrNull = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
