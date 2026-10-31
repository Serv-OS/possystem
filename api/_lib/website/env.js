// api/_lib/website/env.js
//
// Where api/site.js finds its keys. The Ops names are the ones every api/ route reads today
// (api/_userAuth.js supabaseEnv): SUPABASE_URL or VITE_SUPABASE_URL, SUPABASE_ANON_KEY or
// VITE_SUPABASE_ANON_KEY. The Platform names are the release pack's (ARCHITECTURE.md section 14).
// This file holds no secret and reads nothing but process.env.

export function platformEnv(env = (globalThis.process && globalThis.process.env) || {}) {
  return {
    url: String(env.PLATFORM_SUPABASE_URL || env.VITE_PLATFORM_SUPABASE_URL || '').replace(/\/$/, ''),
    anon: String(env.PLATFORM_SUPABASE_ANON_KEY || env.VITE_PLATFORM_SUPABASE_ANON_KEY || ''),
    service: String(env.PLATFORM_SUPABASE_SERVICE_ROLE_KEY || ''),
  };
}

export function opsEnv(env = (globalThis.process && globalThis.process.env) || {}) {
  return {
    url: String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    anon: String(env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || ''),
  };
}

/** The tier's customer root (lib/env.js CUSTOMER_ROOT, same two variables), for servos: links. */
export function customerRoot(env = (globalThis.process && globalThis.process.env) || {}) {
  const tier = String(env.VITE_APP_TIER || 'prod');
  const domain = String(env.VITE_CUSTOMER_DOMAIN || 'serv-os.app');
  return tier === 'prod' ? domain : `${tier}.${domain}`;
}

export function previewSecret(env = (globalThis.process && globalThis.process.env) || {}) {
  return String(env.WEBSITE_PREVIEW_SECRET || '');
}
