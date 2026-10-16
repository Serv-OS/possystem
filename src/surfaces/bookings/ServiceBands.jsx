// src/surfaces/bookings/ServiceBands.jsx
//
// 16 Oct 2026 (bookings audit section 3 item 6): the Timeline's closed stretches (between lunch
// and dinner, a closed day, a private hire block) drawn as grey hatched bands under the booking
// blocks, and the day notice above the Diary. Display only: no store, no writes.

const hatch = 'repeating-linear-gradient(135deg, color-mix(in srgb, var(--t1) 7%, transparent) 0 6px, transparent 6px 12px)';

// bands [{ startMin, endMin, label }], drawn inside the Timeline grid (position: relative).
export function ClosedBands({ bands = [], startMin = 0, slotW = 24, height = 0 }) {
  if (!bands.length) return null;
  return bands.map((b, i) => {
    const left = ((b.startMin - startMin) / 15) * slotW;
    const width = ((b.endMin - b.startMin) / 15) * slotW;
    if (width <= 0) return null;
    return (
      <div key={`${b.startMin}-${i}`} aria-hidden="true" title={b.label} style={{
        position: 'absolute', top: 0, left, width, height: height || '100%', pointerEvents: 'none',
        background: `${hatch}, color-mix(in srgb, var(--bg3, var(--bg2)) 70%, transparent)`,
        borderLeft: '1px solid var(--bdr2)', borderRight: '1px solid var(--bdr2)',
      }}>
        {width >= 48 && (
          <div style={{ position: 'sticky', top: 0, padding: '4px 6px', fontSize: 10, fontWeight: 800, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {b.label}
          </div>
        )}
      </div>
    );
  });
}

export function DayRuleNotice({ text }) {
  if (!text) return null;
  return (
    <div role="note" style={{
      fontSize: 12, fontWeight: 700, color: 'var(--orn)', padding: '5px 10px', borderRadius: 999,
      background: 'color-mix(in srgb, var(--orn) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--orn) 32%, transparent)',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, maxWidth: '100%',
    }} title={text}>{text}</div>
  );
}
