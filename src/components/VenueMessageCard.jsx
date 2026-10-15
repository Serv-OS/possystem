// src/components/VenueMessageCard.jsx: how a message from ServOS looks. One card, two users:
// the real pop up (components/VenueMessagePopup.jsx) and the preview in Company Admin, so what
// ServOS sees before sending is exactly what the venue gets.
//
// Action needed uses the urgent look (red); Info uses the calm look (the accent colour).
// The text is plain text: line breaks are kept and nothing is turned into a link, so a message
// can never carry something a tap would run.
import { KIND_LABEL } from '../lib/venueMessageRules';
import { Icon } from './ServOSIcons';

export default function VenueMessageCard({ message, sentText = '', more = 0, whoName = '', armed = true, onGotIt, onPress, buttonRef = null, rootRef = null, preview = false }) {
  const urgent = message?.kind === 'action';
  const tone = urgent
    ? { line: 'var(--red-b)', wash: 'var(--red-d)', ink: 'var(--red)', icon: 'warn' }
    : { line: 'var(--acc-b)', wash: 'var(--acc-d)', ink: 'var(--acc)', icon: 'bell' };
  const ids = preview ? { title: undefined, body: undefined } : { title: 'venue-message-title', body: 'venue-message-body' };
  return (
    <div
      ref={rootRef}
      // The pop up puts focus HERE, on the card, never on Got it: a card or barcode wedge ends
      // with Enter, and Enter on a focused button is a click (components/VenueMessagePopup.jsx).
      tabIndex={preview ? undefined : -1}
      role={preview ? undefined : 'alertdialog'}
      aria-modal={preview ? undefined : 'true'}
      aria-labelledby={ids.title}
      aria-describedby={ids.body}
      style={{
        position: 'relative', width: 'min(620px, 100%)', maxHeight: preview ? 'none' : 'calc(100vh - 32px)', display: 'flex', flexDirection: 'column',
        background: 'var(--bg1)', color: 'var(--t1)', borderRadius: 22, overflow: 'hidden', outline: 'none',
        border: `1px solid ${tone.line}`, boxShadow: preview ? 'var(--sh)' : 'var(--sh3)', animation: preview ? 'none' : 'slideUp .24s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 22px', background: tone.wash, borderBottom: `1px solid ${tone.line}` }}>
        <div style={{ width: 48, height: 48, borderRadius: 14, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--bg1)', color: tone.ink, border: `1px solid ${tone.line}` }}>
          <Icon name={tone.icon} size={28} stroke={2} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div id={message?.title ? undefined : ids.title} style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)' }}>Message from ServOS</div>
          {sentText && <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t2)', marginTop: 2 }}>Sent {sentText}</div>}
        </div>
        <div style={{ flexShrink: 0, padding: '5px 11px', borderRadius: 999, fontSize: 14, fontWeight: 800, color: tone.ink, background: 'var(--bg1)', border: `1px solid ${tone.line}`, whiteSpace: 'nowrap' }}>
          {KIND_LABEL[urgent ? 'action' : 'info']}
        </div>
      </div>

      <div style={{ padding: '18px 22px 6px', overflowY: 'auto', minHeight: 0 }}>
        {message?.title && (
          <div id={ids.title} style={{ fontSize: 'clamp(22px, 3.2vw, 28px)', fontWeight: 800, lineHeight: 1.2, color: 'var(--t1)', marginBottom: 10, overflowWrap: 'anywhere' }}>
            {message.title}
          </div>
        )}
        <div id={ids.body} style={{ fontSize: 19, lineHeight: 1.5, fontWeight: 500, color: message?.body ? 'var(--t1)' : 'var(--t3)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {message?.body || (preview ? 'Your message shows here.' : '')}
        </div>
      </div>

      <div style={{ padding: '14px 22px 20px' }}>
        {more > 0 && (
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t2)', marginBottom: 10, textAlign: 'center' }}>
            {more === 1 ? '1 more message after this one' : `${more} more messages after this one`}
          </div>
        )}
        <button
          ref={buttonRef}
          type="button"
          className="btn btn-acc btn-full"
          onClick={preview ? undefined : onGotIt}
          // A real tap goes DOWN on the button before it clicks; a click a keyboard made does not.
          onPointerDown={preview ? undefined : onPress}
          onTouchStart={preview ? undefined : onPress}
          onMouseDown={preview ? undefined : onPress}
          disabled={!preview && !armed}
          tabIndex={preview ? -1 : undefined}
          aria-hidden={preview ? 'true' : undefined}
          style={{ height: 68, fontSize: 23, fontWeight: 800, borderRadius: 16, pointerEvents: preview ? 'none' : undefined }}
        >
          Got it
        </button>
        {whoName && (
          <div style={{ fontSize: 13, color: 'var(--t3)', marginTop: 10, textAlign: 'center' }}>
            Confirms for the whole venue as {whoName}.
          </div>
        )}
      </div>
    </div>
  );
}
