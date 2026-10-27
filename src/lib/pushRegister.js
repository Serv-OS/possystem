// src/lib/pushRegister.js
//
// 5.11.102: turn on app push for this phone and tell team-chat (push.register). Two ways, no Firebase:
//   * inside the iOS app (ServOS Staff, ServOS Manager): the native shell asks iOS for permission and
//     hands back the APNs device token and whether it is a production or an Xcode (sandbox) build:
//       web    window.RposPush.register()
//       native window.__rposPushToken({ token, environment }) or ({ error })
//   * a browser or the home screen app (Android, desktop, iPhone home screen): the service worker
//     (public/sw.js) subscribes with our VAPID public key (Web Push).
// It is only ever started by a tap (browsers refuse a permission prompt nobody asked for).

import { VAPID_PUBLIC_KEY } from './pushConfig';

function keyBytes(b64u) {
  const s = b64u.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** What this phone can do: 'ios' (the native shell), 'web', or 'none'. */
export function pushKind(w = typeof window !== 'undefined' ? window : {}) {
  if (w.RposPush && typeof w.RposPush.register === 'function') return 'ios';
  if (w.navigator?.serviceWorker && 'PushManager' in w && 'Notification' in w) return 'web';
  return 'none';
}

/**
 * 'on' | 'off' | 'blocked' | 'unsupported' for the button. Never only the saved flag (review fix A7):
 * the iOS shell reports iOS's own permission (window.RposPush.permission), a browser its permission
 * and whether a subscription really exists (pass the registration's subscription when known).
 */
export function pushStatus(w = typeof window !== 'undefined' ? window : {}, { subscribed = null } = {}) {
  const kind = pushKind(w);
  if (kind === 'none') return 'unsupported';
  let flag = false;
  try { flag = w.localStorage?.getItem?.('rpos-push-on') === '1'; } catch { flag = false; }
  if (kind === 'ios') {
    const perm = w.RposPush.permission;
    if (perm === 'denied') return 'blocked';
    return perm === 'granted' && flag ? 'on' : 'off';
  }
  if (w.Notification.permission === 'denied') return 'blocked';
  if (w.Notification.permission !== 'granted') return 'off';
  if (subscribed === false) return 'off';
  return flag ? 'on' : 'off';
}

/** Whether this browser really has a push subscription (null when unknown). */
export async function webSubscribed() {
  try {
    if (pushKind() !== 'web') return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return !!(reg && (await reg.pushManager.getSubscription()));
  } catch {
    return null;
  }
}

const remember = (token) => {
  try {
    localStorage.setItem('rpos-push-on', '1');
    if (token) localStorage.setItem('rpos-push-token', token);
  } catch { /* private mode */ }
};
const forget = () => { try { localStorage.removeItem('rpos-push-on'); localStorage.removeItem('rpos-push-token'); } catch { /* private mode */ } };

/**
 * The iOS shell re-sends the token at every launch when permission is already given (a token can
 * change). Register it quietly. Call once the person's chat is ready. review fix A7.
 */
export function quietIosRefresh(call, app = 'staff') {
  if (typeof window === 'undefined' || pushKind() !== 'ios') return;
  const go = async (t) => {
    if (!t?.token) return;
    const r = await call({ action: 'push.register', platform: 'apns', token: t.token, environment: t.environment === 'sandbox' ? 'sandbox' : 'production', app });
    if (r.ok) remember(t.token);
  };
  window.__rposPushQuiet = go;
  if (window.__rposPushLast) go(window.__rposPushLast);
}

/** Forget this phone for this person (before signing out of the staff app). Never throws. review fix A3/A6. */
export async function unregisterPush(call) {
  try {
    const kind = pushKind();
    if (kind === 'ios') {
      const token = localStorage.getItem('rpos-push-token');
      if (token) await call({ action: 'push.unregister', platform: 'apns', token });
    } else if (kind === 'web') {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && (await reg.pushManager.getSubscription());
      if (sub) {
        await call({ action: 'push.unregister', platform: 'webpush', subscription: { endpoint: sub.endpoint } });
        await sub.unsubscribe().catch(() => {});
      }
    }
  } catch { /* signing out still happens */ }
  forget();
  if (typeof window !== 'undefined') window.__rposPushQuiet = undefined;
}

/** The page tells the shell and the service worker which chat is on screen (no banner for it). review fix A5. */
export function setOpenChat(id) {
  try { window.RposPush?.setOpen?.(id || null); } catch { /* old shell */ }
  try { navigator.serviceWorker?.controller?.postMessage({ type: 'CHAT_OPEN', conversation_id: id || null }); } catch { /* no worker */ }
}

/** Ask, subscribe and register. call: the team-chat caller; app: 'staff' or 'manager' (the iOS topic). */
export async function registerPush(call, app = 'staff') {
  const kind = pushKind();
  if (kind === 'ios') {
    return new Promise((resolve) => {
      const done = (r) => { clearTimeout(t); window.__rposPushToken = undefined; resolve(r); };
      const t = setTimeout(() => done({ ok: false, message: 'Notifications did not answer. Try again.' }), 60000);
      window.__rposPushToken = async (res) => {
        if (!res || res.error || !res.token) { done({ ok: false, message: res?.error === 'denied' ? 'Notifications are off for this app in Settings.' : 'Notifications could not be turned on.' }); return; }
        const r = await call({ action: 'push.register', platform: 'apns', token: res.token, environment: res.environment === 'sandbox' ? 'sandbox' : 'production', app });
        if (r.ok) { remember(res.token); window.RposPush.permission = 'granted'; }
        done(r);
      };
      window.RposPush.register();
    });
  }
  if (kind !== 'web') return { ok: false, message: 'This phone or browser cannot show notifications.' };
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, message: 'Notifications are blocked. Allow them in the browser settings.' };
  const reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register('/sw.js', { scope: '/' }));
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) });
  const r = await call({ action: 'push.register', platform: 'webpush', subscription: sub.toJSON(), app });
  if (r.ok) remember();
  return r;
}
