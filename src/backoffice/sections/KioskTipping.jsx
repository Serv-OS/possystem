/**
 * KioskTipping: the kiosk tipping rule for the NEW kiosk design, one rule for every kiosk at
 * the venue (platform.locations.tipping_config.kiosk, lib/tipping.js).
 *
 * Shown inside Kiosk settings when the profile uses the new design. Kiosks on the current
 * design keep the tip presets on their own settings page.
 *
 * SAVE SAFETY (build spec F6). location-admin replaced the whole tipping_config until its
 * merge update is deployed, so a save of { kiosk } alone would wipe online and QR tipping.
 * buildKioskTipPatch therefore always sends the stored online and qr rules back unchanged,
 * and the save only counts as saved when the server echoes the kiosk rule back.
 */
import { useCallback, useEffect, useState } from 'react';
import { platformSupabase } from '../../lib/supabase';
import { saveLocation } from '../../lib/locationAdmin';
import { kioskTipRule, buildKioskTipPatch, sameKioskTipRule, normaliseKioskTipRule, KIOSK_TIP_MAX_PCT } from '../../lib/tipping';

export default function KioskTipping({ opsLocationId }) {
  const [row, setRow] = useState(null);          // { id, tipping_config }
  const [loadError, setLoadError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [on, setOn] = useState(true);
  const [pcts, setPcts] = useState(['10', '12.5', '15']);
  const [def, setDef] = useState('');            // '' = No tip
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);  // { tone, text }

  const seed = useCallback((rule) => {
    setOn(rule.on);
    setPcts(Array.from({ length: KIOSK_TIP_MAX_PCT }, (_, i) => (rule.pct[i] != null ? String(rule.pct[i]) : '')));
    setDef(rule.default != null ? String(rule.default) : '');
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      if (!platformSupabase || !opsLocationId) throw new Error('No venue is loaded.');
      let r = await platformSupabase.from('locations').select('id, tipping_config').eq('ops_location_id', opsLocationId).maybeSingle();
      if (!r.error && !r.data) r = await platformSupabase.from('locations').select('id, tipping_config').eq('id', opsLocationId).maybeSingle();
      if (r.error) throw r.error;
      if (!r.data) throw new Error('This venue has no location settings yet.');
      setRow(r.data);
      seed(kioskTipRule(r.data, null));
    } catch (e) {
      setLoadError(e?.message || 'Could not load kiosk tipping.');
    } finally {
      setLoading(false);
    }
  }, [opsLocationId, seed]);

  useEffect(() => { load(); }, [load]);

  const draftRule = normaliseKioskTipRule({
    on,
    pct: pcts.map(v => Number(v)).filter(n => Number.isFinite(n) && n > 0),
    default: def === '' ? null : Number(def),
    custom: false,
  });

  const save = async () => {
    if (!row) return;
    setSaving(true);
    setMessage(null);
    try {
      // Read the stored tipping again right before saving, so Online Ordering or QR tipping
      // saved in another tab since this page opened is carried as it is now, never put back to
      // the copy this page loaded.
      const fresh = await platformSupabase.from('locations').select('tipping_config').eq('id', row.id).maybeSingle();
      if (fresh.error || !fresh.data) throw new Error(fresh.error?.message || 'Could not read the current tipping settings.');
      const { data, error } = await saveLocation(opsLocationId, buildKioskTipPatch(fresh.data.tipping_config, draftRule));
      if (error) throw error;
      if (data && sameKioskTipRule(data.tipping_config?.kiosk, draftRule)) {
        setRow(r => ({ ...r, tipping_config: data.tipping_config }));
        seed(normaliseKioskTipRule(data.tipping_config.kiosk));
        setMessage({ tone: 'ok', text: 'Tipping saved. Refresh the kiosk to see it.' });
      } else {
        if (data?.tipping_config) setRow(r => ({ ...r, tipping_config: data.tipping_config }));
        setMessage({ tone: 'error', text: 'Kiosk tipping did not save. The location settings server needs its update first.' });
      }
    } catch (e) {
      setMessage({ tone: 'error', text: `Kiosk tipping did not save: ${e?.message || 'unknown error'}` });
    } finally {
      setSaving(false);
    }
  };

  const box = { background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 10, padding: 16, marginBottom: 14 };
  if (loading) return <div style={{ ...box, fontSize: 15, color: 'var(--t3)' }}>Loading kiosk tipping</div>;
  if (loadError) return <div style={{ ...box, fontSize: 15, color: '#fca5a5' }}>{loadError}</div>;

  return (
    <div style={box}>
      <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Kiosk tipping, for every kiosk at this venue</div>
      <div style={{ fontSize: 15, color: 'var(--t3)', lineHeight: 1.45, marginBottom: 12 }}>
        Tips are worked out on the order after offers and never include tax.
      </div>

      <button type="button" role="switch" aria-checked={on} onClick={() => setOn(v => !v)} style={{
        display: 'flex', alignItems: 'center', gap: 14, padding: '12px 14px', marginBottom: 12, width: '100%',
        background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 8, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', color: 'inherit',
      }}>
        <span style={{ position: 'relative', width: 44, height: 24, background: on ? 'var(--acc)' : 'var(--bg3)', borderRadius: 12, flexShrink: 0 }}>
          <span style={{ position: 'absolute', top: 2, left: on ? 22 : 2, width: 20, height: 20, background: '#fff', borderRadius: '50%' }} />
        </span>
        <span style={{ fontSize: 16, fontWeight: 600 }}>Ask for a tip</span>
      </button>

      {on ? (
        <>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Tip percentages</div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 6 }}>
            {Array.from({ length: KIOSK_TIP_MAX_PCT }, (_, i) => (
              <input
                key={i}
                type="number" step="0.5" min="0" max="100"
                aria-label={`Tip percentage ${i + 1}`}
                value={pcts[i] ?? ''}
                onChange={e => setPcts(p => p.map((v, j) => (j === i ? e.target.value : v)))}
                style={{ width: 90, textAlign: 'center', background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '8px 10px', color: 'var(--t1)', fontFamily: 'inherit', fontSize: 15 }}
              />
            ))}
          </div>
          <div style={{ fontSize: 15, color: 'var(--t3)', marginBottom: 12 }}>Customers see No tip plus up to three percentages.</div>

          <label style={{ display: 'block', fontSize: 15, fontWeight: 600, marginBottom: 6 }} htmlFor="kiosk-tip-default">Pre-selected</label>
          <select
            id="kiosk-tip-default"
            value={draftRule.default != null ? String(draftRule.default) : ''}
            onChange={e => setDef(e.target.value)}
            style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '8px 10px', color: 'var(--t1)', fontFamily: 'inherit', fontSize: 15, marginBottom: 12 }}
          >
            <option value="">No tip</option>
            {draftRule.pct.map(p => <option key={p} value={String(p)}>{p}%</option>)}
          </select>
        </>
      ) : null}

      {message ? (
        <div role="status" style={{ fontSize: 15, marginBottom: 10, color: message.tone === 'ok' ? '#86efac' : '#fca5a5' }}>{message.text}</div>
      ) : null}
      <button type="button" onClick={save} disabled={saving} style={{
        background: 'var(--acc)', color: '#fff', border: 0, padding: '10px 18px', borderRadius: 8, fontSize: 15, fontWeight: 600,
        cursor: saving ? 'wait' : 'pointer', fontFamily: 'inherit', opacity: saving ? 0.6 : 1,
      }}>{saving ? 'Saving tipping' : 'Save tipping'}</button>
      <div style={{ fontSize: 15, color: 'var(--t3)', lineHeight: 1.45, marginTop: 12 }}>
        Kiosks on the current design still use the tip presets on their own settings page.
      </div>
    </div>
  );
}
