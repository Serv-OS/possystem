// src/backoffice/sections/xero/PostingsHistory.jsx
//
// Postings history: one row per site per business day, with its status (Posted, Partly posted,
// Blocked, Failed, Sending, or Not posted), the documents it sent with Open in Xero links, its
// totals and warnings. Open a row to see exactly what was sent (the payloads saved with each
// posting). "All sites on this Xero" adds the other sites posting to the same organisation that
// you can open, so it is always clear which site posted what.
// 2 Oct 2026: a day posted the old way (bank transactions) at a site that now posts sales
// invoices shows "Replace with invoice" from the site's first invoice day on (xero/ReplaceDay.jsx:
// a preview first, then a confirm). An earlier day says to move the first invoice day back.

// 8 Oct 2026 (the VAT audit, D5): a day with sales and no posting shows in RED as "Not posted"
// with a Push button (xero-config 'gaps', _shared/xeroGaps.js markGaps); a day with nothing to
// post says so in grey. Leeds 30 Sep 2026 (143 sales) sat as a grey "Not posted" for a week, the
// same as a quiet day. Push posts that one day through xero-sales exactly as the Posting tab
// does; nothing posts by itself.

import { Fragment, useCallback, useEffect, useState } from 'react';
import { xeroHistory, xeroHistoryDetail, xeroGaps, xeroSyncSales } from '../../../lib/xero';
import { money } from '../../../lib/currency';
import { offerForRow } from '../../../../supabase/functions/_shared/xeroReplacePlan.js';
import { markGaps } from '../../../../supabase/functions/_shared/xeroGaps.js';
import { S, STATUS_LABEL, STATUS_COLOUR } from './xeroUi';
import { Bullets } from './controls';
import ReplaceDay from './ReplaceDay';

const DOC = { invoice: 'Invoice', credit_note: 'Credit note', payment: 'Payment', refund: 'Refund', bank: 'Bank' };

function Detail({ d, note }) {
  if (!d) return <div style={S.note}>Loading…</div>;
  const postings = Object.entries(d.postings || {});
  return (
    <div style={{ padding: '10px 4px' }}>
      {note && <div style={{ ...S.info, maxWidth: 'none' }}>{note}</div>}
      {d.error && <div style={{ ...S.banner(false), maxWidth: 'none' }}>{d.error}</div>}
      {(d.notReady || []).length > 0 && (
        <div style={{ ...S.banner(false), maxWidth: 'none' }}>
          Not ready: {(d.notReady || []).map((n) => n.message).join(' ')}
        </div>
      )}
      {postings.length === 0 && <div style={S.note}>Nothing was sent for this day.</div>}
      {postings.map(([k, p]) => (
        <details key={k} style={{ marginBottom: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 700, color: 'var(--t2)' }}>
            {DOC[p.type] || (k.startsWith('RECEIVE') ? 'Receive money' : k.startsWith('SPEND') ? 'Spend money' : k)} {p.number || p.reference || ''} · {p.status === 'posted' ? 'in Xero' : p.status === 'deleted' ? 'removed from Xero' : 'sent, answer not confirmed'}{p.total != null ? ` · ${Number(p.total).toFixed(2)}` : ''}
          </summary>
          {p.payload ? <pre style={S.pre}>{JSON.stringify(p.payload, null, 2)}</pre> : <div style={S.note}>Posted before ServOS kept the exact payload; the lines are shown below.</div>}
        </details>
      ))}
      {!postings.some(([, p]) => p.payload) && (d.lines || []).length > 0 && <pre style={S.pre}>{JSON.stringify(d.lines, null, 2)}</pre>}
      {(d.warnings || []).length > 0 && (
        <div style={S.warn}>{d.warnings.map((w, i) => <div key={`${w.code}${i}`} style={{ fontSize: 12.5, color: 'var(--t2)', marginTop: i ? 6 : 0 }}>{w.message}</div>)}</div>
      )}
    </div>
  );
}

/** Push one not posted day. The answer is shown under the row; the list reloads after it. */
function GapPush({ locationId, date, onDone }) {
  const [state, setState] = useState({ busy: false, words: '', ok: null });
  const push = async (e) => {
    e.stopPropagation();
    setState({ busy: true, words: '', ok: null });
    try {
      const r = await xeroSyncSales(locationId, date);
      const words = r?.already ? `Already in Xero for ${date}.` : r?.empty ? `No sales or refunds on ${date}. Nothing to post.` : `Posted ${date} to Xero.`;
      setState({ busy: false, words, ok: true });
      onDone?.();
    } catch (err) {
      setState({ busy: false, words: err?.message || 'Could not post the day', ok: false });
    }
  };
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <button style={{ ...S.small, marginTop: 4, borderColor: '#c33', color: '#c33' }} onClick={push} disabled={state.busy}>{state.busy ? 'Pushing…' : 'Push this day'}</button>
      {state.words && <div style={{ fontSize: 11.5, color: state.ok ? '#2f8f4e' : '#c33', marginTop: 4, maxWidth: 360 }}>{state.words}</div>}
    </div>
  );
}

export default function PostingsHistory({ locId, hasSiblings, currency, postMode, startDate }) {
  const [scope, setScope] = useState('site');
  const [data, setData] = useState(null);
  const [gaps, setGaps] = useState({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const [detail, setDetail] = useState(null);
  const [replacing, setReplacing] = useState(null);   // the day whose replace panel is open
  const load = useCallback(async () => {
    setBusy(true); setErr('');
    try {
      // The gap scan is read beside the history; a scan that fails leaves the history as it is.
      const [h, g] = await Promise.all([xeroHistory(locId, scope, 60), xeroGaps(locId, scope).catch(() => null)]);
      setData(h);
      setGaps(g?.gaps || {});
    } catch (e) { setErr(e.message || 'Could not load the postings'); } finally { setBusy(false); }
  }, [locId, scope]);
  useEffect(() => { load(); }, [load]);
  const toggle = async (r) => {
    const k = `${r.locationId}|${r.date}`;
    if (open === k) { setOpen(null); return; }
    setOpen(k); setDetail(null);
    try { setDetail(await xeroHistoryDetail(locId, r.date, r.locationId !== locId ? r.locationId : undefined)); } catch (e) { setDetail({ error: e.message || 'Could not load the day' }); }
  };
  const rows = markGaps(data?.rows || [], gaps);
  const multi = scope === 'org';
  const gapCount = rows.filter((r) => r.status === 'missing').length;
  // Only this site's own days: its posting model and first invoice day are the ones known here.
  const offerFor = (r) => (r.locationId === locId ? offerForRow(r, { postMode, startDate }) : { show: 'none', text: '' });
  return (
    <div style={S.wide}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={S.h2}>Postings</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {hasSiblings && (
            <select value={scope} onChange={(e) => setScope(e.target.value)} style={{ border: '1px solid var(--bdr2)', borderRadius: 9, padding: '7px 10px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)' }}>
              <option value="site">This site</option>
              <option value="org">All sites on this Xero</option>
            </select>
          )}
          <button style={S.small} onClick={load} disabled={busy}>{busy ? 'Loading…' : 'Refresh'}</button>
        </div>
      </div>
      <Bullets style={{ marginBottom: 10 }} items={[
        ['The last 60 business days.', 'Open a day to see exactly what was sent.'],
        ['Not posted in red', 'means the day had sales and nothing reached Xero. Press Push on that day. Nothing posts by itself.'],
        ['Nothing to post', 'means no sales that day.'],
        ['Card payouts', 'for these days are under Card payments, Payouts.'],
      ]} />
      {err && <div style={S.banner(false)}>{err}</div>}
      {gapCount > 0 && <div style={{ ...S.banner(false), maxWidth: 'none' }}>{gapCount === 1 ? '1 day with sales is not in Xero.' : `${gapCount} days with sales are not in Xero.`} Press Push on each one below.</div>}
      {!busy && !rows.length && !err && <div style={S.note}>Nothing posted yet.</div>}
      {rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Day</th>{multi && <th style={S.th}>Site</th>}<th style={S.th}>Posted as</th><th style={S.th}>Status</th><th style={S.th}>In Xero</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Sales</th><th style={{ ...S.th, textAlign: 'right' }}>Refunds</th><th style={{ ...S.th, textAlign: 'right' }}>VAT</th><th style={S.th}>Warnings</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const k = `${r.locationId}|${r.date}`;
                const [bg, fg] = STATUS_COLOUR[r.status] || STATUS_COLOUR.failed;
                const offer = offerFor(r);
                return (
                  <Fragment key={k}>
                    <tr onClick={() => r.status !== 'waiting' && r.status !== 'quiet' && r.status !== 'missing' && toggle(r)} style={{ cursor: r.status !== 'waiting' && r.status !== 'quiet' && r.status !== 'missing' ? 'pointer' : 'default' }}>
                      <td style={S.td}>{r.date}</td>
                      {multi && <td style={S.td}>{r.site}</td>}
                      <td style={S.td}>{r.model === 'sales_invoice' ? 'Sales invoice' : 'Bank transactions'}</td>
                      <td style={S.td}><span style={S.pill(bg, fg)}>{STATUS_LABEL[r.status] || r.status}</span></td>
                      <td style={S.td}>
                        {(r.documents || []).filter((d) => d.link).map((d) => (
                          <div key={`${d.type}${d.xeroId}`}><a href={d.link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: 'var(--acc)', fontWeight: 700, textDecoration: 'none' }}>{d.type === 'bank' ? (d.direction === 'refunds' ? 'Spend money' : 'Receive money') : `${DOC[d.type] || d.type} ${d.number || ''}`} ↗</a></div>
                        ))}
                        {r.status === 'blocked' && r.notReady && <div style={{ fontSize: 11.5, color: 'var(--t3)' }}>{r.notReady.map((n) => n.message).join(' ')}</div>}
                        {r.status === 'failed' && r.error && <div style={{ fontSize: 11.5, color: 'var(--t3)' }}>{String(r.error).slice(0, 160)}</div>}
                        {r.gap && (
                          <div style={{ fontSize: 11.5, color: '#c33' }}>{r.gap.sales === 1 ? '1 sale' : `${r.gap.sales} sales`}, {money(r.gap.gross, currency)}, not in Xero</div>
                        )}
                        {r.gap && <GapPush locationId={r.locationId} date={r.date} onDone={load} />}
                        {offer.show === 'button' && replacing !== k && (
                          <button style={{ ...S.small, marginTop: 4 }} onClick={(e) => { e.stopPropagation(); setReplacing(k); }}>Replace with invoice</button>
                        )}
                      </td>
                      <td style={S.num}>{r.totals?.sales != null ? money(r.totals.sales, currency) : ''}</td>
                      <td style={S.num}>{r.totals?.refunds ? money(r.totals.refunds, currency) : ''}</td>
                      <td style={S.num}>{r.totals?.vat != null ? money(r.totals.vat, currency) : ''}</td>
                      <td style={S.td}>{r.warnings || ''}</td>
                    </tr>
                    {replacing === k && (
                      <tr><td colSpan={multi ? 9 : 8} style={{ ...S.td, background: 'var(--bg2)' }}>
                        {offer.show === 'button' && <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', margin: '4px 0 8px' }}>{offer.text}</div>}
                        <ReplaceDay locId={locId} date={r.date} currency={currency} autoPreview onAttempt={load} onCancel={() => setReplacing(null)} />
                      </td></tr>
                    )}
                    {open === k && (
                      <tr><td colSpan={multi ? 9 : 8} style={{ ...S.td, background: 'var(--bg2)' }}><Detail d={detail} note={offer.show === 'note' ? offer.text : ''} /></td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
