// supabase/functions/form-submit/index.ts
//
// MARKETING FORMS (5.12.37): THE public submit path for every form, wherever it sits (the venue
// website builder, the hosted page behind the embed snippet, any outside site). Deploy with
// --no-verify-jwt: a person filling in a form has no login. The only door to
// marketing_form_submissions (no rule lets anyone else write a row).
//
// Two ways in, one set of rules (_shared/formSubmitRun.js):
//   * fetch with JSON (the page has JavaScript): answers JSON { ok, thanks } or { ok:false, error }.
//     CORS is open here, and only here, so a form embedded on any outside site can post.
//   * a plain <form method="post"> (no JavaScript): answers 303 back to the page it came from
//     (return_to) with ?form_sent=<form id> or ?form_error=<words>. return_to must be one of our own
//     hosts or a live venue website domain (web_resolve_host on Platform); anything else goes to the
//     hosted form page, so this is never an open redirect.
// Payload capped at 16 KB. The ip address is never stored: a salted SHA-256 (FORM_IP_SALT, else
// derived from the service key) is kept for the 5 per 10 minutes limit.
// The automations ("Form submitted" trigger) run after the answer through EdgeRuntime.waitUntil:
// a failed email or text never fails the submission.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { runFormSubmit } from '../_shared/formSubmitRun.js';
import { fieldsFromForm, parseReturnTo, isOwnHost, returnUrl, LIMITS, formTriggerId } from '../_shared/formRules.js';
import { enrollFromForm, runWorkflow } from '../_shared/workflow-engine.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-client-info, apikey, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const IP_SALT = Deno.env.get('FORM_IP_SALT') || `form-ip:${SERVICE_ROLE.slice(-24)}`;
const APP_ORIGIN = (Deno.env.get('FORMS_APP_ORIGIN') || 'https://app.serv-os.app').replace(/\/$/, '');
const CUSTOMER_DOMAIN = Deno.env.get('CUSTOMER_DOMAIN') || 'serv-os.app';
const opsAdmin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const PLATFORM_URL = Deno.env.get('PLATFORM_SUPABASE_URL') ?? '';
const PLATFORM_KEY = Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '';
const platformAdmin = PLATFORM_URL && PLATFORM_KEY ? createClient(PLATFORM_URL, PLATFORM_KEY, { auth: { autoRefreshToken: false, persistSession: false } }) : null;

async function hashIp(ip: string | null): Promise<string | null> {
  if (!ip) return null;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(IP_SALT), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip.trim().toLowerCase()));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

// Where a plain post may go back to: our hosts, or a venue website that is live on its own domain.
async function allowedBack(u: URL | null): Promise<boolean> {
  if (!u) return false;
  if (isOwnHost(u.hostname, CUSTOMER_DOMAIN)) return true;
  if (!platformAdmin) return false;
  try {
    const { data } = await platformAdmin.rpc('web_resolve_host', { p_host: u.hostname.toLowerCase() });
    const row = Array.isArray(data) ? data[0] : data;
    return !!row;
  } catch { return false; }
}

// The automations for this form: every ACTIVE "Form submitted" workflow of the company naming it.
async function runAutomations({ form, customerId, consent }: { form: any; customerId: string; consent: boolean }) {
  const { data: wfs } = await opsAdmin.from('workflows').select('*').eq('org_id', form.org_id).eq('status', 'active')
    .eq('entry_trigger->>type', 'form_submitted').eq('entry_trigger->>form_id', form.id);
  const opts = { today: new Date().toISOString().slice(0, 10), supabaseUrl: SUPABASE_URL, serviceRole: SERVICE_ROLE };
  for (const wf of wfs ?? []) {
    if (formTriggerId(wf) !== form.id) continue;
    try {
      const en = await enrollFromForm(opsAdmin, wf, customerId, consent, opts);
      if (en.enrollmentId) await runWorkflow(opsAdmin, wf, { ...opts, enrollmentId: en.enrollmentId });
    } catch (e) { console.warn('[form-submit] automation', wf.id, e instanceof Error ? e.message : e); }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  const type = (req.headers.get('content-type') || '').toLowerCase();
  const plain = !type.includes('application/json');
  const len = Number(req.headers.get('content-length') || '0');
  if (len > LIMITS.MAX_PAYLOAD_BYTES) return json({ ok: false, error: 'That is too much to send in one form.' }, 413);
  let text = '';
  try { text = await req.text(); } catch { return json({ ok: false, error: 'invalid body' }, 400); }
  if (text.length > LIMITS.MAX_PAYLOAD_BYTES) return json({ ok: false, error: 'That is too much to send in one form.' }, 413);

  let raw: Record<string, unknown> = {};
  if (plain) {
    // A plain post is urlencoded (the form sets no enctype). Multipart is not accepted.
    raw = fieldsFromForm(new URLSearchParams(text));
  } else {
    try { const j = JSON.parse(text); raw = j && typeof j === 'object' && !Array.isArray(j) ? fieldsFromForm(j) : {}; }
    catch { return json({ ok: false, error: 'invalid json' }, 400); }
  }

  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || null;
  const background: Promise<unknown>[] = [];
  const afterResponse = (fn: () => Promise<unknown>) => {
    const p = fn();
    const rt = (globalThis as any).EdgeRuntime;
    if (rt && typeof rt.waitUntil === 'function') rt.waitUntil(p); else background.push(p);
  };

  let result: { status: number; body: any };
  try {
    result = await runFormSubmit(raw, {
      db: opsAdmin, ipHash: await hashIp(ip), userAgent: req.headers.get('user-agent') || '', now: new Date(),
      afterResponse, runAutomations,
    });
  } catch (e) {
    console.error('[form-submit]', e instanceof Error ? e.message : e);
    result = { status: 503, body: { ok: false, error: 'The form could not be sent just now. Please try again in a minute.' } };
  }
  if (background.length) await Promise.allSettled(background);

  if (!plain) return json(result.body, result.status);

  // No JavaScript: back to the page with the outcome in the address.
  const formId = String(raw.form_id || result.body?.form_id || '').replace(/[^a-f0-9-]/gi, '');
  const back = parseReturnTo(raw.return_to);
  const target = (await allowedBack(back)) && back ? back : new URL(`${APP_ORIGIN}/api/form?id=${formId}`);
  const location = returnUrl(target, formId, result.body?.ok ? { sent: true } : { error: result.body?.error });
  return new Response(null, { status: 303, headers: { ...cors, Location: location, 'Cache-Control': 'no-store' } });
});
