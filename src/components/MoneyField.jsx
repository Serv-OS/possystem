import { useState, useEffect, useRef } from 'react';

// Money input that EDITS in pounds but REPORTS minor units (pennies). It keeps the raw
// typed text instead of round-tripping pounds→minor→pounds on every keystroke — that
// round-trip is what ate the decimal point, forced a leading "0", and jumped the cursor.
//
// - Blank shows blank (not "0"); reports null.
// - Accepts decimals ("3.5", "0.50") and a comma as the decimal separator.
// - Re-syncs from the prop only when the field isn't being edited (so loading config or a
//   parent recompute still updates it, without fighting the user mid-type).
// - inputMode="decimal" gives a numeric keypad on tablets / the Sunmi.
export default function MoneyField({ valueMinor, onMinor, style, placeholder = '0.00', disabled }) {
  const toText = (m) => (m == null ? '' : (m / 100).toString());
  const [text, setText] = useState(() => toText(valueMinor));
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setText(toText(valueMinor));
  }, [valueMinor]);

  const handle = (rawIn) => {
    const raw = rawIn.replace(',', '.');
    if (raw !== '' && !/^\d*\.?\d{0,2}$/.test(raw)) return;   // digits, one optional dot, ≤2 dp
    setText(raw);
    if (raw === '' || raw === '.') { onMinor(null); return; }
    const minor = Math.round(parseFloat(raw) * 100);
    onMinor(Number.isFinite(minor) ? minor : null);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      disabled={disabled}
      style={style}
      placeholder={placeholder}
      value={text}
      onFocus={() => { editing.current = true; }}
      onBlur={() => { editing.current = false; setText(toText(valueMinor)); }}
      onChange={(e) => handle(e.target.value)}
    />
  );
}
