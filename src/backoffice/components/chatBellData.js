// src/backoffice/components/chatBellData.js
// MARKER 5.11.109 Back Office chat bell (data)
//
// The Back Office chat bell's polling (the team-chat inbox action every 30 s while the browser tab
// is in front) and the "open this chat" request from the bell to Workforce, Team chat, which may
// not be on screen yet. The drawing is ChatBell.jsx; the counting is chatModel.js.

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { callTeamChat } from '../../staff/chatSource';
import { inboxAnswerSummary } from '../../staff/chatModel';

export const BO_CHAT_POLL_MS = 30000;
const isUuid = (v) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

// ── "Open this chat" from the bell to Workforce, Team chat (it may not be on screen yet) ──
let pending = null;              // { id, at } or null
const listeners = new Set();
export function requestChatOpen(conversationId = null) {
  pending = { id: conversationId || null, at: Date.now() };
  for (const fn of listeners) fn(pending);
}
/** [request, clear]: the latest open request ({ id, at }) until the screen has used it. */
export function useChatOpenRequest() {
  const [req, setReq] = useState(pending);
  useEffect(() => {
    listeners.add(setReq);
    return () => { listeners.delete(setReq); };
  }, []);
  const clear = useCallback(() => { pending = null; setReq(null); }, []);
  return [req, clear];
}

/** The signed in Back Office person's chat counts, polled every 30 s while the tab is in front. */
export function useBoChatInbox({ enabled, orgId = null }) {
  const [state, setState] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      const r = await callTeamChat(supabase, isUuid(orgId) ? { action: 'inbox', org_id: orgId } : { action: 'inbox' });
      if (alive) setState(inboxAnswerSummary(r));
    };
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, BO_CHAT_POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; clearTimeout(first); clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [enabled, orgId]);
  return enabled ? state : null;
}
