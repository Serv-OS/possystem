// MBottomSheet — shared bottom-sheet wrapper. All MPOS bottom sheets render
// through here so positioning + hit-test handling stays in one place.
//
// Why this exists: earlier sheets used a single `position:fixed; inset:0`
// container with `display:flex; align-items:flex-end` to push the sheet to
// the bottom. On iOS Safari with viewport-fit=cover this combination can
// cause hit-test offsets where touches near button positions register a few
// px below the visual layout. The fix: TWO siblings — a fixed inset:0
// backdrop (just for dim + tap-outside-to-close) and a fixed bottom:0 sheet
// anchored directly at the bottom edge. No flex container needed.

export default function MBottomSheet({ onClose, children, maxHeight = '92%', zIndex = 60, backdropOpacity = '.55' }) {
  return (
    <>
      {/* Backdrop — dims the shell, taps close the sheet. position:absolute
          scopes to the shell (which has position:relative) so the inset
          rectangle exactly matches the shell's coordinate system — no iOS
          viewport-fit hit-test offset. */}
      <div
        onClick={onClose}
        style={{
          position:'absolute', top:0, left:0, right:0, bottom:0,
          background:`rgba(0,0,0,${backdropOpacity})`, zIndex,
        }}
      />
      {/* Sheet — anchored at the shell's bottom, NOT the viewport bottom */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position:'absolute', bottom:0, left:0, right:0, zIndex: zIndex + 1,
          background:'var(--bg1)', borderRadius:'18px 18px 0 0',
          padding:'14px 14px calc(18px + env(safe-area-inset-bottom)) 14px',
          boxShadow:'0 -10px 32px rgba(0,0,0,.45)',
          maxHeight, overflowY:'auto',
        }}>
        {/* Drag-handle indicator */}
        <div style={{ width:36, height:4, borderRadius:2, background:'var(--bdr2)', margin:'0 auto 14px' }}/>
        {children}
      </div>
    </>
  );
}
