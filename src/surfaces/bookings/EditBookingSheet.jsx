// src/surfaces/bookings/EditBookingSheet.jsx
//
// Edit a booking (16 Oct 2026). One sheet, shared by the host stand's booking
// card (DiaryScreen Inspector) and Back Office, Table bookings, so a manager
// can fix a booking from the office. The same fields as the Book screen,
// prefilled: date, time, covers, guest name, phone, email, allergens, note,
// and a table picker that shows free and conflicting tables for the chosen
// time (the conflict names the other booking). Save goes through the store's
// editBooking; every refusal is shown INLINE under the Save button. The
// 13 Aug lesson: toasts are not seen on the stand, so the sheet never fails
// silently.
//
// Money: a package booking shows what the package now costs for the new
// covers against what was captured, and says what is still owed or over paid.
// The captured payment itself is never touched here.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { toMin, toHM, turnFor, sessionsToBlocks } from '../../lib/bookings/optimiser.js';
import { conflictsFor, slotTimes, paymentAfterEdit, editRefusal } from '../../lib/bookings/editRules.js';
import { loadBookings } from '../../lib/bookings/bookingsData.js';
import { UK_ALLERGENS } from '../../lib/kioskAllergens.js';
import { moneyMinor } from '../../lib/currency.js';
import { mono, tintBg, tintBd, rulesOf, bookingName, todayISO, Chip } from './bits.jsx';

const COVERS = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12];

const inp = {
  background: 'var(--bg3)', border: '1px solid var(--bdr2)', borderRadius: 9, color: 'var(--t1)',
  padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', height: 38, boxSizing: 'border-box', width: '100%',
};
const lbl = { fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 };

export default function EditBookingSheet({ b, onClose, onSaved, editedBy = null }) {
  const tables = useStore((s) => s.tables) || [];
  const dayBookings = useStore((s) => s.bookings) || [];
  const bookingRules = useStore((s) => s.bookingRules);
  const packages = useStore((s) => s.packages) || [];
  const bookingsDate = useStore((s) => s.bookingsDate);
  const editBooking = useStore((s) => s.editBooking);
  const rules = rulesOf(bookingRules);
  const pkg = b?.packageId ? packages.find((p) => p.id === b.packageId) : null;

  const [date, setDate] = useState(b?.date || bookingsDate || todayISO());
  const [time, setTime] = useState(String(b?.startTime || '').slice(0, 5));
  const [covers, setCovers] = useState(Number(b?.covers) || 1);
  const [name, setName] = useState(b?.customer?.name || '');
  const [phone, setPhone] = useState(b?.customer?.phone || '');
  const [email, setEmail] = useState(b?.customer?.email || '');
  const [allergens, setAllergens] = useState(Array.isArray(b?.customer?.allergens) ? b.customer.allergens : []);
  const [note, setNote] = useState(b?.note || '');
  const [tableIds, setTableIds] = useState(Array.isArray(b?.tables) && b.tables.length ? b.tables : (b?.primaryTableId ? [b.primaryTableId] : []));
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);

  const refusal = editRefusal(b);

  // Times across the service window, plus the booking's own time when it is off grid.
  const times = useMemo(() => {
    const list = slotTimes(rules);
    if (time && !list.includes(time)) list.push(time);
    return list.sort((x, y) => toMin(x) - toMin(y));
  }, [rules, time]);

  // Other bookings on the chosen day: the store when it is the viewed day, a
  // fresh read for any other day. A sheet opened on an unreadable day shows
  // every table as free but Save still re-checks on the server side read.
  const [otherDay, setOtherDay] = useState({ date: null, rows: [] });
  useEffect(() => {
    if (!date || date === bookingsDate) return undefined;
    let alive = true;
    const locId = b?.locationId || useStore.getState().currentLocationId;
    loadBookings(locId, date).then(({ data }) => { if (alive) setOtherDay({ date, rows: data || [] }); });
    return () => { alive = false; };
  }, [date, bookingsDate, b?.locationId]);

  const turnMinutes = (pkg && Number(pkg.turnMinutes) > 0) ? Number(pkg.turnMinutes) : turnFor(Math.max(1, covers), rules.turnBands);
  const floorTables = useMemo(() => tables.filter((t) => !t.parentId).map((t) => ({ id: t.id, label: t.label || t.id, covers: t.maxCovers || 2, section: t.section || '' })), [tables]);

  const others = useMemo(() => {
    const base = date === bookingsDate ? dayBookings : (otherDay.date === date ? otherDay.rows : []);
    if (date !== todayISO()) return base;
    const now = new Date();
    return [...base, ...sessionsToBlocks(tables, base, rules.turnBands, now.getHours() * 60 + now.getMinutes())];
  }, [date, bookingsDate, dayBookings, otherDay, tables, rules.turnBands]);

  // Every table's state for the chosen window, one conflict check per table.
  const grid = useMemo(() => floorTables.map((t) => {
    const probe = { id: b?.id, tables: [t.id], startTime: time, turnMinutes };
    const c = time ? conflictsFor({ booking: probe, others, tables: floorTables }) : [];
    return { ...t, conflicts: c, picked: tableIds.includes(t.id) };
  }), [floorTables, b?.id, time, turnMinutes, others, tableIds]);

  const seats = tableIds.reduce((s, id) => s + (floorTables.find((t) => t.id === id)?.covers || 0), 0);
  const pickedConflicts = grid.filter((t) => t.picked && t.conflicts.length);
  const payment = paymentAfterEdit({ pkg, covers, capturedMinor: b?.paidMinor ?? null });

  const toggleTable = (id) => setTableIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const save = async () => {
    if (saving || !editBooking) return;
    setSaving(true); setErrors([]);
    const res = await editBooking(b.id, {
      date, startTime: time, covers, tables: tableIds, primaryTableId: tableIds[0] || null, note,
      customer: {
        name: name.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        allergens,
      },
    }, { editedBy });
    setSaving(false);
    if (res?.ok) {
      setSaved(res);
      onSaved?.(res);
      return;
    }
    setErrors(res?.errors?.length ? res.errors : [res?.error || 'Booking NOT saved. Try again.']);
  };

  if (!b) return null;
  const labelOf = (id) => floorTables.find((t) => t.id === id)?.label || String(id).slice(-4);

  return (
    <div
      role="dialog" aria-modal="true" aria-label="Edit booking"
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 100002, background: 'rgba(0,0,0,.55)', display: 'grid', placeItems: 'center', padding: 16 }}
    >
      <div style={{ width: 'min(820px, 100%)', maxHeight: '100%', overflowY: 'auto', background: 'var(--bg1)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 16, boxShadow: 'var(--sh, 0 20px 60px rgba(0,0,0,.5))' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--bdr)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 800 }}>Edit booking</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', ...mono }}>{bookingName(b)} · {b.covers} cvr · {String(b.startTime || '').slice(0, 5)} · {(b.tables || []).map(labelOf).join(' + ')}</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--t4)', cursor: 'pointer', fontSize: 18, padding: 4 }}>✕</button>
        </div>

        {refusal ? (
          <div style={{ padding: 18 }}>
            <div role="alert" style={{ padding: '12px 14px', borderRadius: 10, background: tintBg('var(--red)', 10), border: `1px solid ${tintBd('var(--red)')}`, color: 'var(--red)', fontSize: 14, fontWeight: 700, lineHeight: 1.45 }}>{refusal}</div>
            <button className="btn btn-ghost" onClick={onClose} style={{ marginTop: 14, height: 40, width: '100%' }}>Close</button>
          </div>
        ) : saved ? (
          <div style={{ padding: 18 }}>
            <div role="status" style={{ padding: '12px 14px', borderRadius: 10, background: tintBg('var(--grn)', 10), border: `1px solid ${tintBd('var(--grn)')}`, color: 'var(--grn)', fontSize: 14, fontWeight: 700, lineHeight: 1.45 }}>
              Saved. {bookingName(saved.booking)} is now {saved.booking.covers} covers at {saved.booking.startTime} on {saved.booking.date}, {(saved.booking.tables || []).map(labelOf).join(' + ')}.
              {saved.booking.date !== bookingsDate ? ' It has moved to another day, so it leaves this diary.' : ''}
            </div>
            <PaymentLine payment={payment} pkg={pkg} covers={saved.booking.covers} />
            <button className="btn btn-acc" onClick={onClose} style={{ marginTop: 14, height: 42, width: '100%', fontWeight: 800 }}>Done</button>
          </div>
        ) : (
          <div style={{ padding: 18, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 18 }}>
            {/* left: when and how many */}
            <div style={{ minWidth: 0 }}>
              <div style={lbl}>Date</div>
              <input type="date" value={date} onChange={(e) => { if (e.target.value) setDate(e.target.value); }} aria-label="Booking date" style={{ ...inp, marginBottom: 12 }} />
              <div style={lbl}>Time</div>
              <select value={time} onChange={(e) => setTime(e.target.value)} aria-label="Booking time" style={{ ...inp, marginBottom: 12, ...mono }}>
                {times.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <div style={lbl}>Covers</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {COVERS.map((c) => <Chip key={c} active={covers === c} onClick={() => setCovers(c)} style={{ height: 34, minWidth: 36, padding: '0 10px', fontSize: 13 }}>{c}</Chip>)}
                <input type="number" min={1} max={200} value={covers} onChange={(e) => setCovers(Math.max(1, Math.min(200, Math.round(Number(e.target.value) || 1))))}
                  aria-label="Covers" style={{ ...inp, width: 72, height: 34, ...mono }} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 12, ...mono }}>
                turn {turnMinutes} min · clear {time ? toHM(toMin(time) + turnMinutes) : ''}{pkg?.turnMinutes ? ' · package turn' : ''}
              </div>

              <div style={lbl}>Guest</div>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Guest name" style={{ ...inp, marginBottom: 8 }} />
              <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone" aria-label="Guest phone" inputMode="tel" style={{ ...inp, marginBottom: 8, ...mono }} />
              <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" aria-label="Guest email" inputMode="email" style={{ ...inp, marginBottom: 8 }} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 12 }}>
                {UK_ALLERGENS.map((a) => {
                  const on = allergens.includes(a);
                  return (
                    <button key={a} onClick={() => setAllergens((xs) => (on ? xs.filter((x) => x !== a) : [...xs, a]))} aria-pressed={on}
                      style={{ fontSize: 11, fontWeight: 700, padding: '4px 9px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'capitalize',
                        background: on ? tintBg('var(--red)') : 'var(--bg3)', border: `1px solid ${on ? tintBd('var(--red)') : 'var(--bdr2)'}`, color: on ? 'var(--red)' : 'var(--t3)' }}>
                      {a}
                    </button>
                  );
                })}
              </div>
              <div style={lbl}>Note</div>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Occasion, access needs, requests" aria-label="Booking note" style={{ ...inp, height: 64, resize: 'vertical' }} />
            </div>

            {/* right: tables and the money */}
            <div style={{ minWidth: 0 }}>
              <div style={lbl}>Tables for {time} · {tableIds.length ? `${tableIds.map(labelOf).join(' + ')} seats ${seats}` : 'none picked'}{seats && seats < covers ? ` · ${covers} covers will not fit` : ''}</div>
              <div style={{ fontSize: 10.5, color: 'var(--t4)', marginBottom: 8 }}>Tap to add or remove a table. The first picked is the table the tab opens on. Red is taken for this window.</div>
              {floorTables.length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>No floor plan loaded.</div>}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {grid.map((t) => {
                  const busy = t.conflicts.length > 0;
                  const col = t.picked ? (busy ? 'var(--red)' : 'var(--acc)') : busy ? 'var(--red)' : null;
                  return (
                    <button key={t.id} onClick={() => toggleTable(t.id)} aria-pressed={t.picked}
                      title={busy ? t.conflicts[0].text : `Seats ${t.covers}`}
                      style={{
                        minWidth: 58, padding: '7px 9px', borderRadius: 10, fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left',
                        background: col ? tintBg(col, t.picked ? 16 : 8) : 'var(--bg3)',
                        border: `1.5px solid ${t.picked ? (col || 'var(--acc)') : col ? tintBd(col) : 'var(--bdr2)'}`,
                        color: col || 'var(--t1)',
                      }}>
                      <div style={{ fontSize: 13, fontWeight: 800, ...mono }}>{t.label}</div>
                      <div style={{ fontSize: 10, color: busy ? 'var(--red)' : 'var(--t4)', ...mono }}>{busy ? `taken ${toHM(t.conflicts[0].startMin)}` : `seats ${t.covers}`}</div>
                    </button>
                  );
                })}
              </div>
              {pickedConflicts.length > 0 && (
                <div role="alert" style={{ marginTop: 10, padding: '9px 11px', borderRadius: 9, background: tintBg('var(--red)', 10), border: `1px solid ${tintBd('var(--red)')}`, color: 'var(--red)', fontSize: 12.5, fontWeight: 700, lineHeight: 1.45 }}>
                  {pickedConflicts.map((t) => <div key={t.id}>{t.conflicts[0].text}</div>)}
                </div>
              )}

              {pkg && (
                <div style={{ marginTop: 14 }}>
                  <div style={lbl}>Package · {pkg.name}</div>
                  <PaymentLine payment={payment} pkg={pkg} covers={covers} />
                </div>
              )}

              <div style={{ marginTop: 16 }}>
                {errors.length > 0 && (
                  <div role="alert" style={{ marginBottom: 10, padding: '10px 12px', borderRadius: 10, background: tintBg('var(--red)', 10), border: `1px solid ${tintBd('var(--red)')}`, color: 'var(--red)', fontSize: 13, fontWeight: 700, lineHeight: 1.45 }}>
                    <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>Not saved</div>
                    {errors.map((e, i) => <div key={i}>{e}</div>)}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost" onClick={onClose} disabled={saving} style={{ flex: 1, height: 44 }}>Cancel</button>
                  <button className="btn btn-acc" onClick={save} disabled={saving} style={{ flex: 2, height: 44, fontWeight: 800 }}>{saving ? 'Saving…' : 'Save changes'}</button>
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 8, lineHeight: 1.45 }}>
                  Source and package stay as they are. A captured payment is never changed here. Every other host stand sees the change within a moment.
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// What the package costs for these covers against what was captured.
function PaymentLine({ payment, pkg, covers }) {
  if (!pkg || !payment || payment.state === 'none') return null;
  const unit = pkg.paymentModel === 'deposit' ? `${moneyMinor(Math.round((pkg.depositPerCover || 0) * 100))} deposit per cover` : pkg.priceUnit === 'per_booking' ? `${moneyMinor(Math.round((pkg.price || 0) * 100))} per booking` : `${moneyMinor(Math.round((pkg.price || 0) * 100))} per cover`;
  let line, col = 'var(--t2)';
  if (payment.state === 'unknown') line = `${unit}. ${moneyMinor(payment.dueMinor)} due for ${covers} covers. The payment ledger is not visible from here, check Back Office before taking money.`;
  else if (payment.state === 'settled') { line = `${unit}. ${moneyMinor(payment.dueMinor)} due for ${covers} covers, ${moneyMinor(payment.capturedMinor)} paid. Settled.`; col = 'var(--grn)'; }
  else if (payment.state === 'owed') { line = `${unit}. ${moneyMinor(payment.dueMinor)} due for ${covers} covers, ${moneyMinor(payment.capturedMinor)} paid. ${moneyMinor(payment.diffMinor)} still to take on the till.`; col = 'var(--orn)'; }
  else { line = `${unit}. ${moneyMinor(payment.dueMinor)} due for ${covers} covers, ${moneyMinor(payment.capturedMinor)} paid. ${moneyMinor(payment.diffMinor)} over paid, refund it in Adyen.`; col = 'var(--orn)'; }
  return <div style={{ marginTop: 6, fontSize: 12.5, lineHeight: 1.45, color: col, fontWeight: col === 'var(--t2)' ? 500 : 700 }}>{line}</div>;
}
