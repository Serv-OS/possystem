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
  support:   '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2.5" y="13" width="4.5" height="6.5" rx="1.8"/><rect x="17" y="13" width="4.5" height="6.5" rx="1.8"/><path d="M20 19.5v1a2 2 0 0 1-2 2h-4"/>',
  kds:       '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18M8 22h8M12 18v4"/>',

  // ── order modes ──
  dinein:    '<path d="M5 3v7a3 3 0 0 0 6 0V3M8 3v18M19 3c-1.5 1-2 3-2 6s.5 4 2 4v8"/>',
  takeaway:  '<path d="M6 8h12l-1 12H7z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  collect:   '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M3 12h18M8 7V5a4 4 0 0 1 8 0v2"/>',
  delivery:  '<path d="M3 13h11V6H3zM14 9h4l3 3v4h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',

  // ── Back-office section icons ──
  home:      '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 21V9"/>',
  list:      '<path d="M4 5h16M4 12h16M4 19h10"/><circle cx="19" cy="19" r="1.6"/>',
  inventory: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
  team:      '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 6a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6"/>',
  customers: '<circle cx="12" cy="8" r="3.2"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  channels:  '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18"/>',
  hardware:  '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>',
  reports:   '<path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="6"/><rect x="12" y="7" width="3" height="10"/><rect x="17" y="13" width="3" height="4"/>',
  settings:  '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a1.7 1.7 0 0 0 .3 1.9l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.86 1.18V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.86-1.18l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15H4.5a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.18-2.86l-.06-.06A2 2 0 1 1 8.55 5.2l.06.06A1.7 1.7 0 0 0 11.5 4.6V4.5a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.86 1.18l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 11.5V11"/>',
  signout:   '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  back:      '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  pin:       '<path d="M12 21s-7-4.5-7-10a7 7 0 0 1 14 0c0 5.5-7 10-7 10z"/><circle cx="12" cy="11" r="2.5"/>',

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
  // ── operations ──
  thermo:    '<path d="M14 14.76V5a2 2 0 0 0-4 0v9.76a4 4 0 1 0 4 0z"/>',
  snow:      '<path d="M12 2v20M4.5 6.5l15 11M19.5 6.5l-15 11"/><path d="M9 4l3 2 3-2M9 20l3-2 3 2M4.4 9l2 3-2 3M19.6 9l-2 3 2 3"/>',
  camera:    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.4"/>',
  bell:      '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a1.9 1.9 0 0 1-3.4 0"/>',
  wrench:    '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.1-2.1z"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 14l2 2 4-4"/>',
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
  '🥩':'utensils', '🥓':'utensils', '🍳':'utensils', '🦐':'utensils', '🐟':'utensils', '🍱':'utensils', '🍜':'utensils', '🌮':'utensils', '🌯':'utensils', '🧀':'utensils', '🥙':'utensils', '🫕':'utensils',
  '🔥':'fire', '🌶':'fire', '🌶️':'fire', '⭐':'sparkle', '✨':'sparkle', '🌟':'sparkle',
  '🥧':'cake', '🍦':'cake', '🍨':'cake', '🍪':'donut', '🥐':'sandwich', '🥯':'sandwich',
  '🫖':'cup', '🥃':'cocktail', '🍶':'bottle', '🥛':'soda', '🧉':'cup',
};
/** Returns a ServOS icon name for a known category emoji, else null. */
export function emojiToIcon(emoji) { return (emoji && EMOJI_ICON[emoji]) || null; }

export default Icon;
