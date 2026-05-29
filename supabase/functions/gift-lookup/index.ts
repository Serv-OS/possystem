// supabase/functions/gift-lookup/index.ts
//
// v5.5.197: Flexible gift card lookup.
//
// Accepts multiple search strategies:
//   { code }                    — full 16-char code (HMAC lookup)
//   { code_last4, email }       — last 4 + recipient email
//   { search }                  — smart search: auto-detects whether
//                                 input is a code, last4, email, or name
//   { location_id }             — optional, for POS anonymous auth fallback
//
// Returns card details and recent transactions.

import {
  cors, json, platformAdmin, authenticateCaller, resolveCompanyForLocation,
  normalizeCode, hmacLookup,
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

  const { code, code_last4, email, search, location_id: bodyLocationId } = body as any;

  // v5.5.207: resolve company via location_id (reliable) with user fallback
  const companyResult = await resolveCompanyForLocation(caller.id, bodyLocationId as string);
  if (companyResult instanceof Response) return companyResult;
  const companyId = companyResult;

  let card: any = null;
  let cards: any[] = [];
  let multiResult = false;

  if (code) {
    // ── Full code lookup via HMAC ──────────────────────────────────────
    const normalized = normalizeCode(code as string);
    if (normalized.length !== 16) {
      return json({ error: 'Code must be 16 characters' }, 400);
    }
    const { data: config } = await platformAdmin
      .from('gift_brand_config')
      .select('hmac_secret, currency')
      .eq('company_id', companyId)
      .maybeSingle();
    if (!config) return json({ error: 'Gift cards not configured for this org' }, 404);

    const lookup = await hmacLookup(normalized, config.hmac_secret);
    const { data } = await platformAdmin
      .from('gift_cards')
      .select('*')
      .eq('code_lookup', lookup)
      .eq('company_id', companyId)
      .maybeSingle();
    card = data;

    // v5.5.337: fallback to code_plain when the HMAC lookup misses. Some
    // online-issued cards stored a differently-computed (32-char) code_lookup,
    // so HMAC can't find them — but code_plain is exact. gift-redeem already
    // has this fallback; gift-lookup didn't, so the POS (which looks up BEFORE
    // it redeems) failed with "Card not found" before redeem could recover.
    if (!card) {
      const { data: byPlain } = await platformAdmin
        .from('gift_cards')
        .select('*')
        .eq('code_plain', normalized)
        .eq('company_id', companyId)
        .maybeSingle();
      card = byPlain;
    }

  } else if (code_last4 && email) {
    // ── Legacy: last4 + email ─────────────────────────────────────────
    const { data } = await platformAdmin
      .from('gift_cards')
      .select('*')
      .eq('company_id', companyId)
      .eq('code_last4', String(code_last4).toUpperCase())
      .eq('recipient_email', String(email).toLowerCase().trim())
      .maybeSingle();
    card = data;

  } else if (search) {
    // ── Smart search: auto-detect what was typed ──────────────────────
    const q = String(search).trim();

    // 1. Looks like a full 16-char code?
    const cleaned = q.replace(/[\s-]/g, '').toUpperCase();
    if (/^[A-Z2-9]{16}$/.test(cleaned)) {
      const { data: config } = await platformAdmin
        .from('gift_brand_config')
        .select('hmac_secret, currency')
        .eq('company_id', companyId)
        .maybeSingle();
      if (config) {
        const lookup = await hmacLookup(cleaned, config.hmac_secret);
        const { data } = await platformAdmin
          .from('gift_cards')
          .select('*')
          .eq('code_lookup', lookup)
          .eq('company_id', companyId)
          .maybeSingle();
        card = data;
        if (!card) {
          // v5.5.337: same code_plain fallback as the direct-code path above.
          const { data: byPlain } = await platformAdmin
            .from('gift_cards')
            .select('*')
            .eq('code_plain', cleaned)
            .eq('company_id', companyId)
            .maybeSingle();
          card = byPlain;
        }
      }
    }

    // 2. If no full-code match, try by last4 (2-4 uppercase chars)
    if (!card && /^[A-Z2-9]{2,4}$/i.test(cleaned)) {
      const { data } = await platformAdmin
        .from('gift_cards')
        .select('*')
        .eq('company_id', companyId)
        .eq('code_last4', cleaned.toUpperCase())
        .order('created_at', { ascending: false })
        .limit(10);
      if (data?.length === 1) {
        card = data[0];
      } else if (data?.length > 1) {
        cards = data;
        multiResult = true;
      }
    }

    // 3. If no match yet, try email (contains @)
    if (!card && !multiResult && q.includes('@')) {
      const { data } = await platformAdmin
        .from('gift_cards')
        .select('*')
        .eq('company_id', companyId)
        .ilike('recipient_email', q.toLowerCase().trim())
        .order('created_at', { ascending: false })
        .limit(10);
      if (data?.length === 1) {
        card = data[0];
      } else if (data?.length > 1) {
        cards = data;
        multiResult = true;
      }
    }

    // 4. Try name search (ilike)
    if (!card && !multiResult && q.length >= 2 && !q.includes('@')) {
      const { data } = await platformAdmin
        .from('gift_cards')
        .select('*')
        .eq('company_id', companyId)
        .ilike('recipient_name', `%${q}%`)
        .order('created_at', { ascending: false })
        .limit(10);
      if (data?.length === 1) {
        card = data[0];
      } else if (data?.length > 1) {
        cards = data;
        multiResult = true;
      }
    }
  } else {
    return json({ error: 'Provide { code }, { code_last4, email }, or { search }' }, 400);
  }

  // ── Multiple results ──────────────────────────────────────────────────
  if (multiResult && cards.length > 0) {
    const { data: config } = await platformAdmin
      .from('gift_brand_config')
      .select('currency')
      .eq('company_id', companyId)
      .maybeSingle();
    return json({
      multiple: true,
      count: cards.length,
      cards: cards.map(c => ({
        card_id: c.id,
        status: c.status,
        balance: c.balance_minor,
        initial_amount: c.initial_amount_minor,
        currency: config?.currency || 'gbp',
        code_last4: c.code_last4,
        expires_at: c.expires_at,
        issued_at: c.issued_at,
        recipient_name: c.recipient_name,
        recipient_email: c.recipient_email,
      })),
    });
  }

  if (!card) return json({ error: 'Card not found' }, 404);

  // Get currency from brand config
  const { data: config } = await platformAdmin
    .from('gift_brand_config')
    .select('currency')
    .eq('company_id', companyId)
    .maybeSingle();

  // Fetch recent transactions (last 20)
  const { data: txns } = await platformAdmin
    .from('gift_card_transactions')
    .select('id, type, amount_minor, balance_after_minor, location_id, order_id, channel, staff_id, note, created_at')
    .eq('card_id', card.id)
    .order('created_at', { ascending: false })
    .limit(20);

  return json({
    card_id: card.id,
    status: card.status,
    balance: card.balance_minor,
    initial_amount: card.initial_amount_minor,
    currency: config?.currency || 'gbp',
    code_last4: card.code_last4,
    expires_at: card.expires_at,
    issued_at: card.issued_at,
    recipient_name: card.recipient_name,
    recipient_email: card.recipient_email,
    note: card.note,
    recent_transactions: txns ?? [],
  });
});
