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

// 8 Oct 2026 (D5): a day with sales and no posting is 'missing' (red, with a Push button); a
// day with nothing to post is 'quiet'. Before this both read a grey "Not posted", and Leeds
// 30 Sep (143 sales) looked like a quiet Sunday for a week.
export const STATUS_LABEL = {
  posted: 'Posted', partly_posted: 'Partly posted', blocked: 'Blocked', failed: 'Failed', sending: 'Sending', waiting: 'Not posted',
  missing: 'Not posted', quiet: 'Nothing to post',
};
export const STATUS_COLOUR = {
  posted: ['rgba(46,143,78,.16)', '#2f8f4e'], partly_posted: ['rgba(200,150,40,.16)', '#c89628'], blocked: ['rgba(200,150,40,.16)', '#c89628'],
  failed: ['rgba(200,60,60,.16)', '#c33'], sending: ['rgba(80,120,200,.16)', '#4a6fc0'], waiting: ['rgba(120,120,120,.16)', 'var(--t3)'],
  missing: ['rgba(200,60,60,.16)', '#c33'], quiet: ['rgba(120,120,120,.16)', 'var(--t3)'],
};

/** The outline on a field ServOS filled in for the person to check. */
export const suggested = (on) => (on ? { outline: '2px solid rgba(200,150,40,.65)', outlineOffset: 1 } : undefined);

// ── a day's refunds on the screens (13 Oct 2026) ────────────────────────────────
// What the invoice preview and the Postings history say about a day's refunds is decided here,
// in one place, so it is tested (src/lib/accounting/xeroRefundLines.test.js): a new day has its
// refunds as minus lines on the invoice, a day that fell back and every day posted before this
// keep their credit note, and an answer from an older xero-sales (no refundWay) reads as before.

const LINE_KIND = { sales: 'Sales', discount: 'Discount', gift: 'Gift cards', tip: 'Tips', service: 'Service' };

/**
 * The words and choices of the invoice preview for one plan view (planView of xero-sales).
 * `tw` is 'VAT' or 'Tax'; `fmt` turns an amount into money as the screen shows it.
 *   asLines         the day's refunds are minus lines on the invoice
 *   note            the sentence under the invoice, only when its refunds are on it ('' otherwise)
 *   paymentsTitle   the heading of the payments on the invoice
 *   creditNote      the credit note to show, or null: a day with one always shows it
 *   refundPayments  its refund payments ([] on a day with none)
 *   refundTieTitle  the heading of the VAT per rate table of the refund side
 *   tagFor(line)    the small word under a line: 'Refund' only on a refund line
 */
export function previewWords(view, { tw = 'VAT', fmt = (n) => Number(n || 0).toFixed(2) } = {}) {
  const asLines = view?.refundWay === 'lines';
  return {
    asLines,
    note: asLines && view.invoice ? `Refunds are the minus lines at the end. Sales ${fmt(view.totals?.sales || 0)} less refunds ${fmt(view.totals?.refunds || 0)} makes the invoice total.` : '',
    paymentsTitle: asLines ? 'Payments on the invoice, takings less refunds (it shows as Paid)' : 'Payments on the invoice (it shows as Paid)',
    creditNote: view?.creditNote || null,
    refundPayments: view?.refundPayments || [],
    refundTieTitle: asLines ? `${tw} per rate on the refund lines` : `${tw} per rate on refunds`,
    tagFor: (line) => (line?.refund ? 'Refund' : (LINE_KIND[line?.kind] || line?.kind || '')),
  };
}

/**
 * The line an opened day shows in the Postings history when its refunds are on its invoice: only
 * once that invoice IS in Xero. A day Xero refused, or one whose answer was lost, says nothing
 * here (its own message says what happened); a credit note day never shows it.
 */
export const historyRefundNote = (d) => (d?.refundWay === 'lines' && d.postings?.INVOICE?.status === 'posted' ? 'Refunds are on the invoice as minus lines.' : '');
