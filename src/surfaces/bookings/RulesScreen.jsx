// src/surfaces/bookings/RulesScreen.jsx
//
// Rules — availability (README §5). The guard rails: turn-time bands, join /
// tolerance / pacing / no-show settings. Every stepper writes immediately via
// updateBookingRules (the store applies optimistically then persists), so the
// diary and the optimiser react live — there is no Save button by design.

import { useStore } from '../../store';
import { mono, tintBg, tintBd, rulesOf, money, Stepper, ToggleRow } from './bits.jsx';

const BANDS = [
  { key: '1-2', label: '1–2 covers' },
  { key: '3-4', label: '3–4 covers' },
  { key: '5-6', label: '5–6 covers' },
  { key: '7+', label: '7+ covers' },
];

export default function RulesScreen() {
  const bookingRules = useStore((s) => s.bookingRules);
  const updateBookingRules = useStore((s) => s.updateBookingRules);
  const rules = rulesOf(bookingRules);
  const patch = (p) => updateBookingRules?.(p);
  const setBand = (key, v) => patch({ turnBands: { ...rules.turnBands, [key]: v } });

  const colStyle = { flex: 1, minWidth: 300, maxWidth: 520 };
  const panel = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: '14px 18px' };

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* ── left: turn times ── */}
        <div style={colStyle}>
          <div style={panel}>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 4 }}>Turn times</div>
            <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 8, lineHeight: 1.4 }}>
              How long a party holds its table. Changing a band resizes every diary block and every optimiser window immediately.
            </div>
            {BANDS.map((b) => (
              <Stepper
                key={b.key}
                label={b.label}
                value={rules.turnBands[b.key]}
                onChange={(v) => setBand(b.key, v)}
                step={15} min={45} max={240}
                fmt={(v) => `${v} min`}
              />
            ))}
            <ToggleRow
              label="Protect large tables"
              sub="Score 6+ tops down for parties of 4 or fewer, so they stay free for the bookings that need them."
              on={rules.protectLargeTables}
              onToggle={() => patch({ protectLargeTables: !rules.protectLargeTables })}
            />
          </div>
        </div>

        {/* ── right: combination, pacing & no-shows ── */}
        <div style={colStyle}>
          <div style={panel}>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 4 }}>Combination, pacing &amp; no-shows</div>
            <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 8, lineHeight: 1.4 }}>
              The limits the optimiser and the widget obey. Live — no save step.
            </div>
            <Stepper
              label="Max tables in one combination"
              sub="A join is only legal inside an authored join group."
              value={rules.maxJoin}
              onChange={(v) => patch({ maxJoin: v })}
              step={1} min={1} max={4}
            />
            <Stepper
              label="Wasted-seat tolerance"
              sub="Empty seats a candidate may carry before it stops being offered."
              value={rules.tolerance}
              onChange={(v) => patch({ tolerance: v })}
              step={1} min={0} max={6}
              fmt={(v) => `${v} seat${v === 1 ? '' : 's'}`}
            />
            <Stepper
              label="Pacing cap per 15 min"
              sub="Covers the kitchen can absorb in one window — full slots go red at the host stand and stop selling on the widget."
              value={rules.pacingCap}
              onChange={(v) => patch({ pacingCap: v })}
              step={2} min={2} max={30}
              fmt={(v) => `${v} cvr`}
            />
            <Stepper
              label="No-show hold per cover"
              sub="Held on card at booking, captured only on no-show."
              value={rules.holdPerCover}
              onChange={(v) => patch({ holdPerCover: v })}
              step={5} min={0} max={50}
              fmt={(v) => money(v)}
            />
            <Stepper
              label="Cancellation window"
              sub="Cancel inside this window and the hold may be captured."
              value={rules.cancellationWindowHours}
              onChange={(v) => patch({ cancellationWindowHours: v })}
              step={2} min={0} max={72}
              fmt={(v) => `${v} h`}
            />
            <ToggleRow
              label="Pacing override needs a manager"
              sub="Booking into a full slot at the host stand requires manager approval."
              on={rules.pacingOverrideRequiresPin}
              onToggle={() => patch({ pacingOverrideRequiresPin: !rules.pacingOverrideRequiresPin })}
            />
          </div>

          <div style={{
            marginTop: 12, padding: '12px 14px', borderRadius: 12,
            background: tintBg('var(--orn)', 8), border: `1px solid ${tintBd('var(--orn)')}`,
            fontSize: 11, color: 'var(--orn)', lineHeight: 1.5,
          }}>
            <span style={{ fontWeight: 700 }}>Per-location.</span>{' '}
            <span style={{ color: 'var(--t2)' }}>
              These rules belong to this venue and travel with the floor plan pulled from the POS. A group can set them at company level and let a site override the pacing cap only.
            </span>
          </div>
          {!bookingRules && (
            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--t4)', ...mono }}>
              Showing defaults — no rules saved for this venue yet. The first change writes them.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
