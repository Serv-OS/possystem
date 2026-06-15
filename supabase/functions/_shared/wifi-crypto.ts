// supabase/functions/_shared/wifi-crypto.ts
//
// Symmetric encryption for per-venue UniFi secrets (api key / local-admin creds) stored in
// wifi_unifi_bindings.*_enc. The table already has NO read policy (service-role only), so this is
// defence-in-depth: even with DB access the secrets aren't readable without the function env key.
//
// Key material: WIFI_SECRET if set, else the service-role key (already a high-entropy secret present
// in every edge-fn env and never exposed to clients). AES-GCM, output = base64(iv[12] || ciphertext).
// Rotate to a dedicated WIFI_SECRET later without code change — just re-save the bindings.

const enc = new TextEncoder();
const dec = new TextDecoder();

let _key: Promise<CryptoKey> | null = null;
function key(): Promise<CryptoKey> {
  if (_key) return _key;
  const material = Deno.env.get('WIFI_SECRET') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  _key = crypto.subtle.digest('SHA-256', enc.encode('wifi:' + material))
    .then((raw) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));
  return _key;
}

const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function encryptSecret(plain: string): Promise<string> {
  if (plain == null || plain === '') return '';
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), enc.encode(plain));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return b64(out);
}

export async function decryptSecret(stored: string | null | undefined): Promise<string> {
  if (!stored) return '';
  try {
    const raw = unb64(stored);
    const iv = raw.slice(0, 12);
    const ct = raw.slice(12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await key(), ct);
    return dec.decode(pt);
  } catch (_e) {
    return ''; // wrong key / corrupt — treat as no secret rather than throwing
  }
}
