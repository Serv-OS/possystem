// supabase/functions/ryft-terminals/index.ts
//
// MERCHANT-facing Ryft card-reader (terminal) pairing from the back office.
// Location-scoped: caller must be a signed-in Ops user with access to the
// location (user_locations) — or super_admin. Built ahead of hardware; the
// flow + storage are ready, only the live test needs a physical Ryft terminal.
//
//   list        { ops_location_id }                       → our paired terminals
//   register    { ops_location_id, serial_number, terminal_name?, pos_device_id?, address? }
//                  → ensures an in-person location (iploc_) for the venue, then
//                    POST /in-person/terminals, then stores it in payment_devices
//   unregister  { ops_location_id, terminal_id }          → delete at Ryft + locally

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getAccount, createInPersonLocation, registerTerminal, deleteTerminal, ryftConfigured } from '../_shared/ryft.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const ryftErr = (d: any): string | null => d?.errors?.[0]?.message || d?.message || null;

const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

// Pull a usable address from the merchant's KYB data (or the supplied one).
function pickAddress(account: any, fallback: any) {
  const a = account?.business?.registeredAddress ?? account?.individual?.address ?? fallback ?? null;
  if (!a?.lineOne || !a?.city || !a?.country || !a?.postalCode) return null;
  return { lineOne: a.lineOne, ...(a.lineTwo ? { lineTwo: a.lineTwo } : {}), city: a.city, country: a.country, postalCode: a.postalCode };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ error: 'Invalid token' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = body?.action as string;
  const opsLocationId = body?.ops_location_id as string;
  if (!action || !opsLocationId) return json({ error: 'action and ops_location_id required' }, 400);

  const [{ data: ul }, { data: prof }] = await Promise.all([
    opsAdmin.from('user_locations').select('location_id').eq('user_id', caller.id).eq('location_id', opsLocationId).maybeSingle(),
    opsAdmin.from('user_profiles').select('role').eq('id', caller.id).maybeSingle(),
  ]);
  if (!ul && prof?.role !== 'super_admin') return json({ error: 'No access to this location' }, 403);

  const { data: loc } = await platformAdmin.from('locations')
    .select('id, name, payment_processor').eq('ops_location_id', opsLocationId).maybeSingle();
  if (!loc) return json({ error: 'location not found in platform DB' }, 404);

  // ── list: our paired Ryft terminals (from payment_devices) ──────────────
  if (action === 'list') {
    const { data: mra } = await platformAdmin.from('merchant_ryft_accounts').select('ryft_account_id').eq('location_id', loc.id).maybeSingle();
    const { data: devices } = await platformAdmin.from('payment_devices')
      .select('id, ryft_terminal_id, serial_number, label, bound_pos_device_id, status, created_at')
      .eq('location_id', loc.id).eq('processor', 'ryft').order('created_at', { ascending: true });
    return json({ success: true, processor: loc.payment_processor || 'stripe', linked: !!mra?.ryft_account_id, terminals: devices ?? [] });
  }

  // ── unregister: delete at Ryft + remove our row ─────────────────────────
  if (action === 'unregister') {
    if (!body.terminal_id) return json({ error: 'terminal_id required' }, 400);
    const { data: dev } = await platformAdmin.from('payment_devices')
      .select('id, ryft_terminal_id').eq('location_id', loc.id).eq('processor', 'ryft').eq('ryft_terminal_id', body.terminal_id).maybeSingle();
    const { data: mra } = await platformAdmin.from('merchant_ryft_accounts').select('ryft_account_id').eq('location_id', loc.id).maybeSingle();
    if (ryftConfigured() && mra?.ryft_account_id && body.terminal_id) {
      await deleteTerminal(body.terminal_id, { accountId: mra.ryft_account_id }); // best-effort
    }
    if (dev?.id) await platformAdmin.from('payment_devices').delete().eq('id', dev.id);
    return json({ success: true });
  }

  // ── register: ensure iploc, register terminal, store it ─────────────────
  if (action === 'register') {
    if (loc.payment_processor !== 'ryft') return json({ error: 'This location is not on Ryft.' }, 400);
    if (!ryftConfigured()) return json({ error: 'Ryft not configured' }, 500);
    const serial = String(body.serial_number ?? '').trim();
    if (!serial) return json({ error: 'serial_number required' }, 400);

    const { data: mra } = await platformAdmin.from('merchant_ryft_accounts')
      .select('ryft_account_id, ryft_inperson_location_id').eq('location_id', loc.id).maybeSingle();
    if (!mra?.ryft_account_id) return json({ error: 'Set up card payments for this location first (no Ryft account).' }, 400);
    const opts = { accountId: mra.ryft_account_id };

    // Ensure an in-person location (iploc_). Reuse the stored one, else create.
    let iploc = mra.ryft_inperson_location_id as string | undefined;
    if (!iploc) {
      const got = await getAccount(mra.ryft_account_id);
      const address = pickAddress(got.ok ? got.data : null, body.address);
      if (!address) return json({ error: 'A venue address is needed to set up the reader. Provide address {lineOne, city, country, postalCode} or complete onboarding first.' }, 400);
      const name = String(loc.name ?? 'Venue').padEnd(5, ' ').slice(0, 50);
      const created = await createInPersonLocation({ name, address, metadata: { location_id: loc.id } }, opts);
      if (!created.ok || !created.data?.id) return json({ error: ryftErr(created.data) || `Couldn't create the in-person location (${created.status})`, ryft: created.data }, 502);
      iploc = created.data.id;
      await platformAdmin.from('merchant_ryft_accounts').update({ ryft_inperson_location_id: iploc }).eq('location_id', loc.id);
    }

    const tName = body.terminal_name ? String(body.terminal_name).slice(0, 40) : undefined;
    const reg = await registerTerminal({ serialNumber: serial, locationId: iploc!, ...(tName && tName.length >= 5 ? { name: tName } : {}), metadata: { location_id: loc.id } }, opts);
    if (!reg.ok || !reg.data?.id) return json({ error: ryftErr(reg.data) || `Terminal registration failed (${reg.status})`, ryft: reg.data }, reg.status >= 400 && reg.status < 500 ? 400 : 502);
    const terminalId = reg.data.id;

    const { error: upErr } = await platformAdmin.from('payment_devices').upsert({
      location_id: loc.id, processor: 'ryft', ryft_terminal_id: terminalId,
      serial_number: serial, label: body.terminal_name || null,
      bound_pos_device_id: body.pos_device_id || null, status: 'registered',
      registered_by_user_id: caller.id,
    }, { onConflict: 'ryft_terminal_id' });
    if (upErr) return json({ error: `stored at Ryft but local save failed: ${upErr.message}`, terminal_id: terminalId }, 500);

    return json({ success: true, terminal_id: terminalId, iploc });
  }

  return json({ error: `unknown action: ${action}` }, 400);
});
