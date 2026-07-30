// src/lib/saveHealth.js — v5.5.951
//
// WHY THIS EXISTS: menu writers reported failures with console.error and nothing
// else, while the UI had already applied the change optimistically. A category
// ("Premium Sauces") and its item looked saved for an entire editing session and
// simply didn't exist after refresh — the write had been failing silently the
// whole time. Live case 30 Jul 2026.
//
// Every menu-critical writer now reports its outcome here; Back Office renders a
// red, undismissable banner while saves are failing (with a plain-English hint
// when it's an expired session) and clears it on the next successful write.

import { supabase } from './supabase';

let _state = { broken: false, entity: null, message: null, authy: false, at: 0 };
const _subs = new Set();
let _refreshing = false;
const emit = () => _subs.forEach((fn) => { try { fn(_state); } catch { /* subscriber's problem */ } });

export function reportSave(entity, error) {
  if (error) {
    const message = String(error?.message || error);
    // Expired/invalid session is the most common silent killer in a long-lived tab.
    // (Reads stay alive on anon policies, so the app LOOKS signed in while every
    // write 401s — proven live 30 Jul with the vanished Sauces/Beer categories.)
    const authy = /jwt|token|401|unauthor|expired|invalid claim|refresh/i.test(message);
    _state = { broken: true, entity, message, authy, at: Date.now() };
    console.error(`[saveHealth] ${entity} save FAILED:`, message);
    emit();
    // Best-effort self-heal: kick a session refresh so the NEXT save can succeed
    // (which also clears the banner). The failed change still needs redoing —
    // the banner says so.
    if (authy && !_refreshing && supabase?.auth?.refreshSession) {
      _refreshing = true;
      supabase.auth.refreshSession().catch(() => {}).finally(() => { _refreshing = false; });
    }
  } else if (_state.broken) {
    _state = { broken: false, entity: null, message: null, authy: false, at: Date.now() };
    emit();
  }
}

export function subscribeSaveHealth(fn) {
  _subs.add(fn);
  fn(_state);
  return () => _subs.delete(fn);
}

// Diagnostics hook — lets support trigger/clear the banner from the console
// (window.__rposSaveHealth.reportSave('test', new Error('JWT expired'))).
if (typeof window !== 'undefined') window.__rposSaveHealth = { reportSave };
