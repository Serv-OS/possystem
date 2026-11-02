// src/surfaces/online/OnlineHeaderBlock.jsx
//
// THE ORDERING HEADER under the themed MenuHeader on the online page (5.12.34). Peter looked at
// Toast's online ordering header and said "we should steal this". Our own theme throughout: the
// venue's Appearance tokens (theme.bg / fg / accent, the CSS vars from menuTheme.deriveVars), the
// page's cardBdr and muted, never a colour of this file's own.
//
//   Left:  venue name, its street address, "Change location" (only with another venue to go to)
//   Right: the order type pill ("Pickup only" with one type; tapping opens OrderTypeSheet to
//          pick in place, it no longer sends the customer back to the welcome screen),
//          "Pickup from <address>" (chevron: ChangeLocationSheet),
//          "ASAP, ready in 30 to 35 min" (chevron: OrderTimingSheet).
//   Phone (useNarrowOnline.js): name and address, then the two rows, then the pill.
//
// The sheets are centred on a wide screen and rise from the bottom on a phone. The words come
// from lib/online/orderTiming.js and lib/online/siblingVenues.js, which are tested; this file
// only lays them out. QR does not render this block (the table pill stays in MenuHeader).

import { useState } from 'react';
import { DISPLAY_FONT } from '../menu/menuTheme';
import SlotPicker from './SlotPicker';
import { cartResetWords } from '../../lib/online/siblingVenues';

function contrastFg(hex) {
  if (!hex) return '#fff';
  const c = String(hex).replace('#', '');
  const n = c.length === 3 ? c.split('').map(x => x + x).join('') : c;
  if (n.length !== 6) return '#fff';
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 128 ? '#0b0c10' : '#ffffff';
}

// Line icons in the row colour (currentColor), so they follow the theme.
const PinIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.6" />
  </svg>
);
const ClockIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" />
  </svg>
);
const DashedClockIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3.5a8.5 8.5 0 1 1-8.5 8.5" /><path d="M4.2 9.2a8.5 8.5 0 0 1 1.6-2.9M6.6 5.1a8.5 8.5 0 0 1 2.7-1.3" strokeDasharray="2 2.5" /><path d="M12 7.5V12l3 2" />
  </svg>
);
const Chevron = ({ muted }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
);
export const SearchIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.8-3.8" /></svg>
);

function Row({ icon, words, opens, onClick, theme, muted, bold = null }) {
  const inner = (
    <>
      <span style={{ color: theme.fg, display: 'inline-flex', flex: 'none' }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 14.5, fontWeight: 600, color: theme.fg, lineHeight: 1.35, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {bold ? <>{words}<b style={{ fontWeight: 800 }}>{bold}</b></> : words}
      </span>
      {opens && <Chevron muted={muted} />}
    </>
  );
  const base = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 40, padding: '6px 0', background: 'transparent', border: 'none', textAlign: 'left', fontFamily: 'inherit', boxSizing: 'border-box', minWidth: 0 };
  if (!opens) return <div style={base}>{inner}</div>;
  return <button type="button" className="op-btn" onClick={onClick} style={{ ...base, cursor: 'pointer', color: theme.fg }}>{inner}</button>;
}

/**
 * The block itself. All words arrive ready made (lib/online/orderTiming.js).
 */
export default function OnlineHeaderBlock({
  theme, muted, narrow = false,
  name, address = '', canChangeLocation = false, onChangeLocation,
  pillIcon = null, pillLabel, pillOpens = false, onPill,
  locationWords, locationBold = null, locationOpens = false, onLocationRow,
  timingWords, timingOpens = false, timingDashed = false, onTimingRow,
}) {
  const pill = (
    <button type="button" className="op-btn" onClick={pillOpens ? onPill : undefined} aria-haspopup={pillOpens ? 'dialog' : undefined} style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      width: narrow ? '100%' : 'auto', minWidth: narrow ? 0 : 260, padding: '11px 18px', borderRadius: 999,
      background: 'transparent', color: theme.fg, border: `1.5px solid ${theme.accent}`,
      fontSize: 14.5, fontWeight: 800, fontFamily: 'inherit', cursor: pillOpens ? 'pointer' : 'default', boxSizing: 'border-box',
    }}>
      {pillIcon && <span aria-hidden="true">{pillIcon}</span>}
      <span>{pillLabel}</span>
      {pillOpens && <span style={{ opacity: 0.55, fontSize: 12 }}>▾</span>}
    </button>
  );
  const rows = (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <Row icon={<PinIcon />} words={locationWords} bold={locationBold} opens={locationOpens} onClick={onLocationRow} theme={theme} muted={muted} />
      <Row icon={timingDashed ? <DashedClockIcon /> : <ClockIcon />} words={timingWords} opens={timingOpens} onClick={onTimingRow} theme={theme} muted={muted} />
    </div>
  );
  const left = (
    // flex: none when stacked: a 300px flex basis in a column would be 300px of HEIGHT.
    <div style={{ minWidth: 0, flex: narrow ? 'none' : '1 1 300px' }}>
      <div style={{ fontFamily: DISPLAY_FONT, fontWeight: 700, fontSize: narrow ? 24 : 'clamp(22px,3.2cqw,32px)', letterSpacing: '-.02em', lineHeight: 1.1, color: theme.fg, textTransform: 'uppercase' }}>{name}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap', marginTop: 6, fontSize: 14, color: theme.fg, fontWeight: 500 }}>
        {address ? <span style={{ minWidth: 0 }}>{address}</span> : null}
        {canChangeLocation && (
          <button type="button" onClick={onChangeLocation} className="op-btn" style={{ background: 'transparent', border: 'none', padding: 0, color: theme.fg, fontFamily: 'inherit', fontSize: 14, fontWeight: 700, textDecoration: 'underline', textUnderlineOffset: 3, cursor: 'pointer' }}>Change location</button>
        )}
      </div>
    </div>
  );

  if (narrow) {
    return (
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '18px 20px 6px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {left}
        {rows}
        {pill}
      </div>
    );
  }
  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '22px 20px 8px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' }}>
      {left}
      <div style={{ flex: '0 1 380px', minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
        {pill}
        {rows}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet: centred on a wide screen, from the bottom on a phone. Title, body, Cancel / confirm.
export function Sheet({ theme, cardBdr, narrow, title, children, onClose, confirmLabel = 'Confirm', onConfirm, confirmDisabled = false, cancelLabel = 'Cancel' }) {
  const fg = contrastFg(theme.accent);
  return (
    <div onClick={onClose} role="presentation" style={{
      position: 'fixed', inset: 0, zIndex: 45, background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: narrow ? 'flex-end' : 'center', justifyContent: 'center',
    }}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: narrow ? '100%' : 520, maxHeight: '92vh', overflowY: 'auto',
        background: theme.bg, color: theme.fg,
        borderRadius: narrow ? '18px 18px 0 0' : 18,
        boxShadow: '0 -10px 40px rgba(0,0,0,0.3)',
        fontFamily: 'inherit',
      }}>
        {narrow && <div style={{ padding: '12px 0 2px', display: 'flex', justifyContent: 'center' }}><div style={{ width: 44, height: 5, borderRadius: 3, background: cardBdr }} /></div>}
        <div style={{ padding: '18px 22px 14px', textAlign: 'center', fontFamily: DISPLAY_FONT, fontWeight: 700, fontSize: 20, letterSpacing: '-.01em', textTransform: 'uppercase', borderBottom: `1px solid ${cardBdr}` }}>{title}</div>
        <div style={{ padding: '6px 22px 10px' }}>{children}</div>
        <div style={{ padding: '12px 22px calc(16px + env(safe-area-inset-bottom)) 22px', display: 'flex', gap: 12, borderTop: `1px solid ${cardBdr}` }}>
          <button type="button" onClick={onClose} className="op-btn" style={{
            flex: 1, padding: '13px 18px', borderRadius: 999, background: 'transparent', color: theme.fg,
            border: `1.5px solid ${cardBdr}`, fontSize: 14, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'uppercase', letterSpacing: '.02em',
          }}>{cancelLabel}</button>
          <button type="button" onClick={onConfirm} disabled={confirmDisabled} className="op-btn-primary" style={{
            flex: 1, padding: '13px 18px', borderRadius: 999, background: theme.accent, color: fg,
            border: 'none', fontSize: 14, fontWeight: 800, cursor: confirmDisabled ? 'default' : 'pointer', fontFamily: 'inherit',
            opacity: confirmDisabled ? 0.5 : 1, textTransform: 'uppercase', letterSpacing: '.02em',
          }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function Radio({ on, theme, cardBdr }) {
  return (
    <span aria-hidden="true" style={{
      width: 24, height: 24, borderRadius: '50%', flex: 'none', boxSizing: 'border-box',
      border: `2px solid ${on ? theme.accent : cardBdr}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {on && <span style={{ width: 12, height: 12, borderRadius: '50%', background: theme.accent }} />}
    </span>
  );
}

function Choice({ on, onClick, icon, label, desc, theme, cardBdr, muted, last = false }) {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onClick} className="op-btn" style={{
      display: 'flex', alignItems: 'center', gap: 14, width: '100%', padding: '16px 2px', background: 'transparent',
      border: 'none', borderBottom: last ? 'none' : `1px solid ${cardBdr}`, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', color: theme.fg,
    }}>
      {icon && <span style={{ color: theme.fg, display: 'inline-flex', flex: 'none' }}>{icon}</span>}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 16, fontWeight: 700 }}>{label}</span>
        {desc && <span style={{ display: 'block', fontSize: 13, color: muted, marginTop: 2 }}>{desc}</span>}
      </span>
      <Radio on={on} theme={theme} cardBdr={cardBdr} />
    </button>
  );
}

/** Pick the order type in place. choices: lib/online/orderTiming.js orderTypeChoices. */
export function OrderTypeSheet({ theme, cardBdr, muted, narrow, choices, value, icons = {}, onPick, onClose }) {
  const [picked, setPicked] = useState(value);
  return (
    <Sheet theme={theme} cardBdr={cardBdr} narrow={narrow} title="Order type" onClose={onClose} onConfirm={() => { onPick(picked); onClose(); }} confirmDisabled={!picked}>
      <div role="radiogroup" aria-label="Order type">
        {choices.map((c, i) => (
          <Choice key={c.id} on={picked === c.id} onClick={() => setPicked(c.id)} icon={icons[c.id] ? <span style={{ fontSize: 20 }}>{icons[c.id]}</span> : null} label={c.label} desc={c.desc} theme={theme} cardBdr={cardBdr} muted={muted} last={i === choices.length - 1} />
        ))}
      </div>
    </Sheet>
  );
}

/** ASAP or Schedule for later, with the checkout's own slot list. */
export function OrderTimingSheet({ theme, cardBdr, muted, narrow, timing, slots, orderAheadOnly = false, asapWords, onConfirm, onClose }) {
  const [draft, setDraft] = useState(() => ({ mode: orderAheadOnly ? 'scheduled' : (timing?.mode || 'asap'), slot: timing?.slot || null }));
  const inputBg = theme.isLight ? '#f5f5f7' : '#1f1f24';
  const slot = draft.mode === 'scheduled' ? (draft.slot && slots.some(s => s.iso === draft.slot.iso) ? draft.slot : (slots[0] || null)) : draft.slot;
  const canConfirm = draft.mode === 'asap' || !!slot;
  return (
    <Sheet theme={theme} cardBdr={cardBdr} narrow={narrow} title="Order timing" onClose={onClose} confirmDisabled={!canConfirm}
      onConfirm={() => { onConfirm({ mode: draft.mode, slot: draft.mode === 'scheduled' ? slot : draft.slot }); onClose(); }}>
      <div role="radiogroup" aria-label="Order timing">
        {!orderAheadOnly && (
          <Choice on={draft.mode === 'asap'} onClick={() => setDraft(d => ({ ...d, mode: 'asap' }))} icon={<DashedClockIcon />} label="ASAP" desc={asapWords} theme={theme} cardBdr={cardBdr} muted={muted} />
        )}
        <Choice on={draft.mode === 'scheduled'} onClick={() => setDraft(d => ({ ...d, mode: 'scheduled' }))} icon={<ClockIcon />} label="Schedule for later"
          desc={orderAheadOnly ? 'We are closed right now. Pick a time and your order will be ready when we reopen.' : null} theme={theme} cardBdr={cardBdr} muted={muted} last />
      </div>
      {draft.mode === 'scheduled' && (
        <div style={{ padding: '4px 0 10px' }}>
          <SlotPicker slots={slots} value={slot} onChange={(s) => setDraft(d => ({ ...d, slot: s }))} theme={theme} cardBdr={cardBdr} inputBg={inputBg} />
        </div>
      )}
    </Sheet>
  );
}

const StoreIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 9.5 4.4 4.5h15.2L21 9.5" /><path d="M3 9.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" /><path d="M5 12.5V20h14v-7.5" /><path d="M10 20v-4.5h4V20" />
  </svg>
);

/** Current venue, then the company's other venues with online ordering on. */
export function ChangeLocationSheet({ theme, cardBdr, muted, narrow, current, venues, cartCount = 0, onContinue, onClose }) {
  const [picked, setPicked] = useState(null);
  const chosen = venues.find(v => v.id === picked) || null;
  const heading = { fontFamily: DISPLAY_FONT, fontWeight: 700, fontSize: 15, textTransform: 'uppercase', letterSpacing: '.01em', margin: '14px 0 6px', color: theme.fg };
  return (
    <Sheet theme={theme} cardBdr={cardBdr} narrow={narrow} title="Change location" onClose={onClose} confirmLabel="Continue" confirmDisabled={!chosen}
      onConfirm={() => { if (chosen) onContinue(chosen); }}>
      <div style={heading}>Current location</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 2px 16px', borderBottom: `1px solid ${cardBdr}` }}>
        <span style={{ color: theme.fg, display: 'inline-flex', flex: 'none' }}><StoreIcon /></span>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 16, fontWeight: 700 }}>{current.name}</span>
          {current.address && <span style={{ display: 'block', fontSize: 13.5, color: muted, marginTop: 3 }}>{current.address}</span>}
        </span>
      </div>
      <div style={heading}>Switch to another location</div>
      <div role="radiogroup" aria-label="Switch to another location">
        {venues.map((v, i) => (
          <Choice key={v.id} on={picked === v.id} onClick={() => setPicked(v.id)} label={v.name} desc={v.address || null} theme={theme} cardBdr={cardBdr} muted={muted} last={i === venues.length - 1} />
        ))}
      </div>
      {chosen && cartCount > 0 && (
        <div role="status" style={{ marginTop: 10, padding: '10px 14px', borderRadius: 12, background: `${theme.accent}18`, border: `1px solid ${theme.accent}55`, fontSize: 13.5, fontWeight: 600, color: theme.fg, lineHeight: 1.45 }}>
          {cartResetWords(cartCount, chosen.name)}
        </div>
      )}
    </Sheet>
  );
}
