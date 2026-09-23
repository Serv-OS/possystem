// pairingCodeState.js — what a terminal's pairing code looks like right now.
//
// Peter, 23 Sep 2026: "if they expire they don't regenerate to a new one for
// pairing so how do I then get a new code". An unpaired terminal kept showing
// its old code with "valid for 60 minutes" for ever, and the New pairing code
// button only appeared when there was NO code at all. Once the code expired the
// operator was stuck looking at a dead one. His own iPad at Provo was in that
// state for a day.
//
// Pure: give it the code, its expiry and the clock, it says what to show.

/**
 * @param {{ code?: string|null, expiresAt?: string|number|Date|null, now?: number }} f
 * @returns {{ state: 'none'|'live'|'expired', label: string }}
 */
export function pairingCodeState({ code, expiresAt, now = Date.now() } = {}) {
  if (!code) return { state: 'none', label: '' };
  if (!expiresAt) return { state: 'live', label: '' };   // legacy code with no clock: say nothing rather than guess
  const t = new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return { state: 'live', label: '' };
  if (t <= now) return { state: 'expired', label: 'expired. Issue a new one.' };
  const mins = Math.max(1, Math.round((t - now) / 60_000));
  return { state: 'live', label: mins >= 120 ? `valid until ${new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : `valid for ${mins} more minute${mins === 1 ? '' : 's'}` };
}

/** An unpaired terminal can ALWAYS be given a new code. Expired or not. */
export function canIssueNewCode({ status } = {}) {
  return status === 'unpaired';
}
