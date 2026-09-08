// src/components/ServOSBrand.jsx
// Shared ServOS brand mark — the new "liquid glass" brand.
//
// The official logo SVGs (in /public/brand) are TEXT-based: they reference the
// Syne / Space Grotesk fonts by name with no embedded outlines, so rendering
// them through <img> falls back to a default font and looks wrong. We therefore
// render the mark inline in those exact brand fonts (loaded in index.html) —
// identical letterforms to the artwork, theme-aware (currentColor → --t1),
// and crisp at any size. This mirrors how the ServOS reference HTML renders it.
//   • Icon / monogram : Syne 800 "S" + Signal-green dot
//   • Wordmark        : Space Grotesk 600 "Serv" + green "OS" + green dot
const GREEN = '#15C26A';
const GREEN_GLOW = '#46E08C';

function Dot({ glow = false }) {
  return (
    <span style={{
      display: 'inline-block', width: '0.17em', height: '0.17em', borderRadius: '50%',
      background: GREEN, marginLeft: '0.06em', verticalAlign: 'baseline',
      ...(glow ? { boxShadow: `0 0 8px ${GREEN_GLOW}` } : {}),
    }} />
  );
}

/**
 * ServOS icon / monogram — the Syne "S" + green dot. For compact spaces & tiles.
 * @param {number} [props.size=44] cap height in px
 */
export function ServOSIcon({ size = 44, style = {} }) {
  return (
    <span role="img" aria-label="ServOS" style={{
      display: 'inline-flex', alignItems: 'baseline', whiteSpace: 'nowrap',
      fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: size,
      lineHeight: 0.78, letterSpacing: '-0.02em', color: 'var(--t1)', ...style,
    }}>
      S<Dot glow />
    </span>
  );
}

/**
 * ServOS wordmark — Space Grotesk "Serv" + green "OS" + green dot.
 * `color` overrides the "Serv" colour (defaults to themed --t1).
 * @param {number} [props.fontSize=22]
 */
export function ServOSWordmark({ fontSize = 22, color, style = {} }) {
  return (
    <span role="img" aria-label="ServOS" style={{
      display: 'inline-flex', alignItems: 'baseline', whiteSpace: 'nowrap',
      fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize,
      letterSpacing: '-0.03em', color: color || 'var(--t1)', ...style,
    }}>
      Serv<span style={{ color: 'var(--signal-glow, #46E08C)' }}>OS</span><Dot />
    </span>
  );
}

/** Full lockup — icon + wordmark side by side. */
export function ServOSLockup({ iconSize = 32, fontSize = 22, color, gap = 12, style = {} }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap, ...style }}>
      <ServOSIcon size={iconSize} />
      <ServOSWordmark fontSize={fontSize} color={color} />
    </div>
  );
}
