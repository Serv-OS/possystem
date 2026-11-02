// src/surfaces/online/DeliveryAddressSheet.jsx
//
// THE DELIVERY ADDRESS SHEET (5.12.35). Opens the moment the customer picks Delivery, on the
// welcome screen or from the header's order type pill, and again from the "Delivery to <address>"
// row. Line 1 (with the Mapbox suggestions the checkout already uses) and the postcode, then
// Check address. The order type becomes Delivery only on Continue, once the venue has said it
// delivers there, so nobody builds a basket for an address the venue cannot reach.
//
// Every word and every state comes from lib/online/deliveryCoverage.js (tested); this file lays
// them out on the venue's Appearance tokens (theme, cardBdr, muted, the page's input background),
// never a colour of its own. The quote call is the page's `check` (the same shared helper the
// checkout goes through). A check that cannot run says so and offers Try again or collection; it
// never blanks the page.

import { useEffect, useRef, useState } from 'react';
import AddressAutocomplete from '../../components/AddressAutocomplete';
import { Sheet } from './OnlineHeaderBlock';
import {
  EMPTY_DELIVERY, canCheckAddress, coverageWords, typeAddress, typePostcode, pickAddress, withQuote,
  tryVenueButton, collectInsteadLabel, postcodeLabel, addressCountry,
} from '../../lib/online/deliveryCoverage';

const PinIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.6" />
  </svg>
);

/**
 * @param value     the page's delivery object (EMPTY_DELIVERY when nothing has been typed)
 * @param check     async (delivery) => quote; the page's call through quoteDeliveryAddress
 * @param onContinue(delivery)  covered and confirmed: the page stores it and switches to Delivery
 * @param onCollect             switch to collection instead
 * @param onTryVenue            open the Change location sheet (only offered with a sibling venue)
 */
export default function DeliveryAddressSheet({
  theme, cardBdr, muted, inputBg, narrow, location, siblings = [], value, fmt, check,
  onContinue, onCollect, onTryVenue, onClose,
}) {
  const [draft, setDraft] = useState(() => ({ ...EMPTY_DELIVERY, ...(value || {}) }));
  const [checking, setChecking] = useState(false);
  const runRef = useRef(0);
  useEffect(() => () => { runRef.current += 1; }, []);   // a result after close is dropped

  const words = coverageWords(draft, { checking, fmt, siblings: siblings.length, location });
  const state = words.state;
  const canCheck = canCheckAddress(draft) && !checking;
  const tryVenue = tryVenueButton(siblings);

  const runCheck = async () => {
    if (!canCheck) return;
    const asked = { address1: draft.address1, postcode: draft.postcode };
    const run = ++runRef.current;
    setChecking(true);
    const quote = await check({ ...draft, quote: null });
    if (run !== runRef.current) return;
    setChecking(false);
    setDraft((d) => withQuote(d, asked, quote));
  };

  const confirmLabel = state === 'covered' ? 'Continue' : (state === 'error' ? 'Try again' : 'Check address');
  const onConfirm = state === 'covered' ? () => onContinue({ ...draft }) : runCheck;
  const confirmDisabled = state === 'covered' ? false : !canCheck;

  const inputStyle = { width: '100%', padding: '12px 14px', borderRadius: 10, background: inputBg, color: theme.fg, border: `1.5px solid ${cardBdr}`, fontSize: 15, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' };
  const label = { fontSize: 11, fontWeight: 700, color: muted, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 };
  const secondary = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', padding: '12px 16px', borderRadius: 999, background: 'transparent', color: theme.fg, border: `1.5px solid ${cardBdr}`, fontSize: 14, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit', boxSizing: 'border-box' };
  const proximity = (location && Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lng))) ? { lat: Number(location.lat), lng: Number(location.lng) } : undefined;

  return (
    <Sheet theme={theme} cardBdr={cardBdr} narrow={narrow} title="Delivery address" onClose={onClose}
      confirmLabel={confirmLabel} onConfirm={onConfirm} confirmDisabled={confirmDisabled}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '10px 0 6px' }}>
        <div style={{ fontSize: 14, color: muted, lineHeight: 1.45 }}>Tell us where to deliver and we will check the address before you order.</div>
        <div>
          <div style={label}>Address</div>
          <AddressAutocomplete
            value={draft.address1}
            onChangeText={(t) => setDraft((d) => typeAddress(d, t))}
            onSelect={(a) => setDraft((d) => pickAddress(d, a))}
            country={addressCountry(location)}
            proximity={proximity}
            placeholder="Start typing your address"
            inputStyle={inputStyle}
            autoFocus={!draft.address1}
          />
        </div>
        <div>
          <div style={label}>{postcodeLabel(location)}</div>
          <input
            value={draft.postcode}
            onChange={(e) => setDraft((d) => typePostcode(d, e.target.value))}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runCheck(); } }}
            placeholder={postcodeLabel(location) === 'ZIP code' ? '84601' : 'HD1 2AB'}
            autoComplete="postal-code"
            style={inputStyle}
          />
        </div>

        {(words.title || words.detail) && (
          <div role="status" aria-live="polite" style={{
            display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 14px', borderRadius: 12,
            background: `${theme.accent}18`, border: `1px solid ${theme.accent}55`, color: theme.fg,
          }}>
            <span style={{ color: theme.fg, display: 'inline-flex', flex: 'none', marginTop: 1 }}><PinIcon /></span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 15, fontWeight: 800, lineHeight: 1.35 }}>{words.title}</span>
              {words.detail && <span style={{ display: 'block', fontSize: 13.5, color: muted, marginTop: 3, lineHeight: 1.45 }}>{words.detail}</span>}
            </span>
          </div>
        )}

        {(state === 'not_covered' || state === 'error') && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button type="button" className="op-btn" onClick={onCollect} style={secondary}>{collectInsteadLabel(location)}</button>
            {state === 'not_covered' && tryVenue && (
              <button type="button" className="op-btn" onClick={onTryVenue} style={secondary}>{tryVenue.label}</button>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}
