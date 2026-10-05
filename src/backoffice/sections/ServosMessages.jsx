// src/backoffice/sections/ServosMessages.jsx
//
// Back Office, Settings, Messages from ServOS.
//
// WHY (Peter, 5 Oct 2026): ServOS can now send a venue a message that pops up on its tills and
// in Back Office until someone taps Got it. Once it is confirmed the pop up is gone, so this is
// where a manager reads again what ServOS asked for: every message of the last 30 days, with who
// confirmed it and when (on the venue's own clock). Read only. A message still waiting can be
// confirmed from the pop up itself.
import { useMemo } from 'react';
import { useStore } from '../../store';
import { useVenueMessages } from '../../lib/useVenueMessages';
import { receivedList, venueStatus, formatVenueTime, KIND_LABEL } from '../../lib/venueMessageRules';

const card = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 20, marginBottom: 14 };
const pill = (tone) => ({
  display: 'inline-block', padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap',
  background: tone === 'red' ? 'var(--red-d)' : tone === 'acc' ? 'var(--acc-d)' : 'var(--bg3)',
  color: tone === 'red' ? 'var(--red)' : tone === 'acc' ? 'var(--acc)' : 'var(--t2)',
  border: `1px solid ${tone === 'red' ? 'var(--red-b)' : tone === 'acc' ? 'var(--acc-b)' : 'var(--bdr)'}`,
});

export default function ServosMessages({ locationId }) {
  const { rows, ready, loaded, refresh } = useVenueMessages(locationId, { enabled: !!locationId, days: 30 });
  const timezone = useStore(s => s.locationConfig?.timezone) || null;
  const list = useMemo(() => receivedList(rows), [rows]);

  return (
    <div data-testid="servos-messages" style={{ maxWidth: 820 }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--t1)', marginBottom: 4 }}>Messages from ServOS</div>
      <div style={{ fontSize: 13.5, color: 'var(--t2)', lineHeight: 1.55, marginBottom: 18 }}>
        Messages ServOS sent to this venue in the last 30 days. A new one pops up on the tills and here in Back Office
        until someone taps Got it. One tap confirms it for the whole venue.
      </div>

      {!locationId && <div style={card}>Pick a venue to see its messages.</div>}
      {locationId && !loaded && <div style={{ ...card, color: 'var(--t3)' }}>Loading…</div>}
      {locationId && loaded && !ready && (
        <div style={{ ...card, color: 'var(--t2)' }}>No messages yet. This list fills in after the next ServOS update.</div>
      )}
      {locationId && loaded && ready && list.length === 0 && (
        <div style={{ ...card, color: 'var(--t2)' }}>No messages in the last 30 days.</div>
      )}

      {list.map((m) => {
        const status = venueStatus(m);
        const sent = formatVenueTime(m.sent_at, timezone);
        const confirmedAt = m.confirmed_at ? formatVenueTime(m.confirmed_at, timezone) : '';
        const where = m.confirmed_via === 'till' ? (m.confirmed_device_name ? ` on ${m.confirmed_device_name}` : ' on a till')
          : m.confirmed_via === 'backoffice' ? ' in Back Office' : '';
        return (
          <div key={m.id} style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              <span style={pill(m.kind === 'action' ? 'red' : 'acc')}>{KIND_LABEL[m.kind === 'action' ? 'action' : 'info']}</span>
              <span style={{ fontSize: 13, color: 'var(--t3)' }}>Sent {sent}</span>
              <span style={{ flex: 1 }} />
              <span style={pill(status === 'waiting' ? 'red' : 'plain')}>
                {status === 'waiting' ? 'Waiting for Got it' : status === 'withdrawn' ? 'Withdrawn by ServOS' : 'Confirmed'}
              </span>
            </div>
            {m.title && <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--t1)', marginBottom: 6, overflowWrap: 'anywhere' }}>{m.title}</div>}
            <div style={{ fontSize: 15, lineHeight: 1.55, color: 'var(--t1)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.body}</div>
            {m.confirmed_at && (
              <div style={{ fontSize: 13, color: 'var(--t2)', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--bdr)' }}>
                Confirmed by {m.confirmed_by || 'someone'}{where}{confirmedAt ? ` at ${confirmedAt}` : ''}.
              </div>
            )}
          </div>
        );
      })}

      {locationId && loaded && ready && (
        <button type="button" onClick={refresh}
          style={{ padding: '9px 16px', borderRadius: 10, border: '1px solid var(--bdr2)', background: 'transparent', color: 'var(--t1)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 700 }}>
          Check for new messages
        </button>
      )}
    </div>
  );
}
