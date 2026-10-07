// supabase/functions/xero-connect/index.ts
//
// Xero connection lifecycle for a venue (location):
//   POST { action }:
//     oauth_start  { locationId, returnUrl } -> { url }   (BO opens it; operator authorises at Xero)
//     status       { locationId }            -> non-secret connection status for the BO
//     disconnect   { locationId }            -> revoke at Xero + delete the stored connection
//     organisations    { locationId }           -> the organisations this site's sign in can see
//     set_organisation { locationId, tenantId } -> post this site to another of them (7 Oct 2026)
//   GET ?code&state  -> Xero's redirect target; verifies state, exchanges the code, reads
//                       the authorised organisation, stores tokens, redirects back to the BO.
//
// 30 Sep 2026: venues connected by the same Xero user share one sign in. Xero supersedes the
// older token set when that user connects again, so the callback writes the new set to every
// row signed in by that Xero user, and disconnect revokes the Xero connection only when no
// other venue uses that organisation (else only this venue's row is removed, and the others
// keep posting).
//
// 7 Oct 2026 (Coffee Boy: two organisations, one sign in, every site stored on the first):
//   - the callback stores the organisation of THIS sign in event (pickConsentedOrg), and the
//     new token set goes to that Xero user's rows on ANY organisation;
//   - a site whose organisation changes (the picker, or connecting again and choosing another)
//     has its Xero setup reset first (resetForNewOrganisation): what named things in the old
//     organisation is cleared and a copy is kept in the sync log (kind 'organisation').
//
// Tokens live only in xero_connections (service-role only) and are never returned to the
// browser. POST actions require a signed-in Ops user WITH access to the location, mirroring
// hubrise-connect / payments-onboard. Deploy with --no-verify-jwt (GET callback is public).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { authorizeUrl, exchangeCode, getConnections, getValidAccessToken, signState, verifyState, XERO_SCOPES } from '../_shared/xero.ts';
import { pickConsentedOrg, organisationChoices, mappingForNewOrganisation, autoDailyAfterOrganisationChange, allowedOrganisations, previousOrganisation } from '../_shared/xeroOrg.js';
import { secondStepRefusal } from '../_shared/second-step.ts';
import { xeroUserIdFromToken, xeroAuthEventIdFromToken } from '../_shared/xeroTokens.js';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CLIENT_ID = Deno.env.get('XERO_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('XERO_CLIENT_SECRET') ?? '';
const APP_BASE = Deno.env.get('XERO_APP_BASE') || 'https://dev.serv-os.app';
const STATE_SECRET = SERVICE_ROLE || 'xero-state';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/xero-connect`;

async function requireAccess(req: Request, opsLocationId: string): Promise<{ ok: true; userId: string; isSuper: boolean } | { ok: false; res: Response }> {
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return { ok: false, res: json({ error: 'Unauthorized' }, 401) };
  if (token === SERVICE_ROLE) return { ok: true, userId: 'service', isSuper: true };
  const { data: { user: caller } } = await sb.auth.getUser(token);
  if (!caller) return { ok: false, res: json({ error: 'Invalid token' }, 401) };
  const [{ data: ul }, { data: prof }] = await Promise.all([
    sb.from('user_locations').select('location_id').eq('user_id', caller.id).eq('location_id', opsLocationId).maybeSingle(),
    sb.from('user_profiles').select('role').eq('id', caller.id).maybeSingle(),
  ]);
  if (!ul && prof?.role !== 'super_admin') return { ok: false, res: json({ error: 'No access to this location' }, 403) };
  return { ok: true, userId: caller.id, isSuper: prof?.role === 'super_admin' };
}

function publicStatus(c: any, moved: any = null) {
  if (!c) return { connected: false, configured: !!CLIENT_ID };
  return {
    connected: true,
    configured: !!CLIENT_ID,
    tenant_name: c.tenant_name,
    tenant_id: c.tenant_id,
    connected_at: c.created_at,
    scopes: c.scopes,
    manager_url: 'https://go.xero.com',
    // The last time this site moved to another organisation, when it is the one it is on now.
    organisation_changed: moved && moved.tenant_id === c.tenant_id ? { at: moved.at, from: moved.from, autoTurnedOff: !!moved.auto_turned_off } : null,
  };
}

// ── The organisation record (xero_sync_log, kind 'organisation') ─────────────
// One row each time a site's organisation changes or it disconnects. It answers "which
// organisation was this site's Xero setup made for" when the connection row is gone, and it
// keeps the setup that a change cleared, so a wrong pick can be put back by hand.
type Org = { id: string; name: string | null };
const ORG_KIND = 'organisation';

async function logOrganisation(locationId: string, detail: Record<string, unknown>) {
  const at = new Date().toISOString();
  const { error } = await sb.from('xero_sync_log').insert({
    location_id: locationId, kind: ORG_KIND, ref_id: `${at}-${crypto.randomUUID().slice(0, 8)}`, status: 'ok', detail: { ...detail, at }, updated_at: at,
  });
  if (error) throw new Error(`Could not record the organisation change: ${error.message}`);
  return at;
}

async function lastOrganisationRecord(locationId: string): Promise<any | null> {
  const { data, error } = await sb.from('xero_sync_log').select('detail,created_at').eq('location_id', locationId).eq('kind', ORG_KIND)
    .order('created_at', { ascending: false }).limit(1);
  // A read that failed is never taken as "no record": the reset it guards would be skipped.
  if (error) throw new Error(`Could not read this site's organisation record: ${error.message}`);
  return data?.[0]?.detail || null;
}

// The Xero organisations already used by a site of the same ServOS company as this one, and
// the site's own name (for the words on screen). See allowedOrganisations.
async function companyOrganisations(locationId: string): Promise<{ tenantIds: string[]; siteName: string | null }> {
  const { data: me, error } = await sb.from('locations').select('org_id,name').eq('id', locationId).maybeSingle();
  if (error) throw new Error(`Could not read this site: ${error.message}`);
  if (!me?.org_id) return { tenantIds: [], siteName: me?.name || null };
  const { data: sites, error: sErr } = await sb.from('locations').select('id').eq('org_id', me.org_id);
  if (sErr) throw new Error(`Could not read this company's sites: ${sErr.message}`);
  const ids = (sites || []).map((r: any) => r.id);
  if (!ids.length) return { tenantIds: [], siteName: me.name || null };
  const { data: rows, error: cErr } = await sb.from('xero_connections').select('tenant_id').in('location_id', ids);
  if (cErr) throw new Error(`Could not read this company's Xero connections: ${cErr.message}`);
  return { tenantIds: [...new Set((rows || []).map((r: any) => r.tenant_id).filter(Boolean))] as string[], siteName: me.name || null };
}

// The site is about to post to another organisation. Order matters: the copy is written first
// (nothing is cleared without one), then the setup is cleared. The caller changes the
// organisation only after this returns, so a failure part way leaves the site Not Ready on its
// OLD organisation (safe), never posting to the new one with the old one's choices.
async function resetForNewOrganisation(locationId: string, prev: Org, next: Org, via: string, by: string | null) {
  const { data: cfg, error: readErr } = await sb.from('xero_config').select('mapping,detail,auto_daily,post_mode').eq('location_id', locationId).maybeSingle();
  if (readErr) throw new Error(`Could not read this site's Xero setup: ${readErr.message}`);
  const autoAfter = cfg ? autoDailyAfterOrganisationChange(cfg.post_mode, cfg.auto_daily, cfg.mapping?.invoiceStartDate, new Date().toISOString().slice(0, 10)) : false;
  await logOrganisation(locationId, {
    via, by, tenant_id: next.id, tenant_name: next.name, from: prev.name || prev.id, from_tenant_id: prev.id,
    auto_turned_off: !!cfg?.auto_daily && !autoAfter,
    cleared: cfg ? { mapping: cfg.mapping ?? null, detail: cfg.detail ?? null, auto_daily: !!cfg.auto_daily, post_mode: cfg.post_mode ?? null } : null,
  });
  if (cfg) {
    const { error } = await sb.from('xero_config').update({
      mapping: mappingForNewOrganisation(cfg.mapping), detail: {}, auto_daily: autoAfter, updated_at: new Date().toISOString(),
    }).eq('location_id', locationId);
    if (error) throw new Error(`Could not clear this site's Xero setup: ${error.message}`);
  }
  return { hadSetup: !!cfg, autoTurnedOff: !!cfg?.auto_daily && !autoAfter, postMode: cfg?.post_mode === 'sales_invoice' ? 'sales_invoice' : 'bank_tx' };
}

function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { ...cors, Location: url } });
}
function withParam(u: string, k: string, v: string): string {
  return u + (u.includes('?') ? '&' : '?') + `${k}=${encodeURIComponent(v)}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  const url = new URL(req.url);

  // ── GET = Xero OAuth callback (browser redirect) ──────────────────────────────
  if (req.method === 'GET') {
    const err = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state') || '';
    const payload = await verifyState(STATE_SECRET, state);
    const ret = (payload?.ret && typeof payload.ret === 'string') ? payload.ret : APP_BASE;
    if (err) return redirect(withParam(ret, 'xero', 'error'));
    if (!code || !payload || !payload.loc) return redirect(withParam(ret, 'xero', 'invalid'));
    // Freshness: state must be < 10 minutes old.
    if (!payload.ts || (Date.now() - Number(payload.ts)) > 10 * 60 * 1000) return redirect(withParam(ret, 'xero', 'expired'));
    try {
      const t = await exchangeCode(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, code);
      const tokenSet = {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: new Date(Date.now() + (t.expires_in || 1800) * 1000).toISOString(),
        scopes: t.scope || XERO_SCOPES,
        updated_at: new Date().toISOString(),
      };
      // 1. The new set supersedes this Xero user's older one, so it goes to every row that user
      //    signed in, on any organisation, straight after the exchange and before anything that
      //    can fail (reading the organisations, the reset): those sites keep posting whatever
      //    happens to this sign in.
      const uid = xeroUserIdFromToken(t.access_token);
      if (uid) {
        try {
          const { data: all, error: allErr } = await sb.from('xero_connections').select('location_id,access_token');
          if (allErr) throw new Error(allErr.message);
          const same = (all || []).filter((r: any) => xeroUserIdFromToken(r.access_token) === uid).map((r: any) => r.location_id);
          if (same.length) {
            const { error: sErr } = await sb.from('xero_connections').update(tokenSet).in('location_id', same);
            if (sErr) throw new Error(sErr.message);
          }
        } catch (e) { console.error('[xero-connect] the new token set did not reach the sites sharing this sign in:', (e as Error)?.message || e); }
      }
      const conns = await getConnections(t.access_token);
      // The organisation of THIS sign in event (chosen on Xero's consent screen), not the first
      // one this Xero user ever authorised: a group with two organisations got the wrong one.
      const org = pickConsentedOrg(conns, xeroAuthEventIdFromToken(t.access_token));
      if (!org) return redirect(withParam(ret, 'xero', 'no_org'));
      // 2. This site. If it is moving to another organisation (signed in again and another one
      //    chosen, or disconnected from one and connected to another), its Xero setup is reset
      //    first, so nothing chosen for the old organisation is ever posted into the new one.
      //    The organisation the setup was made for: the connection row, else the last
      //    organisation record, else the organisation the cached setup itself names.
      const { data: existing, error: exErr } = await sb.from('xero_connections').select('tenant_id,tenant_name').eq('location_id', payload.loc).maybeSingle();
      if (exErr) throw new Error(`Could not read the Xero connection: ${exErr.message}`);
      let record: any = null, cached: any = null;
      if (!existing) {
        record = await lastOrganisationRecord(payload.loc);
        const { data: cfg0, error: cfgErr } = await sb.from('xero_config').select('detail').eq('location_id', payload.loc).maybeSingle();
        if (cfgErr) throw new Error(`Could not read this site's Xero setup: ${cfgErr.message}`);
        cached = cfg0?.detail || null;
      }
      const prev: Org | null = previousOrganisation({ row: existing, record, detail: cached });
      const by = payload.uid && payload.uid !== 'service' ? payload.uid : null;
      if (prev && prev.id !== org.tenantId) {
        await resetForNewOrganisation(payload.loc, prev, { id: org.tenantId, name: org.tenantName || null }, 'connect', by);
      }
      const { error: upErr } = await sb.from('xero_connections').upsert({
        location_id: payload.loc,
        tenant_id: org.tenantId,
        tenant_name: org.tenantName || null,
        ...tokenSet,
        connected_by: by,
      }, { onConflict: 'location_id' });
      if (upErr) throw new Error(`Could not store the Xero connection: ${upErr.message}`);
      return redirect(withParam(ret, 'xero', 'connected'));
    } catch (e) {
      console.error('[xero-connect] callback', (e as Error)?.message || e);
      return redirect(withParam(ret, 'xero', 'error'));
    }
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const action = body.action;
  const locationId = body.locationId;
  if (!locationId) return json({ error: 'locationId required' }, 400);

  const acc = await requireAccess(req, locationId);
  if (!acc.ok) return acc.res;

  if (action === 'oauth_start') {
    if (!CLIENT_ID || !CLIENT_SECRET) return json({ error: 'Xero is not configured yet (missing XERO_CLIENT_ID / XERO_CLIENT_SECRET).' }, 400);
    const returnUrl = (typeof body.returnUrl === 'string' && body.returnUrl.startsWith('http')) ? body.returnUrl : APP_BASE;
    const state = await signState(STATE_SECRET, { loc: locationId, ret: returnUrl, uid: acc.userId, ts: Date.now(), n: crypto.randomUUID() });
    return json({ url: authorizeUrl(CLIENT_ID, REDIRECT_URI, state) });
  }

  if (action === 'status') {
    const { data: c } = await sb.from('xero_connections').select('*').eq('location_id', locationId).maybeSingle();
    const last = c ? await lastOrganisationRecord(locationId).catch(() => null) : null;
    return json(publicStatus(c, last && last.via !== 'disconnect' ? last : null));
  }

  // ── organisations: every Xero organisation this site's stored sign in can see ──
  if (action === 'organisations') {
    const { data: c } = await sb.from('xero_connections').select('tenant_id, tenant_name').eq('location_id', locationId).maybeSingle();
    if (!c) return json({ connected: false, organisations: [] });
    // lookupError, not error: the screen must still show where the site posts when Xero cannot
    // be asked, and must not then say this is the only organisation (it does not know).
    const own = [{ tenantId: c.tenant_id, tenantName: c.tenant_name || c.tenant_id, current: true }];
    try {
      const company = await companyOrganisations(locationId);
      const { accessToken } = await getValidAccessToken(sb, locationId, CLIENT_ID, CLIENT_SECRET);
      const conns = await getConnections(accessToken);
      const all = organisationChoices(conns, c.tenant_id);
      const organisations = allowedOrganisations(all, company.tenantIds, c.tenant_id, acc.isSuper);
      return json({ connected: true, current: c.tenant_id, siteName: company.siteName, organisations: organisations.length ? organisations : own, others: all.length - organisations.length });
    } catch (e) {
      return json({ connected: true, current: c.tenant_id, organisations: own, lookupError: (e as Error)?.message || String(e) });
    }
  }

  // ── set_organisation: post this site's sales to another organisation the same sign in can see ──
  // The stored tokens are the Xero user's, so they reach every organisation that user has
  // connected; only this site's organisation changes, and it keeps sharing the one token set
  // with its old siblings (xero.ts rotates by refresh token, on any organisation). The site's
  // Xero setup is reset FIRST (resetForNewOrganisation), then the organisation is changed.
  // Days already posted stay in the old organisation's books and stay posted in the log.
  if (action === 'set_organisation') {
    const tenantId = String(body.tenantId || '').trim();
    if (!tenantId) return json({ error: 'tenantId required' }, 400);
    const { data: c } = await sb.from('xero_connections').select('tenant_id, tenant_name').eq('location_id', locationId).maybeSingle();
    if (!c) return json({ error: 'This site is not connected to Xero.' }, 400);
    if (c.tenant_id === tenantId) return json({ ok: true, unchanged: true, tenant_id: c.tenant_id, tenant_name: c.tenant_name });
    try {
      const { accessToken } = await getValidAccessToken(sb, locationId, CLIENT_ID, CLIENT_SECRET);
      const conns = await getConnections(accessToken);
      const company = await companyOrganisations(locationId);
      const org = allowedOrganisations(organisationChoices(conns, c.tenant_id), company.tenantIds, c.tenant_id, acc.isSuper).find((o) => o.tenantId === tenantId);
      if (!org) return json({ error: 'That organisation cannot be chosen from the list for this site. Use "Sign in to Xero and choose it" and pick it on Xero\'s screen.' }, 400);
      const res = await resetForNewOrganisation(locationId, { id: c.tenant_id, name: c.tenant_name }, { id: org.tenantId, name: org.tenantName }, 'picker', acc.userId === 'service' ? null : acc.userId);
      const { error: uErr } = await sb.from('xero_connections').update({ tenant_id: org.tenantId, tenant_name: org.tenantName }).eq('location_id', locationId);
      if (uErr) return json({ error: `This site's Xero setup was cleared, but the organisation could not be changed: ${uErr.message}. Press again.` }, 500);
      return json({ ok: true, tenant_id: org.tenantId, tenant_name: org.tenantName, previous: c.tenant_name || c.tenant_id, autoTurnedOff: res.autoTurnedOff, postMode: res.postMode, siteName: company.siteName });
    } catch (e) {
      return json({ error: (e as Error)?.message || String(e) }, 502);
    }
  }

  if (action === 'disconnect') {
    const { data: c } = await sb.from('xero_connections').select('*').eq('location_id', locationId).maybeSingle();
    let shared = 0;
    if (c) {
      // Another venue on the same Xero organisation still posts through this connection: only
      // this venue's copy is removed. Otherwise revoke at Xero too (best effort).
      const { data: others } = await sb.from('xero_connections').select('location_id').eq('tenant_id', c.tenant_id).neq('location_id', locationId);
      shared = (others || []).length;
      if (!shared) {
        try {
          const conns = await getConnections(c.access_token);
          const match = conns.find((x: any) => x.tenantId === c.tenant_id);
          if (match?.id) await fetch(`https://api.xero.com/connections/${match.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${c.access_token}` } });
        } catch { /* token may be stale; still drop our copy */ }
      }
      // Which organisation this site's Xero setup was made for, kept for when it connects again
      // (to another one = the setup is reset). Best effort: a failed note never blocks a disconnect.
      await logOrganisation(locationId, { via: 'disconnect', by: acc.userId === 'service' ? null : acc.userId, tenant_id: c.tenant_id, tenant_name: c.tenant_name }).catch((e) => console.warn('[xero-connect] organisation note', (e as Error)?.message || e));
      await sb.from('xero_connections').delete().eq('location_id', locationId);
    }
    return json({ ok: true, connected: false, keptForOtherSites: shared });
  }

  return json({ error: 'Unknown action' }, 400);
});
