// supabase/functions/website-visit/index.ts (6 Nov 2026, 5.12.67). PUBLIC (deploy --no-verify-jwt).
//
// Peter: "website traffic reports". One POST per page view from the venue's own website
// (src/surfaces/website/visitPing.js): the host, the page, the referring host, the utm tags and
// the sv_m token a tracked email link carried. The function
//   1. finds the website for the host on the Platform (web_resolve_host, the public read the site
//      itself uses) and drops the view when the site has visits switched off (settings.analytics_enabled false),
//   2. finds the organisation through the site's own venue (Ops locations.org_id),
//   3. makes the visitor key: SHA-256 of secret + today + ip + browser + host, first 32 hex. No
//      cookie, no stored ip; the key changes every day, so a person is one visitor for one day,
//   4. ties the view to the campaign or automation when sv_m names one of our messages (or
//      utm_campaign is one of the organisation's campaign ids),
//   5. writes one website_visits row (service role; the table has no public write).
// Bots (user agents naming bot, crawler, spider, headless, preview) and bodies over 4 KB are dropped
// with a 204, never an error. A host that is not a live site is dropped the same way.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-client-info, apikey, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};
const done = (s = 204) => new Response(null, { status: s, headers: cors });
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const platformUrl = Deno.env.get('PLATFORM_SUPABASE_URL') ?? '';
const platformKey = Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('PLATFORM_SUPABASE_ANON_KEY') ?? '';
const platform = platformUrl && platformKey ? createClient(platformUrl, platformKey, { auth: { autoRefreshToken: false, persistSession: false } }) : null;
const SALT = Deno.env.get('WEBSITE_VISIT_SALT') || SERVICE_ROLE;
const BOT_RE = /bot|crawl|spider|slurp|headless|preview|facebookexternalhit|whatsapp|telegram|skype|lighthouse|pingdom|monitor/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Site = { enabled: boolean; opsLocationIds: string[]; orgId: string | null; defaultLocation: string | null };
const siteCache = new Map<string, { at: number; site: Site | null }>();

async function siteFor(host: string): Promise<Site | null> {
  const hit = siteCache.get(host);
  if (hit && Date.now() - hit.at < 60_000) return hit.site;
  let site: Site | null = null;
  try {
    if (platform) {
      const { data } = await platform.rpc('web_resolve_host', { p_host: host });
      const row = Array.isArray(data) ? data[0] : data;
      let snap = row?.snapshot;
      if (typeof snap === 'string') { try { snap = JSON.parse(snap); } catch { snap = null; } }
      if (snap && typeof snap === 'object') {
        const settings = (snap.site && snap.site.settings && typeof snap.site.settings === 'object') ? snap.site.settings : {};
        const locs = Array.isArray(snap.locations) ? snap.locations : [];
        const opsIds = [...new Set(locs.map((l: any) => l && l.ops_location_id).filter((x: any) => UUID_RE.test(String(x || ''))))] as string[];
        const def = locs.find((l: any) => l && l.id && settings.default_location_id && String(l.id) === String(settings.default_location_id));
        let orgId: string | null = null;
        if (opsIds.length) {
          const { data: ol } = await opsAdmin.from('locations').select('id, org_id').in('id', opsIds).not('org_id', 'is', null).limit(1);
          orgId = ol?.[0]?.org_id ?? null;
        }
        site = { enabled: settings.analytics_enabled !== false, opsLocationIds: opsIds, orgId, defaultLocation: def?.ops_location_id || opsIds[0] || null };
      }
    }
  } catch (e) { console.warn('[website-visit] site lookup failed:', e instanceof Error ? e.message : String(e)); }
  siteCache.set(host, { at: Date.now(), site });
  return site;
}

async function visitorKey(ip: string, ua: string, host: string): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${SALT}|${day}|${ip}|${ua}|${host}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
function hostOf(ref: string): string {
  try { return new URL(ref).hostname.toLowerCase(); } catch { return ''; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return done(405);
  const ua = req.headers.get('user-agent') || '';
  if (!ua || BOT_RE.test(ua)) return done();
  const raw = await req.text().catch(() => '');
  if (!raw || raw.length > 4096) return done();
  let body: any; try { body = JSON.parse(raw); } catch { return done(); }

  const host = str(body?.host, 253).toLowerCase().replace(/:\d+$/, '');
  const path = str(body?.path, 512) || '/';
  if (!host || !path.startsWith('/')) return done();
  const site = await siteFor(host);
  if (!site || !site.enabled || !site.orgId) return done();

  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || '';
  const key = await visitorKey(ip, ua, host);

  // the campaign or automation this visit came from
  let campaignId: string | null = null, workflowId: string | null = null, messageId: string | null = null;
  const svm = str(body?.sv_m, 40);
  if (UUID_RE.test(svm)) {
    const { data: m } = await opsAdmin.from('marketing_messages').select('id, campaign_id, workflow_id').eq('id', svm).eq('org_id', site.orgId).maybeSingle();
    if (m) { messageId = m.id; campaignId = m.campaign_id || null; workflowId = m.workflow_id || null; }
  }
  const utmCampaign = str(body?.utm_campaign, 120);
  if (!campaignId && !workflowId && UUID_RE.test(utmCampaign)) {
    const { data: c } = await opsAdmin.from('campaigns').select('id').eq('id', utmCampaign).eq('org_id', site.orgId).maybeSingle();
    if (c) campaignId = c.id;
    else { const { data: w } = await opsAdmin.from('workflows').select('id').eq('id', utmCampaign).eq('org_id', site.orgId).maybeSingle(); if (w) workflowId = w.id; }
  }
  const ref = hostOf(str(body?.referrer, 1024));
  const row = {
    org_id: site.orgId, location_id: site.defaultLocation, host, path: path.split('?')[0].slice(0, 512) || '/',
    referrer: ref && ref !== host ? ref : null,
    utm_source: str(body?.utm_source, 120) || null, utm_medium: str(body?.utm_medium, 120) || null, utm_campaign: utmCampaign || null,
    message_id: messageId, campaign_id: campaignId, workflow_id: workflowId, visitor_key: key,
  };
  const { error } = await opsAdmin.from('website_visits').insert(row);
  if (error) console.warn('[website-visit] not recorded:', error.message);
  return done();
});
