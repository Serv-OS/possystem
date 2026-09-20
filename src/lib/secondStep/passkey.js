// src/lib/secondStep/passkey.js
//
// PASSKEY SIGN IN (docs/SECOND_STEP.md). The Toast flow Peter asked for on 20 Sep 2026: a
// fingerprint on a laptop, a face on a phone, Windows Hello on Windows. No codes, no apps.
//
// WHY THIS FILE EXISTS INSTEAD OF supabase.auth.signInWithPasskey. Supabase shipped passkeys in
// @supabase/auth-js 2.116 (client option auth.experimental.passkey, then signInWithPasskey,
// registerPasskey, passkey.list/update/delete). We are on 2.103, which has no passkey code at
// all: it only has the MFA WebAuthn API, and Supabase REFUSED to enable MFA WebAuthn on this
// project ("Enabling of MFA with WebAuthn not currently supported"). Upgrading the client that
// every surface shares, days before the first venue goes live, is not a thing to do at speed.
// So this file speaks to the SAME endpoints 2.116 speaks to, with plain fetch:
//
//   POST /auth/v1/passkeys/registration/options     (signed in)  -> { challenge_id, options }
//   POST /auth/v1/passkeys/registration/verify      (signed in)  <- { challenge_id, credential }
//   POST /auth/v1/passkeys/authentication/options   (no session) -> { challenge_id, options }
//   POST /auth/v1/passkeys/authentication/verify    (no session) -> { session, user }
//   GET/PATCH/DELETE /auth/v1/passkeys[/:id]        (signed in)
//
// When the app is next upgraded to supabase-js 2.116 or later, every call here can be swapped
// for the built in method: the request and answer shapes are the same ones.
//
// THE BROWSER PART is the WebAuthn ceremony itself: navigator.credentials.create() to register
// and .get() to sign in. Level 3 browsers do the JSON conversion for us
// (PublicKeyCredential.parseCreationOptionsFromJSON and credential.toJSON()); everything else
// gets the small base64url conversion below.
//
// PURE ENOUGH TO TEST: every outside thing (fetch, navigator.credentials, the Supabase client)
// is injected, so node:test drives all of it with fakes.

/** base64url to Uint8Array (no padding, - and _ instead of + and /). */
export function fromBase64Url(value) {
  const s = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Uint8Array or ArrayBuffer to base64url. */
export function toBase64Url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf || []);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The server's JSON options as navigator.credentials.create() wants them. */
export function creationOptionsFromJson(options, { PublicKeyCredential: PKC } = {}) {
  const K = PKC || (typeof PublicKeyCredential !== 'undefined' ? PublicKeyCredential : null);
  if (K && typeof K.parseCreationOptionsFromJSON === 'function') return K.parseCreationOptionsFromJSON(options);
  const o = { ...options };
  o.challenge = fromBase64Url(options.challenge);
  o.user = { ...options.user, id: fromBase64Url(options.user?.id) };
  if (Array.isArray(options.excludeCredentials)) {
    o.excludeCredentials = options.excludeCredentials.map((c) => ({ ...c, id: fromBase64Url(c.id) }));
  }
  return o;
}

/** The server's JSON options as navigator.credentials.get() wants them. */
export function requestOptionsFromJson(options, { PublicKeyCredential: PKC } = {}) {
  const K = PKC || (typeof PublicKeyCredential !== 'undefined' ? PublicKeyCredential : null);
  if (K && typeof K.parseRequestOptionsFromJSON === 'function') return K.parseRequestOptionsFromJSON(options);
  const o = { ...options };
  o.challenge = fromBase64Url(options.challenge);
  if (Array.isArray(options.allowCredentials)) {
    o.allowCredentials = options.allowCredentials.map((c) => ({ ...c, id: fromBase64Url(c.id) }));
  }
  return o;
}

/** A credential from the browser as JSON for the server (Level 3 toJSON, else by hand). */
export function credentialToJson(credential) {
  if (!credential) return null;
  if (typeof credential.toJSON === 'function') return credential.toJSON();
  const r = credential.response || {};
  const out = {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type || 'public-key',
    clientExtensionResults: typeof credential.getClientExtensionResults === 'function' ? credential.getClientExtensionResults() : {},
    response: { clientDataJSON: toBase64Url(r.clientDataJSON) },
  };
  if (r.attestationObject) {
    out.response.attestationObject = toBase64Url(r.attestationObject);
    if (typeof r.getTransports === 'function') out.response.transports = r.getTransports();
  } else {
    out.response.authenticatorData = toBase64Url(r.authenticatorData);
    out.response.signature = toBase64Url(r.signature);
    if (r.userHandle) out.response.userHandle = toBase64Url(r.userHandle);
  }
  if (credential.authenticatorAttachment) out.authenticatorAttachment = credential.authenticatorAttachment;
  return out;
}

/** Does this browser and device have a passkey maker (Touch ID, Face ID, Windows Hello)? */
export async function passkeySupport({ PublicKeyCredential: PKC, navigatorRef } = {}) {
  const nav = navigatorRef || (typeof navigator !== 'undefined' ? navigator : null);
  const K = PKC || (typeof PublicKeyCredential !== 'undefined' ? PublicKeyCredential : null);
  if (!nav?.credentials || !K) return { usable: false, reason: 'browser' };
  try {
    const available = typeof K.isUserVerifyingPlatformAuthenticatorAvailable === 'function'
      ? await K.isUserVerifyingPlatformAuthenticatorAvailable()
      : false;
    if (!available) return { usable: false, reason: 'device' };
  } catch { return { usable: false, reason: 'device' }; }
  return { usable: true, reason: 'ok' };
}

const trimEnd = (s) => String(s || '').replace(/\/+$/, '');

/**
 * The passkey client. Everything it needs is injected:
 *   url, anonKey   the Supabase project
 *   getToken()     the current access token, or null (registration and the list need one)
 *   setSession()   hand a new session to supabase-js after a passkey sign in
 *   fetchImpl, credentials  swapped for fakes in node:test
 */
export function createPasskeyClient({
  url, anonKey, getToken, setSession, fetchImpl, credentials, PublicKeyCredential: PKC,
} = {}) {
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const creds = credentials || (typeof navigator !== 'undefined' ? navigator.credentials : null);
  const base = `${trimEnd(url)}/auth/v1`;

  async function call(method, path, { body, token } = {}) {
    if (!doFetch) throw new Error('No fetch');
    const headers = { apikey: anonKey, 'Content-Type': 'application/json' };
    headers.Authorization = `Bearer ${token || anonKey}`;
    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const err = new Error(data?.msg || data?.error_description || data?.message || `Passkey request failed (${res.status})`);
      err.status = res.status;
      err.code = data?.error_code || data?.code || '';
      throw err;
    }
    return data;
  }

  /** Register a passkey for the signed in person. Returns { credentialId, friendlyName }. */
  async function register({ friendlyName } = {}) {
    const token = await getToken?.();
    if (!token) throw new Error('Sign in first.');
    const started = await call('POST', '/passkeys/registration/options', { body: {}, token });
    const publicKey = creationOptionsFromJson(started.options || started.credential_options || {}, { PublicKeyCredential: PKC });
    const credential = await creds.create({ publicKey });
    if (!credential) throw new Error('That was cancelled.');
    const json = credentialToJson(credential);
    const verified = await call('POST', '/passkeys/registration/verify', {
      token,
      body: { challenge_id: started.challenge_id, credential: json, friendly_name: friendlyName || undefined },
    });
    return {
      credentialId: String(verified?.id || json.id || ''),
      friendlyName: verified?.friendly_name || friendlyName || '',
      raw: verified,
    };
  }

  /**
   * Sign in with a passkey. No session is needed to start: the browser offers the passkeys it
   * holds for this site. Hands the new session to supabase-js, so the whole app is signed in.
   */
  async function signIn() {
    const started = await call('POST', '/passkeys/authentication/options', {
      body: { gotrue_meta_security: {} },
    });
    const publicKey = requestOptionsFromJson(started.options || started.credential_options || {}, { PublicKeyCredential: PKC });
    const credential = await creds.get({ publicKey });
    if (!credential) throw new Error('That was cancelled.');
    const out = await call('POST', '/passkeys/authentication/verify', {
      body: { challenge_id: started.challenge_id, credential: credentialToJson(credential) },
    });
    const session = out?.session || (out?.access_token ? out : null);
    if (!session?.access_token) throw new Error('That passkey did not sign you in. Use your password.');
    if (setSession) {
      await setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
    }
    return { session, user: out?.user || session.user || null };
  }

  /** The passkeys this login holds. */
  async function list() {
    const token = await getToken?.();
    if (!token) return [];
    const data = await call('GET', '/passkeys', { token });
    const rows = Array.isArray(data) ? data : (data?.passkeys || data?.data || []);
    return rows.map((r) => ({
      id: String(r.id ?? r.credential_id ?? ''),
      friendlyName: r.friendly_name ?? r.friendlyName ?? '',
      createdAt: r.created_at ?? r.createdAt ?? null,
      lastUsedAt: r.last_used_at ?? r.lastUsedAt ?? null,
    })).filter((r) => r.id);
  }

  /** Rename one. */
  async function rename(id, friendlyName) {
    const token = await getToken?.();
    return call('PATCH', `/passkeys/${encodeURIComponent(id)}`, { token, body: { friendly_name: friendlyName } });
  }

  /** Remove one. The caller decides whether it is allowed (passkeyRules.canRemove). */
  async function remove(id) {
    const token = await getToken?.();
    return call('DELETE', `/passkeys/${encodeURIComponent(id)}`, { token });
  }

  return { register, signIn, list, rename, remove };
}
