// src/lib/authStorageKey.js
//
// ONE BROWSER, TWO KINDS OF SIGN IN.
//
// Every ServOS surface has been sharing a single stored session, 'rpos-auth'.
// A till, a kiosk, a KDS and the Back Office open in the same browser all read
// and write that one key, so whoever signs in or out LAST owns the browser.
// The scar is already in CLAUDE.md (6 Aug 2026: the staff app signed the Back
// Office out and every write started failing RLS), and it has been quietly
// costing us ever since.
//
// WHAT IT LOOKS LIKE IN THE FIELD (21 Sep 2026, Peter's own device log):
//
//   TEst 1   reclaimed        33 times in six hours, a new uid every time
//   POS 1    refused_secret    7 times, "wrong or missing device secret"
//
// Each of those is a till noticing its identity has changed underneath it and
// re-claiming its row with its device secret. A till WITHOUT a secret cannot
// do that, and simply falls off: the Provo kiosk sat at awaiting_pairing.
// Peter is about to walk into twenty venues with a laptop in one hand and a
// till on the counter, so this had to stop being a nuisance before Thursday.
//
// THE FIX IS THE KEY ITSELF. A surface where a PERSON signs in (Back Office,
// the admin portal, the owner app, the staff app) keeps its session under its
// own name, so signing in or out there cannot touch a device. Tills, kiosks,
// KDS screens, menu boards and customer pages are unchanged: they keep the
// shared key and the identity they already hold.
//
// Nothing about permissions changes. The token is the same token, RLS is the
// same RLS; only the cupboard it is kept in is different.

import { DEFAULT_STORAGE_KEY } from './authSession.js';

/** Where a person's sign in is kept, away from every device on the same browser. */
export const PERSON_STORAGE_KEY = 'rpos-bo-auth';

/** The surfaces a PERSON signs in on. Everything else is a device or a customer. */
export const PERSON_MODES = Object.freeze(['office', 'backoffice', 'admin', 'owner', 'staff']);

/** Which stored session this surface uses. */
export function storageKeyFor(mode) {
  return PERSON_MODES.includes(String(mode || '')) ? PERSON_STORAGE_KEY : DEFAULT_STORAGE_KEY;
}

/**
 * Move an existing Back Office sign in across to its own key, ONCE, so nobody
 * is signed out by this change.
 *
 * Only ever copies a REAL person's session: an anonymous one belongs to a till
 * or a customer page and must never be adopted as somebody's login (that is the
 * "blank back office" bug, v5.5.307). Never overwrites a session already there.
 *
 * @returns {'adopted'|'already'|'none'|'anonymous'|'unreadable'}
 */
export function adoptSharedSession(storage, key = PERSON_STORAGE_KEY, sharedKey = DEFAULT_STORAGE_KEY) {
  if (!storage || key === sharedKey) return 'none';
  try {
    if (storage.getItem(key)) return 'already';
    const raw = storage.getItem(sharedKey);
    if (!raw) return 'none';
    const parsed = JSON.parse(raw);
    const user = parsed?.user || parsed?.currentSession?.user || null;
    if (!user || user.is_anonymous === true) return 'anonymous';
    if (!parsed?.refresh_token && !parsed?.currentSession?.refresh_token) return 'anonymous';
    storage.setItem(key, raw);
    return 'adopted';
  } catch {
    return 'unreadable';
  }
}
