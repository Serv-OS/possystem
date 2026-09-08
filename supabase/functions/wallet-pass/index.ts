// wallet-pass — Generate Apple Wallet / Google Wallet loyalty card passes.
//
// POST { action: 'check' | 'apple' | 'google', token?, location_id? }
//
// check:  Returns { apple: bool, google: bool } — no auth needed.
// apple:  Returns binary .pkpass (Content-Type: application/vnd.apple.pkpass)
// google: Returns { url: "https://pay.google.com/gp/v/save/..." }
//
// Required secrets (Apple):
//   APPLE_PASS_TYPE_ID          — e.g. pass.app.serv-os.loyalty
//   APPLE_TEAM_ID               — Apple Developer Team ID
//   APPLE_PASS_CERT_P12_BASE64  — Base64-encoded .p12 certificate
//   APPLE_PASS_CERT_PASSWORD    — .p12 password (can be empty string)
//   APPLE_WWDR_CERT_PEM         — Apple WWDR intermediate cert (PEM)
//
// Required secrets (Google):
//   GOOGLE_WALLET_ISSUER_ID             — from Google Pay Console
//   GOOGLE_WALLET_SERVICE_ACCOUNT_JSON  — full service account JSON
//
// Common:
//   OTP_HMAC_SECRET (fallback: SUPABASE_SERVICE_ROLE_KEY)
//   CUSTOMER_DOMAIN (default: serv-os.app)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Lazy-loaded on first Apple request (heavy dependencies)
let forge: any = null;
let fflate: any = null;

// ── Config ───────────────────────────────────────────────────────────
const SUPABASE_URL  = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const PLATFORM_URL  = Deno.env.get('PLATFORM_SUPABASE_URL') ?? '';
const PLATFORM_KEY  = Deno.env.get('PLATFORM_SERVICE_KEY') ?? '';
const CUSTOMER_DOMAIN = Deno.env.get('CUSTOMER_DOMAIN') ?? 'serv-os.app';

const APPLE_PASS_TYPE  = Deno.env.get('APPLE_PASS_TYPE_ID') ?? '';
const APPLE_TEAM       = Deno.env.get('APPLE_TEAM_ID') ?? '';
const APPLE_P12_B64    = Deno.env.get('APPLE_PASS_CERT_P12_BASE64') ?? '';
const APPLE_P12_PASS   = Deno.env.get('APPLE_PASS_CERT_PASSWORD') ?? '';
const APPLE_WWDR       = Deno.env.get('APPLE_WWDR_CERT_PEM') ?? '';

const GOOGLE_ISSUER    = Deno.env.get('GOOGLE_WALLET_ISSUER_ID') ?? '';
const GOOGLE_SA_JSON   = Deno.env.get('GOOGLE_WALLET_SERVICE_ACCOUNT_JSON') ?? '';

const appleReady  = !!(APPLE_PASS_TYPE && APPLE_TEAM && APPLE_P12_B64 && APPLE_WWDR);
const googleReady = !!(GOOGLE_ISSUER && GOOGLE_SA_JSON);

const opsDb = createClient(SUPABASE_URL, SERVICE_ROLE);
const platformDb = PLATFORM_URL && PLATFORM_KEY
  ? createClient(PLATFORM_URL, PLATFORM_KEY) : null;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

// ── HMAC token verification (matches loyalty-otp) ────────────────────
async function verifyToken(token: string) {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const secret = Deno.env.get('OTP_HMAC_SECRET') || SERVICE_ROLE;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encoded));
  const hex = [...new Uint8Array(expected)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex !== sig) return null;

  try {
    const [customerId, companyId, ts] = atob(encoded).split(':');
    if (Date.now() - Number(ts) > 24 * 60 * 60 * 1000) return null;
    return { customerId, companyId };
  } catch { return null; }
}

// ── Fetch customer + loyalty + venue data ─────────────────────────────
async function fetchPassData(customerId: string, companyId: string, locationId: string) {
  const { data: customer } = await opsDb
    .from('customers').select('id, name, email, phone')
    .eq('id', customerId).maybeSingle();
  if (!customer) throw new Error('Customer not found');

  let loyalty: any = null;
  if (platformDb) {
    const { data: m } = await platformDb
      .from('loyalty_members')
      .select('member_code, points_balance, enrolled_at, tier_id')
      .eq('customer_id', customerId).eq('company_id', companyId)
      .maybeSingle();
    if (m) {
      let tier = null;
      if (m.tier_id) {
        const { data: t } = await platformDb
          .from('loyalty_tiers').select('name, color, icon')
          .eq('id', m.tier_id).maybeSingle();
        tier = t;
      }
      loyalty = {
        member_code: m.member_code,
        points_balance: m.points_balance || 0,
        enrolled_at: m.enrolled_at,
        tier,
      };
    }
  }

  const { data: loc } = await opsDb
    .from('locations').select('name, online_slug')
    .eq('id', locationId).maybeSingle();

  return {
    customer,
    loyalty,
    venue: { name: loc?.name || 'Our Venue', slug: loc?.online_slug || '' },
  };
}

// ── CRC32 (for PNG chunk checksums) ──────────────────────────────────
const CRC_TBL = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  CRC_TBL[n] = c >>> 0;
}
function crc32(d: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < d.length; i++) c = CRC_TBL[(c ^ d[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── Minimal solid-color PNG ──────────────────────────────────────────
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const buf = new Uint8Array(12 + data.length);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
  buf.set(data, 8);
  dv.setUint32(8 + data.length, crc32(buf.subarray(4, 8 + data.length)));
  return buf;
}

// Note: fflate must be loaded before calling (lazy-loaded in generateApplePass)
function solidPng(w: number, h: number, r: number, g: number, b: number): Uint8Array {
  if (!fflate) throw new Error('fflate not loaded — call from generateApplePass');
  // Raw scanlines: filter-byte(0) + RGB per pixel, per row
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      const px = off + 1 + x * 3;
      raw[px] = r; raw[px + 1] = g; raw[px + 2] = b;
    }
  }
  const compressed = fflate.zlibSync(raw);

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const idv = new DataView(ihdr.buffer);
  idv.setUint32(0, w); idv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

  const parts = [sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ── SHA-1 hex ────────────────────────────────────────────────────────
async function sha1(data: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-1', data);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ══════════════════════════════════════════════════════════════════════
// APPLE WALLET — .pkpass generation
// ══════════════════════════════════════════════════════════════════════
async function generateApplePass(
  customer: any, loyalty: any, venue: any,
): Promise<Uint8Array> {
  // Lazy-load heavy deps on first call
  if (!forge) forge = (await import('https://esm.sh/node-forge@1.3.1')).default;
  if (!fflate) fflate = await import('https://esm.sh/fflate@0.8.2');

  const memberCode = loyalty?.member_code || '';
  const portalUrl = venue.slug
    ? `https://${venue.slug}.${CUSTOMER_DOMAIN}/account`
    : '';

  // ── pass.json ─────────────────────────────────────────────────────
  const passData: any = {
    formatVersion: 1,
    passTypeIdentifier: APPLE_PASS_TYPE,
    teamIdentifier: APPLE_TEAM,
    serialNumber: `loyalty-${customer.id}`,
    organizationName: venue.name,
    description: `${venue.name} Loyalty Card`,
    logoText: venue.name,
    foregroundColor: 'rgb(255, 255, 255)',
    backgroundColor: 'rgb(14, 14, 16)',
    labelColor: 'rgb(170, 170, 170)',
    storeCard: {
      headerFields: [
        { key: 'points', label: 'POINTS', value: loyalty?.points_balance ?? 0,
          textAlignment: 'PKTextAlignmentRight' },
      ],
      secondaryFields: [
        { key: 'name', label: 'MEMBER', value: customer.name || 'Loyalty Member' },
        ...(loyalty?.tier ? [{ key: 'tier', label: 'TIER', value: loyalty.tier.name }] : []),
      ],
      auxiliaryFields: [
        { key: 'code', label: 'MEMBER CODE', value: memberCode },
      ],
      backFields: [
        { key: 'info', label: 'About this card',
          value: `Your digital loyalty card for ${venue.name}. Earn points on every order and redeem exclusive rewards.` },
        ...(portalUrl
          ? [{ key: 'portal', label: 'View your account',
               value: portalUrl,
               attributedValue: `<a href="${portalUrl}">${portalUrl}</a>` }]
          : []),
      ],
    },
    barcode: {
      format: 'PKBarcodeFormatQR',
      message: `loyalty:${memberCode || customer.id}`,
      messageEncoding: 'iso-8859-1',
    },
    barcodes: [{
      format: 'PKBarcodeFormatQR',
      message: `loyalty:${memberCode || customer.id}`,
      messageEncoding: 'iso-8859-1',
    }],
  };

  // ── Icon PNGs (brand orange #E8743C) ──────────────────────────────
  const icon1x = solidPng(29, 29, 232, 116, 60);
  const icon2x = solidPng(58, 58, 232, 116, 60);
  const icon3x = solidPng(87, 87, 232, 116, 60);

  // ── Collect all pass files ────────────────────────────────────────
  const files: Record<string, Uint8Array> = {
    'pass.json': new TextEncoder().encode(JSON.stringify(passData)),
    'icon.png': icon1x,
    'icon@2x.png': icon2x,
    'icon@3x.png': icon3x,
  };

  // ── manifest.json (SHA-1 of each file) ────────────────────────────
  const manifest: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(files)) {
    manifest[name] = await sha1(bytes);
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  files['manifest.json'] = manifestBytes;

  // ── PKCS#7 signature ──────────────────────────────────────────────
  const p12Der = forge.util.decode64(APPLE_P12_B64);
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, APPLE_P12_PASS);

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const keyBags  = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const signerCert = certBags[forge.pki.oids.certBag]![0].cert!;
  const privateKey = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]![0].key!;
  const wwdrCert   = forge.pki.certificateFromPem(APPLE_WWDR);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(new TextDecoder().decode(manifestBytes));
  p7.addCertificate(signerCert);
  p7.addCertificate(wwdrCert);
  p7.addSigner({
    key: privateKey,
    certificate: signerCert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign({ detached: true });

  const derStr = forge.asn1.toDer(p7.toAsn1()).getBytes();
  const sig = new Uint8Array(derStr.length);
  for (let i = 0; i < derStr.length; i++) sig[i] = derStr.charCodeAt(i);
  files['signature'] = sig;

  // ── ZIP it as .pkpass ─────────────────────────────────────────────
  return fflate.zipSync(files);
}

// ══════════════════════════════════════════════════════════════════════
// GOOGLE WALLET — save-to-wallet URL
// ══════════════════════════════════════════════════════════════════════
function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pemToBuffer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function generateGoogleWalletUrl(
  customer: any, loyalty: any, venue: any, companyId: string,
): Promise<string> {
  const sa = JSON.parse(GOOGLE_SA_JSON);
  const memberCode = loyalty?.member_code || '';
  const portalUrl = venue.slug ? `https://${venue.slug}.${CUSTOMER_DOMAIN}/account` : '';
  const safeCompany = companyId.replace(/-/g, '_');
  const safeCustomer = customer.id.replace(/-/g, '_');

  const payload = {
    iss: sa.client_email,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    origins: ['https://possystem-liard.vercel.app'],
    payload: {
      loyaltyClasses: [{
        id: `${GOOGLE_ISSUER}.company_${safeCompany}`,
        issuerName: venue.name,
        programName: `${venue.name} Loyalty`,
        reviewStatus: 'UNDER_REVIEW',
        hexBackgroundColor: '#0e0e10',
      }],
      loyaltyObjects: [{
        id: `${GOOGLE_ISSUER}.loyalty_${safeCustomer}`,
        classId: `${GOOGLE_ISSUER}.company_${safeCompany}`,
        state: 'ACTIVE',
        accountId: memberCode || customer.id.slice(0, 8),
        accountName: customer.name || 'Loyalty Member',
        loyaltyPoints: {
          label: 'Points',
          balance: { int: loyalty?.points_balance ?? 0 },
        },
        barcode: {
          type: 'QR_CODE',
          value: `loyalty:${memberCode || customer.id}`,
        },
        ...(portalUrl ? {
          linksModuleData: {
            uris: [{ uri: portalUrl, description: 'View your loyalty account' }],
          },
        } : {}),
      }],
    },
  };

  // Sign JWT (RS256)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const input = `${header}.${body}`;

  const key = await crypto.subtle.importKey(
    'pkcs8', pemToBuffer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key,
    new TextEncoder().encode(input),
  );

  return `https://pay.google.com/gp/v/save/${input}.${b64url(new Uint8Array(sig))}`;
}

// ══════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: { action: string; token?: string; location_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, 400); }

  const { action, token, location_id } = body;

  // ── Check availability (no auth) ────────────────────────────────
  if (action === 'check') {
    return json({ apple: appleReady, google: googleReady });
  }

  // ── Validate action ─────────────────────────────────────────────
  if (action !== 'apple' && action !== 'google') {
    return json({ error: 'action must be check, apple, or google' }, 400);
  }
  if (action === 'apple' && !appleReady) {
    return json({ error: 'Apple Wallet not configured' }, 501);
  }
  if (action === 'google' && !googleReady) {
    return json({ error: 'Google Wallet not configured' }, 501);
  }

  // ── Auth ────────────────────────────────────────────────────────
  if (!token) return json({ error: 'token required' }, 401);
  const auth = await verifyToken(token);
  if (!auth) return json({ error: 'invalid or expired token' }, 401);
  if (!location_id) return json({ error: 'location_id required' }, 400);

  // ── Fetch data ──────────────────────────────────────────────────
  let data;
  try {
    data = await fetchPassData(auth.customerId, auth.companyId, location_id);
  } catch (e: any) {
    return json({ error: e.message || 'Failed to load pass data' }, 500);
  }

  // ── Generate ────────────────────────────────────────────────────
  try {
    if (action === 'apple') {
      const pkpass = await generateApplePass(data.customer, data.loyalty, data.venue);
      const safeName = data.venue.name.replace(/[^a-zA-Z0-9 ]/g, '').replace(/ +/g, '_');
      return new Response(pkpass, {
        headers: {
          ...cors,
          'Content-Type': 'application/vnd.apple.pkpass',
          'Content-Disposition': `attachment; filename="${safeName}_Loyalty.pkpass"`,
        },
      });
    }

    if (action === 'google') {
      const url = await generateGoogleWalletUrl(
        data.customer, data.loyalty, data.venue, auth.companyId,
      );
      return json({ url });
    }
  } catch (e: any) {
    console.error('[wallet-pass] generation failed:', e);
    return json({ error: 'Pass generation failed' }, 500);
  }

  return json({ error: 'unknown error' }, 500);
});
