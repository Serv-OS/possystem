/* global Buffer */
// api/_lib/website/preview.js
//
// Draft preview tokens (ARCHITECTURE.md sections 3 and 10). website-admin issues them with
// WEBSITE_PREVIEW_SECRET; api/site.js verifies them here before it reads a draft through the
// service role. Same scheme as agent A: HMAC SHA-256 hex over `<site_id>.<expiry_ms>`, token
// `<site_id>.<expiry_ms>.<hex>`. Node only (node:crypto). Pure apart from the clock.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const PREVIEW_TTL_MS = 30 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function signPreviewToken(siteId, expiryMs, secret) {
  const hex = createHmac('sha256', String(secret)).update(`${siteId}.${expiryMs}`).digest('hex');
  return `${siteId}.${expiryMs}.${hex}`;
}

/** { ok:true, siteId } or { ok:false, reason }. Never throws. */
export function verifyPreviewToken(token, secret, now = Date.now()) {
  try {
    if (!secret) return { ok: false, reason: 'no secret' };
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return { ok: false, reason: 'bad shape' };
    const [siteId, expiryStr, hex] = parts;
    if (!UUID_RE.test(siteId)) return { ok: false, reason: 'bad site id' };
    const expiry = Number(expiryStr);
    if (!Number.isFinite(expiry) || expiry < now) return { ok: false, reason: 'expired' };
    const want = createHmac('sha256', String(secret)).update(`${siteId}.${expiry}`).digest('hex');
    const a = Buffer.from(String(hex), 'utf8'), b = Buffer.from(want, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad signature' };
    return { ok: true, siteId };
  } catch {
    return { ok: false, reason: 'error' };
  }
}
