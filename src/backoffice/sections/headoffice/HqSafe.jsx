// src/backoffice/sections/headoffice/HqSafe.jsx
//
// Head office, Safe and banking: one site's safe as a ledger the till feeds. Nobody retypes a
// figure: every closed drawer's counted cash, every opening float and every "Cash drop to safe"
// made on the till waits here until someone ticks it into the safe. From the safe the cash goes to
// the bank as a prepared bag (prepared, banked, confirmed), out as petty cash, or stays and is
// counted. The arithmetic is src/lib/hq/safeLedger.js, pure and tested; this file reads, posts
// and draws. Every read answers { data, error, absent, message }; the 20261201a tables may not
// exist yet, and then the one calm card shows.

import { useEffect, useMemo, useState } from 'react';
import {
  fetchCashForSites, fetchTargets, addSafeMovements, addSafeCount, prepareDeposit, setDepositStatus, businessDateFor, NOT_SET_UP_2,
} from '../../../lib/hq/data.js';
import {
  waitingItems, waitingTotal, movementsFromItems, countOutcome, denominationsTotal, suggestedDeposit, cashSummary, safeBalance,
  kindLabel, depositStatusLabel, depositNextStatus,
} from '../../../lib/hq/safeLedger.js';
import { resolveTargets, ragOf } from '../../../lib/hq/targets.js';
import {
  page, card, mono, accBtn, btn, smallBtn, field, th, td, disabled, exactMoney, num, dateText, dateTimeText, NA,
  PageHead, SectionHead, StatTile, Chip, AbsentCard, AmberLine, GreenLine, LoadingLine, EmptyCard, Field, Sheet,
} from './hqUi';

/** Notes and coins per currency, biggest first. */
export const DENOMINATIONS = Object.freeze({
  GBP: [50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05],
  USD: [100, 50, 20, 10, 5, 1, 0.25, 0.1, 0.05, 0.01],
});
export const denominationsFor = (currency) => DENOMINATIONS[String(currency || '').toUpperCase() === 'USD' ? 'USD' : 'GBP'];

const DEPOSIT_TONE = { prepared: 'orn', banked: 'acc', confirmed: 'grn', cancelled: 't4' };
const refOf = (i) => `${i.ref_kind}:${i.ref_id}`;
const FRESH_START_MS = 2 * 86400000;
const money2 = (n, currency) => exactMoney(n, currency, 2);
/** "$12.50" or "-$12.50": the sign stays in front of the symbol. */
const signedMoney = (n, currency) => (n === null || n === undefined ? NA : `${Number(n) < 0 ? '-' : ''}${money2(Math.abs(Number(n)), currency)}`);
const EMPTY_DATA = Object.freeze({ movements: [], counts: [], deposits: [], sessions: [], drops: [], clocks: {} });
const cleanNumber = (s) => { const t = String(s ?? '').trim().replace(/[$£€,\s]/g, ''); return t === '' ? null : (Number.isFinite(Number(t)) ? Number(t) : null); };

/** The ledger rows newest first, each with the balance after it. */
export function ledgerWithRunning(movements) {
  const asc = (movements || []).slice().sort((a, b) => `${a.business_date || ''}|${a.created_at || ''}`.localeCompare(`${b.business_date || ''}|${b.created_at || ''}`));
  let run = 0;
  const out = asc.map((m) => { run = Math.round((run + (Number(m.amount) || 0)) * 100) / 100; return { ...m, running: run }; });
  return out.reverse();
}

export default function HqSafe({ hq }) {
  const firstSite = hq.sites.some((s) => s.id === hq.locationId) ? hq.locationId : (hq.sites[0]?.id || '');
  const [siteId, setSiteId] = useState(firstSite);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState({ key: null, absent: false, error: null, data: null, targets: [] });
  const [unticked, setUnticked] = useState(() => new Set());
  const [sheet, setSheet] = useState(null);   // 'count' | 'deposit' | null
  const [msg, setMsg] = useState(null);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  // Slice 4: money in the picked site's own currency (a UK and a US site in one company).
  const currency = (typeof hq.currencyOf === 'function' && hq.currencyOf(siteId)) || hq.currency;
  const key = `${siteId}|${hq.orgId || ''}|${tick}`;

  useEffect(() => {
    if (!siteId) return undefined;
    let live = true;
    Promise.all([fetchCashForSites([siteId]), fetchTargets(hq.orgId)]).then(([cash, targets]) => {
      if (!live) return;
      if (cash.absent || targets.absent) { setState({ key, absent: true, error: cash.message || targets.message, data: null, targets: [] }); return; }
      setState({ key, absent: false, error: cash.error ? cash.message : (targets.error ? targets.message : null), data: cash.data, targets: targets.data || [] });
      // A safe with no ledger yet starts with only the last two days ticked: 45 days of old cash ups
      // posted in one go would invent a balance the safe never held. Older rows stay listed, unticked.
      const fresh = !(cash.data?.movements || []).some((m) => m.location_id === siteId);
      const old = fresh ? waitingItems({
        sessions: (cash.data?.sessions || []).filter((x) => x.location_id === siteId),
        tillDrops: (cash.data?.drops || []).filter((x) => x.location_id === siteId), movements: [],
      }).filter((i) => i.at && Date.now() - Date.parse(i.at) > FRESH_START_MS).map(refOf) : [];
      setUnticked(new Set(old));
    });
    return () => { live = false; };
  }, [siteId, hq.orgId, tick, key]);
  const loading = !!siteId && state.key !== key;
  const reload = () => setTick((n) => n + 1);

  const data = state.data || EMPTY_DATA;
  const clock = data.clocks?.[siteId] || null;
  const today = clock?.today || hq.today;
  const movements = useMemo(() => data.movements.filter((m) => m.location_id === siteId), [data.movements, siteId]);
  const counts = useMemo(() => data.counts.filter((c) => c.location_id === siteId), [data.counts, siteId]);
  const deposits = useMemo(() => data.deposits.filter((d) => d.location_id === siteId), [data.deposits, siteId]);
  const summary = useMemo(() => cashSummary({ movements, counts, deposits, today }), [movements, counts, deposits, today]);
  const balance = safeBalance(movements);
  const band = useMemo(() => resolveTargets(state.targets, siteId), [state.targets, siteId]);
  const waiting = useMemo(() => waitingItems({
    sessions: data.sessions.filter((s) => s.location_id === siteId), tillDrops: data.drops.filter((d) => d.location_id === siteId), movements,
  }), [data.sessions, data.drops, movements, siteId]);
  const picked = waiting.filter((i) => !unticked.has(refOf(i)));
  const ledger = useMemo(() => ledgerWithRunning(movements), [movements]);
  const site = hq.sites.find((s) => s.id === siteId);

  const run = async (what, fn) => {
    setBusy(true); setMsg(null); setSaved(null);
    const res = await fn();
    setBusy(false);
    if (res?.error) { setMsg(res.message || `Could not ${what}.`); return false; }
    setSaved(`${what[0].toUpperCase()}${what.slice(1)}.`);
    reload();
    return true;
  };

  const putInSafe = () => run('put the cash in the safe', () => addSafeMovements(movementsFromItems(picked, {
    orgId: hq.orgId, locationId: siteId, byName: hq.userName, businessDateOf: (i) => businessDateFor(i.at, clock) || today,
  }), hq.orgId, hq.userName));

  const nextDeposit = (d) => {
    const next = depositNextStatus(d.status);
    if (!next) return;
    run(next === 'banked' ? 'marked the bag banked' : 'confirmed the deposit', () => setDepositStatus(d, next, hq.orgId, hq.userName));
  };
  const cancelDeposit = (d) => {
    if (!window.confirm(`Cancel the ${money2(d.amount, currency)} deposit${d.bag_reference ? ` (bag ${d.bag_reference})` : ''}? The cash goes back on the safe ledger.`)) return;
    run('cancelled the deposit', () => setDepositStatus(d, 'cancelled', hq.orgId, hq.userName));
  };

  const sub = 'The till fills this. Tick what went in, count the safe, make up the bag for the bank.';
  if (state.absent) {
    return (
      <div style={page}>
        <PageHead title="Safe and banking" sub={sub} />
        <AbsentCard message={state.error || NOT_SET_UP_2} />
      </div>
    );
  }

  const lastVar = summary.lastVariance;
  const right = hq.sites.length > 1 ? (
    <Field label="Site" style={{ minWidth: 220 }}><select style={field} value={siteId} onChange={(e) => setSiteId(e.target.value)}>{hq.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
  ) : null;

  return (
    <div style={page}>
      <PageHead title="Safe and banking" sub={sub} right={right} />
      {loading && <LoadingLine>Loading</LoadingLine>}
      <AmberLine>{state.error}</AmberLine>
      <AmberLine>{msg}</AmberLine>
      <GreenLine>{saved}</GreenLine>
      {!hq.sites.length && !loading && <EmptyCard title="No sites yet" body="The safe belongs to a site. None were found for this login." />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
        <StatTile label="Safe balance" value={money2(balance, currency)} tone={ragOf('cash_held', balance, band.cash_held)} note={summary.used ? `${site?.name || 'Site'}, on the ledger` : 'Nothing on the ledger yet'} icon="lock" />
        <StatTile label="In transit to bank" value={money2(summary.inTransit, currency)} note="Prepared or banked, not yet confirmed" icon="bank" />
        <StatTile label="Days since banking" value={summary.unbankedDays === null ? NA : num(summary.unbankedDays)} tone={ragOf('unbanked_days', summary.unbankedDays, band.unbanked_days)} note={summary.lastDeposit ? `Last bag ${dateText(summary.lastDeposit.business_date, currency)}` : 'No bag prepared yet'} icon="calendar" />
        <StatTile label="Last count" value={lastVar === null ? NA : signedMoney(lastVar, currency)} tone={lastVar === null ? null : (lastVar === 0 ? 'grn' : ragOf('safe_variance', Math.abs(lastVar), band.safe_variance))}
          note={summary.lastCountDate ? `Variance on ${dateText(summary.lastCountDate, currency)}` : 'Not counted yet'} icon="checkSquare" />
      </div>

      <SectionHead title="Waiting to go in the safe" sub="Cash ups, floats and drops the till has recorded that the ledger has not seen."
        right={waiting.length ? <button type="button" style={{ ...accBtn, ...disabled(busy || !picked.length) }} disabled={busy || !picked.length} onClick={putInSafe}>{busy ? 'Posting' : `Put in safe (${signedMoney(waitingTotal(picked), currency)})`}</button> : null} />
      {!waiting.length && !loading && <EmptyCard title="Nothing waiting" body="Every cash up and drop is in the safe." />}
      {!!waiting.length && !movements.length && unticked.size > 0 && <AmberLine>First use: only the last two days are ticked. Tick older rows if that cash really is in the safe, or count the safe first and let the count set the balance.</AmberLine>}
      {waiting.length > 0 && (
        <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
            <thead><tr>
              <th style={{ ...th, width: 36 }}><input type="checkbox" aria-label="Tick every row" checked={!unticked.size} onChange={(e) => setUnticked(e.target.checked ? new Set() : new Set(waiting.map(refOf)))} /></th>
              <th style={th}>What</th><th style={th}>Detail</th><th style={th}>Drawer</th><th style={th}>When</th><th style={{ ...th, textAlign: 'right' }}>Amount</th>
            </tr></thead>
            <tbody>
              {waiting.map((i) => {
                const on = !unticked.has(refOf(i));
                return (
                  <tr key={refOf(i)} style={{ opacity: on ? 1 : 0.55 }}>
                    <td style={td}><input type="checkbox" checked={on} aria-label={i.label} onChange={() => setUnticked((s) => { const n = new Set(s); if (n.has(refOf(i))) n.delete(refOf(i)); else n.add(refOf(i)); return n; })} /></td>
                    <td style={{ ...td, fontWeight: 600 }}>{i.label}</td>
                    <td style={{ ...td, color: 'var(--t3)' }}>{i.detail || NA}</td>
                    <td style={td}>{drawerName(data.sessions, i.drawer_id)}</td>
                    <td style={{ ...td, ...mono, color: 'var(--t3)' }}>{dateTimeText(i.at, currency)}</td>
                    <td style={{ ...td, ...mono, textAlign: 'right', fontWeight: 700, color: i.amount < 0 ? 'var(--orn)' : 'var(--t1)' }}>{signedMoney(i.amount, currency)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <SectionHead title="Count the safe" sub={`The ledger expects ${money2(balance, currency)}. Count what is there and the difference shows.`}
        right={<button type="button" style={btn} onClick={() => setSheet('count')}>Count the safe</button>} />
      <CountsTable counts={counts} currency={currency} />

      <SectionHead title="Banking" sub="Make up a bag, mark it banked when it leaves, confirm it when the bank shows it."
        right={<button type="button" style={accBtn} onClick={() => setSheet('deposit')}>Prepare a deposit</button>} />
      <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead><tr><th style={th}>Date</th><th style={{ ...th, textAlign: 'right' }}>Amount</th><th style={th}>Bag</th><th style={th}>Bank</th><th style={th}>Status</th><th style={th}>Next</th></tr></thead>
          <tbody>
            {deposits.map((d) => {
              const next = depositNextStatus(d.status);
              return (
                <tr key={d.id}>
                  <td style={{ ...td, ...mono }}>{dateText(d.business_date, currency)}</td>
                  <td style={{ ...td, ...mono, textAlign: 'right', fontWeight: 700 }}>{money2(d.amount, currency)}</td>
                  <td style={{ ...td, ...mono }}>{d.bag_reference || NA}</td>
                  <td style={{ ...td, color: 'var(--t3)' }}>{d.bank_label || NA}</td>
                  <td style={td}><Chip tone={DEPOSIT_TONE[d.status] || 't3'}>{depositStatusLabel(d.status)}</Chip></td>
                  <td style={td}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {next && <button type="button" style={{ ...smallBtn, ...disabled(busy) }} disabled={busy} onClick={() => nextDeposit(d)}>{next === 'banked' ? 'Mark banked' : 'Confirm'}</button>}
                      {next && <button type="button" style={{ ...smallBtn, color: 'var(--red)', ...disabled(busy) }} disabled={busy} onClick={() => cancelDeposit(d)}>Cancel</button>}
                      {!next && <span style={{ fontSize: 12, color: 'var(--t4)' }}>{d.status === 'confirmed' ? 'Done' : NA}</span>}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!deposits.length && <tr><td style={{ ...td, color: 'var(--t3)' }} colSpan={6}>No deposits yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <SectionHead title="Other movements" sub="Petty cash paid out of the safe, or cash that came in some other way." />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        <SmallMovement title="Petty cash out" sign={-1} currency={currency} busy={busy}
          onPost={(amount, note) => run('took the petty cash out', () => addSafeMovements([{ location_id: siteId, business_date: today, kind: 'petty_out', amount: -Math.abs(amount), note }], hq.orgId, hq.userName))} />
        <SmallMovement title="Other cash in" sign={1} currency={currency} busy={busy}
          onPost={(amount, note) => run('put the cash in', () => addSafeMovements([{ location_id: siteId, business_date: today, kind: 'other_in', amount: Math.abs(amount), note }], hq.orgId, hq.userName))} />
      </div>

      <SectionHead title="Ledger" sub="Every movement, newest first, with the balance after it." />
      <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
          <thead><tr><th style={th}>Date</th><th style={th}>Kind</th><th style={th}>Note</th><th style={th}>Who</th><th style={{ ...th, textAlign: 'right' }}>Amount</th><th style={{ ...th, textAlign: 'right' }}>Balance</th></tr></thead>
          <tbody>
            {ledger.map((m) => (
              <tr key={m.id || `${m.business_date}|${m.created_at}|${m.ref_id}`}>
                <td style={{ ...td, ...mono }}>{dateText(m.business_date, currency)}</td>
                <td style={td}><Chip tone={Number(m.amount) < 0 ? 'orn' : (m.kind === 'adjustment' ? 't3' : 'grn')}>{kindLabel(m.kind)}</Chip></td>
                <td style={{ ...td, color: 'var(--t3)' }}>{m.note || NA}</td>
                <td style={{ ...td, color: 'var(--t3)' }}>{m.created_by_name || NA}</td>
                <td style={{ ...td, ...mono, textAlign: 'right', fontWeight: 700, color: Number(m.amount) < 0 ? 'var(--orn)' : 'var(--t1)' }}>{signedMoney(m.amount, currency)}</td>
                <td style={{ ...td, ...mono, textAlign: 'right' }}>{money2(m.running, currency)}</td>
              </tr>
            ))}
            {!ledger.length && !loading && <tr><td style={{ ...td, color: 'var(--t3)' }} colSpan={6}>The ledger is empty. Tick the waiting cash in above to start it.</td></tr>}
          </tbody>
        </table>
      </div>

      {sheet === 'count' && (
        <CountSheet hq={hq} siteId={siteId} today={today} expected={balance} currency={currency} onClose={() => setSheet(null)}
          onSaved={() => { setSheet(null); setSaved('Count saved.'); reload(); }} />
      )}
      {sheet === 'deposit' && (
        <DepositSheet hq={hq} siteId={siteId} today={today} balance={balance} keepBack={band.cash_held?.green_to || 0} currency={currency} onClose={() => setSheet(null)}
          onSaved={() => { setSheet(null); setSaved('Deposit prepared. The safe moved.'); reload(); }} />
      )}
    </div>
  );
}

function drawerName(sessions, drawerId) {
  if (!drawerId) return NA;
  return (sessions || []).find((s) => s.drawer_id === drawerId)?.drawer_name || 'Drawer';
}

function CountsTable({ counts, currency }) {
  const rows = (counts || []).slice(0, 8);
  return (
    <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
        <thead><tr><th style={th}>Date</th><th style={{ ...th, textAlign: 'right' }}>Counted</th><th style={{ ...th, textAlign: 'right' }}>Expected</th><th style={{ ...th, textAlign: 'right' }}>Variance</th><th style={th}>Who</th><th style={th}>Note</th></tr></thead>
        <tbody>
          {rows.map((c) => {
            const v = c.variance === null || c.variance === undefined ? Math.round(((Number(c.counted_total) || 0) - (Number(c.expected_total) || 0)) * 100) / 100 : Number(c.variance);
            return (
              <tr key={c.id}>
                <td style={{ ...td, ...mono }}>{dateText(c.business_date, currency)}</td>
                <td style={{ ...td, ...mono, textAlign: 'right' }}>{money2(c.counted_total, currency)}</td>
                <td style={{ ...td, ...mono, textAlign: 'right' }}>{money2(c.expected_total, currency)}</td>
                <td style={{ ...td, ...mono, textAlign: 'right', fontWeight: 700, color: v === 0 ? 'var(--grn)' : 'var(--orn)' }}>{signedMoney(v, currency)}</td>
                <td style={{ ...td, color: 'var(--t3)' }}>{c.created_by_name || NA}</td>
                <td style={{ ...td, color: 'var(--t3)' }}>{c.note || NA}</td>
              </tr>
            );
          })}
          {!rows.length && <tr><td style={{ ...td, color: 'var(--t3)' }} colSpan={6}>Not counted yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/** The count sheet: a counted total, or notes and coins that add up to it, against the ledger. */
function CountSheet({ hq, siteId, today, expected, currency, onClose, onSaved }) {
  const [counted, setCounted] = useState('');
  const [denoms, setDenoms] = useState({});
  const [byDenom, setByDenom] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const outcome = countOutcome(cleanNumber(counted), expected);
  const setDenom = (d) => (e) => {
    const next = { ...denoms, [String(d)]: e.target.value };
    setDenoms(next);
    setCounted(String(denominationsTotal(Object.fromEntries(Object.entries(next).map(([k, v]) => [k, cleanNumber(v) || 0])))));
  };
  const save = async (withAdjustment) => {
    setSaving(true); setMsg(null);
    const cleanDenoms = byDenom ? Object.fromEntries(Object.entries(denoms).filter(([, v]) => cleanNumber(v)).map(([k, v]) => [k, cleanNumber(v)])) : null;
    const res = await addSafeCount({
      location_id: siteId, business_date: today, counted_total: cleanNumber(counted), expected_total: expected,
      denominations: cleanDenoms && Object.keys(cleanDenoms).length ? cleanDenoms : null, note: note.trim() || null,
      adjustment: withAdjustment ? outcome.adjustment : null,
    }, hq.orgId, hq.userName);
    setSaving(false);
    if (res.error) setMsg(res.message); else onSaved();
  };
  const canSave = outcome.variance !== null && !saving;
  const toneOf = outcome.variance === null ? 'var(--t3)' : (outcome.variance === 0 ? 'var(--grn)' : 'var(--orn)');
  return (
    <Sheet title="Count the safe" onClose={onClose}>
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Counted total"><input style={{ ...field, ...mono }} inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} placeholder="0.00" autoFocus /></Field>
          <Field label="The ledger expects"><div style={{ ...field, ...mono, background: 'var(--bg0)', color: 'var(--t2)' }}>{money2(expected, currency)}</div></Field>
        </div>
        <button type="button" style={{ ...smallBtn, justifySelf: 'start' }} onClick={() => setByDenom((v) => !v)}>{byDenom ? 'Hide notes and coins' : 'Count by notes and coins'}</button>
        {byDenom && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
            {denominationsFor(currency).map((d) => (
              <Field key={d} label={money2(d, currency)}><input style={{ ...field, ...mono }} inputMode="numeric" value={denoms[String(d)] || ''} onChange={setDenom(d)} placeholder="0" /></Field>
            ))}
          </div>
        )}
        <Field label="Note"><input style={field} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything the owner should know" /></Field>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: toneOf }}>{outcome.words}</div>
        <AmberLine>{msg}</AmberLine>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" style={btn} onClick={onClose}>Close</button>
          <button type="button" style={{ ...(outcome.variance ? btn : accBtn), ...disabled(!canSave) }} disabled={!canSave} onClick={() => save(false)}>{saving ? 'Saving' : 'Save count'}</button>
          {outcome.variance !== null && outcome.variance !== 0 && (
            <button type="button" style={{ ...accBtn, ...disabled(!canSave) }} disabled={!canSave} onClick={() => save(true)}>{saving ? 'Saving' : 'Save and adjust the ledger'}</button>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/** Prepare a bag for the bank: the amount leaves the safe the moment it is saved. */
function DepositSheet({ hq, siteId, today, balance, keepBack, currency, onClose, onSaved }) {
  const [amount, setAmount] = useState(() => String(suggestedDeposit(balance, keepBack)));
  const [bag, setBag] = useState('');
  const [bank, setBank] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const n = cleanNumber(amount);
  const problem = n === null ? 'Type the amount.' : (n <= 0 ? 'The amount must be above zero.' : (n > balance ? `The safe holds ${money2(balance, currency)}. Put the waiting cash in first.` : null));
  const save = async () => {
    setSaving(true); setMsg(null);
    const res = await prepareDeposit({ location_id: siteId, business_date: today, amount: n, bag_reference: bag.trim() || null, bank_label: bank.trim() || null, note: note.trim() || null }, hq.orgId, hq.userName);
    setSaving(false);
    if (res.error) setMsg(res.message); else onSaved();
  };
  return (
    <Sheet title="Prepare a deposit" onClose={onClose}>
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Amount"><input style={{ ...field, ...mono }} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></Field>
          <Field label="Bag reference"><input style={{ ...field, ...mono }} value={bag} onChange={(e) => setBag(e.target.value)} placeholder="Bag number" /></Field>
        </div>
        <div style={{ fontSize: 12, color: 'var(--t3)' }}>
          {keepBack ? `Suggested: the balance less the ${money2(keepBack, currency)} the site keeps back (the Cash held target).` : 'Suggested: the whole balance. Set a Cash held target to keep some back for floats.'}
        </div>
        <Field label="Bank"><input style={field} value={bank} onChange={(e) => setBank(e.target.value)} placeholder="Which bank or account" /></Field>
        <Field label="Note"><input style={field} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <AmberLine>{problem}</AmberLine>
        <AmberLine>{msg}</AmberLine>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" style={btn} onClick={onClose}>Close</button>
          <button type="button" style={{ ...accBtn, ...disabled(saving || !!problem) }} disabled={saving || !!problem} onClick={save}>{saving ? 'Saving' : 'Prepare the bag'}</button>
        </div>
      </div>
    </Sheet>
  );
}

/** One small inline form: an amount and a note, posted as one movement. */
function SmallMovement({ title, sign, currency, busy, onPost }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const n = cleanNumber(amount);
  const ok = n !== null && n > 0 && !busy;
  const post = async () => {
    const done = await onPost(n, note.trim() || null);
    if (done) { setAmount(''); setNote(''); }
  };
  return (
    <div style={{ ...card, display: 'grid', gap: 10 }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--t1)' }}>{title}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10 }}>
        <Field label="Amount"><input style={{ ...field, ...mono }} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></Field>
        <Field label="Note"><input style={field} value={note} onChange={(e) => setNote(e.target.value)} placeholder={sign < 0 ? 'What it paid for' : 'Where it came from'} /></Field>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" style={{ ...btn, ...disabled(!ok) }} disabled={!ok} onClick={post}>{sign < 0 ? `Take out ${n ? money2(n, currency) : ''}` : `Put in ${n ? money2(n, currency) : ''}`}</button>
      </div>
    </div>
  );
}
