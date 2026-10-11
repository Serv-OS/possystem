// supabase/functions/vat-check/index.ts
//
// THE DAILY VAT CHECK (8 Oct 2026, the VAT audit, plan section 4 "a daily check that tells ServOS").
//
// Peter, 8 Oct 2026: "VAT despite the order type should follow the Tax rules set on the back
// office per menu item." "Fix once and right." Every channel now books the VAT the Back Office
// item rules say (Lanes A to C) and the reports read it one way (Lane D). This function is the
// morning after: it reads the last completed business day's sales at every venue that has tax
// rates, works each sale's VAT out again from its stored lines with the till's rule
// (_shared/vatRederive.js, pinned against the real engine), and says what it found:
//   - one row per venue per day in vat_check_runs (the counts and the named sales);
//   - when a sale was booked with no VAT, or with a figure its items do not give, one plain
//     message to the venue (venue_messages, which pops up in Back Office and Company Admin
//     lists): "1 sale was booked with no VAT at Coffee Boy Preston yesterday: QR-4OGI7. ...".
//     Written once per venue and day (the id is worked out from them), so a second run says
//     nothing twice.
// NOTHING IS CHANGED BY IT. It reads, counts and tells. The records stay as the till wrote them.
//
//   POST { action: 'daily' }                       every venue with rates, its last completed day
//   POST { action: 'venue', locationId, date? }    one venue, one business day (default: last completed)
// Service role (pg_cron through call_edge_fn, 20261009c) or a super admin. A Back Office login
// with access to the venue may run 'venue' for its own site. Deploy --no-verify-jwt.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { venueClock, venueTaxRates } from '../_shared/accountingData.ts';
import { pagedRows } from '../_shared/pagedRows.js';
import { businessDayWindow, lastCompletedBusinessDay, isYmd } from '../_shared/businessDay.js';
import { menuIndex } from '../_shared/vatRederive.js';
import { checkVenueDay, vatCheckMessage, vatCheckNoticeId, vatCheckRunRow, needsMessage } from '../_shared/vatCheck.js';
import { gapDayWords } from '../_shared/xeroGaps.js';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const platform = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

// What the check reads of a sale: the lines and the money the till's rule reads, the VAT it
// booked, and the record behind it. No customer, no tenders.
const SALE_COLS = 'id,ref,closed_at,order_type,source,status,voided,total,subtotal,tip,service,items,discounts,tax_amount,tax_breakdown';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Caller = { service: boolean; superAdmin: boolean; userId: string | null };

async function whoIs(req: Request): Promise<Caller | null> {
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return null;
  if (token === SERVICE_ROLE) return { service: true, superAdmin: true, userId: null };
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user) return null;
  const { data: prof } = await sb.from('user_profiles').select('role').eq('id', user.id).maybeSingle();
  return { service: false, superAdmin: prof?.role === 'super_admin', userId: user.id };
}

async function mayOpen(caller: Caller, locationId: string): Promise<boolean> {
  if (caller.service || caller.superAdmin) return true;
  const { data } = await sb.from('user_locations').select('location_id').eq('user_id', caller.userId).eq('location_id', locationId).maybeSingle();
  return !!data;
}

/** Venues that have tax rates: the only ones the rule says must book VAT. { id, name }. */
async function venuesWithRates(): Promise<{ id: string; name: string }[]> {
  const [{ data: rates, error: rErr }, { data: locs, error: lErr }] = await Promise.all([
    sb.from('tax_rates').select('location_id').eq('active', true).limit(5000),
    sb.from('locations').select('id,name').limit(500),
  ]);
  if (rErr) throw new Error(`Could not read the tax rates: ${rErr.message}`);
  if (lErr) throw new Error(`Could not read the venues: ${lErr.message}`);
  const withRates = new Set((rates || []).map((r: any) => String(r.location_id)));
  return (locs || []).filter((l: any) => withRates.has(String(l.id))).map((l: any) => ({ id: String(l.id), name: l.name || 'Venue' }));
}

/** Does this venue use tax profiles (the mirror reads rates only, so figures are not judged)? */
async function profilesInUse(locationId: string): Promise<boolean> {
  const { data, error } = await sb.from('tax_profiles').select('id').eq('location_id', locationId).limit(1);
  if (error) return false;   // no table, or unreadable: judged on rates, as every UK venue is
  return (data || []).length > 0;
}

/** One venue, one business day: read, judge, record, tell. Nothing is changed in the sales. */
async function checkVenue(venue: { id: string; name: string }, dateAsked: string | null, now: number) {
  const clock = await venueClock(platform, venue.id);
  const date = dateAsked && isYmd(dateAsked) ? dateAsked : lastCompletedBusinessDay(now, clock.timezone, clock.dayStart);
  const day = businessDayWindow(date, clock.timezone, clock.dayStart);
  if (!UUID.test(venue.id)) return { locationId: venue.id, venue: venue.name, date, skipped: 'not a venue id' };
  const [rows, rates, menuRows, profiles] = await Promise.all([
    pagedRows('closed checks', () => sb.from('closed_checks').select(SALE_COLS).eq('location_id', venue.id).gte('closed_at', day.fromIso).lt('closed_at', day.toIso).order('closed_at').order('id')),
    venueTaxRates(sb, venue.id),
    pagedRows('menu items', () => sb.from('menu_items').select('id,parent_id,tax_rate_id,tax_overrides').eq('location_id', venue.id).order('id')),
    profilesInUse(venue.id),
  ]);
  const summary = checkVenueDay(rows, { rates, menu: menuIndex(menuRows), profilesInUse: profiles, date, venue: venue.name });
  const ranAt = new Date().toISOString();

  // The message, once per venue and day. A venue_messages table that is not there yet (the
  // 20261005a update not run) is not an error: the run row still says what was found.
  let messageId: string | null = null;
  let messageWritten = false;
  if (needsMessage(summary)) {
    const msg = vatCheckMessage(summary, { venueName: venue.name, dayWords: `on ${gapDayWords(date)}` })!;
    const broadcastId = vatCheckNoticeId(venue.id, date);
    const { data, error } = await sb.from('venue_messages')
      .upsert([{ broadcast_id: broadcastId, location_id: venue.id, kind: msg.kind, title: msg.title, body: msg.body, sent_by: null, sent_by_name: 'ServOS VAT check', sent_at: ranAt }], { onConflict: 'broadcast_id,location_id', ignoreDuplicates: true })
      .select('id');
    if (error) {
      if (!/venue_messages/.test(String(error.message || ''))) console.warn('[vat-check] could not write the venue message:', error.message);
    } else {
      messageWritten = (data || []).length > 0;
    }
    const { data: existing } = await sb.from('venue_messages').select('id').eq('broadcast_id', broadcastId).eq('location_id', venue.id).maybeSingle();
    messageId = existing?.id || null;
  }

  // The run row. A vat_check_runs table that is not there yet (20261009c not run) is said, not thrown.
  const row = vatCheckRunRow(summary, { locationId: venue.id, ranAt, messageId });
  const { error: runErr } = await sb.from('vat_check_runs').upsert(row, { onConflict: 'location_id,business_day' });
  const recorded = !runErr;
  if (runErr && !/vat_check_runs/.test(String(runErr.message || ''))) console.warn('[vat-check] could not write the run row:', runErr.message);

  return {
    locationId: venue.id, venue: venue.name, date, sales: summary.sales, ok: summary.ok, penny: summary.penny,
    noVat: summary.noVat, noVatRefs: summary.noVatRefs, differs: summary.differs, differsRefs: summary.differsRefs,
    noRecord: summary.noRecord, notChecked: summary.notChecked, fallbacks: summary.fallbacks, foreign: summary.foreign,
    repaired: summary.repaired, server: summary.server, profilesInUse: summary.profilesInUse,
    message: needsMessage(summary) ? { written: messageWritten, id: messageId } : null, recorded,
    ...(runErr ? { runError: runErr.message } : {}),
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* an empty body is the daily run */ }
  const caller = await whoIs(req);
  if (!caller) return json({ error: 'Unauthorized' }, 401);
  const action = body.action || 'daily';
  const now = Date.now();
  try {
    if (action === 'venue') {
      const locationId = String(body.locationId || body.location_id || '');
      if (!locationId) return json({ error: 'locationId required' }, 400);
      if (!(await mayOpen(caller, locationId))) return json({ error: 'No access to this location' }, 403);
      const { data: loc } = await sb.from('locations').select('id,name').eq('id', locationId).maybeSingle();
      const out = await checkVenue({ id: locationId, name: loc?.name || 'Venue' }, body.date || null, now);
      return json({ ok: true, at: new Date(now).toISOString(), venues: [out] });
    }
    if (action !== 'daily') return json({ error: `Unknown action ${action}` }, 400);
    if (!caller.service && !caller.superAdmin) return json({ error: 'The daily run is for the server or a super admin' }, 403);
    const venues = await venuesWithRates();
    const results: any[] = [];
    // One venue at a time: a quiet morning read, never a burst on the database the tills use.
    for (const v of venues) {
      try { results.push(await checkVenue(v, body.date || null, now)); }
      catch (e) { results.push({ locationId: v.id, venue: v.name, error: (e as Error)?.message || String(e) }); }
    }
    const told = results.filter((r) => r.message?.written).length;
    const noVat = results.reduce((s, r) => s + (r.noVat || 0), 0);
    const differs = results.reduce((s, r) => s + (r.differs || 0), 0);
    console.log(`[vat-check] ${venues.length} venue(s): ${noVat} with no VAT, ${differs} differ, ${told} message(s) written`);
    return json({ ok: true, at: new Date(now).toISOString(), venues: results, totals: { venues: venues.length, noVat, differs, messagesWritten: told } });
  } catch (e) {
    return json({ ok: false, error: (e as Error)?.message || String(e) }, 500);
  }
});
