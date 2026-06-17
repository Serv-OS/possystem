// supabase/functions/marketing-preferences/index.ts
//
// Slice 8 — customer-facing preference centre. Public (verify_jwt=false); access is gated by an HMAC
// token over "pref:<customer_id>" minted by marketing-send. GET renders a self-contained page with the
// customer's current per-channel marketing opt-in; POST applies changes — writing the customer_consents
// ledger (consented true/false) and adding/removing marketing_suppressions accordingly, and syncing the
// legacy customers.marketing_opt_in flag. No login, no PII in the URL beyond the opaque id+token.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const html = (b: string, s = 200) => new Response(b, { status: s, headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' } });

async function tokenFor(customerId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SERVICE_ROLE), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`pref:${customerId}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
const norm = (channel: string, addr: string) => (channel === 'email' ? addr.trim().toLowerCase() : addr.replace(/\s/g, ''));

async function isSuppressed(org: string, channel: string, addr: string): Promise<boolean> {
  const { data } = await sb.from('marketing_suppressions').select('id').eq('org_id', org).eq('channel', channel).ilike('address', norm(channel, addr)).maybeSingle();
  return !!data;
}

function page(customerId: string, token: string, opts: { email?: string; phone?: string; emailOn: boolean; smsOn: boolean; saved?: boolean }): string {
  const cb = (name: string, label: string, addr: string | undefined, on: boolean) => addr
    ? `<label style="display:flex;align-items:center;gap:10px;padding:12px 0;border-top:1px solid #eee"><input type="checkbox" name="${name}" ${on ? 'checked' : ''} style="width:18px;height:18px"> <span><b>${label}</b><br><span style="color:#888;font-size:13px">${addr}</span></span></label>`
    : `<div style="padding:12px 0;border-top:1px solid #eee;color:#aaa;font-size:13px">${label}: not on file</div>`;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Email & SMS preferences</title></head>
<body style="font-family:system-ui,Arial,sans-serif;background:#f4f4f5;margin:0">
<div style="max-width:440px;margin:48px auto;background:#fff;border-radius:14px;padding:28px;box-shadow:0 1px 4px rgba(0,0,0,.06)">
  <h2 style="margin:0 0 6px">Your marketing preferences</h2>
  <p style="color:#666;font-size:14px;margin:0 0 14px">Choose how you'd like to hear about offers and news. You can change this any time.</p>
  ${opts.saved ? '<div style="background:#e8f5e9;color:#1b5e20;padding:10px 12px;border-radius:8px;font-size:14px;margin-bottom:12px">✓ Your preferences have been saved.</div>' : ''}
  <form method="POST">
    <input type="hidden" name="c" value="${customerId}"><input type="hidden" name="t" value="${token}">
    ${cb('email', 'Email', opts.email, opts.emailOn)}
    ${cb('sms', 'SMS / text', opts.phone, opts.smsOn)}
    <button type="submit" style="width:100%;margin-top:18px;padding:12px;border:none;border-radius:10px;background:#111;color:#fff;font-size:15px;font-weight:700;cursor:pointer">Save preferences</button>
  </form>
  <p style="color:#aaa;font-size:12px;margin-top:14px">Untick everything to unsubscribe from all marketing. Transactional messages (receipts, order updates) are not affected.</p>
</div></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);

  let c = '', t = '', isPost = false; let form: FormData | null = null;
  if (req.method === 'POST') {
    isPost = true;
    try { form = await req.formData(); } catch { return html('<h2>Bad request.</h2>', 400); }
    c = String(form.get('c') || ''); t = String(form.get('t') || '');
  } else {
    c = url.searchParams.get('c') || ''; t = url.searchParams.get('t') || '';
  }
  if (!c || !t) return html('<h2>Invalid link.</h2>', 400);
  if (t !== (await tokenFor(c))) return html('<h2>This link is invalid or has expired.</h2>', 403);

  const { data: cust } = await sb.from('customers').select('id, org_id, email, phone, marketing_opt_in').eq('id', c).maybeSingle();
  if (!cust?.org_id) return html('<h2>We couldn\'t find your details.</h2>', 404);
  const org = cust.org_id;

  if (isPost && form) {
    const wantEmail = form.get('email') === 'on';
    const wantSms = form.get('sms') === 'on';
    const apply = async (channel: 'email' | 'sms', addr: string | null | undefined, want: boolean) => {
      if (!addr) return;
      if (want) {
        await sb.from('marketing_suppressions').delete().eq('org_id', org).eq('channel', channel).ilike('address', norm(channel, addr));
      } else {
        await sb.from('marketing_suppressions').upsert({ org_id: org, channel, address: norm(channel, addr), reason: 'unsubscribe', customer_id: c, source: 'preference_centre' }, { onConflict: 'org_id,channel,address', ignoreDuplicates: true });
      }
      await sb.from('customer_consents').insert({ customer_id: c, org_id: org, channel, purpose: 'marketing', consented: want, source: 'preference_centre', method: 'preference_centre' });
    };
    await apply('email', cust.email, wantEmail);
    await apply('sms', cust.phone, wantSms);
    await sb.from('customers').update({ marketing_opt_in: wantEmail || wantSms, marketing_opt_in_at: new Date().toISOString() }).eq('id', c);
    return html(page(c, t, { email: cust.email, phone: cust.phone, emailOn: wantEmail, smsOn: wantSms, saved: true }));
  }

  // GET: derive current per-channel opt-in = marketing_opt_in AND not suppressed on that channel.
  const [emailSupp, smsSupp] = await Promise.all([
    cust.email ? isSuppressed(org, 'email', cust.email) : Promise.resolve(false),
    cust.phone ? isSuppressed(org, 'sms', cust.phone) : Promise.resolve(false),
  ]);
  return html(page(c, t, { email: cust.email, phone: cust.phone, emailOn: !!cust.marketing_opt_in && !emailSupp, smsOn: !!cust.marketing_opt_in && !smsSupp }));
});
