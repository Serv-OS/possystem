// supabase/functions/gift-list/index.ts
//
// v5.5.200: List gift cards for the caller's org with filtering.
// Body: { limit?, status?, source?, batch_name?, search?, location_id, action? }
//   limit      : max results (default 500, max 1000)
//   status     : filter 'active', 'redeemed', 'voided', 'expired'
//   source     : filter 'manual', 'online', 'bulk', 'import'
//   batch_name : partial match on batch name
//   search     : search code_last4, recipient_name, or recipient_email
//   action     : 'purchases' gives the Back Office "Online purchases" list instead (contract P3)
//
// STAFF ONLY, every action (database fence stage 1, 19 Sep 2026, enforced always). This returns
// code_plain and the recipient's name, email and phone for every card of the company, and it used
// to answer ANY session, anonymous included, for any public location_id: a full dump of spendable
// codes. Its callers are Back Office GiftCards.jsx (All cards, Online purchases) and
// Customers.jsx (a customer's cards), both signed in staff that send the active venue. Staff is
// the database's rule (user_locations to the venue, or a verified super admin; never an
// anonymous session) plus a Platform company role for the venue's company
// (_shared/staffAccess.ts, _shared/gift-authority.ts decideGiftListAuthority).

import {
  cors, json, platformAdmin, authenticateCaller, resolveCompanyForLocation,
} from '../_shared/gift-card-utils.ts';
import { PURCHASE_LIST_COLUMNS } from '../_shared/companyStaffAccess.js';
import { callerIsStaffFor, recordAuthority } from '../_shared/loyalty-utils.ts';
import { decideGiftListAuthority } from '../_shared/gift-authority.ts';
import { authorityLogRow } from '../_shared/loyalty-authority.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authResult = await authenticateCaller(req);
  if (authResult instanceof Response) return authResult;
  const caller = authResult.user;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body OK */ }

  // v5.5.207: resolve company via location_id (reliable) with user fallback
  const companyResult = await resolveCompanyForLocation(caller.id, body.location_id as string);
  if (companyResult instanceof Response) return companyResult;
  const companyId = companyResult;

  // ── Staff only (stage 1, enforced always), before anything is read ─────
  const staff = await callerIsStaffFor(caller, (body.location_id as string) || null, companyId);
  const authority = decideGiftListAuthority({ user: caller, staff });
  if (!authority.ok) {
    recordAuthority(authorityLogRow({
      fn: 'gift-list', mode: 'enforce', outcome: 'refused',
      decision: { ok: false, reason: authority.reason, callerKind: caller?.is_anonymous ? 'anonymous' : 'user_no_access' },
      user: caller, companyId, locationId: body.location_id,
    }));
    return json({ error: authority.error }, authority.status);
  }

  // ── purchases: the Back Office "Online purchases" list (contract P3) ─────
  // The columns the screen shows, NOT fulfilled_code (a spendable code). After 20260919d the
  // browser cannot read gift_card_purchases at all. 'fulfilling' (gift-fulfill's claim while it
  // issues the card) reads as 'paid', the status the screen knows.
  if (body.action === 'purchases' || body.kind === 'purchases') {
    if (!body.location_id) return json({ error: 'location_id required' }, 400);
    const { data: rows, error: pErr } = await platformAdmin
      .from('gift_card_purchases')
      .select(PURCHASE_LIST_COLUMNS)
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(Math.min(Number(body.limit) || 50, 200));
    if (pErr) return json({ error: pErr.message }, 500);
    const purchases = ((rows as any[]) ?? []).map((r) => ({ ...r, status: r.status === 'fulfilling' ? 'paid' : r.status }));
    return json({ purchases });
  }

  const limit = Math.min(Number(body.limit) || 500, 1000);

  let query = platformAdmin
    .from('gift_cards')
    .select('id, code_last4, code_plain, initial_amount_minor, balance_minor, status, issued_at, expires_at, recipient_name, recipient_email, recipient_phone, note, source, batch_name, batch_id, created_at')
    .eq('company_id', companyId);

  // Apply filters
  if (body.status && typeof body.status === 'string') {
    query = query.eq('status', body.status);
  }
  if (body.source && typeof body.source === 'string') {
    query = query.eq('source', body.source);
  }
  if (body.batch_name && typeof body.batch_name === 'string') {
    query = query.ilike('batch_name', `%${body.batch_name}%`);
  }
  if (body.search && typeof body.search === 'string') {
    const s = body.search as string;
    query = query.or(`code_last4.ilike.%${s}%,recipient_name.ilike.%${s}%,recipient_email.ilike.%${s}%,recipient_phone.ilike.%${s}%`);
  }

  const { data, error: err } = await query
    .order('created_at', { ascending: false })
    .limit(limit);

  if (err) return json({ error: err.message }, 500);

  return json({ cards: data ?? [], total: data?.length ?? 0 });
});
