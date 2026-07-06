// src/lib/useCardScan.js
//
// One hook for staff-card reads from EITHER source:
//   • a native NFC tap (window.RposNfc → onNfcTap), where the device exposes standard Android NFC, and
//   • a USB HID NFC reader (keyboard-wedge) that "types" the card UID as a fast keystroke burst + Enter.
// Used by the login screen (PINScreen) AND the app-wide fast-user-switch. Global-safe: it ignores
// keystrokes while the user is typing into an input/textarea/contentEditable, so it never eats a note,
// search or PIN field. Pass active=false to pause (e.g. while a modal owns its own card entry).
import { useEffect, useRef } from 'react';
import { onNfcTap, normalizeCardId } from './nfc';

export function useCardScan(onCard, active = true) {
  const cb = useRef(onCard);
  useEffect(() => { cb.current = onCard; });   // keep latest callback without re-binding listeners
  useEffect(() => {
    if (!active) return undefined;
    const fire = (id) => { const f = cb.current; if (id && typeof f === 'function') f(id); };
    const stopNfc = onNfcTap((cardId) => fire(cardId));   // native tap (no-op off-device)

    let buf = '', timer = null;
    const flush = () => { const raw = buf; buf = ''; if (timer) { clearTimeout(timer); timer = null; } if (raw.length >= 4) fire(normalizeCardId(raw)); };
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;  // don't hijack real typing
      if (e.key === 'Enter') { if (buf.length >= 4) flush(); else buf = ''; return; }   // observe only — never swallow Enter
      if (e.key && e.key.length === 1 && /[0-9A-Za-z:-]/.test(e.key)) { buf += e.key; if (timer) clearTimeout(timer); timer = setTimeout(flush, 200); }
    };
    window.addEventListener('keydown', onKey);
    return () => { try { stopNfc(); } catch { /* ignore */ } window.removeEventListener('keydown', onKey); if (timer) clearTimeout(timer); };
  }, [active]);
}
