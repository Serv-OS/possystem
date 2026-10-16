// src/surfaces/waitlist/QueueCard.jsx
//
// One party in the live queue. Shows party identity (name, size, phone, a UV
// "returning/VIP" badge when it's a known CRM guest), a live elapsed timer vs the
// quote (green under, amber approaching, red over), a status pill, and a single
// one-tap context action that walks the lifecycle:
//
//   waiting  → Notify ("you're next")
//   notified → Send table ready
//   ready    → Seat
//
// A kebab opens the secondary actions: Seat now, Re-send SMS, No-show, Walked
// away, Cancel. Every action goes through the store (setWaitlistStatus /
// cancelWaitlistParty / sendWaitlistSMS) — this component never touches the DB.

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { STATUS, waitState } from '../../lib/waitlist/waitlist';
import { Icon } from '../../components/ServOSIcons';

const mono = { fontFamily: 'var(--font-mono)' };

const mmss = (ms) => {
  if (!ms) return '0:00';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  const m = Math.floor(s / 60), ss = s % 60;
  return `${m}:${String(ss).padStart(2, '0')}`;
};

// pretty UK-ish phone grouping; falls back to raw
function fmtPhone(p) {
  if (!p) return '';
  const d = String(p).replace(/[^\d+]/g, '');
  if (d.startsWith('+44') && d.length >= 12) return `${d.slice(0, 3)} ${d.slice(3, 7)} ${d.slice(7)}`;
  if (d.length === 11) return `${d.slice(0, 5)} ${d.slice(5)}`;
  return p;
}

const PILL = {
  waiting:  { bg: 'var(--acc-d)', fg: 'var(--acc)', bd: 'var(--acc-b)', label: 'Waiting' },
  notified: { bg: 'var(--blu-d)', fg: 'var(--uv)', bd: 'var(--blu-b)', label: 'Notified' },
  ready:    { bg: 'var(--grn-d)', fg: 'var(--grn)', bd: 'var(--grn-b)', label: 'Ready' },
};

// F1: replies the inbound edge fn already acts on (confirm → confirmed_at, cancel
// → status). Anything else is free-text we surface verbatim so the host sees it.
const RECOGNISED_REPLY = new Set(['on_my_way', 'confirm', 'cancel']);
const isFreeTextReply = (r) => {
  if (!r) return false;
  return !RECOGNISED_REPLY.has(String(r).trim().toLowerCase());
};
// the one-tap forward action per status
const NEXT = {
  waiting:  { to: STATUS.NOTIFIED, label: 'Notify', icon: 'bell', sms: 'next' },
  notified: { to: STATUS.READY,    label: 'Send table ready', icon: 'check', sms: 'ready' },
  ready:    { to: 'seat',          label: 'Seat', icon: 'dinein' },
};

export default function QueueCard({ entry, onSeat, seatOn = null, onSeatOn = null }) {
  const setStatus = useStore(s => s.setWaitlistStatus);
  const cancelParty = useStore(s => s.cancelWaitlistParty);
  const sendSMS = useStore(s => s.sendWaitlistSMS);
  const [, force] = useState(0);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(null);

  // tick the live timer every second
  useEffect(() => { const t = setInterval(() => force(n => n + 1), 1000); return () => clearInterval(t); }, []);
  // close kebab on outside tap
  useEffect(() => {
    if (!menu) return;
    const h = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenu(false); };
    document.addEventListener('pointerdown', h);
    return () => document.removeEventListener('pointerdown', h);
  }, [menu]);

  // 16 Oct 2026 (Peter: parties waiting 126 to 142 min still read "quoted 5m"):
  // the timer runs against what the guest was PROMISED (the first quote), and a
  // party past it reads "Over by N min", amber for the first 10 minutes then
  // red, with the extra wait to tell the guest (lib/waitlist, tested).
  // Elapsed time is wall clock arithmetic, the same on any device in any zone.
  const ws = waitState(entry);
  const promised = ws.promised;
  const TONE = { green: 'var(--grn)', amber: 'var(--amber, var(--orn))', red: 'var(--red)' };
  const timerCol = TONE[ws.tone] || TONE.green;
  // accessibility: don't rely on timer colour alone, a text cue too.
  const timerCue = ws.text ? { text: ws.text, icon: ws.over > 0 || ws.left === 0 ? 'warn' : 'bell', col: timerCol } : null;
  const pill = PILL[entry.status] || PILL.waiting;
  const next = NEXT[entry.status] || NEXT.waiting;
  const returning = !!entry.customerId || !!entry.returning;

  const doNext = () => {
    if (next.to === 'seat') { onSeat?.(entry); return; }
    setStatus?.(entry.id, next.to);   // store stamps timestamps + fires SMS for notified/ready
  };

  const act = (fn) => { setMenu(false); fn(); };

  return (
    <div className="sv-glass" style={{ padding: '14px 16px', borderRadius: 16, position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        {/* size chip */}
        <div className="sv-tile" style={{ '--h': returning ? 280 : 150, width: 46, height: 46, borderRadius: 13, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 800, color: returning ? 'var(--uv)' : 'var(--grn)' }}>{entry.size}</span>
        </div>

        {/* identity */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15.5, fontWeight: 800, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.name || 'Guest'}</span>
            {returning && (
              <span style={{ fontSize: 9.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'var(--blu-d)', color: 'var(--uv)', border: '1px solid var(--blu-b)', textTransform: 'uppercase', letterSpacing: '.08em', ...mono }}>Returning</span>
            )}
            {/* F1: guest replied "on my way" → confirmed_at stamped by inbound edge fn.
                Icon + text label (not colour alone) for accessibility; signal-green state. */}
            {entry.confirmedAt && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 9.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'var(--grn-d)', color: 'var(--grn)', border: '1px solid var(--grn-b)', textTransform: 'uppercase', letterSpacing: '.08em', ...mono }}>
                <Icon name="check" size={11} /> On the way
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2, ...mono }}>
            {entry.phone ? fmtPhone(entry.phone) : 'No phone'}
            {entry.sectionPref ? ` · ${entry.sectionPref}` : ''}
          </div>
          {entry.notes ? <div style={{ fontSize: 11, color: 'var(--t2)', marginTop: 3, fontStyle: 'italic' }}>“{entry.notes}”</div> : null}
          {/* F1: unrecognised free-text reply from the guest — surface it muted so the
              host sees what they actually said (recognised on_my_way/confirm/cancel
              are already handled by the chip / status, so not echoed here). */}
          {isFreeTextReply(entry.lastGuestReply) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--t3)', marginTop: 3, ...mono }}>
              <Icon name="note" size={11} /> <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>“{entry.lastGuestReply}”</span>
            </div>
          )}
        </div>

        {/* timer + quote */}
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 800, color: timerCol, lineHeight: 1 }}>{mmss(entry.addedAt)}</div>
          <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 3, ...mono }}>
            {promised != null ? `quoted ${promised}m` : 'no quote'}
          </div>
          {/* what the host can say now: the extra wait, not the total since arrival */}
          {ws.more != null && (
            <div style={{ fontSize: 10, color: 'var(--t2)', marginTop: 2, fontWeight: 700, ...mono }}>tell them ~{ws.more} more min</div>
          )}
          {timerCue && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginTop: 4, fontSize: 9.5, fontWeight: 700, color: timerCue.col, ...mono }}>
              <Icon name={timerCue.icon} size={10} /> {timerCue.text}
            </div>
          )}
        </div>
      </div>

      {/* footer: status pill + one-tap action + kebab */}
      {/* wraps on a phone: the pill, Seat on T8, the main action and the menu do not fit one 326 px line.
          "Over by N min" shows once, under the timer. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, rowGap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, padding: '5px 11px', borderRadius: 999, background: pill.bg, color: pill.fg, border: `1px solid ${pill.bd}`, textTransform: 'uppercase', letterSpacing: '.06em', ...mono }}>{pill.label}</span>
        <div style={{ flex: 1 }} />
        {/* 16 Oct 2026: a fitting table is free and this party is next for it: one tap seats them there. */}
        {seatOn && onSeatOn && (
          <button onClick={() => onSeatOn(seatOn)} className="btn btn-ghost" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', fontSize: 13, fontWeight: 800, borderRadius: 999, borderColor: 'var(--grn-b)', color: 'var(--grn)' }}>
            <Icon name="dinein" size={15} /> Seat on {seatOn.label || seatOn.id}
          </button>
        )}
        <button onClick={doNext} className="btn btn-acc" style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 16px', fontSize: 13, fontWeight: 800, borderRadius: 999 }}>
          <Icon name={next.icon} size={15} /> {next.label}
        </button>
        <div ref={menuRef} style={{ position: 'relative' }}>
          <button onClick={() => setMenu(m => !m)} aria-label="More" className="sv-glass" style={{ width: 44, height: 44, borderRadius: 12, display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--t2)', border: '1px solid var(--bdr)', fontSize: 20, fontWeight: 800, ...mono }}>⋯</button>
          {menu && (
            <div className="sv-glass" style={{ position: 'absolute', right: 0, bottom: 52, zIndex: 30, minWidth: 196, padding: 6, borderRadius: 14, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <KebabItem icon="dinein" onClick={() => act(() => onSeat?.(entry))}>Seat now</KebabItem>
              {entry.phone && (entry.status === STATUS.NOTIFIED || entry.status === STATUS.READY) && (
                <KebabItem icon="bell" onClick={() => act(() => sendSMS?.(entry, entry.status === STATUS.READY ? 'ready' : 'next'))}>Re-send SMS</KebabItem>
              )}
              <div style={{ height: 1, background: 'var(--bdr)', margin: '4px 0' }} />
              <KebabItem icon="warn" tone="red" onClick={() => act(() => cancelParty?.(entry.id, STATUS.NO_SHOW))}>No-show</KebabItem>
              <KebabItem icon="back" tone="red" onClick={() => act(() => cancelParty?.(entry.id, STATUS.WALKED_AWAY))}>Walked away</KebabItem>
              <KebabItem icon="close" tone="red" onClick={() => act(() => cancelParty?.(entry.id, STATUS.CANCELLED))}>Cancel</KebabItem>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function KebabItem({ icon, children, onClick, tone }) {
  const col = tone === 'red' ? 'var(--red)' : 'var(--t1)';
  return (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px', borderRadius: 10, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', color: col, fontFamily: 'inherit', fontSize: 13.5, fontWeight: 600 }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--inset)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
      <Icon name={icon} size={16} /> {children}
    </button>
  );
}
