// src/components/ShiftStartPrompt.jsx
//
// "Start your shift?" — shown once, the first time someone signs in to a till
// on a given day, when the venue has turned the option on
// (Back Office → Workforce → Settings).
//
// WHY IT ASKS INSTEAD OF CLOCKING SILENTLY: signing in to a till is not the
// same as starting a shift. A manager stepping on for two minutes would open a
// shift and stay clocked in until somebody noticed, which quietly corrupts the
// pay record. One tap keeps it effectively automatic without inventing hours.
//
// NO LOCATION CHECK: the till is bolted inside the venue, so using it already
// proves presence. This is the same reason it is the fallback when a phone
// cannot get a GPS fix.

import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { clockPunchForPos } from '../lib/posClockIn';

export default function ShiftStartPrompt() {
  const prompt = useStore(s => s.shiftStartPrompt);
  const clear = useStore(s => s.clearShiftStartPrompt);
  const showToast = useStore(s => s.showToast);
  const [busy, setBusy] = useState(false);

  // Escape declines, matching every other modal in the POS.
  useEffect(() => {
    if (!prompt) return;
    const onKey = (e) => { if (e.key === 'Escape' && !busy) clear?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prompt, busy, clear]);

  if (!prompt) return null;

  const start = async () => {
    setBusy(true);
    try {
      const r = await clockPunchForPos(prompt, 'in');
      if (r?.ok) showToast?.(`Shift started, ${prompt.name?.split(' ')[0] || ''}`.trim(), 'success');
      else showToast?.(r?.error || 'Could not start the shift', 'error');
    } catch (e) {
      showToast?.(e?.message || 'Could not start the shift', 'error');
    } finally {
      setBusy(false);
      clear?.();
    }
  };

  return (
    <div className="modal-back" onClick={(e) => { if (e.target === e.currentTarget && !busy) clear?.(); }}>
      <div className="modal-box" style={{ maxWidth: 340, textAlign: 'center' }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--t1)', marginBottom: 6 }}>
          Start your shift?
        </div>
        <div style={{ fontSize: 13, color: 'var(--t3)', lineHeight: 1.55, marginBottom: 18 }}>
          This clocks {prompt.name?.split(' ')[0] || 'you'} in now. Your hours run from this moment
          until you clock out.
        </div>
        <div style={{ display: 'flex', gap: 9 }}>
          <button className="btn btn-ghost" style={{ flex: 1, height: 46 }} disabled={busy} onClick={() => clear?.()}>
            Not now
          </button>
          <button className="btn btn-acc" style={{ flex: 1, height: 46 }} disabled={busy} onClick={start}>
            {busy ? 'Starting…' : 'Start shift'}
          </button>
        </div>
      </div>
    </div>
  );
}
