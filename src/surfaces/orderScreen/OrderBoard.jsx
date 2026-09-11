// src/surfaces/orderScreen/OrderBoard.jsx
//
// Order screen: the presentational board. Pure props, no Supabase. The TV
// (OrderStatusScreen, mode="screen") and the Back Office preview (OrderScreens.jsx,
// mode="preview") both draw with it, so the preview is exactly what the TV shows.
//
// Sizing works from S, the short side of the stage in px. The list never scrolls:
// layoutSection shrinks the row font, then adds a column, then pages every 8 seconds
// on server corrected time so several TVs turn their pages together. Ready rows sort
// first, so page 1 always shows Ready.
//
// Props: { display (normaliseDisplay shape), venueName, rows (row shape, sorted),
//          nowMs (server corrected), tz (venue zone), lastUpdatedMs, offline,
//          justReady (Set of keys), mode: 'screen' | 'preview' }

import { useLayoutEffect, useRef, useState } from 'react';
import {
  channelLabel, courierLabel, DEFAULT_LABELS, DEFAULT_SETTINGS, DEFAULT_THEME,
} from '../../lib/orderScreen/orderScreenStatus';
import {
  stageSize, splitSectionHeights, layoutSection, pageIndexAt, formatVenueTime, deriveBoardTheme,
} from '../../lib/orderScreen/orderScreenLayout';

const FONT_STACK = "'Space Grotesk', 'Plus Jakarta Sans', system-ui, sans-serif";
const EMPTY_SET = new Set();
const PAGE_MS = 8000;
const CHAR_EM = 0.66; // rough width of an upper case Space Grotesk bold character

// Ready rows pulse 3 times over 1.2 s. Skipped for prefers-reduced-motion.
const BOARD_CSS = `
@keyframes osdPulse { 0%, 100% { filter: none; } 50% { filter: brightness(1.45); } }
.osd-pulse { animation: osdPulse 0.4s ease-in-out 3; }
@media (prefers-reduced-motion: reduce) { .osd-pulse { animation: none; } }
`;

const ellipsis = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 };

// Measures one line of board text in px with a canvas. Null where there is no canvas
// (node tests), and then callers keep their default layout.
let measureCtx;
function textWidth(text, px, weight, uppercase) {
  if (measureCtx === undefined) {
    try { measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null; } catch { measureCtx = null; }
  }
  if (!measureCtx) return null;
  measureCtx.font = `${weight} ${px}px ${FONT_STACK}`;
  const s = String(text || '');
  return measureCtx.measureText(uppercase ? s.toUpperCase() : s).width;
}

// Shrinks a single line of text so it fits `width`, between `max` and `min` px.
function fitText(text, width, max, min, uppercase) {
  const chars = Math.max(1, Array.from(String(text || '')).length);
  const em = uppercase ? CHAR_EM : CHAR_EM * 0.88;
  return Math.max(min, Math.min(max, width / (chars * em)));
}

// Fixed heights above a section's list, in px. Shared by the height split and the section.
function sectionChrome(S, subtitle) {
  const padTop = 0.022 * S;
  const padBottom = 0.012 * S;
  const titleH = 0.05 * S * 1.25;
  const subH = subtitle ? 0.03 * S * 1.35 : 0;
  const gapH = 0.012 * S;
  const headsH = 0.024 * S * 1.8;
  return { padTop, padBottom, titleH, subH, gapH, headsH, total: padTop + padBottom + titleH + subH + gapH + headsH };
}

function useBoxSize(ref, mode) {
  const [size, setSize] = useState(() => (
    mode === 'screen' && typeof window !== 'undefined'
      ? { w: window.innerWidth || 0, h: window.innerHeight || 0 }
      : { w: 0, h: 0 }
  ));
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const w = Math.round(el.clientWidth || 0);
      const h = Math.round(el.clientHeight || 0);
      setSize((p) => (p.w === w && p.h === h ? p : { w, h }));
    };
    let ro = null;
    try {
      if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(measure); ro.observe(el); }
    } catch { ro = null; }
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(measure) : null;
    window.addEventListener('resize', measure);
    const vv = window.visualViewport;
    if (vv) vv.addEventListener('resize', measure);
    // TV browsers can report their final viewport only after first paint.
    const timers = [setTimeout(measure, 400), setTimeout(measure, 1500)];
    return () => {
      if (ro) { try { ro.disconnect(); } catch { /* already gone */ } }
      if (raf != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      if (vv) vv.removeEventListener('resize', measure);
      timers.forEach(clearTimeout);
    };
  }, [ref]);
  return size;
}

export default function OrderBoard({
  display, venueName = '', rows = [], nowMs, tz, lastUpdatedMs = null,
  offline = false, justReady = EMPTY_SET, mode = 'screen',
}) {
  const rootRef = useRef(null);
  const { w: vw, h: vh } = useBoxSize(rootRef, mode);
  // Real logo width over height, so the header text only gives up the room the logo needs.
  const [logoRatio, setLogoRatio] = useState(1);
  const onLogoLoad = (e) => {
    const img = e.currentTarget;
    const r = (img?.naturalWidth || 0) / Math.max(1, img?.naturalHeight || 0);
    if (Number.isFinite(r) && r > 0) setLogoRatio((p) => (Math.abs(p - r) < 0.01 ? p : r));
  };

  const d = display || {};
  const theme = deriveBoardTheme({ ...DEFAULT_THEME, ...(d.theme || {}) }, DEFAULT_THEME);
  const labels = { ...DEFAULT_LABELS, ...(d.labels || {}) };
  const settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
  const sections = Array.isArray(d.sections) ? d.sections : [];
  const isPreview = mode === 'preview';

  const rootStyle = {
    position: isPreview ? 'absolute' : 'fixed', inset: 0, overflow: 'hidden',
    background: theme.bg, color: theme.text, fontFamily: FONT_STACK,
  };
  if (!vw || !vh) return <div ref={rootRef} style={rootStyle} />;

  const stage = stageSize({ vw, vh, orientation: d.orientation, rotate: isPreview ? 0 : d.rotate });
  const S = Math.min(stage.w, stage.h);
  const portrait = d.orientation !== 'landscape';
  const upper = theme.uppercase !== false;
  const now = Number.isFinite(nowMs) ? nowMs : (Number.isFinite(lastUpdatedMs) ? lastUpdatedMs : 0);
  const readySet = justReady instanceof Set ? justReady : EMPTY_SET;

  const headerH = Math.round(0.13 * S);
  const stripH = offline ? Math.round(0.05 * S) : 0;
  const footerH = Math.round(0.05 * S);
  const bodyH = Math.max(0, stage.h - headerH - stripH - footerH);

  // Rows per section, in the order the feed sorted them.
  const bySection = sections.map(() => []);
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r && Number.isInteger(r.sectionIndex) && r.sectionIndex >= 0 && r.sectionIndex < bySection.length) {
      bySection[r.sectionIndex].push(r);
    }
  }
  const counts = bySection.map((list) => list.length);
  const n = sections.length;
  // Portrait: each section first gets room for up to 4 rows at the floor font (never less
  // than 0.22S), so a short delivery list never pages while a busy section fills the rest.
  const minHeights = sections.map((sec, i) => Math.max(
    0.22 * S,
    sectionChrome(S, sec.subtitle).total + Math.min(counts[i], 4) * 0.03 * S * 1.9 + 2,
  ));
  const heights = portrait
    ? splitSectionHeights(bodyH, counts, minHeights)
    : sections.map(() => bodyH);
  const widths = portrait
    ? sections.map(() => stage.w)
    : sections.map((_, i) => (i < n - 1 ? Math.floor(stage.w / n) : stage.w - Math.floor(stage.w / n) * (n - 1)));
  const maxColumns = portrait ? 2 : (n <= 2 ? 2 : 1);

  // Header text: shrink to fit between the logos.
  const logo = theme.logoUrl || '';
  const headerPadX = 0.03 * S;
  const logoMaxW = 0.2 * S;
  const headerText = settings.headerText || venueName || '';
  const logoW = Math.min(logoMaxW, 0.09 * S * logoRatio);
  const headerTextW = stage.w - 2 * headerPadX - (logo ? 2 * (logoW + 0.03 * S) : 0);
  const headerFont = fitText(headerText, headerTextW, 0.055 * S, 0.03 * S, upper);

  const footerText = isPreview
    ? 'Preview'
    : [
      Number.isFinite(lastUpdatedMs) ? `Last updated at ${formatVenueTime(lastUpdatedMs, tz, { date: true })}` : null,
      now ? `Current time: ${formatVenueTime(now, tz)}` : null,
    ].filter(Boolean).join('  |  ');

  return (
    <div ref={rootRef} style={rootStyle}>
      <style>{BOARD_CSS}</style>
      <div
        role="region"
        aria-label={headerText || 'Order screen'}
        style={{
          position: 'absolute', left: '50%', top: '50%', width: stage.w, height: stage.h,
          transform: stage.transform, transformOrigin: 'center center',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          background: theme.bg, color: theme.text, fontFamily: FONT_STACK,
          textTransform: upper ? 'uppercase' : 'none',
        }}
      >
        {/* Header */}
        <div style={{
          flex: `0 0 ${headerH}px`, height: headerH, background: theme.headerBg, color: theme.headerText,
          display: 'flex', alignItems: 'center', gap: 0.03 * S, padding: `0 ${headerPadX}px`, boxSizing: 'border-box',
        }}>
          {logo && <img src={logo} alt={venueName || ''} onLoad={onLogoLoad} style={{ height: 0.09 * S, maxWidth: logoMaxW, objectFit: 'contain', flex: '0 0 auto' }} />}
          <div style={{ flex: '1 1 0', textAlign: 'center', fontSize: headerFont, fontWeight: 700, letterSpacing: '.02em', lineHeight: 1.1, ...ellipsis }}>
            {headerText}
          </div>
          {logo && <img src={logo} alt="" onLoad={onLogoLoad} style={{ height: 0.09 * S, maxWidth: logoMaxW, objectFit: 'contain', flex: '0 0 auto' }} />}
        </div>

        {/* Offline strip */}
        {offline && (
          <div role="status" style={{
            flex: `0 0 ${stripH}px`, height: stripH, background: '#7f1d1d', color: '#FFFFFF',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 0.026 * S,
            fontWeight: 600, textTransform: 'none', padding: `0 ${0.03 * S}px`, boxSizing: 'border-box', ...ellipsis,
          }}>
            Connection lost. Trying again. Orders shown may be out of date.
          </div>
        )}

        {/* Sections */}
        <div style={{ flex: `0 0 ${bodyH}px`, height: bodyH, display: 'flex', flexDirection: portrait ? 'column' : 'row', overflow: 'hidden' }}>
          {sections.map((sec, i) => (
            <BoardSection
              key={sec.id || i}
              sec={sec}
              index={i}
              rows={bySection[i]}
              width={widths[i]}
              height={heights[i] || 0}
              S={S}
              portrait={portrait}
              maxColumns={maxColumns}
              theme={theme}
              labels={labels}
              upper={upper}
              now={now}
              readySet={readySet}
            />
          ))}
        </div>

        {/* Footer */}
        <div style={{
          flex: `0 0 ${footerH}px`, height: footerH, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 0.024 * S, color: theme.muted, textTransform: 'none', whiteSpace: 'pre',
          borderTop: `1px solid ${theme.muted}33`, padding: `0 ${0.03 * S}px`, boxSizing: 'border-box', overflow: 'hidden',
        }}>
          {footerText}
        </div>
      </div>
    </div>
  );
}

function BoardSection({ sec, index, rows, width, height, S, portrait, maxColumns, theme, labels, upper, now, readySet }) {
  const padX = 0.035 * S;
  const subtitle = sec.subtitle || '';
  const { padTop, padBottom, titleH, subH, gapH, headsH, total: chromeH } = sectionChrome(S, subtitle);
  const innerW = Math.max(0, width - 2 * padX);
  const listH = Math.max(0, height - chromeH);

  // Widest row this section can draw, in em of the row font: status pill, name or code with
  // its number badge, channel chip, gaps. A second column only opens when this fits, so a
  // driver's code or a customer's name is never cut to a few letters.
  const pillChars = Math.max(...(sec.statuses || []).concat('collected').map((b) => Array.from(String(labels[b] || '')).length), 6);
  const pillEm = 0.72 * (pillChars * CHAR_EM + 1.8);
  const nameEm = sec.nameFormat === 'number' ? 6 * CHAR_EM : 10 * CHAR_EM + 2.4;
  const chipEm = sec.showChannel !== false ? 0.55 * (8 * CHAR_EM + 1.2) : 0;
  const minColumnEm = Math.max(14, pillEm + nameEm + chipEm + 2);
  const lay = layoutSection({ count: rows.length, boxW: innerW, listH, S, maxColumns, minColumnEm });
  const page = pageIndexAt(now, lay.pages, PAGE_MS);
  const pageRows = lay.pages > 1 ? rows.slice(page * lay.perPage, (page + 1) * lay.perPage) : rows;
  const columns = [];
  for (let c = 0; c < lay.columns; c++) {
    columns.push(lay.pages > 1 || lay.columns > 1
      ? pageRows.slice(c * lay.perColumn, (c + 1) * lay.perColumn)
      : pageRows);
  }
  const pageLabel = lay.pages > 1 ? `Page ${page + 1} of ${lay.pages}` : '';
  const pageFont = 0.03 * S;
  const pageW = pageLabel ? pageLabel.length * pageFont * CHAR_EM + 0.02 * S : 0;
  const title = sec.title || '';
  const titleFont = fitText(title, innerW - pageW, 0.05 * S, 0.03 * S, upper);
  const subFont = fitText(subtitle, innerW, 0.03 * S, 0.02 * S, upper);
  const firstHead = sec.nameFormat === 'number' ? 'Order' : 'Name';
  const colGap = lay.columns > 1 ? 0.03 * S : 0;
  // One column's width in px, so each row can check what fits before it draws.
  const colW = Math.max(0, (innerW - colGap * (lay.columns - 1)) / Math.max(1, lay.columns));

  return (
    <section style={{
      flex: `0 0 ${portrait ? height : width}px`, width, height, boxSizing: 'border-box',
      padding: `${padTop}px ${padX}px ${padBottom}px`, overflow: 'hidden',
      borderTop: portrait && index > 0 ? `1px solid ${theme.muted}40` : 'none',
      borderLeft: !portrait && index > 0 ? `1px solid ${theme.muted}40` : 'none',
    }}>
      <div style={{ height: titleH, display: 'flex', alignItems: 'center', gap: 0.02 * S }}>
        <div style={{ flex: '1 1 0', fontSize: titleFont, fontWeight: 700, lineHeight: 1.15, ...ellipsis }}>{title}</div>
        {pageLabel && <div style={{ flex: '0 0 auto', fontSize: pageFont, color: theme.muted, textTransform: 'none', whiteSpace: 'nowrap' }}>{pageLabel}</div>}
      </div>
      {subtitle && (
        <div style={{ height: subH, display: 'flex', alignItems: 'center', fontSize: subFont, color: theme.muted, ...ellipsis }}>
          {subtitle}
        </div>
      )}
      <div style={{ height: gapH }} />
      <div style={{ height: headsH, display: 'flex', gap: colGap, alignItems: 'center' }}>
        {columns.map((_, c) => (
          <div key={c} style={{ flex: '1 1 0', minWidth: 0, display: 'flex', justifyContent: 'space-between', fontSize: 0.024 * S, color: theme.muted, letterSpacing: '.08em', padding: `0 ${0.4 * lay.font}px` }}>
            <span>{firstHead}</span>
            <span>Status</span>
          </div>
        ))}
      </div>
      <div style={{ height: listH, display: 'flex', gap: colGap, overflow: 'hidden' }}>
        {rows.length === 0 ? (
          <div style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 0.035 * S, color: theme.muted, textAlign: 'center' }}>
            No orders right now
          </div>
        ) : columns.map((colRows, c) => (
          <div key={c} style={{ flex: '1 1 0', minWidth: 0 }}>
            {colRows.map((row) => (
              <BoardRow key={row.key} row={row} sec={sec} font={lay.font} rowH={lay.rowH} width={colW} upper={upper} theme={theme} labels={labels} pulse={readySet.has(row.key)} />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function BoardRow({ row, sec, font, rowH, width, upper, theme, labels, pulse }) {
  const ready = row.bucket === 'ready';
  const collected = row.bucket === 'collected';
  const big = row.name || row.number || '';
  const showBadge = !!row.name && !!row.number;
  const courier = courierLabel(row.courier);
  const pill = labels[row.bucket] || '';
  let chip = sec.showChannel !== false
    ? [channelLabel(row), courier].filter(Boolean).join(' · ')
    : '';
  // A customer's name is never cut while the channel chip still shows. On a narrow column
  // (a landscape TV with 3 sections) the chip goes first. Rows showing only a code keep
  // their chip, because drivers need the app name.
  if (chip && row.name && width > 0) {
    const nameW = textWidth(big, font, 700, upper);
    const badgeW = showBadge ? textWidth(row.number, 0.8 * font, 600, upper) : 0;
    const chipW = textWidth(chip, 0.55 * font, 600, upper);
    const pillW = textWidth(pill, 0.72 * font, ready ? 700 : 600, upper);
    if (nameW != null && badgeW != null && chipW != null && pillW != null) {
      const chipBox = chipW + 0.55 * font * (Array.from(chip).length * 0.04 + 1.2 + 0.2);
      const pillBox = pillW + 0.72 * font * (1.8 + 0.16);
      const gaps = (showBadge ? 4 : 3) * 0.4 * font;
      if (0.8 * font + nameW + badgeW + chipBox + pillBox + gaps > width) chip = '';
    }
  }

  const pillStyle = ready
    ? { background: theme.readyBg, color: theme.readyText, fontWeight: 700, border: `0.08em solid ${theme.readyBg}` }
    : collected
      // Page text colour, never the pill text colour: on a light page a white pill would vanish.
      ? { background: 'transparent', color: theme.text, fontWeight: 600, border: `0.08em solid ${theme.text}` }
      : { background: theme.pillBg, color: theme.pillText, fontWeight: 600, border: `0.08em solid ${theme.pillBg}` };

  return (
    <div style={{ height: rowH, display: 'flex', alignItems: 'center', opacity: collected ? 0.55 : 1 }}>
      <div
        className={pulse && ready ? 'osd-pulse' : undefined}
        style={{
          height: '86%', width: '100%', display: 'flex', alignItems: 'center', gap: '0.4em',
          fontSize: font, lineHeight: 1, padding: '0 0.4em', boxSizing: 'border-box', borderRadius: '0.25em',
          background: ready ? `${theme.readyBg}26` : 'transparent', whiteSpace: 'nowrap', minWidth: 0,
        }}
      >
        {/* A code (no name) never shrinks: drivers must read all of it. Names shrink last. */}
        <span style={{ fontWeight: 700, flex: row.name ? '0 1 auto' : '0 0 auto', ...ellipsis }}>{big}</span>
        {showBadge && (
          <span style={{ fontSize: '0.8em', fontWeight: 600, color: theme.muted, flex: '0 0 auto' }}>{row.number}</span>
        )}
        {chip && (
          <span style={{
            fontSize: '0.55em', fontWeight: 600, color: theme.muted, border: `0.1em solid ${theme.muted}66`,
            borderRadius: 999, padding: '.2em .6em', flex: '0 100 auto', letterSpacing: '.04em', ...ellipsis,
          }}>{chip}</span>
        )}
        <span style={{ flex: '1 1 0', minWidth: 0 }} />
        <span style={{
          fontSize: '0.72em', padding: '.25em .9em', borderRadius: 999, flex: '0 0 auto',
          whiteSpace: 'nowrap', lineHeight: 1.1, ...pillStyle,
        }}>{pill}</span>
      </div>
    </div>
  );
}
