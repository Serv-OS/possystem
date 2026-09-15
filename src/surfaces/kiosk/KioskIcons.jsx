/**
 * KioskIcons: line icons for the new kiosk design.
 *
 * The README draws cutlery, bag, card and tick as SVG line icons and uses glyph
 * characters (star, warning, tick, close, back arrow, chevron, delete) that it says
 * should become proper icons, because they render differently on each platform.
 * Every icon is decorative (aria-hidden): the button around it carries the label.
 * Sizes are design px.
 */

function Svg({ size = 26, color = 'currentColor', strokeWidth = 2, children, fill = 'none' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flex: 'none' }}
    >{children}</svg>
  );
}

/** Eat in (README 1: 92px, stroke 1.6). */
export function CutleryIcon(props) {
  return <Svg strokeWidth={1.6} {...props}><path d="M7 3v8a2 2 0 0 0 4 0V3M9 11v10M17 3c1.5 1.5 1.5 5 0 6.5V21" /></Svg>;
}

/** Take away (README 1: 92px, stroke 1.6). */
export function BagIcon(props) {
  return (
    <Svg strokeWidth={1.6} {...props}>
      <path d="M5 8h14l-1.4 12.2a1 1 0 0 1-1 .8H7.4a1 1 0 0 1-1-.8L5 8Z" />
      <path d="M8.5 8V6a3.5 3.5 0 0 1 7 0v2" />
    </Svg>
  );
}

/** Card reader target (README 7: 120px, stroke 1.5). */
export function CardIcon(props) {
  return <Svg strokeWidth={1.5} {...props}><rect x="2" y="5" width="20" height="14" rx="3" /><path d="M2 10h20M6 15h4" /></Svg>;
}

/** Tick (README 8: 96px white, stroke 2.4). */
export function TickIcon(props) {
  return <Svg strokeWidth={2.4} {...props}><path d="M4 12.5 9.5 18 20 6.5" /></Svg>;
}

// One star everywhere (rewards and points): mosaic yellow with a warm outline. A caller can
// still pass color to paint it one colour.
export function StarIcon({ color = null, ...props }) {
  return (
    <Svg strokeWidth={1.2} color={color || '#8A6A1E'} fill={color || '#E9C84D'} {...props}>
      <path d="M12 3.2l2.7 5.5 6 .9-4.35 4.25 1.03 6-5.38-2.83-5.38 2.83 1.03-6L3.3 9.6l6-.9L12 3.2Z" />
    </Svg>
  );
}

export function WarningIcon(props) {
  return (
    <Svg strokeWidth={2} {...props}>
      <path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4.5M12 17h.01" />
    </Svg>
  );
}

export function CloseIcon(props) {
  return <Svg strokeWidth={2.2} {...props}><path d="M6 6l12 12M18 6 6 18" /></Svg>;
}

export function BackIcon(props) {
  return <Svg strokeWidth={2.2} {...props}><path d="M19 12H5M11 5l-7 7 7 7" /></Svg>;
}

export function ArrowRightIcon(props) {
  return <Svg strokeWidth={2.2} {...props}><path d="M5 12h14M13 5l7 7-7 7" /></Svg>;
}

export function ChevronRightIcon(props) {
  return <Svg strokeWidth={2.2} {...props}><path d="M9 5l7 7-7 7" /></Svg>;
}

export function ChevronDownIcon(props) {
  return <Svg strokeWidth={2.2} {...props}><path d="M5 9l7 7 7-7" /></Svg>;
}

export function PlusIcon(props) {
  return <Svg strokeWidth={2.4} {...props}><path d="M12 5v14M5 12h14" /></Svg>;
}

export function MinusIcon(props) {
  return <Svg strokeWidth={2.4} {...props}><path d="M5 12h14" /></Svg>;
}

/** Keypad delete (the README's backspace glyph). */
export function DeleteKeyIcon(props) {
  return (
    <Svg strokeWidth={2} {...props}>
      <path d="M21 5H9l-6 7 6 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1Z" />
      <path d="M17 9.5l-5 5M12 9.5l5 5" />
    </Svg>
  );
}
