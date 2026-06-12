// v5.5.155 — QR open-tab localStorage cache.
//
// When a customer opens an open-tab on a QR scan, we stash a small marker in
// their browser's localStorage so the NEXT scan from the same device on the
// same QR surface (same slug + table) silently picks up where they left off:
// the OnlineSurface QR mount checks this storage, validates against the DB,
// and renders a resume screen instead of an empty menu.
//
// This is the SILENT identification layer. The tracker URL (with phone-last-4
// gate) is the explicit-share recovery. Phone-number lookup is the last-
// resort fallback. SMS OTP closes the fraud gap properly when Twilio lands.
//
// Storage shape:
//   localStorage['rpos:qr-tab'] = {
//     [slug]: {
//       [tableId]: {
//         tab_ref:           'QR-ABC12',
//         payment_intent_id: 'pi_... | ps_...',   // universal pooling key
//         processor:         'stripe' | 'ryft',
//         // Stripe-only:
//         stripe_account:    'acct_...',
//         // Ryft-only (the session + card stored at tab open, for close/overage):
//         payment_session_id:    'ps_...',
//         ryft_customer_id:      'cus_...',
//         ryft_payment_method_id:'pmt_...',
//         phone_last4:       '1234',
//         opened_at:         '2026-05-09T12:00:00.000Z',
//         table_label:       '4.1',
//         pre_auth_amount:   100,
//       }
//     }
//   }

const KEY = 'rpos:qr-tab';

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); }
  catch { return {}; }
}

function writeAll(blob) {
  try { localStorage.setItem(KEY, JSON.stringify(blob)); } catch {}
}

export function getStashedTab(slug, tableId) {
  if (!slug || !tableId) return null;
  const all = readAll();
  return all[slug]?.[tableId] || null;
}

export function stashTab(slug, tableId, tab) {
  if (!slug || !tableId || !tab) return;
  const all = readAll();
  all[slug] = all[slug] || {};
  all[slug][tableId] = { ...tab, opened_at: tab.opened_at || new Date().toISOString() };
  writeAll(all);
}

export function clearStashedTab(slug, tableId) {
  if (!slug) return;
  const all = readAll();
  if (all[slug]) {
    if (tableId) delete all[slug][tableId];
    else delete all[slug];
    writeAll(all);
  }
}
