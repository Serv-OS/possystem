// v5.5.109 — BO → Online Ordering config page.
// Dedicated page for configuring everything customer-facing about online +
// QR ordering: which menu to expose, branding (logo / colors / hero), per-
// location operational settings (collection lead time, delivery on/off),
// plus the live customer URLs.
//
// Slug + enable toggles still live in Location Settings (they sit alongside
// timezone / business day / opening hours which are also operator-side
// config). This page is the "front-of-house" view of the online product.

import { useEffect, useRef, useState } from 'react';
import { platformSupabase, supabase, getLocationId } from '../../lib/supabase';

// Reuses the existing receipt-assets bucket with an online/ prefix so logo
// + hero uploads don't collide with the receipt branding's logo/QR assets.
const ASSET_BUCKET = 'receipt-assets';

async function uploadOnlineAsset(file, locationId, kind) {
  const ext = (file.name.split('.').pop() || 'png').toLowerCase();
  const path = `locations/${locationId}/online/${kind}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from(ASSET_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type });
  if (upErr) throw upErr;
  const { data: urlData } = supabase.storage.from(ASSET_BUCKET).getPublicUrl(path);
  // Cache-bust on replace so the customer surface picks up the new image
  return `${urlData.publicUrl}?t=${Date.now()}`;
}

const BLANK_BRANDING = {
  logo_url: '',
  hero_url: '',
  accent_color: '#e8a020',
  background:   '#0e0e10',
  foreground:   '#ffffff',
};

const ROOT = 'pos-up.com';

export default function OnlineOrdering({ setSection }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [error, setError]     = useState('');

  const [row,    setRow]      = useState(null);
  const [menus,  setMenus]    = useState([]);
  const [branding, setBranding] = useState(BLANK_BRANDING);
  const [menuId, setMenuId]   = useState('');
  const [leadMin, setLeadMin] = useState(30);
  const [deliveryOn, setDeliveryOn] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [uploadingHero, setUploadingHero] = useState(false);
  const [opsLocId, setOpsLocId] = useState(null);
  const logoInputRef = useRef(null);
  const heroInputRef = useRef(null);

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const _opsLocId = await getLocationId().catch(() => null);
        if (alive) setOpsLocId(_opsLocId);
        const opsLocId = _opsLocId;

        // Menus — from OPS DB. They're per-location and BO is authenticated to ops.
        if (opsLocId && supabase) {
          const { data: m } = await supabase.from('menus')
            .select('id, name, is_default, is_active').eq('location_id', opsLocId)
            .order('is_default', { ascending: false }).order('name');
          if (alive) setMenus(m || []);
        }

        // Platform location row — the home of online_branding / online_menu_id / etc
        if (platformSupabase) {
          const select = 'id, name, online_slug, online_enabled, qr_enabled, online_menu_id, online_branding, online_collection_lead_min, online_delivery_enabled';
          let r = null;
          if (opsLocId) {
            const r1 = await platformSupabase.from('locations').select(select).eq('ops_location_id', opsLocId).maybeSingle();
            r = r1.data;
            if (!r) {
              const r2 = await platformSupabase.from('locations').select(select).eq('id', opsLocId).maybeSingle();
              r = r2.data;
            }
          }
          if (!alive) return;
          setRow(r);
          if (r) {
            setBranding({
              ...BLANK_BRANDING,
              ...(r.online_branding || {}),
            });
            setMenuId(r.online_menu_id || '');
            setLeadMin(typeof r.online_collection_lead_min === 'number' ? r.online_collection_lead_min : 30);
            setDeliveryOn(!!r.online_delivery_enabled);
          }
        }
      } catch (e) {
        console.error('[OnlineOrdering] load failed:', e);
        setError(e?.message || 'Load failed');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // ── Upload handlers ──────────────────────────────────────────────────────
  // File picker → Supabase Storage upload → URL written back into branding
  // state. The user still needs to hit Save to persist the URL onto the
  // platform.locations row, but the image is uploaded immediately so the
  // preview updates and they don't lose their work if the page reloads.
  const handleUpload = async (file, kind, setUploading) => {
    if (!file) return;
    if (!opsLocId) { setError('No location resolved — set up Location Settings first.'); return; }
    if (file.size > 4 * 1024 * 1024) { setError(`${kind} must be under 4 MB.`); return; }
    setUploading(true); setError('');
    try {
      const url = await uploadOnlineAsset(file, opsLocId, kind);
      setBranding(b => ({ ...b, [kind === 'logo' ? 'logo_url' : 'hero_url']: url }));
    } catch (e) {
      console.error('[OnlineOrdering] upload failed:', e);
      setError(`${kind} upload failed: ${e?.message || e}`);
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    if (!platformSupabase || !row) {
      setError('No platform location loaded — open Location Settings first.');
      return;
    }
    setSaving(true); setError(''); setSaved(false);

    // Strip empty strings so the JSONB stays clean
    const cleanBranding = {
      logo_url:     branding.logo_url?.trim()     || null,
      hero_url:     branding.hero_url?.trim()     || null,
      accent_color: branding.accent_color || BLANK_BRANDING.accent_color,
      background:   branding.background   || BLANK_BRANDING.background,
      foreground:   branding.foreground   || BLANK_BRANDING.foreground,
    };

    const { data, error: err } = await platformSupabase
      .from('locations')
      .update({
        online_branding:            cleanBranding,
        online_menu_id:             menuId || null,
        online_collection_lead_min: Math.max(0, parseInt(leadMin, 10) || 0),
        online_delivery_enabled:    !!deliveryOn,
      })
      .eq('id', row.id)
      .select('id, online_branding, online_menu_id, online_collection_lead_min, online_delivery_enabled')
      .maybeSingle();

    setSaving(false);
    if (err) { setError(err.message || 'Save failed'); return; }
    if (!data) { setError('Update returned 0 rows — check RLS UPDATE policy on locations.'); return; }

    // Sync local state to what was actually persisted
    setBranding({ ...BLANK_BRANDING, ...(data.online_branding || {}) });
    setMenuId(data.online_menu_id || '');
    setLeadMin(typeof data.online_collection_lead_min === 'number' ? data.online_collection_lead_min : 30);
    setDeliveryOn(!!data.online_delivery_enabled);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  if (loading) return <div style={{ padding:40, color:'var(--t4)', fontSize:13 }}>Loading…</div>;
  if (!row) return (
    <div style={S.page}>
      <div style={S.h1}>🌐 Online ordering</div>
      <div style={{ marginTop:16, padding:'12px 14px', background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, color:'var(--t3)', fontSize:13 }}>
        Couldn't load this location's online settings. Open <button onClick={() => setSection('location')} style={S.link}>Location settings</button> to set up.
      </div>
    </div>
  );

  const slug = row.online_slug;
  const onlineUrl = slug ? `https://${slug}.${ROOT}` : null;
  const qrUrl     = slug ? `https://${slug}.${ROOT}/t/<table-id>` : null;
  const previewOnline = slug ? `https://possystem-liard.vercel.app/?loc=${slug}&surface=online` : null;
  const previewQr     = slug ? `https://possystem-liard.vercel.app/?loc=${slug}&surface=qr&t=t1` : null;

  return (
    <div style={S.page}>
      <div style={S.h1}>🌐 Online ordering</div>
      <div style={S.sub}>
        Customer-facing settings for online + QR table-side ordering at <b>{row.name}</b>.
        {!slug && <> · <button onClick={() => setSection('location')} style={S.link}>Set a slug in Location Settings</button> to enable customer URLs.</>}
      </div>

      {/* Status strip */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(280px, 1fr))', gap:12, marginBottom:24 }}>
        <StatusPill title="🌐 Online" enabled={row.online_enabled} url={onlineUrl} preview={previewOnline}/>
        <StatusPill title="📱 QR table-side" enabled={row.qr_enabled} url={qrUrl} preview={previewQr}/>
      </div>

      {/* Menu picker */}
      <div style={S.card}>
        <div style={S.h2}>🍽 Which menu shows online?</div>
        <div style={S.desc}>
          Choose which of your menus to expose on the customer-facing surfaces. If unset, the active menu (the one running in your POS / kiosk right now) is used as a fallback.
        </div>
        {menus.length === 0 ? (
          <div style={{ fontSize:12, color:'var(--t4)', fontStyle:'italic' }}>
            No menus found. Define menus in <button onClick={() => setSection('menu')} style={S.link}>Menu manager</button> first.
          </div>
        ) : (
          <select value={menuId} onChange={e => setMenuId(e.target.value)} style={{ ...S.select, maxWidth:360 }}>
            <option value="">— Use whichever menu is active —</option>
            {menus.map(m => (
              <option key={m.id} value={m.id}>
                {m.name}{m.is_default ? ' · default' : ''}{m.is_active === false ? ' (inactive)' : ''}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Branding */}
      <div style={S.card}>
        <div style={S.h2}>🎨 Branding</div>
        <div style={S.desc}>
          Logo, colours, and hero image shown on the customer-facing pages. The accent colour drives buttons + price highlights. Leave the URLs blank for a generic look.
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:14 }}>
          <ImageUpload
            label="Logo"
            url={branding.logo_url}
            kind="logo"
            uploading={uploadingLogo}
            inputRef={logoInputRef}
            onPick={(file) => handleUpload(file, 'logo', setUploadingLogo)}
            onClear={() => setBranding(b => ({ ...b, logo_url: '' }))}
            help="Square works best · PNG with transparency recommended · max 4 MB"
            previewBg="#0e0e10" previewWidth={88} previewHeight={88}/>
          <ImageUpload
            label="Hero banner"
            url={branding.hero_url}
            kind="hero"
            uploading={uploadingHero}
            inputRef={heroInputRef}
            onPick={(file) => handleUpload(file, 'hero', setUploadingHero)}
            onClear={() => setBranding(b => ({ ...b, hero_url: '' }))}
            help="Wide image · 1600×600 ideal · max 4 MB"
            previewBg="#0e0e10" previewWidth="100%" previewHeight={110}/>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:14 }}>
          <ColorField label="Accent colour" value={branding.accent_color} onChange={v => setBranding(b => ({ ...b, accent_color: v }))}/>
          <ColorField label="Background"    value={branding.background}   onChange={v => setBranding(b => ({ ...b, background: v }))}/>
          <ColorField label="Foreground"    value={branding.foreground}   onChange={v => setBranding(b => ({ ...b, foreground: v }))}/>
        </div>

        {/* Live mini-preview */}
        <div style={{ marginTop:18 }}>
          <div style={S.label}>Preview</div>
          <div style={{
            padding:'18px 20px', borderRadius:12, marginTop:8,
            background: branding.background, color: branding.foreground,
            border:'1px solid var(--bdr)',
            display:'flex', alignItems:'center', gap:14,
          }}>
            {branding.logo_url
              ? <img src={branding.logo_url} alt="logo" style={{ width:46, height:46, borderRadius:10, objectFit:'cover' }}/>
              : <div style={{ width:46, height:46, borderRadius:10, background:branding.accent_color, color:'#0b0c10', display:'flex', alignItems:'center', justifyContent:'center', fontSize:20, fontWeight:800 }}>
                  {(row.name || 'X')[0]}
                </div>}
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:15, fontWeight:800 }}>{row.name}</div>
              <div style={{ fontSize:11, opacity:.6 }}>Order online · Collection</div>
            </div>
            <button style={{
              padding:'9px 16px', borderRadius:99, border:'none',
              background: branding.accent_color, color:'#0b0c10',
              fontSize:12, fontWeight:800, cursor:'pointer', fontFamily:'inherit',
            }}>View cart · £24.50</button>
          </div>
        </div>
      </div>

      {/* Operational */}
      <div style={S.card}>
        <div style={S.h2}>⚙️ Operational</div>
        <div style={S.desc}>
          Per-location settings that affect the customer-facing flow.
        </div>

        <Field
          label="Collection lead time (minutes)"
          type="number" min="0"
          value={leadMin}
          onChange={v => setLeadMin(parseInt(v, 10) || 0)}
          help={`Customers can pick a collection time at least ${leadMin} minute${leadMin === 1 ? '' : 's'} from now.`}/>

        <div style={{ marginTop:14, display:'flex', alignItems:'center', justifyContent:'space-between', gap:10, padding:'10px 0' }}>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>Allow delivery</div>
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>Show the Delivery option alongside Collection. Delivery zones / fees come in a future commit.</div>
          </div>
          <Toggle on={deliveryOn} onChange={setDeliveryOn}/>
        </div>
      </div>

      {/* Save */}
      <div style={{ display:'flex', alignItems:'center', gap:12 }}>
        <button onClick={save} disabled={saving}
          style={{ ...S.btn, background:'var(--acc)', color:'#0b0c10', opacity:saving?.6:1 }}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        {saved && <span style={{ fontSize:13, color:'var(--grn)', fontWeight:600 }}>✓ Saved</span>}
        {error && <span style={{ fontSize:12, color:'var(--red)' }}>{error}</span>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function StatusPill({ title, enabled, url, preview }) {
  return (
    <div style={{ padding:'14px 16px', background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6 }}>
        <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>{title}</div>
        <span style={{
          padding:'2px 8px', borderRadius:99, fontSize:9, fontWeight:800, letterSpacing:'.05em', textTransform:'uppercase',
          background: enabled ? 'var(--grn-d)' : 'var(--bg3)',
          color: enabled ? 'var(--grn)' : 'var(--t4)',
          border: `1px solid ${enabled ? 'var(--grn-b)' : 'var(--bdr)'}`,
        }}>{enabled ? 'On' : 'Off'}</span>
      </div>
      <code style={{ fontSize:11, color:url ? 'var(--acc)' : 'var(--t4)', fontFamily:'var(--font-mono, monospace)', overflowWrap:'anywhere' }}>
        {url || '(no slug set)'}
      </code>
      {preview && (
        <a href={preview} target="_blank" rel="noopener" style={{ display:'inline-block', marginTop:8, fontSize:11, color:'var(--t3)', textDecoration:'underline' }}>
          Preview ↗
        </a>
      )}
    </div>
  );
}

function ImageUpload({ label, url, kind, uploading, inputRef, onPick, onClear, help, previewBg, previewWidth, previewHeight }) {
  return (
    <div>
      <div style={S.label}>{label}</div>
      <div style={{
        background: previewBg, borderRadius: 8, border:'1px dashed var(--bdr)',
        padding: 10, display:'flex', alignItems:'center', gap:12,
      }}>
        {url ? (
          <img src={url} alt={label}
            style={{ width: previewWidth, height: previewHeight, objectFit:'cover', borderRadius:6, flexShrink:0 }}/>
        ) : (
          <div style={{
            width: previewWidth, height: previewHeight, borderRadius:6,
            background: 'var(--bg3)', display:'flex', alignItems:'center', justifyContent:'center',
            color:'var(--t4)', fontSize:11, flexShrink:0,
          }}>
            No {kind}
          </div>
        )}
        <div style={{ flex:1, minWidth:0, display:'flex', flexDirection:'column', gap:6 }}>
          <input ref={inputRef} type="file" accept="image/*" style={{ display:'none' }}
            onChange={e => {
              const f = e.target.files?.[0]; if (f) onPick(f);
              if (inputRef.current) inputRef.current.value = '';
            }}/>
          <button onClick={() => inputRef.current?.click()} disabled={uploading}
            style={{
              padding:'7px 14px', borderRadius:8, border:'1px solid var(--bdr)',
              background:'var(--bg3)', color:'var(--t1)', cursor: uploading ? 'wait' : 'pointer',
              fontSize:12, fontWeight:700, fontFamily:'inherit',
            }}>
            {uploading ? 'Uploading…' : url ? `Replace ${kind}` : `Upload ${kind}`}
          </button>
          {url && (
            <button onClick={onClear}
              style={{ background:'transparent', border:'none', color:'var(--t4)', cursor:'pointer', fontSize:11, fontFamily:'inherit', padding:0, textAlign:'left' }}>
              Remove
            </button>
          )}
        </div>
      </div>
      {help && <div style={{ fontSize:11, color:'var(--t4)', marginTop:4 }}>{help}</div>}
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type = 'text', min, help }) {
  return (
    <div>
      <div style={S.label}>{label}</div>
      <input type={type} min={min}
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={S.input}/>
      {help && <div style={{ fontSize:11, color:'var(--t4)', marginTop:4 }}>{help}</div>}
    </div>
  );
}

function ColorField({ label, value, onChange }) {
  return (
    <div>
      <div style={S.label}>{label}</div>
      <div style={{ display:'flex', gap:6, alignItems:'center' }}>
        <input type="color"
          value={value || '#000000'}
          onChange={e => onChange(e.target.value)}
          style={{ width:42, height:32, padding:0, borderRadius:6, border:'1px solid var(--bdr)', background:'transparent', cursor:'pointer' }}/>
        <input type="text"
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          style={{ ...S.input, flex:1, fontFamily:'var(--font-mono, monospace)' }}/>
      </div>
    </div>
  );
}

function Toggle({ on, onChange }) {
  return (
    <button onClick={() => onChange(!on)} style={{
      width:44, height:24, borderRadius:12, border:'none', cursor:'pointer',
      background: on ? 'var(--acc)' : 'var(--bdr2)',
      position:'relative', transition:'background .2s', flexShrink:0,
    }}>
      <div style={{
        position:'absolute', top:3, left: on ? 23 : 3,
        width:18, height:18, borderRadius:'50%', background:'#fff',
        transition:'left .2s', boxShadow:'0 1px 3px rgba(0,0,0,.2)',
      }}/>
    </button>
  );
}

const S = {
  page: { padding:'32px 40px', maxWidth:880, overflowY:'auto' },
  h1:   { fontSize:22, fontWeight:800, marginBottom:4, color:'var(--t1)' },
  sub:  { fontSize:13, color:'var(--t3)', marginBottom:24, lineHeight:1.6 },
  card: { background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:14, padding:24, marginBottom:18 },
  h2:   { fontSize:14, fontWeight:700, color:'var(--t1)', marginBottom:4 },
  desc: { fontSize:12, color:'var(--t4)', marginBottom:14, lineHeight:1.6 },
  label:{ fontSize:11, fontWeight:600, color:'var(--t3)', marginBottom:5, display:'block', textTransform:'uppercase', letterSpacing:'.04em' },
  select:{ width:'100%', padding:'9px 12px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none' },
  input:{ width:'100%', padding:'9px 12px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box' },
  btn:  { padding:'10px 20px', borderRadius:8, border:'none', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:'inherit' },
  link: { background:'transparent', border:'none', color:'var(--acc)', textDecoration:'underline', cursor:'pointer', fontFamily:'inherit', padding:0, fontSize:'inherit' },
};
