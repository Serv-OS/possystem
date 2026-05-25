// src/components/ServOSBrand.jsx
// Shared ServOS brand mark, icon, and wordmark components.
// Follows brand guidelines v1.0 — Ember (#E8743C), Instrument Serif wordmark.

/**
 * ServOS icon mark — the stylised S/OS path in an ember rounded-square.
 * @param {object} props
 * @param {number} [props.size=44] — pixel width/height
 * @param {string} [props.variant='ember'] — 'ember' | 'paper' | 'outline'
 */
export function ServOSIcon({ size = 44, variant = 'ember', style = {} }) {
  const fill = variant === 'paper' ? '#F4EDDF'
    : variant === 'outline' ? 'none'
    : '#E8743C';
  const stroke = variant === 'outline' ? '#0E0D0A' : undefined;
  return (
    <svg viewBox="0 0 80 80" width={size} height={size} style={style}>
      <rect x="4" y="4" width="72" height="72" rx="14" fill={fill}
        {...(stroke ? { stroke, strokeWidth: 3 } : {})} />
      <path
        d="M22 25 Q22 20 27 20 L53 20 Q58 20 58 25 L58 36 Q58 40 54 40 L26 40 Q22 40 22 44 L22 55 Q22 60 27 60 L53 60 Q58 60 58 55"
        fill="none" stroke="#0E0D0A" strokeWidth="6" strokeLinecap="square"
      />
    </svg>
  );
}

/**
 * ServOS wordmark — "Serv" in current color + "OS" in ember italic.
 * Uses Instrument Serif (loaded via Google Fonts in index.html).
 * @param {object} props
 * @param {number} [props.fontSize=22] — base font size
 * @param {string} [props.color] — color for "Serv" (defaults to --t1)
 */
export function ServOSWordmark({ fontSize = 22, color, style = {} }) {
  return (
    <span style={{
      fontFamily: 'inherit',
      fontSize,
      fontWeight: 800,
      lineHeight: 0.95,
      letterSpacing: '-0.02em',
      color: color || 'var(--t1)',
      ...style,
    }}>
      Serv<span style={{ color: '#E8743C' }}>OS</span>
    </span>
  );
}

/**
 * Full ServOS lockup — icon + wordmark side by side.
 * @param {object} props
 * @param {number} [props.iconSize=44] — icon pixel size
 * @param {number} [props.fontSize=22] — wordmark font size
 * @param {string} [props.color] — wordmark "Serv" color
 * @param {number} [props.gap=12] — gap between icon and wordmark
 */
export function ServOSLockup({ iconSize = 44, fontSize = 22, color, gap = 12, style = {} }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap, ...style }}>
      <ServOSIcon size={iconSize} />
      <ServOSWordmark fontSize={fontSize} color={color} />
    </div>
  );
}
