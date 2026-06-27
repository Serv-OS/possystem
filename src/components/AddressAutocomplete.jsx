import { useState, useEffect, useRef } from 'react';
import { searchAddresses, searchPlaces, retrievePlace, newSessionToken, mapboxToken } from '../lib/address/mapbox';

/**
 * AddressAutocomplete — a single text input that suggests precise, geocodable addresses as you
 * type (Mapbox), and on select reports the full structured address WITH coordinates via
 * onSelect({ line1, city, postcode, lat, lng }). Free typing still flows through onChangeText,
 * so manual entry always works. With no Mapbox token it's just a plain input (no regression).
 *
 * The dropdown uses a neutral light popover so it reads correctly on both the dark POS/BO and the
 * light online/catering storefronts. The input itself uses the caller's inputStyle.
 */
export default function AddressAutocomplete({
  value, onChangeText, onSelect, inputStyle, placeholder = 'Start typing your address…',
  country = 'gb', proximity, token: tokenProp, disabled, autoFocus,
}) {
  const token = tokenProp || mapboxToken();
  const [open, setOpen] = useState(false);
  const [sugg, setSugg] = useState([]);
  const [active, setActive] = useState(-1);
  const boxRef = useRef(null);
  const skipRef = useRef(false); // don't re-search the text we just set from a selection
  const sessionRef = useRef(null);
  if (!sessionRef.current) sessionRef.current = newSessionToken();

  useEffect(() => {
    if (!token) return;
    if (skipRef.current) { skipRef.current = false; return; }
    const q = value || '';
    if (q.trim().length < 3) { setSugg([]); setOpen(false); return; }
    let live = true;
    const t = setTimeout(async () => {
      // Search Box first (finds businesses/POIs + addresses); fall back to geocoding (addresses
      // only) if it returns nothing, so there's no regression where Search Box isn't enabled.
      let r = await searchPlaces(q, { country, proximity, sessionToken: sessionRef.current });
      if (!live) return;
      if (!r.length) { r = await searchAddresses(q, { country, proximity }); if (!live) return; }
      setSugg(r); setOpen(r.length > 0); setActive(-1);
    }, 280);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, token, country]);

  useEffect(() => {
    const h = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const choose = async (a) => {
    skipRef.current = true;
    setOpen(false); setActive(-1); setSugg([]);
    let resolved = a;
    if (a.needsRetrieve) {
      // Search Box suggestion → fetch coords + structured address. Each retrieve ends the Mapbox
      // session, so rotate the token afterwards.
      const full = await retrievePlace(a.id, { token, sessionToken: sessionRef.current });
      sessionRef.current = newSessionToken();
      if (full) resolved = full;
    }
    onSelect?.(resolved);
    onChangeText?.(resolved.line1 || resolved.full || resolved.label || a.label || '');
  };

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <input
        style={inputStyle}
        value={value || ''}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => onChangeText?.(e.target.value)}
        onFocus={() => { if (sugg.length) setOpen(true); }}
        onKeyDown={(e) => {
          if (!open || !sugg.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, sugg.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
          else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(sugg[active]); }
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && sugg.length > 0 && (
        <div style={{
          position: 'absolute', zIndex: 9999, top: '100%', left: 0, right: 0, marginTop: 4,
          background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 10,
          boxShadow: '0 10px 28px rgba(0,0,0,0.20)', overflow: 'hidden', maxHeight: 264, overflowY: 'auto',
        }}>
          {sugg.map((a, i) => (
            <div key={a.id} onMouseDown={(e) => { e.preventDefault(); choose(a); }} onMouseEnter={() => setActive(i)}
              style={{ padding: '9px 12px', cursor: 'pointer', fontSize: 13, lineHeight: 1.35, color: '#111827', background: i === active ? '#f3f4f6' : 'transparent', borderBottom: i < sugg.length - 1 ? '1px solid #f0f0f0' : 'none' }}>
              {a.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
