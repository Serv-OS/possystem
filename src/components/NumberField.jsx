// NumberField — a quantity or price box that shows the whole number and says its unit.
//
// v5.11.65 (15 Oct 2026 stock audit): the stock screens used <input type="number"> boxes 64 to
// 84px wide with 24px of padding and a browser spinner inside, so "12.55" was clipped to "12.5"
// and "3.09" to "3.0" with the spinner drawn over the last digit (Peter's "3.0S" screenshot),
// and the unit sat outside the box as separate grey text. This is one bordered box: a text
// input with a numeric keypad (type="text" means no spinner on any browser), tabular digits so
// columns line up, a minimum width that fits "1250.00", and the unit inside the box as a suffix.
//
// It reports the typed STRING through onChange(value) (not an event), so callers keep their
// own parsing: '' is empty, never 0. Digits, one decimal point (a comma is read as one) and,
// when allowNegative, a leading minus are the only characters kept.
export default function NumberField({
  value, onChange, onBlur, unit, width = 112, disabled = false, placeholder = '0', title, autoFocus,
  allowNegative = false, tone, style, inputStyle,
}) {
  const handle = (raw) => {
    let s = String(raw ?? '').replace(',', '.');
    s = s.replace(allowNegative ? /[^0-9.-]/g : /[^0-9.]/g, '');
    if (allowNegative) s = s.replace(/(?!^)-/g, '');
    const firstDot = s.indexOf('.');
    if (firstDot >= 0) s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, '');
    onChange?.(s);
  };
  const border = tone === 'warn' ? 'var(--amber, #F5A623)' : tone === 'bad' ? 'var(--red-b, var(--red))' : 'var(--bdr)';
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', minWidth: width, width, boxSizing: 'border-box',
      background: 'var(--bg2)', border: `1px solid ${border}`, borderRadius: 8, padding: '0 10px',
      opacity: disabled ? 0.6 : 1, ...style,
    }}>
      <input
        type="text" inputMode="decimal" autoComplete="off" autoFocus={autoFocus}
        value={value ?? ''} disabled={disabled} placeholder={placeholder}
        onChange={(e) => handle(e.target.value)} onBlur={onBlur}
        style={{
          flex: 1, minWidth: 0, width: '100%', background: 'transparent', border: 0, outline: 'none',
          color: 'var(--t1)', fontSize: 14, padding: '8px 0', textAlign: 'right', fontFamily: 'inherit',
          fontVariantNumeric: 'tabular-nums', ...inputStyle,
        }} />
      {unit ? <span style={{ fontSize: 11, color: 'var(--t3)', marginLeft: 6, whiteSpace: 'nowrap', flexShrink: 0 }}>{unit}</span> : null}
    </span>
  );
}
