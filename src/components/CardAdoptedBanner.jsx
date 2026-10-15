import { useStore } from '../store';

/**
 * CardAdoptedBanner (30 Sep 2026): a card sale this till booked AFTER its checkout was closed.
 *
 * Coffee Boy Huddersfield, 30 Sep: staff closed the checkout 17 s into a slow tender, the reader
 * approved £11.65, the till's reconciler booked R5737 in the background, the cart stayed on screen
 * with no kitchen ticket, and the same order was rung again as R5739. The customer paid twice.
 *
 * kickRace.js and the checkout watch stop that path; this banner is the last line. It is STICKY:
 * a toast is gone in three seconds and the next thing staff were about to do was ring the order
 * again. Sits with ConfigSyncBanner under the shift bar, on every surface, until staff dismiss it.
 * Set by TerminalJobReconciler through store.showCardAdoptedBanner.
 */
export default function CardAdoptedBanner() {
  const banner = useStore(s => s.cardAdoptedBanner);
  const dismiss = useStore(s => s.dismissCardAdoptedBanner);
  if (!banner?.text) return null;
  const time = banner.at
    ? new Date(banner.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : null;
  return (
    <div role="alert" style={{
      background: 'var(--grn-d, rgba(34,197,94,.12))',
      borderBottom: '2px solid var(--grn, #22c55e)',
      padding: '10px 18px',
      display: 'flex', alignItems: 'center', gap: 14,
      flexShrink: 0, animation: 'slideDown .25s cubic-bezier(.2,.8,.3,1)',
    }}>
      <span style={{ fontSize: 18, flexShrink: 0 }}>✅</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--t1)' }}>{banner.text}</span>
        {time && <span style={{ fontSize: 12, color: 'var(--t3)', marginLeft: 10 }}>Approved at {time}</span>}
      </div>
      <button className="btn" onClick={() => dismiss?.()} style={{ height: 36, padding: '0 14px', flexShrink: 0 }}>
        Got it
      </button>
    </div>
  );
}
