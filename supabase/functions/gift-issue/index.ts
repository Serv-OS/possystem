// supabase/functions/gift-issue/index.ts
//
// Issue a new gift card for an org. Generates a unique code, hashes it,
// and creates the card + initial ledger entry.
//
// Body: { org_id?, amount, recipient_email?, recipient_name?, recipient_phone?,
//         expires_at?, note?, staff_id?, location_id?, channel?, closed_check_id? }
//
// org_id is optional: if omitted, resolved from the caller's company role.
//
// v5.11.118 (Drop C, sell gift cards at the till). channel 'pos' is the paired till printing a
// brand new card after a paid sale. The caller may then be a device BOUND to the venue (the
// till is an anonymous session) or staff (_shared/gift-authority.ts decideGiftTillAuthority);
// location_id and closed_check_id are required; the card gets source 'pos' and
// issued_at_location_id; the 'issue' ledger row carries channel 'pos', order_id = the closed
// check id and staff_id; the reply adds balance_minor and balance_url (the venue's public
// balance page) for the slip. Every other channel is Back Office and unchanged: staff only.

import {
  cors, json, platformAdmin, authenticateCaller, resolveCompanyForLocation,
  generateCode, normalizeCode, codeLast4, formatCode,
  hmacLookup, hashValue, generateHmacSecret,
} from '../_shared/gift-card-utils.ts';
import { requireStaff, callerStaffOrDevice, recordAuthority, deviceHintOf } from '../_shared/loyalty-utils.ts';
import { decideGiftTillAuthority } from '../_shared/gift-authority.ts';
import { authorityLogRow } from '../_shared/loyalty-authority.ts';

/** The venue's public balance page, from the Platform locations row (ops id first, then id). */
async function balanceUrlFor(locationId: string | null): Promise<string | null> {
  if (!locationId) return null;
  let { data } = await platformAdmin.from('locations').select('online_slug').eq('ops_location_id', locationId).maybeSingle();
  if (!data) ({ data } = await platformAdmin.from('locations').select('online_slug').eq('id', locationId).maybeSingle());
  return data?.online_slug ? `https://${data.online_slug}.serv-os.app/gift/balance` : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // Auth
  const authResult = await authenticateCaller(req);
  if (authResult instanceof Response) return authResult;
  const caller = authResult.user;

  // Parse body
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const {
    org_id,
    amount,
    recipient_email,
    recipient_name,
    recipient_phone,
    expires_at,
    note,
    staff_id,
    location_id,
    channel = 'backoffice',
    closed_check_id,
  } = body as any;
  const isTill = channel === 'pos';
  if (isTill && !location_id) return json({ error: 'location_id required for a till issue' }, 400);
  if (isTill && (closed_check_id == null || String(closed_check_id).trim() === '')) {
    return json({ error: 'closed_check_id required for a till issue' }, 400);
  }

  // v5.5.207: resolve company via location_id (reliable) with user fallback.
  // 18 Sep 2026 (round three): the company always comes from the location when one is sent; a
  // body org_id can no longer point the card at another company. org_id alone (no location) is
  // only accepted for staff of that company (checked below).
  let companyId: string | undefined;
  if (location_id) {
    const resolved = await resolveCompanyForLocation(caller.id, location_id as string);
    if (resolved instanceof Response) return resolved;
    companyId = resolved;
    if (org_id && String(org_id) !== String(companyId)) {
      return json({ error: 'org_id does not match the location', code: 'company_mismatch' }, 403);
    }
  } else if (org_id) {
    companyId = String(org_id);
  } else {
    const resolved = await resolveCompanyForLocation(caller.id, null);
    if (resolved instanceof Response) return resolved;
    companyId = resolved;
  }

  // ── Who may issue (18 Sep 2026, round three, enforced now) ─────────────
  // Any session used to be able to create a card for any amount here and be handed the code
  // (an anonymous one is free with the public anon key). Back Office (GiftCards.jsx, a signed in
  // user) is staff only, the same access rule as the database (_shared/staffAccess.ts).
  // v5.11.118: channel 'pos' is the paired till after a paid sale: staff, or a device BOUND to
  // the venue (the device arm of pos_can_access). Never an unbound session.
  const tillRefusal = async (): Promise<Response | null> => {
    const who = await callerStaffOrDevice(caller, (location_id as string) || null, String(companyId));
    const authority = decideGiftTillAuthority({ user: caller, staff: who.staff, device: who.device, deviceReason: who.deviceReason }, 'issue gift cards at the till');
    if (authority.ok) return null;
    recordAuthority(authorityLogRow({
      fn: 'gift-issue', mode: 'enforce', outcome: 'refused',
      decision: { ok: false, reason: authority.reason, callerKind: caller?.is_anonymous ? (who.deviceReason === 'other_venue' || who.deviceReason === 'not_bound' ? 'device_other' : 'anonymous') : 'user_no_access' },
      user: caller, companyId, locationId: location_id, closedCheckId: closed_check_id, channel,
      deviceHint: deviceHintOf(body), detail: { device_reason: who.deviceReason },
    }));
    return json({ error: authority.error, code: 'gift_till_not_allowed', reason: authority.reason }, authority.status);
  };
  const refused = isTill ? await tillRefusal() : await requireStaff({
    fn: 'gift-issue', caller, locationId: (location_id as string) || null, companyId: companyId!,
    what: 'issue gift cards', body,
  });
  if (refused) return refused;

  // Validate amount
  const amountMinor = Math.round(Number(amount));
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    return json({ error: 'amount must be a positive number (minor currency units)' }, 400);
  }

  // Get or create brand config
  let { data: config } = await platformAdmin
    .from('gift_brand_config')
    .select('*')
    .eq('company_id', companyId)
    .maybeSingle();

  if (!config) {
    // Auto-create brand config on first issue
    const hmacSecret = generateHmacSecret();
    const { data: newConfig, error: cfgErr } = await platformAdmin
      .from('gift_brand_config')
      .insert({
        company_id: companyId,
        enabled: true,
        hmac_secret: hmacSecret,
      })
      .select()
      .single();
    if (cfgErr) return json({ error: `Failed to create gift config: ${cfgErr.message}` }, 500);
    config = newConfig;
  }

  if (!config.enabled) {
    return json({ error: 'Gift cards are not enabled for this organization' }, 403);
  }

  // Validate against brand config limits
  if (amountMinor < config.min_card_value_minor) {
    return json({ error: `Amount below minimum (${config.min_card_value_minor} minor units)` }, 400);
  }
  if (amountMinor > config.max_card_value_minor) {
    return json({ error: `Amount exceeds maximum (${config.max_card_value_minor} minor units)` }, 400);
  }

  // Generate code and hashes
  const code = generateCode();
  const normalized = normalizeCode(code);
  const last4 = codeLast4(normalized);

  const [codeHash, lookup] = await Promise.all([
    hashValue(normalized),
    hmacLookup(normalized, config.hmac_secret),
  ]);

  // Check for collision on lookup index (astronomically unlikely but safe)
  const { data: existing } = await platformAdmin
    .from('gift_cards')
    .select('id')
    .eq('code_lookup', lookup)
    .maybeSingle();
  if (existing) {
    return json({ error: 'Code collision detected, please retry' }, 500);
  }

  // Compute expiry
  let expiresAt: string | null = null;
  if (expires_at) {
    expiresAt = new Date(expires_at as string).toISOString();
  } else if (config.default_expiry_months) {
    const d = new Date();
    d.setMonth(d.getMonth() + config.default_expiry_months);
    expiresAt = d.toISOString();
  }

  // Insert card (store plaintext code for back-office voucher/resend)
  const { data: card, error: cardErr } = await platformAdmin
    .from('gift_cards')
    .insert({
      company_id: companyId,
      code_hash: codeHash,
      code_lookup: lookup,
      code_last4: last4,
      code_plain: normalized,
      initial_amount_minor: amountMinor,
      balance_minor: amountMinor,
      status: 'active',
      expires_at: expiresAt,
      issued_by_staff_id: staff_id || null,
      issued_at_location_id: location_id || null,
      recipient_name: recipient_name || null,
      recipient_email: recipient_email || null,
      recipient_phone: recipient_phone || null,
      note: note || null,
      // v5.11.118: a card the till printed says so; Back Office keeps the column default.
      ...(isTill ? { source: 'pos' } : {}),
    })
    .select('id')
    .single();

  if (cardErr) return json({ error: `Failed to create card: ${cardErr.message}` }, 500);

  // Insert initial ledger entry
  const { error: txErr } = await platformAdmin
    .from('gift_card_transactions')
    .insert({
      card_id: card.id,
      company_id: companyId,
      type: 'issue',
      amount_minor: amountMinor,
      balance_after_minor: amountMinor,
      location_id: location_id || null,
      // v5.11.118: the till's issue row names the closed check it was sold on (gift-load status
      // lists the cards of a check by this). Back Office issues carry no order.
      order_id: isTill ? String(closed_check_id) : null,
      channel,
      staff_id: staff_id || null,
      note: note || null,
    });

  if (txErr) {
    // Rollback: delete the card
    await platformAdmin.from('gift_cards').delete().eq('id', card.id);
    return json({ error: `Failed to create ledger entry: ${txErr.message}` }, 500);
  }

  // v5.11.118: the slip prints where the customer checks the balance.
  const balanceUrl = isTill ? await balanceUrlFor((location_id as string) || null) : null;

  return json({
    card_id: card.id,
    code: formatCode(code),
    code_last4: last4,
    balance: amountMinor,
    balance_minor: amountMinor,
    balance_url: balanceUrl,
    currency: config.currency,
    expires_at: expiresAt,
    status: 'active',
  });
});
