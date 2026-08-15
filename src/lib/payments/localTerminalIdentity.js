// localTerminalIdentity.js — v5.6.81
//
// "THIS DEVICE IS THE CARD READER."
//
// Every other card path in the codebase assumes the reader is somewhere else: a
// Stripe WisePOS on the counter, a PAX A920 on the bar, an AMS1 the till drives
// over the cloud. An Adyen Android terminal (S1F2L / S1E2L / S1E4 Pro) running our
// MPOS wrapper is BOTH the till and the reader, so before it can take a payment it
// has to hold a terminal_devices row of its OWN — the same row a PAX self-registers
// and a manager claims in Back Office → Card readers.
//
// This module is only that: identity. It never touches money. The payment itself
// stays in adyenLocalTerminal.js (nexo transport) and the server (adyen-terminal-charge).
//
// WHY A SERIAL FROM THE NATIVE BRIDGE
//   register_terminal_device(p_serial, p_app_version) keys the pairing on a STABLE
//   hardware serial so a reinstall re-adopts the same row instead of orphaning it.
//   A WebView cannot read one, so AdyenNexoBridge.getSerial() supplies it using the
//   exact ladder paxpay uses (Build.getSerial → AID-<ANDROID_ID> → UUID-<random>,
//   frozen in the wrapper's SharedPreferences on first call).
//
// IDENTITY, AND WHY THIS IS STILL SAFE
//   One browser holds ONE Supabase session (storageKey 'rpos-auth'), so this device
//   has exactly one auth.uid(). That single uid ends up on BOTH sides of the fence:
//     • devices.device_uid        — stamped by claim_device() when MPOS pairs as a
//                                   POS-family device (the till identity).
//     • terminal_devices.device_uid — stamped by register_terminal_device() from
//                                   auth.uid(), never client-supplied (the reader
//                                   identity).
//   Neither is self-asserted: the till identity is gated on the pairing CODE, the
//   reader identity on a manager typing the claim code into Back Office. A device
//   that has done neither resolves to `ok:false` here and cannot mint a job at all.
//
// Static imports only — dynamic import() silently fails in this Vite bundle.

import { supabase, ensureAuthToken, getActiveLocationSync, isMock } from '../supabase';
import { VERSION } from '../version';

const BRIDGE = () => (typeof window !== 'undefined' ? window.RposAdyenNexo : null);

/**
 * The wrapper's hardware serial, or null outside the native MPOS app.
 * Never invents one: no bridge means no self-registration, by design.
 */
export function localTerminalSerial() {
  try {
    const s = BRIDGE()?.getSerial?.();
    const v = typeof s === 'string' ? s.trim() : '';
    return v || null;
  } catch { return null; }
}

/** The native wrapper's versionName, falling back to the web build's version. */
export function localTerminalAppVersion() {
  let native = '';
  try { native = String(BRIDGE()?.appVersion?.() || '').trim(); } catch { native = ''; }
  return native ? `mpos ${native} / web ${VERSION}` : `web ${VERSION}`;
}

/**
 * Self-register (idempotently) and return the pairing state.
 * Shape mirrors register_terminal_device: { deviceId, claimCode, status, locationId, label }.
 * Returns null when there is nothing to register against (no bridge / mock / no serial).
 *
 * Calling this repeatedly is CHEAP AND CORRECT: the RPC returns the SAME claim code
 * for an unpaired row and refreshes last_seen_at, which is what keeps the 30-minute
 * claim TTL alive while a manager walks to the office to type the code in.
 */
export async function registerLocalTerminal() {
  if (isMock || !supabase) return null;
  const serial = localTerminalSerial();
  if (!serial) return null;
  await ensureAuthToken();
  const { data, error } = await supabase.rpc('register_terminal_device', {
    p_serial: serial,
    p_app_version: localTerminalAppVersion(),
  });
  // supabase-js RESOLVES with { data, error } — it never rejects. Destructure and log.
  if (error) {
    console.warn('[localTerminal] register_terminal_device failed:', error.message);
    return null;
  }
  if (!data) return null;
  return {
    deviceId: data.device_id ?? null,
    claimCode: data.claim_code ?? null,
    status: data.status ?? 'unpaired',
    locationId: data.location_id ?? null,
    label: data.label ?? null,
  };
}

/** Keep Back Office's "last seen" honest. Best effort — never throws into a caller. */
export async function heartbeatLocalTerminal(deviceId) {
  if (!deviceId || isMock || !supabase) return;
  const { error } = await supabase.rpc('terminal_heartbeat', {
    p_device_id: deviceId,
    p_app_version: localTerminalAppVersion(),
  });
  if (error) console.warn('[localTerminal] heartbeat failed:', error.message);
}

/**
 * Resolve "can THIS device take a card payment on its own reader right now?".
 *
 * Returns one of:
 *   { ok: true,  terminal: { id, label, locationId, adyenTerminalId } }
 *   { ok: false, reason, claimCode?, status? }        — a human-readable blocker
 *   { ok: false, applicable: false }                  — no bridge; not our business
 *
 * NEVER THROWS. A resolution failure must fall through to the existing card tiers,
 * exactly like findPaxTerminal, rather than taking the card button down.
 *
 * The gates, in order, and why each one exists:
 *   1. bridge present            — otherwise this is a phone, not an Adyen terminal.
 *   2. registered + PAIRED       — an unpaired row is a claim code on a screen, not
 *                                  a reader. We surface the code instead.
 *   3. location matches          — the terminal is paired to the venue a MANAGER
 *                                  chose. If this app is signed in to a different
 *                                  venue, refuse: a job created here would carry the
 *                                  terminal's location and book somebody else's sale.
 *   4. adyen_terminal_id present — the POIID Back Office links after Adyen boards the
 *                                  terminal. Without it prepare_local has nothing to
 *                                  address and the server returns 'terminal_not_linked'.
 */
export async function resolveSelfHostedAdyenTerminal() {
  if (!BRIDGE()) return { ok: false, applicable: false };
  if (isMock || !supabase) {
    return { ok: false, reason: 'This build has no Supabase connection, so it cannot take a real card payment.' };
  }
  try {
    const serial = localTerminalSerial();
    if (!serial) {
      return { ok: false, reason: 'This terminal did not report a serial number, so it cannot be paired. Update the MPOS app.' };
    }

    const reg = await registerLocalTerminal();
    if (!reg) {
      return { ok: false, reason: 'Could not reach the server to check this terminal. Check the network and try again.' };
    }
    if (reg.status !== 'paired' || !reg.deviceId) {
      return {
        ok: false,
        status: reg.status,
        claimCode: reg.claimCode,
        reason: 'This card terminal is not paired to a venue yet.',
      };
    }

    // The pairing row itself — RLS td_select lets a device read the row it owns
    // (device_uid = auth.uid()), so no widening of a payments table is needed.
    const { data: row, error } = await supabase
      .from('terminal_devices')
      .select('id, label, location_id, status, active, adyen_terminal_id')
      .eq('id', reg.deviceId)
      .maybeSingle();
    if (error) {
      console.warn('[localTerminal] could not read own pairing row:', error.message);
      return { ok: false, reason: 'Could not read this terminal\'s pairing record.' };
    }
    if (!row || row.status !== 'paired' || row.active !== true) {
      return { ok: false, reason: 'This card terminal has been retired or switched off in Back Office.' };
    }

    const activeLocation = getActiveLocationSync();
    if (!activeLocation || activeLocation === 'loc-demo') {
      return { ok: false, reason: 'No venue is resolved on this device yet.' };
    }
    if (row.location_id && row.location_id !== activeLocation) {
      return {
        ok: false,
        reason: 'This card terminal is paired to a different venue from the one this app is signed in to. '
              + 'Re-pair it in Back Office → Card readers.',
      };
    }
    if (!row.adyen_terminal_id) {
      return {
        ok: false,
        reason: 'This terminal is paired but not linked to an Adyen terminal ID yet. '
              + 'Add its POIID in Back Office → Card readers.',
      };
    }

    // Advisory only — the row is live and the operator is standing in front of it.
    heartbeatLocalTerminal(row.id);

    return {
      ok: true,
      terminal: {
        id: row.id,
        label: row.label || 'This terminal',
        locationId: row.location_id,
        adyenTerminalId: row.adyen_terminal_id,
      },
    };
  } catch (e) {
    console.warn('[localTerminal] resolve failed:', e?.message || e);
    return { ok: false, reason: 'Could not check this terminal\'s card reader.' };
  }
}
