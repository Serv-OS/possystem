// v5.5.163 — Challenge 21 (UK alcohol ID check) configuration.
//
// UK regulation: licensed venues must randomly check ID for purchases of
// alcohol when a customer LOOKS under 21 (or under 25 — most venues run
// Challenge 25). To support an evidence trail for licensing audits, this
// page lets the operator:
//   1. Enable / disable the prompt
//   2. Pick which menu categories count as "alcohol"
//   3. Set how often the prompt fires (every Nth alcohol-containing sale)
//
// When ON, the POS counter on platform.locations increments on every closed
// check that contains at least one item from a flagged category. When the
// counter hits the threshold a modal pops up asking staff to collect the
// next customer's details. Submitted entries land in ops.challenge_21_checks
// and surface in the Challenge 21 report (filterable by date range).

import { useEffect, useState } from 'react';
import { platformSupabase, supabase, isMock, getLocationId } from '../../lib/supabase';
import { saveLocation, resetChallenge21Counter } from '../../lib/locationAdmin';
import { reportSave } from '../../lib/saveHealth';
import { useStore } from '../../store';
import Challenge21Report from './Challenge21Report';

export default function Challenge21() {
  // v5.5.166: store key is `menuCategories` not `categories` — wrong key
  // meant the store fallback was always empty, leaving us with the
  // DB-direct path which returns 0 if the BO's ops_location_id doesn't
  // match the menu_categories rows.
  const { menuCategories: storeCats, showToast } = useStore();
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);
  const [savedAt, setSavedAt]       = useState(null);
  const [error, setError]           = useState('');
  const [locationId, setLocationId] = useState(null);
  // Writes go through the location-admin edge fn, which keys off the OPS id and
  // resolves the platform row itself — so we keep both ids.
  const [opsLocId, setOpsLocId]     = useState(null);
  const [tab, setTab]               = useState('config'); // config | report

  // Form state
  const [enabled, setEnabled]       = useState(false);
  const [categoryIds, setCategoryIds] = useState([]);
  const [triggerEvery, setTriggerEvery] = useState(10);
  const [counter, setCounter]       = useState(0);

  // Categories list — fall back to store cats if BO categories are loaded there
  const [categories, setCategories] = useState([]);

  // v5.5.164: BO auth uses the OPS supabase client (not platform). Resolve
  // the working location id via getLocationId() — the same path every other
  // BO section uses — then look up the matching platform.locations row by
  // ops_location_id for the Challenge 21 config.
  useEffect(() => {
    if (isMock) { setLoading(false); return; }
    (async () => {
      try {
        const opsId = await getLocationId();
        if (!opsId || opsId === 'loc-demo') {
          setError('Not signed in — open the back office (?mode=office) and sign in first');
          setLoading(false); return;
        }
        setOpsLocId(opsId);

        // v5.5.165: categories — prefer the store (already hydrated by
        // SyncBridge from the BO's resolved location, matches what Menu
        // Manager renders). Fall back to a direct DB query if the store is
        // empty, and finally fall back to an UNFILTERED query that surfaces
        // any rows we can find so the user can see what's there. Diagnostic
        // surfaces the queried location_id so a mismatch is obvious.
        let cats = [];
        if (Array.isArray(storeCats) && storeCats.length) {
          // v5.5.167: store cats use `label` (Menu Manager terminology); DB cats use `name`.
          cats = storeCats.map(c => ({ id: c.id, name: c.label || c.name || '', parent_id: c.parentId, sort_order: c.sortOrder }));
        }
        if (!cats.length && supabase) {
          try {
            const { data } = await supabase
              .from('menu_categories').select('id, name, parent_id, sort_order')
              .eq('location_id', opsId).order('sort_order');
            cats = Array.isArray(data) ? data : [];
          } catch (e) { console.warn('[Challenge21] cats fetch threw:', e?.message); }
        }
        if (!cats.length && supabase) {
          // Last-ditch: any categories at all on the ops DB? Surfaces what
          // location_ids exist so the user can see if there's a mismatch.
          try {
            const { data: anyCats } = await supabase
              .from('menu_categories').select('id, name, location_id, sort_order')
              .order('sort_order').limit(50);
            if (anyCats?.length) {
              const otherLocs = [...new Set(anyCats.map(c => c.location_id).filter(Boolean))];
              setError(`No categories found for your location (${opsId}). The ops DB has ${anyCats.length} categor${anyCats.length === 1 ? 'y' : 'ies'} under other location_id${otherLocs.length === 1 ? '' : 's'}: ${otherLocs.join(', ')}. If one of those is yours, set rpos-bo-location in localStorage or fix user_profiles.location_id.`);
              cats = anyCats.map(c => ({ id: c.id, name: c.name + ` (${c.location_id})`, sort_order: c.sort_order }));
            }
          } catch {}
        }
        if (!cats.length) {
          setError(prev => prev || `No categories anywhere. Resolved BO location: ${opsId}. Open Menu Manager first.`);
        }
        setCategories(cats);

        // Challenge 21 config + counter from platform DB, joined by ops_location_id
        const { data: loc, error: lErr } = await platformSupabase
          .from('locations')
          .select('id, challenge_21_enabled, challenge_21_alcohol_category_ids, challenge_21_trigger_every, challenge_21_counter')
          .eq('ops_location_id', opsId).maybeSingle();
        if (lErr) {
          if (/column .* does not exist/i.test(lErr.message)) {
            setError('DB migration missing — run the Challenge 21 SQL from the v5.5.163 changelog on the PLATFORM project.');
          } else {
            setError(lErr.message);
          }
          setLoading(false); return;
        }
        if (!loc) {
          setError(`No platform row found for ops location ${opsId}. Check platform.locations.ops_location_id is populated.`);
          setLoading(false); return;
        }
        setLocationId(loc.id);
        setEnabled(!!loc.challenge_21_enabled);
        setCategoryIds(Array.isArray(loc.challenge_21_alcohol_category_ids) ? loc.challenge_21_alcohol_category_ids : []);
        setTriggerEvery(Number(loc.challenge_21_trigger_every) || 10);
        setCounter(Number(loc.challenge_21_counter) || 0);
      } catch (e) {
        setError(e?.message || 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleCat = (id) => {
    setCategoryIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const save = async () => {
    if (!locationId || !opsLocId) return;
    setSaving(true); setError(''); setSavedAt(null);
    try {
      const { error: uErr } = await saveLocation(opsLocId, {
        challenge_21_enabled: enabled,
        challenge_21_alcohol_category_ids: categoryIds,
        challenge_21_trigger_every: Math.max(1, Math.min(1000, Math.round(Number(triggerEvery) || 10))),
      });
      reportSave('Challenge 21 settings', uErr);
      if (uErr) {
        if (/column .* does not exist/i.test(uErr.message)) {
          setError('DB migration missing — run the Challenge 21 SQL on the platform DB.');
        } else {
          setError(uErr.message);
        }
        return;
      }
      setSavedAt(Date.now());
    } catch (e) {
      setError(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const resetCounter = async () => {
    if (!locationId || !opsLocId) return;
    if (!confirm('Reset the Challenge ID counter to 0? The next alcohol sale will start fresh.')) return;
    const { data, error } = await resetChallenge21Counter(opsLocId);
    const failure = error || (!data
      ? new Error(`Counter reset returned no result for location ${locationId}`)
      : null);
    reportSave('Challenge 21 counter', failure);
    if (failure) {
      // The POS reads the counter from the DB, so showing 0 here would be a lie.
      setError(`Counter NOT reset — ${failure.message}`);
      showToast('Counter NOT reset — the POS will keep counting from where it was', 'error');
      return;
    }
    setError('');
    setCounter(0);
  };

  if (loading) return <div style={pageStyle}><div style={{ padding: 24 }}>Loading…</div></div>;

  return (
    <div style={pageStyle}>
      <div style={{ padding: '28px 0' }}>
        <h1 style={{ fontSize: 26, fontWeight: 900, margin: 0, color:'var(--t1)' }}>Challenge ID</h1>
        <p style={{ fontSize: 14, color: 'var(--t3)', margin: '8px 0 0', maxWidth: 680, lineHeight: 1.6 }}>
          UK licensing compliance. When enabled, the POS will prompt staff every Nth alcohol-containing sale to record ID details for the customer. Submissions log to a date-filtered report you can export for licensing reviews.
        </p>

        {/* Tab switch */}
        <div style={{ display:'flex', gap: 4, marginTop: 22, borderBottom: '1px solid var(--bdr)' }}>
          {[{ id:'config', label:'Configuration' }, { id:'report', label:'Report' }].map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: '10px 18px', background: 'none', border: 'none',
              borderBottom: tab === t.id ? '2px solid var(--acc)' : '2px solid transparent',
              color: tab === t.id ? 'var(--t1)' : 'var(--t3)', cursor:'pointer',
              fontFamily:'inherit', fontSize: 13, fontWeight: 700,
              marginBottom: -1,
            }}>{t.label}</button>
          ))}
        </div>

        {tab === 'config' && (
          <div style={{ marginTop: 24 }}>
            {error && (
              <div style={{
                padding: '14px 16px', borderRadius: 10, marginBottom: 18,
                background: '#fef2f2', border: '1px solid #fca5a5',
                color: '#991b1b', fontSize: 13, lineHeight: 1.6,
              }}>{error}</div>
            )}

            {/* Enable toggle */}
            <Card>
              <Row>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color:'var(--t1)' }}>Enable Challenge ID</div>
                  <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 3 }}>
                    Off by default. Turn on when ready to enforce ID checks.
                  </div>
                </div>
                <Switch checked={enabled} onChange={setEnabled}/>
              </Row>
            </Card>

            {/* Alcohol categories */}
            <Card disabled={!enabled}>
              <div style={{ fontSize: 15, fontWeight: 700, color:'var(--t1)' }}>Alcohol-containing categories</div>
              <div style={{ fontSize: 12, color:'var(--t3)', marginTop: 3, marginBottom: 14 }}>
                Tick every category that contains alcohol. A sale counts toward the trigger counter if it contains AT LEAST ONE item from any ticked category.
              </div>
              {categories.length === 0 ? (
                <div style={{ fontSize: 12, color:'var(--t4)', padding: 16, background:'var(--bg2)', borderRadius: 8 }}>
                  No categories loaded. Set up your menu first in <strong>Menu Manager</strong>.
                </div>
              ) : (
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
                  {categories.map(c => {
                    const checked = categoryIds.includes(c.id);
                    return (
                      <label key={c.id} style={{
                        display:'flex', alignItems:'center', gap: 10,
                        padding:'10px 12px', borderRadius: 8,
                        background: checked ? '#fef3c7' : 'var(--bg2)',
                        border: checked ? '1px solid #f59e0b' : '1px solid var(--bdr2)',
                        cursor:'pointer', fontSize: 13,
                        // v5.5.168: force dark text on the cream-yellow checked
                        // background — without this, dark-theme --t1 is near-white
                        // and becomes invisible.
                        color: checked ? '#0b0c10' : 'var(--t1)',
                      }}>
                        <input type="checkbox" checked={checked} onChange={() => toggleCat(c.id)}
                          style={{ width: 16, height: 16, cursor:'pointer' }}/>
                        <span style={{ flex: 1, fontWeight: checked ? 700 : 500 }}>{c.name || '(unnamed)'}</span>
                        {checked && <span style={{ fontSize: 16 }}>🍺</span>}
                      </label>
                    );
                  })}
                </div>
              )}
              {categoryIds.length > 0 && (
                <div style={{ marginTop: 12, fontSize: 12, color:'var(--t3)' }}>
                  <strong>{categoryIds.length}</strong> categor{categoryIds.length === 1 ? 'y' : 'ies'} flagged as alcohol.
                </div>
              )}
            </Card>

            {/* Trigger frequency */}
            <Card disabled={!enabled}>
              <div style={{ fontSize: 15, fontWeight: 700, color:'var(--t1)' }}>Trigger frequency</div>
              <div style={{ fontSize: 12, color:'var(--t3)', marginTop: 3, marginBottom: 14 }}>
                Prompt fires after every <strong>N</strong> alcohol-containing sales. Lower = more frequent checks. UK best practice is every 5–20 sales.
              </div>
              <div style={{ display:'flex', alignItems:'center', gap: 12 }}>
                <span style={{ fontSize: 13, color:'var(--t2)' }}>Every</span>
                <input type="number" min={1} max={1000}
                  value={triggerEvery}
                  onChange={e => setTriggerEvery(e.target.value)}
                  style={{
                    width: 90, padding: '10px 12px', borderRadius: 8,
                    border: '1px solid var(--bdr2)', background: 'var(--bg2)',
                    color: 'var(--t1)', fontSize: 16, fontWeight: 700, fontFamily:'inherit',
                    textAlign: 'center',
                  }}/>
                <span style={{ fontSize: 13, color:'var(--t2)' }}>alcohol-containing sales</span>
              </div>
              <div style={{ marginTop: 14, padding: '10px 12px', background:'var(--bg2)', borderRadius: 8,
                fontSize: 12, color:'var(--t3)', display:'flex', alignItems:'center', gap: 10,
              }}>
                <span>Current counter: <strong style={{ color:'var(--t1)' }}>{counter}</strong> / {triggerEvery}</span>
                <button onClick={resetCounter} style={{
                  marginLeft:'auto', padding:'5px 10px', borderRadius: 6,
                  background:'transparent', border:'1px solid var(--bdr2)',
                  color:'var(--t2)', fontSize: 11, fontWeight: 600, cursor:'pointer', fontFamily:'inherit',
                }}>Reset</button>
              </div>
            </Card>

            {/* Save */}
            <div style={{ display:'flex', alignItems:'center', gap: 12, marginTop: 18 }}>
              <button onClick={save} disabled={saving} style={{
                padding: '12px 26px', borderRadius: 10, fontFamily:'inherit',
                background:'var(--acc)', color: '#0b0c10', border: 'none',
                fontSize: 14, fontWeight: 800, cursor: saving ? 'wait' : 'pointer',
                opacity: saving ? 0.6 : 1,
              }}>{saving ? 'Saving…' : 'Save settings'}</button>
              {savedAt && <span style={{ fontSize: 12, color:'var(--good)' }}>✓ Saved {new Date(savedAt).toLocaleTimeString()}</span>}
            </div>
          </div>
        )}

        {tab === 'report' && <Challenge21Report locationId={locationId}/>}
      </div>
    </div>
  );
}

const pageStyle = { color: 'var(--t1)' };

function Card({ children, disabled }) {
  return (
    <div style={{
      padding: 18, borderRadius: 12, marginBottom: 14,
      background: 'var(--bg1)', border: '1px solid var(--bdr)',
      opacity: disabled ? 0.55 : 1, pointerEvents: disabled ? 'none' : 'auto',
    }}>{children}</div>
  );
}

function Row({ children }) {
  return <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap: 14 }}>{children}</div>;
}

function Switch({ checked, onChange }) {
  return (
    <button onClick={() => onChange(!checked)} style={{
      width: 52, height: 30, borderRadius: 30,
      background: checked ? 'var(--acc)' : '#cbd5e1',
      border: 'none', cursor: 'pointer', position: 'relative',
      transition: 'background 0.15s', fontFamily: 'inherit',
    }}>
      <span style={{
        position: 'absolute', top: 3, left: checked ? 25 : 3,
        width: 24, height: 24, borderRadius: '50%',
        background: 'white', transition: 'left 0.15s',
        boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
      }}/>
    </button>
  );
}
