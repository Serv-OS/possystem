// supabase/functions/invoice-inbox/index.ts
//
// Multi site stock Drop 3 (v5.11.96, contract 3.5, decision 12): the inbound invoice email. Each
// company has an address 'invoices+<token>@<domain>' (stock_inbox_address); the email provider posts
// each email here, the files go to the private bucket stock-invoice-inbox under org/<org_id>/ and
// stock_inbox_receive writes one inbox row per file and places it by account number or delivery
// address (else it waits in the Inbox tab for "Which site?").
//
// The inbound provider is open question 15, so there is no provider, no key and no address yet:
// every call is answered 503 'The invoice inbox address is not set up yet.' until PROVIDER_READY is
// switched on with the provider's own request check. Back Office Upload into the inbox works from day
// one (it does not come through here). The pure part (_shared/invoiceInbox.js) is built and tested.
//
// Deploy --no-verify-jwt (the provider has no Supabase login; its own signature is the check).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { parseInboxBody, receiveFiles, INBOX_BUCKET } from '../_shared/invoiceInbox.js';

const PROVIDER_READY = false;

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// Until a provider is chosen this always says no. When one is, it checks the provider's signature
// and turns its webhook into { token, from, subject, files: [{ filename, mime, content_base64 }] }.
async function providerBody(_req: Request): Promise<any | null> {
  return null;
}

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!PROVIDER_READY) return json({ error: 'The invoice inbox address is not set up yet.' }, 503);
  const raw = await providerBody(req);
  if (!raw) return json({ error: 'The invoice inbox address is not set up yet.' }, 503);
  const body = parseInboxBody(raw);
  if (!body.ok) return json({ error: body.error, skipped: body.skipped || [] }, 400);
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: co } = await sb.from('stock_co_settings').select('org_id').eq('inbox_token', body.token).maybeSingle();
  if (!co?.org_id) return json({ error: 'This inbox address is not known.' }, 404);
  const ids = body.files.map(() => crypto.randomUUID());
  const files = receiveFiles(co.org_id, body.files, ids);
  for (let i = 0; i < files.length; i++) {
    const up = await sb.storage.from(INBOX_BUCKET).upload(files[i].file_path, b64ToBytes(body.files[i].content_base64), { contentType: files[i].mime, upsert: false });
    if (up.error) return json({ error: `Could not keep ${files[i].file_name}: ${up.error.message}` }, 500);
  }
  const { data, error } = await sb.rpc('stock_inbox_receive', { p_token: body.token, p_from: body.from, p_subject: body.subject, p_files: files });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, received: files.length, skipped: body.skipped, answer: data });
});
