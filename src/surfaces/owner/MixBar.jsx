// src/surfaces/owner/MixBar.jsx: the thin sales mix bar under a card's sales figure (8 Oct 2026).
//
// Peter: "what is Food/drink/other split ... in hospitality a valued piece of data". One bar,
// three segments at most, the words under it ("Food 62%  Drinks 31%  Other 7%") and the change
// in share against the comparison period in points where the function sent one ("+3 pts"; "0 pts"
// when nothing moved; nothing at all with no comparison). Every number here is the function's
// (whole percent shares that add to 100), through src/lib/ownerMix.js cardBar: no division and no
// percent is worked out on the screen. Colours are by group key, so Food is the same colour on
// every card. The card hands in null (an old function, no sales, or nothing set up on a venue
// card) and nothing is drawn.

export default function MixBar({ bar, size = 'card' }) {
  if (!bar) return null;
  const group = size === 'group';
  return (
    <div>
      <div role="img" aria-label={`Sales mix: ${bar.words}`}
        style={{ display: 'flex', height: group ? 8 : 6, borderRadius: 99, overflow: 'hidden', gap: 2, marginTop: 10 }}>
        {bar.segments.map((s) => (
          <div key={s.key} style={{ flex: `${s.share} 0 0`, minWidth: s.share > 0 ? 3 : 0, background: s.color }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 6, fontSize: group ? 12 : 11.5, lineHeight: 1.3 }}>
        {bar.segments.map((s) => (
          <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
            <span aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
            <span style={{ color: 'var(--t2)', fontWeight: 700 }}>{s.name} {s.share}%</span>
            {s.ptsText && <span style={{ color: 'var(--t3)', fontWeight: 600 }}>· {s.ptsText}</span>}
          </span>
        ))}
      </div>
      {bar.hint && <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 8 }}>{bar.hint}</div>}
    </div>
  );
}
