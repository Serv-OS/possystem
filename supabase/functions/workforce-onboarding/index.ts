// supabase/functions/workforce-onboarding
//
// Candidate-facing contract signing for the Workforce onboarding flow. The
// candidate is NOT a logged-in user — access is gated by an unguessable token
// stored on the onboarding record (meta.signToken). Runs as service-role.
//
// Actions { action, token, name? }:
//   sign.get     → offer + contract details + a short-lived signed URL
//   sign.submit  → record the typed-name signature (name, timestamp, IP) and
//                  mark the contract onboarding step complete (idempotent)
//   offer.accept → record the candidate's acceptance of the offer letter
//                  (timestamp + IP; idempotent)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function findByToken(token: string) {
  const { data } = await admin.from('wf_onboarding').select('*').eq('meta->>signToken', token).maybeSingle();
  return data;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { action, token } = body;
  if (!action || !token) return json({ error: 'action and token required' }, 400);

  const onb = await findByToken(String(token));
  if (!onb) return json({ ok: false, error: 'This signing link is invalid or has expired.' });
  const meta = onb.meta || {};

  try {
    if (action === 'sign.get') {
      const [{ data: staff }, { data: loc }] = await Promise.all([
        admin.from('wf_staff').select('name, role_key').eq('id', onb.staff_id).maybeSingle(),
        admin.from('locations').select('name').eq('id', onb.location_id).maybeSingle(),
      ]);
      let contractUrl: string | null = null;
      if (meta.contractPath) {
        const { data: signed } = await admin.storage.from('wf-documents').createSignedUrl(meta.contractPath, 600);
        contractUrl = signed?.signedUrl ?? null;
      }
      return json({
        ok: true,
        staffName: staff?.name ?? 'there',
        position: onb.role_key || staff?.role_key || '',
        businessName: loc?.name ?? 'the team',
        contractUrl,
        contractHtml: meta.contractHtml ?? null,
        signed: !!meta.signature,
        signature: meta.signature ?? null,
        offerHtml: meta.offerHtml ?? null,
        offerAccepted: meta.offerAccepted ?? null,
      });
    }

    if (action === 'offer.accept') {
      if (meta.offerAccepted) return json({ ok: true, alreadyAccepted: true, offerAccepted: meta.offerAccepted });
      const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || null;
      const offerAccepted = { acceptedAt: new Date().toISOString(), ip, via: 'link' };
      const steps = Array.isArray(onb.steps) ? onb.steps.map((s: any) => s.key === 'offer' ? { ...s, status: 'complete', completedAt: offerAccepted.acceptedAt } : s) : onb.steps;
      const { error } = await admin.from('wf_onboarding')
        .update({ meta: { ...meta, offerAccepted }, steps }).eq('id', onb.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, offerAccepted });
    }

    if (action === 'sign.submit') {
      const name = String(body.name || '').trim();
      if (name.length < 2) return json({ ok: false, error: 'Please type your full name to sign.' });
      if (meta.signature) return json({ ok: true, alreadySigned: true, signature: meta.signature });
      const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || null;
      const signature = { name, signedAt: new Date().toISOString(), ip };
      const steps = Array.isArray(onb.steps) ? onb.steps.map((s: any) => s.key === 'contract' ? { ...s, status: 'complete', completedAt: signature.signedAt } : s) : onb.steps;
      const { error } = await admin.from('wf_onboarding')
        .update({ meta: { ...meta, signature }, steps }).eq('id', onb.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, signature });
    }

    return json({ error: `unknown action "${action}"` }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
