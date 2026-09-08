/**
 * Receipt Branding — per-location header logo, business details, footer, QR.
 *
 * Lives on `locations.receipt_branding jsonb`. Fetched on demand with a 60s
 * in-memory cache so we don't round-trip Supabase on every print. Shape:
 *
 *   {
 *     paper_width_mm: 80,                // or 58 for compact printers
 *     header: {
 *       logo_storage_path: "locations/<id>/header.png" | null,
 *       logo_url:          "https://..." | null,        // resolved URL (public or signed)
 *       logo_width_dots:   384,                          // 80mm = 576 dots @ 203dpi; 384 = conservative default
 *       business_name:     "Peter's Pub" | null,
 *       address_lines:     ["12 High St", "Foster City, CA"] | [],
 *       phone:             "+1 650 555 0100" | null,
 *       tax_id:            "VAT GB123456789" | null,
 *       show_order_number: true,
 *       show_server_name:  true,
 *       show_covers:       true
 *     },
 *     footer: {
 *       message:           "Thank you for dining with us!" | null,
 *       qr: {
 *         enabled:         true,
 *         mode:            "url" | "upload",             // 'url' = generate at print, 'upload' = pre-rendered image
 *         url_value:       "https://pos-up.com/r/peters-pub" | null,
 *         storage_path:    "locations/<id>/qr.png" | null,
 *         image_url:       "https://..." | null,         // resolved URL when mode='upload'
 *         size_dots:       160,
 *         caption:         "Scan to leave a review" | null
 *       } | null
 *     }
 *   }
 *
 * All fields are optional. A missing receipt_branding falls back to the plain
 * text-only receipt shape that's been in production since v4.0 (reads
 * location.name, location.address, location.receiptFooter).
 */

import { supabase } from './supabase';

const TTL_MS = 60_000; // 60s cache
const _cache = new Map(); // locationId -> { ts, branding }

export async function loadLocationBranding(locationId) {
  if (!locationId) return null;
  const cached = _cache.get(locationId);
  if (cached && (Date.now() - cached.ts) < TTL_MS) return cached.branding;

  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('locations')
      .select('receipt_branding')
      .eq('id', locationId)
      .single();
    if (error) {
      console.warn('[receiptBranding] load failed:', error.message);
      return null;
    }
    const branding = data?.receipt_branding || null;
    _cache.set(locationId, { ts: Date.now(), branding });
    return branding;
  } catch (e) {
    console.warn('[receiptBranding] load threw:', e.message);
    return null;
  }
}

export function invalidateBrandingCache(locationId) {
  if (locationId) _cache.delete(locationId);
  else _cache.clear();
}

/**
 * Merge a branding object onto the `location` object used by buildCustomerReceipt.
 * Kept in one place so the POS, CheckHistory reprint, and Back Office preview
 * all render the same thing.
 */
export function mergeBrandingIntoLocation(location, branding) {
  if (!branding) return location || {};
  return {
    ...(location || {}),
    receipt_branding: branding,
    // Expose header/footer/paper_width at the top level so buildCustomerReceipt
    // can read location.header.logo_url, location.header.phone, location.footer.message,
    // etc., without having to traverse location.receipt_branding.
    header: branding.header || {},
    footer: branding.footer || {},
    paper_width_mm: branding.paper_width_mm || location?.paper_width_mm,
    // Keep the legacy flat fields populated too for any consumer still reading
    // location.name / location.address / location.receiptFooter directly.
    name: branding.header?.business_name || location?.name,
    address: (branding.header?.address_lines || []).filter(Boolean).join('\n') || location?.address,
    receiptFooter: branding.footer?.message || location?.receiptFooter,
  };
}
