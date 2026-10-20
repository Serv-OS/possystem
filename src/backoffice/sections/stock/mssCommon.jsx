// src/backoffice/sections/stock/mssCommon.jsx
//
// MULTI SITE STOCK (v5.11.80): small shared pieces for the Shared stock screens. The look and the
// buttons are the Multi site menu's own (../msm/msmUi.jsx), so the two read as one place.

import { ui } from '../msm/msmStyle';
import { t } from './mssShared';



export function SiteSelect({ sites, value, onChange, placeholder = 'Pick a site', style }) {
  return (
    <select value={value || ''} onChange={(e) => onChange(e.target.value || null)} style={{ ...ui.input, width: 'auto', minWidth: 180, ...style }}>
      <option value="">{placeholder}</option>
      {(sites || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );
}

export function Pager({ offset, limit, total, onChange }) {
  if (!total || total <= limit) return total ? <span style={t.grey}>{total} in all</span> : null;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.ceil(total / limit);
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--t3)' }}>
      <button type="button" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))} style={pagerBtn}>Back</button>
      Page {page} of {pages} ({total} in all)
      <button type="button" disabled={page >= pages} onClick={() => onChange(offset + limit)} style={pagerBtn}>Next</button>
    </span>
  );
}
const pagerBtn = { padding: '3px 9px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'transparent', color: 'var(--t2)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 };

