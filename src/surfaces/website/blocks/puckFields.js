// src/surfaces/website/blocks/puckFields.js
//
// Schema prop → Puck 0.20 field (text, textarea, number, select, radio, array, object, custom,
// slot). Plain JS so node:test can check the mapping; puckConfig.jsx wires these fields to the
// React components.
//
// 5.12.9: opts.renderers = { image, color, menu, categories, href, markdown } turns a typed field
// into a Puck custom field ({ type: 'custom', render }) so the editor shows a picker (photo upload,
// colour swatch, menu and category dropdowns, link chooser, markdown toolbar) instead of a text box
// for an id or a URL. Without renderers (node tests, the SSR side) the plain fields stay.

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

/** Which renderer (opts.renderers key) a schema field uses; null = a plain Puck field. */
export function rendererFor(f) {
  if (!f || typeof f !== 'object') return null;
  switch (f.type) {
    case 'image': case 'color': case 'menu': case 'categories': case 'href': return f.type;
    case 'text': return f.markdown === true ? 'markdown' : null;
    default: return null;
  }
}

/**
 * One schema prop → one Puck field. opts: { locations } for the venue dropdown, { renderers } for
 * the editor's pickers (see the file comment); the rest of opts (pages, menus, categories,
 * uploadAsset) rides along to the renderer as `opts`.
 */
export function puckField(f, opts = {}) {
  const base = { label: f.label || undefined };
  const key = rendererFor(f);
  const renderer = key && opts.renderers && typeof opts.renderers[key] === 'function' ? opts.renderers[key] : null;
  if (renderer) return { ...base, type: 'custom', render: (p) => renderer({ ...p, field: f, opts }) };
  switch (f.type) {
    case 'string': case 'href': return { ...base, type: 'text', placeholder: f.hint || undefined };
    // Plain fallbacks when no renderer is given (image upload, colour, menu and category pickers
    // are custom fields in the editor). Slots are Puck's own drop zones.
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

