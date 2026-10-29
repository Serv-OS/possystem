// supabase/functions/gift-bulk-create/index.ts
//
// v5.5.199: Bulk-create gift cards. Creates a batch of cards with the same
// value. No recipient details required — cards are anonymous until redeemed.
//
// Body: { amount, quantity, batch_name, expires_at?, blank? }
//   amount     — card value in minor currency units (e.g. 2500 = £25); not needed when blank
//   quantity   — number of cards to create (1-500)
//   batch_name — user-defined label for this batch
//   expires_at — optional ISO date (overrides default_expiry_months)
//   blank      — v5.11.118 (Drop C): true makes PRINTED cards with nothing on them: initial 0,
//                balance 0, status 'blank', source 'bulk'. The till loads them at the sale
//                (gift-load). No ledger row until then; no expiry (it starts when loaded).
//
// Returns: { batch_id, batch_name, quantity, cards: [{ code, code_last4, card_id }], blank }
//
// The plaintext codes are returned ONCE in the response. They are hashed
// on the card record and cannot be recovered later.

import {
  cors, json, platformAdmin, authenticateCaller, resolveCompanyForLocation,
  generateCode, normalizeCode, codeLast4, formatCode,
  hmacLookup, hashValue, generateHmacSecret,
} from '../_shared/gift-card-utils.ts';
import { requireStaff } from '../_shared/loyalty-utils.ts';

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
  const blank = (body as any).blank === true;

  // v5.5.207: resolve company via location_id (reliable) with user fallback
  const companyResult = await resolveCompanyForLocation(caller.id, body.location_id as string);
  if (companyResult instanceof Response) return companyResult;
  const companyId = companyResult;

  // ── Staff only (18 Sep 2026, round three, enforced now) ────────────────
  // Any session could create 500 cards of any value and be handed every code. The only caller is
  // Back Office (GiftCards.jsx Bulk create, a signed in user).
  const refused = await requireStaff({
    fn: 'gift-bulk-create', caller, locationId: (body.location_id as string) || null, companyId,
    what: 'create gift cards', body,
  });
  if (refused) return refused;

  // Validate. A blank batch carries no amount (0 on the card until the till loads it).
  const amountMinor = blank ? 0 : Math.round(Number(amount));
  if (!blank && (!Number.isFinite(amountMinor) || amountMinor <= 0)) {
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

  // Validate against limits (a blank card has no value yet; gift-load checks the loaded amount)
  if (!blank && amountMinor < config.min_card_value_minor) {
    return json({ error: `Amount below minimum (${config.min_card_value_minor} minor units)` }, 400);
  }
  if (!blank && amountMinor > config.max_card_value_minor) {
    return json({ error: `Amount exceeds maximum (${config.max_card_value_minor} minor units)` }, 400);
  }

  // Compute expiry. A blank card's clock starts when it is loaded, so none is set here.
  let expiresAt: string | null = null;
  if (blank) {
    expiresAt = null;
  } else if (expires_at) {
    expiresAt = new Date(expires_at as string).toISOString();
  } else if (config.default_expiry_months) {
    const d = new Date();
    d.setMonth(d.getMonth() + config.default_expiry_months);
    expiresAt = d.toISOString();
  }

  // 30 Oct 2026 (v5.11.120): each code is hashed with a deliberately slow hash (argon2id, 16 MB), so a
  // request of 50 ran past the function's time limit after 33 cards (HTTP 546). A request now makes
  // at most PER_CALL cards and answers `remaining`; Back Office keeps calling with the same batch_id
  // until remaining is 0. A continued batch reuses its id and name.
  const PER_CALL = 20;
  const batchId = (body as any).batch_id ? String((body as any).batch_id) : crypto.randomUUID();
  const todo = Math.min(qty, PER_CALL);
  const trimmedName = String(batch_name).trim();
  const results: Array<{ code: string; code_last4: string; card_id: string }> = [];
  const errors: string[] = [];

  // Generate this call's cards
  for (let i = 0; i < todo; i++) {
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
          status: blank ? 'blank' : 'active',
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

      // A blank card has no ledger row until the till loads it (gift-load writes 'load').
      if (blank) {
        results.push({ code: formatCode(code), code_last4: last4, card_id: card.id });
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
    remaining: Math.max(0, qty - todo),   // v5.11.120: what the caller still has to ask for
    cards: results,
    errors: errors.length > 0 ? errors : undefined,
    currency: config.currency,
    amount: amountMinor,
    expires_at: expiresAt,
    blank,
  });
});
