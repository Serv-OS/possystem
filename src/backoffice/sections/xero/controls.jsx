// src/backoffice/sections/xero/controls.jsx
//
// Small controls shared by the Back Office Xero screens. They live at module scope (never
// declared inside another component's render), so React keeps the same element between renders
// and a select that has focus keeps it while its own value changes.

import { S, sel, accountRef, accountLabel } from './xeroUi';

/** An account select. A saved value missing from the list stays visible so it can be changed. */
export function AcctSelect({ value, onChange, list, placeholder = 'Choose an account', style }) {
  const known = !value || list.some((a) => accountRef(a) === value || a.id === value);
  return (
    <select value={value || ''} onChange={(e) => onChange(e.target.value)} style={style ? { ...sel, ...style } : sel}>
      <option value="">{placeholder}</option>
      {!known && <option value={value}>{value} (not in this list: choose again)</option>}
      {list.map((a) => <option key={a.id} value={accountRef(a)}>{accountLabel(a)}</option>)}
    </select>
  );
}

/**
 * Short notes as bullets, each led by a bold key word (the house style for these screens: short
 * lines are easier to read than one long paragraph). items: [[keyWord, rest], ...] where rest
 * may be text or an element; a plain string or element is a bullet with no key word.
 */
export function Bullets({ items, style }) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;
  return (
    <ul style={{ ...S.note, margin: '4px 0 0', paddingLeft: 18, ...(style || {}) }}>
      {list.map((it, i) => (
        <li key={i} style={{ marginTop: i ? 3 : 0 }}>
          {Array.isArray(it) ? <><b style={{ color: 'var(--t2)' }}>{it[0]}</b>{it[1] ? <>{' '}{it[1]}</> : null}</> : it}
        </li>
      ))}
    </ul>
  );
}
