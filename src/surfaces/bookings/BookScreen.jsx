// src/surfaces/bookings/BookScreen.jsx
//
// The three-column booking flow — README §3. Covers + time chips (pacing-aware,
// manager override on a full slot), ranked candidates from the optimiser with
// the FULL generated reasons list, then guest search (CRM), payment options
// (display only — Phase 5 charges nothing) and the atomic confirm. On
// {ok:false, tableId} — the create RPC lost the race — we say so plainly and
// re-run suggestions rather than optimistically writing (OPTIMISER.md rule).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { toMin, toHM, turnFor } from '../../lib/bookings/optimiser.js';
import {
  mono, tintBg, tintBd, rulesOf, money, initialsOf, Chip, SectionTitle,
} from './bits.jsx';

const COVERS = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12];

export default function BookScreen({ onBooked }) {
  const bookings = useStore((s) => s.bookings) || [];
  const tables = useStore((s) => s.tables) || [];
  const bookingRules = useStore((s) => s.bookingRules);
  const rules = rulesOf(bookingRules);

  const [party, setParty] = useState(2);
  const [time, setTime] = useState(null);
  const [pick, setPick] = useState(0);
  const [overrideBy, setOverrideBy] = useState(null);
  const [guestQ, setGuestQ] = useState('');
  const [results, setResults] = useState([]);
  const [guest, setGuest] = useState(null);
  const [walkIn, setWalkIn] = useState(false);
  const [pay, setPay] = useState('hold');
  const [note, setNote] = useState('');
  const [taken, setTaken] = useState(null);   // table id that was taken mid-flight
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [refresh, setRefresh] = useState(0);  // bump to re-run suggestions after a race

  // ── time chips across the service window ────────────────────────────────────
  const slotTimes = useMemo(() => {
    const out = [];
    const step = rules.slotMinutes || 15;
    for (let m = toMin(rules.serviceStart); m < toMin(rules.serviceEnd); m += step) out.push(toHM(m));
    return out;
  }, [rules.serviceStart, rules.serviceEnd, rules.slotMinutes]);
  useEffect(() => { if (!time && slotTimes.length) setTime(slotTimes[0]); }, [slotTimes, time]);

  const paceAt = useStore((s) => s.bookingPaceAt);
  const pace = useMemo(() => {
    const map = new Map();
    for (const t of slotTimes) map.set(t, paceAt ? paceAt(t) : { load: 0, cap: rules.pacingCap, full: false });
    return map;
  }, [slotTimes, paceAt, bookings, rules.pacingCap]);
  const slotFull = time ? !!pace.get(time)?.full : false;

  // ── candidates ──────────────────────────────────────────────────────────────
  const suggest = useStore((s) => s.suggestBookingTables);
  const candidates = useMemo(() => {
    if (!suggest || !time) return [];
    return suggest({ party, time }) || [];
    // bookings / tables / rules are deps because suggest reads them via get()
  }, [suggest, party, time, bookings, tables, bookingRules, refresh]);
  useEffect(() => { setPick(0); }, [party, time]);
  useEffect(() => { setOverrideBy(null); }, [party, time]);
  const cand = candidates[Math.min(pick, candidates.length - 1)] || null;

  // ── guest search (debounced, async) ─────────────────────────────────────────
  const qRef = useRef('');
  useEffect(() => {
    qRef.current = guestQ;
    if (!guestQ || guestQ.length < 3) { setResults([]); return; }
    const t = setTimeout(async () => {
      const fn = useStore.getState().searchCustomersLive;
      const rows = typeof fn === 'function' ? await fn(guestQ) : [];
      if (qRef.current === guestQ) setResults(Array.isArray(rows) ? rows : []);
    }, 250);
    return () => clearTimeout(t);
  }, [guestQ]);

  // ── confirm ─────────────────────────────────────────────────────────────────
  const canConfirm = !!cand && !!time && (guest || walkIn) && !saving && (!slotFull || overrideBy);
  const confirm = async () => {
    if (!canConfirm) return;
    setSaving(true); setErr(''); setTaken(null);
    const createBooking = useStore.getState().createBooking;
    const res = createBooking ? await createBooking({
      covers: party,
      time,
      tables: cand.set,
      primaryTableId: cand.set[0],
      customerId: guest?.id || null,
      customer: guest ? { name: guest.name, phone: guest.phone } : null,
      note,
      source: 'host',
      pacingOverrideBy: overrideBy,
    }) : { ok: false, error: 'Bookings store not wired' };
    setSaving(false);
    if (res.ok) {
      setGuest(null); setGuestQ(''); setNote(''); setWalkIn(false); setOverrideBy(null);
      onBooked?.(res.booking?.id);
      return;
    }
    if (res.tableId) {
      const lbl = tables.find((t) => t.id === res.tableId)?.label || res.tableId;
      setTaken(lbl);
      setPick(0);
      setRefresh((r) => r + 1); // re-run suggestions against the fresh diary
    } else {
      setErr(res.error || 'Could not save the booking');
    }
  };

  const approver = () => useStore.getState().staff?.name || 'Manager';
  const col = { display: 'flex', flexDirection: 'column', minHeight: 0 };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 16, padding: 16, overflow: 'auto' }}>
      {/* ── column 1: party & time ── */}
      <div style={{ ...col, width: 300, flexShrink: 0 }}>
        <SectionTitle n={1}>Party &amp; time</SectionTitle>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
          {COVERS.map((c) => <Chip key={c} active={party === c} onClick={() => setParty(c)}>{c}</Chip>)}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {slotTimes.map((t) => {
            const p = pace.get(t) || { load: 0, full: false };
            const active = time === t;
            return (
              <button key={t} onClick={() => setTime(t)} style={{
                padding: '8px 10px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                background: active ? tintBg(p.full ? 'var(--red)' : 'var(--acc)') : 'var(--inset, var(--bg3))',
                border: `1.5px solid ${p.full ? tintBd('var(--red)') : active ? tintBd('var(--acc)') : 'var(--bdr)'}`,
                transition: 'all 140ms cubic-bezier(.2,.8,.3,1)',
              }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: active ? (p.full ? 'var(--red)' : 'var(--acc)') : 'var(--t1)', ...mono }}>{t}</div>
                <div style={{ fontSize: 10, color: p.full ? 'var(--red)' : 'var(--t4)', ...mono }}>
                  {p.full ? 'at pacing cap' : `${p.load} cvr booked`}
                </div>
              </button>
            );
          })}
        </div>
        {slotFull && (
          <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: tintBg('var(--red)', 8), border: `1px solid ${tintBd('var(--red)')}` }}>
            <div style={{ fontSize: 11, color: 'var(--red)', lineHeight: 1.4, fontWeight: 700 }}>
              At the kitchen's pacing cap — a manager must approve
            </div>
            {overrideBy
              ? <div style={{ fontSize: 11, color: 'var(--t2)', marginTop: 6, ...mono }}>Approved by {overrideBy}</div>
              : <button className="btn btn-red btn-sm" onClick={() => setOverrideBy(approver())} style={{ marginTop: 8, height: 32 }}>Approve (manager)</button>}
          </div>
        )}
        <div style={{ fontSize: 10, color: 'var(--t4)', marginTop: 10, lineHeight: 1.4 }}>
          Slots at the cap stop being sold by the guest widget automatically — only the host can override.
        </div>
      </div>

      {/* ── column 2: table, auto-optimised ── */}
      <div style={{ ...col, flex: 1, minWidth: 260 }}>
        <SectionTitle n={2}>Table — auto-optimised</SectionTitle>
        {taken && (
          <div style={{ marginBottom: 10, padding: '10px 12px', borderRadius: 10, background: tintBg('var(--red)', 10), border: `1px solid ${tintBd('var(--red)')}`, color: 'var(--red)', fontSize: 12, fontWeight: 700 }}>
            {taken} was taken by another device — here are alternatives
          </div>
        )}
        {candidates.length === 0 && (
          <div style={{ padding: '18px 14px', borderRadius: 13, border: '1px dashed var(--bdr2)', color: 'var(--t3)', fontSize: 12, lineHeight: 1.5 }}>
            {(rules.joinGroups || []).length === 0
              ? 'No join groups authored yet — author join groups in Back Office → Floor plan so the optimiser knows which tables may combine.'
              : `No tables fit ${party} at ${time || '—'} — try another time or party size.`}
          </div>
        )}
        {candidates.map((c, i) => {
          const active = i === pick;
          return (
            <button key={c.id || i} onClick={() => setPick(i)} style={{
              textAlign: 'left', borderRadius: 13, padding: '12px 14px', marginBottom: 8, cursor: 'pointer',
              background: active ? tintBg('var(--acc)') : 'var(--bg1)',
              border: `1.5px solid ${active ? tintBd('var(--acc)') : 'var(--bdr)'}`,
              transition: 'all 140ms cubic-bezier(.2,.8,.3,1)',
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 17, fontWeight: 800, color: active ? 'var(--acc)' : 'var(--t1)', letterSpacing: '-0.01em' }}>{c.label}</span>
                <span style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>{c.section || ''} · seats {c.cap}</span>
                <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 20, background: i === 0 ? tintBg('var(--grn)') : tintBg('var(--t3)'), border: `1px solid ${i === 0 ? tintBd('var(--grn)') : tintBd('var(--t3)')}`, color: i === 0 ? 'var(--grn)' : 'var(--t3)' }}>
                  {i === 0 ? 'Best fit' : 'Alternative'}
                </span>
              </div>
              <div style={{ marginTop: 8 }}>
                {(c.reasons || []).map((r, j) => (
                  <div key={j} style={{ fontSize: 11, color: 'var(--t2)', lineHeight: 1.45 }}>
                    <span style={{ color: 'var(--t4)' }}>—</span> {r}
                  </div>
                ))}
              </div>
            </button>
          );
        })}
        <div style={{ marginTop: 4, padding: '12px 14px', borderRadius: 13, background: tintBg('var(--blu)', 8), border: `1px solid ${tintBd('var(--blu)', 22)}`, fontSize: 11, color: 'var(--t2)', lineHeight: 1.5 }}>
          <span style={{ color: 'var(--blu)', fontWeight: 700 }}>Why combinations?</span> Two 2-tops joined beat burning a 6-top on a small party. The limits — turn times, wasted-seat tolerance, max join, pacing — live in Rules and apply immediately.
        </div>
      </div>

      {/* ── column 3: guest & payment ── */}
      <div style={{ ...col, width: 340, flexShrink: 0 }}>
        <SectionTitle n={3}>Guest &amp; payment</SectionTitle>
        {guest ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 11, background: tintBg('var(--acc)'), border: `1px solid ${tintBd('var(--acc)')}`, marginBottom: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 999, display: 'grid', placeItems: 'center', background: tintBg('var(--uv)'), color: 'var(--uv)', fontSize: 12, fontWeight: 800 }}>{initialsOf(guest.name)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{guest.name || 'Guest'}</div>
              <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>{guest.phone || ''}</div>
            </div>
            <button onClick={() => setGuest(null)} style={{ background: 'none', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 15 }}>✕</button>
          </div>
        ) : (
          <>
            <input
              className="input"
              placeholder="Search name or mobile…"
              value={guestQ}
              onChange={(e) => setGuestQ(e.target.value)}
              style={{ width: '100%', height: 42, boxSizing: 'border-box', marginBottom: 8 }}
            />
            {results.map((c) => (
              <button key={c.id || c.phone} onClick={() => { setGuest(c); setResults([]); setWalkIn(false); }} style={{
                textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', marginBottom: 6,
                borderRadius: 11, border: '1px solid var(--bdr)', background: 'var(--bg1)', cursor: 'pointer',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{c.name || 'Unnamed'}</div>
                  <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>
                    {c.phone || 'no phone'}{Number.isFinite(c.visits) ? ` · ${c.visits} visits` : ''}
                  </div>
                </div>
                {Number(c.no_shows) > 0 && (
                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--red)', background: tintBg('var(--red)'), border: `1px solid ${tintBd('var(--red)')}`, borderRadius: 20, padding: '2px 8px' }}>
                    {c.no_shows} no-show{c.no_shows > 1 ? 's' : ''}
                  </span>
                )}
              </button>
            ))}
          </>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--t2)', margin: '2px 0 12px', cursor: 'pointer' }}>
          <input type="checkbox" checked={walkIn} onChange={(e) => { setWalkIn(e.target.checked); if (e.target.checked) setGuest(null); }} />
          Walk-in / no guest attached
        </label>

        {/* payment options — display only (Phase 5 does the charging) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {[
            { k: 'hold', t: 'Card held, no charge', d: `${money(rules.holdPerCover)} per cover, captured only on no-show` },
            { k: 'deposit', t: 'Deposit', d: '£10 per cover, redeemed against the bill as tender' },
            { k: 'prepay', t: 'Full prepay', d: 'Package price, charged now, order lines queued to POS' },
          ].map((o) => (
            <button key={o.k} onClick={() => setPay(o.k)} style={{
              textAlign: 'left', padding: '10px 12px', borderRadius: 12, cursor: 'pointer',
              background: pay === o.k ? tintBg('var(--grn)') : 'var(--bg1)',
              border: `1.5px solid ${pay === o.k ? tintBd('var(--grn)') : 'var(--bdr)'}`,
              transition: 'all 140ms cubic-bezier(.2,.8,.3,1)',
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: pay === o.k ? 'var(--grn)' : 'var(--t1)' }}>{o.t}</div>
              <div style={{ fontSize: 10.5, color: 'var(--t3)', marginTop: 2 }}>{o.d}</div>
            </button>
          ))}
          <div style={{ fontSize: 10, color: 'var(--t4)' }}>Display only for now — no card is charged until the payments phase.</div>
        </div>

        <input className="input" placeholder="Note — occasion, allergies, requests…" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: '100%', height: 40, boxSizing: 'border-box', marginBottom: 12 }} />

        {/* summary */}
        <div style={{ background: 'var(--bg3)', borderRadius: 12, padding: '12px 14px', marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 800, ...mono }}>
            {party} cvr · {time || '—'} · {cand ? cand.label : 'no table'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 3, ...mono }}>
            {time ? `turn ${turnFor(party, rules.turnBands)} min · clear ${toHM(toMin(time) + turnFor(party, rules.turnBands))}` : ''}
          </div>
          <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 3 }}>{guest ? guest.name : walkIn ? 'Walk-in, no guest' : 'No guest attached yet'}</div>
        </div>

        {err && <div style={{ fontSize: 11, color: 'var(--red)', marginBottom: 8 }}>{err}</div>}
        <button
          onClick={confirm}
          disabled={!canConfirm}
          className={canConfirm ? 'btn btn-acc' : 'btn'}
          style={{
            height: 48, width: '100%', fontWeight: 800, fontSize: 14, borderRadius: 12,
            ...(canConfirm ? {} : { background: tintBg('var(--t1)', 6), color: 'var(--t4)', cursor: 'not-allowed', border: '1px solid var(--bdr)' }),
          }}
        >
          {saving ? 'Saving…' : 'Confirm booking'}
        </button>
        <div style={{ fontSize: 10, color: 'var(--t4)', marginTop: 8, lineHeight: 1.4 }}>
          Confirm writes the guest to the CRM, holds the table on the diary and notifies the POS. Nothing is charged.
        </div>
      </div>
    </div>
  );
}
