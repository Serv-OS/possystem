// src/components/VenueMessagePopup.jsx: a message from ServOS, parked over the screen until
// someone taps Got it.
//
// WHY (Peter, 5 Oct 2026): "we need to be able to send a notification, like a message ... like a
// POP UP from the admin: send a message, in this case saying 'Hi, I have just made an update, you
// need to do XYZ'." His calls: it pops up in Back Office AND on tills, it stays until someone
// taps Got it, and one confirmation clears it for the whole venue (admin sees who and when).
//
// WHERE IT IS MOUNTED (two places, and only these; pinned by lib/venueMessagePopupWiring.test.js)
//   * App.jsx, inside the till shell (Floor, POS, Bar, Orders) with a member of staff signed in;
//   * BackOfficeApp.jsx, for whoever is signed in to that venue.
// NEVER on a kiosk, kitchen screen, customer display, menu board, order screen, time clock, the
// phone till or any customer page.
//
// THE CARD PATH IS OFF LIMITS. It never opens over a checkout, a card screen, a tab capture or
// any payment in progress: every pay flow holds lib/paymentBusy.js (the open checkout holds for
// as long as it is on screen), and this asks the same question an app update asks,
// canApplyUpdate(). If a payment is live the message waits and shows after. If a payment starts
// while it is showing, it steps aside at once. CHANGE DUE (components/ChangeDueOverlay.jsx) is
// shown after the checkout has closed, so nothing holds for it: the pop up reads it from the
// store and waits until staff have tapped it away (the cash handover is part of the payment).
//
// KEYS. The card covers the screen but a key press does not care, so while the pop up shows
// every key is caught before the screen behind can see it (lib/venueMessageRules.js
// popupKeyAction): no typing into a hidden form, no staff card swipe or barcode scan acting
// behind the card. Focus sits on the card, NEVER on Got it, and on a till Got it only counts
// after a real press on the button: a wedge ends with Enter, and Enter must never confirm a
// message for the whole venue with nobody having read it.
//
// One tap and it is gone from this screen, internet or not (lib/useVenueMessages.js). No typing.
// The text is shown as plain text: line breaks kept, nothing is turned into a link.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';
import { useVenueMessages } from '../lib/useVenueMessages';
import { canApplyUpdate, subscribePaymentBusy } from '../lib/paymentBusy';
import { mayShowPopup, confirmer, chimeKey, formatVenueTime, popupKeyAction, gotItClickCounts, POPUP_HOSTS } from '../lib/venueMessageRules';
import { playOrderChime } from '../lib/orderChime';
import VenueMessageCard from './VenueMessageCard';

// A tap already on its way when the card appears (or when Got it brings up the next message)
// must not land on Got it. The button wakes after this long (the kiosk alert's own rule).
const ARM_MS = 700;
// A press on Got it counts for the click that follows it, not for one much later.
const PRESS_MS = 3000;
const KEY_EVENTS = ['keydown', 'keypress', 'keyup'];
const chimed = new Set();

export default function VenueMessagePopup({ host, locationId, user = null, userName = null, timezone = null }) {
  const allowedHost = POPUP_HOSTS.includes(host);
  const { queue, confirm } = useVenueMessages(locationId, { enabled: allowedHost && !!locationId });
  const staffName = useStore(s => (host === 'till' ? s.staff?.name : null)) || null;
  // A till in a customer's hands (tip pass, card, receipt): wait, show when it is back.
  const customerFacing = useStore(s => s.tillCustomerFacing === true);
  // CHANGE DUE is parked over the till: staff are still handing cash back.
  const changeDueShowing = useStore(s => !!s.changeDue);
  // The venue's own clock (the store keeps the venue's timezone), never this device's.
  const venueZone = useStore(s => s.locationConfig?.timezone) || timezone || null;
  const [paymentQuiet, setPaymentQuiet] = useState(() => canApplyUpdate());
  const [armedKey, setArmedKey] = useState(null);
  const okRef = useRef(null);
  const cardRef = useRef(null);
  const armedRef = useRef(false);
  const pressedAtRef = useRef(0);

  const waiting = queue.length;
  const who = confirmer({ host, staffName, user, userName });

  // Follow the payment flag while something is waiting. The flag tells us the moment a payment
  // starts; the one second tick catches the end of the quiet seconds after it finishes.
  useEffect(() => {
    if (!waiting) return undefined;
    const check = () => setPaymentQuiet(canApplyUpdate());
    const first = setTimeout(check, 0);
    const unsubscribe = subscribePaymentBusy(check);
    const iv = setInterval(check, 1000);
    return () => { clearTimeout(first); unsubscribe(); clearInterval(iv); };
  }, [waiting]);

  // Asked again at render, not only from state: a payment that started this very tick wins.
  const show = allowedHost && who.ok && waiting > 0
    && mayShowPopup({ paymentQuiet: paymentQuiet && canApplyUpdate(), customerFacing, changeDueShowing });
  const front = show ? queue[0] : null;
  const frontKey = front ? front.id : null;
  const frontChime = front ? chimeKey(front) : null;

  // One chime the first time this screen SHOWS a message, and one more when ServOS sends it again.
  useEffect(() => {
    if (!frontChime || chimed.has(frontChime)) return;
    chimed.add(frontChime);
    if (host === 'till') playOrderChime();
  }, [frontChime, host]);

  useEffect(() => {
    if (!frontKey) return undefined;
    pressedAtRef.current = 0;
    const t = setTimeout(() => { armedRef.current = true; setArmedKey(frontKey); }, ARM_MS);
    // Asleep again whenever this message leaves the screen (Got it, or a payment starting), so
    // the button is never awake on its very first frame when it comes back.
    return () => { clearTimeout(t); armedRef.current = false; setArmedKey(null); };
  }, [frontKey]);

  // While the card is up: take focus off whatever was focused behind it and put it on the card
  // (not the button), and catch every key before the screen behind can.
  useEffect(() => {
    if (!frontKey || typeof window === 'undefined') return undefined;
    const before = document.activeElement;
    const focusT = setTimeout(() => {
      try { if (before && before !== document.body && typeof before.blur === 'function') before.blur(); } catch { /* noop */ }
      try { cardRef.current?.focus({ preventScroll: true }); } catch { /* noop */ }
    }, 0);
    const onKey = (e) => {
      const action = popupKeyAction({
        host, key: e.key, onButton: !!okRef.current && e.target === okRef.current, armed: armedRef.current,
        modifier: !!(e.ctrlKey || e.metaKey || e.altKey),
      });
      // Whatever it is, the screen behind never hears it (useCardScan, forms, shortcuts).
      e.stopPropagation();
      if (action === 'press' || action === 'browser') return;   // Got it by keyboard (Back Office), or the browser's own key
      e.preventDefault();
      if (action === 'button' && e.type === 'keydown') {
        try { (armedRef.current && okRef.current ? okRef.current : cardRef.current)?.focus({ preventScroll: true }); } catch { /* noop */ }
      }
    };
    // Capture on window: first in line, before React's root and before any window listener.
    for (const type of KEY_EVENTS) window.addEventListener(type, onKey, true);
    return () => {
      clearTimeout(focusT);
      for (const type of KEY_EVENTS) window.removeEventListener(type, onKey, true);
    };
  }, [frontKey, host]);

  if (!front || typeof document === 'undefined') return null;

  const armed = armedKey === frontKey;
  const onPress = () => { pressedAtRef.current = Date.now(); };
  const onGotIt = () => {
    const pressed = pressedAtRef.current > 0 && Date.now() - pressedAtRef.current < PRESS_MS;
    pressedAtRef.current = 0;
    if (!gotItClickCounts({ host, armed, pressed })) return;
    confirm(front.id, who.name);
  };

  return createPortal(
    <div
      data-venue-message-popup={host}
      style={{
        position: 'fixed', inset: 0, zIndex: 100010, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16, fontFamily: 'inherit', animation: 'fadeIn .18s ease',
      }}
    >
      {/* Scrim from the screen's own background colour, so it follows the light and dark themes. */}
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'var(--bg)', opacity: 0.84 }} />
      <VenueMessageCard
        key={front.id}
        message={front}
        sentText={formatVenueTime(front.sent_at, venueZone)}
        more={waiting - 1}
        whoName={who.name}
        armed={armed}
        onGotIt={onGotIt}
        onPress={onPress}
        buttonRef={okRef}
        rootRef={cardRef}
      />
    </div>,
    document.body
  );
}
