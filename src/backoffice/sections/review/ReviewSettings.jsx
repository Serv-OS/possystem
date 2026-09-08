// src/backoffice/sections/review/ReviewSettings.jsx
//
// Review Settings — back office. Routing, connected platforms & AI config for the
// guest review card. Loads everything through the review-admin edge fn (the
// review_settings / review_platforms tables are service-role-write): get_config
// returns { settings, platforms, caps, notes }. Writes go back through the same
// fn — save_settings for the review-card copy + AI voice, upsert_platform per
// platform row. Capabilities (read/reply per platform) come from the server's
// caps map and are shown honestly — we never imply a capability the platform's
// API doesn't actually grant.
//
// Compliance note baked into the UX: the threshold is DE-GATED. It only sets
// internal triage emphasis/alerting — it NEVER hides the public review path from
// a guest, and we never auto-post a guest's review or suppress negative ones.

import { useEffect, useState, useMemo } from 'react';
import { supabase, getActiveLocationSync } from '../../../lib/supabase';
import GoogleConnect from './GoogleConnect';

const PLATFORM_LABEL = {
  google: 'Google', tripadvisor: 'TripAdvisor', facebook: 'Facebook', thefork: 'TheFork',
  trustpilot: 'Trustpilot', booking: 'Booking.com', yelp: 'Yelp', opentable: 'OpenTable',
  ubereats: 'Uber Eats', deliveroo: 'Deliveroo', justeat: 'Just Eat',
};

// Honest one-word capability labels for the caps map.
const CAP_LABEL = { api: 'Automatic', manual: 'Manual', none: 'Not available' };
const capColor = (c) => (c === 'api' ? 'var(--grn)' : c === 'manual' ? '#e0b748' : 'var(--t4)');

const DEFAULTS = {
  enabled: false,
  threshold: 4,
  page_title: 'How was your visit?',
  intro_copy: 'We’d love to hear how we did — your feedback helps us get better.',
  thanks_public_copy: 'Thank you! Tap below to share your review where it helps us most.',
  thanks_private_copy: 'Thank you for telling us — a manager will read this personally.',
  ai_auto_draft: false,
  brand_voice: '',
};

const S = {
  wrap:   { padding: 0 },
  h1:     { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub:    { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 20 },
  card:   { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 18, marginBottom: 16 },
  cardHd: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 4 },
  h2:     { fontSize: 15.5, fontWeight: 800, color: 'var(--t1)', margin: 0 },
  cardSub:{ fontSize: 12.5, color: 'var(--t3)', marginTop: 2, marginBottom: 14, lineHeight: 1.5 },
  field:  { marginBottom: 14 },
  label:  { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 6, letterSpacing: '.01em' },
  hint:   { fontSize: 11.5, color: 'var(--t4)', marginTop: 5, lineHeight: 1.45 },
  input:  { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' },
  area:   { width: '100%', boxSizing: 'border-box', minHeight: 70, border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none', resize: 'vertical', lineHeight: 1.5 },
  inset:  { border: '1px solid var(--bdr)', borderRadius: 12, background: 'var(--bg2)', padding: 14, marginBottom: 12 },
  row:    { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  pill:   { fontSize: 10.5, padding: '2px 8px', borderRadius: 99, background: 'var(--bg3)', color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 700, border: '1px solid var(--bdr)' },
  btn:    { padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' },
  prim:   { background: 'var(--acc)', color: '#0b0c10' },
  ghost:  { background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  saveRow:{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 },
  err:    { fontSize: 12, color: 'var(--red)', marginTop: 6 },
  ok:     { fontSize: 12.5, color: 'var(--grn)', fontWeight: 700 },
  empty:  { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  steps:  { display: 'flex', gap: 6, marginTop: 8 },
  stepBtn:(on) => ({ flex: 1, padding: '8px 0', borderRadius: 8, border: '1px solid var(--bdr2)', background: on ? 'var(--acc)' : 'var(--bg2)', color: on ? '#0b0c10' : 'var(--t2)', fontWeight: 800, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }),
  noteWarn:{ fontSize: 12, color: 'var(--t3)', marginTop: 8, padding: '8px 10px', border: '1px solid var(--bdr)', borderRadius: 8, background: 'var(--bg2)', lineHeight: 1.5 },
};

// House toggle — hand-rolled, no deps.
function Toggle({ on, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!on}
      disabled={disabled}
      onClick={() => !disabled && onChange(!on)}
      style={{
        width: 42, height: 24, borderRadius: 99, border: '1px solid var(--bdr2)',
        background: on ? 'var(--acc)' : 'var(--bg3)', position: 'relative', cursor: disabled ? 'default' : 'pointer',
        padding: 0, flexShrink: 0, opacity: disabled ? 0.5 : 1, transition: 'background .15s',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: on ? 20 : 2, width: 18, height: 18, borderRadius: 99,
        background: on ? '#0b0c10' : 'var(--t3)', transition: 'left .15s',
      }} />
    </button>
  );
}

// A reusable Save button + transient confirmation / error.
function SaveBar({ onSave, busy, done, err, label = 'Save' }) {
  return (
    <div style={S.saveRow}>
      <button style={{ ...S.btn, ...S.prim, opacity: busy ? 0.6 : 1 }} onClick={onSave} disabled={busy}>
        {busy ? 'Saving…' : label}
      </button>
      {done && <span style={S.ok}>✓ Saved</span>}
      {err && <span style={S.err}>{err}</span>}
    </div>
  );
}

export default function ReviewSettings() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');

  const [settings, setSettings] = useState(DEFAULTS);   // working copy of review_settings
  const [platforms, setPlatforms] = useState([]);       // [{platform, enabled, url, external_place_id}]
  const [caps, setCaps] = useState({});                 // { platform: { read, reply } }
  const [notes, setNotes] = useState({});               // { platform: { status_label, note } }

  // Per-section save state: { busy, done, err }
  const [cardSave, setCardSave] = useState({});
  const [aiSave, setAiSave] = useState({});
  const [platSave, setPlatSave] = useState({});         // { platform: { busy, done, err } }

  // ----- load -----
  const load = async () => {
    setLoading(true); setLoadErr('');
    try {
      const id = await getActiveLocationSync();
      setLocId(id);
      if (!supabase || !id) { setLoading(false); return; }
      const { data, error } = await supabase.functions.invoke('review-admin', {
        body: { action: 'get_config', ops_location_id: id },
      });
      if (error) { let b = null; try { b = await error.context?.json?.(); } catch {} throw new Error(b?.error || error.message); }
      if (data?.error) throw new Error(data.error);
      setSettings({ ...DEFAULTS, ...(data?.settings || {}) });
      setPlatforms(Array.isArray(data?.platforms) ? data.platforms : []);
      setCaps(data?.caps || {});
      setNotes(data?.notes || {});
    } catch (e) {
      setLoadErr(e.message || 'Could not load review settings');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const set = (patch) => setSettings(s => ({ ...s, ...patch }));

  // platform working-copy lookup, merged with server defaults so every cap key renders a card.
  const platformByKey = useMemo(() => {
    const m = {};
    platforms.forEach(p => { m[p.platform] = p; });
    return m;
  }, [platforms]);

  const setPlatformField = (key, patch) => {
    setPlatforms(list => {
      const next = list.slice();
      const i = next.findIndex(p => p.platform === key);
      const base = i >= 0 ? next[i] : { platform: key, enabled: false, url: '', external_place_id: '' };
      const merged = { ...base, ...patch };
      if (i >= 0) next[i] = merged; else next.push(merged);
      return next;
    });
  };

  // ----- saves -----
  const saveSettings = async (fields, setState) => {
    setState({ busy: true, done: false, err: '' });
    try {
      if (!supabase || !locId) throw new Error('No active location.');
      const { data, error } = await supabase.functions.invoke('review-admin', {
        body: { action: 'save_settings', ops_location_id: locId, settings: fields },
      });
      if (error) { let b = null; try { b = await error.context?.json?.(); } catch {} throw new Error(b?.error || error.message); }
      if (data?.error) throw new Error(data.error);
      setState({ busy: false, done: true, err: '' });
      setTimeout(() => setState(st => (st.done ? { ...st, done: false } : st)), 2200);
    } catch (e) {
      setState({ busy: false, done: false, err: e.message || 'Save failed' });
    }
  };

  const saveCard = () => saveSettings({
    enabled: settings.enabled,
    threshold: settings.threshold,
    page_title: settings.page_title,
    intro_copy: settings.intro_copy,
    thanks_public_copy: settings.thanks_public_copy,
    thanks_private_copy: settings.thanks_private_copy,
  }, setCardSave);

  const saveAi = () => saveSettings({
    brand_voice: settings.brand_voice,
    ai_auto_draft: settings.ai_auto_draft,
  }, setAiSave);

  const savePlatform = async (key) => {
    const p = platformByKey[key] || { platform: key, enabled: false, url: '', external_place_id: '' };
    setPlatSave(s => ({ ...s, [key]: { busy: true, done: false, err: '' } }));
    try {
      if (!supabase || !locId) throw new Error('No active location.');
      const { data, error } = await supabase.functions.invoke('review-admin', {
        body: {
          action: 'upsert_platform', ops_location_id: locId,
          platform: key, enabled: !!p.enabled, url: p.url || '', external_place_id: p.external_place_id || '',
        },
      });
      if (error) { let b = null; try { b = await error.context?.json?.(); } catch {} throw new Error(b?.error || error.message); }
      if (data?.error) throw new Error(data.error);
      setPlatSave(s => ({ ...s, [key]: { busy: false, done: true, err: '' } }));
      setTimeout(() => setPlatSave(s => (s[key]?.done ? { ...s, [key]: { ...s[key], done: false } } : s)), 2200);
    } catch (e) {
      setPlatSave(s => ({ ...s, [key]: { busy: false, done: false, err: e.message || 'Save failed' } }));
    }
  };

  // ----- render -----
  if (loading) return <div style={S.wrap}><h1 style={S.h1}>Review settings</h1><div style={S.empty}>Loading…</div></div>;

  if (!supabase || !locId) {
    return (
      <div style={S.wrap}>
        <h1 style={S.h1}>Review settings</h1>
        <div style={S.sub}>Routing, connected platforms & AI for your guest review card.</div>
        <div style={S.empty}>
          {!locId ? 'No active location selected — pick a location to configure reviews.'
                  : 'Running in mock mode — connect Supabase to manage review settings.'}
        </div>
      </div>
    );
  }

  const platformKeys = Object.keys(caps);

  return (
    <div style={S.wrap}>
      <h1 style={S.h1}>Review settings</h1>
      <div style={S.sub}>Routing, connected platforms & AI for your guest review card.</div>

      {loadErr && <div style={{ ...S.card, borderColor: 'var(--red)' }}><div style={S.err}>{loadErr}</div></div>}

      {/* ───────────────────────── 1. Customer review card ───────────────────────── */}
      <div style={S.card}>
        <div style={S.cardHd}>
          <h2 style={S.h2}>Customer review card</h2>
          <Toggle on={settings.enabled} onChange={(v) => set({ enabled: v })} />
        </div>
        <div style={S.cardSub}>
          The page guests land on after their visit. They tell you how it went, then everyone is offered the public
          review path — the card never hides it.
        </div>

        <div style={S.field}>
          <span style={S.label}>Internal emphasis threshold</span>
          <div style={S.steps}>
            {[1, 2, 3, 4, 5].map(n => (
              <button key={n} type="button" style={S.stepBtn(settings.threshold === n)} onClick={() => set({ threshold: n })}>
                {'★'.repeat(n)}
              </button>
            ))}
          </div>
          <div style={S.hint}>
            Ratings at or below this score are flagged for your team to follow up first — it’s for internal triage and
            alerting only.
          </div>
          <div style={S.noteWarn}>
            This does <strong>not</strong> hide the public review path from anyone, and we never auto-post a guest’s
            review or suppress a negative one. Every guest can leave a public review regardless of their rating.
          </div>
        </div>

        <div style={S.field}>
          <label style={S.label}>Page title</label>
          <input style={S.input} value={settings.page_title || ''} maxLength={80}
            onChange={e => set({ page_title: e.target.value })} placeholder={DEFAULTS.page_title} />
        </div>

        <div style={S.field}>
          <label style={S.label}>Intro copy</label>
          <textarea style={S.area} value={settings.intro_copy || ''}
            onChange={e => set({ intro_copy: e.target.value })} placeholder={DEFAULTS.intro_copy} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div style={S.field}>
            <label style={S.label}>Thank-you — public path</label>
            <textarea style={S.area} value={settings.thanks_public_copy || ''}
              onChange={e => set({ thanks_public_copy: e.target.value })} placeholder={DEFAULTS.thanks_public_copy} />
            <div style={S.hint}>Shown after a guest opts to post publicly.</div>
          </div>
          <div style={S.field}>
            <label style={S.label}>Thank-you — private feedback</label>
            <textarea style={S.area} value={settings.thanks_private_copy || ''}
              onChange={e => set({ thanks_private_copy: e.target.value })} placeholder={DEFAULTS.thanks_private_copy} />
            <div style={S.hint}>Shown when a guest sends feedback straight to you.</div>
          </div>
        </div>

        <SaveBar onSave={saveCard} busy={cardSave.busy} done={cardSave.done} err={cardSave.err} label="Save review card" />
      </div>

      {/* ───────────────────────── 2. Connected platforms ───────────────────────── */}
      <div style={S.card}>
        <div style={S.cardHd}>
          <h2 style={S.h2}>Connected platforms</h2>
        </div>
        <div style={S.cardSub}>
          Where public reviews are read from and replied to. Each platform’s capabilities depend on its own API — we
          show exactly what’s possible and never imply more.
        </div>

        {platformKeys.length === 0 && <div style={S.empty}>No platforms configured.</div>}

        {platformKeys.map(key => {
          const cap = caps[key] || { read: 'none', reply: 'none' };
          const note = notes[key] || {};
          const p = platformByKey[key] || { platform: key, enabled: false, url: '', external_place_id: '' };
          const ps = platSave[key] || {};
          const showUrl = cap.read === 'api' || cap.reply === 'api';
          const showPlaceId = key === 'google' && showUrl;
          return (
            <div key={key} style={S.inset}>
              <div style={S.row}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 14, color: 'var(--t1)' }}>{PLATFORM_LABEL[key] || key}</strong>
                    {note.status_label && <span style={S.pill}>{note.status_label}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 14, marginTop: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11.5, color: 'var(--t3)' }}>
                      Read: <span style={{ color: capColor(cap.read), fontWeight: 700 }}>{CAP_LABEL[cap.read] || cap.read}</span>
                    </span>
                    <span style={{ fontSize: 11.5, color: 'var(--t3)' }}>
                      Reply: <span style={{ color: capColor(cap.reply), fontWeight: 700 }}>{CAP_LABEL[cap.reply] || cap.reply}</span>
                    </span>
                  </div>
                </div>
                {key !== 'google' && <Toggle on={p.enabled} onChange={(v) => setPlatformField(key, { enabled: v })} />}
              </div>

              {note.note && <div style={{ ...S.hint, marginTop: 8 }}>{note.note}</div>}

              {key === 'google' ? (
                <GoogleConnect locId={locId} />
              ) : (
                <>
                  {showUrl && (
                    <div style={{ marginTop: 12 }}>
                      <label style={S.label}>Listing URL</label>
                      <input style={S.input} value={p.url || ''} placeholder="https://…"
                        onChange={e => setPlatformField(key, { url: e.target.value })} />
                    </div>
                  )}
                  <div style={{ marginTop: 12 }}>
                    <SaveBar onSave={() => savePlatform(key)} busy={ps.busy} done={ps.done} err={ps.err} label="Save" />
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* ───────────────────────── 3. AI replies ───────────────────────── */}
      <div style={S.card}>
        <div style={S.cardHd}>
          <h2 style={S.h2}>AI replies</h2>
        </div>
        <div style={S.cardSub}>
          Claude drafts replies in your house voice. A human always reviews and approves before anything is sent or
          posted — nothing goes out automatically.
        </div>

        <div style={S.field}>
          <label style={S.label}>Brand voice</label>
          <textarea
            style={{ ...S.area, minHeight: 110 }}
            value={settings.brand_voice || ''}
            onChange={e => set({ brand_voice: e.target.value })}
            placeholder="e.g. Warm and personal, never corporate. Use the guest’s first name. Thank them, address specifics, keep it under three sentences. British spelling. Sign off as ‘the team at {venue}’."
          />
          <div style={S.hint}>This guides how Claude writes every draft. Be specific about tone, length and sign-off.</div>
        </div>

        <div style={S.inset}>
          <div style={S.row}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--t1)' }}>Auto-draft new reviews</div>
              <div style={{ ...S.hint, marginTop: 4 }}>
                Pre-draft a reply for each new review so it’s ready in the queue. You still approve, edit or regenerate
                every one before it’s sent.
              </div>
            </div>
            <Toggle on={settings.ai_auto_draft} onChange={(v) => set({ ai_auto_draft: v })} />
          </div>
        </div>

        <SaveBar onSave={saveAi} busy={aiSave.busy} done={aiSave.done} err={aiSave.err} label="Save AI settings" />
      </div>
    </div>
  );
}
