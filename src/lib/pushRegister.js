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

/** 'on' | 'off' | 'blocked' | 'unsupported' for the button label (the iOS shell always says off until asked). */
export function pushStatus(w = typeof window !== 'undefined' ? window : {}) {
  const kind = pushKind(w);
  if (kind === 'none') return 'unsupported';
  if (kind === 'ios') return w.localStorage?.getItem?.('rpos-push-on') === '1' ? 'on' : 'off';
  if (w.Notification.permission === 'denied') return 'blocked';
  return w.Notification.permission === 'granted' && w.localStorage?.getItem?.('rpos-push-on') === '1' ? 'on' : 'off';
}

const remember = () => { try { localStorage.setItem('rpos-push-on', '1'); } catch { /* private mode */ } };

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
        if (r.ok) remember();
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
