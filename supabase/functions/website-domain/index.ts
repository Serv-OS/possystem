// supabase/functions/website-domain/index.ts
// MARKER 5.12.0 website builder custom domains
//
// A venue brings its own domain (we never sell domains). Contract: docs/website-builder/
// ARCHITECTURE.md section 3.
//
// WHAT HAPPENS ON check_domain {custom_domain}
//   1. The hostname is cleaned and checked (www.mozzpizza.com). Our own hosts are refused.
//   2. The records list is built: www host = CNAME www -> sites.serv-os.app and A @ -> 76.76.21.21;
//      any other host = one CNAME.
//   3. Both names are registered on the Vercel project (POST /v10/projects/{id}/domains). 409
//      "already exists" counts as done. A TXT verification record Vercel asks for is appended.
//   4. Live DNS is read over HTTPS (dns.google/resolve) and each record gets ok true or false.
//   5. GET /v9/projects/{id}/domains/{name}/config says whether the certificate side is ready.
//   6. domain_status is stored on web_sites and returned.
// remove_domain {} clears custom_domain, apex_domain and domain_status and asks Vercel to drop
// both names (a failure there is noted, never fatal: the names are harmless on the project).
//
// NOTHING HERE THROWS TO THE CLIENT. Every outside call has an 8 second timeout and a failure
// lands in domain_status.error as plain English, because this is the screen an owner reads
// while on the phone to their domain registrar.
//
// Secrets: VERCEL_TOKEN, VERCEL_PROJECT_ID (new), plus the Platform pair location-admin uses.
// The fence is the one website-admin uses (_shared/websiteAuth.ts).

import { websiteCaller, resolveCompany, platformAdmin, json, cors, fetchWithTimeout } from '../_shared/websiteAuth.ts';
import {
  isPlainObject, normaliseHostname, apexFor, buildDomainRecords, parseDnsAnswer, recordSatisfied,
  txtRecordsFromVercel, domainStatusFrom, sslStateFrom,
} from '../_shared/websiteRules.js';

type Row = Record<string, unknown>;
type Rec = { type: string; name: string; host: string; value: string; ok: boolean };

const VERCEL_TOKEN = Deno.env.get('VERCEL_TOKEN') ?? '';
const VERCEL_PROJECT_ID = Deno.env.get('VERCEL_PROJECT_ID') ?? '';
const VERCEL_TEAM_ID = Deno.env.get('VERCEL_TEAM_ID') ?? '';   // optional, only when the project sits in a team
const TIMEOUT_MS = 8000;

const bad = (msg: string) => json({ error: msg }, 400);
const teamQs = () => (VERCEL_TEAM_ID ? `?teamId=${encodeURIComponent(VERCEL_TEAM_ID)}` : '');
const vercelHeaders = () => ({ Authorization: `Bearer ${VERCEL_TOKEN}`, 'Content-Type': 'application/json' });

async function readJson(res: Response | null): Promise<Row | null> {
  if (!res) return null;
  try { const j = await res.json(); return isPlainObject(j) ? j as Row : null; } catch { return null; }
}

/** Add one name to the Vercel project. Returns { ok, txt:[...], error }. */
async function vercelAddDomain(name: string): Promise<{ ok: boolean; txt: Rec[]; error: string; row: Row | null }> {
  if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID) return { ok: false, txt: [], error: 'Vercel is not connected yet (VERCEL_TOKEN or VERCEL_PROJECT_ID missing).', row: null };
  const res = await fetchWithTimeout(`https://api.vercel.com/v10/projects/${encodeURIComponent(VERCEL_PROJECT_ID)}/domains${teamQs()}`, {
    method: 'POST', headers: vercelHeaders(), body: JSON.stringify({ name }),
  }, TIMEOUT_MS);
  if (!res) return { ok: false, txt: [], error: `Vercel did not answer when adding ${name}. Try again in a minute.`, row: null };
  const body = await readJson(res);
  if (res.ok) return { ok: true, txt: txtRecordsFromVercel(body?.verification), error: '', row: body };
  const code = String((body?.error as Row | undefined)?.code ?? '');
  // 409 (or the matching code) means the name is already on this project: that is the state we want.
  if (res.status === 409 || code === 'domain_already_in_use' || code === 'domain_already_exists') {
    const cfg = await vercelGetDomain(name);
    return { ok: true, txt: txtRecordsFromVercel(cfg?.verification), error: '', row: cfg };
  }
  if (code === 'domain_taken' || code === 'domain_already_in_use_by_different_team') {
    return { ok: false, txt: [], error: `${name} is attached to another Vercel account. Remove it there first.`, row: body };
  }
  const msg = String((body?.error as Row | undefined)?.message ?? `Vercel answered ${res.status}`);
  return { ok: false, txt: [], error: `Vercel could not add ${name}: ${msg}`, row: body };
}

async function vercelGetDomain(name: string): Promise<Row | null> {
  const res = await fetchWithTimeout(`https://api.vercel.com/v9/projects/${encodeURIComponent(VERCEL_PROJECT_ID)}/domains/${encodeURIComponent(name)}${teamQs()}`, { headers: vercelHeaders() }, TIMEOUT_MS);
  return res && res.ok ? await readJson(res) : null;
}

async function vercelDomainConfig(name: string): Promise<Row | null> {
  const res = await fetchWithTimeout(`https://api.vercel.com/v6/domains/${encodeURIComponent(name)}/config${teamQs()}`, { headers: vercelHeaders() }, TIMEOUT_MS);
  return res && res.ok ? await readJson(res) : null;
}

async function vercelRemoveDomain(name: string): Promise<boolean> {
  if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID) return false;
  const res = await fetchWithTimeout(`https://api.vercel.com/v9/projects/${encodeURIComponent(VERCEL_PROJECT_ID)}/domains/${encodeURIComponent(name)}${teamQs()}`, { method: 'DELETE', headers: vercelHeaders() }, TIMEOUT_MS);
  return !!res && (res.ok || res.status === 404);
}

/** DNS over HTTPS: the answers of one type for one name, [] on any trouble. */
async function dnsAnswers(name: string, type: 'A' | 'CNAME' | 'TXT'): Promise<string[]> {
  const res = await fetchWithTimeout(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`, { headers: { Accept: 'application/dns-json' } }, TIMEOUT_MS);
  const body = await readJson(res);
  return parseDnsAnswer(body, type);
}

async function checkRecords(records: Rec[]): Promise<Rec[]> {
  const out: Rec[] = [];
  for (const r of records) {
    const answers = await dnsAnswers(r.host, r.type as 'A' | 'CNAME' | 'TXT');
    // A www CNAME is sometimes flattened by the registrar into A records pointing at Vercel: accept
    // the CNAME when the A answers resolve to our apex address.
    let ok = recordSatisfied(r, answers);
    if (!ok && r.type === 'CNAME') ok = recordSatisfied({ ...r, value: '76.76.21.21' }, await dnsAnswers(r.host, 'A'));
    out.push({ ...r, ok });
  }
  return out;
}

async function loadSite(companyId: string): Promise<Row | null> {
  const { data } = await platformAdmin.from('web_sites').select('*').eq('company_id', companyId).maybeSingle();
  return (data as Row | null) ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const who = await websiteCaller(req);
  if ('refusal' in who) return who.refusal;

  let body: Row;
  try { body = await req.json(); } catch { return bad('The request was not valid JSON.'); }
  if (!isPlainObject(body)) return bad('The request body must be an object.');
  const action = String(body.action ?? '').trim();

  const picked = resolveCompany(who.caller, body.company_id);
  if ('refusal' in picked) return picked.refusal;
  const site = await loadSite(picked.companyId);
  if (!site) return json({ error: 'Open the website builder once before adding a domain.' }, 404);
  const siteId = site.id as string;

  try {
    if (action === 'check_domain') {
      // Re check the stored domain when none is sent, so the Check button works without retyping.
      const raw = body.custom_domain !== undefined ? body.custom_domain : site.custom_domain;
      const host = normaliseHostname(raw);
      if (!host) return bad('Type the address visitors will use, like www.yourrestaurant.com. Our own addresses cannot be used here.');
      const apex = apexFor(host);
      let records: Rec[] = buildDomainRecords(host) as Rec[];
      const errors: string[] = [];
      const vercel: Row = {};

      // Register on Vercel first: a TXT verification record, when asked for, must be in the list
      // the owner copies, or they add two records and still see "pending" for ever.
      const names = apex ? [host, apex] : [host];
      for (const name of names) {
        const add = await vercelAddDomain(name);
        vercel[name] = { added: add.ok, verified: (add.row as Row | null)?.verified ?? null };
        if (!add.ok) errors.push(add.error);
        for (const txt of add.txt) if (!records.some((r) => r.type === 'TXT' && r.name === txt.name && r.value === txt.value)) records.push(txt);
      }

      records = await checkRecords(records);

      let ssl = 'none';
      if (!errors.length) {
        const cfg = await vercelDomainConfig(host);
        const row = (vercel[host] as Row | undefined) ?? null;
        ssl = sslStateFrom(cfg, row);
        if (cfg) vercel.config = { misconfigured: cfg.misconfigured ?? null, configuredBy: cfg.configuredBy ?? null };
      }

      const status = domainStatusFrom({ records, ssl, error: errors.join(' '), vercel });
      const { data: updated, error } = await platformAdmin.from('web_sites')
        .update({ custom_domain: host, apex_domain: apex, domain_status: status })
        .eq('id', siteId).select('*').maybeSingle();
      if (error) {
        if ((error as { code?: string }).code === '23505') return json({ error: 'That domain is already connected to another site.', code: 'domain_taken' }, 409);
        throw error;
      }
      return json({ ok: true, custom_domain: host, apex_domain: apex, domain_status: status, site: updated });
    }

    if (action === 'remove_domain') {
      const host = typeof site.custom_domain === 'string' ? site.custom_domain : '';
      const apex = typeof site.apex_domain === 'string' ? site.apex_domain : '';
      const dropped: Record<string, boolean> = {};
      for (const name of [host, apex].filter(Boolean)) dropped[name] = await vercelRemoveDomain(name);
      const { data: updated, error } = await platformAdmin.from('web_sites')
        .update({ custom_domain: null, apex_domain: null, domain_status: { state: 'none', records: [], ssl: 'none', checked_at: new Date().toISOString() } })
        .eq('id', siteId).select('*').maybeSingle();
      if (error) throw error;
      return json({ ok: true, removed: dropped, site: updated });
    }

    return bad(`Unknown action "${action}".`);
  } catch (e) {
    // The screen must still render: hand back a status with the error in it rather than a 500.
    const msg = String((e as Error)?.message || e);
    console.error('[website-domain]', action, msg);
    const status = domainStatusFrom({ records: Array.isArray((site.domain_status as Row | undefined)?.records) ? (site.domain_status as Row).records as Rec[] : [], ssl: 'none', error: `Something went wrong while checking the domain: ${msg}` });
    return json({ ok: false, error: status.error, domain_status: status }, 200);
  }
});
