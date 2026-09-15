/**
 * KioskCategoryTile (v5.8.65): one category tile in the kiosk rail.
 *
 * Reusable piece for the kiosk redesign. The mode is decided once for the whole rail by
 * railTileMode (lib/categoryPhoto.js), so every tile in a rail has the same height:
 *   'text'  : today's plain text button, unchanged
 *   'photo' : a 104px photo slot (at 1080 wide) over the label. The brand colour block
 *             always sits under the photo, so a category with no photo, or a photo that
 *             fails to load, still shows a full size tile (decision 2).
 * The photo is decorative (alt=""): the label is the accessible name.
 * photoOrigin: the app's Supabase URL. A photo URL on any other host is never shown.
 */
import { tileAccentColor, tileSlot } from '../../lib/categoryPhoto';

export default function KioskCategoryTile({ cat, active, mode, brandColor, photoOrigin = null, onSelect, look }) {
  // New kiosk design (README 2 rail tile, plain design px). Any other look keeps the
  // current tile below, untouched.
  if (look === 'design') {
    const slot = tileSlot(cat, mode, brandColor, photoOrigin);
    return (
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={!!active}
        style={{
          display: 'flex', flexDirection: 'column', gap: 10, padding: 12, borderRadius: 24, width: '100%',
          border: `3px solid ${active ? 'var(--k2PrimaryLine)' : 'transparent'}`,
          background: active ? '#FFFFFF' : 'rgba(255,255,255,.55)',
          textAlign: 'left', cursor: 'pointer', flex: 'none', minHeight: 64, justifyContent: 'center',
        }}
      >
        {slot ? (
          <div style={{ height: 104, borderRadius: 16, overflow: 'hidden', flex: 'none', background: slot.background }}>
            {slot.url && (
              <img
                src={slot.url}
                alt=""
                loading="lazy"
                draggable={false}
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                onError={e => { e.currentTarget.style.display = 'none'; }}
              />
            )}
          </div>
        ) : null}
        <span style={{
          fontSize: 22, fontWeight: 700, lineHeight: 1.2, padding: '0 4px 4px',
          color: active ? '#14110F' : '#3A332C', overflowWrap: 'anywhere',
        }}>{cat.label}</span>
      </button>
    );
  }

  if (mode !== 'photo') {
    return (
      <button
        onClick={onSelect}
        style={{
          padding: 'clamp(14px, 2vw, 20px) clamp(14px, 1.8vw, 22px)',
          background: active ? brandColor : 'transparent',
          color: active ? '#fff' : brandColor,
          borderRadius: 14,
          fontSize: 'clamp(15px, 1.9vw, 20px)',
          fontWeight: 700,
          border: 0,
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
          letterSpacing: '-0.01em',
          lineHeight: 1.2,
          transition: 'background 0.1s',
        }}
      >{cat.label}</button>
    );
  }

  const slot = tileSlot(cat, 'photo', brandColor, photoOrigin);
  return (
    <button
      onClick={onSelect}
      aria-pressed={!!active}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'clamp(6px, 0.8vw, 10px)',
        padding: 'clamp(8px, 1vw, 12px)',
        borderRadius: 'clamp(16px, 2.2vw, 24px)',
        border: `3px solid ${active ? tileAccentColor(brandColor) : 'transparent'}`,
        background: active ? 'var(--kSurfaceRaised)' : 'var(--kSurface1)',
        color: 'var(--kFg)',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
        flexShrink: 0,
        transition: 'border-color 0.1s, background 0.1s',
      }}
    >
      <div style={{
        height: 'clamp(72px, 9.6vw, 104px)',
        borderRadius: 16,
        overflow: 'hidden',
        flexShrink: 0,
        background: slot.background,
      }}>
        {slot.url && (
          <img
            src={slot.url}
            alt=""
            loading="lazy"
            draggable={false}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            onError={e => { e.currentTarget.style.display = 'none'; }}
          />
        )}
      </div>
      <span style={{
        fontSize: 'clamp(15px, 1.9vw, 20px)',
        fontWeight: 700,
        lineHeight: 1.2,
        letterSpacing: '-0.01em',
        padding: '0 4px 4px',
        overflowWrap: 'anywhere',   // a long one word name wraps instead of being cut off
      }}>{cat.label}</span>
    </button>
  );
}
