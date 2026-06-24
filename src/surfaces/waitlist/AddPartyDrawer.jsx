// src/surfaces/waitlist/AddPartyDrawer.jsx
//
// Add-party drawer — phone-first. The host types a number; on a long-enough number
// we look the guest up in the CRM (store.lookupGuestByPhone → fetchCustomerByPhone).
// A hit shows a UV "returning guest" card and auto-fills the name; a miss shows a
// quiet "new contact" line. Then: size stepper, zone pills (from config zones or the
// floor's sections), notes, and a live quote footer that re-estimates as the party
// shape changes. "Add to queue" calls store.addParty and closes.
//
// The live quote here is computed from the same pure estimator + live tables view the
// board uses, so what the host sees in the footer is exactly what the party will get.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { estimate, bandFor, DEFAULT_BANDS, DEFAULT_QUOTE_RULES, isActive } from '../../lib/waitlist/waitlist';
import { Icon } from '../../components/ServOSIcons';

const mono = { fontFamily: 'var(--font-mono)' };

function tablesView(tables = []) {
  return tables
    .filter(t => !t.parentId)
    .map(t => ({
      cap: t.maxCovers,
      status: t.status === 'available' ? 'open' : t.status === 'clearing' ? 'clearing' : 'seated',
      section: t.section,
    }));
}

export default function AddPartyDrawer({ loc, operator, onClose }) {
  const tables = useStore(s => s.tables) || [];
  const waitlist = useStore(s => s.waitlist) || [];
  const cfg = useStore(s => s.waitlistConfig);
  const addParty = useStore(s => s.addParty);
  const lookup = useStore(s => s.lookupGuestByPhone);

  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [size, setSize] = useState(2);
  const [zone, setZone] = useState(null);     // section pref id
  const [notes, setNotes] = useState('');
  const [guest, setGuest] = useState(null);   // CRM card or null
  const [looking, setLooking] = useState(false);
  const [lookedFor, setLookedFor] = useState(''); // phone we last resolved
  const [busy, setBusy] = useState(false);
  const lookupTimer = useRef(null);

  // zones: prefer configured zones, else derive sections from the floor
  const zones = useMemo(() => {
    if (cfg?.zones?.length) return cfg.zones.map(z => ({ id: z.id, name: z.name }));
    const seen = new Set(); const out = [];
    tables.filter(t => !t.parentId).forEach(t => { const s = t.section || 'main'; if (!seen.has(s)) { seen.add(s); out.push({ id: s, name: s }); } });
    return out;
  }, [cfg, tables]);

  // debounced CRM lookup as the host types
  useEffect(() => {
    const digits = phone.replace(/[^\d+]/g, '');
    if (lookupTimer.current) clearTimeout(lookupTimer.current);
    if (digits.length < 7) { setGuest(null); setLookedFor(''); return; }
    if (typeof lookup !== 'function') return;
    lookupTimer.current = setTimeout(async () => {
      setLooking(true);
      const card = await lookup(phone);
      setLooking(false);
      setLookedFor(phone);
      setGuest(card || null);
      if (card?.name && !name) setName(card.name);
    }, 450);
    return () => { if (lookupTimer.current) clearTimeout(lookupTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone]);

  // live quote — same maths as the board
  const bands = cfg?.bands?.length ? cfg.bands : DEFAULT_BANDS;
  const rules = cfg
    ? { buffer: cfg.buffer ?? 5, roundTo: cfg.roundTo ?? 5, maxQuote: cfg.maxQuote ?? 120, defaultTurn: cfg.defaultTurn ?? 60 }
    : DEFAULT_QUOTE_RULES;
  const tv = useMemo(() => tablesView(tables), [tables]);
  const waitingForEst = useMemo(
    () => waitlist.filter(e => isActive(e.status)).map(e => ({ size: e.size, status: e.status, quoted: e.quoted })),
    [waitlist],
  );
  const quote = useMemo(
    () => estimate({ size, sectionPref: zone, tables: tv, waiting: waitingForEst, bands, rules }),
    [size, zone, tv, waitingForEst, bands, rules],
  );

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await addParty?.({
        name: name.trim() || guest?.name || 'Guest',
        phone: phone.trim() || null,
        size,
        sectionPref: zone || null,
        notes: notes.trim() || '',
        customer: guest || null,
        customerId: guest?.customerId || null,
      });
      onClose?.();
    } finally {
      setBusy(false);
    }
  };

  const newContact = lookedFor && lookedFor === phone && !guest && !looking && phone.replace(/[^\d+]/g, '').length >= 7;

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(8,9,12,0.55)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} className="sv-glass" style={{ width: '100%', maxWidth: 520, borderRadius: '22px 22px 0 0', padding: '20px 18px 24px', maxHeight: '92vh', overflowY: 'auto' }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 800 }}>Add a party</div>
            <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>Look them up, then quote a wait</div>
          </div>
          <button onClick={onClose} className="sv-glass" style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--t1)', border: '1px solid var(--bdr)' }}><Icon name="close" size={17} /></button>
        </div>

        {/* phone-first */}
        <Label>Phone</Label>
        <input
          value={phone}
          onChange={e => setPhone(e.target.value)}
          inputMode="tel"
          placeholder="07… or +44…"
          className="input"
          style={{ fontSize: 17, letterSpacing: '.04em', ...mono }}
          autoFocus
        />

        {/* CRM result */}
        {looking && <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 8, ...mono }}>Looking up…</div>}
        {guest && !looking && (
          <div style={{ marginTop: 10, padding: '12px 14px', borderRadius: 14, background: 'rgba(124,92,255,0.10)', border: '1px solid rgba(124,92,255,0.30)', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'rgba(124,92,255,0.18)', color: 'var(--uv)', flexShrink: 0 }}><Icon name="user" size={19} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--uv-glow, var(--uv))' }}>{guest.name || 'Returning guest'}</div>
              <div style={{ fontSize: 10.5, color: 'var(--t3)', ...mono }}>
                Returning guest
                {Number.isFinite(guest.credit) && guest.credit > 0 ? ` · ${guest.credit} pts` : ''}
                {guest.tier ? ` · ${guest.tier}` : ''}
              </div>
              {guest.allergens?.length ? (
                <div style={{ fontSize: 10.5, color: 'var(--amber, var(--orn))', marginTop: 3, ...mono }}>Allergens: {guest.allergens.join(', ')}</div>
              ) : null}
            </div>
          </div>
        )}
        {newContact && (
          <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, ...mono }}>
            <Icon name="plus" size={13} /> New contact — they'll be added to the CRM
          </div>
        )}

        {/* name */}
        <Label style={{ marginTop: 16 }}>Name</Label>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Party name" className="input" style={{ fontSize: 16 }} />

        {/* size stepper */}
        <Label style={{ marginTop: 16 }}>Party size</Label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Stepper onClick={() => setSize(s => Math.max(1, s - 1))} icon="minus" disabled={size <= 1} />
          <div style={{ flex: 1, textAlign: 'center' }}>
            <span style={{ fontFamily: 'Syne, Space Grotesk, sans-serif', fontSize: 38, fontWeight: 800, color: 'var(--t1)' }}>{size}</span>
            <span style={{ fontSize: 11, color: 'var(--t3)', marginLeft: 8, ...mono }}>band {bandFor(size, bands).label}</span>
          </div>
          <Stepper onClick={() => setSize(s => Math.min(20, s + 1))} icon="plus" disabled={size >= 20} />
        </div>
        <div style={{ display: 'flex', gap: 7, marginTop: 10, flexWrap: 'wrap' }}>
          {[1, 2, 3, 4, 5, 6, 8].map(n => (
            <button key={n} onClick={() => setSize(n)} className="sv-glass sv-pill" style={{ flex: '1 0 auto', minWidth: 44, padding: '9px 0', fontWeight: 700, cursor: 'pointer', border: `1px solid ${size === n ? 'var(--acc-b)' : 'var(--bdr)'}`, background: size === n ? 'var(--acc-d)' : 'var(--inset)', color: size === n ? 'var(--acc)' : 'var(--t2)', ...mono }}>{n}</button>
          ))}
        </div>

        {/* zone pills */}
        {zones.length > 1 && (
          <>
            <Label style={{ marginTop: 16 }}>Seating preference</Label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <ZonePill on={zone === null} onClick={() => setZone(null)}>Any</ZonePill>
              {zones.map(z => <ZonePill key={z.id} on={zone === z.id} onClick={() => setZone(z.id)}>{z.name}</ZonePill>)}
            </div>
          </>
        )}

        {/* notes */}
        <Label style={{ marginTop: 16 }}>Notes</Label>
        <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="High chair, window seat…" className="input" style={{ fontSize: 14 }} />

        {/* live quote footer + add */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 22 }}>
          <div style={{ flex: '0 0 auto', textAlign: 'center' }}>
            <div style={{ fontSize: 9.5, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.1em', ...mono }}>Quote</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
              <span style={{ fontFamily: 'Syne, Space Grotesk, sans-serif', fontSize: 34, fontWeight: 800, color: 'var(--uv)', textShadow: '0 0 22px rgba(124,92,255,0.4)' }}>{quote}</span>
              <span style={{ fontSize: 12, color: 'var(--t3)', ...mono }}>min</span>
            </div>
          </div>
          <button onClick={submit} disabled={busy} className="btn btn-acc" style={{ flex: 1, padding: 16, fontSize: 15, fontWeight: 800, borderRadius: 14, opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Adding…' : 'Add to queue'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Label({ children, style }) {
  return <div style={{ fontSize: 10.5, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 7, ...mono, ...style }}>{children}</div>;
}
function Stepper({ onClick, icon, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} className="sv-glass" style={{ width: 54, height: 54, borderRadius: 14, display: 'grid', placeItems: 'center', cursor: disabled ? 'default' : 'pointer', color: 'var(--t1)', border: '1px solid var(--bdr)', opacity: disabled ? 0.4 : 1 }}>
      <Icon name={icon} size={20} />
    </button>
  );
}
function ZonePill({ on, onClick, children }) {
  return (
    <button onClick={onClick} className="sv-pill" style={{ padding: '9px 16px', cursor: 'pointer', fontWeight: 700, fontSize: 13, fontFamily: 'inherit', border: `1px solid ${on ? 'var(--acc-b)' : 'var(--bdr)'}`, background: on ? 'var(--acc-d)' : 'var(--inset)', color: on ? 'var(--acc)' : 'var(--t2)', textTransform: 'capitalize' }}>{children}</button>
  );
}
