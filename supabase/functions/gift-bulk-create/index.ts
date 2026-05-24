// supabase/functions/gift-bulk-create/index.ts
//
// v5.5.199: Bulk-create gift cards. Creates a batch of cards with the same
// value. No recipient details required — cards are anonymous until redeemed.
//
// Body: { amount, quantity, batch_name, expires_at? }
//   amount     — card value in minor currency units (e.g. 2500 = £25)
//   quantity   — number of cards to create (1-500)
//   batch_name — user-defined label for this batch
//   expires_at — optional ISO date (overrides default_expiry_months)
//
// Returns: { batch_id, batch_name, quantity, cards: [{ code, code_last4, card_id }] }
//
// The plaintext codes are returned ONCE in the response. They are hashed
// on the card record and cannot be recovered later.

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

  const { amount, quantity, batch_name, expires_at } = body as any;

  // Resolve company
  const companyResult = await resolveCompanyId(caller.id);
  if (companyResult instanceof Response) return companyResult;
  const companyId = companyResult;

  // Validate
  const amountMinor = Math.round(Number(amount));
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    return json({ error: 'amount must be positive (minor currency units)' }, 400);
  }
  const qty = Math.round(Number(quantity));
  if (!Number.isFinite(qty) || qty < 1 || qty > 500) {
    return json({ error: 'quantity must be between 1 and 500' }, 400);
  }
  if (!batch_name || typeof batch_name !== 'string' || !batch_name.trim()) {
    return json({ error: 'batch_name is required' }, 400);
  }

  // Get or create brand config
  let { data: config } = await platformAdmin
    .from('gift_brand_config')
    .select('*')
    .eq('company_id', companyId)
    .maybeSingle();

  if (!config) {
    const hmacSecret = generateHmacSecret();
    const { data: newConfig, error: cfgErr } = await platformAdmin
      .from('gift_brand_config')
      .insert({ company_id: companyId, enabled: true, hmac_secret: hmacSecret })
      .select().single();
    if (cfgErr) return json({ error: `Config creation failed: ${cfgErr.message}` }, 500);
    config = newConfig;
  }

  // Validate against limits
  if (amountMinor < config.min_card_value_minor) {
    return json({ error: `Amount below minimum (${config.min_card_value_minor} minor units)` }, 400);
  }
  if (amountMinor > config.max_card_value_minor) {
    return json({ error: `Amount exceeds maximum (${config.max_card_value_minor} minor units)` }, 400);
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

  // Generate batch ID
  const batchId = crypto.randomUUID();
  const trimmedName = String(batch_name).trim();
  const results: Array<{ code: string; code_last4: string; card_id: string }> = [];
  const errors: string[] = [];

  // Generate all cards
  for (let i = 0; i < qty; i++) {
    try {
      const code = generateCode();
      const normalized = normalizeCode(code);
      const last4 = codeLast4(normalized);

      const [codeHash, lookup] = await Promise.all([
        hashValue(normalized),
        hmacLookup(normalized, config.hmac_secret),
      ]);

      // Check collision
      const { data: existing } = await platformAdmin
        .from('gift_cards')
        .select('id')
        .eq('code_lookup', lookup)
        .maybeSingle();
      if (existing) {
        errors.push(`Card ${i + 1}: code collision, skipped`);
        continue;
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
          batch_id: batchId,
          batch_name: trimmedName,
          source: 'bulk',
        })
        .select('id')
        .single();

      if (cardErr) {
        errors.push(`Card ${i + 1}: ${cardErr.message}`);
        continue;
      }

      // Insert ledger entry
      const { error: txErr } = await platformAdmin
        .from('gift_card_transactions')
        .insert({
          card_id: card.id,
          company_id: companyId,
          type: 'issue',
          amount_minor: amountMinor,
          balance_after_minor: amountMinor,
          channel: 'backoffice',
          note: `Bulk batch: ${trimmedName}`,
        });

      if (txErr) {
        await platformAdmin.from('gift_cards').delete().eq('id', card.id);
        errors.push(`Card ${i + 1}: ledger failed, rolled back`);
        continue;
      }

      results.push({
        code: formatCode(code),
        code_last4: last4,
        card_id: card.id,
      });
    } catch (e) {
      errors.push(`Card ${i + 1}: ${e.message}`);
    }
  }

  return json({
    batch_id: batchId,
    batch_name: trimmedName,
    quantity: results.length,
    requested: qty,
    cards: results,
    errors: errors.length > 0 ? errors : undefined,
    currency: config.currency,
    amount: amountMinor,
    expires_at: expiresAt,
  });
});
