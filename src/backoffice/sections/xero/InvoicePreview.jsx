// src/backoffice/sections/xero/InvoicePreview.jsx
//
// The daily sales invoice as it would be (Check figures) or was (a post) sent to Xero: the
// header, every line with its account, VAT code, amount and VAT, the payments into clearing
// accounts, and the VAT per rate against what the till booked. The exact JSON is one click away,
// so an accountant can see precisely what Xero receives. Where tax is added on top of prices
// (US, Exclusive) the words are "tax", not "VAT".
// 13 Oct 2026: the day's refunds are minus lines at the end of the invoice (view.refundWay
// 'lines'), each marked Refund, and the payments are takings less refunds. The credit note and
// refund payment blocks stay for a day whose refunds could not go on its invoice and for days
// posted before this. An older xero-sales sends no refundWay: the screen then reads as before.
// What is said and when is decided in previewWords (xeroUi.js), where it is tested.

import { money } from '../../../lib/currency';
import { dayLabel } from '../../../../supabase/functions/_shared/xeroInvoicePlan.js';
import { S, findAccount, accountLabel, previewWords } from './xeroUi';

function Lines({ lines, accounts, cur, tw, tagFor }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>Line</th><th style={S.th}>Account</th><th style={S.th}>{tw} code</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Amount{tw === 'Tax' ? ' before tax' : ''}</th><th style={{ ...S.th, textAlign: 'right' }}>{tw} sent</th><th style={{ ...S.th, textAlign: 'right' }}>Xero would work out</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const a = findAccount(accounts, l.account);
            return (
              <tr key={i}>
                <td style={S.td}>{l.description}<div style={{ fontSize: 11, color: 'var(--t4)' }}>{tagFor(l)}</div></td>
                <td style={S.td}>{a ? accountLabel(a) : (l.account || <b style={{ color: '#c33' }}>No account chosen</b>)}</td>
                <td style={S.td}>{l.taxType || <b style={{ color: '#c33' }}>No Xero rate</b>}</td>
                <td style={S.num}>{money(tw === 'Tax' ? Math.round((l.amount - l.vat) * 100) / 100 : l.amount, cur)}</td>
                <td style={S.num}>{money(l.vat, cur)}</td>
                <td style={{ ...S.num, color: Math.abs((l.xeroVat || 0) - (l.vat || 0)) > 0.005 ? '#c89628' : 'var(--t3)' }}>{money(l.xeroVat || 0, cur)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Payments({ list, accounts, cur, title }) {
  if (!list?.length) return null;
  return (
    <>
      <div style={S.h3}>{title}</div>
      <table style={S.table}>
        <tbody>
          {list.map((p) => {
            const a = findAccount(accounts, p.account);
            return (
              <tr key={p.key}>
                <td style={S.td}>{p.reference}</td>
                <td style={S.td}>{a ? accountLabel(a) : p.account}</td>
                <td style={S.num}>{money(p.amount, cur)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function Doc({ doc, title, date, view, accounts, cur, tw, tagFor }) {
  if (!doc) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <div style={S.h2}>{title} {doc.number}</div>
        <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--t1)' }}>{money(doc.total, cur)}</div>
      </div>
      <div style={{ ...S.note, marginBottom: 8 }}>
        To <b>{doc.contactName}</b> · Reference &ldquo;{doc.reference}&rdquo; · Dated {dayLabel(date)} · Amounts {doc.lineAmountTypes === 'Exclusive' ? 'before tax, tax added' : 'include VAT'}
        {view.tracking ? <> · Tracking <b>{view.tracking}</b> on every line</> : <> · No tracking</>}
      </div>
      <Lines lines={doc.lines} accounts={accounts} cur={cur} tw={tw} tagFor={tagFor} />
    </div>
  );
}

/** The plan view from xero-sales (planView), with the day's warnings and what stops it. */
export default function InvoicePreview({ result, accounts = [], currency }) {
  const view = result?.invoice;
  if (!view) return null;
  const cur = currency || result?.currency;
  const date = result?.date;
  const tw = view.invoice?.lineAmountTypes === 'Exclusive' || view.creditNote?.lineAmountTypes === 'Exclusive' ? 'Tax' : 'VAT';
  const sales = (view.vatTie || []).filter((t) => t.side === 'sales');
  const refunds = (view.vatTie || []).filter((t) => t.side === 'refunds');
  const tie = (rows, title) => (rows.length ? (
    <>
      <div style={S.h3}>{title}</div>
      <table style={S.table}>
        <thead><tr><th style={S.th}>ServOS rate</th><th style={S.th}>Xero rate</th><th style={{ ...S.th, textAlign: 'right' }}>Till {tw === 'Tax' ? 'tax' : 'VAT'}</th><th style={{ ...S.th, textAlign: 'right' }}>Invoice {tw === 'Tax' ? 'tax' : 'VAT'}</th><th style={S.th} /></tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={`${t.side}${t.key}`}>
              <td style={S.td}>{t.label}{t.pct != null ? ` (${t.pct}%)` : ''}</td>
              <td style={S.td}>{t.taxType || <b style={{ color: '#c33' }}>none</b>}</td>
              <td style={S.num}>{money(t.tillVat, cur)}</td>
              <td style={S.num}>{money(t.invoiceVat, cur)}</td>
              <td style={{ ...S.td, color: Math.abs(t.tillVat - t.invoiceVat) < 0.005 ? '#2f8f4e' : '#c33', fontWeight: 800 }}>{Math.abs(t.tillVat - t.invoiceVat) < 0.005 ? '✓ ties' : 'differs'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  ) : null);
  const problems = result.problems || [];
  const notReady = result.notReady || [];
  // Refunds on the invoice as minus lines (13 Oct 2026). No refundWay from an older server: as before.
  const words = previewWords(view, { tw, fmt: (n) => money(n, cur) });
  return (
    <div>
      {(problems.length > 0 || notReady.length > 0) && (
        <div style={{ ...S.banner(false), maxWidth: 'none' }}>
          <div>This day would not be sent yet:</div>
          <ul style={{ margin: '6px 0 0 18px', padding: 0, fontWeight: 600 }}>
            {[...problems, ...notReady].map((p, i) => <li key={`${p.code}${i}`}>{p.message}</li>)}
          </ul>
        </div>
      )}
      <Doc doc={view.invoice} title="Sales invoice" date={date} view={view} accounts={accounts} cur={cur} tw={tw} tagFor={words.tagFor} />
      {words.note && <div style={{ ...S.note, marginTop: 8 }}>{words.note}</div>}
      <Payments list={view.payments} accounts={accounts} cur={cur} title={words.paymentsTitle} />
      <Doc doc={words.creditNote} title="Credit note for refunds" date={date} view={view} accounts={accounts} cur={cur} tw={tw} tagFor={words.tagFor} />
      <Payments list={words.refundPayments} accounts={accounts} cur={cur} title="Refund payments" />
      {tie(sales, `${tw} per rate: the till against the invoice`)}
      {tie(refunds, words.refundTieTitle)}
      {!view.invoice && !view.creditNote && <div style={S.note}>Nothing to send for this day.</div>}
      {(result.warnings || []).length > 0 && (
        <div style={S.warn}>
          {result.warnings.map((w, i) => (
            <div key={`${w.code}${i}`} style={{ fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.5, marginTop: i ? 6 : 0 }}><b>{w.count ? `${w.count} × ` : ''}</b>{w.message}</div>
          ))}
        </div>
      )}
      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 700, color: 'var(--t2)' }}>Exactly what Xero receives</summary>
        <pre style={S.pre}>{JSON.stringify({
          invoice: view.invoice?.payload || null,
          payments: (view.payments || []).map((p) => p.payload),
          creditNote: view.creditNote?.payload || null,
          refundPayments: (view.refundPayments || []).map((p) => p.payload),
        }, null, 2)}</pre>
        <div style={S.note}>Payments name the invoice by its number here; when sent, Xero&rsquo;s own id for the invoice is used.</div>
      </details>
    </div>
  );
}
