// src/backoffice/sections/xero/xeroUi.js
//
// Shared look for the Back Office Xero screens (XeroIntegration.jsx and the xero/ tabs):
// styles and small pure helpers. Plain JS, no components.

export const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  h2: { fontSize: 15, fontWeight: 800, color: 'var(--t1)', margin: '0 0 6px' },
  h3: { fontSize: 13, fontWeight: 800, color: 'var(--t1)', margin: '16px 0 4px' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18, maxWidth: 620, lineHeight: 1.5 },
  card: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 20, marginBottom: 14, maxWidth: 620 },
  wide: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 20, marginBottom: 14, maxWidth: 980 },
  btn: { padding: '11px 18px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 800, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  ghost: { padding: '9px 14px', borderRadius: 9, cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  small: { padding: '6px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  note: { fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.55 },
  pill: (bg, fg) => ({ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 800, background: bg, color: fg }),
  banner: (ok) => ({ padding: '10px 14px', borderRadius: 10, fontSize: 13, fontWeight: 700, marginBottom: 14, maxWidth: 620, background: ok ? 'rgba(46,143,78,.14)' : 'rgba(200,60,60,.14)', color: ok ? '#2f8f4e' : '#c33', border: `1px solid ${ok ? 'rgba(46,143,78,.3)' : 'rgba(200,60,60,.3)'}` }),
  info: { padding: '10px 14px', borderRadius: 10, fontSize: 13, fontWeight: 600, marginBottom: 14, maxWidth: 620, background: 'rgba(80,120,200,.12)', color: 'var(--t2)', border: '1px solid rgba(80,120,200,.3)' },
  warn: { marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'rgba(200,150,40,.12)', border: '1px solid rgba(200,150,40,.3)' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 },
  th: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--bdr)', color: 'var(--t3)', fontWeight: 700, whiteSpace: 'nowrap' },
  td: { padding: '6px 8px', borderBottom: '1px solid var(--bdr)', color: 'var(--t1)', verticalAlign: 'top' },
  num: { padding: '6px 8px', borderBottom: '1px solid var(--bdr)', color: 'var(--t1)', textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
  pre: { fontSize: 11.5, background: 'var(--bg2)', border: '1px solid var(--bdr2)', borderRadius: 8, padding: 10, overflow: 'auto', maxHeight: 360, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
};

/** The main button, greyed out when it cannot be pressed. */
export const btn = (off) => ({ ...S.btn, opacity: off ? 0.45 : 1, cursor: off ? 'not-allowed' : 'pointer' });

export const sel = { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 9, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' };
export const input = { ...sel };
export const fieldRow = { display: 'grid', gridTemplateColumns: '180px 1fr', gap: 12, alignItems: 'center', marginBottom: 10 };
export const flabel = { fontSize: 12.5, fontWeight: 700, color: 'var(--t2)' };

/** An account as a select shows it. */
export const accountLabel = (a) => (a ? `${a.code ? `${a.code} · ` : ''}${a.name}` : '');

/** The account a saved value names (a code, or an id for accounts with no code). */
export function findAccount(accounts, ref) {
  const v = String(ref || '').trim();
  if (!v) return null;
  return (accounts || []).find((a) => a.id === v || (a.code && a.code.toUpperCase() === v.toUpperCase())) || null;
}

/** The value a select saves for an account: its code, else its id. */
export const accountRef = (a) => (a ? (a.code || a.id) : '');

/** Accounts that can receive a payment in Xero: bank accounts, or "Enable payments to this account". */
export const canTakePayments = (a) => !!a && (a.bank || String(a.type || '').toUpperCase() === 'BANK' || a.pay === true);

export const STATUS_LABEL = {
  posted: 'Posted', partly_posted: 'Partly posted', blocked: 'Blocked', failed: 'Failed', sending: 'Sending', waiting: 'Not posted',
};
export const STATUS_COLOUR = {
  posted: ['rgba(46,143,78,.16)', '#2f8f4e'], partly_posted: ['rgba(200,150,40,.16)', '#c89628'], blocked: ['rgba(200,150,40,.16)', '#c89628'],
  failed: ['rgba(200,60,60,.16)', '#c33'], sending: ['rgba(80,120,200,.16)', '#4a6fc0'], waiting: ['rgba(120,120,120,.16)', 'var(--t3)'],
};

/** The outline on a field ServOS filled in for the person to check. */
export const suggested = (on) => (on ? { outline: '2px solid rgba(200,150,40,.65)', outlineOffset: 1 } : undefined);
