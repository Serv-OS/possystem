// src/surfaces/website/blocks/puckFields.js
//
// Schema prop → Puck 0.20 field (text, textarea, number, select, radio, array, object). Plain JS so
// node:test can check the mapping; puckConfig.jsx wires these fields to the React components.

const YES_NO = [{ label: 'Yes', value: true }, { label: 'No', value: false }];

/**
 * The venue dropdown (5.12.8): 'default' and 'all' first, then every venue of the company by name.
 * opts.locations is the public locations list the editor already holds; without it the field is a
 * plain text box, so a missing list never hides the value.
 */
export function locationOptions(locations) {
  const list = Array.isArray(locations) ? locations.filter((l) => l && l.id) : [];
  const venues = list.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    .map((l) => ({ label: l.name || l.online_slug || l.id, value: l.id }));
  return [{ label: 'Default venue (site setting)', value: 'default' }, { label: 'All venues', value: 'all' }, ...venues];
}

/** One schema prop → one Puck field. opts: { locations } for the venue dropdown. */
export function puckField(f, opts = {}) {
  const base = { label: f.label || undefined };
  switch (f.type) {
    case 'string': case 'href': return { ...base, type: 'text', placeholder: f.hint || undefined };
    // 5.12.9 plumbing: plain fields until the editor's pickers replace them (image upload, colour,
    // menu and category dropdowns). Slots are Puck's own drop zones.
    case 'image': case 'color': case 'menu': return { ...base, type: 'text', placeholder: f.hint || undefined };
    case 'categories': return { ...base, type: 'array', arrayFields: puckFields(f.item, opts), defaultItemProps: { id: '' }, getItemSummary: (item, i) => summaryOf(item, i) };
    case 'slot': return { type: 'slot' };
    case 'location':
      return Array.isArray(opts.locations) && opts.locations.length
        ? { ...base, type: 'select', options: locationOptions(opts.locations) }
        : { ...base, type: 'text', placeholder: f.hint || undefined };
    case 'text': return { ...base, type: 'textarea', placeholder: f.hint || undefined };
    case 'number': return { ...base, type: 'number', min: f.min, max: f.max };
    case 'boolean': return { ...base, type: 'radio', options: YES_NO };
    case 'enum': return { ...base, type: 'select', options: f.options.map((o) => ({ label: String(o), value: o })) };
    case 'array': return {
      ...base, type: 'array', arrayFields: puckFields(f.item, opts),
      defaultItemProps: Object.fromEntries(Object.entries(f.item).map(([k, sub]) => [k, sub.default])),
      getItemSummary: (item, i) => summaryOf(item, i),
    };
    case 'object': return { ...base, type: 'object', objectFields: puckFields(f.fields, opts) };
    default: return { ...base, type: 'text' };
  }
}
export function puckFields(props, opts = {}) {
  return Object.fromEntries(Object.entries(props || {}).map(([k, f]) => [k, puckField(f, opts)]));
}
function summaryOf(item, i) {
  if (!item || typeof item !== 'object') return `Item ${i + 1}`;
  const first = Object.values(item).find((v) => typeof v === 'string' && v.trim());
  return first ? String(first).slice(0, 40) : `Item ${i + 1}`;
}

