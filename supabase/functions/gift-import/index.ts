// supabase/functions/gift-import/index.ts
//
// v5.5.200: Import gift cards from external sources. Accepts an array of
// cards with their balances. Each card gets a NEW code generated (the
// imported card's original code from the old system is stored as a note).
//
// Body: {
//   batch_name: string,
//   expires_at?: string (ISO date — applies to all cards in this batch),
//   cards: [{ balance, recipient_name?, recipient_email?, recipient_phone?, note?, original_code? }]
// }
//
// Returns: { batch_id, imported: number, cards: [{ code, code_last4, card_id }] }
//
// Max 500 cards per import. Each card gets a fresh 16-char code, hashed
// with the org's HMAC secret. The plaintext code is returned once.

import {
  cors, json, platformAdmin, authenticateCaller, resolveCompanyForLocation,
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

  const { batch_name, cards: inputCards, expires_at } = body as any;

  // v5.5.207: resolve company via location_id (reliable) with user fallback
  const companyResult = await resolveCompanyForLocation(caller.id, body.location_id as string);
  if (companyResult instanceof Response) return companyResult;
  const companyId = companyResult;

  // Validate
  if (!batch_name || typeof batch_name !== 'string' || !batch_name.trim()) {
    return json({ error: 'batch_name is required' }, 400);
  }
  if (!Array.isArray(inputCards) || inputCards.length === 0) {
    return json({ error: 'cards array is required and must not be empty' }, 400);
  }
  if (inputCards.length > 500) {
    return json({ error: 'Maximum 500 cards per import' }, 400);
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

  const batchId = crypto.randomUUID();
  const trimmedName = String(batch_name).trim();
  const results: Array<{ code: string; code_last4: string; card_id: string; balance: number }> = [];
  const errors: string[] = [];

  for (let i = 0; i < inputCards.length; i++) {
    const input = inputCards[i];
    try {
      const balanceMinor = Math.round(Number(input.balance));
      if (!Number.isFinite(balanceMinor) || balanceMinor <= 0) {
        errors.push(`Row ${i + 1}: invalid balance`);
        continue;
      }

      // Generate new code for this imported card
      const code = generateCode();
      const normalized = normalizeCode(code);
      const last4 = codeLast4(normalized);

      const [codeHash, lookup] = await Promise.all([
        hashValue(normalized),
        hmacLookup(normalized, config.hmac_secret),
      ]);

      // Collision check
      const { data: existing } = await platformAdmin
        .from('gift_cards')
        .select('id')
        .eq('code_lookup', lookup)
        .maybeSingle();
      if (existing) {
        errors.push(`Row ${i + 1}: code collision, skipped`);
        continue;
      }

      // Build note with original code reference if provided
      const notes: string[] = [];
      if (input.original_code) notes.push(`Imported from: ${input.original_code}`);
      if (input.note) notes.push(input.note);
      const fullNote = notes.join(' | ') || `Imported in batch: ${trimmedName}`;

      // Determine expiry: use batch-level expires_at if provided
      const cardExpiresAt = expires_at ? new Date(expires_at).toISOString() : null;

      // Insert card (store plaintext code for back-office voucher/resend)
      const { data: card, error: cardErr } = await platformAdmin
        .from('gift_cards')
        .insert({
          company_id: companyId,
          code_hash: codeHash,
          code_lookup: lookup,
          code_last4: last4,
          code_plain: normalized,
          initial_amount_minor: balanceMinor,
          balance_minor: balanceMinor,
          status: 'active',
          expires_at: cardExpiresAt,
          batch_id: batchId,
          batch_name: trimmedName,
          source: 'import',
          recipient_name: input.recipient_name || null,
          recipient_email: input.recipient_email || null,
          recipient_phone: input.recipient_phone || null,
          note: fullNote,
        })
        .select('id')
        .single();

      if (cardErr) {
        errors.push(`Row ${i + 1}: ${cardErr.message}`);
        continue;
      }

      // Ledger entry
      const { error: txErr } = await platformAdmin
        .from('gift_card_transactions')
        .insert({
          card_id: card.id,
          company_id: companyId,
          type: 'issue',
          amount_minor: balanceMinor,
          balance_after_minor: balanceMinor,
          channel: 'backoffice',
          note: `Import: ${trimmedName}`,
        });

      if (txErr) {
        await platformAdmin.from('gift_cards').delete().eq('id', card.id);
        errors.push(`Row ${i + 1}: ledger failed, rolled back`);
        continue;
      }

      results.push({
        code: formatCode(code),
        code_last4: last4,
        card_id: card.id,
        balance: balanceMinor,
      });
    } catch (e) {
      errors.push(`Row ${i + 1}: ${e.message}`);
    }
  }

  return json({
    batch_id: batchId,
    batch_name: trimmedName,
    imported: results.length,
    total: inputCards.length,
    cards: results,
    errors: errors.length > 0 ? errors : undefined,
    currency: config.currency,
  });
});
