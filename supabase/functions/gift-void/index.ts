// supabase/functions/gift-void/index.ts
//
// Void a gift card. Zeroes the balance and marks it as voided.
// Irreversible. Used by back office staff.
//
// Body: { card_id, reason, staff_id? }

import {
  cors, json, platformAdmin, authenticateCaller, resolveCompanyForLocation,
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

  // v5.5.207: resolve company via location_id (reliable) with user fallback
  const companyResult = await resolveCompanyForLocation(caller.id, body.location_id as string);
  if (companyResult instanceof Response) return companyResult;
  const companyId = companyResult;

  const { card_id, reason, staff_id } = body as any;

  if (!card_id) return json({ error: 'card_id required' }, 400);
  if (!reason) return json({ error: 'reason required' }, 400);

  // Get card
  const { data: card } = await platformAdmin
    .from('gift_cards')
    .select('id, company_id, balance_minor, status')
    .eq('id', card_id)
    .eq('company_id', companyId)
    .maybeSingle();

  if (!card) return json({ error: 'Card not found' }, 404);
  if (card.status === 'voided') return json({ error: 'Card is already voided' }, 400);

  const remainingBalance = card.balance_minor;

  // Insert void ledger entry (debit any remaining balance)
  if (remainingBalance > 0) {
    const { error: txErr } = await platformAdmin
      .from('gift_card_transactions')
      .insert({
        card_id: card.id,
        company_id: companyId,
        type: 'void',
        amount_minor: -remainingBalance,    // negative = debit remaining
        balance_after_minor: 0,
        channel: 'backoffice',
        staff_id: staff_id || null,
        note: reason,
      });
    if (txErr) return json({ error: `Ledger write failed: ${txErr.message}` }, 500);
  }

  // Mark card as voided
  const { error: updErr } = await platformAdmin
    .from('gift_cards')
    .update({
      status: 'voided',
      balance_minor: 0,
      voided_at: new Date().toISOString(),
      voided_by: staff_id || caller.id,
      voided_reason: reason,
    })
    .eq('id', card.id);

  if (updErr) return json({ error: `Card update failed: ${updErr.message}` }, 500);

  return json({
    card_id: card.id,
    status: 'voided',
    previous_balance: remainingBalance,
  });
});
