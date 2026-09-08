// adyenLocalTerminal.js — v5.5.967 (ADYEN_INTEGRATION_PLAN.md Phase 3, built ahead)
//
// The web seam for taking an Adyen payment when THIS device can reach the
// terminal's LOCAL nexo endpoint — i.e. the MPOS app running ON an Adyen
// Android terminal (S1E4 Pro / S1E2L) via the AdyenNexoBridge, and later the
// Tap to Pay POS Mobile SDK (which consumes the identical PaymentRequest).
//
// Money contract (same as PaxPay, enforced server-side by adyen-terminal-charge):
//   1. 'prepare_local' — SERVER builds the nexo PaymentRequest from the job's
//      DB-proven amount and marks the job in-flight (CAS). We never build or
//      alter a payment message here.
//   2. Bridge posts it to https://127.0.0.1:8443/nexo and returns the raw
//      PaymentResponse.
//   3. 'report_local' — SERVER parses, sanity-checks and settles via the single
//      settle-writer RPC. The device's report is advisory, never authoritative.
//   4. Timeout/unknown → 'result' recovery (TransactionStatusRequest) owns it.
//      NEVER assume declined on a lost response.

import { supabase } from '../supabase';

const BRIDGE = () => (typeof window !== 'undefined' ? window.RposAdyenNexo : null);

/** True when running inside the MPOS wrapper on hardware with the local bridge. */
export function adyenLocalBridgeAvailable() {
  try { return !!BRIDGE()?.isAvailable(); } catch { return false; }
}

// Callback registry for the native bridge (window.__rposAdyenNexoCallback).
const _pending = new Map();
if (typeof window !== 'undefined' && !window.__rposAdyenNexoCallback) {
  window.__rposAdyenNexoCallback = (id, ok, payloadJson) => {
    const entry = _pending.get(id);
    if (!entry) return;
    _pending.delete(id);
    clearTimeout(entry.timer);
    let payload = null;
    try { payload = payloadJson ? JSON.parse(payloadJson) : null; } catch { payload = { error: 'bad_json', raw: payloadJson }; }
    entry.resolve({ ok: !!ok, payload });
  };
}

function postNexoViaBridge(nexoRequest, { timeoutMs = 160_000 } = {}) {
  return new Promise((resolve) => {
    const bridge = BRIDGE();
    if (!bridge) { resolve({ ok: false, payload: { error: 'no_bridge' } }); return; }
    const id = `nx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      if (_pending.has(id)) { _pending.delete(id); resolve({ ok: false, payload: { error: 'timeout' } }); }
    }, timeoutMs);
    _pending.set(id, { resolve, timer });
    try { bridge.postNexo(id, JSON.stringify(nexoRequest)); }
    catch (e) {
      _pending.delete(id); clearTimeout(timer);
      resolve({ ok: false, payload: { error: 'bridge_throw', message: e?.message } });
    }
  });
}

async function charge(action, body) {
  const { data, error } = await supabase.functions.invoke('adyen-terminal-charge', { body: { action, ...body } });
  if (error) throw new Error(error.message || 'adyen-terminal-charge failed');
  return data;
}

/**
 * Run a full local-terminal payment for an existing terminal job.
 * Returns the server's settled body: { ok, state: 'approved'|'declined'|..., card, ... }
 * or { ok:false, pending:true } when the outcome is with recovery.
 */
export async function runAdyenLocalPayment(jobId, { onStage } = {}) {
  onStage?.('preparing');
  const prep = await charge('prepare_local', { job_id: jobId });
  if (!prep?.ok) {
    // Already settled / in flight / not ready — surface the server's verdict.
    return prep ?? { ok: false, error: 'prepare failed' };
  }

  onStage?.('present_card');
  const res = await postNexoViaBridge(prep.nexo_request);

  if (res.ok && res.payload) {
    onStage?.('confirming');
    return await charge('report_local', { job_id: jobId, response: res.payload });
  }

  // Transport failed or timed out — the tender may STILL have completed on the
  // terminal. Ask the server to recover the truth; keep polling briefly.
  onStage?.('recovering');
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 3_000));
    const st = await charge('result', { job_id: jobId }).catch(() => null);
    if (st && st.state && st.state !== 'processing') return st;
  }
  return { ok: false, pending: true, error: 'outcome pending — the job will settle via recovery' };
}

/** Best-effort cancel of an in-flight tender (server relays an AbortRequest). */
export async function abortAdyenLocalPayment(jobId) {
  try { return await charge('abort', { job_id: jobId }); }
  catch (e) { return { ok: false, error: e?.message }; }
}
