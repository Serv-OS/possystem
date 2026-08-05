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
import { saveLocation } from '../../lib/locationAdmin';
import { CUSTOMER_ROOT, customerUrl, groupOrderUrl } from '../../lib/env';
import QRCode from 'qrcode';

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
  accent_color: '#E8743C',
  background:   '#0e0e10',
  foreground:   '#ffffff',
};

const ROOT = CUSTOMER_ROOT;

export default function OnlineOrdering({ setSection }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [error, setError]     = useState('');

  const [row,    setRow]      = useState(null);
  // Multi-site group ordering link — set when this venue's company has
  // more than one location ({ slug, name, count }); read-only, shown for copying.
  const [group,  setGroup]    = useState(null);
  const [menus,  setMenus]    = useState([]);
  const [branding, setBranding] = useState(BLANK_BRANDING);
  const [menuId, setMenuId]   = useState('');
  const [leadMin, setLeadMin] = useState(30);
  const [deliveryOn, setDeliveryOn] = useState(false);
  // v5.5.959: the Gift cards / Loyalty pills were hardcoded enabled={true} — a fresh
  // venue with both OFF showed both ON. Read the REAL company-level flags; absent
  // config = OFF (the honest default for an unconfigured venue).
  const [giftOn, setGiftOn]       = useState(false);
  const [loyaltyOn, setLoyaltyOn] = useState(false);
  useEffect(() => {
    if (!row?.company_id || !platformSupabase) return;
    let alive = true;
    (async () => {
      try {
        const [g, l] = await Promise.all([
          platformSupabase.from('gift_brand_config').select('enabled').eq('company_id', row.company_id).maybeSingle(),
          platformSupabase.from('loyalty_config').select('enabled').eq('company_id', row.company_id).maybeSingle(),
        ]);
        if (!alive) return;
        setGiftOn(!!g?.data?.enabled);
        setLoyaltyOn(!!l?.data?.enabled);
      } catch { /* pills stay OFF — never claim a feature is live on a read failure */ }
    })();
    return () => { alive = false; };
  }, [row?.company_id]);
  // v5.5.147: QR ordering settings + table list for QR-code generator
  const [qrPaymentMode, setQrPaymentMode] = useState('pay_now');   // 'pay_now' | 'open_tab' | 'both'
  const [qrTableMode,   setQrTableMode]   = useState('confirm');    // 'fixed' | 'confirm' | 'free'
  const [qrServicePct,  setQrServicePct]  = useState(0);
  // v5.5.149: open-tab guardrails. Shown to customer + enforced on close.
  const [qrTabPreAuth,        setQrTabPreAuth]        = useState(100);   // £ held on the card when tab opens
  const [qrTabWarning,        setQrTabWarning]        = useState('Note: tabs left open at close-time may incur a surcharge.');
  const [qrTabSurchargePct,   setQrTabSurchargePct]   = useState(0);
  const [qrTabSurchargeFixed, setQrTabSurchargeFixed] = useState(0);
  const [qrTabForceCloseMin,  setQrTabForceCloseMin]  = useState(0);     // 0 = manual only
  const [tables, setTables] = useState([]);
  const [downloading, setDownloading] = useState(false);
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
          const select = 'id, name, company_id, online_slug, online_enabled, qr_enabled, online_menu_id, online_branding, online_collection_lead_min, online_delivery_enabled';
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
            // v5.5.147: probe QR settings separately so a missing-column error
            // (migration not run yet) doesn't break the rest of this page.
            try {
              const { data: qr } = await platformSupabase
                .from('locations')
                .select('qr_payment_mode, qr_table_mode, qr_service_charge_pct')
                .eq('id', r.id).maybeSingle();
              if (qr) {
                setQrPaymentMode(qr.qr_payment_mode || 'pay_now');
                setQrTableMode(qr.qr_table_mode || 'confirm');
                setQrServicePct(Number(qr.qr_service_charge_pct) || 0);
              }
            } catch { /* columns not migrated yet — defaults stand */ }
            // v5.5.149: open-tab guardrail settings — separate defensive
            // SELECT so missing columns from a partial migration don't
            // poison the rest of the page load.
            try {
              const { data: tab } = await platformSupabase
                .from('locations')
                .select('qr_tab_pre_auth_amount, qr_tab_warning_message, qr_tab_left_open_surcharge_pct, qr_tab_left_open_surcharge_fixed, qr_tab_force_close_after_minutes')
                .eq('id', r.id).maybeSingle();
              if (tab) {
                if (tab.qr_tab_pre_auth_amount != null) setQrTabPreAuth(Number(tab.qr_tab_pre_auth_amount));
                if (tab.qr_tab_warning_message)         setQrTabWarning(tab.qr_tab_warning_message);
                if (tab.qr_tab_left_open_surcharge_pct != null)   setQrTabSurchargePct(Number(tab.qr_tab_left_open_surcharge_pct));
                if (tab.qr_tab_left_open_surcharge_fixed != null) setQrTabSurchargeFixed(Number(tab.qr_tab_left_open_surcharge_fixed));
                if (tab.qr_tab_force_close_after_minutes != null) setQrTabForceCloseMin(Number(tab.qr_tab_force_close_after_minutes));
              }
            } catch { /* columns not migrated — defaults stand */ }
            // Multi-site group ordering link — when this venue's company has more
            // than one location, surface the one-link-for-the-group landing page
            // (/order/<companies.slug>) for copying. Defensive: any failure just
            // hides the card.
            try {
              if (r.company_id) {
                const [{ data: co }, { count }] = await Promise.all([
                  platformSupabase.from('companies').select('id, name, slug').eq('id', r.company_id).maybeSingle(),
                  platformSupabase.from('locations').select('id', { count: 'exact', head: true }).eq('company_id', r.company_id),
                ]);
                if (alive && co?.slug && (count || 0) > 1) setGroup({ slug: co.slug, name: co.name, count });
              }
            } catch { /* group link is optional */ }
          }
        }
        // v5.5.147/148/152: load floor-plan tables. floor_tables schema is
        // (id, location_id, label, x, y, w, h, shape, max_covers, section,
        // sort_order) — there is NO parent_id column, so v5.5.148 silently
        // failed the SELECT and left the QR table list empty. Now selecting
        // only columns we know exist.
        if (opsLocId && supabase) {
          const { data: rows, error: tErr } = await supabase
            .from('floor_tables')
            .select('id, label, sort_order')
            .eq('location_id', opsLocId)
            .order('sort_order');
          if (tErr) {
            console.warn('[OnlineOrdering] floor_tables load:', tErr.message);
          } else if (alive && rows?.length) {
            // v5.5.161: keep `label` nullable so we can DETECT auto-named
            // tables (no friendly label set in Floor Plan) and warn the
            // operator. The auto-generated `id` looks like `t-1776905944421`
            // which makes for a horrid QR URL like `/?t=t-1776905944421`
            // and an even worse "Table t-1776905944421" header on the QR
            // confirm screen. Customers expect to see "Table T4" or "Table 5".
            setTables(rows.map(t => {
              const rawLabel = t.label || '';
              const looksAutoNamed = !rawLabel || rawLabel === t.id || /^t-\d+$/i.test(rawLabel);
              return { id: t.id, label: looksAutoNamed ? null : rawLabel, isUnlabeled: looksAutoNamed };
            }));
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
    if (!platformSupabase || !row || !opsLocId) {
      setError('No platform location loaded — open Location Settings first.');
      return;
    }
    setSaving(true); setError(''); setSaved(false);

    // v5.5.744: branding (logo / colours / header / background) is now edited ONLY in Menu appearance,
    // so the two screens can no longer clobber each other's online_branding. This screen keeps the
    // operational settings and deliberately does NOT write online_branding.
    // All three writes below go through the location-admin edge fn (service_role);
    // the browser no longer holds UPDATE on platform.locations. The fn resolves the
    // platform row from the ops id, so we pass opsLocId, not row.id.
    const { data, error: err } = await saveLocation(opsLocId, {
      online_menu_id:             menuId || null,
      online_collection_lead_min: Math.max(0, parseInt(leadMin, 10) || 0),
      online_delivery_enabled:    !!deliveryOn,
    });

    // v5.5.153: QR settings save now SURFACES errors to the BO UI instead
    // of silently swallowing them. Most common cause was the column
    // migration not having been run — settings appeared to save but the
    // customer surface kept reading defaults. Operator now sees a clear
    // "Run this SQL" message instead of a silent no-op.
    const qrCoreUpd = await saveLocation(opsLocId, {
      qr_payment_mode: qrPaymentMode,
      qr_table_mode: qrTableMode,
      qr_service_charge_pct: Math.max(0, Math.min(50, Number(qrServicePct) || 0)),
    });
    if (qrCoreUpd.error || !qrCoreUpd.data) {
      const msg = qrCoreUpd.error?.message || 'the platform DB returned no row';
      if (msg.includes('column') && msg.includes('schema')) {
        setError('QR settings can\'t save — DB migration missing. Run the SQL from the v5.5.151 changelog (qr_payment_mode / qr_table_mode / qr_service_charge_pct columns).');
      } else {
        setError('QR settings save failed: ' + msg);
      }
      setSaving(false);
      return;
    }
    const qrTabUpd = await saveLocation(opsLocId, {
      qr_tab_pre_auth_amount:           Math.max(0, Number(qrTabPreAuth) || 0),
      qr_tab_warning_message:           (qrTabWarning || '').trim() || null,
      qr_tab_left_open_surcharge_pct:   Math.max(0, Math.min(50, Number(qrTabSurchargePct) || 0)),
      qr_tab_left_open_surcharge_fixed: Math.max(0, Number(qrTabSurchargeFixed) || 0),
      qr_tab_force_close_after_minutes: Math.max(0, parseInt(qrTabForceCloseMin, 10) || 0),
    });
    if (qrTabUpd.error || !qrTabUpd.data) {
      const msg = qrTabUpd.error?.message || 'the platform DB returned no row';
      if (msg.includes('column') && msg.includes('schema')) {
        setError('Open-tab settings can\'t save — DB migration missing. Run the SQL from the v5.5.151 changelog (qr_tab_* columns).');
      } else {
        setError('Open-tab settings save failed: ' + msg);
      }
      setSaving(false);
      return;
    }

    setSaving(false);
    if (err) { setError(err.message || 'Save failed'); return; }
    if (!data) { setError('Update returned 0 rows — reload this page, the venue record may have moved.'); return; }

    // Sync local state to what was actually persisted. Branding is only re-synced
    // when the echo carries it — this screen never writes it, and blanking the
    // local copy would wipe the preview.
    if (data.online_branding) setBranding({ ...BLANK_BRANDING, ...data.online_branding });
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
  const giftUrl   = slug ? `https://${slug}.${ROOT}/gift` : null;
  const portalUrl = slug ? `https://${slug}.${ROOT}/account` : null;
  const previewOnline = customerUrl(slug, '') || null;
  const previewQr     = customerUrl(slug, '/t/t1') || null;
  const previewGift   = customerUrl(slug, '/gift') || null;
  const previewPortal = customerUrl(slug, '/account') || null;

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
        <StatusPill title="🎁 Gift cards" enabled={giftOn} url={giftUrl} preview={previewGift}/>
        <StatusPill title="⭐ Loyalty portal" enabled={loyaltyOn} url={portalUrl} preview={previewPortal}/>
      </div>

      {/* Multi-site group ordering link — one link for the whole group */}
      {group && <GroupLinkCard group={group} />}

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

      {/* Branding — consolidated into Menu appearance (v5.5.744) */}
      <div style={S.card}>
        <div style={S.h2}>🎨 Branding</div>
        <div style={S.desc}>
          Your logo, colours, header style, header photo and page background for the online ordering &amp;
          catering pages are all set in <b>one place now — Back office → Menu appearance</b>, with a live
          preview. This screen no longer edits branding, so the two can’t overwrite each other. (The kiosk
          is still branded separately in Kiosk settings.)
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
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>Show Delivery alongside Collection at checkout. The delivery fee + fulfilment (self-delivery, or a courier) are set in <b>Channels → Delivery</b> — the fee is added to the customer's total automatically.</div>
          </div>
          <Toggle on={deliveryOn} onChange={setDeliveryOn}/>
        </div>
      </div>

      {/* v5.5.147/149: QR ordering settings + per-table QR-code generator */}
      <QrSettingsBlock
        slug={row?.online_slug}
        paymentMode={qrPaymentMode} setPaymentMode={setQrPaymentMode}
        tableMode={qrTableMode} setTableMode={setQrTableMode}
        servicePct={qrServicePct} setServicePct={setQrServicePct}
        tabPreAuth={qrTabPreAuth} setTabPreAuth={setQrTabPreAuth}
        tabWarning={qrTabWarning} setTabWarning={setQrTabWarning}
        tabSurchargePct={qrTabSurchargePct} setTabSurchargePct={setQrTabSurchargePct}
        tabSurchargeFixed={qrTabSurchargeFixed} setTabSurchargeFixed={setQrTabSurchargeFixed}
        tabForceCloseMin={qrTabForceCloseMin} setTabForceCloseMin={setQrTabForceCloseMin}
        tables={tables}
        downloading={downloading} setDownloading={setDownloading}/>

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
// v5.5.147: QR settings + per-table QR-code generator. JPEG output is composed
// in a canvas: QR code on top, big "TABLE T5" label below, venue name footer.
// Each click downloads a single labelled JPEG; "Download all" loops through
// every table sequentially (browser handles each download as separate file).
function QrSettingsBlock({
  slug,
  paymentMode, setPaymentMode,
  tableMode, setTableMode,
  servicePct, setServicePct,
  tabPreAuth, setTabPreAuth,
  tabWarning, setTabWarning,
  tabSurchargePct, setTabSurchargePct,
  tabSurchargeFixed, setTabSurchargeFixed,
  tabForceCloseMin, setTabForceCloseMin,
  tables, downloading, setDownloading,
}) {
  const showsTabSettings = paymentMode === 'open_tab' || paymentMode === 'both';
  const buildQrUrl = (table) => {
    // v5.5.753: delegate to customerUrl so the printed table QR uses the pretty
    // subdomain form when the app is on the customer domain, and a working
    // same-origin ?loc= link on any other host (e.g. a Vercel preview) — never a
    // dead <slug>.serv-os.app link that only resolves once wildcard DNS is wired.
    if (tableMode === 'free') return customerUrl(slug, '/t/free');
    const t = table || {};
    const tParam = t.label || t.id || '';
    return customerUrl(slug, `/t/${encodeURIComponent(tParam)}`);
  };

  const downloadOne = async (table) => {
    const url = buildQrUrl(table);
    // Render QR to a canvas, then composite a label + footer into a larger
    // canvas, export as JPEG, trigger download.
    const qrCanvas = document.createElement('canvas');
    await QRCode.toCanvas(qrCanvas, url, { width: 720, margin: 2, errorCorrectionLevel: 'M' });
    const W = 800, H = 1000;
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    // White background — easier to print
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    // QR centered
    ctx.drawImage(qrCanvas, (W - 720) / 2, 60, 720, 720);
    // Label
    ctx.fillStyle = '#000';
    ctx.font = '700 28px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('SCAN TO ORDER', W / 2, 830);
    ctx.font = '900 84px -apple-system, system-ui, sans-serif';
    ctx.fillText(`Table ${table.label || table.id || '?'}`, W / 2, 920);
    ctx.font = '500 18px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = '#666';
    ctx.fillText(slug ? `${slug}.${CUSTOMER_ROOT}` : CUSTOMER_ROOT, W / 2, 970);
    // JPEG download
    out.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `qr-table-${(table.label || table.id || 'unknown').toString().replace(/[^a-z0-9-]+/gi, '_')}.jpg`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/jpeg', 0.92);
  };

  const downloadAll = async () => {
    setDownloading(true);
    try {
      for (const t of tables) {
        // Slight delay between downloads so the browser doesn't block them
        // as a "multiple files" dialog.
        // eslint-disable-next-line no-await-in-loop
        await downloadOne(t);
        // eslint-disable-next-line no-await-in-loop
        await new Promise(r => setTimeout(r, 250));
      }
    } finally { setDownloading(false); }
  };

  const radioStyle = (active) => ({
    flex: 1, padding: '8px 10px', borderRadius: 8, fontFamily: 'inherit',
    background: active ? 'var(--acc-d)' : 'var(--bg2)',
    color: active ? 'var(--acc)' : 'var(--t2)',
    border: `1px solid ${active ? 'var(--acc-b)' : 'var(--bdr2)'}`,
    fontSize: 12, fontWeight: 700, cursor: 'pointer', textAlign: 'center',
  });

  return (
    <div style={{ ...S.card, boxSizing: 'border-box', maxWidth: '100%', overflow: 'hidden' }}>
      <h3 style={S.h2}>QR ordering</h3>
      <div style={{ fontSize: 12, color: 'var(--t4)', marginBottom: 14, lineHeight: 1.5 }}>
        Settings + downloadable QR codes for table-side ordering. Print one per table or stick on table tents.
      </div>

      {/* Payment mode — flex-wrap so long labels don't push the card wider
          than its container (which would push the hero banner upload
          button off-screen on narrow viewports). */}
      <div style={{ marginBottom: 14 }}>
        <div style={S.label}>Payment</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button onClick={() => setPaymentMode('pay_now')}  style={radioStyle(paymentMode === 'pay_now')}>💳 Pay now</button>
          <button onClick={() => setPaymentMode('open_tab')} style={radioStyle(paymentMode === 'open_tab')}>📋 Open tab</button>
          <button onClick={() => setPaymentMode('both')}     style={radioStyle(paymentMode === 'both')}>Both</button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 6, lineHeight: 1.5 }}>
          Pay-now charges immediately. Open-tab pre-authorises the card and bills at end (lands in commit 3).
        </div>
      </div>

      {/* Table mode */}
      <div style={{ marginBottom: 14 }}>
        <div style={S.label}>Table identification</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button onClick={() => setTableMode('fixed')}   style={radioStyle(tableMode === 'fixed')}>🔒 Fixed</button>
          <button onClick={() => setTableMode('confirm')} style={radioStyle(tableMode === 'confirm')}>✅ Confirm</button>
          <button onClick={() => setTableMode('free')}    style={radioStyle(tableMode === 'free')}>✏️ Free-type</button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 6, lineHeight: 1.5 }}>
          {tableMode === 'fixed' && 'QR locks the table — customer can\'t change it.'}
          {tableMode === 'confirm' && '"You\'re at Table 5? Yes / Change" before menu loads — recommended.'}
          {tableMode === 'free' && 'QR encodes no table — customer types their number on first screen.'}
        </div>
      </div>

      {/* Service charge */}
      <Field
        label="Service charge %"
        type="number" min="0"
        value={servicePct}
        onChange={v => setServicePct(parseFloat(v) || 0)}
        help="Auto-applied to every QR order. 0 = none. Capped at 50%."/>

      {/* v5.5.149: open-tab guardrails — only relevant when tabs are allowed */}
      {showsTabSettings && (
        <div style={{ marginTop: 18, padding: 14, background: 'var(--bg2)', border: '1px dashed var(--bdr)', borderRadius: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t1)', marginBottom: 8 }}>Open-tab guardrails</div>
          <div style={{ fontSize: 11, color: 'var(--t4)', lineHeight: 1.5, marginBottom: 12 }}>
            How tabs behave when a customer opens one and walks away. The customer sees the warning message + your surcharge policy on the QR checkout before they commit.
          </div>

          <Field
            label="Pre-authorisation hold (£)"
            type="number" min="0"
            value={tabPreAuth}
            onChange={v => setTabPreAuth(parseFloat(v) || 0)}
            help="Amount Stripe holds on the card when the tab opens. Higher = covers more. Released or captured at close. Default £100."/>

          <div style={{ marginTop: 12 }}>
            <div style={S.label}>Customer warning message</div>
            <textarea value={tabWarning} onChange={e => setTabWarning(e.target.value)}
              rows={2} placeholder="e.g. ⚠ Tabs left open at close incur a 10% surcharge."
              style={{ ...S.input, resize: 'vertical', minHeight: 56, fontFamily: 'inherit' }}/>
            <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 4 }}>
              Shown next to the "Open tab" option on the QR checkout. Plain text — no HTML.
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
            <Field
              label="Left-open surcharge %"
              type="number" min="0"
              value={tabSurchargePct}
              onChange={v => setTabSurchargePct(parseFloat(v) || 0)}
              help="0 = none. Applied on top of the bill if force-closed."/>
            <Field
              label="Left-open surcharge (£ flat)"
              type="number" min="0"
              value={tabSurchargeFixed}
              onChange={v => setTabSurchargeFixed(parseFloat(v) || 0)}
              help="Fixed-£ alternative or in addition to %."/>
          </div>

          <div style={{ marginTop: 12 }}>
            <Field
              label="Auto force-close after (minutes)"
              type="number" min="0"
              value={tabForceCloseMin}
              onChange={v => setTabForceCloseMin(parseInt(v, 10) || 0)}
              help="0 = manual only. If set, master device captures any tab past this age + applies the surcharge."/>
          </div>
        </div>
      )}

      {/* QR codes */}
      <div style={{ marginTop: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ ...S.label, marginBottom: 0 }}>QR codes ({tables.length} table{tables.length === 1 ? '' : 's'})</div>
          <button onClick={downloadAll} disabled={!tables.length || downloading || tableMode === 'free'}
            style={{ ...S.btn, background: 'var(--bg3)', color: 'var(--t1)', fontSize: 12, padding: '8px 14px',
              opacity: (!tables.length || downloading || tableMode === 'free') ? 0.4 : 1 }}>
            {downloading ? 'Downloading…' : '⬇ Download all'}
          </button>
        </div>
        {tableMode === 'free' && (
          <div style={{ fontSize: 12, color: 'var(--t4)', padding: 12, background: 'var(--bg2)', borderRadius: 8, border: '1px solid var(--bdr2)' }}>
            Free-type mode: a single generic QR is enough — customers type their table number on arrival. <button onClick={() => downloadOne({ id: '', label: 'Generic' })} style={{ background: 'none', border: 'none', color: 'var(--acc)', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit', padding: 0, fontSize: 12 }}>Download generic QR</button>
          </div>
        )}
        {tableMode !== 'free' && tables.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--t4)', padding: 16, background: 'var(--bg2)', borderRadius: 8, border: '1px dashed var(--bdr2)', textAlign: 'center' }}>
            No tables yet. Set them up in Floor Plan first.
          </div>
        )}
        {tableMode !== 'free' && tables.length > 0 && tables.some(t => t.isUnlabeled) && (
          <div style={{
            marginBottom:10, padding:'12px 14px', borderRadius:8,
            background:'#7c2d1220', border:'1px solid #f59e0b', color:'var(--t1)',
            fontSize:12, lineHeight:1.5,
          }}>
            <strong>⚠ {tables.filter(t => t.isUnlabeled).length} of {tables.length} tables have no label set.</strong>
            {' '}Their QR URLs will use the auto-generated id (e.g. <code>?t=t-1776905944421</code>) and customers will see "Table t-1776905944421" on the confirm screen.
            {' '}Open <strong>Floor Plan → click each table → set Label</strong> to "T4", "5", etc., then come back and re-download the QRs.
          </div>
        )}
        {tableMode !== 'free' && tables.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
            {tables.map(t => {
              const url = buildQrUrl(t);
              return (
                <div key={t.id} style={{
                  padding: '12px 10px', borderRadius: 8,
                  background: 'var(--bg2)', border: t.isUnlabeled ? '1px solid #f59e0b' : '1px solid var(--bdr2)',
                  display: 'flex', flexDirection: 'column', gap: 6,
                }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <span style={{ fontSize: 22 }}>📱</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color:'var(--t1)' }}>Table {t.label || '(no label)'}</span>
                    {t.isUnlabeled && <span style={{ fontSize:9, fontWeight:800, color:'#92400e', background:'#fde68a', padding:'2px 6px', borderRadius:6 }}>UNLABELED</span>}
                    <span style={{ marginLeft:'auto', fontSize:10, color:'var(--t4)', fontFamily:'var(--font-mono)' }}>id: {t.id.length > 12 ? t.id.slice(0,12)+'…' : t.id}</span>
                  </div>
                  <a href={url} target="_blank" rel="noopener" style={{
                    fontSize: 10, color:'var(--acc)', wordBreak:'break-all', textDecoration:'none',
                    fontFamily:'var(--font-mono)', lineHeight:1.4,
                  }}>{url}</a>
                  <div style={{ display:'flex', gap:6 }}>
                    <button onClick={() => downloadOne(t)} style={{
                      flex:1, padding:'6px 8px', borderRadius:6, fontSize:11, fontWeight:700,
                      background:'var(--acc)', color:'#0b0c10', border:'none', cursor:'pointer',
                    }}>⬇ JPEG</button>
                    <button onClick={() => { navigator.clipboard?.writeText(url); }} style={{
                      flex:1, padding:'6px 8px', borderRadius:6, fontSize:11, fontWeight:700,
                      background:'var(--bg3)', color:'var(--t2)', border:'1px solid var(--bdr2)', cursor:'pointer',
                    }}>📋 Copy URL</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// Multi-site group ordering link — read-only copy field. One link for the whole
// group: customers land on a branded venue picker (/order/<companies.slug>) and are
// handed to the chosen venue's existing ONLINE ordering URL. Catering is a separate
// face of the business with its own group link (see Channels → Catering ordering).
// A single online-enabled venue skips the picker and redirects straight in.
function GroupLinkCard({ group }) {
  const [copied, setCopied] = useState(false);
  const url = groupOrderUrl(group.slug);
  if (!url) return null;
  return (
    <div style={S.card}>
      <div style={S.h2}>🏢 Group ordering link</div>
      <div style={S.desc}>
        <b>{group.name}</b> has {group.count} locations. Put this ONE link on the group's website —
        customers pick their venue, then order online there (if only one venue has online ordering,
        they go straight in). Per-venue links above keep working as normal. The group <b>catering</b> link
        lives in Channels → Catering ordering.
      </div>
      <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
        <input readOnly value={url} onFocus={e => e.target.select()}
          style={{ ...S.input, flex:'1 1 260px', width:'auto', fontFamily:'var(--font-mono, monospace)', fontSize:12, color:'var(--t2)' }}/>
        <button onClick={() => { navigator.clipboard?.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
          style={{ ...S.btn, background:'var(--bg3)', color:'var(--t1)', border:'1px solid var(--bdr)' }}>
          {copied ? '✓ Copied' : '📋 Copy'}
        </button>
        <a href={url} target="_blank" rel="noopener"
          style={{ ...S.btn, background:'transparent', color:'var(--acc)', border:'1px solid var(--bdr)', textDecoration:'none', display:'inline-block' }}>
          Open ↗
        </a>
      </div>
    </div>
  );
}

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
        background: 'var(--bg2)', borderRadius: 10, border:'1px solid var(--bdr2)',
        padding: 8, display:'flex', alignItems:'center', gap:12,
      }}>
        {url ? (
          <img src={url} alt={label}
            style={{ width: previewWidth, height: previewHeight, objectFit:'cover', borderRadius:6, flexShrink:0, background: previewBg, border:'1px solid var(--bdr)' }}/>
        ) : (
          <div style={{
            width: previewWidth, height: previewHeight, borderRadius:6,
            background: 'var(--bg3)', border:'1px dashed var(--bdr)', display:'flex', alignItems:'center', justifyContent:'center',
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
