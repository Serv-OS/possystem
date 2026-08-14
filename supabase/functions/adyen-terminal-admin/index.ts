// supabase/functions/adyen-terminal-admin
//
// The Back Office's Adyen FLEET door — the Lightspeed-style "register the
// terminal on the location" flow (Peter, 14 Aug: "I want this setup properly
// with a proper flow"). AMS1-class terminals run Adyen's own software, so
// there is no on-device claim code: registration = Management API reassign to
// the venue's STORE + a linked ops terminal_devices row the charge path and
// till-binding already understand.
//
// Actions (all BO-fenced):
//   status       → processor, merchant, store mapping, Management-API scope probe
//   ensure_store → create the venue's Adyen store + merchant_adyen_accounts row
//   list         → Adyen fleet for the merchant, split store vs inventory,
//                  joined to our terminal_devices links
//   assign       → reassign terminal to the venue store + payment_devices row
//                  + ops terminal_devices row (paired, ready to bind to a till)
//   unlink       → retire the ops row (terminal stays boarded at Adyen)
//
// Auth: BO JWT → user_locations membership (or super_admin) — the ryft-terminals
// fence, verbatim in spirit. All writes service-role.
//
// Scope: needs an API key with Management API "Terminals read/write" roles.
// If ADYEN_MANAGEMENT_KEY is set it is used for management calls; otherwise
// ADYEN_API_KEY. A 401/403 from Adyen surfaces as scope_missing so the BO can
// say exactly what to fix instead of a dead button.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { managementBase, ADYEN_MERCHANT_ACCOUNT } from '../_shared/adyen.ts';

const opsAdmin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('PLATFORM_SERVICE_KEY') ?? '',
);

const MGMT_KEY = Deno.env.get('ADYEN_MANAGEMENT_KEY') || Deno.env.get('ADYEN_API_KEY') || '';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

async function mgmt<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(`${managementBase()}${path}`, {
    method,
    headers: { 'X-API-Key': MGMT_KEY, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: T;
  try { data = await res.json(); } catch { data = {} as T; }
  return { ok: res.ok, status: res.status, data };
}

const scopeMissing = (status: number) => status === 401 || status === 403;

// A store with no payment methods bricks its terminals ("no payment method
// configured" on the reader). Request the card schemes for the store; test
// auto-approves, live goes to Adyen review. Idempotent — "already exists"
// style refusals are fine.
async function ensurePaymentMethods(merchant: string, storeId: string): Promise<{ requested: string[]; errors: string[] }> {
  const requested: string[] = [];
  const errors: string[] = [];
  for (const type of ['visa', 'mc', 'amex', 'maestro']) {
    const r = await mgmt('POST', `/merchants/${merchant}/paymentMethodSettings`, {
      type, storeIds: [storeId], currencies: ['GBP'], countries: ['GB'],
    });
    if (r.ok) requested.push(type);
    else {
      const msg = String((r.data as Record<string, unknown>)?.detail || (r.data as Record<string, unknown>)?.title || r.status);
      if (/exist|already|duplicate/i.test(msg)) requested.push(type);
      else errors.push(`${type}: ${msg}`);
    }
  }
  return { requested, errors };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || 'status');
    const opsLocationId = String(body.ops_location_id || '');
    if (!opsLocationId || opsLocationId === 'loc-demo') return json({ error: 'ops_location_id required' }, 400);

    // ── BO fence (the ryft-terminals pattern) ────────────────────────────────
    const authHeader = req.headers.get('Authorization') || '';
    const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
    if (!caller) return json({ error: 'not authenticated' }, 401);
    const [{ data: ul }, { data: prof }] = await Promise.all([
      opsAdmin.from('user_locations').select('location_id').eq('user_id', caller.id).eq('location_id', opsLocationId).maybeSingle(),
      opsAdmin.from('user_profiles').select('role').eq('id', caller.id).maybeSingle(),
    ]);
    if (!ul && prof?.role !== 'super_admin') return json({ error: 'No access to this location' }, 403);

    // ── venue resolution: ops → platform → merchant mapping ──────────────────
    const select = 'id, name, payment_processor';
    let { data: loc } = await platformAdmin.from('locations').select(select).eq('ops_location_id', opsLocationId).maybeSingle();
    if (!loc) ({ data: loc } = await platformAdmin.from('locations').select(select).eq('id', opsLocationId).maybeSingle());
    if (!loc) return json({ error: 'location not found in platform DB' }, 404);

    const { data: maa } = await platformAdmin.from('merchant_adyen_accounts')
      .select('merchant_account, store_id, region, receive_payments_ok')
      .eq('location_id', loc.id).maybeSingle();
    const merchant = maa?.merchant_account || ADYEN_MERCHANT_ACCOUNT;
    if (!merchant) return json({ error: 'no Adyen merchant account configured (ADYEN_MERCHANT_ACCOUNT)' }, 500);

    // ── status: everything the panel needs to decide what to show ────────────
    if (action === 'status') {
      const probe = await mgmt('GET', `/merchants/${merchant}/stores?pageSize=1`);
      return json({
        ok: true,
        venue: loc.name,
        processor: loc.payment_processor || 'stripe',
        merchant,
        storeId: maa?.store_id || null,
        receivePaymentsOk: maa?.receive_payments_ok ?? null,
        scopeOk: !scopeMissing(probe.status),
        scopeError: scopeMissing(probe.status)
          ? 'The Adyen API key has no Management (Terminals) role — add one in Customer Area → Developers → API credentials, or set ADYEN_MANAGEMENT_KEY.'
          : null,
      });
    }

    // ── ensure_store: the venue's physical store at Adyen + our mapping row ──
    if (action === 'ensure_store') {
      if (maa?.store_id) return json({ ok: true, storeId: maa.store_id, existing: true });
      const a = (body.address || {}) as Record<string, string>;
      const payload = {
        description: String(body.description || loc.name || 'ServOS venue').slice(0, 100),
        shopperStatement: String(body.shopper_statement || loc.name || 'ServOS').replace(/[^a-zA-Z0-9 .,'-]/g, '').slice(0, 22) || 'ServOS',
        phoneNumber: String(body.phone || '+441234567890'),
        address: {
          country: String(a.country || 'GB'),
          line1: String(a.line1 || '1 High Street'),
          city: String(a.city || 'London'),
          postalCode: String(a.postal_code || 'EC1A 1AA'),
        },
      };
      const r = await mgmt('POST', `/merchants/${merchant}/stores`, payload);
      if (scopeMissing(r.status)) return json({ ok: false, error: 'scope_missing' }, 200);
      if (!r.ok) return json({ ok: false, error: (r.data as Record<string, unknown>)?.detail || (r.data as Record<string, unknown>)?.title || `store create failed (${r.status})` }, 200);
      const storeId = String((r.data as Record<string, unknown>).id || '');
      const { error: upErr } = await platformAdmin.from('merchant_adyen_accounts').upsert({
        location_id: loc.id, merchant_account: merchant, store_id: storeId,
        region: 'EU', receive_payments_ok: true,
      }, { onConflict: 'location_id' });
      if (upErr) return json({ ok: false, error: `store created (${storeId}) but mapping write failed: ${upErr.message}` }, 500);
      const pm = await ensurePaymentMethods(merchant, storeId);
      return json({ ok: true, storeId, existing: false, paymentMethods: pm });
    }

    // Everything below needs the store mapping.
    if (!maa?.store_id) return json({ ok: false, error: 'no_store', hint: 'Run ensure_store first — the venue has no Adyen store yet.' }, 200);

    // ── ensure_payment_methods: repair a store missing its card schemes ──────
    if (action === 'ensure_payment_methods') {
      const pm = await ensurePaymentMethods(merchant, maa.store_id as string);
      return json({ ok: pm.errors.length === 0, ...pm });
    }

    // ── list: merchant fleet split store vs inventory, joined to our links ───
    if (action === 'list') {
      const r = await mgmt<{ data?: Record<string, unknown>[] }>('GET', `/terminals?merchantIds=${encodeURIComponent(merchant)}&pageSize=100`);
      if (scopeMissing(r.status)) return json({ ok: false, error: 'scope_missing' }, 200);
      if (!r.ok) return json({ ok: false, error: `terminal list failed (${r.status})` }, 200);
      const { data: links } = await opsAdmin.from('terminal_devices')
        .select('id, label, adyen_terminal_id, bound_pos_device_id, status, last_seen_at, tip_config, modes, idle_screen')
        .eq('location_id', opsLocationId).not('adyen_terminal_id', 'is', null).neq('status', 'retired');
      const linkBy = new Map((links || []).map((l) => [String(l.adyen_terminal_id), l]));
      const rows = (r.data.data || []).map((t) => {
        const asn = (t.assignment || {}) as Record<string, unknown>;
        return {
          id: t.id, model: t.model, serialNumber: t.serialNumber,
          firmwareVersion: t.firmwareVersion || null,
          lastActivityAt: t.lastActivityAt || null,
          onStore: asn.storeId === maa.store_id,
          assignmentStatus: asn.status || null,
          link: linkBy.get(String(t.id)) || null,
        };
      });
      return json({
        ok: true,
        store: rows.filter((x) => x.onStore),
        inventory: rows.filter((x) => !x.onStore),
      });
    }

    // ── find_by_serial: locate a boxed reader anywhere the credential sees ───
    // A fresh reader boards to COMPANY inventory, which the merchant-filtered
    // list can't show. The operator types the serial off the box label; this
    // searches credential-wide and returns candidates for assign.
    if (action === 'find_by_serial') {
      const serial = String(body.serial || '').replace(/[^a-zA-Z0-9]/g, '');
      if (serial.length < 6) return json({ ok: false, error: 'Type the full serial number from the label on the reader (or its box).' }, 200);
      const r = await mgmt<{ data?: Record<string, unknown>[] }>('GET', `/terminals?searchQuery=${encodeURIComponent(serial)}&pageSize=20`);
      if (scopeMissing(r.status)) return json({ ok: false, error: 'scope_missing' }, 200);
      if (!r.ok) return json({ ok: false, error: `search failed (${r.status})` }, 200);
      const matches = (r.data.data || []).map((t) => {
        const asn = (t.assignment || {}) as Record<string, unknown>;
        return {
          id: t.id, model: t.model, serialNumber: t.serialNumber,
          firmwareVersion: t.firmwareVersion || null, lastActivityAt: t.lastActivityAt || null,
          onStore: asn.storeId === maa.store_id,
          assignmentStatus: asn.status || null,
        };
      });
      return json({ ok: true, matches });
    }

    // ── assign: board onto the venue store + both link rows ──────────────────
    if (action === 'assign') {
      const terminalId = String(body.terminal_id || '');
      if (!terminalId) return json({ error: 'terminal_id required' }, 400);
      const label = String(body.label || '').slice(0, 60) || terminalId;

      // 1. Adyen-side: put the terminal on the venue's store (no-op if already there).
      const re = await mgmt('POST', `/terminals/${encodeURIComponent(terminalId)}/reassign`, { storeId: maa.store_id });
      if (scopeMissing(re.status)) return json({ ok: false, error: 'scope_missing' }, 200);
      // 409/422 "already assigned" is fine — anything else refuses loudly.
      if (!re.ok && re.status !== 409 && re.status !== 422) {
        return json({ ok: false, error: (re.data as Record<string, unknown>)?.detail || `reassign failed (${re.status})` }, 200);
      }

      const serial = terminalId.includes('-') ? terminalId.split('-').slice(1).join('-') : terminalId;

      // 2. Platform registry row (billing/fleet visibility) — keyed on the POIID.
      const { data: pdExisting } = await platformAdmin.from('payment_devices')
        .select('id').eq('adyen_terminal_id', terminalId).maybeSingle();
      if (pdExisting) {
        await platformAdmin.from('payment_devices')
          .update({ location_id: loc.id, label, status: 'online', processor: 'adyen' })
          .eq('id', pdExisting.id);
      } else {
        const { error: pdErr } = await platformAdmin.from('payment_devices').insert({
          location_id: loc.id, processor: 'adyen', adyen_terminal_id: terminalId,
          serial_number: serial, label, connection_kind: 'network', device_type: String(terminalId.split('-')[0] || 'AMS1'), status: 'online',
        });
        if (pdErr) return json({ ok: false, error: `platform registry write failed: ${pdErr.message}` }, 500);
      }

      // 3. Ops link row — what the charge path, till binding and the POS status
      // drawer all read. AMS1 has no on-device app, so no claim code: the row
      // is born 'paired'. device_uid is NOT NULL default auth.uid(), which is
      // NULL under service-role — synthesize one.
      const { data: tdExisting } = await opsAdmin.from('terminal_devices')
        .select('id, status').eq('adyen_terminal_id', terminalId).maybeSingle();
      let terminalDeviceId: string;
      if (tdExisting) {
        await opsAdmin.from('terminal_devices')
          .update({ location_id: opsLocationId, label, status: 'paired', active: true, claimed_at: new Date().toISOString() })
          .eq('id', tdExisting.id);
        terminalDeviceId = tdExisting.id;
      } else {
        const { data: td, error: tdErr } = await opsAdmin.from('terminal_devices').insert({
          device_uid: crypto.randomUUID(),
          serial_number: serial,
          location_id: opsLocationId,
          label,
          status: 'paired',
          active: true,
          claimed_at: new Date().toISOString(),
          adyen_terminal_id: terminalId,
        }).select('id').maybeSingle();
        if (tdErr || !td) return json({ ok: false, error: `terminal link write failed: ${tdErr?.message || 'no row'}` }, 500);
        terminalDeviceId = td.id;
      }
      return json({ ok: true, terminalDeviceId, poiid: terminalId });
    }

    // ── passcodes: the reader's on-device admin menu PIN (store-level) ───────
    if (action === 'passcodes') {
      const r = await mgmt<Record<string, unknown>>('GET', `/merchants/${merchant}/terminalSettings`);
      if (scopeMissing(r.status)) return json({ ok: false, error: 'scope_missing' }, 200);
      const sr = await mgmt<Record<string, unknown>>('GET', `/stores/${maa.store_id}/terminalSettings`);
      const merchantPass = (r.data?.passcodes || {}) as Record<string, unknown>;
      const storePass = (sr.data?.passcodes || {}) as Record<string, unknown>;
      // Set a known admin PIN at store level if none exists anywhere.
      if (!storePass.adminMenuPin && !merchantPass.adminMenuPin && body.set_default) {
        const pin = String(body.pin || '1111');
        const up = await mgmt('PATCH', `/stores/${maa.store_id}/terminalSettings`, { passcodes: { adminMenuPin: pin } });
        if (up.ok) return json({ ok: true, adminMenuPin: pin, source: 'set_now' });
        return json({ ok: false, error: (up.data as Record<string, unknown>)?.detail || `passcode set failed (${up.status})` }, 200);
      }
      return json({
        ok: true,
        adminMenuPin: storePass.adminMenuPin || merchantPass.adminMenuPin || null,
        refundPin: storePass.refundPin || merchantPass.refundPin || null,
        source: storePass.adminMenuPin ? 'store' : merchantPass.adminMenuPin ? 'merchant' : 'unset',
      });
    }

    // ── unlink: retire our link; the terminal stays boarded at Adyen ─────────
    if (action === 'unlink') {
      const tdId = String(body.terminal_device_id || '');
      if (!tdId) return json({ error: 'terminal_device_id required' }, 400);
      const { error } = await opsAdmin.from('terminal_devices')
        .update({ status: 'retired', active: false })
        .eq('id', tdId).eq('location_id', opsLocationId);
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: `unknown action: ${action}` }, 400);
  } catch (e) {
    console.error('[adyen-terminal-admin]', e);
    return json({ error: (e as Error).message || 'server error' }, 500);
  }
});
