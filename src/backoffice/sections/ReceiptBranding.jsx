import { useState, useEffect, useRef } from 'react';
import { useStore } from '../../store';
import { supabase, isMock, getLocationId } from '../../lib/supabase';
import { invalidateBrandingCache } from '../../lib/receiptBranding';
import { money } from '../../lib/currency';

const ASSET_BUCKET = 'receipt-assets';
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB

const DEFAULT_BRANDING = {
  paper_width_mm: 80,
  header: {
    logo_url: null,
    logo_storage_path: null,
    logo_width_dots: 384,
    business_name: '',
    address_lines: [],
    phone: '',
    tax_id: '',
    show_order_number: true,
    show_server_name: true,
    show_covers: true,
  },
  footer: {
    message: '',
    qr: {
      enabled: false,
      mode: 'url',
      url_value: '',
      storage_path: null,
      image_url: null,
      size_dots: 160,
      caption: '',
    },
  },
};

// Merge a loaded-from-DB branding record onto the defaults so a partially
// populated row still renders every form field.
function mergeDefaults(b) {
  if (!b) return DEFAULT_BRANDING;
  return {
    ...DEFAULT_BRANDING,
    ...b,
    header: { ...DEFAULT_BRANDING.header, ...(b.header || {}) },
    footer: {
      ...DEFAULT_BRANDING.footer,
      ...(b.footer || {}),
      qr: { ...DEFAULT_BRANDING.footer.qr, ...(b.footer?.qr || {}) },
    },
  };
}

async function uploadAsset(file, locationId, kind) {
  const ext = (file.name.split('.').pop() || 'png').toLowerCase();
  const path = `locations/${locationId}/${kind}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from(ASSET_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type });
  if (upErr) throw upErr;
  const { data: urlData } = supabase.storage.from(ASSET_BUCKET).getPublicUrl(path);
  // Bust browser cache when replacing an asset at the same path
  return { path, url: `${urlData.publicUrl}?t=${Date.now()}` };
}

export default function ReceiptBranding() {
  const { showToast } = useStore();
  const [locationId, setLocationId] = useState(null);
  const [branding, setBranding] = useState(DEFAULT_BRANDING);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [uploadingQR, setUploadingQR] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Persistent error banner — toasts dismiss too fast and these errors need visibility.
  const [saveError, setSaveError] = useState(null);
  const logoInputRef = useRef(null);
  const qrInputRef = useRef(null);

  useEffect(() => {
    const load = async () => {
      if (isMock) { setLoading(false); return; }
      const locId = await getLocationId().catch(() => null);
      if (!locId) { setLoading(false); return; }
      setLocationId(locId);
      const { data, error } = await supabase
        .from('locations')
        .select('receipt_branding')
        .eq('id', locId)
        .single();
      if (!error) setBranding(mergeDefaults(data?.receipt_branding));
      setLoading(false);
    };
    load();
  }, []);

  const updH = (key, val) => { setDirty(true); setBranding(b => ({ ...b, header: { ...b.header, [key]: val } })); };
  const updF = (key, val) => { setDirty(true); setBranding(b => ({ ...b, footer: { ...b.footer, [key]: val } })); };
  const updQR = (key, val) => { setDirty(true); setBranding(b => ({ ...b, footer: { ...b.footer, qr: { ...b.footer.qr, [key]: val } } })); };

  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !locationId) return;
    if (file.size > MAX_UPLOAD_BYTES) { showToast('Logo must be under 2MB', 'error'); return; }
    setUploadingLogo(true);
    try {
      const { path, url } = await uploadAsset(file, locationId, 'header');
      setBranding(b => ({ ...b, header: { ...b.header, logo_storage_path: path, logo_url: url } }));
      setDirty(true);
      showToast('Logo uploaded', 'success');
    } catch (err) {
      const msg = `Logo upload failed: ${err.message || err}. Check that the Supabase Storage bucket "receipt-assets" exists and is public.`;
      showToast(msg, 'error');
      setSaveError(msg);
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleQRUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !locationId) return;
    if (file.size > MAX_UPLOAD_BYTES) { showToast('QR image must be under 2MB', 'error'); return; }
    setUploadingQR(true);
    try {
      const { path, url } = await uploadAsset(file, locationId, 'qr');
      setBranding(b => ({ ...b, footer: { ...b.footer, qr: { ...b.footer.qr, storage_path: path, image_url: url } } }));
      setDirty(true);
      showToast('QR image uploaded', 'success');
    } catch (err) {
      const msg = `QR image upload failed: ${err.message || err}. Check that the Supabase Storage bucket "receipt-assets" exists and is public.`;
      showToast(msg, 'error');
      setSaveError(msg);
    } finally {
      setUploadingQR(false);
    }
  };

  const handleSave = async () => {
    if (!locationId) { showToast('No location — cannot save', 'error'); setSaveError('No location ID — cannot save. Are you signed in?'); return; }
    setSaving(true);
    setSaveError(null);
    try {
      // `.select()` so PostgREST returns the updated rows — we use data.length to
      // detect the silent-no-match case (where error stays null but 0 rows updated).
      const { data, error } = await supabase
        .from('locations')
        .update({ receipt_branding: branding })
        .eq('id', locationId)
        .select('id');
      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error(`No rows matched id=${locationId}. The location may not exist or RLS blocked the update.`);
      }
      invalidateBrandingCache(locationId);
      setDirty(false);
      showToast(`Receipt branding saved (${data.length} row) — next print will use it`, 'success');
    } catch (err) {
      const msg = `Save failed: ${err.message || err}`;
      showToast(msg, 'error');
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--t3)' }}>
        Loading…
      </div>
    );
  }

  return (
    <div style={{ display:'flex', flex:1, overflow:'hidden' }}>

      {/* Left: form */}
      <div style={{ flex:1, overflowY:'auto', padding:'20px 24px 32px', minWidth:0 }}>

        {/* Header bar */}
        <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:20, gap:16, flexWrap:'wrap' }}>
          <div>
            <h2 style={{ fontSize:22, fontWeight:800, margin:0, color:'var(--t1)', letterSpacing:'-.01em' }}>Receipt branding</h2>
            <div style={{ fontSize:12, color:'var(--t3)', marginTop:4, maxWidth:520 }}>
              Logo, business details, and footer QR for customer receipts at this location. Changes apply on the next print. Run the receipt-control migration first (see migrations folder) if save fails with a "column does not exist" error.
            </div>
          </div>
          <button
            onClick={handleSave}
            disabled={saving || !locationId || !dirty}
            style={{
              padding:'10px 20px', borderRadius:10, cursor: (saving || !dirty) ? 'default' : 'pointer',
              fontFamily:'inherit', fontSize:13, fontWeight:700, flexShrink:0,
              background: dirty ? 'var(--grn)' : 'var(--bg3)',
              border:`1px solid ${dirty ? 'var(--grn-b, var(--grn))' : 'var(--bdr)'}`,
              color: dirty ? '#0e0f14' : 'var(--t3)',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving…' : dirty ? 'Save branding' : 'Saved'}
          </button>
        </div>

        {/* Persistent error banner — visible until dismissed or successful retry */}
        {saveError && (
          <div style={{ marginBottom:16, padding:'12px 14px', borderRadius:10, background:'var(--red-d)', border:'1.5px solid var(--red-b)', color:'var(--red)', fontSize:12, display:'flex', alignItems:'flex-start', gap:10 }}>
            <div style={{ flex:1, whiteSpace:'pre-wrap' }}>{saveError}</div>
            <button onClick={() => setSaveError(null)} style={{ background:'transparent', border:'none', color:'var(--red)', cursor:'pointer', fontSize:18, lineHeight:1, padding:'0 4px', flexShrink:0 }} aria-label="Dismiss">×</button>
          </div>
        )}

        {/* Header section */}
        <Section title="Header">
          <LogoRow
            url={branding.header.logo_url}
            uploading={uploadingLogo}
            onPick={() => logoInputRef.current?.click()}
            onRemove={() => { updH('logo_url', null); updH('logo_storage_path', null); }}
          />
          <input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display:'none' }} onChange={handleLogoUpload}/>
          <NumberRow label="Logo width (dots)" hint="80mm paper = 576 dots max. 384 is a safe default." value={branding.header.logo_width_dots} min={96} max={576} step={8} onChange={v => updH('logo_width_dots', v)}/>
          <TextRow label="Business name" value={branding.header.business_name} onChange={v => updH('business_name', v)} placeholder="Your business name"/>
          <TextAreaRow label="Address (one line per row)" rows={3} value={(branding.header.address_lines || []).join('\n')} onChange={v => updH('address_lines', v.split('\n'))} placeholder={'Street\nCity, State'}/>
          <TextRow label="Phone" value={branding.header.phone} onChange={v => updH('phone', v)} placeholder="+44 20 7123 4567"/>
          <TextRow label="VAT / Tax ID" value={branding.header.tax_id} onChange={v => updH('tax_id', v)} placeholder="VAT GB123456789"/>
          <ToggleRow label="Show server name" desc="Prints 'Server: Jane' under the check ref" checked={branding.header.show_server_name !== false} onChange={v => updH('show_server_name', v)}/>
          <ToggleRow label="Show covers count" desc="Prints 'N covers' on dine-in receipts with >1 guest" checked={branding.header.show_covers !== false} onChange={v => updH('show_covers', v)}/>
        </Section>

        {/* Footer section */}
        <Section title="Footer message">
          <TextAreaRow label="Message" rows={2} value={branding.footer.message} onChange={v => updF('message', v)} placeholder="Thank you for dining with us!"/>
        </Section>

        {/* Footer QR */}
        <Section title="Footer QR code">
          <ToggleRow label="Enable QR code" desc="Prints below the footer message" checked={!!branding.footer.qr.enabled} onChange={v => updQR('enabled', v)}/>
          {branding.footer.qr.enabled && (
            <>
              <ModeRow
                mode={branding.footer.qr.mode || 'url'}
                onChange={m => updQR('mode', m)}
              />
              {branding.footer.qr.mode === 'url' ? (
                <TextRow
                  label="URL to encode"
                  value={branding.footer.qr.url_value || ''}
                  onChange={v => updQR('url_value', v)}
                  placeholder="https://your-venue.com/review"
                  hint="Generated at print time using the printer's native QR command. Crisper than an uploaded image."
                />
              ) : (
                <QRImageRow
                  url={branding.footer.qr.image_url}
                  uploading={uploadingQR}
                  onPick={() => qrInputRef.current?.click()}
                  onRemove={() => { updQR('image_url', null); updQR('storage_path', null); }}
                />
              )}
              <input ref={qrInputRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display:'none' }} onChange={handleQRUpload}/>
              <NumberRow label="QR size (dots)" hint="~25 dots per millimetre. 160 is ~20mm." value={branding.footer.qr.size_dots} min={96} max={400} step={8} onChange={v => updQR('size_dots', v)}/>
              <TextRow label="Caption" value={branding.footer.qr.caption || ''} onChange={v => updQR('caption', v)} placeholder="Scan to leave a review"/>
            </>
          )}
        </Section>

      </div>

      {/* Right: preview */}
      <ReceiptPreview branding={branding}/>

    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Section({ title, children }) {
  return (
    <div style={{ marginBottom:20, padding:'14px 16px 18px', background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:12 }}>
      <div style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:12 }}>{title}</div>
      <div style={{ display:'flex', flexDirection:'column', gap:12 }}>{children}</div>
    </div>
  );
}

function TextRow({ label, value, onChange, placeholder, hint }) {
  return (
    <label style={{ display:'block' }}>
      <div style={{ fontSize:12, fontWeight:600, color:'var(--t2)', marginBottom:5 }}>{label}</div>
      <input
        type="text"
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width:'100%', height:36, padding:'0 12px', borderRadius:8, boxSizing:'border-box',
          background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t1)',
          fontSize:13, fontFamily:'inherit', outline:'none',
        }}
      />
      {hint && <div style={{ fontSize:11, color:'var(--t4)', marginTop:4 }}>{hint}</div>}
    </label>
  );
}

function TextAreaRow({ label, value, onChange, placeholder, rows = 3 }) {
  return (
    <label style={{ display:'block' }}>
      <div style={{ fontSize:12, fontWeight:600, color:'var(--t2)', marginBottom:5 }}>{label}</div>
      <textarea
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        style={{
          width:'100%', padding:'8px 12px', borderRadius:8, boxSizing:'border-box',
          background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t1)',
          fontSize:13, fontFamily:'inherit', outline:'none', resize:'vertical', lineHeight:1.4,
        }}
      />
    </label>
  );
}

function NumberRow({ label, value, onChange, min, max, step, hint }) {
  return (
    <label style={{ display:'block' }}>
      <div style={{ fontSize:12, fontWeight:600, color:'var(--t2)', marginBottom:5 }}>{label}</div>
      <input
        type="number"
        value={value ?? ''}
        min={min} max={max} step={step || 1}
        onChange={e => onChange(Number(e.target.value) || 0)}
        style={{
          width:120, height:36, padding:'0 12px', borderRadius:8, boxSizing:'border-box',
          background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t1)',
          fontSize:13, fontFamily:'inherit', outline:'none',
        }}
      />
      {hint && <div style={{ fontSize:11, color:'var(--t4)', marginTop:4 }}>{hint}</div>}
    </label>
  );
}

function ToggleRow({ label, desc, checked, onChange }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:12 }}>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:13, fontWeight:600, color:'var(--t1)' }}>{label}</div>
        {desc && <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>{desc}</div>}
      </div>
      <button
        onClick={() => onChange(!checked)}
        style={{
          width:44, height:24, borderRadius:12, border:'none', cursor:'pointer',
          background: checked ? 'var(--grn)' : 'var(--bg4)', transition:'all .2s', flexShrink:0, position:'relative',
        }}
      >
        <div style={{
          width:18, height:18, borderRadius:'50%', background:'#fff',
          position:'absolute', top:3, left: checked ? 22 : 3, transition:'left .2s',
          boxShadow:'0 1px 3px rgba(0,0,0,.3)',
        }}/>
      </button>
    </div>
  );
}

function ModeRow({ mode, onChange }) {
  const opts = [
    { id: 'url',    label: 'Generate from URL', desc: 'Native ESC/POS — crispest result' },
    { id: 'upload', label: 'Upload image',       desc: 'Use an existing QR PNG/JPG' },
  ];
  return (
    <div>
      <div style={{ fontSize:12, fontWeight:600, color:'var(--t2)', marginBottom:6 }}>QR mode</div>
      <div style={{ display:'flex', gap:8 }}>
        {opts.map(o => {
          const on = mode === o.id;
          return (
            <button
              key={o.id}
              onClick={() => onChange(o.id)}
              style={{
                flex:1, padding:'10px 12px', borderRadius:10, cursor:'pointer', textAlign:'left',
                background: on ? 'var(--acc-d)' : 'var(--bg3)',
                border: `1.5px solid ${on ? 'var(--acc-b)' : 'var(--bdr)'}`,
                color: on ? 'var(--acc)' : 'var(--t2)',
                fontFamily:'inherit',
              }}
            >
              <div style={{ fontSize:12, fontWeight:700 }}>{o.label}</div>
              <div style={{ fontSize:10, color: on ? 'var(--acc)' : 'var(--t4)', marginTop:2, opacity: on ? 0.8 : 1 }}>{o.desc}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LogoRow({ url, uploading, onPick, onRemove }) {
  return (
    <div>
      <div style={{ fontSize:12, fontWeight:600, color:'var(--t2)', marginBottom:6 }}>Header logo</div>
      <div style={{ display:'flex', alignItems:'center', gap:12 }}>
        <div style={{
          width:120, height:80, borderRadius:8, background:'#fff', border:'1px solid var(--bdr)',
          display:'flex', alignItems:'center', justifyContent:'center', overflow:'hidden', flexShrink:0,
        }}>
          {url ? (
            <img src={url} alt="" style={{ maxWidth:'100%', maxHeight:'100%', objectFit:'contain' }}/>
          ) : (
            <div style={{ fontSize:10, color:'#999' }}>No logo</div>
          )}
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:6, flex:1 }}>
          <button onClick={onPick} disabled={uploading} style={{
            padding:'8px 14px', borderRadius:8, cursor: uploading ? 'wait' : 'pointer', fontFamily:'inherit',
            background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t1)',
            fontSize:12, fontWeight:600, opacity: uploading ? 0.6 : 1, alignSelf:'flex-start',
          }}>
            {uploading ? 'Uploading…' : url ? 'Replace logo' : 'Upload logo'}
          </button>
          {url && (
            <button onClick={onRemove} style={{
              padding:'6px 14px', borderRadius:8, cursor:'pointer', fontFamily:'inherit',
              background:'transparent', border:'1px solid var(--bdr)', color:'var(--red)',
              fontSize:11, fontWeight:600, alignSelf:'flex-start',
            }}>Remove</button>
          )}
          <div style={{ fontSize:10, color:'var(--t4)' }}>PNG, JPG, or WebP. Under 2MB. Black-on-white works best.</div>
        </div>
      </div>
    </div>
  );
}

function QRImageRow({ url, uploading, onPick, onRemove }) {
  return (
    <div>
      <div style={{ fontSize:12, fontWeight:600, color:'var(--t2)', marginBottom:6 }}>QR image</div>
      <div style={{ display:'flex', alignItems:'center', gap:12 }}>
        <div style={{
          width:80, height:80, borderRadius:8, background:'#fff', border:'1px solid var(--bdr)',
          display:'flex', alignItems:'center', justifyContent:'center', overflow:'hidden', flexShrink:0,
        }}>
          {url ? (
            <img src={url} alt="" style={{ maxWidth:'100%', maxHeight:'100%', objectFit:'contain' }}/>
          ) : (
            <div style={{ fontSize:10, color:'#999' }}>No QR</div>
          )}
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:6, flex:1 }}>
          <button onClick={onPick} disabled={uploading} style={{
            padding:'8px 14px', borderRadius:8, cursor: uploading ? 'wait' : 'pointer', fontFamily:'inherit',
            background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t1)',
            fontSize:12, fontWeight:600, opacity: uploading ? 0.6 : 1, alignSelf:'flex-start',
          }}>
            {uploading ? 'Uploading…' : url ? 'Replace QR image' : 'Upload QR image'}
          </button>
          {url && (
            <button onClick={onRemove} style={{
              padding:'6px 14px', borderRadius:8, cursor:'pointer', fontFamily:'inherit',
              background:'transparent', border:'1px solid var(--bdr)', color:'var(--red)',
              fontSize:11, fontWeight:600, alignSelf:'flex-start',
            }}>Remove</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Live preview ─────────────────────────────────────────────────────────────

function ReceiptPreview({ branding }) {
  const h = branding.header || {};
  const f = branding.footer || {};
  const qr = f.qr || {};
  const addressLines = (h.address_lines || []).filter(Boolean);
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
  const timeStr = now.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });

  // Sample data to make the preview feel real
  const sampleItems = [
    { qty: 1, name: 'Burger & chips', price: 14.50 },
    { qty: 2, name: 'House lager',    price: 5.50  },
    { qty: 1, name: 'Sticky toffee',  price: 7.00  },
  ];
  const subtotal = sampleItems.reduce((s, i) => s + i.qty * i.price, 0);
  const service = subtotal * 0.125;
  const total = subtotal + service;

  return (
    <div style={{
      width: 360, flexShrink: 0, background: 'var(--bg1)',
      borderLeft: '1px solid var(--bdr)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{
        padding: '14px 20px', borderBottom: '1px solid var(--bdr)',
        fontSize: 11, fontWeight: 700, color: 'var(--t3)',
        textTransform: 'uppercase', letterSpacing: '.07em', flexShrink: 0,
      }}>
        Preview · 80mm thermal
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 16px', display: 'flex', justifyContent: 'center' }}>
        <div style={{
          width: 290, background: '#fff', color: '#000', padding: 18,
          fontFamily: 'DM Mono, Menlo, monospace', fontSize: 10.5, lineHeight: 1.5,
          boxShadow: '0 4px 16px rgba(0,0,0,.25)', borderRadius: 2,
        }}>
          {/* Logo */}
          {h.logo_url && (
            <div style={{ textAlign: 'center', marginBottom: 8 }}>
              <img
                src={h.logo_url}
                alt=""
                style={{
                  maxWidth: `${Math.min(100, ((h.logo_width_dots || 384) / 576) * 100)}%`,
                  maxHeight: 90, objectFit: 'contain',
                }}
              />
            </div>
          )}

          {/* Business name */}
          <div style={{ textAlign: 'center', fontWeight: 800, fontSize: 14, marginBottom: 4 }}>
            {h.business_name || 'Your business name'}
          </div>

          {/* Address / phone / tax id */}
          {addressLines.map((line, i) => (
            <div key={`a${i}`} style={{ textAlign: 'center', fontSize: 10 }}>{line}</div>
          ))}
          {h.phone  && <div style={{ textAlign: 'center', fontSize: 10 }}>{h.phone}</div>}
          {h.tax_id && <div style={{ textAlign: 'center', fontSize: 9, color: '#555', marginTop: 2 }}>{h.tax_id}</div>}

          <div style={{ borderTop: '1px dashed #000', margin: '10px 0' }}/>

          {/* Check header */}
          <Row left="Ref: R12345678" right={`${dateStr} ${timeStr}`}/>
          {h.show_server_name !== false && (
            <Row left="Server: Jane" right={h.show_covers !== false ? '3 covers' : ''}/>
          )}
          <Row left="Table 7 · dine-in" right=""/>

          <div style={{ borderTop: '1px dashed #000', margin: '10px 0' }}/>

          <div style={{ fontWeight: 800, marginBottom: 4 }}>ITEMS</div>
          {sampleItems.map((it, i) => (
            <Row
              key={`i${i}`}
              left={`${it.qty > 1 ? it.qty + 'x ' : ''}${it.name}`}
              right={`${money((it.qty * it.price))}`}
            />
          ))}

          <div style={{ borderTop: '1px dashed #000', margin: '10px 0' }}/>

          <Row left="Subtotal" right={`${money(subtotal)}`}/>
          <Row left="Service (12.5%)" right={`${money(service)}`}/>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: 14, marginTop: 4 }}>
            <span>TOTAL</span><span>{money(total)}</span>
          </div>

          <div style={{ borderTop: '1px dashed #000', margin: '10px 0' }}/>

          {/* Footer message */}
          <div style={{ textAlign: 'center', marginBottom: qr.enabled ? 10 : 4 }}>
            {f.message || 'Thank you for dining with us!'}
          </div>

          {/* QR code */}
          {qr.enabled && (
            <div style={{ textAlign: 'center', marginTop: 6 }}>
              {qr.mode === 'upload' && qr.image_url ? (
                <img
                  src={qr.image_url}
                  alt=""
                  style={{
                    width: Math.min(160, (qr.size_dots || 160) * 0.55),
                    height: Math.min(160, (qr.size_dots || 160) * 0.55),
                    objectFit: 'contain',
                  }}
                />
              ) : (
                <div style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: Math.min(160, (qr.size_dots || 160) * 0.55),
                  height: Math.min(160, (qr.size_dots || 160) * 0.55),
                  background: '#eee', border: '1px dashed #999',
                  fontSize: 8, color: '#666', padding: 4, textAlign: 'center',
                  wordBreak: 'break-all',
                }}>
                  {qr.mode === 'url'
                    ? (qr.url_value || 'Set a URL to preview')
                    : 'Upload a QR image'}
                </div>
              )}
              {qr.caption && (
                <div style={{ fontSize: 9, marginTop: 4 }}>{qr.caption}</div>
              )}
            </div>
          )}

          <div style={{ textAlign: 'center', fontSize: 8, color: '#666', marginTop: 12 }}>
            Powered by Serv OS
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ left, right }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{left}</span>
      <span style={{ flexShrink: 0 }}>{right}</span>
    </div>
  );
}
