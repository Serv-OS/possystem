// src/lib/pushConfig.js
//
// 5.11.102 push: the public half of our Web Push (VAPID) key pair. Public by design: a browser needs it
// to subscribe, and only our server (secret VAPID_PRIVATE_KEY) can sign pushes for it. The private
// key is never in git (release folder vapid_private.txt, pasted into the Supabase secrets).
// VITE_VAPID_PUBLIC_KEY overrides it for a test project with its own pair.

export const VAPID_PUBLIC_KEY = (import.meta.env?.VITE_VAPID_PUBLIC_KEY || 'BN867qQeNJ-6ItDfMkE4y6abZf-gCQX3XMzTN0_SYy10rRPXpK4LeUWkMrW2M-QsLwmqz9DzpuVDDpQBs78Rb88').trim();
