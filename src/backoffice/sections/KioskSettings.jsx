/**
* KioskSettings — v5.2.1
*
* Per-kiosk configuration page. Opens from KioskRegistry's 'Settings' button.
*
* What it edits (all on the kiosk's device_profiles row):
*   - Branding: name, primary color, accent color, bg color, logo, attract video
*   - Menu: which menu pinned (or null for schedule-driven)
*   - Operations: idle timeout, table mode, tip presets, loyalty enabled, allergen required
*   - Wait time: avg minutes shown to customer
*   - Hero banners: per-screen images (jsonb array)
*
* File uploads go to the kiosk-assets Supabase Storage bucket (public).
*/

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase, getLocationId } from '../../lib/supabase';
import { CATEGORY_PHOTO_COPY } from '../../lib/categoryPhoto';
import { KIOSK_NEW_DESIGN_READY } from '../../lib/kioskFlow';
import { kioskPrimary, kioskPalette, parseCssColor, contrastWithWhite, DESIGN_GREEN, OLD_DEFAULT_BRAND } from '../../lib/kioskTheme';
import KioskTipping from './KioskTipping';

// v5.8.76 (Peter, 15 Sep 2026): one eat in mode per kiosk, in plain words, the same for both kiosk
// designs. The stored values are unchanged (lib/kioskFlow.js kioskStartModel explains each).
const TABLE_MODES = [
  { v: 'either',   label: 'Table plan',          desc: 'Customers pick their table on the table plan. If no tables are set up, they type the number.' },
  { v: 'enter',    label: 'Type a table number', desc: 'Customers type their table number.' },
  { v: 'dispense', label: 'Flag number',         desc: 'Customers take a numbered flag and type its number. It shows as the table number, so staff take the meal to that flag.' },
  { v: 'none',     label: 'Take away only',      desc: 'No eat in option.' },
];
const TABLE_MODES_V2 = TABLE_MODES;

export default function KioskSettings({ kioskId, onBack }) {
  const [device, setDevice] = useState(null);
  const [profile, setProfile] = useState(null);
  const [menus, setMenus] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [uploadingFor, setUploadingFor] = useState(null); // 'logo' | 'video' | banner index

  // Local-state copy of profile fields (edits buffered)
  const [draft, setDraft] = useState({});
  // v5.7.9: record which fields THIS session actually changed (every edit funnels
  // through setField). save() only writes menu_id when the operator used the menu
  // picker here, so a kiosk settings tab left open all day can never revert a menu
  // pin that was changed elsewhere with its stale loaded value.
  const touchedRef = useRef(new Set());
  const setField = (k, v) => { touchedRef.current.add(k); setDraft(prev => Object.assign({}, prev, { [k]: v })); };

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const locId = await getLocationId();
      const { data: dev, error: e1 } = await supabase
        .from('devices').select('*').eq('id', kioskId).maybeSingle();
      if (e1) throw e1;
      if (!dev) throw new Error('Kiosk not found');
      setDevice(dev);

      if (dev.profile_id) {
        const { data: prof, error: e2 } = await supabase
          .from('device_profiles').select('*').eq('id', dev.profile_id).maybeSingle();
        if (e2) throw e2;
        setProfile(prof);
        touchedRef.current.clear(); // draft reseeded from DB truth
        setDraft({
          kiosk_brand_name:        prof?.kiosk_brand_name        ?? '',
          kiosk_brand_color:       prof?.kiosk_brand_color       ?? '#f97316',
          kiosk_brand_accent_color:prof?.kiosk_brand_accent_color?? '#fbbf24',
          kiosk_brand_bg_color:    prof?.kiosk_brand_bg_color    ?? '#0e0e10',
          kiosk_brand_logo_url:    prof?.kiosk_brand_logo_url    ?? '',
          kiosk_attract_video_url: prof?.kiosk_attract_video_url ?? '',
          kiosk_theme_mode:        prof?.kiosk_theme_mode        ?? 'dark',
          kiosk_label_tap_to_order:  prof?.kiosk_label_tap_to_order  ?? '',
          kiosk_label_place_order:   prof?.kiosk_label_place_order   ?? '',
          kiosk_label_add_to_order:  prof?.kiosk_label_add_to_order  ?? '',
          menu_id:                 prof?.menu_id                 ?? null,
          kiosk_idle_timeout_sec:  prof?.kiosk_idle_timeout_sec  ?? 60,
          kiosk_table_mode:        prof?.kiosk_table_mode        ?? 'either',
          kiosk_tip_presets:       prof?.kiosk_tip_presets       ?? [10, 12.5, 15],
          kiosk_loyalty_enabled:   prof?.kiosk_loyalty_enabled   ?? true,
          kiosk_allergen_required: prof?.kiosk_allergen_required ?? false,
          kiosk_avg_wait_minutes:  prof?.kiosk_avg_wait_minutes  ?? 8,
          kiosk_banners:           prof?.kiosk_banners           ?? [],
          kiosk_category_photos:   prof?.kiosk_category_photos   ?? true,
          kiosk_new_design:        prof?.kiosk_new_design        ?? false,
          kiosk_sms_enabled:       prof?.kiosk_sms_enabled       ?? false,
        });
      }

      const { data: menusData } = await supabase
        .from('menus').select('id, name').eq('location_id', locId).order('name');
      setMenus(menusData || []);
    } catch (e) {
      setError(e?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [kioskId]);

  useEffect(() => { load(); }, [load]);

  // v5.8.65: the category photo switch exists only once the 20260914 migration has
  // run. The loaded row is select('*'), so the key is present exactly when the column is.
  const photoSwitchReady = !!profile && Object.prototype.hasOwnProperty.call(profile, 'kiosk_category_photos');
  // The new kiosk design switch and the ready text switch exist only once
  // 20260915_OPS_kiosk_redesign.sql has run, and the design switch only in a build whose new
  // design is finished (KIOSK_NEW_DESIGN_READY). Until then neither shows and neither is sent.
  const designColumn = !!profile && Object.prototype.hasOwnProperty.call(profile, 'kiosk_new_design');
  const designReady = KIOSK_NEW_DESIGN_READY && designColumn;
  const smsReady = !!profile && Object.prototype.hasOwnProperty.call(profile, 'kiosk_sms_enabled');
  // The page shows the new design's settings only while this profile uses it.
  const v2 = designReady && draft.kiosk_new_design === true;

  // ─── Save handler ───
  const save = async () => {
    if (!profile) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const patch = {
        kiosk_brand_name:        draft.kiosk_brand_name        || null,
        kiosk_brand_color:       draft.kiosk_brand_color       || null,
        kiosk_brand_accent_color:draft.kiosk_brand_accent_color|| null,
        kiosk_brand_bg_color:    draft.kiosk_brand_bg_color    || null,
        kiosk_brand_logo_url:    draft.kiosk_brand_logo_url    || null,
        kiosk_attract_video_url: draft.kiosk_attract_video_url || null,
        kiosk_theme_mode:        draft.kiosk_theme_mode        || 'dark',
        kiosk_label_tap_to_order:  draft.kiosk_label_tap_to_order || null,
        kiosk_label_place_order:   draft.kiosk_label_place_order  || null,
        kiosk_label_add_to_order:  draft.kiosk_label_add_to_order || null,
        menu_id:                 draft.menu_id                 || null,
        kiosk_idle_timeout_sec:  draft.kiosk_idle_timeout_sec  ?? 60,
        kiosk_table_mode:        draft.kiosk_table_mode        || 'either',
        kiosk_tip_presets:       draft.kiosk_tip_presets       || [10, 12.5, 15],
        kiosk_loyalty_enabled:   !!draft.kiosk_loyalty_enabled,
        kiosk_allergen_required: !!draft.kiosk_allergen_required,
        kiosk_avg_wait_minutes:  draft.kiosk_avg_wait_minutes  ?? 8,
        kiosk_banners:           draft.kiosk_banners           || [],
        kiosk_category_photos:   draft.kiosk_category_photos !== false,
        kiosk_new_design:        draft.kiosk_new_design === true,
        kiosk_sms_enabled:       draft.kiosk_sms_enabled === true,
      };
      // v5.7.9: an omitted column keeps its DB value, so a stale tab saving a
      // branding tweak can never clobber the kiosk's menu pin.
      if (!touchedRef.current.has('menu_id')) delete patch.menu_id;
      // v5.8.65: same touched-only rule for the category photo switch, and never sent
      // before the migration adds the column (PGRST204 would fail the whole save).
      if (!photoSwitchReady || !touchedRef.current.has('kiosk_category_photos')) delete patch.kiosk_category_photos;
      // Same rule for the new design switches: only when the column exists and was changed here.
      if (!designReady || !touchedRef.current.has('kiosk_new_design')) delete patch.kiosk_new_design;
      if (!smsReady || !touchedRef.current.has('kiosk_sms_enabled')) delete patch.kiosk_sms_enabled;
      const { error } = await supabase.from('device_profiles').update(patch).eq('id', profile.id);
      if (error) throw error;
      setSuccess('Saved. Refresh the kiosk to see changes.');
      setTimeout(() => setSuccess(null), 3000);
      await load();
    } catch (e) {
      setError(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // ─── File upload helpers ───
  const uploadFile = async (file, slot) => {
    setUploadingFor(slot);
    setError(null);
    try {
      const ext = file.name.split('.').pop()?.toLowerCase() || 'bin';
      const path = `${profile.id}/${slot}-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from('kiosk-assets').upload(path, file, { cacheControl: '3600', upsert: true });
      if (error) throw error;
      const { data } = supabase.storage.from('kiosk-assets').getPublicUrl(path);
      return data.publicUrl;
    } catch (e) {
      setError(e?.message || 'Upload failed');
      return null;
    } finally {
      setUploadingFor(null);
    }
  };

  const onLogoUpload = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const url = await uploadFile(f, 'logo');
    if (url) setField('kiosk_brand_logo_url', url);
    e.target.value = '';
  };

  const onVideoUpload = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    // Browser-incompatible formats — fail fast with a clear message.
    const name = f.name.toLowerCase();
    if (name.endsWith('.mov') || name.endsWith('.avi') || name.endsWith('.mkv') || name.endsWith('.wmv')) {
      setError('Video must be MP4 (H.264). Convert ' + f.name + ' first — most browsers (Chrome, Firefox, Android) can\'t play .mov / .avi / .mkv files.');
      e.target.value = '';
      return;
    }
    const url = await uploadFile(f, 'video');
    if (url) setField('kiosk_attract_video_url', url);
    e.target.value = '';
  };

  const onBannerUpload = async (e, idx) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const url = await uploadFile(f, `banner${idx}`);
    if (url) {
      const banners = [...(draft.kiosk_banners || [])];
      banners[idx] = Object.assign({}, banners[idx], { imageUrl: url });
      setField('kiosk_banners', banners);
    }
    e.target.value = '';
  };

  const addBanner = () => {
    setField('kiosk_banners', [...(draft.kiosk_banners || []), { screen: 'menu', imageUrl: '', label: '' }]);
  };
  const removeBanner = (idx) => {
    setField('kiosk_banners', (draft.kiosk_banners || []).filter((_, i) => i !== idx));
  };
  const updateBanner = (idx, k, v) => {
    const banners = [...(draft.kiosk_banners || [])];
    banners[idx] = Object.assign({}, banners[idx], { [k]: v });
    setField('kiosk_banners', banners);
  };

  // ─── Tip presets editing ───
  const updateTip = (idx, val) => {
    const presets = [...(draft.kiosk_tip_presets || [])];
    presets[idx] = parseFloat(val) || 0;
    setField('kiosk_tip_presets', presets);
  };

  // ─── Render ───
  if (loading) return <div style={{ padding: 40, color: 'var(--t3)', textAlign: 'center' }}>Loading…</div>;
  if (!device || !profile) return <div style={{ padding: 40, color: 'var(--t3)', textAlign: 'center' }}>Kiosk or profile not found.</div>;

  return (
    <div style={{ position: 'absolute', inset: 0, overflowY: 'auto', overflowX: 'hidden' }}><div style={{ padding: 24, maxWidth: 880, margin: '0 auto', fontFamily: 'inherit', color: 'var(--t1)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <button onClick={onBack} style={btnGhost()}>← Back</button>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 2 }}>Kiosk settings</h1>
          <p style={{ fontSize: 12.5, color: 'var(--t3)' }}>{device.name} · profile: {profile.name}</p>
        </div>
        <button onClick={save} disabled={saving} style={btnPrimary(saving)}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      {error && <div style={alertStyle('error')}>{error}</div>}
      {success && <div style={alertStyle('success')}>{success}</div>}

      {/* Live preview */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 24, marginTop: 8 }}>
        {/* LEFT — settings */}
        <div>

          {/* ── New kiosk design switch (visible only in a build whose new design is finished) ── */}
          {KIOSK_NEW_DESIGN_READY ? (
            <SectionLg title="Kiosk design">
              {designColumn ? (
                <>
                  <LargeToggleRow
                    checked={draft.kiosk_new_design === true}
                    onChange={v => setField('kiosk_new_design', v)}
                    title="New kiosk design"
                    desc="A cream and green look with five steps: start, menu, review and pay, card and done. Turn it off to go back to the current kiosk."
                  />
                  <div style={{ fontSize: 15, color: 'var(--t3)', lineHeight: 1.45 }}>Refresh the kiosk after you save.</div>
                </>
              ) : (
                <div style={{ fontSize: 15, color: 'var(--t3)', lineHeight: 1.45 }}>The new kiosk design needs a database update before this switch appears.</div>
              )}
            </SectionLg>
          ) : null}

          {v2 ? (
            <SectionLg title="Look" desc="How the new kiosk design looks at this kiosk.">
              <div style={{ fontSize: 15, color: 'var(--t3)', lineHeight: 1.45, marginBottom: 14 }}>The new design always uses the cream look. The light or dark theme setting only applies to the current design.</div>
              <FieldLg label="Main colour" hint="Buttons and highlights use this colour. Leave it on the design green if you have no brand colour. The old default orange (#f97316) shows as the design green, so for that orange pick a shade one step away, for example #f97416.">
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span aria-hidden="true" style={{ width: 40, height: 40, borderRadius: 10, background: kioskPrimary(draft), border: '1px solid var(--bdr)', flexShrink: 0 }} />
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 6, padding: 4, width: 220 }}>
                    <input type="color" aria-label="Main colour" value={lookColourShown(draft)} onChange={e => setField('kiosk_brand_color', e.target.value)}
                      style={{ width: 32, height: 32, border: 0, padding: 0, background: 'transparent', cursor: 'pointer' }} />
                    <input type="text" aria-label="Main colour code" value={lookColourText(draft)} onChange={e => setField('kiosk_brand_color', e.target.value)}
                      style={{ flex: 1, background: 'transparent', border: 0, color: 'var(--t1)', fontSize: 15, fontFamily: 'ui-monospace, monospace', outline: 'none', minWidth: 0 }} />
                  </div>
                  <button type="button" onClick={() => setField('kiosk_brand_color', DESIGN_GREEN)} style={Object.assign({}, btnGhost(), { fontSize: 15 })}>Use the design green</button>
                </div>
                {lookColourIsLight(draft) ? (
                  <div style={{ fontSize: 15, color: 'var(--t2)', marginTop: 8, lineHeight: 1.45 }}>This colour is very light. Text and highlights will use a darker shade so customers can read them.</div>
                ) : null}
              </FieldLg>
              <FieldLg label="Brand name" hint="Shown when there is no logo.">
                <input value={draft.kiosk_brand_name || ''} onChange={e => setField('kiosk_brand_name', e.target.value)} placeholder={device.name} style={Object.assign({}, inp(), { fontSize: 15 })} />
              </FieldLg>
              <FieldLg label="Logo" hint="Shown at the top of the start screen. A square PNG works best.">
                <FileSlot
                  currentUrl={draft.kiosk_brand_logo_url}
                  onUpload={onLogoUpload}
                  onClear={() => setField('kiosk_brand_logo_url', '')}
                  accept="image/*"
                  uploading={uploadingFor === 'logo'}
                  kind="image"
                />
              </FieldLg>
              <FieldLg label="Attract video" hint="Plays on the tap to start screen. Use an MP4 file up to 30MB. It plays without sound.">
                <FileSlot
                  currentUrl={draft.kiosk_attract_video_url}
                  onUpload={onVideoUpload}
                  onClear={() => setField('kiosk_attract_video_url', '')}
                  accept="video/mp4"
                  uploading={uploadingFor === 'video'}
                  kind="video"
                />
              </FieldLg>
            </SectionLg>
          ) : null}

          {/* ── Theme + button labels ── */}
          {!v2 && <Section title="Theme & wording" desc="Pick light or dark surface. Customise key buttons with your brand voice.">
            <Field label="Theme" hint="Dark = white text on dark bg. Light = dark text on light bg. Brand colours still apply on top.">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {[
                  { v: 'dark',  label: 'Dark',  desc: 'White text, dark surface' },
                  { v: 'light', label: 'Light', desc: 'Dark text, light surface' },
                ].map(opt => (
                  <button key={opt.v} onClick={() => setField('kiosk_theme_mode', opt.v)} style={{
                    background: opt.v === 'dark' ? '#0e0e10' : '#fafafa',
                    color:      opt.v === 'dark' ? '#fff'    : '#111',
                    border: '2px solid ' + (draft.kiosk_theme_mode === opt.v ? 'var(--acc)' : 'var(--bdr)'),
                    borderRadius: 10, padding: '14px 12px', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                  }}>
                    <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>{opt.label}</div>
                    <div style={{ fontSize: 11, opacity: 0.7 }}>{opt.desc}</div>
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Attract screen CTA" hint="Default: TAP TO ORDER">
              <input value={draft.kiosk_label_tap_to_order || ''} onChange={e => setField('kiosk_label_tap_to_order', e.target.value)} placeholder="TAP TO ORDER" maxLength={24} style={inp()} />
            </Field>
            <Field label="Add to order button" hint="Default: Add to order">
              <input value={draft.kiosk_label_add_to_order || ''} onChange={e => setField('kiosk_label_add_to_order', e.target.value)} placeholder="Add to order" maxLength={24} style={inp()} />
            </Field>
            <Field label="Place order button" hint="Default: Place order. Shown after loyalty step.">
              <input value={draft.kiosk_label_place_order || ''} onChange={e => setField('kiosk_label_place_order', e.target.value)} placeholder="Place order" maxLength={24} style={inp()} />
            </Field>
          </Section>}

          {/* ── Branding ── */}
          {!v2 && <Section title="Brand" desc="This is the customer's first impression. Make it count.">
            <Field label="Brand name" hint="Shown on the attract screen">
              <input value={draft.kiosk_brand_name || ''} onChange={e => setField('kiosk_brand_name', e.target.value)} placeholder={device.name} style={inp()} />
            </Field>

            <Field label="Brand colours" hint="Primary drives buttons + accents · Accent is highlights · Background is the dark base">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                <ColorPicker label="Primary"   value={draft.kiosk_brand_color}        onChange={v => setField('kiosk_brand_color', v)} />
                <ColorPicker label="Accent"    value={draft.kiosk_brand_accent_color} onChange={v => setField('kiosk_brand_accent_color', v)} />
                <ColorPicker label="Background" value={draft.kiosk_brand_bg_color}    onChange={v => setField('kiosk_brand_bg_color', v)} />
              </div>
            </Field>

            <Field label="Logo" hint="PNG with transparent background works best · max 2MB">
              <FileSlot
                currentUrl={draft.kiosk_brand_logo_url}
                onUpload={onLogoUpload}
                onClear={() => setField('kiosk_brand_logo_url', '')}
                accept="image/*"
                uploading={uploadingFor === 'logo'}
                kind="image"
              />
            </Field>

            <Field label="Attract video" hint="⚠ MUST be MP4 (H.264). iPhone .mov files won't play in browsers · max 30MB · silent">
              <FileSlot
                currentUrl={draft.kiosk_attract_video_url}
                onUpload={onVideoUpload}
                onClear={() => setField('kiosk_attract_video_url', '')}
                accept="video/mp4"
                uploading={uploadingFor === 'video'}
                kind="video"
              />
            </Field>
          </Section>}

          {/* ── Hero banners ── */}
          {v2 ? (
            <SectionLg title="Hero banners">
              <div style={{ fontSize: 15, color: 'var(--t3)', lineHeight: 1.45 }}>Banners and button wording are not used by the new kiosk design.</div>
            </SectionLg>
          ) : <Section title="Hero banners" desc="Promo images that appear at the top of menu screens. Optional.">
            {(draft.kiosk_banners || []).length === 0 && (
              <div style={{ padding: 18, fontSize: 12.5, color: 'var(--t3)', textAlign: 'center', background: 'var(--bg2)', borderRadius: 8, border: '1px dashed var(--bdr)' }}>No banners yet.</div>
            )}
            {(draft.kiosk_banners || []).map((b, idx) => (
              <div key={idx} style={{ display: 'grid', gridTemplateColumns: '120px 1fr auto', gap: 10, marginBottom: 10, alignItems: 'center', background: 'var(--bg2)', padding: 10, borderRadius: 8 }}>
                <FileSlot
                  currentUrl={b.imageUrl}
                  onUpload={(e) => onBannerUpload(e, idx)}
                  onClear={() => updateBanner(idx, 'imageUrl', '')}
                  accept="image/*"
                  uploading={uploadingFor === `banner${idx}`}
                  kind="image"
                  compact
                />
                <div>
                  <select value={b.screen || 'menu'} onChange={e => updateBanner(idx, 'screen', e.target.value)} style={Object.assign({}, inp(), { fontSize: 12, padding: '6px 8px', marginBottom: 6 })}>
                    <option value="attract">Attract screen</option>
                    <option value="menu">Menu screen</option>
                    <option value="done">Order-done screen</option>
                  </select>
                  <input value={b.label || ''} onChange={e => updateBanner(idx, 'label', e.target.value)} placeholder="Label (optional)" style={Object.assign({}, inp(), { fontSize: 12, padding: '6px 8px' })} />
                </div>
                <button onClick={() => removeBanner(idx)} style={btnGhostDanger()}>×</button>
              </div>
            ))}
            <button onClick={addBanner} style={Object.assign({}, btnGhost(), { width: '100%', borderStyle: 'dashed' })}>+ Add banner</button>
          </Section>}

          {/* ── Menu ── */}
          <Section title="Menu" desc="Which menu the kiosk shows. Leave on Auto for time-of-day to drive it (timed menus).">
            <Field label="Active menu">
              <select value={draft.menu_id || ''} onChange={e => setField('menu_id', e.target.value || null)} style={inp()}>
                <option value="">Auto (timed menus)</option>
                {menus.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </Field>
            {/* v5.8.65: category photos on the kiosk tiles, per profile */}
            {photoSwitchReady ? (
              <div>
                <LargeToggleRow
                  checked={draft.kiosk_category_photos !== false}
                  onChange={v => setField('kiosk_category_photos', v)}
                  title={CATEGORY_PHOTO_COPY.switchTitle}
                  desc={CATEGORY_PHOTO_COPY.switchDesc}
                />
                <div style={{ fontSize: 15, color: 'var(--t3)', lineHeight: 1.45 }}>{CATEGORY_PHOTO_COPY.switchOffNote}</div>
                <div style={{ fontSize: 15, color: 'var(--t3)', lineHeight: 1.45, marginTop: 4 }}>{CATEGORY_PHOTO_COPY.switchShared}</div>
              </div>
            ) : (
              <div style={{ fontSize: 15, color: 'var(--t3)', lineHeight: 1.45 }}>{CATEGORY_PHOTO_COPY.switchNotReady}</div>
            )}
          </Section>

          {/* ── Customer flow ── */}
          <Section title="Customer flow" desc="How customers move through ordering.">
            {v2 ? (
              <FieldLg label="Eat in and tables">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {TABLE_MODES_V2.map(opt => (
                    <label key={opt.v} style={{ display: 'flex', gap: 10, padding: '10px 12px', background: 'var(--bg2)', border: '1.5px solid ' + (draft.kiosk_table_mode === opt.v ? 'var(--acc)' : 'var(--bdr)'), borderRadius: 8, cursor: 'pointer' }}>
                      <input type="radio" checked={draft.kiosk_table_mode === opt.v} onChange={() => setField('kiosk_table_mode', opt.v)} />
                      <div><div style={{ fontSize: 16, fontWeight: 600 }}>{opt.label}</div><div style={{ fontSize: 15, color: 'var(--t3)' }}>{opt.desc}</div></div>
                    </label>
                  ))}
                </div>
              </FieldLg>
            ) : <Field label="Eat-in / table mode">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {TABLE_MODES.map(opt => (
                  <label key={opt.v} style={{ display: 'flex', gap: 10, padding: '10px 12px', background: 'var(--bg2)', border: '1.5px solid ' + (draft.kiosk_table_mode === opt.v ? 'var(--acc)' : 'var(--bdr)'), borderRadius: 8, cursor: 'pointer' }}>
                    <input type="radio" checked={draft.kiosk_table_mode === opt.v} onChange={() => setField('kiosk_table_mode', opt.v)} />
                    <div><div style={{ fontSize: 13, fontWeight: 600 }}>{opt.label}</div><div style={{ fontSize: 11, color: 'var(--t3)' }}>{opt.desc}</div></div>
                  </label>
                ))}
              </div>
            </Field>}

            {v2 ? <KioskTipping opsLocationId={device.location_id} /> : <Field label="Tip presets (%)" hint="Customer sees these as quick-pick buttons before pay">
              <div style={{ display: 'flex', gap: 10 }}>
                {[0, 1, 2].map(i => (
                  <input key={i} type="number" step="0.5" min="0" max="100"
                    value={(draft.kiosk_tip_presets || [])[i] ?? ''}
                    onChange={e => updateTip(i, e.target.value)}
                    placeholder={['10', '12.5', '15'][i]}
                    style={Object.assign({}, inp(), { width: 80, textAlign: 'center' })}
                  />
                ))}
              </div>
            </Field>}

            <Field label="Average wait time" hint="Shown to customer on attract & order-done screens">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input type="number" min="1" max="60"
                  value={draft.kiosk_avg_wait_minutes || 8}
                  onChange={e => setField('kiosk_avg_wait_minutes', parseInt(e.target.value) || 0)}
                  style={Object.assign({}, inp(), { width: 80, textAlign: 'center' })}
                />
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>minutes</span>
              </div>
            </Field>

            <Field label="Idle timeout" hint="Mid-order inactivity before kiosk resets">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input type="number" min="15" max="600" step="5"
                  value={draft.kiosk_idle_timeout_sec || 60}
                  onChange={e => setField('kiosk_idle_timeout_sec', parseInt(e.target.value) || 60)}
                  style={Object.assign({}, inp(), { width: 80, textAlign: 'center' })}
                />
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>seconds (then 10s warning)</span>
              </div>
            </Field>

            {v2 ? (
              <>
                <LargeToggleRow
                  checked={!!draft.kiosk_loyalty_enabled}
                  onChange={v => setField('kiosk_loyalty_enabled', v)}
                  title="Collect points"
                  desc="Customers can add their mobile number to collect points with no code. Spending a reward needs a text code."
                />
                {smsReady ? (
                  <LargeToggleRow
                    checked={draft.kiosk_sms_enabled === true}
                    onChange={v => setField('kiosk_sms_enabled', v)}
                    title="Text me when it's ready"
                    desc="Customers who collect their order (take away, or eat in with no table number) can add their mobile number to get one text when it is ready. This is separate from points."
                  />
                ) : null}
                <LargeToggleRow
                  checked={!!draft.kiosk_allergen_required}
                  onChange={v => setField('kiosk_allergen_required', v)}
                  title="Force allergen acknowledgement"
                  desc="Customers must tick that they have checked the allergens before paying. They also confirm when adding an item that contains an allergen they asked to avoid."
                />
                <div style={{ fontSize: 15, color: 'var(--t3)', lineHeight: 1.45 }}>
                  Alcohol means the categories ticked on the Challenge 21 page. Orders with alcohol are marked Check ID for staff.
                </div>
              </>
            ) : (
              <>
                <ToggleRow
                  checked={!!draft.kiosk_loyalty_enabled}
                  onChange={v => setField('kiosk_loyalty_enabled', v)}
                  title="Loyalty sign-in & rewards"
                  desc="Customers can sign in with their phone before paying to earn points/stamps, redeem rewards and use linked gift cards. Turning this OFF removes the whole loyalty step from the kiosk."
                />
                <ToggleRow
                  checked={!!draft.kiosk_allergen_required}
                  onChange={v => setField('kiosk_allergen_required', v)}
                  title="Force allergen acknowledgement"
                  desc="Customer must confirm allergen warning when adding flagged items (UK Natasha's Law)"
                />
              </>
            )}
          </Section>

          {/* ── Card terminal ── */}
          <Section title="Card terminal" desc="Assign the paired card terminal this kiosk sends card payments to. Only needed at venues that pair a terminal running the ServOS app — Stripe-reader venues take card automatically.">
            <KioskCardTerminalSection kioskId={kioskId} locationId={device.location_id} />
          </Section>

        </div>

        {/* RIGHT — live preview */}
        <div>
          <div style={{ position: 'sticky', top: 20 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Live preview</div>
            {v2 ? <DesignPreview draft={draft} deviceName={device.name} /> : <div style={{ borderRadius: 16, overflow: 'hidden', border: '1px solid var(--bdr)', background: draft.kiosk_brand_bg_color || '#0e0e10', aspectRatio: '9 / 16' }}>
              <div style={{ height: '100%', background: 'linear-gradient(135deg, ' + (draft.kiosk_brand_color || '#f97316') + ', ' + (draft.kiosk_brand_accent_color || '#fbbf24') + ')', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 16, color: '#fff' }}>
                {draft.kiosk_brand_logo_url && <img src={draft.kiosk_brand_logo_url} alt="" style={{ maxWidth: 80, maxHeight: 80, marginBottom: 14 }} />}
                <div style={{ fontSize: 20, fontWeight: 800, textAlign: 'center', letterSpacing: '-0.02em', marginBottom: 4 }}>{draft.kiosk_brand_name || device.name || 'Order here'}</div>
                <div style={{ fontSize: 10, opacity: 0.85, marginBottom: 18, textAlign: 'center' }}>~{draft.kiosk_avg_wait_minutes || 8} min wait</div>
                <div style={{ background: '#fff', color: draft.kiosk_brand_color || '#f97316', padding: '10px 22px', borderRadius: 100, fontSize: 12, fontWeight: 800 }}>TAP TO ORDER</div>
              </div>
            </div>}
            <div style={{ marginTop: 8, fontSize: 10.5, color: 'var(--t3)', textAlign: 'center' }}>Approximate · Refresh kiosk after Save to apply</div>
          </div>
        </div>
      </div>
    </div></div>
  );
}

// ============================================================
// Sub-components
// ============================================================

function Section({ title, desc, children }) {
  return (
    <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 18, marginBottom: 14 }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>{title}</div>
        {desc && <div style={{ fontSize: 11.5, color: 'var(--t3)' }}>{desc}</div>}
      </div>
      {children}
    </div>
  );
}

// New design settings: Back Office sized text (title 17px, description 15px).
function SectionLg({ title, desc, children }) {
  return (
    <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 18, marginBottom: 14 }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 2 }}>{title}</div>
        {desc && <div style={{ fontSize: 15, color: 'var(--t3)', lineHeight: 1.45 }}>{desc}</div>}
      </div>
      {children}
    </div>
  );
}

function FieldLg({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 15, color: 'var(--t3)', marginTop: 6, lineHeight: 1.45 }}>{hint}</div>}
    </div>
  );
}

// A small start screen in the new design: cream, the logo or name, a headline and two tiles
// in the main colour.
// The Look section's colour boxes show the colour the kiosk will really use: an empty colour or
// the old untouched orange default is the design green, so the picker, the code box and the
// swatch always agree.
function lookColourIsDefault(draft) {
  const c = String(draft?.kiosk_brand_color || '').trim().toLowerCase();
  return !c || c === OLD_DEFAULT_BRAND;
}
function lookColourText(draft) {
  return lookColourIsDefault(draft) ? DESIGN_GREEN : (draft.kiosk_brand_color || '');
}
function lookColourShown(draft) {
  const c = lookColourText(draft);
  return /^#[0-9a-f]{6}$/i.test(c) ? c : DESIGN_GREEN;
}
// White text reads under 3:1 on it, so the kiosk darkens it for text and highlights.
function lookColourIsLight(draft) {
  const rgb = parseCssColor(kioskPrimary(draft));
  return !!rgb && contrastWithWhite(rgb) < 3;
}

function DesignPreview({ draft, deviceName }) {
  const primary = kioskPrimary(draft);
  const onPrimary = kioskPalette(primary).onPrimary;
  const tile = { background: '#fff', borderRadius: 12, padding: '14px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, boxShadow: '0 3px 9px rgba(0,0,0,.06)' };
  return (
    <div style={{ borderRadius: 16, overflow: 'hidden', border: '1px solid var(--bdr)', background: '#EFE4D9', aspectRatio: '9 / 16', padding: 16, display: 'flex', flexDirection: 'column', color: '#14110F', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}>
      <div style={{ height: 40, display: 'flex', alignItems: 'center' }}>
        {draft.kiosk_brand_logo_url
          ? <div style={{ background: '#fff', borderRadius: 6, padding: 4, height: 36 }}><img src={draft.kiosk_brand_logo_url} alt="" style={{ height: 28, width: 'auto', maxWidth: 120, objectFit: 'contain', display: 'block' }} /></div>
          : <div style={{ fontSize: 15, fontWeight: 800 }}>{draft.kiosk_brand_name || deviceName || 'Order here'}</div>}
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 14 }}>
        <div style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.05, letterSpacing: '-0.03em' }}>Where are you eating today?</div>
        <div style={{ display: 'grid', gridTemplateColumns: draft.kiosk_table_mode === 'none' ? '1fr' : '1fr 1fr', gap: 8 }}>
          {draft.kiosk_table_mode !== 'none' ? <div style={tile}><span style={{ width: 22, height: 22, borderRadius: 999, border: `2px solid ${primary}` }} /><span style={{ fontSize: 15, fontWeight: 800 }}>Eat in</span></div> : null}
          <div style={tile}><span style={{ width: 22, height: 22, borderRadius: 6, border: `2px solid ${primary}` }} /><span style={{ fontSize: 15, fontWeight: 800 }}>Take away</span></div>
        </div>
      </div>
      <div style={{ background: primary, color: onPrimary, borderRadius: 999, padding: '8px 0', textAlign: 'center', fontSize: 15, fontWeight: 800 }}>Tap to start</div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 5 }}>{hint}</div>}
    </div>
  );
}

function ColorPicker({ label, value, onChange }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--t3)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 6, padding: 4 }}>
        <input type="color" value={value || '#000000'} onChange={e => onChange(e.target.value)}
          style={{ width: 32, height: 32, border: 0, padding: 0, background: 'transparent', cursor: 'pointer' }} />
        <input type="text" value={value || ''} onChange={e => onChange(e.target.value)}
          style={{ flex: 1, background: 'transparent', border: 0, color: 'var(--t1)', fontSize: 12, fontFamily: 'ui-monospace, monospace', outline: 'none', minWidth: 0 }} />
      </div>
    </div>
  );
}

function FileSlot({ currentUrl, onUpload, onClear, accept, uploading, kind, compact }) {
  const inputId = 'fu-' + Math.random().toString(36).slice(2, 8);
  const hasFile = !!currentUrl;
  const size = compact ? 100 : 130;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ width: size, height: size, borderRadius: 10, background: 'var(--bg2)', border: '1px dashed var(--bdr)', display: 'grid', placeItems: 'center', overflow: 'hidden', flexShrink: 0 }}>
        {hasFile && kind === 'image' && <img src={currentUrl} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />}
        {hasFile && kind === 'video' && <video src={currentUrl} muted style={{ maxWidth: '100%', maxHeight: '100%' }} />}
        {!hasFile && <div style={{ fontSize: 24, color: 'var(--t4, var(--t3))' }}>{kind === 'video' ? '\ud83c\udfa5' : '\ud83d\uddbc\ufe0f'}</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
        <label htmlFor={inputId} style={Object.assign({}, btnGhost(), { textAlign: 'center', cursor: uploading ? 'wait' : 'pointer', opacity: uploading ? 0.5 : 1 })}>
          {uploading ? 'Uploading…' : (hasFile ? 'Replace' : 'Upload')}
        </label>
        {hasFile && <button onClick={onClear} style={btnGhostDanger()}>Remove</button>}
      </div>
      <input id={inputId} type="file" accept={accept} onChange={onUpload} style={{ display: 'none' }} />
    </div>
  );
}

function ToggleRow({ checked, onChange, title, desc }) {
  return (
    <button onClick={() => onChange(!checked)} style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', marginBottom: 8,
      background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8,
      cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', color: 'inherit', width: '100%',
    }}>
      <span style={{ position: 'relative', width: 36, height: 20, background: checked ? 'var(--acc)' : 'var(--bg3)', borderRadius: 10, flexShrink: 0, transition: 'background .15s' }}>
        <span style={{ position: 'absolute', top: 2, left: checked ? 18 : 2, width: 16, height: 16, background: '#fff', borderRadius: '50%', transition: 'all .15s' }} />
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
        <span style={{ fontSize: 11, color: 'var(--t3)' }}>{desc}</span>
      </span>
    </button>
  );
}

// v5.8.65: same shape as ToggleRow with Back Office sized text (16px title, 15px description).
function LargeToggleRow({ checked, onChange, title, desc }) {
  return (
    <button type="button" role="switch" aria-checked={!!checked} onClick={() => onChange(!checked)} style={{
      display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', marginBottom: 8,
      background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8,
      cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', color: 'inherit', width: '100%',
    }}>
      <span style={{ position: 'relative', width: 44, height: 24, background: checked ? 'var(--acc)' : 'var(--bg3)', borderRadius: 12, flexShrink: 0, transition: 'background .15s' }}>
        <span style={{ position: 'absolute', top: 2, left: checked ? 22 : 2, width: 20, height: 20, background: '#fff', borderRadius: '50%', transition: 'all .15s' }} />
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 16, fontWeight: 600 }}>{title}</span>
        <span style={{ fontSize: 15, color: 'var(--t3)', lineHeight: 1.45 }}>{desc}</span>
      </span>
    </button>
  );
}

// v5.5.871 — assign a paired card terminal to this kiosk (bind_pos_device_id →
// the kiosk's devices.id) via the dedicated set_terminal_bound_device RPC. Binding
// is immediate (not part of the profile Save). On a Stripe venue there are no
// terminal_devices rows, so the list is empty and the section is a no-op.
function KioskCardTerminalSection({ kioskId, locationId }) {
  const [terminals, setTerminals] = useState(null); // null = loading
  const [busy, setBusy] = useState(null);           // terminal id being (un)bound
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const { data, error } = await supabase.rpc('terminal_targets_for_pos', { p_location_id: locationId });
      if (error) throw error;
      setTerminals(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e?.message || 'Could not load card terminals');
      setTerminals([]);
    }
  }, [locationId]);

  useEffect(() => { load(); }, [load]);

  const bind = async (terminalId, assign) => {
    setBusy(terminalId); setErr(null);
    try {
      const { error } = await supabase.rpc('set_terminal_bound_device', {
        p_terminal_id: terminalId,
        p_bound_pos_device_id: assign ? kioskId : null,
      });
      if (error) throw error;
      await load();
    } catch (e) {
      setErr(e?.message || 'Could not update the terminal assignment');
    } finally {
      setBusy(null);
    }
  };

  if (terminals === null) return <div style={{ fontSize: 12, color: 'var(--t3)' }}>Loading terminals…</div>;
  return (
    <div>
      {err && <div style={alertStyle('error')}>{err}</div>}
      {terminals.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>
          No card terminals running the ServOS app are paired at this venue. Pair one in Back Office → Card readers → Terminals running the ServOS app, then assign it here.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {terminals.map(t => {
            const mine = t.bound_pos_device_id === kioskId;
            const other = t.bound_pos_device_id && !mine;
            const linked = !!t.ryft_terminal_id;
            return (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', background: 'var(--bg2)', border: '1.5px solid ' + (mine ? 'var(--acc)' : 'var(--bdr)'), borderRadius: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{t.label || 'Card terminal'}</div>
                  <div style={{ fontSize: 11, color: 'var(--t3)' }}>
                    {mine ? 'Assigned to this kiosk' : other ? 'Assigned to another till' : 'Unassigned'}
                    {!linked && ' · ⚠ not connected to the card processor (cannot take card yet)'}
                  </div>
                </div>
                {mine ? (
                  <button onClick={() => bind(t.id, false)} disabled={busy === t.id} style={btnGhost()}>
                    {busy === t.id ? '…' : 'Unassign'}
                  </button>
                ) : (
                  <button onClick={() => bind(t.id, true)} disabled={busy === t.id || !!other}
                    title={other ? 'Unassign it from the other till first' : ''}
                    style={Object.assign({}, btnPrimary(busy === t.id), { opacity: (busy === t.id || other) ? 0.5 : 1 })}>
                    {busy === t.id ? '…' : 'Assign to this kiosk'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Style helpers ───
function inp() { return { width: '100%', background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '8px 10px', color: 'var(--t1)', fontFamily: 'inherit', fontSize: 13, outline: 'none' }; }
function btnPrimary(saving) { return { background: 'var(--acc)', color: '#fff', border: 0, padding: '9px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: saving ? 'wait' : 'pointer', fontFamily: 'inherit', opacity: saving ? 0.6 : 1 }; }
function btnGhost() { return { background: 'transparent', border: '1px solid var(--bdr)', color: 'var(--t2)', padding: '8px 14px', borderRadius: 8, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit' }; }
function btnGhostDanger() { return { background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', padding: '6px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }; }
function alertStyle(kind) {
  if (kind === 'error') return { background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 14 };
  return { background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', color: '#86efac', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 14 };
}
