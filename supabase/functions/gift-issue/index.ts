// supabase/functions/gift-issue/index.ts
//
// Issue a new gift card for an org. Generates a unique code, hashes it,
// and creates the card + initial ledger entry.
//
// Body: { org_id?, amount, recipient_email?, recipient_name?, recipient_phone?,
//         expires_at?, note?, staff_id?, location_id?, channel? }
//
// org_id is optional: if omitted, resolved from the caller's company role.

import {
  cors, json, platformAdmin, authenticateCaller, resolveCompanyId,
  generateCode, normalizeCode, codeLast4, formatCode,
  hmacLookup, hashValue, generateHmacSecret,
} from '../_shared/gift-card-utils.ts';

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
  } = body as any;

  // Resolve company
  let companyId = org_id as string | undefined;
  if (!companyId) {
    const resolved = await resolveCompanyId(caller.id);
    if (resolved instanceof Response) return resolved;
    companyId = resolved;
  }

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
      channel,
      staff_id: staff_id || null,
      note: note || null,
    });

  if (txErr) {
    // Rollback: delete the card
    await platformAdmin.from('gift_cards').delete().eq('id', card.id);
    return json({ error: `Failed to create ledger entry: ${txErr.message}` }, 500);
  }

  return json({
    card_id: card.id,
    code: formatCode(code),
    code_last4: last4,
    balance: amountMinor,
    currency: config.currency,
    expires_at: expiresAt,
    status: 'active',
  });
});
