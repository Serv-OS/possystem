// src/surfaces/kds/KdsSettingsSheet.jsx
//
// Station settings (v5.8.66): the right hand sheet from the design handoff, behind a
// manager PIN (Peter, 14 Sep 2026). Saved per screen in devices.kds_settings.

import { useState, useEffect } from 'react';
import { KDS_TYPES, KDS_TYPE_KEYS, KDS_STATUS } from '../../lib/kds/kdsTicket';
import { KDS_TOGGLES, clampThresholds, matchManagerPin, isManagerStaff, THRESHOLD_MAX } from '../../lib/kds/kdsSettings';
import { C, SANS, MONO, chip, monoLabel } from './kdsStyles';

function Toggle({ label, sub, on, onToggle }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={onToggle} style={{
      width: '100%', appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer', display: 'flex',
      alignItems: 'center', gap: 16, padding: '14px 0', borderTop: `1px solid ${C.row}`, textAlign: 'left',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ font: `700 17px ${SANS}`, color: C.setting }}>{label}</div>
        <div style={{ font: `400 14px/1.35 ${SANS}`, color: C.meta2, marginTop: 2 }}>{sub}</div>
      </div>
      <span style={{
        flex: 'none', width: 52, height: 30, borderRadius: 99, padding: 3, display: 'flex', alignItems: 'center',
        background: on ? C.bump : 'rgba(255,255,255,.14)', justifyContent: on ? 'flex-end' : 'flex-start',
      }}>
        <span style={{ width: 24, height: 24, borderRadius: 99, background: '#fff', display: 'block' }} />
      </span>
    </button>
  );
}

const stepBtn = {
  width: 44, height: 44, flex: 'none', border: '1px solid rgba(255,255,255,.16)', background: 'rgba(255,255,255,.05)',
  color: '#E6ECE9', borderRadius: 10, font: `700 19px ${SANS}`, cursor: 'pointer',
};

/** One threshold row. Tap the value to type minutes (the design asks for typed entry). */
function ThresholdRow({ from, to, label, sub, value, onChange }) {
  const [typing, setTyping] = useState(null);
  const commit = () => {
    if (typing != null && typing.trim() !== '') onChange(Number(typing));
    setTyping(null);
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderTop: `1px solid ${C.row}`, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <span style={{ width: 14, height: 14, borderRadius: 5, background: from.c }} />
        <span style={{ color: C.empty, fontSize: 13 }}>→</span>
        <span style={{ width: 14, height: 14, borderRadius: 5, background: to.c }} />
      </div>
      <div style={{ flex: 1, minWidth: 140 }}>
        <div style={{ font: `700 17px ${SANS}`, color: C.setting }}>{label}</div>
        <div style={{ font: `400 14px ${SANS}`, color: C.meta2, marginTop: 2 }}>{sub}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button type="button" aria-label={`${label} minus one minute`} onClick={() => onChange(value - 1)} style={stepBtn}>−</button>
        {typing != null ? (
          <input autoFocus inputMode="numeric" type="number" min={1} max={THRESHOLD_MAX} value={typing}
            onChange={(e) => setTyping(e.target.value)} onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setTyping(null); }}
            style={{ width: 78, height: 44, textAlign: 'center', font: `700 17px ${MONO}`, color: to.c, background: 'rgba(255,255,255,.06)', border: `1px solid ${to.c}`, borderRadius: 10, outline: 'none' }} />
        ) : (
          <button type="button" aria-label={`${label}, ${value} minutes, tap to type`} onClick={() => setTyping(String(value))}
            style={{ minWidth: 78, height: 44, textAlign: 'center', font: `700 17px ${MONO}`, color: to.c, background: 'transparent', border: 0, cursor: 'text' }}>
            {value} min
          </button>
        )}
        <button type="button" aria-label={`${label} plus one minute`} onClick={() => onChange(value + 1)} style={stepBtn}>+</button>
      </div>
    </div>
  );
}

export function KdsSettingsSheet({ settings, onChange, onClose, saveNote }) {
  const set = (patch) => onChange({ ...settings, ...patch });
  const toggle = (k) => onChange({ ...settings, show: { ...settings.show, [k]: !settings.show[k] } });
  const setThreshold = (key, v) => {
    const next = key === 'caution' ? clampThresholds(v, settings.late, 'caution') : clampThresholds(settings.caution, v, 'late');
    onChange({ ...settings, ...next });
  };

  return (
    <div onClick={onClose} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, background: 'rgba(6,8,7,.6)', display: 'flex', justifyContent: 'flex-end', zIndex: 30 }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Station settings" style={{
        width: 460, maxWidth: '100%', height: '100%', background: C.sheet, borderLeft: '1px solid rgba(255,255,255,.1)',
        display: 'flex', flexDirection: 'column', animation: 'kdsKfade .18s ease',
      }}>
        <div style={{ padding: '24px 26px 18px', borderBottom: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ font: `800 24px ${SANS}`, color: '#fff' }}>Station settings</div>
            <div style={{ font: `400 13px ${MONO}`, color: C.meta3, marginTop: 3 }}>Saved per screen, not per venue</div>
          </div>
          <button type="button" aria-label="Close settings" onClick={onClose} style={{ border: 0, background: 'rgba(255,255,255,.08)', color: '#fff', width: 44, height: 44, borderRadius: 12, fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '8px 26px 26px' }}>
          {saveNote && (
            <div style={{ marginTop: 14, borderLeft: `3px solid ${C.allergen}`, background: 'rgba(255,196,107,.09)', padding: '8px 11px', borderRadius: '0 8px 8px 0', font: `600 14px ${SANS}`, color: C.note }}>{saveNote}</div>
          )}

          <div style={{ ...monoLabel, padding: '18px 0 6px' }}>ON THE TICKET</div>
          {KDS_TOGGLES.map(([k, label, sub]) => (
            <Toggle key={k} label={label} sub={sub} on={settings.show[k]} onToggle={() => toggle(k)} />
          ))}

          <div style={{ ...monoLabel, padding: '26px 0 6px' }}>TIME THRESHOLDS</div>
          <div style={{ font: `400 14px/1.4 ${SANS}`, color: C.meta2, paddingBottom: 4 }}>Minutes since the order fired before the timer changes colour.</div>
          <ThresholdRow from={KDS_STATUS.ok} to={KDS_STATUS.caution} label="Green → Orange" sub="Order is running behind"
            value={settings.caution} onChange={(v) => setThreshold('caution', v)} />
          <ThresholdRow from={KDS_STATUS.caution} to={KDS_STATUS.late} label="Orange → Red" sub="Order is late, escalate"
            value={settings.late} onChange={(v) => setThreshold('late', v)} />

          <div style={{ ...monoLabel, padding: '26px 0 10px' }}>COLOUR CARDS BY</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" style={chip(settings.colour === 'type')} onClick={() => set({ colour: 'type' })}>Order type</button>
            <button type="button" style={chip(settings.colour === 'status')} onClick={() => set({ colour: 'status' })}>Time status</button>
          </div>

          <div style={{ ...monoLabel, padding: '26px 0 10px' }}>DENSITY</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" style={chip(settings.density === 'comfortable')} onClick={() => set({ density: 'comfortable' })}>Comfortable</button>
            <button type="button" style={chip(settings.density === 'compact')} onClick={() => set({ density: 'compact' })}>Compact</button>
          </div>

          <div style={{ ...monoLabel, padding: '26px 0 10px' }}>ORDER TYPE COLOURS</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {KDS_TYPE_KEYS.map(k => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0' }}>
                <span style={{ width: 18, height: 18, borderRadius: 6, background: KDS_TYPES[k].c }} />
                <span style={{ font: `600 16px ${SANS}`, color: C.railItem }}>{KDS_TYPES[k].legend}</span>
                <span style={{ flex: 1 }} />
                <span style={{ font: `400 13px ${MONO}`, color: C.meta3 }}>{KDS_TYPES[k].c}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Manager PIN before the settings open. `loadStaff` returns the venue's active staff
 * (fresh each time, so a PIN changed in Back Office works without a reload).
 */
export function KdsManagerPin({ loadStaff, onApprove, onClose }) {
  const [staff, setStaff] = useState(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    loadStaff().then(list => { if (alive) setStaff(Array.isArray(list) ? list : []); }).catch(() => { if (alive) setStaff([]); });
    return () => { alive = false; };
  }, [loadStaff]);

  const managers = (staff || []).filter(s => isManagerStaff(s) && s.pin);
  const maxLen = managers.reduce((n, s) => Math.max(n, String(s.pin).length), 4);

  const tryPin = (p) => {
    const m = matchManagerPin(staff, p);
    if (m) { onApprove(m); return true; }
    return false;
  };
  const press = (k) => {
    setError('');
    if (k === '⌫') { setPin(p => p.slice(0, -1)); return; }
    if (k === 'OK') {
      if (!tryPin(pin)) { setError('Incorrect manager PIN'); setPin(''); }
      return;
    }
    if (pin.length >= 8) return;
    const next = pin + k;
    setPin(next);
    if (tryPin(next)) return;
    if (next.length >= maxLen) { setError('Incorrect manager PIN'); setPin(''); }
  };

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK'];
  return (
    <div onClick={onClose} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, background: 'rgba(6,8,7,.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, zIndex: 40 }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Manager PIN" style={{
        width: 380, maxWidth: '100%', maxHeight: '100%', overflow: 'auto', background: C.sheet, border: `1px solid ${C.modalEdge}`,
        borderRadius: 22, padding: 26, animation: 'kdsKfade .16s ease', boxShadow: '0 40px 90px rgba(0,0,0,.6)',
      }}>
        <div style={{ ...monoLabel, textAlign: 'center' }}>MANAGER REQUIRED</div>
        <div style={{ font: `800 22px ${SANS}`, color: '#fff', textAlign: 'center', marginTop: 6 }}>Enter a manager PIN</div>
        <div style={{ font: `400 14px ${SANS}`, color: C.meta2, textAlign: 'center', marginTop: 4 }}>to change this screen's settings</div>

        {staff === null ? (
          <div style={{ font: `600 16px ${SANS}`, color: C.meta2, textAlign: 'center', padding: '40px 0' }}>Loading…</div>
        ) : managers.length === 0 ? (
          <div style={{ font: `600 16px/1.45 ${SANS}`, color: C.note, textAlign: 'center', padding: '28px 6px' }}>
            {/* Every venue has staff, so an empty list means the list did not load. */}
            {staff.length === 0
              ? 'Could not load the staff list for this venue. Check the connection, then try again.'
              : 'No manager PIN is set up for this venue. Add one in Back Office, Staff, then try again.'}
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 12, margin: '22px 0 8px' }}>
              {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
                <span key={i} style={{ width: 16, height: 16, borderRadius: 99, background: i < pin.length ? C.bump : 'rgba(255,255,255,.14)' }} />
              ))}
            </div>
            <div style={{ minHeight: 22, textAlign: 'center', font: `700 15px ${SANS}`, color: '#FF6B6B' }}>{error}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginTop: 8 }}>
              {keys.map(k => (
                <button key={k} type="button" onClick={() => press(k)} style={{
                  height: 64, borderRadius: 14, cursor: 'pointer', font: `700 24px ${k === 'OK' ? SANS : MONO}`,
                  border: `1px solid ${k === 'OK' ? C.bump : 'rgba(255,255,255,.16)'}`,
                  background: k === 'OK' ? C.bump : 'rgba(255,255,255,.05)', color: k === 'OK' ? C.bumpInk : '#fff',
                }}>{k}</button>
              ))}
            </div>
          </>
        )}
        <button type="button" onClick={onClose} style={{ width: '100%', marginTop: 14, height: 52, borderRadius: 14, border: '1px solid rgba(255,255,255,.18)', background: 'transparent', color: C.ghost, font: `700 18px ${SANS}`, cursor: 'pointer' }}>Cancel</button>
      </div>
    </div>
  );
}
