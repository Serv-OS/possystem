// src/lib/venueMessagePopupWiring.test.js: where the "Message from ServOS" pop up is mounted,
// and that it stays off the card path (5 Oct 2026).
//
// Peter's rule: it pops up in Back Office and on tills. It must NEVER appear on a kiosk, kitchen
// screen, customer display, menu board, order screen, time clock or any customer page, and never
// over a checkout, card screen, tab capture or any payment in progress. Perfect rules are worth
// nothing if the component is mounted in the wrong place, and only reading the real files can
// check that.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SRC, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const count = (hay, needle) => hay.split(needle).length - 1;
const between = (src, startMarker, endMarker) => {
  const i = src.indexOf(startMarker);
  assert.ok(i >= 0, `marker not found: ${startMarker}`);
  const j = src.indexOf(endMarker, i + startMarker.length);
  assert.ok(j > i, `end marker not found after ${startMarker}: ${endMarker}`);
  return src.slice(i, j);
};

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(jsx?|mjs)$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const filesNaming = (needle) => sourceFiles(SRC).filter((p) => fs.readFileSync(p, 'utf8').includes(needle)).map(rel).sort();

// ── where it is mounted ─────────────────────────────────────────────────────

test('the pop up is mounted in exactly two files: the till shell (App.jsx) and Back Office', () => {
  assert.deepEqual(filesNaming('import VenueMessagePopup'), ['src/App.jsx', 'src/backoffice/BackOfficeApp.jsx']);
  assert.deepEqual(filesNaming('<VenueMessagePopup'), ['src/App.jsx', 'src/backoffice/BackOfficeApp.jsx']);
  // Nothing loads it lazily or under another name either.
  assert.deepEqual(filesNaming('VenueMessagePopup').filter((f) => !f.startsWith('src/components/VenueMessage')), ['src/App.jsx', 'src/backoffice/BackOfficeApp.jsx']);
});

test('no kiosk, kitchen screen, customer display, menu board, order screen, time clock or customer page names it', () => {
  const never = /(Kiosk|KDS|Kds|kds\/|CustomerDisplay|customerDisplay|MenuBoard|menuBoard|OrderScreen|orderScreen|TimeClock|MPOS|mpos\/|OtherSurfaces|online\/|\/qr|Qr[A-Z]|Customer(Boot|Portal)|Gift|Review|Waitlist|Bookings)/;
  const named = [...filesNaming('VenueMessagePopup'), ...filesNaming('useVenueMessages'), ...filesNaming("lib/venueMessages'")];
  for (const f of named) assert.ok(!never.test(f), `${f} must not show or read messages from ServOS`);
  // The hook that reads the messages is used by the pop up and the Back Office list, nothing else.
  assert.deepEqual(filesNaming('useVenueMessages'), [
    'src/backoffice/sections/ServosMessages.jsx',
    'src/components/VenueMessagePopup.jsx',
    'src/lib/useVenueMessages.js',
  ]);
});

test('App.jsx mounts it once, inside the till shell only, behind tillMayHostPopup', () => {
  const app = read('src/App.jsx');
  assert.equal(count(app, '<VenueMessagePopup'), 1);
  // The till shell: from the shift bar to the end of that body.
  const shell = between(app, '<ShiftBar version={VERSION}', '// Kiosk card problems park over EVERY staff body');
  assert.equal(count(shell, '<VenueMessagePopup host="till"'), 1);
  assert.match(shell, /\{tillMayHostPopup\(\{ deviceMode: 'pos', deviceType: pairedDeviceType, defaultSurface: deviceConfig\?\.defaultSurface, surface, isKdsDevice, staffSignedIn: !!staff \}\)\s*&& <VenueMessagePopup host="till"/);
  // The other bodies of a paired device (kitchen screen, PIN screen, kiosk, phone till) are
  // chosen before the shell and never carry it.
  const otherBodies = between(app, 'let body;', '<CardUserSwitch />');
  assert.ok(otherBodies.includes('<KDSSurface />') && otherBodies.includes('<PINScreen />')
    && otherBodies.includes('<KioskSurface />') && otherBodies.includes('<MPOSSurface />'));
  assert.equal(count(otherBodies, 'VenueMessagePopup'), 0);
  // It is not in the fixed slot that sits over EVERY body (where the kiosk card alert lives).
  const fixedSlot = app.slice(app.indexOf('const showKioskStaffAlert'), app.indexOf('const NAV = ['));
  assert.equal(count(fixedSlot, 'VenueMessagePopup'), 0);
});

test('App.jsx: every surface routed before the till shell returns without the pop up', () => {
  const app = read('src/App.jsx');
  const lines = app.split('\n').filter((l) => /^\s*if \(deviceMode === '/.test(l));
  for (const mode of ['kiosk', 'customer-display', 'menuboard', 'clock', 'mpos', 'manager', 'staff', 'bookings', 'waitlist', 'owner', 'admin']) {
    const line = lines.find((l) => l.includes(`deviceMode === '${mode}'`));
    assert.ok(line, `route for ${mode} not found`);
    assert.ok(!line.includes('VenueMessagePopup'), `${mode} must not mount the pop up`);
  }
  // The customer pages (online, QR, gift, portal, review) are routed by CustomerBoot.
  assert.equal(count(read('src/surfaces/CustomerBoot.jsx'), 'VenueMessage'), 0);
});

test('Back Office mounts it once, for a signed in person at a venue, and lists what was received', () => {
  const bo = read('src/backoffice/BackOfficeApp.jsx');
  assert.equal(count(bo, '<VenueMessagePopup'), 1);
  assert.match(bo, /\{authUser && !isMock && orgCtx\?\.locationId && \(\s*<VenueMessagePopup host="backoffice" locationId=\{orgCtx\.locationId\} user=\{authUser\}/);
  assert.ok(bo.includes("{ id: 'servos-messages', label: 'Messages from ServOS'"));
  assert.ok(bo.includes("['servos-messages','Messages from ServOS']"));
  assert.ok(bo.includes("{section === 'servos-messages' && <ServosMessages locationId={orgCtx?.locationId || null} />}"));
});

// ── the card path ───────────────────────────────────────────────────────────

test('the pop up asks the payment flag before it shows, at render and while it waits', () => {
  const pop = read('src/components/VenueMessagePopup.jsx');
  assert.ok(pop.includes("import { canApplyUpdate, subscribePaymentBusy } from '../lib/paymentBusy';"));
  assert.ok(pop.includes('const unsubscribe = subscribePaymentBusy(check);'));
  assert.ok(pop.includes('mayShowPopup({ paymentQuiet: paymentQuiet && canApplyUpdate(), customerFacing, changeDueShowing })'));
  // CHANGE DUE is shown after the checkout closed (no hold covers it): read from the store.
  assert.ok(pop.includes('const changeDueShowing = useStore(s => !!s.changeDue);'));
  assert.ok(read('src/components/ChangeDueOverlay.jsx').includes('const changeDue = useStore(s => s.changeDue);'));
  // Nothing renders unless that answer was yes.
  assert.ok(pop.includes('const front = show ? queue[0] : null;'));
  assert.ok(pop.includes("if (!front || typeof document === 'undefined') return null;"));
  // A till in a customer's hands waits too.
  assert.ok(pop.includes('s.tillCustomerFacing === true'));
  // It never takes the payment flag itself, and never touches a pay flow.
  assert.equal(count(pop, 'holdPaymentBusy'), 0);
});

test('the checkout and the card screens still hold the flag the pop up reads', () => {
  assert.ok(read('src/surfaces/CheckoutModal.jsx').includes("usePaymentBusy(true, 'checkout');"));
  assert.ok(read('src/surfaces/PaxTerminal.jsx').includes("usePaymentBusy(true, 'card machine screen');"));
  assert.ok(read('src/components/TabPreAuthTerminal.jsx').includes("usePaymentBusy(true, 'bar tab card hold');"));
  assert.ok(read('src/components/SplitModal.jsx').includes("usePaymentBusy(true, 'split bill');"));
});

test('this change touches no pay flow file', () => {
  for (const f of ['src/surfaces/CheckoutModal.jsx', 'src/surfaces/PaxTerminal.jsx', 'src/components/SplitModal.jsx',
    'src/components/TabPreAuthTerminal.jsx', 'src/lib/paymentBusy.js', 'src/lib/payments/terminalJobs.js', 'src/surfaces/KioskApp.jsx',
    'src/components/ChangeDueOverlay.jsx', 'src/lib/usePaymentBusy.js']) {
    assert.equal(count(read(f), 'VenueMessage'), 0, f);
    assert.equal(count(read(f), 'venueMessage'), 0, f);
  }
});

test('the message is shown as plain text: no HTML injection and no link is made', () => {
  const card = read('src/components/VenueMessageCard.jsx');
  assert.equal(count(card, 'dangerouslySetInnerHTML'), 0);
  assert.equal(count(card, '<a '), 0);
  assert.equal(count(card, 'href'), 0);
  assert.ok(card.includes("whiteSpace: 'pre-wrap'"));
  assert.ok(card.includes('Message from ServOS'));
  assert.ok(card.includes('Got it'));
  // One tap, no typing.
  assert.equal(count(card, '<input'), 0);
  assert.equal(count(card, '<textarea'), 0);
});

test('Got it never holds the till: the tap clears the screen first and is sent after', () => {
  const hook = read('src/lib/useVenueMessages.js');
  const confirm = between(hook, 'const confirm = useCallback((id, name) => {', '}, [sendTap, setTappedBoth]);');
  assert.ok(confirm.indexOf('setTappedBoth(addTapped(') < confirm.indexOf('sendTap(id)'));
  assert.ok(hook.includes('for (const id of tapsToSend(pruned)) sendTap(id);'));
  // Three ways in: load, live, and a poll.
  assert.ok(hook.includes('export const POLL_MS = 60 * 1000;'));
  assert.ok(hook.includes('onSubscribed: refresh,'));
  assert.ok(hook.includes("document.addEventListener('visibilitychange', onVisible)"));
});

test('training mode never switches the messages off', () => {
  for (const f of ['src/lib/venueMessages.js', 'src/lib/useVenueMessages.js', 'src/components/VenueMessagePopup.jsx']) {
    assert.equal(count(read(f), 'isTrainingMode('), 0, f);
  }
});

// ── the venue reads only what it may ────────────────────────────────────────

test('the app asks only for the columns a venue may read, never *', () => {
  const lib = read('src/lib/venueMessages.js');
  assert.equal(count(lib, "select('*')"), 0);
  const cols = lib.match(/VENUE_MESSAGE_COLUMNS = '([^']+)'/)[1].split(',').map((c) => c.trim()).sort();
  const sql = read('supabase/migrations/20261005a_OPS_venue_messages.sql');
  const grant = sql.match(/grant select \(([^)]+)\)\s+on table public\.venue_messages to authenticated;/)[1]
    .split(',').map((c) => c.trim()).sort();
  assert.deepEqual(cols, grant);
  assert.ok(!grant.includes('sent_by') && !grant.includes('sent_by_name') && !grant.includes('confirmed_email'));
});

// ── the database file ───────────────────────────────────────────────────────

test('20261005a: Ops only, guarded, row level security on, one read rule, no write rule', () => {
  const sql = read('supabase/migrations/20261005a_OPS_venue_messages.sql');
  assert.ok(sql.includes('OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi'));
  assert.ok(sql.includes("raise exception 'This is not the Ops database"));
  assert.ok(sql.includes("set local lock_timeout = '3s';"));
  assert.ok(sql.includes('create table if not exists public.venue_messages'));
  assert.ok(sql.includes('alter table public.venue_messages enable row level security;'));
  assert.ok(sql.includes('revoke all on table public.venue_messages from public, anon, authenticated;'));
  const policies = [...sql.matchAll(/create policy (\w+) on public\.venue_messages\s+as (\w+) for (\w+)/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`);
  // One rule that lets anybody in (read, own venue). The other only ever refuses (second step).
  assert.deepEqual(policies, ['venue_messages_read_own_venue permissive select', 'second_step_fence restrictive all']);
  assert.ok(sql.includes('using (location_id in (select public.venue_message_reader_location_ids()));'));
  // The read rule is as narrow as the confirm rule: the fence's wide helper (every bound device,
  // kiosks and kitchen screens included, plus ops_devices) is used nowhere in the SQL itself.
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.equal(count(code, 'pos_accessible_location_ids'), 0);
  assert.equal(count(code, 'pos_accessible_location_keys'), 0);
  assert.equal(count(code, 'ops_devices'), 0);
  const reader = between(sql, 'create or replace function public.venue_message_reader_location_ids()', '$fn$;');
  assert.ok(reader.includes('security definer') && reader.includes('set search_path = public, pg_temp'));
  assert.ok(reader.includes('from public.user_accessible_locations() as k'));
  assert.ok(reader.includes('d.device_uid = auth.uid()') && reader.includes('d.bound_via is not null') && reader.includes("d.status in ('active', 'online')"));
  assert.ok(reader.includes("coalesce(d.type, '') not in ('kiosk', 'kds', 'clock')"));
  assert.ok(sql.indexOf('create or replace function public.venue_message_reader_location_ids()') < sql.indexOf('create policy venue_messages_read_own_venue'));
  assert.ok(sql.includes('revoke all on function public.venue_message_reader_location_ids() from public, anon;'));
  // No grant of insert, update or delete to a venue session, anywhere in the file.
  assert.ok(!/grant[^;]*\b(insert|update|delete|all)\b[^;]*\bto\s+(anon|authenticated|public)\b/i.test(sql.replace(/grant all on table public\.venue_messages to service_role;/, '')));
  assert.ok(!/^\s*(begin|commit)\s*;/im.test(sql), 'bare statements, the editor is the transaction');
  // The visible check is the last statement.
  const last = sql.trim().split(/;\s*\n/).filter((s) => s.trim()).pop();
  assert.ok(/^\s*(--[^\n]*\n\s*)*select/i.test(last.trim()) && last.includes('realtime_on'));
});

test('20261005a: Got it changes only the confirm fields, of a row of the caller\'s own venue', () => {
  const sql = read('supabase/migrations/20261005a_OPS_venue_messages.sql');
  const fn = between(sql, 'create or replace function public.venue_message_confirm(p_id uuid, p_name text default null)', '$fn$;');
  assert.ok(fn.includes('security definer'));
  assert.ok(fn.includes('set search_path = public, pg_temp'));
  // The only write in the function, and what it sets.
  assert.equal(count(fn, 'update public.venue_messages'), 1);
  assert.equal(count(fn, 'insert into'), 0);
  assert.equal(count(fn, 'delete from'), 0);
  const set = between(fn, 'update public.venue_messages m', 'where m.id = p_id');
  const cols = [...set.matchAll(/(\w+) = /g)].map((m) => m[1]).sort();
  assert.deepEqual(cols, ['confirmed_at', 'confirmed_by', 'confirmed_device_id', 'confirmed_device_name', 'confirmed_email', 'confirmed_user_id', 'confirmed_via']);
  // Back Office proof is the email from the sign in token (a login can edit its own full_name),
  // and a venue can never read it back.
  assert.ok(fn.includes("current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'"));
  assert.ok(!sql.match(/grant select \(([^)]+)\)/)[1].includes('confirmed_email'));
  // Back Office: not anonymous and the venue is one of the login's own. Till: paired to THAT venue.
  assert.ok(fn.includes('if not public.is_anon_session()'));
  assert.ok(fn.includes('v_row.location_id::text in (select public.user_accessible_locations())'));
  assert.ok(fn.includes('d.device_uid = v_uid'));
  assert.ok(fn.includes('d.bound_via is not null'));
  assert.ok(fn.includes('d.location_id = v_row.location_id'));
  assert.ok(fn.includes("coalesce(d.type, '') not in ('kiosk', 'kds', 'clock')"));
  // A finished message is never changed again.
  assert.ok(fn.indexOf('if v_row.withdrawn_at is not null then') < fn.indexOf('update public.venue_messages m'));
  assert.ok(fn.indexOf('if v_row.confirmed_at is not null then') < fn.indexOf('update public.venue_messages m'));
  assert.ok(sql.includes('revoke all on function public.venue_message_confirm(uuid, text) from public, anon;'));
});

test('the rollback names the same objects and checks they are gone', () => {
  const sql = read('supabase/migrations/20261005a_OPS_venue_messages_ROLLBACK.sql');
  assert.ok(sql.includes("raise exception 'This is not the Ops database"));
  assert.ok(sql.includes('drop function if exists public.venue_message_confirm(uuid, text);'));
  assert.ok(sql.includes('drop table if exists public.venue_messages;'));
  assert.ok(sql.indexOf('drop table if exists public.venue_messages;') < sql.indexOf('drop function if exists public.venue_message_reader_location_ids();'));
  assert.ok(sql.includes('alter publication supabase_realtime drop table public.venue_messages;'));
});

// ── only ServOS staff can send ──────────────────────────────────────────────

test('venue-messages-admin: second step, a real user, never anonymous, super_admin read by the server', () => {
  const fn = read('supabase/functions/venue-messages-admin/index.ts');
  const order = [
    'const needs = requireAal2(req, [SERVICE_ROLE]);',
    'await admin.auth.getUser(token);',
    "if (user.is_anonymous) return json({ error: 'Only ServOS staff can do this.' }, 403);",
    "if (profErr || profile?.role !== 'super_admin') return json({ error: 'Only ServOS staff can do this.' }, 403);",
    'body = await req.json();',
  ];
  let at = -1;
  for (const step of order) {
    const i = fn.indexOf(step);
    assert.ok(i > at, `missing or out of order: ${step}`);
    at = i;
  }
  // The role comes from the database for the token's own user, never from the request.
  assert.ok(fn.includes(".select('role, full_name, email').eq('id', user.id).maybeSingle();"));
  assert.ok(!/body\??\.(role|is_admin|sent_by)/.test(fn));
  // The service key itself is not a sender: a message has a person behind it.
  assert.ok(fn.includes('if (!token || token === SERVICE_ROLE) return json('));
  // The message and the recipients are checked again on the server, against its own venue list.
  assert.ok(fn.includes('const draft = cleanDraft({ title: body?.title, body: body?.body, kind: body?.kind });'));
  assert.ok(fn.includes('const picked = expandRecipients({ companyIds, venueIds, venues });'));
  // Send again touches only venues still waiting.
  assert.ok(fn.includes(".eq('broadcast_id', broadcastId).is('confirmed_at', null).is('withdrawn_at', null).select('id');"));
});

test('Company Admin shows the section, and it calls only the admin function', () => {
  const app = read('src/admin/CompanyAdminApp.jsx');
  assert.ok(app.includes("{ id:'venue-messages', label:'Messages to venues'"));
  assert.ok(app.includes("{section === 'venue-messages' && <AdminVenueMessages />}"));
  const sec = read('src/admin/sections/AdminVenueMessages.jsx');
  assert.ok(sec.includes('`${FUNCTIONS_URL}/venue-messages-admin`'));
  assert.equal(count(sec, ".from('venue_messages')"), 0, 'the admin screen never writes the table itself');
  assert.ok(sec.includes('if (!window.confirm(sendQuestion(picked.length))) return;'));
  assert.ok(sec.includes('expect_count: picked.length, broadcast_id: draftId.current,'));
  // The note is built from what the server WROTE, and a refused retry starts a new draft id.
  assert.ok(sec.includes('setNote(sendResultLine({ sent: res.sent, written: res.written }));'));
  assert.equal(count(sec, 'res.sent ==='), 0);
  const refused = between(sec, "if (e.code === 'already_sent') {", '} finally {');
  assert.ok(refused.includes('draftId.current = newId();') && refused.includes('await load({ quiet: true });'));
});

// ── review fixes, 5 Oct 2026 ────────────────────────────────────────────────

test('venue-messages-admin: one broadcast id is one text, checked BEFORE anything is written', () => {
  const fn = read('supabase/functions/venue-messages-admin/index.ts');
  const send = between(fn, "if (action === 'send') {", "if (action === 'resend' || action === 'withdraw') {");
  const prior = send.indexOf(".select('kind, title, body').eq('broadcast_id', broadcastId).limit(1);");
  const refuse = send.indexOf("if (was && !sameMessage(was, draft)) {");
  const write = send.indexOf('.upsert(rows,');
  assert.ok(prior > 0 && refuse > prior && write > refuse, 'read, compare, then write');
  assert.ok(send.includes("code: 'already_sent' }, 409);"));
  assert.ok(send.includes('written: (data ?? []).length'));
});

test('focus goes to the card, never to Got it, and keys are caught before the screen behind', () => {
  const pop = read('src/components/VenueMessagePopup.jsx');
  const card = read('src/components/VenueMessageCard.jsx');
  // Nothing ever focuses the button on its own (a wedge's Enter on a focused button is a click).
  assert.equal(count(pop, 'okRef.current?.focus('), 0);
  assert.equal(count(pop, 'okRef.current.focus('), 0);
  assert.ok(pop.includes('cardRef.current?.focus({ preventScroll: true });'));
  // The only way focus reaches the button is the Tab rule, which a till never gets.
  assert.equal(count(pop, '.focus('), 2);
  assert.ok(pop.includes("if (action === 'button' && e.type === 'keydown') {"));
  assert.ok(card.includes('ref={rootRef}') && card.includes('tabIndex={preview ? undefined : -1}'));
  assert.equal(count(card, 'autoFocus'), 0);
  // Keys: capture phase on window, propagation stopped for every key, default cancelled unless
  // the rule says otherwise.
  assert.ok(pop.includes("const KEY_EVENTS = ['keydown', 'keypress', 'keyup'];"));
  assert.ok(pop.includes('for (const type of KEY_EVENTS) window.addEventListener(type, onKey, true);'));
  assert.ok(pop.includes('for (const type of KEY_EVENTS) window.removeEventListener(type, onKey, true);'));
  const onKey = between(pop, 'const onKey = (e) => {', '    };');
  assert.ok(onKey.indexOf('e.stopPropagation();') < onKey.indexOf("if (action === 'press' || action === 'browser') return;"));
  assert.ok(onKey.indexOf("if (action === 'press' || action === 'browser') return;") < onKey.indexOf('e.preventDefault();'));
  // The staff card swipe listens on window without capture, so the capture listener is first.
  assert.ok(read('src/lib/useCardScan.js').includes("window.addEventListener('keydown', onKey);"));
  // Got it on a till needs a real press on the button first.
  assert.ok(pop.includes('if (!gotItClickCounts({ host, armed, pressed })) return;'));
  assert.ok(card.includes('onPointerDown={preview ? undefined : onPress}'));
});

test('a saved Got it tap is sent from the always mounted SyncBridge, and a send cannot hang', () => {
  const bridge = read('src/sync/SyncBridge.jsx');
  assert.ok(bridge.includes("import { flushVenueMessageTaps } from '../lib/venueMessageTaps';"));
  assert.equal(count(bridge, 'await flushVenueMessageTaps({ send: confirmVenueMessage });'), 2, 'on coming back online and on the 60 second tick');
  const online = between(bridge, 'const onBackOnline = async () => {', "window.addEventListener('online', onBackOnline);");
  assert.ok(online.includes('await flushVenueMessageTaps({ send: confirmVenueMessage });'));
  // SyncBridge never reads or shows a message: it only names the flush.
  assert.equal(count(bridge, 'VenueMessage'), 6);
  assert.equal(count(bridge, 'fetchVenueMessages'), 0);
  const taps = read('src/lib/venueMessageTaps.js');
  assert.equal(count(taps, 'fetchVenueMessages'), 0);
  assert.equal(count(taps, 'subscribeVenueMessages'), 0);
  assert.ok(taps.includes('if (flushing || liveHooks > 0) return 0;'));
  assert.equal(count(taps, "from './venueMessages"), 0, 'no Supabase in the tap store');
  // The hook tells the flush when it is running.
  const hook = read('src/lib/useVenueMessages.js');
  assert.ok(hook.includes('hookStarted();') && hook.includes('hookStopped();'));
  // 15 seconds, then the send is given up and tried again later.
  const lib = read('src/lib/venueMessages.js');
  assert.ok(lib.includes('await Promise.race(['));
  assert.ok(lib.includes('clearTimeout(timer);'));
  assert.ok(read('src/lib/venueMessageRules.js').includes('export const CONFIRM_TIMEOUT_MS = 15 * 1000;'));
});
