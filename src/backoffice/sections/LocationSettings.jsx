import { useState, useEffect } from 'react';
import { platformSupabase, supabase, getLocationId } from '../../lib/supabase';
import { clearLocationConfigCache } from '../../lib/locationTime';

const TIMEZONES = [
  { value:'Europe/London',      label:'Europe/London (UK)' },
  { value:'Europe/Paris',       label:'Europe/Paris (CET)' },
  { value:'Europe/Berlin',      label:'Europe/Berlin (CET)' },
  { value:'Europe/Amsterdam',   label:'Europe/Amsterdam (CET)' },
  { value:'Europe/Dublin',      label:'Europe/Dublin' },
  { value:'America/New_York',   label:'America/New York (ET)' },
  { value:'America/Chicago',    label:'America/Chicago (CT)' },
  { value:'America/Denver',     label:'America/Denver (MT)' },
  { value:'America/Los_Angeles',label:'America/Los Angeles (PT)' },
  { value:'America/Toronto',    label:'America/Toronto (ET)' },
  { value:'Australia/Sydney',   label:'Australia/Sydney (AEDT)' },
  { value:'Australia/Melbourne',label:'Australia/Melbourne (AEDT)' },
  { value:'Asia/Dubai',         label:'Asia/Dubai (GST)' },
  { value:'Asia/Singapore',     label:'Asia/Singapore (SGT)' },
  { value:'Asia/Tokyo',         label:'Asia/Tokyo (JST)' },
];

const HOURS = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2);
  const m = (i % 2) * 30;
  const s = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  return { value: s, label: s };
});

// v4.6.25: Duration in minutes between a start and end HH:MM. Handles
// overnight wrap where end <= start (e.g. late bar 22:00 -> 02:00).
function shiftDurationMinutes(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const startMin = sh * 60 + sm;
  const endMin   = eh * 60 + em;
  return endMin > startMin ? endMin - startMin : (24 * 60) - startMin + endMin;
}

const S = {
  page: { padding:'32px 40px', maxWidth:760, overflowY:'auto' },
  h1:   { fontSize:22, fontWeight:800, marginBottom:4, color:'var(--t1)' },
  sub:  { fontSize:13, color:'var(--t3)', marginBottom:32 },
  card: { background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:14, padding:24, marginBottom:20 },
  h2:   { fontSize:14, fontWeight:700, color:'var(--t1)', marginBottom:4 },
  desc: { fontSize:12, color:'var(--t4)', marginBottom:16, lineHeight:1.6 },
  label:{ fontSize:12, fontWeight:600, color:'var(--t3)', marginBottom:5, display:'block', textTransform:'uppercase', letterSpacing:'.04em' },
  select:{ width:'100%', padding:'9px 12px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none' },
  input: { padding:'9px 12px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none' },
  row:  { display:'grid', gridTemplateColumns:'1fr 1fr 1fr auto', gap:8, alignItems:'end', marginBottom:8 },
  btn:  { padding:'9px 18px', borderRadius:8, border:'none', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:'inherit' },
};

export default function LocationSettings() {
  const [location, setLocation] = useState(null);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [error, setError]       = useState('');

  const [timezone, setTimezone]     = useState('Europe/London');
  const [bizDayStart, setBizDayStart] = useState('06:00');
  const [collectionLeadMin, setCollectionLeadMin] = useState(30);
  const [shifts, setShifts]         = useState([]);
  const [showItemImages, setShowItemImages] = useState(false);
  const [loadingImageSetting, setLoadingImageSetting] = useState(true);

  useEffect(() => {
    if (!platformSupabase) { setLoading(false); return; }
    // Try the resolved location first, fall back to limit(1) if that returns
    // no row (e.g. ops DB locations.id and platform DB locations.id don't
    // match — they sometimes don't because Platform was bootstrapped from
    // a different seed). Surface load errors to the UI rather than swallowing.
    (async () => {
      try {
        const locId = await getLocationId().catch(() => null);
        const select = 'id, name, timezone, business_day_start, shifts, collection_lead_minutes';
        let row = null;
        let lastErr = null;
        if (locId) {
          const r = await platformSupabase.from('locations').select(select).eq('id', locId).maybeSingle();
          row = r.data;
          lastErr = r.error;
          if (lastErr) console.warn('[LocationSettings] load by id failed:', lastErr);
        }
        if (!row) {
          const r = await platformSupabase.from('locations').select(select).limit(1).maybeSingle();
          row = r.data;
          lastErr = r.error || lastErr;
          if (lastErr && !row) console.warn('[LocationSettings] fallback load failed:', lastErr);
        }
        if (row) {
          setLocation(row);
          setTimezone(row.timezone || 'Europe/London');
          setBizDayStart(row.business_day_start || '06:00');
          setShifts(Array.isArray(row.shifts) ? row.shifts : []);
          setCollectionLeadMin(typeof row.collection_lead_minutes === 'number' ? row.collection_lead_minutes : 30);
        } else {
          setError('Could not load any location row from the platform DB. Check VITE_PLATFORM_SUPABASE_URL/KEY and the locations table SELECT policy.');
        }
      } catch (e) {
        console.error('[LocationSettings] load threw:', e);
        setError(`Load failed: ${e.message}`);
      } finally {
        setLoading(false);
      }
    })();

    // Load show_item_images from ops DB
    (async () => {
      const locId = await getLocationId().catch(() => null);
      if (!locId || !supabase) { setLoadingImageSetting(false); return; }
      const { data } = await supabase.from('locations').select('show_item_images').eq('id', locId).single();
      if (data) setShowItemImages(data.show_item_images ?? false);
      setLoadingImageSetting(false);
    })();
  }, []);

  const addShift = () => {
    setShifts(s => [...s, { id:`shift-${Date.now()}`, name:'New shift', start:'09:00', end:'17:00' }]);
  };
  const updateShift = (id, key, val) => {
    setShifts(s => s.map(sh => sh.id === id ? { ...sh, [key]: val } : sh));
  };
  const removeShift = (id) => setShifts(s => s.filter(sh => sh.id !== id));

  const save = async () => {
    if (!platformSupabase) {
      setError('Platform DB not configured. Set VITE_PLATFORM_SUPABASE_URL/KEY.');
      return;
    }
    if (!location) {
      setError('No location loaded — nothing to save against. Check the platform DB locations table or run the load again.');
      return;
    }
    setSaving(true); setError(''); setSaved(false);

    // Sanitise shifts payload — strip any fields the JSONB column doesn't
    // expect, coerce times to HH:MM strings. The Service Periods bug was
    // caused by the update silently no-op'ing: .update().eq() returns success
    // (no error) even when RLS denies the write OR when the row id mismatches.
    // Adding .select().single() forces a round-trip on the actual mutated
    // row, so we can confirm shifts came back persisted.
    const cleanShifts = (shifts || []).map(sh => ({
      id:    sh.id || `shift-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name:  String(sh.name || 'Shift').slice(0, 60),
      start: String(sh.start || '00:00').slice(0, 5),
      end:   String(sh.end   || '00:00').slice(0, 5),
    }));

    const { data, error: err } = await platformSupabase
      .from('locations')
      .update({
        timezone,
        business_day_start:      bizDayStart,
        shifts:                  cleanShifts,
        collection_lead_minutes: collectionLeadMin,
      })
      .eq('id', location.id)
      .select('id, shifts, timezone, business_day_start, collection_lead_minutes')
      .single();

    // Save show_item_images to ops DB (separate concern)
    const locId = await getLocationId().catch(() => null);
    if (locId && supabase) {
      try { await supabase.from('locations').update({ show_item_images: showItemImages }).eq('id', locId); } catch {}
    }
    setSaving(false);

    if (err) {
      console.warn('[LocationSettings] save failed:', err);
      setError(err.message || 'Save failed (check console)');
      return;
    }
    if (!data) {
      setError('Save did not return a row — likely an RLS / permission issue. Sign in to the platform DB or check the locations table policies for UPDATE.');
      return;
    }
    // Verify shifts round-tripped — surfaces the bug instead of hiding it
    const persistedShifts = Array.isArray(data.shifts) ? data.shifts : [];
    if (cleanShifts.length !== persistedShifts.length) {
      setError(`Save reported success but shifts didn't persist: sent ${cleanShifts.length}, got ${persistedShifts.length} back. Check the locations.shifts column type (must be jsonb) and RLS UPDATE policy.`);
      return;
    }
    // Keep local state in sync with what's actually persisted
    setShifts(persistedShifts);
    clearLocationConfigCache(); // force refresh on next read
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  if (loading) return <div style={{ padding:40, color:'var(--t4)', fontSize:13 }}>Loading…</div>;
  if (!platformSupabase) return (
    <div style={S.page}>
      <div style={S.h1}>Location Settings</div>
      <div style={{ padding:'20px 0', color:'var(--red)', fontSize:13 }}>
        Platform DB not configured. Add <code>VITE_PLATFORM_SUPABASE_URL</code> and <code>VITE_PLATFORM_SUPABASE_ANON_KEY</code> to Vercel environment variables.
      </div>
    </div>
  );

  return (
    <div style={S.page}>
      <div style={S.h1}>Location Settings</div>
      <div style={S.sub}>Configure timezone and service periods for {location?.name || 'your location'}</div>

      {/* Timezone */}
      <div style={S.card}>
        <div style={S.h2}>🌍 Timezone</div>
        <div style={S.desc}>
          All timestamps, reporting, and shift calculations use this timezone.
          Reports will show "today's" data from the correct local midnight — not the server or device time.
        </div>
        <label style={S.label}>Location timezone</label>
        <select style={S.select} value={timezone} onChange={e => setTimezone(e.target.value)}>
          {TIMEZONES.map(tz => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
        </select>
        <div style={{ fontSize:11, color:'var(--t4)', marginTop:6 }}>
          Current time in {timezone}: <strong style={{ color:'var(--t2)' }}>
            {new Date().toLocaleTimeString('en-GB', { timeZone: timezone, hour:'2-digit', minute:'2-digit' })}
          </strong>
        </div>
      </div>

      {/* Business day start */}
      <div style={S.card}>
        <div style={S.h2}>⏰ Business day start</div>
        <div style={S.desc}>
          The time a new reporting day begins. Checks closed before this time are attributed to the previous day.
          Set to <strong>06:00</strong> for a standard restaurant. Nightclubs or late bars might use <strong>04:00</strong>.
        </div>
        <label style={S.label}>New day starts at</label>
        <select style={{ ...S.select, maxWidth:160 }} value={bizDayStart} onChange={e => setBizDayStart(e.target.value)}>
          {HOURS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}
        </select>
        <div style={{ fontSize:11, color:'var(--t4)', marginTop:6 }}>
          Today's reporting period: <strong style={{ color:'var(--t2)' }}>{bizDayStart} — {bizDayStart} tomorrow</strong>
        </div>

      {/* v4.6.60: Collection lead time */}
      <div style={S.card}>
        <div style={S.h2}>🕐 Collection lead time</div>
        <div style={S.desc}>
          When a customer schedules a collection time, the kitchen ticket fires this many minutes before the collection time.
          Set to <strong>30</strong> for a normal kitchen. Set to <strong>0</strong> to fire immediately on send.
        </div>
        <label style={S.label}>Fire to kitchen N minutes before collection</label>
        <select style={{ ...S.select, maxWidth:160 }} value={collectionLeadMin} onChange={e => setCollectionLeadMin(parseInt(e.target.value, 10) || 0)}>
          {Array.from({ length: 25 }, (_, i) => i * 5).map(m => (
            <option key={m} value={m}>{m === 0 ? 'Fire immediately' : `${m} minutes`}</option>
          ))}
        </select>
        <div style={{ fontSize:11, color:'var(--t4)', marginTop:6 }}>
          Example: customer collects at <strong style={{ color:'var(--t2)' }}>19:00</strong>, lead time <strong style={{ color:'var(--t2)' }}>{collectionLeadMin} min</strong> → kitchen fires at <strong style={{ color:'var(--t2)' }}>{collectionLeadMin === 0 ? '19:00 (immediately)' : (() => { const d = new Date(); d.setHours(19, 0, 0, 0); d.setMinutes(d.getMinutes() - collectionLeadMin); return d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }); })()}</strong>.
        </div>
      </div>
      </div>

      {/* Shifts */}
      <div style={S.card}>
        <div style={S.h2}>🕐 Service periods</div>
        <div style={S.desc}>
          Named shifts let you filter reports by period (Breakfast / Lunch / Dinner) and give the AI assistant
          shift context. Leave empty to use whole-day reporting only.
        </div>

        {shifts.map((sh, i) => {
          const dur = shiftDurationMinutes(sh.start, sh.end);
          const tooLong = dur > 12 * 60;  // More than 12h likely indicates misconfiguration
          return (
          <div key={sh.id} style={S.row}>
            <div>
              {i === 0 && <label style={S.label}>Name</label>}
              <input style={{ ...S.input, width:'100%', boxSizing:'border-box' }}
                value={sh.name} onChange={e => updateShift(sh.id, 'name', e.target.value)}
                placeholder="e.g. Dinner"/>
            </div>
            <div>
              {i === 0 && <label style={S.label}>Start</label>}
              <select style={{ ...S.select, ...(tooLong ? { borderColor:'var(--red-b)' } : {}) }} value={sh.start} onChange={e => updateShift(sh.id, 'start', e.target.value)}>
                {HOURS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}
              </select>
            </div>
            <div>
              {i === 0 && <label style={S.label}>End</label>}
              <select style={{ ...S.select, ...(tooLong ? { borderColor:'var(--red-b)' } : {}) }} value={sh.end} onChange={e => updateShift(sh.id, 'end', e.target.value)}>
                {HOURS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}
              </select>
              {tooLong && (
                <div style={{ fontSize:10, color:'var(--red)', marginTop:4 }}>
                  {Math.floor(dur/60)}h long — check start/end are correct
                </div>
              )}
            </div>
            <div>
              {i === 0 && <label style={S.label}>&nbsp;</label>}
              <button onClick={() => removeShift(sh.id)}
                style={{ ...S.btn, background:'var(--red-d)', color:'var(--red)', border:'1px solid var(--red-b)', padding:'9px 12px' }}>✕</button>
            </div>
          </div>
          );
        })}

        <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginTop:4 }}>
          <button onClick={addShift}
            style={{ ...S.btn, background:'var(--bg3)', color:'var(--t2)', border:'1px solid var(--bdr)' }}>
            + Add shift
          </button>
          <button onClick={() => setShifts([
            { id:`shift-${Date.now()}-b`, name:'Breakfast', start:'07:00', end:'11:00' },
            { id:`shift-${Date.now()}-l`, name:'Lunch',     start:'11:00', end:'17:00' },
            { id:`shift-${Date.now()}-d`, name:'Dinner',    start:'17:00', end:'23:00' },
          ])}
            style={{ ...S.btn, background:'transparent', color:'var(--t3)', border:'1px solid var(--bdr)' }}>
            Use defaults (Breakfast / Lunch / Dinner)
          </button>
        </div>

        {shifts.length > 0 && (
          <div style={{ marginTop:12, fontSize:11, color:'var(--t4)', lineHeight:1.8 }}>
            ⓘ Service periods drive Shifts, Daypart, and Business summary reports (v4.6.25+). They also appear in the AI assistant context.
            Gaps between shifts are valid — not all time needs to be covered.
          </div>
        )}
      </div>

      {/* POS Display */}
      <div style={S.card}>
        <div style={S.h2}>🖼 POS Display</div>
        <div style={S.desc}>
          When enabled, product images appear as background photos on the POS item buttons.
          Images can be added per-item in the menu manager. Images always show on long-press regardless of this setting.
        </div>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 0' }}>
          <div>
            <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>Show images on POS buttons</div>
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>Applies to all terminals at this location</div>
          </div>
          <button
            onClick={() => setShowItemImages(v => !v)}
            style={{
              width:44, height:24, borderRadius:12, border:'none', cursor:'pointer',
              background: showItemImages ? 'var(--acc)' : 'var(--bdr2)',
              position:'relative', transition:'background .2s', flexShrink:0,
            }}>
            <div style={{
              position:'absolute', top:3, left: showItemImages ? 23 : 3,
              width:18, height:18, borderRadius:'50%', background:'#fff',
              transition:'left .2s', boxShadow:'0 1px 3px rgba(0,0,0,.2)',
            }}/>
          </button>
        </div>
        {loadingImageSetting && <div style={{ fontSize:11, color:'var(--t4)' }}>Loading…</div>}
      </div>

      {/* Save */}
      <div style={{ display:'flex', alignItems:'center', gap:12 }}>
        <button onClick={save} disabled={saving}
          style={{ ...S.btn, background:'var(--acc)', color:'#fff', opacity:saving?.6:1 }}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        {saved && <span style={{ fontSize:13, color:'var(--grn)', fontWeight:600 }}>✓ Saved</span>}
        {error && <span style={{ fontSize:13, color:'var(--red)' }}>{error}</span>}
      </div>
    </div>
  );
}
