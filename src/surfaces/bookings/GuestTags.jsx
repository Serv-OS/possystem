// src/surfaces/bookings/GuestTags.jsx
//
// Guest tags (16 Oct 2026, v5.11.70 host tools, plan item 8). VIP, Regular,
// the visit count, no-shows and the venue's own tags as chips beside a guest's
// name, from the CRM customer record. Used on the host stand's booking card,
// the Book screen and the Edit sheet. The rules (which tags show, when a guest
// is a Regular) are guestChips in supabase/functions/_shared/bookingHost.js
// (tested).
//
// Renders nothing for a guest with no CRM record, while loading, or when the
// record has nothing to say, so it can sit anywhere without moving a layout.
//
// 17 Oct 2026 (v5.11.72, PR 295 follow up): the till's check header shows
// TillGuestTags below, VIP and Regular only (lib/bookings/tillGuestTags.js),
// inside a boundary that renders nothing if anything in here ever fails, so a
// display chip can never take the check down at a live venue.

import { Component, useEffect, useState } from 'react';
import { guestChips } from '../../../supabase/functions/_shared/bookingHost.js';
import { loadGuestFacts, cachedGuestFacts, customerIdOf } from '../../lib/bookings/hostData.js';
import { TILL_CHIP_KEYS } from '../../lib/bookings/tillGuestTags.js';

const TONE = {
  gold: { col: '#e8a020', bg: 'rgba(232,160,32,.14)', bd: 'rgba(232,160,32,.45)' },
  green: { col: 'var(--grn)', bg: 'color-mix(in srgb, var(--grn) 13%, transparent)', bd: 'color-mix(in srgb, var(--grn) 35%, transparent)' },
  grey: { col: 'var(--t2)', bg: 'color-mix(in srgb, var(--t1) 7%, transparent)', bd: 'color-mix(in srgb, var(--t1) 16%, transparent)' },
  red: { col: 'var(--red)', bg: 'color-mix(in srgb, var(--red) 12%, transparent)', bd: 'color-mix(in srgb, var(--red) 35%, transparent)' },
};

// only: the chip keys to show (the till passes TILL_CHIP_KEYS); null shows them all.
export default function GuestTags({ customerId = null, customer = null, compact = false, only = null, style = {} }) {
  const id = customerId && /^[0-9a-f-]{36}$/i.test(String(customerId)) ? String(customerId) : customerIdOf(customer);
  // Keyed on the id it was loaded for, so a different guest never shows the last one's chips.
  const [loaded, setLoaded] = useState({ id: null, facts: null });
  useEffect(() => {
    if (!id) return undefined;
    let alive = true;
    loadGuestFacts(id)
      .then((facts) => { if (alive) setLoaded({ id, facts }); })
      .catch(() => { if (alive) setLoaded({ id, facts: null }); });
    return () => { alive = false; };
  }, [id]);
  if (!id) return null;
  const facts = loaded.id === id ? loaded.facts : cachedGuestFacts(id);
  if (!facts) return null;
  const chips = guestChips(facts).filter((c) => !only || only.includes(c.key)).slice(0, compact ? 3 : 6);
  if (!chips.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: compact ? 2 : 5, ...style }}>
      {chips.map((c) => {
        const t = TONE[c.tone] || TONE.grey;
        return (
          <span key={c.key} style={{
            fontSize: compact ? 10 : 11, fontWeight: 800, lineHeight: 1.2, whiteSpace: 'nowrap',
            padding: compact ? '1px 6px' : '2px 8px', borderRadius: 999, textTransform: c.key.startsWith('tag:') ? 'capitalize' : 'none',
            color: t.col, background: t.bg, border: `1px solid ${t.bd}`,
          }}>{c.key === 'vip' ? `★ ${c.label}` : c.label}</span>
        );
      })}
    </div>
  );
}

// The till's check header: VIP and Regular only, and nothing at all on any fault.
class Quiet extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e) { console.warn('[GuestTags] till chips hidden after an error:', e?.message || e); }
  render() { return this.state.failed ? null : this.props.children; }
}

export function TillGuestTags({ customer = null }) {
  return <Quiet><GuestTags customer={customer} compact only={TILL_CHIP_KEYS} /></Quiet>;
}
