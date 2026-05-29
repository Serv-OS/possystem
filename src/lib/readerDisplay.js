// src/lib/readerDisplay.js
//
// v5.5.171 — live cart push to the connected Stripe reader.
//
// Called from POS surfaces whenever the cart changes. Debounced ~600ms so a
// burst of "+1 / +1 / +1" doesn't hammer the edge fn. Idempotent — every
// call sends the FULL current cart; the edge fn just renders the latest
// state on the reader screen via setReaderDisplay.
//
// Skips the call silently when:
//   • not paired (no rpos-device JSON in localStorage)
//   • not authenticated (no Supabase session)
//   • offline / Stripe unreachable (edge fn returns 4xx — we log + move on)
//
// Reader-side, the edge fn ALSO checks `reader.action.status === 'in_progress'`
// before pushing — so an in-flight payment isn't yanked back to the cart.
//
// Usage:
//   import { pushReaderDisplay } from '../lib/readerDisplay';
//   useEffect(() => { pushReaderDisplay({ lineItems, totalMinor }); }, [cart]);

import { supabase, isMock, ensureAuthToken } from './supabase';
import { money } from './/currency';

// ── Per-reader customer display toggle ──────────────────────────────────────
// Cached in localStorage so every pushReaderDisplay call is a sync read (no DB).
// Back office writes the flag to payment_devices; POS caches it on boot via
// getAssignedNetworkReader().customer_display_enabled.
const DISPLAY_ENABLED_KEY = 'rpos-reader-display-enabled';

/** Call once at POS boot with the reader's customer_display_enabled value. */
export function cacheReaderDisplaySetting(enabled) {
  try {
    localStorage.setItem(DISPLAY_ENABLED_KEY, enabled === false ? '0' : '1');
  } catch {}
}

function isCustomerDisplayEnabled() {
  try {
    const v = localStorage.getItem(DISPLAY_ENABLED_KEY);
    return v !== '0'; // default true if missing
  } catch { return true; }
}

let _timer = null;
let _inflight = null;
let _lastSentKey = null;

function getOpsDeviceId() {
  try {
    const raw = localStorage.getItem('rpos-device');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.id || null;
  } catch { return null; }
}

/**
 * Debounced push of the current cart to the assigned reader.
 *
 * @param {{ lineItems: Array<{description:string, amount:number, quantity:number}>,
 *           totalMinor: number,
 *           currency?: string,
 *           debounceMs?: number }} args
 */
export function pushReaderDisplay({ lineItems = [], totalMinor = 0, currency = 'gbp', debounceMs = 600 } = {}) {
  if (isMock) return; // No network reader in mock mode
  if (!isCustomerDisplayEnabled()) return; // v5.5.188: per-reader toggle

  // Build a stable key so identical successive cart states don't re-fire
  const key = JSON.stringify({
    n: lineItems.length,
    t: Math.round(totalMinor),
    first: lineItems[0]?.description?.slice(0, 20) || '',
  });
  if (key === _lastSentKey && _timer == null) {
    // Same as last sent state and no pending update — nothing to do
    return;
  }

  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(async () => {
    _timer = null;
    const opsDeviceId = getOpsDeviceId();
    if (!opsDeviceId) return;
    if (!supabase) return;

    try {
      let token;
      try { token = await ensureAuthToken(); } catch { return; }
      if (!token) return;

      // Cancel any in-flight push — last-wins
      if (_inflight) try { _inflight.abort(); } catch {}
      const ac = new AbortController();
      _inflight = ac;

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-update-reader-display`,
        {
          method: 'POST',
          signal: ac.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({
            pos_device_id: opsDeviceId,
            line_items: lineItems,
            total_minor: Math.round(totalMinor),
            currency,
          }),
        }
      );
      if (res.ok) {
        _lastSentKey = key;
        try {
          const j = await res.json();
          console.log('[readerDisplay] push ok', j?.skipped || j?.cleared || `${j?.items || 0} items, ${money(((j?.total || 0) / 100))}`);
        } catch {}
      } else {
        const txt = await res.text().catch(() => '');
        console.warn('[readerDisplay] push failed', res.status, txt.slice(0, 200));
      }
    } catch (e) {
      if (e?.name === 'AbortError') return;
      console.warn('[readerDisplay] push threw:', e?.message);
    } finally {
      _inflight = null;
    }
  }, Math.max(50, debounceMs));
}

/** Immediately clear the reader to the idle "Welcome" state. */
export function clearReaderDisplay() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _lastSentKey = null;
  pushReaderDisplay({ lineItems: [], totalMinor: 0, debounceMs: 50 });
}
