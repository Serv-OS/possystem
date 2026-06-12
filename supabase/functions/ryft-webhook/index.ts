// supabase/functions/ryft-webhook/index.ts
//
// Receives Ryft webhook events. The one we care about most: a sub-account's
// verification status changing — so merchant_ryft_accounts.charges_enabled
// flips to true AUTOMATICALLY the moment a merchant finishes onboarding, with
// no manual "Sync" needed.
//
// Auth = signature, not a JWT (Ryft calls this). Verify the `Signature` header:
// HMAC-SHA256 of the RAW body with the webhook endpoint secret (RYFT_WEBHOOK_SECRET).
// Deployed with verify_jwt=false. Must return 200 fast (Ryft retries on failure).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getAccount } from '../_shared/ryft.ts';

const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const WEBHOOK_SECRET = Deno.env.get('RYFT_WEBHOOK_SECRET') ?? '';

async function validSignature(rawBody: string, header: string): Promise<boolean> {
  if (!WEBHOOK_SECRET || !header) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ header.charCodeAt(i);  // constant-time-ish
  return diff === 0;
}

function deriveStatus(account: any) {
  const v = account?.verification ?? {};
  const caps = account?.capabilities ?? {};
  const anyEnabled = ['visaPayments', 'mastercardPayments', 'amexPayments', 'inPersonPayments'].some((k) => caps?.[k]?.status === 'Enabled');
  return {
    charges_enabled: anyEnabled || v?.status === 'Verified',
    details_submitted: !!v?.status && v.status !== 'Required',
    verification: v,
    country: account?.business?.registeredAddress?.country ?? account?.individual?.address?.country ?? null,
  };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const raw = await req.text();
  if (!(await validSignature(raw, req.headers.get('Signature') ?? ''))) {
    return new Response('invalid signature', { status: 401 });
  }

  let evt: any;
  try { evt = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  const type: string = evt?.eventType ?? evt?.type ?? '';

  try {
    if (/^Account\.(updated|verification_status_updated|created)$/.test(type)) {
      const accountId: string | undefined = evt?.data?.id ?? evt?.accountId;
      if (accountId) {
        // Re-fetch the account so we derive status from the authoritative source
        // (event payloads can be partial), then update the merchant row.
        const got = await getAccount(accountId);
        const account = got.ok ? got.data : (evt?.data ?? {});
        const d = deriveStatus(account);
        await platformAdmin.from('merchant_ryft_accounts').update({
          charges_enabled: d.charges_enabled,
          details_submitted: d.details_submitted,
          requirements: d.verification ?? null,
          country: d.country,
          last_webhook_at: new Date().toISOString(),
        }).eq('ryft_account_id', accountId);
      }
    } else if (/^(PaymentSession|Payout|Person)\./.test(type)) {
      // Touch last_webhook_at so we can see the account is active. Best-effort.
      const accountId: string | undefined = evt?.accountId ?? evt?.data?.accountId;
      if (accountId) await platformAdmin.from('merchant_ryft_accounts').update({ last_webhook_at: new Date().toISOString() }).eq('ryft_account_id', accountId);
    }
  } catch (e) {
    console.error('[ryft-webhook] handler error', (e as Error).message);
    // Still 200 — we verified the signature; don't trigger Ryft retries for our bug.
  }

  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
