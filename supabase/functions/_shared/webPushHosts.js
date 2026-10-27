// supabase/functions/_shared/webPushHosts.js
// MARKER 5.11.102 web push hosts (review fix S7)
//
// A browser's push subscription names the push service to send to. team-chat (push.register) keeps
// only the browsers' own services, so a forged subscription can never make our server send requests
// to an address of someone's choosing. Pure, tested from src/lib/pushCrypto.test.js.

const HOSTS = [
  /^fcm\.googleapis\.com$/,              // Chrome, Edge on Android, most Android browsers (the Web Push endpoint, not the Firebase SDK)
  /(^|\.)push\.services\.mozilla\.com$/, // Firefox
  /^web\.push\.apple\.com$/,            // Safari, iPhone home screen apps
  /(^|\.)notify\.windows\.com$/,        // Edge on Windows
];

export function webPushHostOk(endpoint) {
  try {
    const u = new URL(String(endpoint || ''));
    return u.protocol === 'https:' && !u.port && !u.username && HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}
