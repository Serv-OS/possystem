// src/surfaces/website/blocks/puckFields.js
//
// Schema prop → Puck 0.20 field (text, textarea, number, select, radio, array, object). Plain JS so
// node:test can check the mapping; puckConfig.jsx wires these fields to the React components.

const YES_NO = [{ label: 'Yes', value: true }, { label: 'No', value: false }];

/** One schema prop → one Puck field. */
export function puckField(f) {
  const base = { label: f.label || undefined };
  switch (f.type) {
    case 'string': case 'href': return { ...base, type: 'text', placeholder: f.hint || undefined };
    case 'text': return { ...base, type: 'textarea', placeholder: f.hint || undefined };
    case 'number': return { ...base, type: 'number', min: f.min, max: f.max };
    case 'boolean': return { ...base, type: 'radio', options: YES_NO };
    case 'enum': return { ...base, type: 'select', options: f.options.map((o) => ({ label: String(o), value: o })) };
    case 'array': return {
      ...base, type: 'array', arrayFields: puckFields(f.item),
      defaultItemProps: Object.fromEntries(Object.entries(f.item).map(([k, sub]) => [k, sub.default])),
      getItemSummary: (item, i) => summaryOf(item, i),
    };
    case 'object': return { ...base, type: 'object', objectFields: puckFields(f.fields) };
    default: return { ...base, type: 'text' };
  }
}
export function puckFields(props) {
  return Object.fromEntries(Object.entries(props || {}).map(([k, f]) => [k, puckField(f)]));
}
function summaryOf(item, i) {
  if (!item || typeof item !== 'object') return `Item ${i + 1}`;
  const first = Object.values(item).find((v) => typeof v === 'string' && v.trim());
  return first ? String(first).slice(0, 40) : `Item ${i + 1}`;
}

