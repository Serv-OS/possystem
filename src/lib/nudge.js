// src/lib/nudge.js — manager → tills "nudge" for a stalled table.
// One-way Supabase realtime broadcast on `nudge:<locationId>`. The tills subscribe in lib/realtime.js
// (startRealtime) and pop a toast + chime. No DB write — it's a transient "go check this table" ping.
// The Manager app is anonymous-paired; broadcast has no RLS, so the send works without extra grants.
import { supabase, isMock } from './supabase';

export function sendNudge(locationId, payload = {}) {
  if (isMock || !supabase || !locationId) return;
  try {
    const ch = supabase.channel(`nudge:${locationId}`);
    ch.subscribe((status) => {
      if (status !== 'SUBSCRIBED') return;
      try { ch.send({ type: 'broadcast', event: 'nudge', payload }); } catch { /* offline */ }
      setTimeout(() => { try { supabase.removeChannel(ch); } catch { /* noop */ } }, 800);
    });
  } catch { /* offline */ }
}
