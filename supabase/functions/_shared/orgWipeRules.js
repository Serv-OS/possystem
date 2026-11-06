// supabase/functions/_shared/orgWipeRules.js: delete an organisation (or a location) and wipe
// all its data, the rules both sides share (5 Nov 2026).
//
// WHY (Peter, 5 Nov 2026): "Cant delete organizations from the back office. Delete button
// doesn't do anything, this should say delete organizations - all locations and wipe all data."
//
// Pure helpers only (no Supabase, no Deno, no window, no React): the org-admin edge function
// imports this file, and src/lib/orgWipeRules.js re-exports it for the Company Admin screen, so
// the name check the screen does is the one the server does.

export const ORG_WIPE_TITLE = 'Delete organisation: all locations and wipe all data';
export const LOCATION_WIPE_TITLE = 'Delete location and wipe all its data';

/** Shown on the screen while the SQL or the function is missing. */
export const NEEDS_UPDATE_LINE =
  'Deleting an organisation needs two ServOS database updates first (20261125a on Ops, 20261125b on Platform) and the org-admin function deployed. Nothing was deleted.';

/** The name typed must be the organisation's name: trimmed, any case, inner spaces squeezed. */
export function nameMatches(typed, name) {
  const clean = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const want = clean(name);
  return want.length > 0 && clean(typed) === want;
}

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s ?? ''));
export { isUuid };

/** The storage buckets a venue's files can sit in, and the prefixes its files use. */
export const STORAGE_BUCKETS = [
  'ops-files', 'wf-documents', 'invoice-scans', 'kiosk-assets', 'receipt-assets', 'web-assets',
  'chat-photos', 'stock-invoice-inbox', 'report-exports', 'bucket_public',
];
export function storagePrefixes(locationId) {
  const id = String(locationId ?? '').trim();
  if (!id) return [];
  return [`locations/${id}`, id];
}

/** A function the database does not have yet (the SQL file has not run). */
export function isMissingWipeFunction(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (code === 'PGRST202' || code === '42883') return true;
  const msg = String(error.message || error.hint || '');
  return /admin_wipe/i.test(msg) && /(could not find|does not exist|schema cache|not found)/i.test(msg);
}

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const plural = (count, one, many) => `${count.toLocaleString('en-GB')} ${count === 1 ? one : many}`;

/**
 * The numbers a person reads before pressing the red button, from the server's report:
 *   { ops: { venues: { tables }, people: { tables }, company: { tables } } | { tables }, platform: { tables }, logins, locations, storage? }
 * Returns { lines: string[], total, tables }.
 */
export function wipeSummary(report) {
  const r = report || {};
  const tables = {};
  const add = (block) => {
    const t = (block && block.tables) || {};
    for (const [k, v] of Object.entries(t)) tables[k] = (tables[k] || 0) + n(v);
  };
  const ops = r.ops || {};
  if (ops.venues || ops.people || ops.company) { add(ops.venues); add(ops.people); add(ops.company); } else add(ops);
  const platform = r.platform || {};
  if (platform.locations_report || platform.company_report) { add(platform.locations_report); add(platform.company_report); } else add(platform);
  const total = Object.values(tables).reduce((a, b) => a + b, 0);
  const lines = [];
  if (r.locations != null) lines.push(plural(n(r.locations), 'location', 'locations'));
  lines.push(`${plural(total, 'row', 'rows')} across ${plural(Object.keys(tables).length, 'table', 'tables')}`);
  const named = [
    ['closed_checks', 'closed check', 'closed checks'],
    ['kds_tickets', 'kitchen ticket', 'kitchen tickets'],
    ['order_queue', 'open order', 'open orders'],
    ['customers', 'customer', 'customers'],
    ['menu_items', 'menu item', 'menu items'],
    ['wf_staff', 'staff record', 'staff records'],
    ['devices', 'device', 'devices'],
    ['adyen_payments', 'card payment', 'card payments'],
    ['gift_cards', 'gift card', 'gift cards'],
  ];
  for (const [k, one, many] of named) if (tables[k]) lines.push(plural(tables[k], one, many));
  if (r.logins != null) lines.push(`${plural(n(r.logins), 'Back Office login', 'Back Office logins')} removed`);
  if (r.storage && n(r.storage.files)) lines.push(plural(n(r.storage.files), 'stored file', 'stored files'));
  return { lines, total, tables };
}

/** What the green banner says after a wipe. */
export function wipeDoneLine(kind, name, report) {
  const { total } = wipeSummary(report);
  const who = kind === 'location' ? 'location' : 'organisation';
  const logins = report && report.logins != null ? `, ${plural(n(report.logins), 'login', 'logins')} removed` : '';
  const files = report && report.storage && n(report.storage.files) ? `, ${plural(n(report.storage.files), 'file', 'files')}` : '';
  const left = report && report.storage && Array.isArray(report.storage.errors) && report.storage.errors.length
    ? ` ${report.storage.errors.length} stored file(s) could not be removed; see the list.` : '';
  return `"${name}" ${who} deleted: ${plural(total, 'row', 'rows')}${logins}${files}.${left}`;
}
