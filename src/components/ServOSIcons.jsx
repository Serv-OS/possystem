// src/components/ServOSIcons.jsx
// ServOS line-icon set — monoline, stroke:currentColor, 24×24 grid.
// Paths mirror the ServOS POS.html / Back Office.html reference icon set.
// Use <Icon name="..." size={20} /> anywhere a clean line icon is needed
// (replaces emoji in the POS/BO chrome). Colour follows currentColor, so it
// adapts to the surrounding text colour + theme automatically.

const PATHS = {
  // ── POS rail / nav ──
  bar:       '<path d="M5 3h14l-7 8z"/><path d="M12 11v8M8 21h8"/>',
  floor:     '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  pos:       '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18M7 14h4"/>',
  orders:    '<path d="M9 4h6l1 3H8z"/><rect x="5" y="7" width="14" height="14" rx="2"/><path d="M9 12h6"/>',
  ai:        '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/>',
  status:    '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  office:    '<path d="M3 21V8l9-5 9 5v13"/><path d="M9 21v-6h6v6"/>',
  kds:       '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18M8 22h8M12 18v4"/>',

  // ── order modes ──
  dinein:    '<path d="M5 3v7a3 3 0 0 0 6 0V3M8 3v18M19 3c-1.5 1-2 3-2 6s.5 4 2 4v8"/>',
  takeaway:  '<path d="M6 8h12l-1 12H7z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  collect:   '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M3 12h18M8 7V5a4 4 0 0 1 8 0v2"/>',
  delivery:  '<path d="M3 13h11V6H3zM14 9h4l3 3v4h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',

  // ── UI / chrome ──
  search:    '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  warn:      '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h0"/>',
  plus:      '<path d="M12 5v14M5 12h14"/>',
  minus:     '<path d="M5 12h14"/>',
  arrow:     '<path d="M5 12h14M13 6l6 6-6 6"/>',
  close:     '<path d="M6 6l12 12M18 6L6 18"/>',
  check:     '<path d="M5 12l4 4L19 7"/>',
  chevron:   '<path d="M9 6l6 6-6 6"/>',
  drawer:    '<rect x="4" y="9" width="16" height="11" rx="2"/><path d="M8 9V7a4 4 0 0 1 8 0v2"/>',
  user:      '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  note:      '<path d="M5 4h11l3 3v13H5z"/><path d="M9 10h6M9 14h6M9 18h3"/>',
  edit:      '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 5l4 4"/>',
  tag:       '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><circle cx="7" cy="7" r="1.4"/>',
  print:     '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
  fire:      '<path d="M12 3c2 3 1 4 0 6 1 0 2-1 2-2 2 2 3 4 3 7a5 5 0 0 1-10 0c0-3 2-4 3-6 0 2 2 2 2 0 0-2-2-3 0-5z"/>',
  clock:     '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bolt2:     '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  sun:       '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/>',
  moon:      '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  card:      '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/>',
  cash:      '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
  receipt:   '<path d="M5 3h14v18l-2-1.5L15 21l-2-1.5L11 21 9 19.5 7 21 5 19.5z"/><path d="M8 8h8M8 12h8"/>',
  sparkle:   '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/>',

  // ── food / drink (category fallbacks) ──
  bolt:      '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  pizza:     '<path d="M12 3a16 16 0 0 1 9 9L12 21 3 12a16 16 0 0 1 9-9z"/><circle cx="10" cy="10" r="1"/><circle cx="14" cy="13" r="1"/>',
  wing:      '<path d="M5 19c4-2 7-5 9-9M14 4l5 1 1 5-3 3"/><circle cx="6.5" cy="17.5" r="2.5"/>',
  bottle:    '<path d="M10 2h4v3l1 3v12a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2V8l1-3z"/><path d="M9 12h6"/>',
  soda:      '<path d="M6 8h12l-1.5 12h-9z"/><path d="M9 4l1 4M15 4l-1 4"/>',
  utensils:  '<path d="M5 3v7a2 2 0 0 0 4 0V3M7 3v18M17 3c-1.5 0-2.5 2-2.5 5s1 4 2.5 4v9"/>',
  wine:      '<path d="M7 3h10l-1 6a4 4 0 0 1-8 0z"/><path d="M12 13v6M8 21h8"/>',
  sandwich:  '<path d="M4 8h16M4 12h16M4 16h16"/><path d="M4 8a8 4 0 0 1 16 0M4 16a8 4 0 0 0 16 0"/>',
  cup:       '<path d="M5 8h12v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z"/><path d="M17 9h2a2 2 0 0 1 0 4h-2"/>',
  donut:     '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/>',
  cake:      '<path d="M4 21V12h16v9z"/><path d="M4 14c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2"/><path d="M12 4v4"/>',
  cocktail:  '<path d="M5 4h14l-7 8z"/><path d="M12 12v6M8 18h8"/><circle cx="16" cy="6" r="1"/>',
  beer:      '<path d="M6 6h10v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z"/><path d="M16 9h2a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><path d="M9 4v2M12 3v3M15 4v2"/>',
  utensilsCrossed: '<path d="M5 3v7a2 2 0 0 0 4 0V3M7 3v18M17 3c-1.5 0-2.5 2-2.5 5s1 4 2.5 4v9"/>',
};

/**
 * Monoline ServOS icon.
 * @param {string} props.name  key in PATHS
 * @param {number} [props.size=20]
 * @param {number} [props.stroke=1.7]
 */
export function Icon({ name, size = 20, stroke = 1.7, style = {}, ...rest }) {
  const d = PATHS[name];
  if (!d) return null;
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size}
      fill="none" stroke="currentColor" strokeWidth={stroke}
      strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, display: 'block', ...style }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: d }}
      {...rest}
    />
  );
}

/** Does a named icon exist? (lets callers fall back to operator-set emoji.) */
export function hasIcon(name) { return !!PATHS[name]; }

// Map common (default) category emoji → ServOS line icons. Lets the POS render
// clean icons for the usual categories while still falling back to whatever
// custom emoji an operator set (we never overwrite their data).
const EMOJI_ICON = {
  '⚡':'bolt', '🍕':'pizza', '🍟':'wing', '🍗':'wing', '🍖':'wing',
  '🍷':'wine', '🥂':'wine', '🍺':'beer', '🍻':'beer', '🍸':'cocktail', '🍹':'cocktail',
  '🍾':'bottle', '🥫':'bottle', '☕':'cup', '🍵':'cup', '🧋':'cup',
  '🍩':'donut', '🍰':'cake', '🧁':'cake', '🎂':'cake',
  '🥪':'sandwich', '🌭':'sandwich', '🥖':'sandwich',
  '🥤':'soda', '🧃':'soda',
  '🍽':'utensils', '🍽️':'utensils', '🍴':'utensils', '🥗':'utensils', '🍝':'utensils', '🍔':'utensils', '🍲':'utensils', '🥘':'utensils',
};
/** Returns a ServOS icon name for a known category emoji, else null. */
export function emojiToIcon(emoji) { return (emoji && EMOJI_ICON[emoji]) || null; }

export default Icon;
