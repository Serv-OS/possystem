// src/backoffice/sections/msm/msmStyle.js
//
// MULTI SITE MENU (v5.11.75): the shared styles and the money format for the screens (kept out of
// msmUi.jsx so that file holds components only).

import { currencySymbol } from '../../../lib/currency';

export const ui = {
  page: { padding: '22px 26px 40px', maxWidth: 'none', color: 'var(--t1)' },
  card: { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 18, boxShadow: 'var(--sh)' },
  h2: { fontSize: 15, fontWeight: 700, color: 'var(--t1)', margin: '0 0 4px' },
  sub: { fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.5 },
  label: { fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6, display: 'block' },
  input: { width: '100%', padding: '8px 11px', borderRadius: 9, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  row: { display: 'flex', alignItems: 'center', gap: 8 },
  err: { fontSize: 12.5, color: 'var(--red)', lineHeight: 1.5 },
};

export const money = (v) => (v == null || !Number.isFinite(Number(v)) ? '' : `${currencySymbol()}${Number(v).toFixed(2)}`);
