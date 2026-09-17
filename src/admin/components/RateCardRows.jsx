// src/admin/components/RateCardRows.jsx
//
// The ONE rate card editor (10 Sep 2026): one row per payment type, a percent
// and pence each, and the live effective value with where it comes from. Used
// by the Processing page (the platform defaults and each venue's Card rates)
// and by the go live flow's step 5 (Edit rates), so the two can never drift.
// Pure shape work lives in src/lib/payments/rateCard.js.
//
// OWNER RULE (10 Sep 2026): "we set the rate that customers get charged for
// the different card types". Plain words, no dashes, no id in a sentence.
//
// CREDIT AND DEBIT APART (17 Sep 2026): six rows. A blank debit row uses the
// credit row above it, so nothing changes for a venue until a debit rate is
// typed. What applies is drawn GREY when the row is blank (the value is
// inherited) and in the accent colour when it is typed here.
//
// Props:
//   value        editor state { tier: { percent, fixed_pence } } (strings)
//   onChange     (next) => void
//   fallbackFor  (tierId, 'percent' | 'fixed_pence') => { value, label }: what
//                applies when the input is blank (the platform default, the
//                legacy flat rate), value null when nothing does. The debit
//                rows walk their credit row first (rateCard.js rowFallback)
//   currency     'GBP' | 'USD': pence or cents in the labels
//   big          15px inputs, headers, notes and labels (the owner rule: body
//                text 15px or more). Both the go live flow and Processing
//                pass it; the small size is kept only for any older caller
//   debitReady   the server can keep a debit rate (rateCard.js
//                serverKnowsDebit). False keeps the two debit rows read only
//                with one plain line, because an older server would drop a
//                typed debit rate in silence. Default false

import { RATE_CARD_TIERS, DEBIT_ROW_NOTES, DEBIT_NOT_READY_NOTE, fmtRate, rowView } from '../../lib/payments/rateCard';

const GRID = 'minmax(180px, 1.4fr) 1fr 1fr minmax(150px, 1.2fr)';

export default function RateCardRows({ value, onChange, fallbackFor, currency = 'GBP', big = false, debitReady = false }) {
  const v = value && typeof value === 'object' ? value : {};
  const minor = String(currency || '').toUpperCase() === 'USD' ? 'cents' : 'pence';
  const size = big ? 15 : 13;
  const head = { fontSize: big ? 15 : 11, fontWeight: 700, color: 'var(--t3)', textTransform: big ? 'none' : 'uppercase', letterSpacing: big ? 0 : '.06em' };
  const input = {
    width: '100%', boxSizing: 'border-box', padding: big ? '10px 12px' : '8px 10px', borderRadius: 8,
    border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: size,
    fontFamily: 'var(--font-mono, monospace)', outline: 'none', minHeight: big ? 44 : undefined,
  };
  const note = { fontSize: big ? 15 : 12, color: 'var(--t3)', lineHeight: 1.5, margin: 0 };
  const setField = (tierId, field, next) => onChange({ ...v, [tierId]: { ...(v[tierId] ?? { percent: '', fixed_pence: '' }), [field]: next } });
  return (
    <div style={{ display: 'grid', gap: big ? 12 : 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 10, alignItems: 'center' }}>
        <span style={head}>Payment type</span>
        <span style={head}>Rate %</span>
        <span style={head}>Per payment ({minor})</span>
        <span style={head}>What applies</span>
      </div>
      {RATE_CARD_TIERS.map((t) => {
        const row = v[t.id] ?? { percent: '', fixed_pence: '' };
        const view = rowView(v, t.id, fallbackFor);
        const locked = !!t.base && !debitReady;
        const rowInput = locked ? { ...input, opacity: 0.55, cursor: 'not-allowed' } : input;
        // Typed here reads in the accent colour; an inherited value is grey.
        const valueColor = view.nothing ? 'var(--t4)' : view.typed ? 'var(--acc)' : 'var(--t3)';
        return (
          <div key={t.id} style={{ display: 'grid', gridTemplateColumns: GRID, gap: 10, alignItems: 'center' }}>
            <span style={{ fontSize: size, color: 'var(--t1)', fontWeight: 600, lineHeight: 1.4 }}>
              {t.label}
              {t.note && <span style={{ display: 'block', fontSize: big ? 15 : 11, color: 'var(--t3)', fontWeight: 400 }}>{t.note}</span>}
            </span>
            <input
              type="number" step="0.01" min="0" max="100" value={row.percent}
              aria-label={`${t.label} rate percent`}
              placeholder={view.placeholderPct}
              disabled={locked}
              onChange={(e) => setField(t.id, 'percent', e.target.value)}
              style={rowInput}
            />
            <input
              type="number" step="1" min="0" max="10000" value={row.fixed_pence}
              aria-label={`${t.label} ${minor} per payment`}
              placeholder={view.placeholderFix}
              disabled={locked}
              onChange={(e) => setField(t.id, 'fixed_pence', e.target.value)}
              style={rowInput}
            />
            <div style={{ fontSize: big ? 15 : 12, color: view.nothing ? 'var(--t4)' : 'var(--t2)', lineHeight: 1.4 }}>
              <strong style={{ color: valueColor }}>{fmtRate(view.effPct, view.effFix, currency)}</strong>
              {view.source && <span style={{ color: 'var(--t4)' }}> {view.source}</span>}
            </div>
          </div>
        );
      })}
      <div style={{ display: 'grid', gap: 4, marginTop: 2 }}>
        {debitReady
          ? DEBIT_ROW_NOTES.map((l) => <p key={l} style={note}>{l}</p>)
          : <p style={note}>{DEBIT_NOT_READY_NOTE}</p>}
      </div>
    </div>
  );
}
