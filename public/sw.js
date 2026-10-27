// Restaurant OS Service Worker
// skipWaiting is NOT called on install — new SW waits until user approves update
// This lets the UpdateBanner show and give staff control over when to refresh

self.addEventListener('install', e => {
  // Do NOT call skipWaiting() here — we want the new SW to wait
  // so the update banner can prompt the user
});

self.addEventListener('activate', e => {
  // Clean up old caches when we activate
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Network first — always fetch fresh content
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/'))
    );
  }
});

// App sends this message when user taps "Update now"
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── App push (5.11.102) ──────────────────────────────────────────────────────
// Web Push for the home screen staff app (Android, desktop, iPhone home screen). The server
// (supabase/functions/_shared/push.ts) encrypts { title, body, tag, data } for this browser; the
// push service never sees the words. No Firebase: the browser's own push service, our VAPID keys.
self.addEventListener('push', e => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch { msg = { body: e.data ? e.data.text() : '' }; }
  const title = msg.title || 'ServOS';
  e.waitUntil(self.registration.showNotification(title, {
    body: msg.body || '',
    tag: msg.tag || undefined,
    renotify: !!msg.tag,
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-72x72.png',
    data: msg.data || {},
  }));
});

// Tapping a notification opens (or focuses) the staff app, on the chat when it was a chat message.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = new URL(data.url || '/?mode=staff', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.includes('mode=staff') && 'focus' in w) {
        w.postMessage({ type: 'PUSH_OPEN', data });
        return w.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
