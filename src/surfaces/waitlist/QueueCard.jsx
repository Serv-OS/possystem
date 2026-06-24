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
import { STATUS } from '../../lib/waitlist/waitlist';
import { Icon } from '../../components/ServOSIcons';

const mono = { fontFamily: 'var(--font-mono)' };

// elapsed minutes since added
const minsSince = (ms) => (ms ? Math.max(0, Math.floor((Date.now() - ms) / 60000)) : 0);
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
// the one-tap forward action per status
const NEXT = {
  waiting:  { to: STATUS.NOTIFIED, label: 'Notify', icon: 'bell', sms: 'next' },
  notified: { to: STATUS.READY,    label: 'Send table ready', icon: 'check', sms: 'ready' },
  ready:    { to: 'seat',          label: 'Seat', icon: 'dinein' },
};

export default function QueueCard({ entry, onSeat }) {
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

  const elapsed = minsSince(entry.addedAt);
  const quoted = Number.isFinite(entry.quoted) ? entry.quoted : null;
  // timer colour: green well under quote, amber within 5 min, red over
  let timerCol = 'var(--grn)';
  if (quoted != null) {
    if (elapsed >= quoted) timerCol = 'var(--red)';
    else if (elapsed >= quoted - 5) timerCol = 'var(--amber, var(--orn))';
  }
  // accessibility: don't rely on timer colour alone — derive a tiny text cue too.
  // amber "approaching" → "~Xm left", red "over" → "Xm over", green → none.
  let timerCue = null;
  if (quoted != null) {
    if (elapsed >= quoted) timerCue = { text: `${elapsed - quoted}m over`, icon: 'warn', col: 'var(--red)' };
    else if (elapsed >= quoted - 5) timerCue = { text: `~${quoted - elapsed}m left`, icon: 'bell', col: 'var(--amber, var(--orn))' };
  }
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
          </div>
          <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2, ...mono }}>
            {entry.phone ? fmtPhone(entry.phone) : 'No phone'}
            {entry.sectionPref ? ` · ${entry.sectionPref}` : ''}
          </div>
          {entry.notes ? <div style={{ fontSize: 11, color: 'var(--t2)', marginTop: 3, fontStyle: 'italic' }}>“{entry.notes}”</div> : null}
        </div>

        {/* timer + quote */}
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 800, color: timerCol, lineHeight: 1 }}>{mmss(entry.addedAt)}</div>
          <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 3, ...mono }}>
            {quoted != null ? `quoted ${quoted}m` : 'no quote'}
          </div>
          {timerCue && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginTop: 4, fontSize: 9.5, fontWeight: 700, color: timerCue.col, ...mono }}>
              <Icon name={timerCue.icon} size={10} /> {timerCue.text}
            </div>
          )}
        </div>
      </div>

      {/* footer: status pill + one-tap action + kebab */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, padding: '5px 11px', borderRadius: 999, background: pill.bg, color: pill.fg, border: `1px solid ${pill.bd}`, textTransform: 'uppercase', letterSpacing: '.06em', ...mono }}>{pill.label}</span>
        {quoted != null && elapsed >= quoted && (
          <span style={{ fontSize: 10, color: 'var(--red)', fontWeight: 700, ...mono }}>{elapsed - quoted}m over</span>
        )}
        <div style={{ flex: 1 }} />
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
