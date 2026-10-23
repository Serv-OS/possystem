// supabase/functions/xero-stock-journal/index.ts
//
// MULTI SITE STOCK Drop 4b (release 5.11.100, contract 4): the closing stock journal to Xero, one per
// legal company (the Xero organisation its sites are connected to) per month, from Reports > Stock and GP >
// Month end. It is ALWAYS a DRAFT ManualJournal: nothing is posted in Xero until the accountant posts it.
// There is no cron: a person presses Send. Nothing here posts anything by itself.
// MARKER 5.11.100 xero-stock-journal draft only
//
//   POST { action: 'preview' | 'send', orgId, from, to, tenantId, stockAccount?, movementAccount? }
//   with the Back Office login's bearer (the second step applies).
//
//   preview -> { status: 'not_connected' | 'needs_reconnect' | 'not_locked' | 'sent' | 'ready', words, amount,
//                narration, accounts: [{ code, name, type }], suggested: { stockAccount, movementAccount },
//                last: { stockAccount, movementAccount } | null, legal }
//   send    -> { ok: true, status: 'sent', xero_journal_id } or { ok: false, status, error }
//
// Who may: the database decides. stock_month_end_journal is called AS THE LOGIN (the report guard, and
// Stock control 'all' or the company's owner: 'Only head office sends the closing stock journal.'). The
// Xero token is read with the service role from the legal company's own connected site, and what was
// sent is written with stock_month_end_journal_record (service role only; a second send of a month is
// refused there too). A Xero 401 or 403 answers needs_reconnect: 'Reconnect Xero to allow stock journals.'
//
// Deploy (manual, the function checks the login itself):
//   npx supabase functions deploy xero-stock-journal --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getValidAccessToken, xeroApi } from '../_shared/xero.ts';
import { secondStepRefusal } from '../_shared/second-step.ts';
import { bearerOf } from '../_shared/cronKey.js';
import {
  accountList, suggestAccounts, journalBody, journalKey, journalStatus, sendRefusal, needsReconnect, journalIdOf, STATUS_WORDS,
} from '../_shared/xeroStockJournal.js';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CLIENT_ID = Deno.env.get('XERO_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('XERO_CLIENT_SECRET') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const errText = (e: unknown) => String((e as any)?.message || e || 'failed').slice(0, 500);

// The legal company's row from the database, asked as the login.
async function legalOf(token: string, orgId: string, from: string, to: string, tenantId: string): Promise<{ legal?: any; error?: string; status?: number }> {
  const asUser = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  const { data, error } = await asUser.rpc('stock_month_end_journal', { p_org: orgId, p_from: from, p_to: to });
  if (error) {
    const missing = /PGRST202|42883|could not find the function|schema cache/i.test(`${error.code || ''} ${error.message || ''}`);
    return { error: missing ? 'Month end needs a ServOS update.' : (error.message || 'Could not read the month.'), status: missing ? 503 : (error.code === '42501' ? 403 : 400) };
  }
  const legal = (Array.isArray(data?.legal) ? data.legal : []).find((x: any) => String(x?.tenant_id ?? '') === String(tenantId));
  if (!legal) return { error: 'That legal company is not in these sites.', status: 404 };
  return { legal };
}

// The last accounts used for this legal company (the newest sent journal), for the form.
async function lastAccounts(orgId: string, tenantId: string) {
  const { data } = await sb.from('stock_month_end_journals').select('stock_account, movement_account, period')
    .eq('org_id', orgId).eq('tenant_id', tenantId).eq('status', 'sent').order('period', { ascending: false }).limit(1);
  const r = Array.isArray(data) ? data[0] : null;
  return r && (r.stock_account || r.movement_account) ? { stockAccount: r.stock_account || null, movementAccount: r.movement_account || null } : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const token = bearerOf(req.headers.get('Authorization'));
  if (!token || token === SERVICE_ROLE) return json({ error: 'Sign in to Back Office to send the closing stock journal.' }, 401);
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user || (user as any).is_anonymous === true) return json({ error: 'Sign in to Back Office to send the closing stock journal.' }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const { action, orgId, from, to, tenantId } = body || {};
  if (action !== 'preview' && action !== 'send') return json({ error: 'Unknown action.' }, 400);
  if (!UUID.test(String(orgId || '')) || !YMD.test(String(from || '')) || !YMD.test(String(to || '')) || String(from) > String(to)) {
    return json({ error: 'Pick the month first.' }, 400);
  }
  if (!tenantId) return json({ ok: false, status: 'not_connected', words: STATUS_WORDS.not_connected, error: STATUS_WORDS.not_connected });

  const got = await legalOf(token, String(orgId), String(from), String(to), String(tenantId));
  if (!got.legal) return json({ error: got.error }, got.status || 400);
  const legal = got.legal;
  const st = journalStatus(legal);

  if (action === 'preview') {
    const base = { status: st.status, words: st.words, amount: legal.amount ?? null, narration: legal.narration ?? null, legal };
    if (st.status === 'not_connected' || st.status === 'needs_reconnect') return json({ ...base, accounts: [], suggested: { stockAccount: null, movementAccount: null }, last: null });
    try {
      const { accessToken, tenantId: tid } = await getValidAccessToken(sb, String(legal.connection_location_id), CLIENT_ID, CLIENT_SECRET);
      if (String(tid) !== String(tenantId)) return json({ ...base, status: 'not_connected', words: STATUS_WORDS.not_connected, accounts: [], suggested: { stockAccount: null, movementAccount: null }, last: null });
      const ans = await xeroApi(accessToken, String(tid), '/Accounts');
      const accounts = Array.isArray(ans?.Accounts) ? ans.Accounts : [];
      return json({ ...base, accounts: accountList(accounts), suggested: suggestAccounts(accounts), last: await lastAccounts(String(orgId), String(tenantId)) });
    } catch (e) {
      if (needsReconnect(e)) return json({ ...base, status: 'needs_reconnect', words: STATUS_WORDS.needs_reconnect, accounts: [], suggested: { stockAccount: null, movementAccount: null }, last: null });
      return json({ ...base, error: `Could not read the Xero accounts: ${errText(e)}` }, 502);
    }
  }

  // send: one DRAFT ManualJournal, never posted
  const stockAccount = body.stockAccount ? String(body.stockAccount) : null;
  const movementAccount = body.movementAccount ? String(body.movementAccount) : null;
  const no = sendRefusal(legal, { stockAccount, movementAccount });
  if (no) return json({ ok: false, status: st.status, error: no });
  let journal: any;
  try {
    journal = journalBody({ amount: legal.amount, date: String(to), narration: legal.narration, stockAccount, movementAccount });
  } catch (e) {
    return json({ ok: false, status: st.status, error: errText(e) });
  }
  const byName = (user as any).user_metadata?.full_name || user.email || null;
  const record = (patch: Record<string, unknown>) => sb.rpc('stock_month_end_journal_record', {
    p_org: orgId, p_from: from, p_to: to, p_tenant: String(tenantId),
    p_patch: { amount: legal.amount, stock_account: stockAccount, movement_account: movementAccount, sent_by: user.id,
               sent_by_name: byName, ...patch },
  });
  // Claim the legal company's month BEFORE calling Xero (one send at a time, whatever the accounts): a
  // second call while this one runs is refused 'This journal is already being sent.', a sent month for good.
  const { error: claimErr } = await sb.rpc('stock_month_end_journal_claim', {
    p_org: orgId, p_from: from, p_to: to, p_tenant: String(tenantId), p_by: user.id, p_by_name: byName,
  });
  if (claimErr) {
    const msg = String(claimErr.message || '');
    if (/already being sent/i.test(msg)) return json({ ok: false, status: 'sending', error: STATUS_WORDS.sending });
    if (/already sent/i.test(msg)) return json({ ok: false, status: 'sent', error: STATUS_WORDS.already });
    return json({ ok: false, status: st.status, error: msg || 'Could not start the send.' }, 400);
  }
  let xeroId: string | null = null;
  try {
    const { accessToken, tenantId: tid } = await getValidAccessToken(sb, String(legal.connection_location_id), CLIENT_ID, CLIENT_SECRET);
    if (String(tid) !== String(tenantId)) {
      await record({ status: 'failed', error: STATUS_WORDS.not_connected });
      return json({ ok: false, status: 'not_connected', error: STATUS_WORDS.not_connected });
    }
    const ans = await xeroApi(accessToken, String(tid), '/ManualJournals', {
      method: 'PUT', body: JSON.stringify(journal), idempotencyKey: journalKey(String(orgId), String(from), String(tenantId), { stockAccount, movementAccount, amount: legal.amount }),
    });
    xeroId = journalIdOf(ans);
    if (!xeroId) throw new Error('Xero did not return the journal.');
  } catch (e) {
    const reconnect = needsReconnect(e);
    await record({ status: 'failed', error: reconnect ? STATUS_WORDS.needs_reconnect : errText(e) });
    if (reconnect) return json({ ok: false, status: 'needs_reconnect', error: STATUS_WORDS.needs_reconnect });
    return json({ ok: false, status: 'failed', error: `Xero did not take the journal: ${errText(e)}` }, 502);
  }
  const { error: recErr } = await record({ status: 'sent', xero_journal_id: xeroId });
  if (recErr) {
    // The draft is in Xero (a repeat send returns the same draft through the idempotency key).
    return json({ ok: true, status: 'sent', xero_journal_id: xeroId, warning: `Sent to Xero as a draft, but ServOS could not note it: ${recErr.message}` });
  }
  return json({ ok: true, status: 'sent', xero_journal_id: xeroId });
});
