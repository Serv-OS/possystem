// src/lib/payments/ryftTerminal.js
//
// Card-present (POS) Ryft terminal charge: start the on-terminal payment, then
// poll the underlying payment session until the customer taps and it reaches
// Approved/Captured. Mirrors the Stripe reader flow (process → poll → done).
// Built to the Ryft in-person spec; verify against a Ryft reader when hardware
// is available.

import { supabase, ensureAuthToken } from '../supabase';

async function invoke(name, body) {
  await ensureAuthToken();
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let msg = error.message || 'Payment error';
    try { const b = await error.context?.json?.(); if (b?.error) msg = b.error; } catch { /* keep */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

/**
 * Charge a card on the location's Ryft terminal.
 * @returns { paymentSessionId, status } once Approved/Captured.
 * Calls onProgress(state) during polling so the UI can show "present card…".
 */
export async function chargeRyftTerminal({ locationId, posDeviceId, amountMinor, currency = 'gbp', captureMethod = 'automatic', closedCheckId, metadata = {}, onProgress, signal, pollMs = 1200, timeoutMs = 120000 }) {
  const start = await invoke('ryft-terminal-payment', {
    location_id: locationId,
    pos_device_id: posDeviceId || null,
    amount_minor: amountMinor,
    currency,
    capture_method: captureMethod,
    closed_check_id: closedCheckId || null,
    metadata,
  });
  const { paymentSessionId, terminalId, accountId } = start;
  if (!paymentSessionId) throw new Error('Ryft terminal did not start a payment');
  onProgress?.('present_card');

  const began = Date.now();
  while (Date.now() - began < timeoutMs) {
    if (signal?.aborted) {
      try { await invoke('ryft-terminal-cancel', { terminal_id: terminalId, account_id: accountId }); } catch { /* best effort */ }
      throw new Error('cancelled');
    }
    await new Promise(r => setTimeout(r, pollMs));
    const s = await invoke('ryft-terminal-poll', { payment_session_id: paymentSessionId, account_id: accountId });
    onProgress?.(s.state, s.status);
    if (s.state === 'succeeded') return { paymentSessionId, terminalId, accountId, status: s.status, card: s.card || null };  // card = receipt block (scheme/last4/auth code)
    if (s.state === 'failed') throw new Error('Card declined or cancelled on the terminal');
  }
  // Timed out — try to cancel the dangling action.
  try { await invoke('ryft-terminal-cancel', { terminal_id: terminalId, account_id: accountId }); } catch { /* best effort */ }
  throw new Error('Payment timed out — please try again');
}

export async function cancelRyftTerminal(terminalId, accountId) {
  return invoke('ryft-terminal-cancel', { terminal_id: terminalId, account_id: accountId || null });
}
