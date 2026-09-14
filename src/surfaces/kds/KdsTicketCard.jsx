// src/surfaces/kds/KdsTicketCard.jsx
//
// The ticket card and the expanded (pop out) ticket, v5.8.66. Sizes, colours and
// spacing are the design handoff's (design_handoff_kds/README.md), plus what Peter
// kept from the old board: a tick box per item on the card AND in the pop out, the
// staff name (switchable), covers (switchable) and the red LATE glow and pulse.
//
// SIZES: Peter kept today's automatic columns (6 across on his big screen), which are
// narrower than the design's cards, and chose "keep columns, smaller text". Names and
// item names keep the design size and step down only when one long word would otherwise
// split ("Christodo ulou"); the padding, timer and qty chip around them scale with the
// column (`scale` is 1 at the design's 380px card, see src/lib/kds/kdsFit.js).
//
// Overlays use top/right/bottom/left, never `inset`: inset needs Chrome 87 and the build
// targets the Chrome 80 WebView on older Sunmi screens.
//
// Components live at module scope and the card is memoised. The board re-renders every
// second for the clock, and a component declared inside it would remount every card on
// every tick (the old board declared TicketCard inside KDSSurface).

import { memo, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { identityParts, formatElapsed, statusOf } from '../../lib/kds/kdsTicket';
import { scaled, breakableWords, fitFontSize } from '../../lib/kds/kdsFit';
import { C, SANS, MONO, LATE_PULSE } from './kdsStyles';

const HELD_TIMER = { label: 'ON HOLD', c: '#AEB8B3', bg: 'rgba(255,255,255,.07)' };

// ── fit text ──────────────────────────────────────────────────────────────────
// Text is measured on a canvas, so it must be re-measured once the web fonts arrive,
// or a fallback font's widths would be used.
let fontsVersion = 0;
const fontListeners = new Set();
function subscribeFonts(cb) {
  fontListeners.add(cb);
  return () => fontListeners.delete(cb);
}
if (typeof document !== 'undefined' && document.fonts?.addEventListener) {
  const bump = () => { fontsVersion += 1; fontListeners.forEach(l => l()); };
  document.fonts.addEventListener('loadingdone', bump);
  document.fonts.ready?.then(bump).catch(() => {});
}
const useFontsVersion = () => useSyncExternalStore(subscribeFonts, () => fontsVersion, () => 0);

let measureCtx = null;
function widestWordPx(text, weight, px, family) {
  if (typeof document === 'undefined') return 0;
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return 0;
  measureCtx.font = `${weight} ${px}px ${family}`;
  return breakableWords(text).reduce((w, word) => Math.max(w, measureCtx.measureText(word).width), 0);
}

/**
 * A block of text whose font steps down (to minPx) when its widest word is wider than
 * the line. The size is written straight to the element, not to React state, so a
 * resize never re-renders the card.
 */
function FitText({ text, maxPx, minPx, weight, family = SANS, style }) {
  const ref = useRef(null);
  const fonts = useFontsVersion();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const size = fitFontSize({ maxPx, minPx, available: el.clientWidth, widestAtMax: widestWordPx(text, weight, maxPx, family) });
      el.style.fontSize = `${size}px`;
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, maxPx, minPx, weight, family, fonts]);
  return (
    <div ref={ref} style={{ ...style, fontFamily: family, fontWeight: weight, fontSize: maxPx, overflowWrap: 'anywhere' }}>{text}</div>
  );
}

// ── sizes ─────────────────────────────────────────────────────────────────────
/**
 * Card sizes at a scale (1 = the design). The pop out always uses the design's big sizes.
 * The words staff read (name, items, modifiers, notes) stay at the design size and only
 * step down, word by word, through FitText when a word would not fit. A first pass that
 * scaled everything took names to 16px on a 6 across board, smaller than the old board's
 * 22px, so only the chrome around the words scales: padding, gaps, timer, qty chip.
 */
function cardSizes(s) {
  return {
    padX: scaled(16, s, 12), padTop: scaled(14, s, 11), headGap: scaled(12, s, 8),
    headline: 25, headlineMin: 15,
    ident: scaled(14, s, 13), meta: 13,
    timerPad: `${scaled(8, s, 6)}px ${scaled(12, s, 8)}px`, timerLabel: 10, timerValue: scaled(26, s, 20),
    badge: 12, badgePad: `${scaled(4, s, 3)}px ${scaled(9, s, 7)}px`,
    course: 12,
    bodyGap: scaled(9, s, 7), lineGap: scaled(11, s, 8),
    chip: scaled(30, s, 26), chipFont: scaled(17, s, 15), chipPad: scaled(7, s, 5),
    item: 19, itemMin: 14, mods: 15, allergen: 13,
    note: 15, notePad: `${scaled(8, s, 6)}px ${scaled(11, s, 8)}px`,
    footPad: scaled(12, s, 9),
  };
}
const MODAL = {
  headline: 46, headlineMin: 26, ident: 20, meta: 17, badge: 15, course: 15,
  timerPad: '14px 22px', timerLabel: 12, timerValue: 44,
  chip: 52, chipFont: 28, chipPad: 12, lineGap: 18,
  item: 30, itemMin: 18, mods: 23, allergen: 19, note: 20, notePad: '14px 18px',
};

/** Accent for the top bar and course chip: the type colour, or the time status colour. */
function accentOf(view, st, settings) {
  return settings.colour === 'status' ? st.c : view.type.c;
}

function Badge({ view, font, pad }) {
  const c = view.type.c;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', borderRadius: 6, padding: pad,
      font: `700 ${font}px ${MONO}`, letterSpacing: '.1em', color: c, background: `${c}1F`,
    }}>{view.type.label}</span>
  );
}

function TimerBlock({ label, value, colour, bg, pad, labelPx, valuePx, pulse = false }) {
  return (
    <div style={{
      flex: 'none', textAlign: 'center', borderRadius: 11, padding: pad,
      color: colour, background: bg, animation: pulse ? LATE_PULSE : 'none',
    }}>
      <div style={{ font: `700 ${labelPx}px ${MONO}`, letterSpacing: '.12em', opacity: 0.85, whiteSpace: 'nowrap' }}>{label}</div>
      {value != null && <div style={{ font: `700 ${valuePx}px/1 ${MONO}`, marginTop: 2, whiteSpace: 'nowrap' }}>{value}</div>}
    </div>
  );
}

function CourseChip({ label, accent, font, big = false }) {
  return (
    <div style={{
      alignSelf: 'flex-start', border: `1px solid ${accent}66`, color: accent, borderRadius: 7,
      padding: big ? '6px 12px' : '4px 10px', font: `700 ${font}px ${MONO}`, letterSpacing: '.08em',
    }}>{label}</div>
  );
}

/** Tick one item as made. At least a 44px touch area around a box the size of the qty chip. */
function TickBox({ ticked, onTick, size, big, disabled = false }) {
  const pad = Math.max(0, Math.ceil((44 - size) / 2));
  return (
    <button type="button" disabled={disabled}
      aria-label={ticked ? 'Item done' : 'Mark item done'}
      onClick={(e) => { e.stopPropagation(); if (!ticked && !disabled) onTick(); }}
      style={{
        flex: 'none', appearance: 'none', background: 'transparent', border: 0, padding: pad, margin: -pad,
        cursor: ticked || disabled ? 'default' : 'pointer', display: 'flex',
      }}>
      <span style={{
        width: size, height: size, borderRadius: big ? 14 : 9, display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: `1.5px solid ${ticked ? C.bump : 'rgba(255,255,255,.22)'}`,
        background: ticked ? C.bump : 'transparent', color: C.bumpInk,
        font: `900 ${Math.round(size * 0.56)}px ${SANS}`,
      }}>{ticked ? '✓' : ''}</span>
    </button>
  );
}

function LineRow({ line, big, z, onTick, canTick, showTick }) {
  const done = line.bumped;
  return (
    <div style={{
      display: 'flex', gap: z.lineGap, alignItems: 'flex-start', width: '100%',
      opacity: done ? 0.35 : 1,
      ...(big ? { paddingBottom: 16, borderBottom: `1px solid ${C.row}` } : null),
    }}>
      {showTick && <TickBox ticked={done} onTick={onTick} size={z.chip} big={big} disabled={!canTick} />}
      <span style={{
        flex: 'none', minWidth: z.chip, height: z.chip, padding: `0 ${z.chipPad}px`,
        borderRadius: big ? 14 : 9, background: big ? 'rgba(255,255,255,.09)' : 'rgba(255,255,255,.08)', color: '#fff',
        font: `700 ${z.chipFont}px ${MONO}`, display: 'flex', alignItems: 'center', justifyContent: 'center',
        textDecoration: done ? 'line-through' : 'none',
      }}>{line.qty}</span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: big ? 6 : 3 }}>
        <FitText text={line.name} maxPx={z.item} minPx={z.itemMin} weight={big ? 800 : 700}
          style={{ lineHeight: big ? 1.15 : 1.2, color: big ? '#fff' : C.item, textDecoration: done ? 'line-through' : 'none' }} />
        {line.mods.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: big ? 3 : 2 }}>
            {line.mods.map((m, i) => (
              <div key={i} style={{ font: `600 ${z.mods}px/${big ? 1.25 : 1.3} ${SANS}`, color: C.mods, overflowWrap: 'anywhere' }}>{m}</div>
            ))}
          </div>
        )}
        {line.allergen && (
          <div style={{ font: `700 ${z.allergen}px ${MONO}`, letterSpacing: big ? 0 : '.06em', color: C.allergen, overflowWrap: 'anywhere' }}>⚠ {line.allergen}</div>
        )}
      </div>
    </div>
  );
}

function NoteBlock({ note, big, z }) {
  return (
    <div style={{
      width: '100%', borderLeft: `${big ? 4 : 3}px solid ${C.allergen}`,
      background: big ? 'rgba(255,196,107,.1)' : 'rgba(255,196,107,.09)',
      padding: z.notePad, borderRadius: big ? '0 10px 10px 0' : '0 8px 8px 0',
      font: `${big ? 700 : 600} ${z.note}px ${SANS}`, color: C.note, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
      textAlign: 'left',
    }}>{note}</div>
  );
}

/**
 * "Till 2  |  #43". Each segment stays in one piece ("#CA-5BEPG" must never split);
 * a narrow card wraps between segments instead.
 */
function Identity({ parts, font }) {
  // The pipe travels with the segment before it ("Deliveroo  |"), so a wrapped line
  // starts with the number, never with a stray pipe. Two no-break spaces each side.
  const last = parts.length - 1;
  return (
    <span style={{ font: `700 ${font}px ${MONO}`, color: C.ident, letterSpacing: '.02em', minWidth: 0 }}>
      {parts.map((p, i) => (
        <span key={i}>
          <span style={{ display: 'inline-block', maxWidth: '100%', overflowWrap: 'anywhere' }}>
            {i < last ? `${p}\u00a0\u00a0|\u00a0` : p}
          </span>
          {i < last ? ' ' : null}
        </span>
      ))}
    </span>
  );
}

/** Shared by card and pop out: identity, and the covers / staff line. */
function headParts(view, settings) {
  const show = settings.show;
  const ident = identityParts(view.meta, view.headline, { showSource: show.source });
  const meta = [show.covers ? view.coversLabel : null, show.staff ? view.staff : null].filter(Boolean).join(' · ');
  return { ident, meta };
}

function timerProps(view, mins, settings, mode) {
  if (mode === 'history') {
    return { label: 'BUMPED', value: view.bumpedLabel || null, colour: C.ident, bg: 'rgba(255,255,255,.07)', pulse: false };
  }
  if (view.held) return { label: HELD_TIMER.label, value: formatElapsed(mins), colour: HELD_TIMER.c, bg: HELD_TIMER.bg, pulse: false };
  const st = statusOf(mins, settings.caution, settings.late);
  return { label: st.label, value: formatElapsed(mins), colour: st.c, bg: st.bg, pulse: st.key === 'late' };
}

/**
 * One card on the board.
 *   mode  'live' (Bump + Hold) or 'history' (Recall)
 *   scale 1 at the design card width, smaller on narrow columns
 */
export const KdsTicketCard = memo(function KdsTicketCard({ view, mins, settings, scale = 1, mode = 'live', onOpen, onBump, onHold, onResume, onBumpItem, onRecall }) {
  const show = settings.show;
  const compact = settings.density === 'compact';
  const z = cardSizes(scale);
  const st = statusOf(mins, settings.caution, settings.late);
  const accent = accentOf(view, st, settings);
  const held = mode === 'live' && view.held;
  const late = mode === 'live' && !held && st.key === 'late';
  const { ident, meta } = headParts(view, settings);
  const timer = timerProps(view, mins, settings, mode);
  const canTick = mode === 'live' && !held;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', background: C.card, borderRadius: 16, overflow: 'hidden',
      border: late ? '1.5px solid rgba(255,107,107,.33)' : `1px solid ${held ? 'rgba(255,255,255,.22)' : C.line}`,
      boxShadow: late ? '0 0 24px rgba(255,107,107,.2)' : 'none',
      opacity: held ? 0.55 : 1, paddingBottom: compact ? 0 : 2, minWidth: 0,
    }}>
      <div style={{ height: 5, background: accent, flex: 'none' }} />

      <div onClick={() => onOpen(view.id)} style={{ cursor: 'pointer', padding: `${z.padTop}px ${z.padX}px 0`, display: 'flex', alignItems: 'flex-start', gap: z.headGap }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Badge view={view} font={z.badge} pad={z.badgePad} />
            {ident.length > 0 && <Identity parts={ident} font={z.ident} />}
          </div>
          {show.name && (
            <FitText text={view.headline} maxPx={z.headline} minPx={z.headlineMin} weight={800}
              style={{ lineHeight: 1.12, letterSpacing: '-.01em', textWrap: 'pretty' }} />
          )}
          {meta && <div style={{ font: `400 ${z.meta}px/1.5 ${MONO}`, color: C.meta2, overflowWrap: 'anywhere' }}>{meta}</div>}
        </div>
        {show.timer && <TimerBlock {...timer} pad={z.timerPad} labelPx={z.timerLabel} valuePx={z.timerValue} />}
      </div>

      <div role="button" tabIndex={0} onClick={() => onOpen(view.id)}
        onKeyDown={(e) => {
          // Only when the body itself has focus: Enter on a focused tick box must tick it.
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(view.id); }
        }}
        style={{ cursor: 'pointer', padding: `${z.padTop}px ${z.padX}px ${z.footPad}px`, display: 'flex', flexDirection: 'column', gap: z.bodyGap, width: '100%', textAlign: 'left' }}>
        {view.groups.map(g => (
          <div key={g.course} style={{ display: 'flex', flexDirection: 'column', gap: z.bodyGap }}>
            {show.course && <CourseChip label={g.label} accent={accent} font={z.course} />}
            {g.lines.map(l => (
              <LineRow key={l.index} line={l} big={false} z={z} canTick={canTick} showTick={mode === 'live'} onTick={() => onBumpItem(view.id, l.index)} />
            ))}
          </div>
        ))}
        {show.notes && view.note && <NoteBlock note={view.note} big={false} z={z} />}
      </div>

      <div style={{ marginTop: 'auto', padding: `0 ${z.footPad}px ${z.footPad}px`, display: 'flex', gap: 8 }}>
        {mode === 'history' ? (
          <button type="button" onClick={() => onRecall(view.id)} style={bumpStyle(compact, scale)}>↺ Recall</button>
        ) : (
          <>
            <button type="button" onClick={() => onBump(view.id)} style={bumpStyle(compact, scale)}>Bump ✓</button>
            <button type="button" className="kds-hold" aria-label={held ? 'Resume' : 'Hold'} onClick={() => (held ? onResume(view.id) : onHold(view.id))}
              style={{
                flex: 'none', width: scaled(52, scale, 44), minHeight: 44, border: '1px solid rgba(255,255,255,.16)', background: 'rgba(255,255,255,.05)',
                color: C.ghost, borderRadius: 12, font: `700 16px ${SANS}`, cursor: 'pointer',
              }}>{held ? '▶' : '❚❚'}</button>
          </>
        )}
      </div>
    </div>
  );
});

/** Bump keeps the design's 52px (44px compact) height at every scale: it is the main touch target. */
function bumpStyle(compact, scale) {
  return {
    flex: 1, border: 0, background: C.bump, color: C.bumpInk, borderRadius: 12,
    height: compact ? 44 : 52, font: `800 ${compact ? scaled(17, scale, 15) : scaled(19, scale, 16)}px ${SANS}`, cursor: 'pointer',
  };
}

const modalGhost = {
  border: '1px solid rgba(255,255,255,.18)', background: 'transparent', color: C.ghost, borderRadius: 14,
  padding: '0 28px', height: 64, font: `700 20px ${SANS}`, cursor: 'pointer',
};

const modalBump = {
  border: 0, background: C.bump, color: C.bumpInk, borderRadius: 14, padding: '0 56px', height: 64,
  font: `800 24px ${SANS}`, cursor: 'pointer',
};

/** The expanded ticket in the centre of the screen, always at the design's big sizes. */
export function KdsTicketModal({ view, mins, settings, mode = 'live', onClose, onBump, onHold, onResume, onBumpItem, onRecall }) {
  const show = settings.show;
  const z = MODAL;
  const st = statusOf(mins, settings.caution, settings.late);
  const accent = accentOf(view, st, settings);
  const held = mode === 'live' && view.held;
  const { ident, meta } = headParts(view, settings);
  const timer = timerProps(view, mins, settings, mode);
  const canTick = mode === 'live' && !held;

  return (
    <div onClick={onClose} style={{
      position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, background: 'rgba(6,8,7,.72)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 44, zIndex: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" style={{
        width: 1040, maxWidth: '100%', maxHeight: '100%', background: C.modal, border: `1px solid ${C.modalEdge}`,
        borderRadius: 22, overflow: 'hidden', display: 'flex', flexDirection: 'column',
        boxShadow: '0 40px 90px rgba(0,0,0,.6)', animation: 'kdsKfade .16s ease',
      }}>
        <div style={{ height: 8, background: accent, flex: 'none' }} />
        <div style={{ padding: '26px 32px 22px', display: 'flex', alignItems: 'flex-start', gap: 24, borderBottom: `1px solid ${C.line}`, flex: 'none' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Badge view={view} font={z.badge} pad="4px 9px" />
              {ident.length > 0 && <Identity parts={ident} font={z.ident} />}
            </div>
            <FitText text={view.headline} maxPx={z.headline} minPx={z.headlineMin} weight={800}
              style={{ lineHeight: 1.05, letterSpacing: '-.02em', color: '#fff' }} />
            {meta && <div style={{ font: `400 ${z.meta}px ${MONO}`, color: C.meta1, overflowWrap: 'anywhere' }}>{meta}</div>}
          </div>
          {show.timer && <TimerBlock {...timer} pad={z.timerPad} labelPx={z.timerLabel} valuePx={z.timerValue} />}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '22px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {show.notes && view.note && <NoteBlock note={view.note} big z={z} />}
          {view.groups.map(g => (
            <div key={g.course} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {show.course && <CourseChip label={g.label} accent={accent} font={z.course} big />}
              {g.lines.map(l => (
                <LineRow key={l.index} line={l} big z={z} canTick={canTick} showTick={mode === 'live'} onTick={() => onBumpItem(view.id, l.index)} />
              ))}
            </div>
          ))}
        </div>

        <div style={{ flex: 'none', padding: '18px 26px', display: 'flex', gap: 12, flexWrap: 'wrap', borderTop: `1px solid ${C.line}`, background: 'rgba(255,255,255,.02)' }}>
          <button type="button" className="kds-ghost" onClick={onClose} style={modalGhost}>Close</button>
          {mode === 'live' && (
            <button type="button" className="kds-ghost" onClick={() => (held ? onResume(view.id) : onHold(view.id))} style={modalGhost}>{held ? 'Resume' : 'Hold'}</button>
          )}
          <div style={{ flex: 1 }} />
          {mode === 'history' ? (
            <button type="button" className="kds-bump-lg" onClick={() => onRecall(view.id)} style={modalBump}>↺ Recall</button>
          ) : (
            <button type="button" className="kds-bump-lg" onClick={() => onBump(view.id)} style={modalBump}>Bump order ✓</button>
          )}
        </div>
      </div>
    </div>
  );
}
