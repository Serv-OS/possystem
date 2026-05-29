// supabase/functions/_shared/gift-card-utils.ts
//
// Shared utilities for gift card edge functions:
//   - 16-char code generation (alphabet excludes I, 1, O, 0)
//   - HMAC-SHA256 lookup index for fast code retrieval
//   - Argon2id hashing for code and PIN storage
//   - HMAC secret generation for new orgs

import { argon2id, argon2Verify } from 'https://esm.sh/hash-wasm@4.11.0';

// ── Code alphabet ───────────────────────────────────────────────────────────
// 32 chars: A-Z minus I,O plus 2-9 (no 1,0). Unambiguous on receipts/screens.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 16;

// ── Generate a random gift card code ────────────────────────────────────────
// Returns a 16-char string like "ABCD EFGH JKLM NPQR" (no spaces in storage).
export function generateCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return code;
}

// Format code with spaces for display: "ABCD EFGH JKLM NPQR"
export function formatCode(code: string): string {
  const clean = code.replace(/\s/g, '').toUpperCase();
  return clean.match(/.{1,4}/g)?.join(' ') ?? clean;
}

// Normalize input code: strip spaces, uppercase
export function normalizeCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

// Last 4 characters for support display
export function codeLast4(code: string): string {
  return code.slice(-4);
}

// ── HMAC-SHA256 lookup index ────────────────────────────────────────────────
// Fast indexed retrieval without exposing the code. Uses per-org secret.
export async function hmacLookup(code: string, hmacSecret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(hmacSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(code));
  // Return as hex string
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Argon2id hashing ────────────────────────────────────────────────────────
// Used for code_hash (verify code on redemption) and pin_hash.
// Params: memory 16 MB, iterations 3, parallelism 1, output 32 bytes.
// Conservative memory to stay within Deno Deploy limits.
export async function hashValue(value: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return await argon2id({
    password: value,
    salt,
    parallelism: 1,
    iterations: 3,
    memorySize: 16384, // 16 MB
    hashLength: 32,
    outputType: 'encoded', // returns $argon2id$... string
  });
}

// Verify a value against an argon2id hash
export async function verifyHash(value: string, hash: string): Promise<boolean> {
  return await argon2Verify({ password: value, hash });
}

// ── HMAC secret generation ──────────────────────────────────────────────────
// Generate a random 256-bit hex string for per-org HMAC secret.
export function generateHmacSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Shared Supabase + CORS helpers ──────────────────────────────────────────
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

export const opsAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Auth helper: extract and validate caller from Authorization header.
// Returns the user object or a Response (error).
export async function authenticateCaller(
  req: Request,
): Promise<{ user: any } | Response> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const {
    data: { user },
  } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!user) return json({ error: 'Invalid token' }, 401);
  return { user };
}

// Resolve the caller's company_id from user_company_roles in Platform DB.
// Returns company_id or a Response (error).
// NOTE: This function has a known limitation — it uses the Ops DB user UUID
// to query Platform DB user_company_roles, which may not match when the two
// projects have different user tables. Prefer resolveCompanyForLocation()
// when a location_id is available.
export async function resolveCompanyId(
  userId: string,
): Promise<string | Response> {
  const { data } = await platformAdmin
    .from('user_company_roles')
    .select('company_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();
  if (!data?.company_id) {
    return json({ error: 'No company linked to this user' }, 403);
  }
  return data.company_id;
}

// ── Location-based company resolution ──────────────────────────────────
// v5.5.207: Reliable company resolution via location_id.
// Priority: location_id → user_company_roles fallback.
//
// This solves the cross-DB UUID mismatch where Ops DB user UUIDs don't
// match Platform DB user_company_roles entries. When a back-office user
// is viewing a specific location, the location_id is the most reliable
// way to determine which company's data to access.
export async function resolveCompanyForLocation(
  userId: string,
  locationId?: string | null,
): Promise<string | Response> {
  // 1. Try location_id first (most reliable — no cross-DB UUID issues)
  if (locationId) {
    // Try as ops_location_id (back office and POS send the Ops DB location ID)
    const { data: locByOps } = await platformAdmin
      .from('locations')
      .select('company_id')
      .eq('ops_location_id', locationId)
      .maybeSingle();
    if (locByOps?.company_id) return locByOps.company_id;

    // Try as platform location ID
    const { data: locById } = await platformAdmin
      .from('locations')
      .select('company_id')
      .eq('id', locationId)
      .maybeSingle();
    if (locById?.company_id) return locById.company_id;

    // v5.5.320: a location_id WAS provided but no platform row matched. FAIL
    // CLOSED — do NOT fall through to the user_company_roles fallback below.
    // That fallback returns the FIRST user_company_roles row, which for a
    // multi-company user (owner/super_admin) is an ARBITRARY company → it could
    // read/write another tenant's gift cards & loyalty. Every real location is
    // mirrored to the Platform DB by provision-location; an unmatched location
    // is a provisioning gap and must error loudly, never silently mis-resolve.
    return json({
      error: 'Location not provisioned in the platform database. Re-provision it (Company Admin → the location).',
      code: 'location_not_provisioned',
    }, 409);
  }

  // 2. No location_id supplied — fall back to user_company_roles. This path is
  // for callers that genuinely have no location context (single-company users).
  const result = await resolveCompanyId(userId);
  if (typeof result === 'string') return result;

  return json({ error: 'Could not resolve company. Ensure location is linked.' }, 403);
}
