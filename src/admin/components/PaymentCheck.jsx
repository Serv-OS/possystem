// src/admin/components/PaymentCheck.jsx
//
// "Check a payment" on the Revenue page (10 Sep 2026). OWNER BRIEF: "tell me
// how £1 is broken down at 0.8% + 5p where I can see what the customer has
// paid and that equals that and then how much we made on that transaction",
// "I need this proven not just calculations I need to see it on the back
// office", "we should be making on both % + txn".
//
// Pick a venue, pick one of its card payments, and the box shows Adyen's OWN
// records for it: where the money went, what ServOS made, and the percent and
// fixed parts. The server (adyen-terminal-admin payment_list and
// payment_breakdown, super_admin only, read only) reads the payment row, the
// split rule on the venue store, the Balance Platform transfers and the
// FranPOS rate; _shared/paymentBreakdown.ts (mirror of
// src/lib/payments/paymentBreakdown.js) puts them together.
//
// STATES: ok and mismatch show the tables; waiting (Adyen has not booked it)
// and incomplete (some of Adyen's records could not be read) show one
// sentence and Check again, never a money gap built from half the records.
//
// SCREEN RULES (owner): 15px text (13px only for the small grey source words
// and the bracketed Adyen term), plain words, short sentences, no dashes,
// Adyen ids only on grey monospace rows with Copy, one plain sentence per
// problem with the raw detail behind Show detail, one primary button per box.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, platformSupabase } from '../../lib/supabase';
import { formatMinor, SOURCE_WORDS } from '../../lib/payments/paymentBreakdown';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

async function authToken() {
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  if (!token) {
    const err = new Error('Sign in again to check payments.');
    err.status = 401;
    throw err;
  }
  return token;
}

// One plain sentence for any failure, the raw answer kept as detail.
function plainError(res, j, fallback) {
  const raw = j?.detail || j?.error || `HTTP ${res.status}`;
  let text = fallback;
  if (res.status === 401) text = 'Sign in again to check payments.';
  else if (res.status === 403) text = 'Only a ServOS admin can check payments.';
  else if (j?.error && /[.!?]$/.test(String(j.error)) && !/_/.test(String(j.error))) text = String(j.error);
  const err = new Error(text);
  err.detail = raw === text ? null : String(raw);
  err.status = res.status;
  return err;
}

// fallback: the sentence for THIS action when the server gives no plain one.
async function callTerminalAdmin(venue, action, payload, fallback) {
  const token = await authToken();
  const res = await fetch(`${FUNCTIONS_URL}/adyen-terminal-admin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ops_location_id: venue.ops_location_id || venue.id, location_id: venue.id, ...payload }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) throw plainError(res, j, fallback);
  return j;
}

async function callPaymentsAdmin(action, payload) {
  const token = await authToken();
  const res = await fetch(`${FUNCTIONS_URL}/payments-admin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...payload }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw plainError(res, j, 'The venues could not be read.');
  return j;
}

const S = {
  card:   { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: 'var(--sh)' },
  title:  { fontSize: 19, fontWeight: 800, color: 'var(--t1)', margin: 0, marginBottom: 6 },
  body:   { fontSize: 15, color: 'var(--t2)', lineHeight: 1.5, margin: 0 },
  label:  { fontSize: 15, fontWeight: 700, color: 'var(--t2)', display: 'block', marginBottom: 6 },
  select: { padding: '9px 12px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit', minWidth: 260, maxWidth: '100%' },
  h2:     { fontSize: 17, fontWeight: 800, color: 'var(--t1)', margin: '22px 0 8px' },
  // 13px ONLY for the small grey source words and the bracketed Adyen term.
  grey:   { fontSize: 13, color: 'var(--t3)' },
  rate:   { fontSize: 15, color: 'var(--t2)' },
  quiet:  { fontSize: 15, color: 'var(--t3)' },
  prim:   { padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 15, fontWeight: 700, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  link:   { background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontSize: 15, fontWeight: 700, fontFamily: 'inherit', color: 'var(--acc)' },
  bad:    { padding: 12, background: 'var(--red-d)', color: 'var(--red)', borderRadius: 8, fontSize: 15, border: '1px solid var(--red-b)', lineHeight: 1.5, marginTop: 12 },
  warn:   { padding: 12, background: 'var(--orn-d, rgba(230,160,60,.12))', color: 'var(--orn, #e8a020)', borderRadius: 8, fontSize: 15, border: '1px solid var(--orn-b, var(--bdr2))', lineHeight: 1.5, marginTop: 12 },
  good:   { color: 'var(--grn)', fontWeight: 700 },
  idRow:  { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderTop: '1px solid var(--bdr)', flexWrap: 'wrap' },
  idVal:  { fontFamily: 'var(--font-mono, monospace)', fontSize: 15, color: 'var(--t3)', wordBreak: 'break-all' },
  copy:   { background: 'transparent', border: '1px solid var(--bdr2)', borderRadius: 6, padding: '3px 9px', cursor: 'pointer', fontSize: 15, color: 'var(--t2)', fontFamily: 'inherit' },
};

// Green for money made, red for a loss.
const moneyColour = (minor) => (Number(minor) < 0 ? 'var(--red)' : 'var(--grn)');

// A date and time in the venue's own time zone: "10 Sep, 15:29".
function whenText(iso, timeZone) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return 'Not known';
  const opts = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false };
  try { return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: timeZone || 'UTC' }).format(d); }
  catch { return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(d); }
}

function Source({ kind }) {
  if (!kind) return null;
  return <span style={{ ...S.grey, whiteSpace: 'nowrap' }}>{SOURCE_WORDS[kind] || kind}</span>;
}

// One plain sentence, the raw answer behind Show detail.
function Problem({ text, detail, tone = 'bad' }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div style={tone === 'warn' ? S.warn : S.bad}>
      <div>{text}</div>
      {detail && (
        <>
          <button type="button" style={{ ...S.link, color: 'inherit', marginTop: 6 }} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide detail' : 'Show detail'}
          </button>
          {open && <div style={{ ...S.idVal, color: 'inherit', marginTop: 6, whiteSpace: 'pre-wrap' }}>{detail}</div>}
        </>
      )}
    </div>
  );
}

// An Adyen id on its own grey row, with Copy. Never inside a sentence.
function IdLine({ label, term, id }) {
  const [copied, setCopied] = useState(false);
  if (!id) return null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(String(id)); setCopied(true); setTimeout(() => setCopied(false), 1400); }
    catch { /* clipboard blocked: the id is on screen to read */ }
  };
  return (
    <div style={S.idRow}>
      <span style={{ fontSize: 15, color: 'var(--t2)', minWidth: 190 }}>
        {label}{term ? <span style={S.grey}> ({term})</span> : null}
      </span>
      <span style={S.idVal}>{id}</span>
      <button type="button" style={S.copy} onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

// A short money table: label (with its detail under it), amount, source word.
// A bold row is the answer: green when money was made, red for a loss.
function MoneyRows({ rows, currency }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 2fr) minmax(90px, 1fr) minmax(120px, 1fr)', gap: '0 16px', maxWidth: 620 }}>
      {rows.map((r) => (
        <div key={r.key} style={{ display: 'contents' }}>
          <div style={{ padding: '8px 0', borderTop: '1px solid var(--bdr)', fontSize: 15, color: 'var(--t1)', fontWeight: r.bold ? 800 : 400 }}>
            {r.label}
            {r.detail && <div style={{ ...S.rate, fontWeight: 400 }}>{r.detail}</div>}
          </div>
          <div style={{ padding: '8px 0', borderTop: '1px solid var(--bdr)', fontSize: r.bold ? 17 : 15, fontWeight: r.bold ? 800 : 600, color: r.bold ? moneyColour(r.minor) : 'var(--t1)', textAlign: 'right' }}>
            {formatMinor(r.minor, currency)}
          </div>
          <div style={{ padding: '10px 0 8px', borderTop: '1px solid var(--bdr)' }}><Source kind={r.source} /></div>
        </div>
      ))}
    </div>
  );
}

// The notes and warnings, ABOVE the tables so the reason is read first.
function Notes({ data, withProblems }) {
  const b = data?.breakdown;
  return (
    <>
      {[...(data?.notes || []), ...(b?.warnings || [])].map((w) => <Problem key={w} text={w} tone="warn" />)}
      {withProblems && (data?.problems || []).map((p) => <Problem key={`${p.text}${p.detail}`} text={p.text} detail={p.detail} tone="warn" />)}
    </>
  );
}

// Every problem behind the one "could not be read" sentence, for Show detail.
const problemDetail = (data) => (data?.problems || [])
  .map((p) => [p.text, p.detail].filter(Boolean).join('\n'))
  .join('\n\n') || null;

function Breakdown({ data }) {
  const [showRefs, setShowRefs] = useState(false);
  const b = data?.breakdown;
  if (!b) return null;
  const cur = b.currency;
  const line = (key) => (b.lines || []).find((l) => l.key === key) || null;
  const paid = line('customer_paid');
  const fee = line('venue_fee');
  const tip = line('tip');
  const surcharge = line('surcharge');
  const receives = line('venue_receives');
  const venueFees = line('venue_adyen_fees');
  const fees = line('adyen_fees');
  const left = line('left_on_platform');
  const fp = line('franpos_rate');
  const share = line('servos_share');
  const refunded = line('refunded');
  // A fee record Adyen booked as money coming back is a fee refund.
  const feesBack = !!fees && Number(fees.minor) < 0;

  const moneyRows = [
    paid && { ...paid },
    fee && { ...fee, detail: fee.detail ? `Rate on Adyen today: ${fee.detail}` : null },
    tip && { ...tip },
    surcharge && { ...surcharge },
    receives && { ...receives },
    venueFees && { ...venueFees },
    refunded && { ...refunded },
  ].filter(Boolean);
  const madeRows = [
    fee && { key: 'fee', label: 'Venue fee', minor: fee.minor, source: 'adyen' },
    fees && { key: 'fees', label: feesBack ? 'plus Adyen fee refund' : 'minus Adyen fees', minor: feesBack ? -fees.minor : fees.minor, source: 'adyen' },
    left && { key: 'left', label: 'Left on the platform account', minor: left.minor, source: 'computed' },
    fp && { key: 'fp', label: 'minus FranPOS rate', minor: fp.minor, source: 'franpos', detail: fp.detail },
    share && { key: 'share', label: 'ServOS share', minor: share.minor, source: 'computed', bold: true },
  ].filter(Boolean);

  const parts = b.parts;
  const sum = (a, c) => (a === null || a === undefined || c === null || c === undefined ? null : a + c);
  const cell = (v) => (v === null || v === undefined ? 'Not known' : formatMinor(v, cur));
  const th = { fontSize: 15, fontWeight: 700, color: 'var(--t3)', padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap' };
  const td = { fontSize: 15, padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap', borderTop: '1px solid var(--bdr)', color: 'var(--t1)' };

  return (
    <div>
      <h3 style={S.h2}>Where the money went</h3>
      <MoneyRows rows={moneyRows} currency={cur} />
      {b.checks?.addsUp === true && (
        <p style={{ ...S.body, marginTop: 10, fontSize: 17 }}>
          <span style={{ color: 'var(--t1)', fontWeight: 700 }}>{b.sumLine}</span>{' '}
          <span style={S.good} aria-label="Adds up">&#10003; Adds up</span>
        </p>
      )}
      {b.checks?.addsUp === false && (
        <p style={{ ...S.body, marginTop: 10, fontSize: 17, fontWeight: 700, color: 'var(--red)' }}>
          {b.sumLine}, not {formatMinor(b.amountMinor, cur)}.
        </p>
      )}

      <h3 style={S.h2}>What ServOS made</h3>
      <MoneyRows rows={madeRows} currency={cur} />

      <h3 style={S.h2}>Percent and fixed</h3>
      {parts ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', minWidth: 460 }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }} />
                <th style={th}>Venue pays<div style={{ ...S.grey, fontWeight: 400 }}>{parts.from === 'rate' ? SOURCE_WORDS.rate : SOURCE_WORDS.adyen}</div></th>
                <th style={th}>FranPOS keeps<div style={{ ...S.grey, fontWeight: 400 }}>{SOURCE_WORDS.franpos}</div></th>
                <th style={th}>ServOS keeps<div style={{ ...S.grey, fontWeight: 400 }}>{SOURCE_WORDS.computed}</div></th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ ...td, textAlign: 'left' }}>Percent</td>
                <td style={td}>{cell(parts.percent.venue)}</td>
                <td style={td}>{cell(parts.percent.franpos)}</td>
                <td style={td}>{cell(parts.percent.servos)}</td>
              </tr>
              <tr>
                <td style={{ ...td, textAlign: 'left' }}>Fixed</td>
                <td style={td}>{cell(parts.fixed.venue)}</td>
                <td style={td}>{cell(parts.fixed.franpos)}</td>
                <td style={td}>{cell(parts.fixed.servos)}</td>
              </tr>
              <tr>
                <td style={{ ...td, textAlign: 'left' }}>{Number(parts.adyenFees) < 0 ? 'Adyen fee refund' : 'Adyen fees'}</td>
                <td style={td} />
                <td style={td} />
                <td style={td}>{cell(parts.adyenFees === null || parts.adyenFees === undefined ? null : -parts.adyenFees)}</td>
              </tr>
              <tr>
                <td style={{ ...td, textAlign: 'left', fontWeight: 800 }}>Total</td>
                <td style={{ ...td, fontWeight: 800 }}>{cell(sum(parts.percent.venue, parts.fixed.venue) ?? fee?.minor)}</td>
                <td style={{ ...td, fontWeight: 800 }}>{cell(sum(parts.percent.franpos, parts.fixed.franpos))}</td>
                <td style={{ ...td, fontWeight: 800, color: moneyColour(parts.servosTotal) }}>{cell(parts.servosTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <p style={S.body}>Not known yet.</p>
      )}

      {(b.references || []).length > 0 && (
        <div style={{ marginTop: 18 }}>
          <button type="button" style={S.link} onClick={() => setShowRefs((v) => !v)} aria-expanded={showRefs}>
            {showRefs ? 'Hide Adyen references' : 'Adyen references'}
          </button>
          {showRefs && (
            <div style={{ marginTop: 8 }}>
              {b.references.map((r) => <IdLine key={`${r.label}${r.id}`} label={r.label} term={r.term} id={r.id} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function PaymentCheck() {
  const [venues, setVenues] = useState(null);          // null while loading
  const [venuesError, setVenuesError] = useState(null);
  const [venueId, setVenueId] = useState('');
  const [list, setList] = useState({ loading: false, payments: null, error: null });
  const [psp, setPsp] = useState('');
  const [check, setCheck] = useState({ loading: false, data: null, error: null });
  // The newest request of each kind. A slower answer to an earlier click is
  // dropped, so it never paints under a newer venue or payment.
  const listReq = useRef(0);
  const checkReq = useRef(0);

  const venue = useMemo(() => (venues || []).find((v) => v.id === venueId) || null, [venues, venueId]);

  // Venues with an Adyen account row: the platform locations, kept to the
  // ones payments-admin adyen_accounts finds a row for.
  const loadVenues = useCallback(async () => {
    setVenuesError(null);
    try {
      if (!platformSupabase) throw new Error('The venue list is not set up here.');
      const { data: locs, error } = await platformSupabase.from('locations').select('id, name, ops_location_id, timezone').order('name');
      if (error) { const e = new Error('The venues could not be read.'); e.detail = error.message; throw e; }
      const ids = (locs || []).map((l) => l.id);
      const r = ids.length ? await callPaymentsAdmin('adyen_accounts', { location_ids: ids }) : { accounts: [] };
      const withRow = new Set((r.accounts || []).map((a) => a.location_id));
      setVenues((locs || []).filter((l) => withRow.has(l.id)));
    } catch (e) {
      setVenues([]);
      setVenuesError({ text: e.message || 'The venues could not be read.', detail: e.detail || null });
    }
  }, []);

  // Deferred a tick: the repo lint refuses setState reached synchronously
  // from an effect.
  useEffect(() => { const t = setTimeout(() => loadVenues(), 0); return () => clearTimeout(t); }, [loadVenues]);

  const loadPayments = useCallback(async (v) => {
    const mine = ++listReq.current;
    setList({ loading: true, payments: null, error: null });
    try {
      const j = await callTerminalAdmin(v, 'payment_list', { days: 30 }, 'The card payments for this venue could not be read.');
      if (mine !== listReq.current) return;
      setList({ loading: false, payments: j.payments || [], error: null });
    } catch (e) {
      if (mine !== listReq.current) return;
      setList({ loading: false, payments: null, error: { text: e.message, detail: e.detail || null } });
    }
  }, []);

  const runCheck = useCallback(async (v, ref) => {
    const mine = ++checkReq.current;
    setCheck((c) => ({ loading: true, data: c.data && c.data.payment?.psp === ref ? c.data : null, error: null }));
    try {
      const j = await callTerminalAdmin(v, 'payment_breakdown', { psp: ref }, 'This payment could not be checked.');
      if (mine !== checkReq.current) return;
      setCheck({ loading: false, data: j, error: null });
    } catch (e) {
      if (mine !== checkReq.current) return;
      setCheck({ loading: false, data: null, error: { text: e.message, detail: e.detail || null } });
    }
  }, []);

  const pickVenue = (id) => {
    setVenueId(id);
    setPsp('');
    checkReq.current++;
    setCheck({ loading: false, data: null, error: null });
    const v = (venues || []).find((x) => x.id === id);
    if (v) loadPayments(v);
    else { listReq.current++; setList({ loading: false, payments: null, error: null }); }
  };

  const pickPayment = (ref) => {
    setPsp(ref);
    if (venue) runCheck(venue, ref);
  };

  const b = check.data?.breakdown;
  const pay = check.data?.payment;
  const needsAgain = b && (b.state === 'waiting' || b.state === 'mismatch' || b.state === 'incomplete');
  const col = 'minmax(110px, 1fr) minmax(80px, .8fr) minmax(150px, 1.6fr) minmax(80px, .8fr)';

  return (
    <div style={S.card}>
      <h2 style={S.title}>Check a payment</h2>
      <p style={S.body}>Pick a venue and one of its card payments. Adyen&rsquo;s own records show where every penny went.</p>

      <div style={{ marginTop: 14 }}>
        <label style={S.label} htmlFor="payment-check-venue">Venue</label>
        <select id="payment-check-venue" style={S.select} value={venueId} onChange={(e) => pickVenue(e.target.value)} disabled={venues === null}>
          <option value="">{venues === null ? 'Loading venues' : 'Pick a venue'}</option>
          {(venues || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        {venues && venues.length === 0 && !venuesError && <p style={{ ...S.body, marginTop: 8 }}>No venue has an Adyen account yet.</p>}
        {venuesError && <Problem text={venuesError.text} detail={venuesError.detail} />}
      </div>

      {venue && (
        <div style={{ marginTop: 16 }}>
          <div style={{ ...S.label, marginBottom: 4 }}>Card payments in the last 30 days</div>
          {list.loading && <p style={S.body}>Loading payments</p>}
          {list.error && <Problem text={list.error.text} detail={list.error.detail} />}
          {list.payments && list.payments.length === 0 && <p style={S.body}>No card payments in the last 30 days.</p>}
          {list.payments && list.payments.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 480, maxHeight: 320, overflowY: 'auto', border: '1px solid var(--bdr)', borderRadius: 8 }}>
                <div style={{ display: 'grid', gridTemplateColumns: col, gap: 12, padding: '8px 12px', background: 'var(--bg2)', position: 'sticky', top: 0 }}>
                  {['Date', 'Amount', 'Card', 'Venue fee'].map((h, i) => (
                    <span key={h} style={{ fontSize: 15, fontWeight: 700, color: 'var(--t3)', textAlign: i === 1 || i === 3 ? 'right' : 'left' }}>{h}</span>
                  ))}
                </div>
                {list.payments.map((p) => {
                  const on = p.psp === psp;
                  return (
                    <button
                      key={p.psp}
                      type="button"
                      onClick={() => pickPayment(p.psp)}
                      aria-pressed={on}
                      style={{
                        display: 'grid', gridTemplateColumns: col, gap: 12, width: '100%', padding: '9px 12px', border: 'none',
                        borderTop: '1px solid var(--bdr)', background: on ? 'var(--acc-d, var(--bg3))' : 'transparent',
                        cursor: 'pointer', fontFamily: 'inherit', fontSize: 15, color: 'var(--t1)', textAlign: 'left',
                      }}
                    >
                      <span>{whenText(p.at, venue.timezone)}</span>
                      <span style={{ textAlign: 'right', fontWeight: 600 }}>{formatMinor(p.amountMinor, p.currency)}</span>
                      <span>{p.cardLabel}{!p.live && <span style={S.quiet}> (test card)</span>}</span>
                      <span style={{ textAlign: 'right' }}>{p.venueFeeMinor === null ? 'Not known' : formatMinor(p.venueFeeMinor, p.currency)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {psp && (
        <div style={{ marginTop: 20, borderTop: '1px solid var(--bdr2)', paddingTop: 14 }}>
          {pay && (
            <div>
              <p style={{ ...S.body, fontSize: 17, color: 'var(--t1)', fontWeight: 700 }}>
                {formatMinor(pay.amountMinor, pay.currency)} on {pay.cardLabel}
              </p>
              <p style={{ ...S.body, marginTop: 2 }}>
                {whenText(pay.at, venue?.timezone).replace(', ', ' at ')}. {pay.typeLabel}.{!pay.live ? ' Test card.' : ''}
              </p>
            </div>
          )}
          {check.loading && !check.data && <p style={S.body}>Reading Adyen&rsquo;s records</p>}
          {check.error && <Problem text={check.error.text} detail={check.error.detail} />}
          {b?.state === 'waiting' && <p style={{ ...S.body, marginTop: 8 }}>{b.message}</p>}
          {b?.state === 'incomplete' && <Problem text={b.message} detail={problemDetail(check.data)} tone="warn" />}
          {b?.state === 'mismatch' && <Problem text={b.message} />}
          {(needsAgain || check.error) && (
            <div style={{ marginTop: 12 }}>
              <button type="button" style={{ ...S.prim, opacity: check.loading ? 0.6 : 1 }} disabled={check.loading} onClick={() => venue && runCheck(venue, psp)}>
                {check.loading ? 'Checking' : 'Check again'}
              </button>
            </div>
          )}
          {b && <Notes data={check.data} withProblems={b.state !== 'incomplete'} />}
          {b && (b.state === 'ok' || b.state === 'mismatch') && <Breakdown data={check.data} />}
        </div>
      )}
    </div>
  );
}
