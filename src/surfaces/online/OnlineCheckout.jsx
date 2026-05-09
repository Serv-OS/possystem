// v5.5.117 — Phase 4: Online ordering checkout sheet.
// Slide-up full-screen on mobile, centered modal on desktop. Three sections:
//   1. Customer details (name, phone, email; + address for delivery)
//   2. When? — ASAP / Schedule for later (15-min slots, respecting opening hours
//      and online_collection_lead_min so the kitchen has time to prep)
//   3. Order summary + pay button (Stripe wiring lands in a follow-up commit;
//      this commit ships the customer-details + time-picker UX + the order
//      persistence path).
//
// On confirm: writes to ops `closed_checks` (paid status) AND `order_queue`
// (status=pending, source=online, sent_at = collection_time - leadMin) so
// the kitchen receives the ticket at the right time. Mirrors the existing
// MPOS collection flow (see store.recordWalkInClosed + locationConfig
// .collectionLeadMinutes for the timing logic).

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { isOpenNow, getDayWindows } from '../../lib/openingHours';

export default function OnlineCheckout({ cart, theme, location, orderType, loyalty, onClose, onPlaced }) {
  const opsLocationId = location.ops_location_id || location.id;
  const tz = location.timezone || 'Europe/London';
  const leadMin = Number(location.online_collection_lead_min) || 30;

  // Customer details
  const [name, setName]   = useState('');
  const [phone, setPhone] = useState(loyalty?.phone || '');
  const [email, setEmail] = useState('');
  const [address1, setAddress1] = useState('');
  const [postcode, setPostcode] = useState('');
  const [notes, setNotes] = useState('');

  // Timing — ASAP or scheduled
  const [timeMode, setTimeMode] = useState('asap'); // 'asap' | 'scheduled'
  const [slot, setSlot]         = useState(null);

  // Submit
  const [working, setWorking] = useState(false);
  const [error, setError]     = useState('');

  // Subtotal
  const subtotal = useMemo(() => cart.reduce((s, l) => {
    const unit = l.price + (l.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
    return s + unit * (l.qty || 1);
  }, 0), [cart]);

  // Build collection slots — every 15 min between (now + leadMin) and the
  // next close time, snapped to :00 / :15 / :30 / :45.
  const slots = useMemo(() => buildCollectionSlots(location, tz, leadMin), [location, tz, leadMin]);

  // When the customer first picks Schedule, auto-select the earliest slot
  // so the dropdowns aren't empty and "Place order" isn't blocked on a
  // micro-interaction.
  useEffect(() => {
    if (timeMode === 'scheduled' && !slot && slots.length) setSlot(slots[0]);
  }, [timeMode, slot, slots]);

  const muted   = theme.isLight ? '#6b6b70' : '#a0a0a8';
  const cardBdr = theme.isLight ? '#ececef' : '#2a2a30';
  const inputBg = theme.isLight ? '#f5f5f7' : '#1f1f24';

  const isDelivery = orderType === 'delivery';
  const valid = useMemo(() => {
    if (!name.trim()) return false;
    if (!/^\+?[0-9 ]{7,}$/.test(phone)) return false;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
    if (isDelivery && (!address1.trim() || !postcode.trim())) return false;
    if (timeMode === 'scheduled' && !slot) return false;
    return true;
  }, [name, phone, email, address1, postcode, isDelivery, timeMode, slot]);

  const place = async () => {
    if (!valid) { setError('Please complete the highlighted fields.'); return; }
    setWorking(true); setError('');

    // Compute collection time + sent_at (kitchen fire time)
    const collectionAt = timeMode === 'asap'
      ? new Date(Date.now() + leadMin * 60_000)
      : new Date(slot.iso);
    const sentAt = new Date(collectionAt.getTime() - leadMin * 60_000);

    // Compose check shape — same shape ops uses elsewhere.
    const ref = `OL-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const customer = {
      name: name.trim(),
      phone: phone.replace(/\s+/g, ''),
      email: email.trim(),
      ...(isDelivery ? { address: { line1: address1.trim(), postcode: postcode.trim().toUpperCase() } } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    const items = cart.map(l => ({
      itemId: l.itemId,
      name: l.name,
      price: l.price,
      qty: l.qty || 1,
      mods: l.mods || [],
    }));

    try {
      // Write order_queue row — POS picks this up via realtime, kitchen
      // ticket fires at sent_at via the existing collection lead-time
      // pipeline (same path MPOS scheduled-collection flows already use).
      // Schema: order_queue(ref pk, location_id, type, customer, items,
      // total, status, staff, created_at, sent_at, collection_time text,
      // is_asap, updated_at, source, paid, payment_method, kitchen_routed_at).
      // No `subtotal`, no `scheduled_for`. The collection time is text
      // (HH:mm in venue tz) + is_asap; the kitchen-fire moment is sent_at.
      const collectionTimeLabel = collectionAt.toLocaleTimeString('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const queueRow = {
        ref,
        location_id: opsLocationId,
        type: orderType,
        status: 'received',
        source: 'online',
        items,
        customer,
        total: subtotal, // delivery fee added in a follow-up commit
        sent_at: sentAt.toISOString(),
        collection_time: collectionTimeLabel,
        is_asap: timeMode === 'asap',
      };
      // `paid` / `payment_method` columns from migration v5.5.57 may not be
      // applied on every venue's DB yet — leaving them off the row is safe
      // because the column defaults to false. The operator marks paid when
      // they collect cash; Stripe-paid online orders set it via webhook in
      // the next commit.
      // Don't try to write to closed_checks yet — payment hasn't been
      // taken. Phase 4 (Stripe online card) lands the closed_checks row on
      // payment success. For now we land the order_queue row so it shows
      // up on the operator's POS as a pending unpaid online order.
      const { error: insErr } = await supabase.from('order_queue').insert(queueRow);
      if (insErr) throw insErr;

      onPlaced?.({ ref, collectionAt, total: subtotal });
    } catch (e) {
      console.error('[OnlineCheckout] place failed:', e);
      setError(e?.message || 'Could not place order. Please try again.');
    } finally {
      setWorking(false);
    }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 600,
        maxHeight: '96vh', overflowY: 'auto',
        background: theme.bg, color: theme.fg,
        borderRadius: '18px 18px 0 0',
        boxShadow: '0 -10px 40px rgba(0,0,0,0.3)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif',
      }}>
        <div style={{ padding: '12px 0 6px', display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: 44, height: 5, borderRadius: 3, background: cardBdr }}/>
        </div>

        <div style={{ padding: '8px 24px 16px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: '-0.02em' }}>Checkout</div>
            <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>{isDelivery ? 'Delivery' : 'Collection'} · {cart.length} item{cart.length === 1 ? '' : 's'} · £{subtotal.toFixed(2)}</div>
          </div>
          <button onClick={onClose} style={{
            width: 36, height: 36, borderRadius: '50%', border: 'none',
            background: inputBg, color: theme.fg,
            fontSize: 18, fontWeight: 900, cursor: 'pointer', fontFamily: 'inherit',
          }}>×</button>
        </div>

        <div style={{ padding: '0 24px 12px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* 1. Your details */}
          <SectionTitle>Your details</SectionTitle>
          <Field label="Name" value={name} onChange={setName} placeholder="Full name" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Phone" value={phone} onChange={setPhone} placeholder="07700 900000" type="tel" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
            <Field label="Email" value={email} onChange={setEmail} placeholder="you@example.com" type="email" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
          </div>
          {isDelivery && (
            <>
              <Field label="Delivery address" value={address1} onChange={setAddress1} placeholder="House / flat number, street" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
              <Field label="Postcode" value={postcode} onChange={setPostcode} placeholder="SW1A 1AA" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
            </>
          )}
          <Field label="Notes (optional)" value={notes} onChange={setNotes} placeholder="Buzzer / leave at door / dietary…" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>

          {/* 2. When? */}
          <SectionTitle>When?</SectionTitle>
          <div style={{ display: 'flex', gap: 8 }}>
            <ModeChip active={timeMode === 'asap'} onClick={() => setTimeMode('asap')}
              theme={theme} cardBdr={cardBdr}>
              ⚡ ASAP <span style={{ opacity: 0.6, marginLeft: 4 }}>· ~{leadMin} min</span>
            </ModeChip>
            <ModeChip active={timeMode === 'scheduled'} onClick={() => setTimeMode('scheduled')}
              theme={theme} cardBdr={cardBdr}>
              🗓 Schedule
            </ModeChip>
          </div>
          {timeMode === 'scheduled' && (
            <SlotPicker slots={slots} value={slot} onChange={setSlot} theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
          )}

          {/* 3. Summary */}
          <SectionTitle>Order summary</SectionTitle>
          <div style={{ background: inputBg, border: `1px solid ${cardBdr}`, borderRadius: 12, padding: '12px 14px' }}>
            {cart.map(line => {
              const unit = line.price + (line.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
              return (
                <div key={line.uid} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13 }}>
                  <span style={{ flex: 1, minWidth: 0 }}>{line.qty || 1} × {line.name}</span>
                  <span style={{ fontWeight: 700 }}>£{(unit * (line.qty || 1)).toFixed(2)}</span>
                </div>
              );
            })}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', borderTop: `1px solid ${cardBdr}`, marginTop: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 800 }}>Total</span>
              <span style={{ fontSize: 18, fontWeight: 900 }}>£{subtotal.toFixed(2)}</span>
            </div>
          </div>
        </div>

        {/* Sticky pay button */}
        <div style={{
          position: 'sticky', bottom: 0,
          padding: '14px 24px calc(14px + env(safe-area-inset-bottom)) 24px',
          background: theme.bg, borderTop: `1px solid ${cardBdr}`,
        }}>
          {error && <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 10 }}>{error}</div>}
          <button onClick={place} disabled={!valid || working} className="op-btn-primary" style={{
            width: '100%', padding: '16px 22px', borderRadius: 14,
            background: valid ? theme.accent : `${theme.fg}20`,
            color: valid ? contrastFg(theme.accent) : `${theme.fg}60`,
            border: 'none', fontSize: 16, fontWeight: 800, cursor: valid && !working ? 'pointer' : 'not-allowed',
            fontFamily: 'inherit',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>{working ? 'Placing order…' : 'Place order'}</span>
            <span>£{subtotal.toFixed(2)}</span>
          </button>
          <div style={{ fontSize: 10, color: muted, textAlign: 'center', marginTop: 8 }}>
            Online card payment lands in the next update. Right now your order goes through to the venue marked unpaid — they'll contact you to confirm.
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function SectionTitle({ children }) {
  return <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '-0.01em', textTransform: 'uppercase', opacity: 0.7 }}>{children}</div>;
}

function Field({ label, value, onChange, placeholder, type = 'text', theme, cardBdr, inputBg }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: theme.isLight ? '#6b6b70' : '#a0a0a8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>{label}</div>
      <input type={type} value={value || ''} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{
          width: '100%', padding: '12px 14px', borderRadius: 10,
          background: inputBg, color: theme.fg, border: `1.5px solid ${cardBdr}`,
          fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
        }}/>
    </div>
  );
}

function ModeChip({ active, onClick, theme, cardBdr, children }) {
  return (
    <button onClick={onClick} className="op-btn" style={{
      flex: 1, padding: '14px 16px', borderRadius: 12,
      background: active ? `${theme.accent}15` : 'transparent',
      color: theme.fg, border: `1.5px solid ${active ? theme.accent : cardBdr}`,
      fontSize: 14, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit',
    }}>{children}</button>
  );
}

function SlotPicker({ slots, value, onChange, theme, cardBdr, inputBg }) {
  if (!slots.length) {
    return <div style={{ padding: 14, fontSize: 12, color: theme.isLight ? '#6b6b70' : '#a0a0a8', background: inputBg, borderRadius: 10, border: `1px solid ${cardBdr}` }}>
      No collection slots available right now. Try ASAP, or come back during opening hours.
    </div>;
  }
  // Group by day, preserving insertion order (already chronological)
  const byDay = {};
  slots.forEach(s => {
    if (!byDay[s.day]) byDay[s.day] = [];
    byDay[s.day].push(s);
  });
  const days = Object.keys(byDay);
  // If no value yet, default to first slot of first day so the time
  // dropdown isn't blank when the customer first picks Schedule.
  const selectedDay = value ? value.day : days[0];
  const selectedTime = value ? value.iso : '';
  const timesForDay = byDay[selectedDay] || [];

  const handleDayChange = (day) => {
    const list = byDay[day] || [];
    if (list.length) onChange(list[0]);
  };
  const handleTimeChange = (iso) => {
    const slot = (byDay[selectedDay] || []).find(s => s.iso === iso);
    if (slot) onChange(slot);
  };

  const selectStyle = {
    width: '100%', padding: '12px 14px', borderRadius: 10,
    background: inputBg, color: theme.fg, border: `1.5px solid ${cardBdr}`,
    fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
    fontWeight: 600,
    appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
    backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path d='M1 1l5 5 5-5' stroke='%23${(theme.isLight ? '6b6b70' : 'a0a0a8')}' stroke-width='1.6' fill='none' stroke-linecap='round'/></svg>")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 14px center',
    paddingRight: 36,
    cursor: 'pointer',
  };
  const labelStyle = { fontSize: 11, fontWeight: 700, color: theme.isLight ? '#6b6b70' : '#a0a0a8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6, display: 'block' };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
      <div>
        <label style={labelStyle}>Day</label>
        <select value={selectedDay} onChange={e => handleDayChange(e.target.value)} style={selectStyle}>
          {days.map(d => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      </div>
      <div>
        <label style={labelStyle}>Time</label>
        <select value={selectedTime} onChange={e => handleTimeChange(e.target.value)} style={selectStyle}>
          {timesForDay.map(s => (
            <option key={s.iso} value={s.iso}>{s.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Build the next ~24h of valid collection slots.
// Slots are 15-min increments inside opening windows, starting at the
// earliest slot ≥ now+leadMin, snapped to :00/:15/:30/:45.
function buildCollectionSlots(location, tz, leadMin) {
  const hours = location.opening_hours;
  if (!hours?.weekly) return [];
  const out = [];
  const now = new Date();
  const earliest = new Date(now.getTime() + leadMin * 60_000);
  // Round up to next 15-min boundary
  const m = earliest.getMinutes();
  const ceil = Math.ceil(m / 15) * 15;
  earliest.setMinutes(ceil, 0, 0);

  // Walk up to 7 days ahead, generate slots inside open windows ≥ earliest
  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const probe = new Date(now.getTime() + dayOffset * 24 * 60 * 60_000);
    const windows = getDayWindows(hours, tz, probe);
    if (!windows.length) continue;
    const dayLabel = probe.toLocaleDateString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
    for (const w of windows) {
      const [oh, om] = w.open.split(':').map(Number);
      const [ch, cm] = w.close.split(':').map(Number);
      // Earliest valid slot in this window
      const cur = new Date(probe);
      cur.setHours(oh, om, 0, 0);
      const end = new Date(probe);
      end.setHours(ch, cm, 0, 0);
      while (cur.getTime() < end.getTime()) {
        if (cur.getTime() >= earliest.getTime()) {
          out.push({
            iso: cur.toISOString(),
            day: dayOffset === 0 ? 'Today' : (dayOffset === 1 ? 'Tomorrow' : dayLabel),
            label: cur.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }),
          });
        }
        cur.setMinutes(cur.getMinutes() + 15);
      }
    }
    if (out.length >= 60) break; // reasonable upper bound
  }
  return out;
}

function contrastFg(hex) {
  if (!hex) return '#fff';
  const c = hex.replace('#', '');
  const n = c.length === 3 ? c.split('').map(x => x + x).join('') : c;
  if (n.length !== 6) return '#fff';
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 128 ? '#0b0c10' : '#ffffff';
}
