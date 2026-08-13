// src/backoffice/sections/TableBookings.jsx
//
// Back Office → Channels → Table bookings. The owner-facing home for bookings
// config — the same rules the host stand's Rules tab edits (RulesScreen.jsx),
// redrawn in the BO's own visual language (PackageBuilder/MenuBoards idiom),
// plus the booking-widget controls and the public /book link + website embed.
//
// Every control writes through updateBookingRules — the store applies the
// patch optimistically then persists to booking_rules immediately, so the
// host-stand diary and the optimiser react live. No save button by design.
//
// The public URL follows OnlineOrdering.jsx exactly: platform DB `locations`
// row via ops_location_id (fallback: id), slug → https://<slug>.<CUSTOMER_ROOT>/book.

import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { money } from '../../lib/currency';
import { CUSTOMER_ROOT } from '../../lib/env';
import { platformSupabase, getLocationId } from '../../lib/supabase';
import { DEFAULT_RULES, DEFAULT_TURN_BANDS } from '../../lib/bookings/optimiser.js';

const MONO = 'var(--font-mono, ui-monospace, monospace)';

const BANDS = [
  { key: '1-2', label: '1–2 covers' },
  { key: '3-4', label: '3–4 covers' },
  { key: '5-6', label: '5–6 covers' },
  { key: '7+', label: '7+ covers' },
];

// Mirrors FALLBACK_RULES in surfaces/bookings/bits.jsx + the DB column
// defaults for the widget pair (migration 20260811b: enabled, 90 days).
// Screens must tolerate bookingRules === null — no rules row exists until
// the first write.
const FALLBACK = {
  ...DEFAULT_RULES,
  turnBands: DEFAULT_TURN_BANDS,
  holdPerCover: 20,
  cancellationWindowHours: 24,
  protectLargeTables: true,
  pacingOverrideRequiresPin: true,
  widgetEnabled: true,
  widgetMaxDaysAhead: 90,
  joinGroups: [],
};

export default function TableBookings() {
  const bookingRules = useStore(s => s.bookingRules);
  const updateBookingRules = useStore(s => s.updateBookingRules);

  // Idempotent load so the BO has rules even without a POS boot (PackageBuilder pattern).
  useEffect(() => { useStore.getState().loadBookingsFromDB?.(); }, []);

  const rules = {
    ...FALLBACK,
    ...(bookingRules || {}),
    turnBands: { ...DEFAULT_TURN_BANDS, ...(bookingRules?.turnBands || {}) },
  };
  const patch = (p) => updateBookingRules?.(p);
  const setBand = (key, v) => patch({ turnBands: { ...rules.turnBands, [key]: v } });

  // ── venue slug → public /book URL (identical lookup to OnlineOrdering) ────
  const [slug, setSlug] = useState(null);
  const [slugReady, setSlugReady] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const opsLocId = await getLocationId().catch(() => null);
        if (opsLocId && platformSupabase) {
          const select = 'id, online_slug';
          let r = (await platformSupabase.from('locations').select(select).eq('ops_location_id', opsLocId).maybeSingle()).data;
          if (!r) r = (await platformSupabase.from('locations').select(select).eq('id', opsLocId).maybeSingle()).data;
          if (alive) setSlug(r?.online_slug || null);
        }
      } catch { /* no platform row — the widget card explains */ }
      if (alive) setSlugReady(true);
    })();
    return () => { alive = false; };
  }, []);

  const bookUrl = slug ? `https://${slug}.${CUSTOMER_ROOT}/book` : null;
  const embed = bookUrl
    ? `<iframe src="${bookUrl}" style="width:100%;max-width:560px;height:820px;border:0;border-radius:16px" title="Book a table" loading="lazy"></iframe>`
    : '';

  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedEmbed, setCopiedEmbed] = useState(false);
  const copy = async (text, setFlag) => {
    try {
      await navigator.clipboard.writeText(text);
      setFlag(true); setTimeout(() => setFlag(false), 1800);
    } catch { /* clipboard blocked — the text is shown for manual copy */ }
  };

  const joinGroupCount = bookingRules?.joinGroups?.length || 0;

  return (
    <div style={{ maxWidth: 1400 }}>
      <Head title="Table bookings"
        sub="The guard rails the diary, the optimiser and the booking widget obey — turn times, joins, pacing and no-show cover. Changes save instantly and every host stand reacts live; there is no save button." />

      {/* ── 1 · Rules ── */}
      <div style={{ display: 'flex', gap: 14, marginTop: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ ...S.section, flex: '1 1 380px', minWidth: 320 }}>
          <div style={S.lbl}>Turn times</div>
          <div style={S.hint}>How long a party holds its table. Changing a band resizes every diary block and every optimiser window immediately.</div>
          {BANDS.map(b => (
            <BoStepper key={b.key} label={b.label}
              value={rules.turnBands[b.key]}
              onChange={v => setBand(b.key, v)}
              step={15} min={45} max={240} fmt={v => `${v} min`} />
          ))}
          <BoToggle label="Protect large tables"
            sub="Score 6+ tops down for parties of 4 or fewer, so they stay free for the bookings that need them."
            on={rules.protectLargeTables}
            onToggle={() => patch({ protectLargeTables: !rules.protectLargeTables })} />
        </div>

        <div style={{ ...S.section, flex: '1 1 380px', minWidth: 320 }}>
          <div style={S.lbl}>Combination, pacing &amp; no-shows</div>
          <div style={S.hint}>The limits the optimiser and the widget obey.</div>
          <BoStepper label="Max tables in one combination"
            sub="A join is only legal inside an authored join group."
            value={rules.maxJoin} onChange={v => patch({ maxJoin: v })}
            step={1} min={1} max={4} />
          <BoStepper label="Wasted-seat tolerance"
            sub="Empty seats a candidate may carry before it stops being offered."
            value={rules.tolerance} onChange={v => patch({ tolerance: v })}
            step={1} min={0} max={6} fmt={v => `${v} seat${v === 1 ? '' : 's'}`} />
          <BoStepper label="Pacing cap per 15 min"
            sub="Covers the kitchen can absorb in one window — full slots go red at the host stand and stop selling on the widget."
            value={rules.pacingCap} onChange={v => patch({ pacingCap: v })}
            step={2} min={2} max={30} fmt={v => `${v} cvr`} />
          <BoStepper label="No-show hold per cover"
            sub="Held on card at booking, captured only on no-show."
            value={rules.holdPerCover} onChange={v => patch({ holdPerCover: v })}
            step={5} min={0} max={50} fmt={v => money(v)} />
          <BoStepper label="Cancellation window"
            sub="Cancel inside this window and the hold may be captured."
            value={rules.cancellationWindowHours} onChange={v => patch({ cancellationWindowHours: v })}
            step={2} min={0} max={72} fmt={v => `${v} h`} />
          <BoToggle label="Pacing override needs a manager"
            sub="Booking into a full slot at the host stand requires manager approval (PIN)."
            on={rules.pacingOverrideRequiresPin}
            onToggle={() => patch({ pacingOverrideRequiresPin: !rules.pacingOverrideRequiresPin })} />
          {!bookingRules && (
            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--t4)', fontFamily: MONO }}>
              Showing defaults — no rules saved for this venue yet. The first change writes them.
            </div>
          )}
        </div>
      </div>

      {/* ── 2 · Booking widget ── */}
      <div style={{ ...S.section, marginTop: 14 }}>
        <div style={S.lbl}>Booking widget</div>
        <div style={S.hint}>The customer-facing booking page — the same optimiser and pacing rules as the host stand, sold from the venue website.</div>
        <BoToggle label="Sell bookings online"
          sub="Off takes the public booking page down immediately; the host stand keeps working."
          on={rules.widgetEnabled}
          onToggle={() => patch({ widgetEnabled: !rules.widgetEnabled })} />
        <BoStepper label="Book up to"
          sub="How far ahead the widget offers dates."
          value={rules.widgetMaxDaysAhead} onChange={v => patch({ widgetMaxDaysAhead: v })}
          step={7} min={7} max={365} fmt={v => `${v} days`} />
        <BoToggle label="Card capture (Adyen)"
          sub="On: prepay packages and deposits are charged at booking, and plain bookings hold a card (nothing charged) for the no-show policy. Off: bookings complete with no card step."
          on={!!rules.cardCaptureEnabled}
          onToggle={() => patch({ cardCaptureEnabled: !rules.cardCaptureEnabled })} />

        {bookUrl ? (
          <>
            <div style={{ marginTop: 14 }}>
              <div style={S.lbl}>Public booking URL</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', marginTop: 8, flexWrap: 'wrap' }}>
                <button style={{ ...S.monoBox, flex: '1 1 320px' }} title="Tap to copy"
                  onClick={() => copy(bookUrl, setCopiedUrl)}>{bookUrl}</button>
                <button style={S.btn} onClick={() => copy(bookUrl, setCopiedUrl)}>
                  {copiedUrl ? 'Copied ✓' : 'Copy'}
                </button>
              </div>
            </div>
            <div style={{ marginTop: 14 }}>
              <div style={S.lbl}>Website embed</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', marginTop: 8, flexWrap: 'wrap' }}>
                <button style={{ ...S.monoBox, flex: '1 1 320px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', textAlign: 'left', lineHeight: 1.5 }}
                  title="Tap to copy" onClick={() => copy(embed, setCopiedEmbed)}>{embed}</button>
                <button style={S.btn} onClick={() => copy(embed, setCopiedEmbed)}>
                  {copiedEmbed ? 'Copied ✓' : 'Copy'}
                </button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 8, lineHeight: 1.5 }}>
                Paste this into the venue website; bookings land straight in the diary, and slots at the kitchen's pacing cap are never sold online.
              </div>
            </div>
          </>
        ) : (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--t3)' }}>
            {slugReady
              ? <>No venue slug yet — set one in <b>Settings → Location settings</b> to get the public booking link and website embed.</>
              : 'Looking up the venue slug…'}
          </div>
        )}
      </div>

      {/* ── 3 · Join groups pointer + per-location note ── */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
        <div style={{ ...S.note, background: 'var(--blu-d)', borderColor: 'var(--blu-b)' }}>
          <div style={{ ...S.noteTitle, color: 'var(--blu)' }}>Join groups</div>
          <div style={S.noteBody}>
            Table combinations are authored on the floor plan: <b>Back Office → Floor plan → select a table → Booking join group</b>.
            This venue has <b>{joinGroupCount}</b> join group{joinGroupCount === 1 ? '' : 's'} authored — a join is only ever offered inside one.
          </div>
        </div>
        <div style={{ ...S.note, background: 'var(--grn-d)', borderColor: 'var(--grn-b)' }}>
          <div style={{ ...S.noteTitle, color: 'var(--grn)' }}>Per-location</div>
          <div style={S.noteBody}>
            These rules belong to this venue and are shared with the host stand's Rules tab — edit in either place, both react live.
          </div>
        </div>
      </div>
    </div>
  );
}

// ── BO-idiom controls (PackageBuilder styling, RulesScreen semantics) ─────────
function Row({ label, sub, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--bdr)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2, lineHeight: 1.4 }}>{sub}</div>}
      </div>
      {children}
    </div>
  );
}

function BoStepper({ label, sub, value, onChange, step = 1, min = 0, max = 999, fmt = (v) => v }) {
  const clamp = (v) => Math.min(max, Math.max(min, v));
  return (
    <Row label={label} sub={sub}>
      <button style={S.step} onClick={() => onChange(clamp(Number(value) - step))} aria-label={`decrease ${label}`}>−</button>
      <div style={{ minWidth: 66, textAlign: 'center', fontSize: 14, fontWeight: 800, fontFamily: MONO, color: 'var(--t1)' }}>{fmt(value)}</div>
      <button style={S.step} onClick={() => onChange(clamp(Number(value) + step))} aria-label={`increase ${label}`}>+</button>
    </Row>
  );
}

function BoToggle({ label, sub, on, onToggle }) {
  return (
    <Row label={label} sub={sub}>
      <button style={on ? S.pillOn : S.pill} onClick={onToggle} aria-pressed={!!on}>
        {on ? '✓ On' : 'Off'}
      </button>
    </Row>
  );
}

const Head = ({ title, sub }) => (
  <div style={{ marginBottom: 4 }}>
    <div style={{ fontSize: 11, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 700 }}>Channels</div>
    <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--t1)', marginTop: 2 }}>{title}</div>
    <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4, maxWidth: 720, lineHeight: 1.5 }}>{sub}</div>
  </div>
);

const S = {
  section: { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 14 },
  lbl: { fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.04em' },
  hint: { fontSize: 11, color: 'var(--t4)', marginTop: 4, marginBottom: 4, lineHeight: 1.4 },
  step: { width: 30, height: 30, borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 16, cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1, padding: 0, flexShrink: 0 },
  pill: { fontSize: 12.5, padding: '6px 11px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t2)', cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 },
  pillOn: { fontSize: 12.5, padding: '6px 11px', borderRadius: 8, border: '1px solid var(--grn-b)', background: 'var(--grn-d)', color: 'var(--grn)', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700, flexShrink: 0 },
  btn: { padding: '8px 14px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', alignSelf: 'center' },
  monoBox: { fontFamily: MONO, fontSize: 12, color: 'var(--t1)', background: 'var(--bg2)', border: '1px solid var(--bdr2)', borderRadius: 8, padding: '9px 11px', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' },
  note: { flex: '1 1 260px', padding: '12px 14px', borderRadius: 12, border: '1px solid' },
  noteTitle: { fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em' },
  noteBody: { fontSize: 11.5, color: 'var(--t2)', lineHeight: 1.55, marginTop: 5 },
};
