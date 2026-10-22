// supabase/functions/_shared/stockNotifyRules.js
//
// MULTI SITE STOCK Drop 3 (contract 3.5, map 4.23 alert table, decision 3): what each stock alert says
// and where it goes. PURE (no Deno, no network): the stock-notify and po-cutoff-run edge functions
// import it, and node --test drives every branch (src/lib/stock/stockNotifyRules.test.js).
//
// The table (map 4.23): every kind rings the bell (activity_events); SMS only for the 30 minute
// approval step; email for order by, sent unapproved, price rise, invoice unplaced and count missed.
// Who gets it is the database's answer (stock_notify_targets); this file only decides the channels,
// the words, the route and the dedupe. Nothing here is ever sent twice: the ledger row
// (stock_notify_sent) is marked sent with the bell id, and a row already sent is skipped.
// No phone push (Peter: SMS, email and the bell first).

export const NOTIFY_KINDS = Object.freeze([
  'order_by', 'approval_wait', 'approval_60', 'approval_30', 'sent_unapproved',
  'price_rise', 'invoice_unplaced', 'count_due', 'count_missed', 'count_second_approval',
  'transfer_waiting', 'delivery_overdue',
]);

// kind -> { audience, sms, email, needNow, severity, route, focus }
const TABLE = Object.freeze({
  order_by:              { audience: 'site_managers', sms: false, email: true,  needNow: true,  severity: 'warn', route: 'order-pad' },
  approval_wait:         { audience: 'approvers', sms: false, email: false, needNow: true,  severity: 'info', route: 'purchase-orders' },
  approval_60:           { audience: 'approvers', sms: false, email: false, needNow: true,  severity: 'warn', route: 'purchase-orders' },
  approval_30:           { audience: 'company_editors', sms: true,  email: false, needNow: true,  severity: 'warn', route: 'purchase-orders' },
  sent_unapproved:       { audience: 'company_editors', sms: false, email: true,  needNow: false, severity: 'warn', route: 'purchase-orders' },
  price_rise:            { audience: 'company_editors', sms: false, email: true,  needNow: false, severity: 'info', route: 'price-changes' },
  invoice_unplaced:      { audience: 'company_editors', sms: false, email: true,  needNow: false, severity: 'info', route: 'invoices', focus: 'inbox' },
  count_due:             { audience: 'site_managers', sms: false, email: false, needNow: true,  severity: 'info', route: 'stock-counts' },
  count_missed:          { audience: 'company_editors', sms: false, email: true,  needNow: true,  severity: 'warn', route: 'stock-counts' },
  count_second_approval: { audience: 'company_editors', sms: false, email: false, needNow: false, severity: 'info', route: 'stock-counts' },
  transfer_waiting:      { audience: 'receiving_site', sms: false, email: false, needNow: true,  severity: 'info', route: 'stock-transfers' },
  delivery_overdue:      { audience: 'site_managers', sms: false, email: false, needNow: true,  severity: 'warn', route: 'stock-deliveries' },
});

export const isNotifyKind = (k) => Object.prototype.hasOwnProperty.call(TABLE, String(k || ''));

/** The channels of a kind: { bell: true, sms, email, needNow }. An unknown kind rings nothing. */
export function channelsOf(kind) {
  const t = TABLE[kind];
  if (!t) return { bell: false, sms: false, email: false, needNow: false };
  return { bell: true, sms: t.sms, email: t.email, needNow: t.needNow };
}

/** Who a kind is for, in the table's words (the database picks the people). */
export const audienceOf = (kind) => TABLE[kind]?.audience || null;

/** 'warn' or 'info' for the bell row. */
export const severityOf = (kind) => TABLE[kind]?.severity || 'info';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** 'Wed 22 Oct' from 'YYYY-MM-DD' (or the date part of a timestamp); '' for nothing. */
export function dayShort(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (!Number.isFinite(d.getTime())) return '';
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** '£1,234.50' (or the venue's symbol from payload.currency_symbol); '' for no number. */
export function moneyWords(v, symbol = '£') {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return '';
  const whole = Math.abs(n % 1) < 0.005;
  const s = Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}${symbol}${s}`;
}

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/**
 * The words of one alert: { title, body }. payload is the ledger row's payload (the database fills
 * site, supplier, amounts; a title or body there wins, so a staged row can carry its own words).
 */
export function wordsOf(kind, payload = {}) {
  const p = payload || {};
  if (p.title) return { title: clean(p.title), body: clean(p.body || '') };
  const sym = p.currency_symbol || '£';
  const site = clean(p.site_name || p.site || 'A site');
  const sup = clean(p.supplier_name || p.supplier || 'the supplier');
  const amount = moneyWords(p.amount, sym);
  const limit = moneyWords(p.limit ?? p.limit_amount, sym);
  const raiser = clean(p.raised_by_name || '');
  const byHm = clean(p.order_by_hm || '');
  const day = dayShort(p.delivery_day || p.day || p.expected_date);
  const ref = clean(p.reference || '');
  switch (kind) {
    case 'order_by':
      return { title: `Order by in 1 hour: ${sup}`, body: `${site}: nothing is ordered${day ? ` for ${day}` : ''} yet.${byHm ? ` Order by ${byHm}.` : ''}` };
    case 'approval_wait':
      return { title: 'Order waiting for approval', body: `${site}: ${sup}${amount ? ` ${amount}` : ''}${raiser ? `, raised by ${raiser}` : ''}.${limit ? ` The limit here is ${limit}.` : ''}` };
    case 'approval_60':
      return { title: 'Order still waiting for approval', body: `${site}: ${sup}${amount ? ` ${amount}` : ''}. 60 minutes to the order by time.` };
    case 'approval_30':
      return { title: 'Order needs approval in 30 minutes', body: `${site}: ${sup}${amount ? ` ${amount}` : ''}. Head office can Send anyway. At the order by time it is sent unapproved.` };
    case 'sent_unapproved':
      if (p.failed) return { title: `Could not email ${sup}. Phone them.`, body: `${site}: the order${ref ? ` ${ref}` : ''} did not reach the supplier by email.` };
      return { title: 'Order sent unapproved', body: `${site}: ${sup}${amount ? ` ${amount}` : ''} was sent at the order by time with no answer.` };
    case 'price_rise': {
      const pct = Number(p.pct);
      return { title: `${clean(p.item_name || 'An item')} rose ${Number.isFinite(pct) ? Math.round(pct * 10) / 10 : ''}% at ${site}`, body: `From an invoice from ${sup}. Make it the company price, or leave it at this site.` };
    }
    case 'invoice_unplaced':
      return { title: 'An invoice needs a site', body: `${p.from_email ? `From ${clean(p.from_email)}. ` : ''}Pick the site in Invoices, Inbox.` };
    case 'count_due':
      return { title: 'Count due today', body: `${clean(p.plan_name || 'Stock count')} at ${site}${p.due_by ? ` by ${clean(String(p.due_by).slice(0, 5))}` : ''}.` };
    case 'count_missed':
      return { title: 'Count missed', body: `${clean(p.plan_name || 'Stock count')} at ${site} was not counted${day ? ` on ${day}` : ''}.` };
    case 'count_second_approval':
      return { title: 'Count waiting for a second approval', body: `${site}: variance ${amount || 'over the limit'}${limit ? `, over ${limit}` : ''}.` };
    case 'transfer_waiting':
      if (p.dispute) return { title: 'Transfer disputed', body: `${site} says something is wrong with ${ref || 'a transfer'}${p.note ? `: ${clean(p.note)}` : ''}.` };
      if (p.requested) return { title: 'Transfer requested', body: `${clean(p.from_name || 'A site')} asks ${site} for stock${ref ? ` (${ref})` : ''}.` };
      return { title: 'Transfer waiting', body: `${clean(p.from_name || 'A site')} sent ${ref || 'stock'} to ${site}. Receive it in Transfers.` };
    case 'delivery_overdue':
      return { title: 'Delivery overdue', body: `${sup} at ${site}${day ? ` was due ${day}` : ' is late'}.` };
    default:
      return { title: 'Stock alert', body: '' };
  }
}

/** The Back Office route and focus for the bell's ref_id: 'purchase-orders' or 'invoices:inbox'. */
export function refIdOf(kind, payload = {}) {
  const t = TABLE[kind];
  if (!t) return null;
  const focus = focusText(payload?.focus || t.focus || payload?.po_id || payload?.transfer_id || payload?.count_id || null);
  return focus ? `${t.route}:${focus}` : t.route;
}

/** A focus as text: a record as JSON, an id or a word as it is. */
export function focusText(focus) {
  if (focus == null || focus === '') return '';
  return typeof focus === 'object' ? JSON.stringify(focus) : String(focus);
}

/** The Back Office route and focus of a bell row's ref_id ('route' or 'route:focus'); null when none. */
export function parseRefId(refId) {
  const t = String(refId || '');
  if (!/^[a-z][a-z0-9-]*(:|$)/.test(t)) return null;
  const k = t.indexOf(':');
  if (k < 0) return { route: t, focus: null };
  const raw = t.slice(k + 1);
  let focus = raw;
  if (raw.startsWith('{')) { try { focus = JSON.parse(raw); } catch { focus = null; } }
  return { route: t.slice(0, k), focus: focus === '' ? null : focus };
}

/**
 * The focus a Back Office screen reads on arrival (contract 3.2), whatever shape the alert carried:
 * Price changes { tab: 'supplier', supplierItemId, locationId }; Invoices { tab: 'inbox' } for the
 * inbox, else { tab, focus }. Other routes keep the focus as it is.
 */
export function normFocus(route, focus) {
  if (focus == null || focus === '') return null;
  if (route === 'price-changes') {
    if (typeof focus !== 'object') return null;
    const supplierItemId = focus.supplierItemId || focus.supplier_item_id || null;
    if (!supplierItemId) return null;
    return { tab: focus.tab === 'cost' ? 'cost' : 'supplier', supplierItemId, locationId: focus.locationId || focus.location_id || null };
  }
  if (route === 'invoices') {
    if (focus === 'inbox' || (typeof focus === 'object' && (focus.tab === 'inbox' || focus.focus === 'inbox'))) return { tab: 'inbox' };
    return typeof focus === 'object' ? focus : { focus };
  }
  return focus;
}

/** A link that opens Back Office on a route with its focus (the alert email and the till's bell). */
export function boLink(origin, route, focus = null) {
  if (!origin || !route) return null;
  const f = focusText(focus);
  return `${String(origin).replace(/\/+$/, '')}/?mode=office&go=${encodeURIComponent(route)}${f ? `&open=${encodeURIComponent(f)}` : ''}`;
}

/** The route and focus a Back Office link carries (?go=&open=), normalised; null when none. */
export function readBoLink(search) {
  let q;
  try { q = new URLSearchParams(String(search || '')); } catch { return null; }
  const route = q.get('go');
  if (!route || !/^[a-z][a-z0-9-]*$/.test(route)) return null;
  const raw = q.get('open');
  let focus = raw || null;
  if (raw && raw.startsWith('{')) { try { focus = JSON.parse(raw); } catch { focus = null; } }
  return { route, focus: normFocus(route, focus) };
}

/** Is this Supplier prices row the one an alert focused (its company supplier item, at its site)? */
export function priceRowFocused(focus, row) {
  const f = normFocus('price-changes', focus);
  return !!(f && row && f.supplierItemId === row.supplier_item_id && (!f.locationId || f.locationId === row.location_id));
}

/** The route a kind's alert opens (null for an unknown kind). */
export const routeOf = (kind) => TABLE[kind]?.route || null;

/** The activity_events row for one bell site. */
export function bellRow(kind, payload, locationId) {
  const w = wordsOf(kind, payload);
  return {
    location_id: locationId, kind: `stock_${kind}`, severity: severityOf(kind),
    title: w.title.slice(0, 200), body: w.body ? w.body.slice(0, 1000) : null,
    ref_type: 'stock', ref_id: refIdOf(kind, payload), actor_name: 'ServOS stock',
  };
}

/** A UK mobile to +44 (the ops-escalate rule), anything else kept as typed with only + and digits. */
export function toE164(p) {
  const d = String(p || '').replace(/[^\d+]/g, '');
  if (!d) return '';
  if (d.startsWith('+')) return d;
  if (d.startsWith('07')) return `+44${d.slice(1)}`;
  if (d.startsWith('44')) return `+${d}`;
  return d;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The SMS text: 'ServOS stock: <title>. <body>' within 320 characters. */
export function smsText(words) {
  const t = `ServOS stock: ${clean(words?.title)}${words?.body ? `. ${clean(words.body)}` : ''}`.replace(/\.\./g, '.');
  return t.length > 320 ? `${t.slice(0, 317)}...` : t;
}

/** The email: { subject, html }. */
export function emailOf(words, link = null) {
  const open = link ? `<p style="margin:14px 0 0"><a href="${esc(link)}" style="color:#0F1211;font-weight:bold">Open it in Back Office</a></p>` : '';
  return {
    subject: `ServOS stock: ${clean(words?.title)}`.slice(0, 200),
    html: `<div style="font-family:Arial,sans-serif;max-width:560px"><h3 style="margin:0 0 6px">${esc(words?.title)}</h3>${words?.body ? `<p style="margin:0;color:#333">${esc(words.body)}</p>` : ''}${open}<p style="margin:14px 0 0;color:#777;font-size:12px">Sent by ServOS stock. Open Back Office to act on it.</p></div>`,
  };
}

/**
 * What to send for one ledger row: { bell: [location_id], sms: [{ to, text }], email: [{ to, subject, html }] }.
 * targets is stock_notify_targets' answer. Numbers and addresses are sent once each; a person whose
 * sms or email flag is false is skipped for that channel; bad numbers and addresses are left out.
 */
export function planSend(row, targets, { origin = null } = {}) {
  const kind = row?.kind;
  const ch = channelsOf(kind);
  const words = wordsOf(kind, row?.payload || {});
  const out = { bell: [], sms: [], email: [], words };
  if (!ch.bell) return out;
  const bellSites = new Set();
  for (const b of (targets?.bell || [])) if (b?.location_id) bellSites.add(String(b.location_id));
  if (!bellSites.size && row?.location_id) bellSites.add(String(row.location_id));
  out.bell = [...bellSites];
  const phones = new Set();
  const mails = new Set();
  for (const person of (targets?.people || [])) {
    if (ch.sms && person?.sms !== false) {
      const to = toE164(person?.mobile);
      if (/^\+?\d{8,15}$/.test(to)) phones.add(to);
    }
    if (ch.email && person?.email_on !== false) {
      const to = String(person?.email || '').trim().toLowerCase();
      if (EMAIL_RE.test(to)) mails.add(to);
    }
  }
  const text = smsText(words);
  const p = row?.payload || {};
  const mail = emailOf(words, origin ? boLink(origin, TABLE[kind]?.route, p.focus || TABLE[kind]?.focus || p.po_id || p.transfer_id || p.count_id || null) : null);
  out.sms = [...phones].map((to) => ({ to, text }));
  out.email = [...mails].map((to) => ({ to, subject: mail.subject, html: mail.html }));
  return out;
}

/** May this row be sent now? Only a waiting row of a known kind (never twice). */
export function sendable(row) {
  return !!row && row.status === 'waiting' && isNotifyKind(row.kind);
}

/** How a send went for the ledger: 'sent' when the bell landed (the bell is the record), else 'failed'. */
export function outcomeOf({ bellIds = [], smsSent = 0, smsTried = 0, emailSent = 0, emailTried = 0 } = {}) {
  const errors = [];
  if (smsTried > smsSent) errors.push(`${smsTried - smsSent} of ${smsTried} texts failed`);
  if (emailTried > emailSent) errors.push(`${emailTried - emailSent} of ${emailTried} emails failed`);
  if (!bellIds.length) errors.push('the bell did not save');
  return { status: bellIds.length ? 'sent' : 'failed', error: errors.length ? errors.join('; ') : null };
}

/** Who may start a run: the service role, or the pg_cron job's key that the database checks. */
export function cronAccess({ service = false, key = '', check = null } = {}) {
  if (service) return { ok: true, status: 200, reason: null };
  if (!key) return { ok: false, status: 401, reason: 'no_cron_key' };
  const e = check?.error;
  if (e && /PGRST202|42883|could not find the function|does not exist|schema cache/i.test(`${e.code || ''} ${e.message || ''}`)) {
    return { ok: false, status: 503, reason: 'needs_database_update' };
  }
  if (e) return { ok: false, status: 401, reason: 'cron_key_check_failed' };
  if (check && check.data === true) return { ok: true, status: 200, reason: null };
  return { ok: false, status: 401, reason: 'wrong_cron_key' };
}

export const SEND_JOB_MAX_ATTEMPTS = 3;

/** After one send try of a stock_po_send_jobs row: the patch to write and whether to stage the alert. */
export function sendJobStep(job, result, nowIso) {
  const attempts = (Number(job?.attempts) || 0) + 1;
  if (result?.ok) return { patch: { status: 'sent', attempts, sent_at: nowIso, last_error: null }, alert: false };
  const lastError = String(result?.error || 'send failed').slice(0, 500);
  if (attempts >= SEND_JOB_MAX_ATTEMPTS || result?.final === true) return { patch: { status: 'failed', attempts, last_error: lastError }, alert: true };
  return { patch: { attempts, last_error: lastError }, alert: false };
}
