/**
 * KioskKeypad: the README 6 keypad (display, 1 to 9, Clear, 0, delete, confirm button).
 * Used for the table number fallback now and the phone number later.
 * Digits only; the value lives with the caller. placeholderMono draws the placeholder in
 * the display face (the phone "07 . . ." pattern); otherwise it is plain words.
 */
import { t } from '../../lib/i18n';
import { keypadNext } from '../../lib/kioskFlow';
import { DeleteKeyIcon } from './KioskIcons';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'del'];

export default function KioskKeypad({ value = '', onChange, maxLength, placeholder = '', placeholderMono = false, format, confirmLabel, canConfirm, onConfirm }) {
  const digits = typeof value === 'string' ? value : '';
  const shown = digits ? (typeof format === 'function' ? format(digits) : digits) : '';
  const enabled = canConfirm === undefined ? digits.length > 0 : !!canConfirm;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div
        aria-live="polite"
        style={{
          background: 'var(--k2Sunken)', border: '2px solid var(--k2Hairline)', borderRadius: 24, height: 120,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 24px',
          fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 46, fontWeight: 800, letterSpacing: '0.08em',
          // The phone pattern placeholder ('07 · · ·') is drawn in ink, as the prototype does.
          color: shown || placeholderMono ? 'var(--k2Ink)' : 'var(--k2InkSubtle)', whiteSpace: 'nowrap', overflow: 'hidden',
        }}
      >
        {shown || (placeholderMono
          ? placeholder
          : <span style={{ fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontSize: 34, fontWeight: 700, letterSpacing: 0 }}>{placeholder}</span>)}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
        {KEYS.map((k) => {
          const isDigit = k.length === 1;
          const label = k === 'clear' ? t('k2.keypad.clear') : k === 'del' ? null : k;
          return (
            <button
              key={k}
              type="button"
              aria-label={k === 'del' ? t('k2.keypad.delete') : undefined}
              onClick={() => onChange?.(keypadNext(digits, k, maxLength))}
              style={{
                border: 0, height: 104, borderRadius: 20, boxShadow: 'inset 0 0 0 2px var(--k2Hairline)',
                background: isDigit ? 'var(--k2Sunken)' : 'var(--k2Neutral)', color: 'var(--k2Ink)',
                fontSize: isDigit ? 38 : 24, fontWeight: 700, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {label ?? <DeleteKeyIcon size={36} />}
            </button>
          );
        })}
      </div>

      {confirmLabel ? (
        <button
          type="button"
          disabled={!enabled}
          onClick={() => { if (enabled) onConfirm?.(digits); }}
          style={{
            border: 0, height: 112, borderRadius: 26, fontSize: 30, fontWeight: 800,
            background: enabled ? 'var(--k2Primary)' : 'var(--k2Disabled)',
            color: enabled ? 'var(--k2OnPrimary)' : 'var(--k2InkOnDark)',
            cursor: enabled ? 'pointer' : 'default',
          }}
        >{confirmLabel}</button>
      ) : null}
    </div>
  );
}
