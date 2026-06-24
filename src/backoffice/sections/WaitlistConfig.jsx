// src/backoffice/sections/WaitlistConfig.jsx
//
// Tables Ready — Waitlist settings (Channels → Tables Ready). One waitlist_config
// row per location, read/written through the data layer under RLS. Sets the quote
// estimator's rules (buffer / max-quote / round-up / cold-start turn), per-band
// turn times (showing the learned value alongside when turn_time_stats has one),
// seating zones (reuses the floor-plan sections — capacity-only, never the live
// floor), the SMS templates the host fires (join / next / ready, with merge-field
// chips), and a "pair a host stand" panel that claims a paired tablet by code.
//
// All DB access tolerates a missing relation / mock mode (the data layer returns
// empty / null and never throws), so this page renders even before the migration
// is applied. Editing any rule recomputes live quotes on save (noted to the user).

import { useEffect, useMemo, useState, useCallback } from 'react';
import QRCode from 'qrcode';
import { useStore } from '../../store';
import { getActiveLocationSync, getLocationId, platformSupabase, isMock } from '../../lib/supabase';
import { customerUrl, CUSTOMER_ROOT } from '../../lib/env';
import {
  loadWaitlistConfig, saveWaitlistConfig, claimWaitlistDevice,
} from '../../lib/waitlist/waitlistData';
import {
  DEFAULT_BANDS, DEFAULT_QUOTE_RULES, clamp,
} from '../../lib/waitlist/waitlist';

// ── styles (matches CateringSettings card/form language) ──────────────────────
const S = {
  wrap: { height: '100%', overflowY: 'auto', padding: '22px 26px' },
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em', fontFamily: 'var(--font-display)' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18, maxWidth: 720 },
  card: { border: '1px solid var(--bdr)', borderRadius: 18, background: 'var(--bg1)', padding: 18, marginBottom: 16, maxWidth: 780 },
  h2: { fontSize: 15.5, fontWeight: 800, color: 'var(--t1)', margin: '0 0 4px', fontFamily: 'var(--font-display)' },
  cardSub: { fontSize: 12, color: 'var(--t3)', margin: '0 0 14px' },
  label: { display: 'block', fontSize: 11, fontWeight: 800, color: 'var(--t3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em', fontFamily: "'JetBrains Mono', var(--font-mono, ui-monospace), monospace" },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 12, padding: '9px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' },
  field: { marginBottom: 12 },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  hint: { fontSize: 11.5, color: 'var(--t4)', marginTop: 5, lineHeight: 1.45 },
  btn: { padding: '10px 20px', borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 13.5, fontWeight: 800, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  btnGhost: { padding: '9px 14px', borderRadius: 12, border: '1px solid var(--bdr2)', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: 'var(--bg2)', color: 'var(--t1)' },
  ok: { fontSize: 12.5, color: 'var(--grn)', fontWeight: 800 },
  err: { fontSize: 12, color: 'var(--red)', fontWeight: 700 },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  toggle: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: 'var(--t2)', cursor: 'pointer' },
  sliderVal: { fontFamily: "'JetBrains Mono', var(--font-mono, ui-monospace), monospace", fontWeight: 800, fontSize: 14, color: 'var(--t1)', minWidth: 64, textAlign: 'right' },
  stepBtn: { width: 44, height: 44, borderRadius: 999, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 18, cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1, display: 'grid', placeItems: 'center' },
  pill: { fontSize: 10.5, fontWeight: 800, padding: '2px 9px', borderRadius: 999, fontFamily: "'JetBrains Mono', var(--font-mono, ui-monospace), monospace", letterSpacing: '.03em' },
  chip: { fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 999, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--uv)', cursor: 'pointer', fontFamily: "'JetBrains Mono', var(--font-mono, ui-monospace), monospace" },
  ta: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 12, padding: '9px 12px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none', resize: 'vertical', minHeight: 60, lineHeight: 1.5 },
  codeInput: { width: 190, border: '1px solid var(--bdr2)', borderRadius: 12, padding: '10px 12px', fontSize: 16, letterSpacing: '.18em', fontWeight: 800, fontFamily: "'JetBrains Mono', var(--font-mono, ui-monospace), monospace", textTransform: 'uppercase', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' },
};

// Default SMS bodies the host fires (kept inline + editable per venue).
const DEFAULT_SMS = {
  join: 'Hi {name}, you’re on the list at {venue} — party of {size}. Estimated wait ~{quote} min. We’ll text when your table is ready.',
  next: '{name}, you’re next at {venue}! Please start heading back — your table for {size} is almost ready.',
  ready: '{name}, your table is ready at {venue}! Please see the host. We’ll hold it for a few minutes.',
};
const MERGE_FIELDS = ['{name}', '{venue}', '{size}', '{quote}'];

// camelCase config <-> editor working copy. The data layer already returns
// camelCase (cfg: {buffer,roundTo,maxQuote,defaultTurn,bands,zones,smsEnabled}).
function toEditor(cfg) {
  const c = cfg || {};
  const bands = (Array.isArray(c.bands) && c.bands.length ? c.bands : DEFAULT_BANDS).map((b) => ({
    label: b.label, min: b.min, max: b.max, turn: Number(b.turn) || DEFAULT_QUOTE_RULES.defaultTurn,
  }));
  const sms = c.sms || c.smsTemplates || {};
  return {
    buffer: c.buffer ?? DEFAULT_QUOTE_RULES.buffer,
    roundTo: c.roundTo ?? DEFAULT_QUOTE_RULES.roundTo,
    maxQuote: c.maxQuote ?? DEFAULT_QUOTE_RULES.maxQuote,
    defaultTurn: c.defaultTurn ?? DEFAULT_QUOTE_RULES.defaultTurn,
    bands,
    zones: Array.isArray(c.zones) ? c.zones : null,   // null = follow floor sections
    smsEnabled: c.smsEnabled !== false,
    selfServiceEnabled: c.selfServiceEnabled === true,   // F2: guest QR / link self-join (default OFF)
    sms: { join: sms.join || DEFAULT_SMS.join, next: sms.next || DEFAULT_SMS.next, ready: sms.ready || DEFAULT_SMS.ready },
  };
}

export default function WaitlistConfig() {
  const showToast = useStore((s) => s.showToast);
  const locationSections = useStore((s) => s.locationSections) || [];

  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [c, setC] = useState(null);
  const [learned, setLearned] = useState({});   // { bandLabel: {avg, n} } from turn_time_stats (passed through cfg if present)
  const [save, setSave] = useState({});
  const [code, setCode] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [slug, setSlug] = useState(null);         // venue online_slug (platform locations) — null = not set yet
  const [linkCopied, setLinkCopied] = useState(false);
  const [qr, setQr] = useState(null);             // QR data URI for the public join URL

  useEffect(() => {
    (async () => {
      try {
        const id = getActiveLocationSync() || await getLocationId().catch(() => null);
        setLocId(id);
        const { data: cfg } = await loadWaitlistConfig(id);   // table-absent-safe → {data:null}
        setC(toEditor(cfg));
        // Learned turns may ride along on the cfg payload; fall back to empty.
        const lt = cfg?.learnedTurns || cfg?.learned || {};
        setLearned(lt && typeof lt === 'object' ? lt : {});
        // Resolve the venue's online_slug so we can show the public join URL + QR.
        // Best-effort: platform locations are readable by the BO client (same pattern
        // as ReviewCard). Falls back to the ?loc= preview form when no slug is set.
        if (!isMock && platformSupabase && id) {
          try {
            const { data: loc } = await platformSupabase.from('locations')
              .select('online_slug').or(`ops_location_id.eq.${id},id.eq.${id}`).maybeSingle();
            if (loc?.online_slug) setSlug(loc.online_slug);
          } catch { /* slug best-effort — preview form is the fallback */ }
        }
      } catch {
        setC(toEditor(null));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const set = useCallback((patch) => setC((v) => ({ ...v, ...patch })), []);

  // The seating zones the host can request. Reuse the floor sections by default;
  // a venue can override the capacity note but the floor plan stays the source.
  const zonesView = useMemo(() => {
    if (Array.isArray(c?.zones) && c.zones.length) return c.zones;
    return (locationSections || []).map((sec) => ({ id: sec.id, name: sec.label, color: sec.color }));
  }, [c, locationSections]);

  // Public guest-join URL. With a slug we get the real branded host
  // (https://<slug>.serv-os.app/waitlist); without one we fall back to a
  // ?loc= preview against the operator host so the operator can still test it.
  const joinUrl = useMemo(() => {
    if (slug) return customerUrl(slug, '/waitlist');
    if (!locId) return null;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `${origin}/?loc=${encodeURIComponent(locId)}&surface=waitlist`;
  }, [slug, locId]);

  // Render the QR for the join URL only while self-service is on (it's the
  // thing the operator prints / displays). Regenerates if the URL changes.
  useEffect(() => {
    if (!c?.selfServiceEnabled || !joinUrl) { setQr(null); return; }
    let alive = true;
    QRCode.toDataURL(joinUrl, { width: 480, margin: 1, errorCorrectionLevel: 'M' })
      .then((d) => { if (alive) setQr(d); })
      .catch(() => { if (alive) setQr(null); });
    return () => { alive = false; };
  }, [c?.selfServiceEnabled, joinUrl]);

  const copyLink = async () => {
    if (!joinUrl) return;
    try { await navigator.clipboard.writeText(joinUrl); setLinkCopied(true); setTimeout(() => setLinkCopied(false), 1500); } catch { /* clipboard blocked — URL is shown for manual copy */ }
  };

  const saveAll = async () => {
    if (!c) return;
    setSave({ busy: true });
    try {
      const payload = {
        buffer: clamp(Number(c.buffer) || 0, 0, 20),
        roundTo: Number(c.roundTo) || 5,
        maxQuote: clamp(Number(c.maxQuote) || 120, 30, 120),
        defaultTurn: Math.max(5, Number(c.defaultTurn) || 60),
        bands: c.bands.map((b) => ({ label: b.label, min: b.min, max: b.max, turn: Math.max(5, Number(b.turn) || 60) })),
        zones: Array.isArray(c.zones) && c.zones.length ? c.zones : null,
        smsEnabled: !!c.smsEnabled,
        selfServiceEnabled: !!c.selfServiceEnabled,
        sms: c.sms,
      };
      const { error } = await saveWaitlistConfig(locId, payload);
      if (error) throw error;
      setSave({ done: true });
      showToast?.('Waitlist settings saved — new quotes use these rules', 'success');
      setTimeout(() => setSave((v) => (v.done ? {} : v)), 2800);
    } catch (e) {
      setSave({ err: e?.message || 'Save failed' });
      showToast?.(e?.message || 'Could not save', 'error');
    }
  };

  const claim = async () => {
    const cc = code.trim().toUpperCase();
    if (cc.length < 4) { showToast?.('Enter the code shown on the host stand', 'error'); return; }
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    setClaiming(true);
    try {
      // claimWaitlistDevice returns the RPC jsonb on success ({id, location_id})
      // or null if the code wasn't found / the RPC isn't migrated yet (it swallows
      // the error and logs it). A valid claim always carries a location_id.
      const res = await claimWaitlistDevice(cc, loc);
      if (res && res.location_id) {
        setCode(''); showToast?.('Host stand paired', 'success');
      } else {
        showToast?.('That code wasn’t found — check the host stand', 'error');
      }
    } catch (e) {
      showToast?.(e?.message || 'Could not pair', 'error');
    } finally {
      setClaiming(false);
    }
  };

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!c) return <div style={S.empty}>Pick a location to set up Tables Ready.</div>;

  const setBandTurn = (i, val) => set({ bands: c.bands.map((b, j) => (j === i ? { ...b, turn: val } : b)) });
  const insertMerge = (kind, token) => set({ sms: { ...c.sms, [kind]: `${c.sms[kind] || ''}${(c.sms[kind] || '').endsWith(' ') || !c.sms[kind] ? '' : ' '}${token} ` } });
  const hostUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/?mode=waitlist`;

  return (
    <div style={S.wrap}>
      <h1 style={S.h1}>Tables Ready</h1>
      <div style={S.sub}>
        Set how the walk-in waitlist quotes a wait and texts your guests. Quotes are data-driven from your live
        floor and learned turn times; these rules tune the estimate. Changes apply to <b>new</b> quotes —
        existing parties re-quote automatically on the live board.
      </div>

      {/* ── Quote rules ── */}
      <div style={S.card}>
        <h2 style={S.h2}>Quote rules</h2>
        <div style={S.cardSub}>The estimator's knobs. The wait is rounded up and capped so it always reads cleanly.</div>

        <div style={S.field}>
          <label style={S.label}>Safety buffer</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <input type="range" min={0} max={20} step={1} value={c.buffer} onChange={(e) => set({ buffer: Number(e.target.value) })} style={{ flex: 1, accentColor: 'var(--uv)' }} />
            <span style={S.sliderVal}>{c.buffer} min</span>
          </div>
          <div style={S.hint}>Padding added to every quote so you under-promise. 0–20 minutes.</div>
        </div>

        <div style={S.field}>
          <label style={S.label}>Maximum quote</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <input type="range" min={30} max={120} step={5} value={c.maxQuote} onChange={(e) => set({ maxQuote: Number(e.target.value) })} style={{ flex: 1, accentColor: 'var(--uv)' }} />
            <span style={S.sliderVal}>{c.maxQuote} min</span>
          </div>
          <div style={S.hint}>Quotes never read higher than this — above it the host says "see me". 30–120 minutes.</div>
        </div>

        <div style={S.row2}>
          <div style={S.field}>
            <label style={S.label}>Round up to</label>
            <select style={S.input} value={c.roundTo} onChange={(e) => set({ roundTo: Number(e.target.value) })}>
              <option value={1}>Nearest minute</option>
              <option value={5}>Nearest 5 min</option>
              <option value={10}>Nearest 10 min</option>
              <option value={15}>Nearest 15 min</option>
            </select>
            <div style={S.hint}>Quotes round up to a tidy number.</div>
          </div>
          <div style={S.field}>
            <label style={S.label}>Cold-start turn time</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button style={S.stepBtn} onClick={() => set({ defaultTurn: Math.max(5, c.defaultTurn - 5) })}>−</button>
              <span style={{ ...S.sliderVal, minWidth: 70 }}>{c.defaultTurn} min</span>
              <button style={S.stepBtn} onClick={() => set({ defaultTurn: c.defaultTurn + 5 })}>+</button>
            </div>
            <div style={S.hint}>Used before the system has learned a band's real turn time.</div>
          </div>
        </div>
      </div>

      {/* ── Per-band turn times ── */}
      <div style={S.card}>
        <h2 style={S.h2}>Turn time by party size</h2>
        <div style={S.cardSub}>
          How long a table is typically held for each party size. The system learns the real value from seated
          checks; the <span style={{ color: 'var(--grn)', fontWeight: 800 }}>learned</span> figure is shown when there's
          enough data, and replaces your seed automatically.
        </div>
        {c.bands.map((b, i) => {
          const l = learned[b.label] || learned[b.min + '-' + b.max] || null;
          return (
            <div key={b.label} style={{ display: 'grid', gridTemplateColumns: '92px 1fr 160px', gap: 12, alignItems: 'center', marginBottom: 8 }}>
              <div>
                <span style={{ ...S.pill, color: 'var(--uv)', border: '1px solid var(--uv)', background: 'transparent' }}>{b.label}</span>
                <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 3 }}>{b.max >= 999 ? `${b.min}+ guests` : `${b.min}–${b.max} guests`}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button style={S.stepBtn} onClick={() => setBandTurn(i, Math.max(5, b.turn - 5))}>−</button>
                <span style={{ ...S.sliderVal, minWidth: 64 }}>{b.turn} min</span>
                <button style={S.stepBtn} onClick={() => setBandTurn(i, b.turn + 5)}>+</button>
                <span style={{ fontSize: 11, color: 'var(--t4)' }}>your seed</span>
              </div>
              <div style={{ textAlign: 'right' }}>
                {l && Number.isFinite(Number(l.avg)) ? (
                  <>
                    <span style={{ ...S.pill, color: 'var(--grn)', border: '1px solid var(--grn)', background: 'transparent' }}>learned {Math.round(l.avg)} min</span>
                    <div style={{ fontSize: 10, color: 'var(--t4)', marginTop: 3 }}>{l.n || l.sampleCount || 0} seated</div>
                  </>
                ) : (
                  <span style={{ fontSize: 11, color: 'var(--t4)' }}>learning…</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Seating zones (reuse floor sections) ── */}
      <div style={S.card}>
        <h2 style={S.h2}>Seating zones</h2>
        <div style={S.cardSub}>
          A guest can request a zone (e.g. "patio"). These are your floor-plan sections — edit them in
          <b> Floor plan</b>. The waitlist only uses zones for <b>capacity</b> (which tables fit a party), never the
          live floor state.
        </div>
        {zonesView.length === 0 ? (
          <div style={S.hint}>No floor sections yet — add them in Floor plan and they'll appear here.</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {zonesView.map((z) => (
              <span key={z.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 999, border: '1px solid var(--bdr2)', background: 'var(--bg2)', fontSize: 12.5, fontWeight: 700, color: 'var(--t1)' }}>
                <span style={{ width: 9, height: 9, borderRadius: 999, background: z.color || 'var(--t4)' }} />
                {z.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── SMS templates ── */}
      <div style={S.card}>
        <h2 style={S.h2}>Text messages</h2>
        <div style={S.cardSub}>What the host fires at each step. Tap a chip to drop in a merge field.</div>
        <label style={{ ...S.toggle, marginBottom: 14 }}>
          <input type="checkbox" checked={c.smsEnabled} onChange={(e) => set({ smsEnabled: e.target.checked })} />
          Send SMS to guests {c.smsEnabled
            ? <span style={{ ...S.pill, color: 'var(--grn)', border: '1px solid var(--grn)', marginLeft: 6 }}>ON</span>
            : <span style={{ ...S.pill, color: 'var(--t4)', border: '1px solid var(--bdr2)', marginLeft: 6 }}>OFF</span>}
        </label>

        {[['join', 'On join', 'Sent when a party is added to the list.'], ['next', 'You’re next', 'Sent when their table is about to free up.'], ['ready', 'Table ready', 'Sent the moment their table is ready.']].map(([kind, title, desc]) => (
          <div key={kind} style={{ ...S.field, opacity: c.smsEnabled ? 1 : 0.5 }}>
            <label style={S.label}>{title}</label>
            <div style={{ fontSize: 11, color: 'var(--t4)', marginBottom: 6 }}>{desc}</div>
            <textarea style={S.ta} value={c.sms[kind]} disabled={!c.smsEnabled} onChange={(e) => set({ sms: { ...c.sms, [kind]: e.target.value } })} />
            <div style={{ display: 'flex', gap: 6, marginTop: 7, flexWrap: 'wrap' }}>
              {MERGE_FIELDS.map((f) => (
                <button key={f} type="button" disabled={!c.smsEnabled} style={S.chip} onClick={() => insertMerge(kind, f)}>{f}</button>
              ))}
            </div>
          </div>
        ))}
        <div style={S.hint}>Merge fields fill from the party + venue at send time. Guests can reply STOP to opt out. The on/off switch and merge fields apply now; custom message wording is saved with the config once your venue's config row supports it (defaults are used until then).</div>
      </div>

      {/* ── Guest self-service (QR / link join) ── */}
      <div style={S.card}>
        <h2 style={S.h2}>Guest self-service</h2>
        <div style={S.cardSub}>
          Let walk-ins add themselves to the list from a QR code or link — they get a live status page
          with their place in line and quoted wait, and can tap "on my way" or cancel. New self-joins land
          straight on your host board.
        </div>
        <label style={{ ...S.toggle, marginBottom: 14 }}>
          <input
            type="checkbox"
            checked={!!c.selfServiceEnabled}
            onChange={(e) => set({ selfServiceEnabled: e.target.checked })}
          />
          Allow guests to join from a QR / link {c.selfServiceEnabled
            ? <span style={{ ...S.pill, color: 'var(--grn)', border: '1px solid var(--grn)', marginLeft: 6 }}>ON</span>
            : <span style={{ ...S.pill, color: 'var(--t4)', border: '1px solid var(--bdr2)', marginLeft: 6 }}>OFF</span>}
        </label>

        {c.selfServiceEnabled && (
          <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {qr && (
              <div style={{ flexShrink: 0, padding: 10, background: '#fff', borderRadius: 14, border: '1px solid var(--bdr2)' }}>
                <img src={qr} alt="Waitlist join QR code" width={150} height={150} style={{ display: 'block' }} />
              </div>
            )}
            <div style={{ flex: '1 1 280px', minWidth: 240 }}>
              <label style={S.label}>Public join link</label>
              {!slug && (
                <div style={{ ...S.hint, color: 'var(--amber, var(--t3))', marginTop: 0, marginBottom: 8 }}>
                  No online slug set for this venue yet — set one in <b>Location settings → Online ordering</b> to get a
                  branded <code style={{ fontFamily: "'JetBrains Mono', var(--font-mono, ui-monospace), monospace" }}>your-venue.{CUSTOMER_ROOT}/waitlist</code> link.
                  The preview link below works for testing in the meantime.
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <code style={{ flex: '1 1 200px', minWidth: 180, fontSize: 12.5, padding: '9px 12px', borderRadius: 12, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontFamily: "'JetBrains Mono', var(--font-mono, ui-monospace), monospace", wordBreak: 'break-all' }}>
                  {joinUrl || '—'}
                </code>
                <button style={S.btnGhost} onClick={copyLink} disabled={!joinUrl}>
                  {linkCopied ? '✓ Copied' : 'Copy link'}
                </button>
              </div>
              <div style={S.hint}>
                Print the QR for the host stand / door, or share the link. Guests scanning it join the
                same live queue your host sees. Self-joins don't get the join SMS — their status page is the confirmation.
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Pair a host stand ── */}
      <div style={S.card}>
        <h2 style={S.h2}>Pair a host stand</h2>
        <div style={S.cardSub}>A tablet at the door runs the live board and takes walk-ins.</div>
        <ol style={{ margin: '0 0 14px', paddingLeft: 18, color: 'var(--t2)', fontSize: 13, lineHeight: 1.7 }}>
          <li>On the tablet, open <code style={{ background: 'var(--bg2)', padding: '1px 6px', borderRadius: 6, color: 'var(--t1)', fontFamily: "'JetBrains Mono', var(--font-mono, ui-monospace), monospace" }}>{hostUrl}</code> (or tap <b>Tables Ready</b> on the mode picker).</li>
          <li>It shows a <b>6-character pairing code</b>. Type that code below and pair.</li>
          <li>The stand then asks for a staff PIN — and you're on the live board.</li>
        </ol>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 8))}
            onKeyDown={(e) => e.key === 'Enter' && claim()}
            placeholder="CODE"
            style={S.codeInput}
          />
          <button onClick={claim} disabled={claiming} style={{ ...S.btn, opacity: claiming ? 0.6 : 1 }}>{claiming ? 'Pairing…' : 'Pair host stand'}</button>
        </div>
      </div>

      {/* ── Save bar ── */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', maxWidth: 780, paddingBottom: 24 }}>
        <button style={S.btn} onClick={saveAll} disabled={save.busy}>{save.busy ? 'Saving…' : 'Save waitlist settings'}</button>
        {save.done && <span style={S.ok}>✓ Saved — new quotes use these rules</span>}
        {save.err && <span style={S.err}>{save.err}</span>}
      </div>
    </div>
  );
}
