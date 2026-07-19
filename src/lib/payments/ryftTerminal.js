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
 * @returns { paymentSessionId, terminalId, accountId, status, card, amountMinor, currency }
 * once Approved/Captured — amountMinor is what Ryft reports as actually captured
 * (null on older fn responses that don't return it).
 * Calls onProgress(state) during polling so the UI can show "present card…".
 * Thrown errors may carry: .cancelled (staff abort), .cancelConfirmed (whether the
 * terminal-cancel call succeeded), .declined (definitive card decline).
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

  // Best-effort terminal-action cancel; returns whether it was CONFIRMED.
  const cancelAction = async () => {
    try { await invoke('ryft-terminal-cancel', { terminal_id: terminalId, account_id: accountId }); return true; }
    catch { return false; }
  };
  // Staff/unmount abort: cancel the terminal action and report whether the
  // cancel actually landed, so the UI can refuse to walk away from a PAX that
  // might still be live collecting a card.
  const abortError = async () => {
    const confirmed = await cancelAction();
    const err = new Error('cancelled');
    err.cancelled = true;
    err.cancelConfirmed = confirmed;
    return err;
  };

  const began = Date.now();
  let pollFailures = 0;                // CONSECUTIVE transient poll failures
  const MAX_POLL_FAILURES = 5;         // ~6s of continuous failure before giving up
  while (Date.now() - began < timeoutMs) {
    if (signal?.aborted) throw await abortError();
    await new Promise(r => setTimeout(r, pollMs));
    if (signal?.aborted) throw await abortError();

    // One transient poll failure must NOT kill a live payment — the PAX may be
    // mid-tap. Retry a few times; only a sustained outage is fatal, and a fatal
    // exit cancels the terminal action so the reader doesn't sit live collecting.
    let s;
    try {
      s = await invoke('ryft-terminal-poll', { payment_session_id: paymentSessionId, account_id: accountId });
      pollFailures = 0;
    } catch (e) {
      pollFailures += 1;
      if (pollFailures >= MAX_POLL_FAILURES) {
        await cancelAction();
        throw new Error('Lost contact with the payment service — the terminal payment was cancelled. Please try again.');
      }
      continue;
    }

    onProgress?.(s.state, s.status);

    // Decline: the new poll fn exposes a definitive `declined` flag + `lastError`;
    // the old shape only ever reports state 'failed'. Tolerate both and stop
    // IMMEDIATELY — a decline must never present as a 2-minute timeout.
    const declined = s.declined === true || (!!s.lastError && s.state !== 'succeeded');
    if (declined || s.state === 'failed') {
      const err = new Error(declined ? 'Card declined — try another card' : 'Card declined or cancelled on the terminal');
      err.declined = declined;
      err.lastError = s.lastError || null;
      throw err;
    }
    if (s.state === 'succeeded') {
      return {
        paymentSessionId, terminalId, accountId, status: s.status,
        card: s.card || null,                                        // receipt block (scheme/last4/auth code)
        amountMinor: Number.isFinite(s.amount) ? s.amount : null,    // what Ryft actually captured
        currency: s.currency || null,
      };
    }
  }
  // Timed out — cancel the dangling action.
  await cancelAction();
  throw new Error('Payment timed out — please try again');
}

export async function cancelRyftTerminal(terminalId, accountId) {
  return invoke('ryft-terminal-cancel', { terminal_id: terminalId, account_id: accountId || null });
}
