import { useState, useEffect, useRef } from 'react';
import { useStore } from '../../store';
import { supabase, isMock, getLocationId } from '../../lib/supabase';
import { reportSave } from '../../lib/saveHealth';
// 30 Sep 2026 (Peter, Coffee Boy): the order type a till starts on, and the dine in flag prompt.
import { defaultOrderTypeFor, defaultOrderTypeSummary, cleanDefaultOrderType, tillOrderColumnsReady, tillOrderColumnsToKeep, DEFAULT_ORDER_TYPE_COLUMN, FLAG_PROMPT_COLUMN } from '../../lib/tillOrderType';
import { useSyncExternalStore } from 'react';   // 30 Sep 2026: the editor watches the till order type column flag
import { money } from '../../lib/currency';
import { ServOSIcon } from '../../components/ServOSBrand';
import { DISPLAY_BRAND_COLUMN, cleanDisplayBrand, displayBrandForDb, displayBrandFromKiosk, badDisplayBrandColours, hasDisplayBrandColumn, displayBrandIsSet, mergeDisplayBrand, normaliseHex, resolveDisplayBrand, EMPTY_DISPLAY_BRAND, DEFAULT_ACCENT_DARK } from '../../lib/customerDisplayBrand';

const SURFACES = [
  { id:'tables', label:'Floor plan', icon:'⬚', desc:'Opens to the table layout view' },
  { id:'pos',    label:'POS ordering', icon:'⊞', desc:'Opens straight to the menu/ordering screen' },
  { id:'bar',    label:'Bar tabs', icon:'🍸', desc:'Opens to the bar tab management screen' },
  { id:'kds',    label:'Kitchen display', icon:'▣', desc:'Opens to the KDS screen (for kitchen units)' },
  { id:'mpos',   label:'MPOS (mobile)', icon:'📱', desc:'Phone or Sunmi handheld for servers and runners. Card-only — Stripe Tap to Pay or assigned reader.' },
];

// MPOS payment mode — only relevant when defaultSurface === 'mpos'
const MPOS_PAYMENT_MODES = [
  { id:'tap_to_pay',          label:'Tap to Pay on this device', desc:'Use the phone’s built-in NFC. Requires native shell (Phase 1B).' },
  { id:'assigned_reader',     label:'Assigned network reader',   desc:'Pair to a fixed BBPOS WisePOS E or S700.' },
  { id:'pay_at_counter_only', label:'Pay at counter only',       desc:'Server takes orders only — cash/card all routed to the counter POS.' },
];

// Customer-facing display destination (per terminal — matches the hardware it has)
const CUSTOMER_DISPLAY_MODES = [
  { id:'auto',   label:'Auto (recommended)', desc:'Use a dedicated screen if present, otherwise the card reader.' },
  { id:'screen', label:'Dedicated screen',   desc:'Customer-facing second screen, e.g. Sunmi D3 Pro rear / external monitor.' },
  { id:'reader', label:'Card reader screen', desc:'Show the order on the WisePOS E reader screen.' },
  { id:'off',    label:'Off',                desc:'No customer-facing display.' },
];

const ORDER_TYPES = [
  { id:'dine-in',    label:'Dine in',    icon:'🍽' },
  { id:'takeaway',   label:'Takeaway',   icon:'🥡' },
  { id:'collection', label:'Collection', icon:'📦' },
  // Drive thru (16 Sep 2026): this tick IS the venue's switch. Off unless ticked, so a
  // till that never ticks it never offers it. No new column: device_profiles.enabled_order_types.
  { id:'drive-thru', label:'Drive thru', icon:'🚗' },
];
const orderTypeLabel = (t) => ORDER_TYPES.find(o => o.id === t)?.label || (t === 'delivery' ? 'Delivery' : t);

// 30 Sep 2026: true once device_profiles has default_order_type and dine_in_flag_prompt (the
// 20260930c migration), false while it does not, null until the profiles have loaded. Set once
// by loadFromDB (setTillOrderColumns); read by toDbRow and the save guard, and watched by the
// editor (useTillOrderColumns) so a block already open when the answer lands redraws itself.
// Only true shows the two settings and sends the columns (PGRST204 would fail the whole save
// before the migration). A module variable, not editor state, so ProfileEditor's props stay as
// they are.
let _tillOrderColumns = isMock ? true : null;
const _tillOrderWatchers = new Set();
function setTillOrderColumns(value) {
  _tillOrderColumns = value;
  _tillOrderWatchers.forEach(fn => fn());
}
const subscribeTillOrderColumns = (fn) => { _tillOrderWatchers.add(fn); return () => { _tillOrderWatchers.delete(fn); }; };
const readTillOrderColumns = () => _tillOrderColumns;
function useTillOrderColumns() {
  return useSyncExternalStore(subscribeTillOrderColumns, readTillOrderColumns);
}

// 30 Sep 2026: the stale tab guard for the two till order type columns (the v5.7.9 GUARDED_FIELDS
// class: a tab that opened the profile before another tab set "Starts on" must not wipe it with a
// rename). Kept beside GUARDED_FIELDS rather than in it so the fresh read never names a column
// that is not there yet (lib/tillOrderType.js tillOrderColumnsToKeep decides). Reads the stored
// values for the keys this editor session left alone and puts them on the row; a failed read drops
// the columns so PostgREST leaves them as they are. Returns the kept values as the form holds them
// (for this tab's list), or null when nothing was kept.
async function keepTillOrderColumns(row, touched) {
  const keep = tillOrderColumnsToKeep(touched, _tillOrderColumns);
  if (!keep.length || !row?.id) return null;
  const fresh = await supabase.from('device_profiles')
    .select(keep.map(([, col]) => col).join(', '))
    .eq('id', row.id).maybeSingle();
  const kept = {};
  for (const [formKey, col] of keep) {
    if (fresh.data) {
      row[col] = fresh.data[col];   // untouched: keep the DB value
      kept[formKey] = col === FLAG_PROMPT_COLUMN ? fresh.data[col] === true : (fresh.data[col] || null);
    } else {
      delete row[col];              // new row, or the read failed: omit the column
    }
  }
  return fresh.data ? kept : null;
}

// v4.5.1: trimmed to only the features actually wired in the codebase.
// Removed (Apr 26): kds (KDS is now a standalone product), kiosk (own surface, not a flag),
// reports (cosmetic-only — Back Office is web-accessible anyway), discounts/voids/splitCheck/
// tableTransfer (all pure stubs — never wired to anything).
const FEATURES = [
  { id:'barTabs', label:'Bar tabs',          desc:'Hide bar tab surface from POS sidebar' },
  { id:'courses', label:'Course management', desc:'Hide per-course headers + Fire course buttons. Items still carry course assignment internally.' },
];

const DEFAULT_PROFILES = [
  {
    id:'prof-1', name:'Main counter', color:'#3b82f6',
    defaultSurface:'tables', enabledOrderTypes:['dine-in','takeaway','collection'],
    assignedSection:null, hiddenFeatures:[], tableServiceEnabled:true,
    quickScreenEnabled:true, receiptPrinterId:'pr1', deviceCount:1,
    autoPrintReceiptOnClose:true, orderNotifications:true,
  },
  {
    id:'prof-2', name:'Bar terminal', color:'#e8a020',
    defaultSurface:'bar', enabledOrderTypes:['dine-in'],
    assignedSection:'bar', hiddenFeatures:['courses','kiosk','reports'],
    tableServiceEnabled:false, quickScreenEnabled:true,
    receiptPrinterId:'pr3', deviceCount:1,
    autoPrintReceiptOnClose:true, orderNotifications:true,
  },
  {
    id:'prof-3', name:'Server handheld', color:'#22c55e',
    defaultSurface:'pos', enabledOrderTypes:['dine-in'],
    assignedSection:null, hiddenFeatures:['kiosk','reports','discounts','voids'],
    tableServiceEnabled:true, quickScreenEnabled:true,
    receiptPrinterId:'pr1', deviceCount:1,
    autoPrintReceiptOnClose:true, orderNotifications:true,
  },
];

export default function DeviceProfiles() {
  const { showToast, devices, setDeviceConfig, markBOChange } = useStore();
  const [profiles, setProfiles] = useState(() => {
    try { return JSON.parse(localStorage.getItem('rpos-device-profiles') || '[]'); } catch { return []; }
  });
  const [editing, setEditing] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [locationId, setLocationId] = useState(null);
  // 30 Sep 2026: true once device_profiles has the customer_display_brand column (the 20260930b
  // migration), false while it does not, null until the profiles have loaded (or when that read
  // failed). Only true shows the branding editor and lets toDbRow send the column.
  const [brandColumnReady, setBrandColumnReady] = useState(isMock ? true : null);

  // Load from Supabase on mount — replaces localStorage cache with fresh data
  useEffect(() => {
    if (isMock) { setProfiles(DEFAULT_PROFILES); return; }
    const loadFromDB = async () => {
      const locId = await getLocationId().catch(() => null);
      if (!locId) return;
      setLocationId(locId);

      // Fetch profiles AND devices in parallel to get real device counts
      const [{ data: profileData }, { data: deviceData }] = await Promise.all([
        supabase.from('device_profiles').select('*').eq('location_id', locId).order('sort_order'),
        supabase.from('devices').select('id, profile_id').eq('location_id', locId),
      ]);

      // Count devices per profile
      const countMap = {};
      (deviceData || []).forEach(d => {
        if (d.profile_id) countMap[d.profile_id] = (countMap[d.profile_id] || 0) + 1;
      });

      // Does the branding column exist yet? The rows say so; with no rows, ask for the column.
      if (profileData?.length) setBrandColumnReady(hasDisplayBrandColumn(profileData[0]));
      else if (profileData) {
        const probe = await supabase.from('device_profiles').select(DISPLAY_BRAND_COLUMN).limit(1);
        setBrandColumnReady(!probe.error);
      }

      const mapped = (profileData || []).map(p => ({
        id: p.id, name: p.name, color: p.color || '#3b82f6',
        defaultSurface: p.default_surface || 'tables',
        enabledOrderTypes: p.enabled_order_types || ['dine-in'],
        assignedSection: p.assigned_section, hiddenFeatures: p.hidden_features || [],
        tableServiceEnabled: p.table_service_enabled !== false,
        quickScreenEnabled: p.quick_screen_enabled !== false,
        autoPrintReceiptOnClose: p.auto_print_receipt_on_close !== false,
        orderNotifications: p.order_notifications !== false,
        // 30 Sep 2026: the order type the till starts on (null = automatic) and the flag prompt.
        defaultOrderType: p[DEFAULT_ORDER_TYPE_COLUMN] || null,
        dineInFlagPrompt: p[FLAG_PROMPT_COLUMN] === true,
        menuId: p.menu_id,
        sortOrder: p.sort_order || 0,
        deviceCount: countMap[p.id] || 0,
        serviceCharge: p.service_charge || null,
        isMaster: p.is_master || false,
        trainingMode: p.training_mode === true,   // v5.5.645: per-device training
        // v5.5.731: auto sign-out policy
        signoutIdleSeconds: p.signout_idle_seconds || 0,
        signoutOnPay: p.signout_on_pay === true,
        signoutOnSend: p.signout_on_send === true,

        // v5.5.60 MPOS-only fields
        runnerMode: p.runner_mode === true,
        paymentMode: p.payment_mode || 'tap_to_pay',
        customerDisplayMode: p.customer_display_mode || 'auto',
        customerDisplayImages: Array.isArray(p.customer_display_images) ? p.customer_display_images : [],
        // 30 Sep 2026: the customer display's own branding (lib/customerDisplayBrand.js), and the
        // kiosk look it falls back to while that is empty. kioskBrand is read only here: Kiosk
        // settings owns it and toDbRow never writes it.
        customerDisplayBrand: cleanDisplayBrand(p[DISPLAY_BRAND_COLUMN]),
        kioskBrand: { name: p.kiosk_brand_name || '', color: p.kiosk_brand_color || '', logoUrl: p.kiosk_brand_logo_url || '' },
        assignedReaderId: p.assigned_reader_id || null,
      }));
      setProfiles(mapped);
      try { localStorage.setItem('rpos-device-profiles', JSON.stringify(mapped)); } catch {}
      // 30 Sep 2026: are the order type columns there yet? The rows say so; with no rows, ask.
      if (profileData?.length) setTillOrderColumns(tillOrderColumnsReady(profileData[0]));
      else if (profileData) {
        const probe = await supabase.from('device_profiles').select(DEFAULT_ORDER_TYPE_COLUMN).limit(1);
        setTillOrderColumns(!probe.error);
      }
    };
    loadFromDB();
  }, []);

  const toDbRow = (p, locId) => ({
    id: p.id,
    location_id: locId || locationId,
    name: p.name,
    color: p.color || '#3b82f6',
    default_surface: p.defaultSurface,
    enabled_order_types: p.enabledOrderTypes,
    assigned_section: p.assignedSection || null,
    hidden_features: p.hiddenFeatures || [],
    table_service_enabled: p.tableServiceEnabled !== false,
    quick_screen_enabled: p.quickScreenEnabled !== false,
    auto_print_receipt_on_close: p.autoPrintReceiptOnClose !== false,
    order_notifications: p.orderNotifications !== false,
    // 30 Sep 2026: only once the columns exist (PGRST204 would fail the whole save before then).
    // The default is kept only while its type is still enabled (cleanDefaultOrderType).
    ...(_tillOrderColumns === true ? {
      [DEFAULT_ORDER_TYPE_COLUMN]: cleanDefaultOrderType(p.defaultOrderType, p.enabledOrderTypes),
      [FLAG_PROMPT_COLUMN]: p.dineInFlagPrompt === true,
    } : {}),
    menu_id: p.menuId || null,
    sort_order: p.sortOrder || 0,
    service_charge: p.serviceCharge || null,
    is_master: p.isMaster || false,
    training_mode: p.trainingMode === true,   // v5.5.645: per-device training
    // v5.5.731: auto sign-out policy
    signout_idle_seconds: Number(p.signoutIdleSeconds) || 0,
    signout_on_pay: p.signoutOnPay === true,
    signout_on_send: p.signoutOnSend === true,

    // v5.5.60 MPOS-only fields
    runner_mode: p.runnerMode === true,
    payment_mode: p.paymentMode || 'tap_to_pay',
    customer_display_mode: p.customerDisplayMode || 'auto',
    customer_display_images: p.customerDisplayImages || [],
    assigned_reader_id: p.assignedReaderId || null,
    // 30 Sep 2026: only once the column exists (PGRST204 would fail the whole save before it).
    ...(brandColumnReady ? { [DISPLAY_BRAND_COLUMN]: displayBrandForDb(p.customerDisplayBrand) } : {}),
  });

  // Always resolve a real locationId — never save with null
  const resolveLocId = async () => {
    if (locationId) return locationId;
    
    const id = await getLocationId().catch(() => null);
    if (id) setLocationId(id);
    return id;
  };

  // v5.7.9: fields where a stale tab writing its in-memory value silently undoes an
  // operator's change made elsewhere. The proven victim is menu_id: a BO tab opened
  // BEFORE a menu was pinned held menuId undefined, so ANY save from that tab (even a
  // rename) nulled the pin. Same class as the vanishing-categories saga. On update,
  // these keep the DB value unless THIS editor session actually touched them.
  // Third entry: the DB value as the form holds it, for putting a kept value back into this
  // tab's list after the save (so the next editor opened here starts from what was stored).
  const GUARDED_FIELDS = [
    ['menuId', 'menu_id', v => v],
    ['serviceCharge', 'service_charge', v => v || null],
    ['trainingMode', 'training_mode', v => v === true],
    // 30 Sep 2026: the customer display's own branding, once its column exists. A tab opened
    // before someone set it elsewhere cannot wipe it by saving a rename.
    ...(brandColumnReady ? [['customerDisplayBrand', DISPLAY_BRAND_COLUMN, cleanDisplayBrand]] : []),
  ];

  // The tab's own copy of the profiles (state + the rpos-device-profiles cache), one row replaced.
  const putLocal = (p) => {
    setProfiles(ps => ps.map(x => x.id === p.id ? p : x));
    try {
      const cur = JSON.parse(localStorage.getItem('rpos-device-profiles') || '[]');
      const exists = cur.find(x => x.id === p.id);
      const next = exists
        ? cur.map(x => x.id === p.id ? p : x)
        : [...cur, p];
      localStorage.setItem('rpos-device-profiles', JSON.stringify(next));
    } catch {}
  };

  // `touched` is the Set of form keys the editor session explicitly changed (null =
  // unknown caller: keep today's full-overwrite behaviour). `opened` is the profile as the
  // editor opened with it (the base for merging the display branding).
  const save = async (form, touched = null, opened = null) => {
    // Close panel immediately so it feels instant
    setEditing(null);
    setShowNew(false);

    // 30 Sep 2026: keep what is stored, not what was typed (trimmed name, lower case colour codes),
    // so reopening the editor in this tab shows the saved branding.
    const updated = { ...form, customerDisplayBrand: cleanDisplayBrand(form.customerDisplayBrand) };

    // Update local state and localStorage immediately
    putLocal(updated);

    markBOChange();

    if (!isMock) {
      try {
        const locId = await resolveLocId();
        if (!locId) throw new Error('Could not resolve location ID');

        const row = toDbRow(updated, locId);
        // 30 Sep 2026: keep the stored Starts on / flag number unless this session changed them.
        const keptTillOrder = await keepTillOrderColumns(row, touched);
        if (keptTillOrder) setProfiles(ps => ps.map(p => p.id === row.id ? { ...p, ...keptTillOrder } : p));
        // Use update for existing profiles, insert for new ones. The existence check
        // doubles as the fresh read for the clobber guard (no extra round trip).
        let error;
        const existing = await supabase.from('device_profiles')
          .select(['id', ...GUARDED_FIELDS.map(([, col]) => col)].join(', '))
          .eq('id', row.id).maybeSingle();
        const kept = {};   // guarded fields that kept the DB value: form key -> value as the form holds it
        if (existing.data || existing.error) {
          // Row exists, or the fresh read failed and we cannot tell. Treat both as
          // an update: a genuinely new row then fails loudly on the 0-row check
          // below instead of a duplicate-key insert error, never silently.
          if (touched) {
            for (const [formKey, col, fromDb] of GUARDED_FIELDS) {
              if (touched.has(formKey)) continue;                // session edited it: write the form value
              if (existing.data) {                               // untouched: keep the DB value
                row[col] = existing.data[col];
                kept[formKey] = fromDb(existing.data[col]);
              }
              else delete row[col];                              // fresh read failed: omit the column so PostgREST leaves it alone
            }
            // 30 Sep 2026 (review): branding this session changed is merged field by field with the
            // database copy (mergeDisplayBrand), so a tab open since before someone else set the
            // name and logo, that only picks an accent colour here, keeps that name and logo.
            if (brandColumnReady && touched.has('customerDisplayBrand') && existing.data && opened) {
              const merged = mergeDisplayBrand(opened.customerDisplayBrand, updated.customerDisplayBrand, existing.data[DISPLAY_BRAND_COLUMN]);
              row[DISPLAY_BRAND_COLUMN] = displayBrandForDb(merged);
              kept.customerDisplayBrand = merged;
            }
          }
          const { error: e, data: dataUp } = await supabase.from('device_profiles').update(row).eq('id', row.id).select('id');
          if (e) throw e;
          if (!dataUp || dataUp.length === 0) throw new Error(`Profile update matched 0 rows for id=${row.id}. Column may be missing (run migration) or RLS blocked it.`);
          error = e;
          // 30 Sep 2026 (review): the list above still holds this tab's stale copy of every field
          // the guard kept. Put the stored value back, or the next editor opened here starts from
          // the stale one and a later save of that field would write it.
          if (Object.keys(kept).length) putLocal({ ...updated, ...kept });
        } else {
          const { error: e } = await supabase.from('device_profiles').insert(row);
          error = e;
        }
        if (error) throw error;
        reportSave('device profile', null);
        showToast(`"${updated.name}" saved`, 'success');
      } catch (err) {
        console.error('Profile save failed:', err);
        reportSave('device profile', err);
        showToast(`Save failed — "${updated.name}" NOT saved to cloud`, 'error');
      }
    } else {
      showToast(`"${updated.name}" saved`, 'success');
    }
  };

  const addProfile = async (profile) => {
    const nextId = `prof-${Date.now()}`;
    const newProfile = { ...profile, id: nextId, deviceCount: 0, customerDisplayBrand: cleanDisplayBrand(profile.customerDisplayBrand) };

    // Close panel immediately
    setShowNew(false);

    // Update local state and localStorage immediately
    setProfiles(ps => [...ps, newProfile]);
    try {
      const cur = JSON.parse(localStorage.getItem('rpos-device-profiles') || '[]');
      localStorage.setItem('rpos-device-profiles', JSON.stringify([...cur, newProfile]));
    } catch {}

    markBOChange();

    // v5.5.961: the success toast used to fire HERE, before the DB insert was even
    // attempted — a failed insert left a phantom profile that lived in state +
    // localStorage all evening and "vanished on refresh" when loadFromDB replaced
    // both with DB truth. Now: success only after the row lands; on failure the
    // card is reverted on the spot and the saveHealth banner goes up.
    if (!isMock) {
      try {
        const locId = await resolveLocId();
        if (!locId) throw new Error('No location ID');
        const row = toDbRow(newProfile, locId);
        const { error } = await supabase.from('device_profiles').insert(row);
        if (error) throw error;
        reportSave('device profile', null);
        showToast(`"${profile.name}" profile created`, 'success');
      } catch (err) {
        console.error('Profile insert failed:', err);
        reportSave('device profile', err);
        setProfiles(ps => ps.filter(x => x.id !== newProfile.id));
        try {
          const cur = JSON.parse(localStorage.getItem('rpos-device-profiles') || '[]');
          localStorage.setItem('rpos-device-profiles', JSON.stringify(cur.filter(x => x.id !== newProfile.id)));
        } catch {}
        showToast(`"${profile.name}" was NOT saved — fix the connection and create it again`, 'error');
      }
    } else {
      showToast(`"${profile.name}" profile created`, 'success');
    }
  };

  const deleteProfile = async (id) => {
    // v5.5.961: check the delete actually landed — a swallowed failure here made
    // the profile resurrect on refresh (inverse of the phantom-create bug).
    if (!isMock) {
      const { error } = await supabase.from('device_profiles').delete().eq('id', id);
      reportSave('device profile delete', error);
      if (error) {
        showToast('Delete failed — profile kept', 'error');
        return;
      }
    }
    setProfiles(ps => ps.filter(p => p.id !== id));
    try {
      const cur = JSON.parse(localStorage.getItem('rpos-device-profiles') || '[]');
      localStorage.setItem('rpos-device-profiles', JSON.stringify(cur.filter(p => p.id !== id)));
    } catch {}
    markBOChange();
    showToast('Profile deleted', 'info');
  };

  return (
    <div style={{ flex:1, overflowY:'auto', padding:28 }}>
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:24 }}>
        <div>
          <div style={{ fontSize:14, color:'var(--t3)', marginTop:4, maxWidth:560 }}>
            Profiles control what each terminal shows and can do. Assign a profile to a device and it immediately adapts — the bar terminal never shows takeaway, the counter shows everything.
          </div>
        </div>
        <button onClick={() => setShowNew(true)} style={{
          padding:'8px 18px', borderRadius:10, cursor:'pointer', fontFamily:'inherit',
          background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:13, fontWeight:700, flexShrink:0,
        }}>+ New profile</button>
      </div>

      {/* Profile cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(320px, 1fr))', gap:14 }}>
        {profiles.map(prof => {
          const devCount = (devices || []).filter(d => d.profileId === prof.id).length || prof.deviceCount || 0;
          const orderTypes = prof.enabledOrderTypes || [];
          const hiddenFeats = prof.hiddenFeatures || [];
          return (
            <div key={prof.id} style={{
              background:'var(--bg1)', border:'1px solid var(--bdr)',
              borderRadius:16, overflow:'hidden',
              borderTop:`3px solid ${prof.color}`,
            }}>
              {/* Header */}
              <div style={{ padding:'16px 18px 14px' }}>
                <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:10 }}>
                  <div>
                    <div style={{ fontSize:16, fontWeight:800, color:'var(--t1)' }}>{prof.name}</div>
                    <div style={{ fontSize:11, color:'var(--t3)', marginTop:3 }}>
                      {devCount} device{devCount !== 1 ? 's' : ''} using this profile
                    </div>
                  </div>
                  <div style={{
                    padding:'4px 10px', borderRadius:20, fontSize:10, fontWeight:700,
                    background:`${prof.color}22`, color:prof.color,
                    border:`1px solid ${prof.color}44`,
                  }}>
                    {SURFACES.find(s => s.id === prof.defaultSurface)?.label || prof.defaultSurface}
                  </div>
                </div>

                {/* Config summary */}
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  {prof.trainingMode && <ConfigRow label="Training mode" value="🎓 ON — nothing committed" valueColor="#B45309"/>}
                  <ConfigRow label="Default screen" value={SURFACES.find(s => s.id === prof.defaultSurface)?.label}/>
                  <ConfigRow label="Order types" value={orderTypes.map(t => ORDER_TYPES.find(o => o.id === t)?.icon + ' ' + ORDER_TYPES.find(o => o.id === t)?.label).join(' · ') || 'None'}/>
                  <ConfigRow label="Starts on" value={defaultOrderTypeSummary(prof, orderTypeLabel)}/>
                  {prof.dineInFlagPrompt && <ConfigRow label="Flag number" value="Asked on dine in orders" valueColor="var(--acc)"/>}
                  <ConfigRow label="Table service" value={prof.tableServiceEnabled ? '✓ Enabled' : '✕ Disabled'} valueColor={prof.tableServiceEnabled ? 'var(--grn)' : 'var(--red)'}/>
                  <ConfigRow label="Auto-print receipt" value={prof.autoPrintReceiptOnClose !== false ? '✓ Enabled' : '✕ Disabled'} valueColor={prof.autoPrintReceiptOnClose !== false ? 'var(--grn)' : 'var(--red)'}/>
                  <ConfigRow label="Section" value={prof.assignedSection || 'All sections'}/>
                  {hiddenFeats.length > 0 && (
                    <ConfigRow label="Hidden features" value={hiddenFeats.join(', ')} truncate/>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div style={{ padding:'10px 18px', borderTop:'1px solid var(--bdr)', display:'flex', gap:8, background:'var(--bg2)' }}>
                <button onClick={() => setEditing({ ...prof })} style={{
                  flex:1, height:34, borderRadius:8, cursor:'pointer', fontFamily:'inherit',
                  background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t2)', fontSize:12, fontWeight:600,
                }}>Edit profile</button>
                <button onClick={() => {
                  setDeviceConfig({
                    profileId: prof.id,
                    profileName: prof.name,
                    defaultSurface: prof.defaultSurface,
                    enabledOrderTypes: orderTypes,
                    assignedSection: prof.assignedSection,
                    hiddenFeatures: hiddenFeats,
                    tableServiceEnabled: prof.tableServiceEnabled,
                    quickScreenEnabled: prof.quickScreenEnabled,
                    autoPrintReceiptOnClose: prof.autoPrintReceiptOnClose !== false,
                    menuId: prof.menuId,
                    receiptPrinterId: prof.receiptPrinterId,
                    defaultOrderType: prof.defaultOrderType || null,   // 30 Sep 2026 (lib/tillOrderType.js)
                    dineInFlagPrompt: prof.dineInFlagPrompt === true,
                  });
                  showToast(`"${prof.name}" applied to this terminal`, 'success');
                }} style={{
                  flex:1, height:34, borderRadius:8, cursor:'pointer', fontFamily:'inherit',
                  background:`${prof.color}22`, border:`1px solid ${prof.color}44`, color:prof.color, fontSize:12, fontWeight:700,
                }}>Apply to this terminal</button>
              </div>
            </div>
          );
        })}
      </div>

      {editing && <ProfileEditor profile={editing} brandReady={brandColumnReady} onSave={save} onDelete={() => { deleteProfile(editing.id); setEditing(null); }} onClose={() => setEditing(null)}/>}
      {showNew  && <ProfileEditor profile={null} brandReady={brandColumnReady} onSave={addProfile} onClose={() => setShowNew(false)}/>}
    </div>
  );
}

// ── Customer display branding ─────────────────────────────────────────────────
// Peter, 30 Sep 2026: "The customer branding for the kiosk and the customer display should be
// separate". The display's own name, accent colour, background colour and logo, stored in
// device_profiles.customer_display_brand (lib/customerDisplayBrand.js). While none is set the
// display shows the kiosk branding, as before. Once any field is set the display uses only its
// own, and an empty field is the standard look, never the kiosk's, so a kiosk change no longer
// reaches the display.
const BRAND_LABEL = { display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 };
const BRAND_FIELD = { fontSize:12, fontWeight:700, color:'var(--t2)', marginBottom:6 };
const BRAND_HINT = { fontSize:11, color:'var(--t4)', marginTop:4 };
const BRAND_NOTE = { fontSize:12, marginBottom:10, lineHeight:1.45 };
const BRAND_INPUT = { width:'100%', background:'var(--bg3)', border:'1.5px solid var(--bdr2)', borderRadius:10, padding:'9px 12px', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box' };
const BRAND_BTN = { padding:'8px 12px', borderRadius:8, border:'1px solid var(--bdr2)', background:'var(--bg3)', color:'var(--t2)', cursor:'pointer', fontSize:12, fontWeight:600, fontFamily:'inherit', flexShrink:0 };
const DISPLAY_DARK_BG = '#0f1211';

function BrandColourRow({ label, value, pickerValue, onChange, emptyHint }) {
  const raw = value || '';
  const bad = raw.trim() !== '' && !normaliseHex(raw);
  return (
    <div style={{ marginBottom:12 }}>
      <div style={BRAND_FIELD}>{label}</div>
      <div style={{ display:'flex', gap:8, alignItems:'center' }}>
        <input type="color" aria-label={label} value={pickerValue} onChange={e => onChange(e.target.value)}
          style={{ width:42, height:38, padding:2, borderRadius:8, border:'1.5px solid var(--bdr2)', background:'var(--bg3)', cursor:'pointer', flexShrink:0 }}/>
        <input aria-label={label + ' code'} value={raw} onChange={e => onChange(e.target.value)} placeholder="Not set" style={BRAND_INPUT}/>
        {raw && <button type="button" onClick={() => onChange('')} style={BRAND_BTN}>Clear</button>}
      </div>
      {bad
        ? <div style={{ ...BRAND_HINT, color:'var(--red)' }}>Type a colour code like #15C26A, or pick one. You can save once it is fixed or cleared.</div>
        : !raw && <div style={BRAND_HINT}>{emptyHint}</div>}
    </div>
  );
}

function DisplayBrandEditor({ ready, brand, kiosk, onChange, onReplace, onUploadLogo, uploading }) {
  if (ready !== true) {
    return (
      <div style={{ marginBottom:18 }}>
        <label style={BRAND_LABEL}>Customer display branding</label>
        <div style={{ ...BRAND_NOTE, color:'var(--t3)' }}>
          {ready === false
            ? "The customer display's own branding needs a database update before it can be set here. Until then the display uses the kiosk branding."
            : 'The customer display branding has not loaded. Refresh Back Office to set it. Until then the display keeps what it shows now.'}
        </div>
      </div>
    );
  }
  const b = { ...EMPTY_DISPLAY_BRAND, ...(brand || {}) };
  const k = kiosk || {};
  const ownSet = displayBrandIsSet(b);
  const kioskHas = !!(k.name || k.color || k.logoUrl);
  // What the display will show with these settings (dark look when no background is set).
  const look = resolveDisplayBrand({
    kiosk_brand_name: k.name, kiosk_brand_color: k.color, kiosk_brand_logo_url: k.logoUrl,
    [DISPLAY_BRAND_COLUMN]: b,
  }, { theme: 'dark', placeName: 'Venue name' });
  const ink = look.dark ? '#E9ECEA' : '#16191C';
  const kioskHex = normaliseHex(k.color);

  let note;
  if (ownSet) note = 'The customer display uses this branding, and the kiosk keeps its own. Empty fields use the standard look, and an empty background follows the till.';
  else if (kioskHas) note = 'Using the kiosk branding until you set this. Once you set anything here, the display stops following the kiosk.';
  else note = 'This profile has no kiosk branding, so the display shows the venue name and the standard look until you set this.';

  return (
    <div style={{ marginBottom:18 }}>
      <label style={BRAND_LABEL}>Customer display branding</label>
      <div style={{ ...BRAND_NOTE, color: ownSet ? 'var(--t2)' : 'var(--t3)' }}>{note}</div>
      {!ownSet && kioskHas && (
        <button type="button" onClick={() => onReplace(displayBrandFromKiosk(k))} style={{ ...BRAND_BTN, marginBottom:12 }}>
          Start from the kiosk branding
        </button>
      )}

      {/* Preview */}
      <div aria-label="Customer display preview" style={{
        display:'flex', alignItems:'center', gap:12, padding:'12px 14px', borderRadius:12, marginBottom:14,
        background: look.bgColor || DISPLAY_DARK_BG, color: ink, borderLeft:`4px solid ${look.color}`,
      }}>
        {look.logoUrl
          ? <img src={look.logoUrl} alt="" style={{ height:30, maxWidth:110, objectFit:'contain' }}/>
          : <ServOSIcon size={26} style={{ color: ink }}/>}
        <div style={{ fontSize:15, fontWeight:700, flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{look.name}</div>
        <div style={{ fontSize:18, fontWeight:900, color: look.color }}>{money(12.5)}</div>
      </div>

      <div style={{ marginBottom:12 }}>
        <div style={BRAND_FIELD}>Name</div>
        <input aria-label="Customer display name" value={b.name} maxLength={60} onChange={e => onChange('name', e.target.value)}
          placeholder={!ownSet && k.name ? `Kiosk name: ${k.name}` : 'Venue name'} style={BRAND_INPUT}/>
        {!b.name.trim() && <div style={BRAND_HINT}>{
          ownSet ? 'Shows the venue name.'
            : k.name ? 'Using the kiosk name until you set this.' : 'Shows the venue name until you set this.'
        }</div>}
      </div>

      <BrandColourRow
        label="Accent colour"
        value={b.color}
        pickerValue={normaliseHex(b.color) || (!ownSet && kioskHex) || DEFAULT_ACCENT_DARK.toLowerCase()}
        onChange={v => onChange('color', v)}
        emptyHint={ownSet ? 'Uses the standard green.'
          : k.color ? `Using the kiosk colour (${k.color}) until you set this.` : 'Using the standard green until you set this.'}
      />

      <BrandColourRow
        label="Background colour"
        value={b.bgColor}
        pickerValue={normaliseHex(b.bgColor) || DISPLAY_DARK_BG}
        onChange={v => onChange('bgColor', v)}
        emptyHint="Follows the till's light or dark look until you set this."
      />

      <div>
        <div style={BRAND_FIELD}>Logo</div>
        <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
          {b.logoUrl && (
            <div style={{ height:40, padding:4, borderRadius:8, border:'1px solid var(--bdr2)', background:'var(--bg3)', display:'flex', alignItems:'center' }}>
              <img src={b.logoUrl} alt="Customer display logo" style={{ height:30, maxWidth:120, objectFit:'contain' }}/>
            </div>
          )}
          <label style={{ ...BRAND_BTN, display:'inline-block', border:'1px dashed var(--bdr2)', background:'transparent' }}>
            {uploading ? 'Uploading…' : b.logoUrl ? 'Replace logo' : '+ Upload logo'}
            <input type="file" accept="image/*" style={{ display:'none' }} disabled={uploading}
              onChange={e => { const f = e.target.files?.[0]; if (f) onUploadLogo(f); e.target.value = ''; }}/>
          </label>
          {b.logoUrl && <button type="button" onClick={() => onChange('logoUrl', '')} style={BRAND_BTN}>Remove</button>}
        </div>
        {!b.logoUrl && <div style={BRAND_HINT}>{
          ownSet ? 'Shows the Serv OS mark.'
            : k.logoUrl ? 'Using the kiosk logo until you set this.' : 'Shows the Serv OS mark until you set this.'
        }</div>}
      </div>
    </div>
  );
}

function ConfigRow({ label, value, valueColor, truncate }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', gap:10, fontSize:12 }}>
      <span style={{ color:'var(--t4)', flexShrink:0 }}>{label}</span>
      <span style={{ color: valueColor || 'var(--t2)', fontWeight:500, textAlign:'right', overflow: truncate ? 'hidden' : 'visible', textOverflow: truncate ? 'ellipsis' : 'clip', whiteSpace: truncate ? 'nowrap' : 'normal' }}>{value}</span>
    </div>
  );
}

// ── Starts on + flag number (30 Sep 2026) ─────────────────────────────────────
// Peter, Coffee Boy: "Huddersfield have one POS that only does drive thru but it's defaulting to
// Dine in", and for coffee shops with numbered flags and no fixed tables, "prompts for a table
// flag ... then the KDS and production tickets say Table and the number typed". Both live on the
// device profile (lib/tillOrderType.js). Greyed out until the 20260930c migration has run.
const TILL_LABEL = { display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 };
const TILL_HINT = { fontSize:11, color:'var(--t4)', marginTop:6, lineHeight:1.45 };

function TillOrderTypeSettings({ form, upd }) {
  const ready = useTillOrderColumns();
  if (ready !== true) {
    return (
      <div style={{ marginBottom:18 }}>
        <label style={TILL_LABEL}>Starts on and flag number</label>
        <div style={{ fontSize:12, color:'var(--t3)', lineHeight:1.45 }}>
          {ready === false
            ? 'Choosing the order type a till starts on, and asking for a flag number on dine in orders, need a database update first. Until then a till starts on its only enabled order type, or dine in.'
            : 'These settings are still loading. If they do not appear, refresh Back Office.'}
        </div>
      </div>
    );
  }
  const enabled = form.enabledOrderTypes || [];
  const current = cleanDefaultOrderType(form.defaultOrderType, enabled) || '';
  const auto = defaultOrderTypeFor({ enabledOrderTypes: enabled, defaultOrderType: null });
  const flagOn = form.dineInFlagPrompt === true;
  const dineIn = enabled.includes('dine-in');
  return (
    <div style={{ marginBottom:18 }}>
      <label style={TILL_LABEL}>Starts on</label>
      <select aria-label="Order type the till starts on" value={current} onChange={e => upd('defaultOrderType', e.target.value || null)}
        style={{ width:'100%', background:'var(--bg3)', border:'1.5px solid var(--bdr2)', borderRadius:10, padding:'9px 12px', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none' }}>
        <option value="">Automatic ({orderTypeLabel(auto)})</option>
        {ORDER_TYPES.filter(t => enabled.includes(t.id)).map(t => <option key={t.id} value={t.id}>{t.icon} {t.label}</option>)}
      </select>
      <div style={TILL_HINT}>The order type a till on this profile opens on, and goes back to after each order. Automatic means the only enabled type, or dine in. Floor tables are always dine in.</div>

      <label style={{ ...TILL_LABEL, marginTop:14 }}>Flag number</label>
      <button type="button" onClick={() => upd('dineInFlagPrompt', !flagOn)} aria-pressed={flagOn} style={{
        width:'100%', padding:'11px 14px', borderRadius:10, cursor:'pointer', fontFamily:'inherit', textAlign:'left',
        background: flagOn ? 'var(--acc-d)' : 'var(--bg3)',
        border:`1.5px solid ${flagOn ? 'var(--acc)' : 'var(--bdr)'}`,
        color: flagOn ? 'var(--acc)' : 'var(--t2)', fontSize:13, fontWeight:700, transition:'all .1s',
        display:'flex', alignItems:'center', justifyContent:'space-between', gap:10,
      }}>
        <span>Ask for a flag number on dine in orders</span>
        <span style={{ fontSize:11, fontWeight:800 }}>{flagOn ? 'ON' : 'OFF'}</span>
      </button>
      <div style={TILL_HINT}>
        {flagOn
          ? 'Before a dine in order is sent or paid, staff type the number on the customer\'s flag. Staff cannot skip it. Kitchen screens, kitchen tickets, the receipt and Orders then say Table and that number.'
          : 'For coffee shops with numbered flags and no fixed tables. Kitchen screens and tickets say Table and the number typed.'}
        {!dineIn && ' Dine in is not enabled on this profile, so nothing asks until it is.'}
      </div>
    </div>
  );
}

// ── Profile editor modal ───────────────────────────────────────────────────────
function ProfileEditor({ profile, brandReady, onSave, onDelete, onClose }) {
  const { menus } = useStore();
  const isNew = !profile;
  const [form, setForm] = useState(profile || {
    name:'', color:'#3b82f6',
    defaultSurface:'tables', enabledOrderTypes:['dine-in'],
    assignedSection:null, hiddenFeatures:[],
    tableServiceEnabled:true, quickScreenEnabled:true, receiptPrinterId:'pr1', menuId:null,
    autoPrintReceiptOnClose:true, orderNotifications:true,
    runnerMode:false, paymentMode:'tap_to_pay', assignedReaderId:null, customerDisplayMode:'auto',
    trainingMode:false,
    signoutIdleSeconds:0, signoutOnPay:false, signoutOnSend:false,
    defaultOrderType:null, dineInFlagPrompt:false,   // 30 Sep 2026 (lib/tillOrderType.js)
  });

  // v5.7.9: record which fields THIS editor session actually changed. Every control
  // in this modal funnels through upd() (updSC, toggleOrderType and toggleFeature all
  // call it), so adding the key here catches them all. save() uses the set to keep
  // the DB value for clobber-prone fields (menu pin, service charge, training mode)
  // the operator never pressed, so a tab loaded before a change made elsewhere can
  // no longer silently undo it.
  const touchedRef = useRef(new Set());
  const upd = (key, val) => { touchedRef.current.add(key); setForm(f => ({ ...f, [key]: val })); };

  // Customer-display uploads (kiosk-assets public bucket, customer-display/ folder).
  const putDisplayAsset = async (file, tag = '') => {
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `customer-display/${Date.now()}-${tag}${safe}`;
    const { error } = await supabase.storage.from('kiosk-assets').upload(path, file, { cacheControl: '3600', upsert: true, contentType: file.type });
    if (error) throw error;
    return supabase.storage.from('kiosk-assets').getPublicUrl(path).data?.publicUrl || '';
  };
  const [uploadingImg, setUploadingImg] = useState(false);
  const uploadDisplayImage = async (file) => {
    if (!file || isMock || !supabase) return;
    setUploadingImg(true);
    try {
      const url = await putDisplayAsset(file);
      if (url) {
        touchedRef.current.add('customerDisplayImages'); // setForm call that bypasses upd()
        setForm(f => ({ ...f, customerDisplayImages: [ ...(f.customerDisplayImages || []), url ] }));
      }
    } catch (e) {
      alert('Image upload failed: ' + (e.message || e) + '\n(Check the kiosk-assets storage bucket exists and is public.)');
    } finally {
      setUploadingImg(false);
    }
  };
  // 30 Sep 2026: the customer display's own branding (lib/customerDisplayBrand.js). Functional
  // setForm so a logo upload finishing after a typed change never loses either.
  const updBrand = (key, val) => {
    touchedRef.current.add('customerDisplayBrand');
    setForm(f => ({ ...f, customerDisplayBrand: { ...EMPTY_DISPLAY_BRAND, ...(f.customerDisplayBrand || {}), [key]: val } }));
  };
  const replaceBrand = (next) => {
    touchedRef.current.add('customerDisplayBrand');
    setForm(f => ({ ...f, customerDisplayBrand: { ...EMPTY_DISPLAY_BRAND, ...(next || {}) } }));
  };
  // 30 Sep 2026 (review): a colour code that is not one would be dropped on save without a word,
  // so Save waits until it is fixed or cleared (the field says why).
  const badBrandColours = brandReady === true ? badDisplayBrandColours(form.customerDisplayBrand) : [];
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const uploadDisplayLogo = async (file) => {
    if (!file || isMock || !supabase) return;
    setUploadingLogo(true);
    try {
      const url = await putDisplayAsset(file, 'logo-');
      if (url) updBrand('logoUrl', url);
    } catch (e) {
      alert('Logo upload failed: ' + (e.message || e) + '\n(Check the kiosk-assets storage bucket exists and is public.)');
    } finally {
      setUploadingLogo(false);
    }
  };
  const toggleOrderType = id => { const arr = form.enabledOrderTypes || []; upd('enabledOrderTypes', arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id]); };
  const toggleFeature = id => { const arr = form.hiddenFeatures || []; upd('hiddenFeatures', arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id]); };

  const COLORS = ['#3b82f6','#e8a020','#22c55e','#a855f7','#ef4444','#22d3ee','#f97316'];
  const SECTIONS = [null, 'main', 'bar', 'patio'];

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:22,
        width:'100%', maxWidth:540, maxHeight:'90vh',
        display:'flex', flexDirection:'column', boxShadow:'var(--sh3)', overflow:'hidden',
      }}>
        <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--bdr)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div style={{ fontSize:16, fontWeight:800 }}>{isNew ? 'New device profile' : `Edit — ${profile.name}`}</div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--t3)', cursor:'pointer', fontSize:20 }}>×</button>
        </div>

        <div style={{ flex:1, overflowY:'auto', padding:'18px 20px' }}>
          {/* Name + colour */}
          <div style={{ marginBottom:16 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:6 }}>Profile name</label>
            <input style={{ width:'100%', background:'var(--bg3)', border:'1.5px solid var(--bdr2)', borderRadius:10, padding:'9px 12px', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box' }} value={form.name} onChange={e => upd('name', e.target.value)} placeholder="e.g. Bar terminal, Server handheld"/>
          </div>

          <div style={{ marginBottom:18 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Profile colour</label>
            <div style={{ display:'flex', gap:8 }}>
              {COLORS.map(c => (
                <button key={c} onClick={() => upd('color', c)} style={{
                  width:28, height:28, borderRadius:'50%', background:c, border:'none', cursor:'pointer',
                  outline: form.color === c ? `3px solid var(--t1)` : '3px solid transparent',
                  outlineOffset:2, transition:'outline .1s',
                }}/>
              ))}
            </div>
          </div>

          {/* Default surface */}
          <div style={{ marginBottom:18 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Default screen on startup</label>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
              {SURFACES.map(s => (
                <button key={s.id} onClick={() => upd('defaultSurface', s.id)} style={{
                  padding:'10px 12px', borderRadius:10, cursor:'pointer', fontFamily:'inherit',
                  textAlign:'left', transition:'all .1s',
                  background: form.defaultSurface === s.id ? 'var(--acc-d)' : 'var(--bg3)',
                  border:`1.5px solid ${form.defaultSurface === s.id ? 'var(--acc)' : 'var(--bdr)'}`,
                }}>
                  <div style={{ fontSize:13, fontWeight:700, color: form.defaultSurface === s.id ? 'var(--acc)' : 'var(--t1)', marginBottom:2 }}>{s.icon} {s.label}</div>
                  <div style={{ fontSize:10, color:'var(--t4)' }}>{s.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* MPOS-only options — only shown when default surface is MPOS */}
          {form.defaultSurface === 'mpos' && (
            <div style={{ marginBottom:18, padding:14, borderRadius:12, background:'var(--acc-d)', border:'1px solid var(--acc-b)' }}>
              <div style={{ fontSize:11, fontWeight:800, color:'var(--acc)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:10 }}>📱 MPOS settings</div>

              {/* Runner mode */}
              <label style={{ display:'flex', alignItems:'center', gap:10, cursor:'pointer', marginBottom:14 }}>
                <div onClick={() => upd('runnerMode', !form.runnerMode)} style={{
                  width:42, height:24, borderRadius:14, position:'relative', flexShrink:0,
                  background: form.runnerMode ? 'var(--grn)' : 'var(--bg4)', transition:'all .2s',
                }}>
                  <div style={{ width:18, height:18, borderRadius:'50%', background:'#fff', position:'absolute', top:3, left: form.runnerMode ? 21 : 3, transition:'left .2s' }}/>
                </div>
                <div>
                  <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>Runner mode</div>
                  <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>Restricts UI to delivery handoff (no order taking).</div>
                </div>
              </label>

              {/* Payment mode */}
              <div style={{ marginTop:6 }}>
                <div style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Payment mode</div>
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  {MPOS_PAYMENT_MODES.map(m => (
                    <button key={m.id} onClick={() => upd('paymentMode', m.id)} style={{
                      textAlign:'left', padding:'10px 12px', borderRadius:10, cursor:'pointer', fontFamily:'inherit',
                      background: form.paymentMode === m.id ? 'var(--bg2)' : 'transparent',
                      border:`1.5px solid ${form.paymentMode === m.id ? 'var(--acc)' : 'var(--bdr2)'}`,
                    }}>
                      <div style={{ fontSize:13, fontWeight:700, color: form.paymentMode === m.id ? 'var(--acc)' : 'var(--t1)' }}>{m.label}</div>
                      <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>{m.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Order types */}
          <div style={{ marginBottom:18 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Enabled order types</label>
            <div style={{ display:'flex', gap:8 }}>
              {ORDER_TYPES.map(t => {
                const on = (form.enabledOrderTypes || []).includes(t.id);
                return (
                  <button key={t.id} onClick={() => toggleOrderType(t.id)} style={{
                    flex:1, padding:'10px', borderRadius:10, cursor:'pointer', fontFamily:'inherit', textAlign:'center',
                    background: on ? 'var(--acc-d)' : 'var(--bg3)',
                    border:`1.5px solid ${on ? 'var(--acc)' : 'var(--bdr)'}`,
                    color: on ? 'var(--acc)' : 'var(--t3)', transition:'all .1s',
                  }}>
                    <div style={{ fontSize:18, marginBottom:2 }}>{t.icon}</div>
                    <div style={{ fontSize:11, fontWeight:700 }}>{t.label}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 30 Sep 2026 (Peter, Coffee Boy): what the till starts on, and the dine in flag prompt */}
          <TillOrderTypeSettings form={form} upd={upd}/>

          {/* Customer-facing display */}
          <div style={{ marginBottom:18 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Customer-facing display</label>
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {CUSTOMER_DISPLAY_MODES.map(m => {
                const on = (form.customerDisplayMode || 'auto') === m.id;
                return (
                  <button key={m.id} onClick={() => upd('customerDisplayMode', m.id)} style={{
                    textAlign:'left', padding:'10px 12px', borderRadius:10, cursor:'pointer', fontFamily:'inherit',
                    background: on ? 'var(--bg2)' : 'transparent',
                    border:`1.5px solid ${on ? 'var(--acc)' : 'var(--bdr2)'}`,
                  }}>
                    <div style={{ fontSize:13, fontWeight:700, color: on ? 'var(--acc)' : 'var(--t1)' }}>{m.label}</div>
                    <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>{m.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Customer display — idle slideshow images */}
          <div style={{ marginBottom:18 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Customer display — slideshow images</label>
            <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:8 }}>
              {(form.customerDisplayImages || []).map((url, i) => (
                <div key={i} style={{ position:'relative', width:88, height:58, borderRadius:8, overflow:'hidden', border:'1px solid var(--bdr2)' }}>
                  <img src={url} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }}/>
                  <button onClick={() => upd('customerDisplayImages', (form.customerDisplayImages || []).filter((_, j) => j !== i))}
                    style={{ position:'absolute', top:2, right:2, width:18, height:18, borderRadius:'50%', border:'none', background:'rgba(0,0,0,.7)', color:'#fff', cursor:'pointer', fontSize:11, lineHeight:'18px', padding:0 }}>✕</button>
                </div>
              ))}
              {(form.customerDisplayImages || []).length === 0 && (
                <div style={{ fontSize:12, color:'var(--t4)', alignSelf:'center' }}>No images — falls back to venue branding.</div>
              )}
            </div>
            <label style={{ display:'inline-block', padding:'8px 12px', borderRadius:8, border:'1px dashed var(--bdr2)', cursor:'pointer', fontSize:12, color:'var(--t2)', fontWeight:600 }}>
              {uploadingImg ? 'Uploading…' : '+ Add image'}
              <input type="file" accept="image/*" style={{ display:'none' }} disabled={uploadingImg}
                onChange={e => { const f = e.target.files?.[0]; if (f) uploadDisplayImage(f); e.target.value = ''; }}/>
            </label>
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:6 }}>Cycled as a slideshow when idle, and shown on the left half while an order is rung up.</div>
          </div>

          {/* Customer display branding (30 Sep 2026): its own look, separate from the kiosk's */}
          <DisplayBrandEditor
            ready={brandReady}
            brand={form.customerDisplayBrand}
            kiosk={form.kioskBrand}
            onChange={updBrand}
            onReplace={replaceBrand}
            onUploadLogo={uploadDisplayLogo}
            uploading={uploadingLogo}
          />

          {/* Section */}
          <div style={{ marginBottom:18 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Default floor section</label>
            <div style={{ display:'flex', gap:6 }}>
              {SECTIONS.map(s => (
                <button key={String(s)} onClick={() => upd('assignedSection', s)} style={{
                  padding:'7px 14px', borderRadius:9, cursor:'pointer', fontFamily:'inherit',
                  background: form.assignedSection === s ? 'var(--acc-d)' : 'var(--bg3)',
                  border:`1px solid ${form.assignedSection === s ? 'var(--acc)' : 'var(--bdr)'}`,
                  color: form.assignedSection === s ? 'var(--acc)' : 'var(--t3)',
                  fontSize:12, fontWeight:700, textTransform:'capitalize',
                }}>{s || 'All'}</button>
              ))}
            </div>
          </div>

          {/* Table service toggle */}
          <div style={{ marginBottom:18, display:'flex', justifyContent:'space-between', alignItems:'center', padding:'12px 14px', background:'var(--bg3)', borderRadius:10, border:'1px solid var(--bdr)' }}>
            <div>
              <div style={{ fontSize:13, fontWeight:600, color:'var(--t1)' }}>Table service</div>
              <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>Show floor plan, seat guests, manage covers</div>
            </div>
            <button onClick={() => upd('tableServiceEnabled', !form.tableServiceEnabled)} style={{
              width:44, height:24, borderRadius:12, border:'none', cursor:'pointer',
              background: form.tableServiceEnabled ? 'var(--grn)' : 'var(--bg4)', transition:'all .2s', flexShrink:0, position:'relative',
            }}>
              <div style={{ width:18, height:18, borderRadius:'50%', background:'#fff', position:'absolute', top:3, left: form.tableServiceEnabled ? 22 : 3, transition:'left .2s', boxShadow:'0 1px 3px rgba(0,0,0,.3)' }}/>
            </button>
          </div>

          {/* Auto-print receipt on close toggle */}
          <div style={{ marginBottom:18, display:'flex', justifyContent:'space-between', alignItems:'center', padding:'12px 14px', background:'var(--bg3)', borderRadius:10, border:'1px solid var(--bdr)' }}>
            <div>
              <div style={{ fontSize:13, fontWeight:600, color:'var(--t1)' }}>Auto-print receipt on close</div>
              <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>Print customer receipt automatically when payment completes. Staff can still untick per-transaction on the pay screen.</div>
            </div>
            <button onClick={() => upd('autoPrintReceiptOnClose', form.autoPrintReceiptOnClose === false)} style={{
              width:44, height:24, borderRadius:12, border:'none', cursor:'pointer',
              background: form.autoPrintReceiptOnClose !== false ? 'var(--grn)' : 'var(--bg4)', transition:'all .2s', flexShrink:0, position:'relative',
            }}>
              <div style={{ width:18, height:18, borderRadius:'50%', background:'#fff', position:'absolute', top:3, left: form.autoPrintReceiptOnClose !== false ? 22 : 3, transition:'left .2s', boxShadow:'0 1px 3px rgba(0,0,0,.3)' }}/>
            </button>
          </div>

          {/* v5.5.731: Sign-out behaviour — how a logged-in staff member is signed out on this device.
              Manual (tap another card / user-icon logout) always works; these are the automatic triggers. */}
          <div style={{ marginBottom:18, padding:'14px', background:'var(--bg3)', borderRadius:10, border:'1px solid var(--bdr)' }}>
            <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)', marginBottom:2 }}>Sign-out behaviour</div>
            <div style={{ fontSize:11, color:'var(--t3)', marginBottom:12 }}>How the signed-in staff member is signed out. Tapping another card or the logout icon always works — these add automatic sign-out.</div>

            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
              <div style={{ fontSize:12.5, fontWeight:600, color:'var(--t1)' }}>After inactivity</div>
              <select value={form.signoutIdleSeconds || 0} onChange={e => upd('signoutIdleSeconds', Number(e.target.value))}
                style={{ background:'var(--bg4)', border:'1.5px solid var(--bdr2)', borderRadius:8, padding:'6px 10px', color:'var(--t1)', fontSize:12.5, fontFamily:'inherit', cursor:'pointer' }}>
                {[[0,'Off'],[15,'15 seconds'],[30,'30 seconds'],[45,'45 seconds'],[60,'1 minute'],[90,'1½ minutes'],[120,'2 minutes'],[180,'3 minutes'],[300,'5 minutes']].map(([v,l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>

            {[['signoutOnPay','After taking payment','Sign out once a payment / check is cashed off'],
              ['signoutOnSend','After sending an order','Sign out once an order is sent to the kitchen']].map(([key,label,desc]) => (
              <div key={key} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:10 }}>
                <div>
                  <div style={{ fontSize:12.5, fontWeight:600, color:'var(--t1)' }}>{label}</div>
                  <div style={{ fontSize:11, color:'var(--t3)', marginTop:1 }}>{desc}</div>
                </div>
                <button onClick={() => upd(key, !form[key])} style={{ width:44, height:24, borderRadius:12, border:'none', cursor:'pointer', background: form[key] ? 'var(--grn)' : 'var(--bg4)', transition:'all .2s', flexShrink:0, position:'relative' }}>
                  <div style={{ width:18, height:18, borderRadius:'50%', background:'#fff', position:'absolute', top:3, left: form[key] ? 22 : 3, transition:'left .2s', boxShadow:'0 1px 3px rgba(0,0,0,.3)' }}/>
                </button>
              </div>
            ))}
          </div>

          {/* Order notifications toggle */}
          <div style={{ marginBottom:18, display:'flex', justifyContent:'space-between', alignItems:'center', padding:'12px 14px', background:'var(--bg3)', borderRadius:10, border:'1px solid var(--bdr)' }}>
            <div>
              <div style={{ fontSize:13, fontWeight:600, color:'var(--t1)' }}>Order notifications</div>
              <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>Show the new-order popup &amp; play the chime on this terminal when online, kiosk, QR or delivery orders arrive. Untick for terminals that shouldn't be alerted (the order still prints &amp; routes as normal).</div>
            </div>
            <button onClick={() => upd('orderNotifications', form.orderNotifications === false)} style={{
              width:44, height:24, borderRadius:12, border:'none', cursor:'pointer',
              background: form.orderNotifications !== false ? 'var(--grn)' : 'var(--bg4)', transition:'all .2s', flexShrink:0, position:'relative',
            }}>
              <div style={{ width:18, height:18, borderRadius:'50%', background:'#fff', position:'absolute', top:3, left: form.orderNotifications !== false ? 22 : 3, transition:'left .2s', boxShadow:'0 1px 3px rgba(0,0,0,.3)' }}/>
            </button>
          </div>

          {/* Service charge */}
          {(() => {
            const sc = form.serviceCharge || { enabled: false, rate: 12.5, applyTo: 'all', minCovers: 8 };
            const updSC = (k, v) => upd('serviceCharge', { ...sc, [k]: v });
            return (
              <div style={{ marginBottom:18, padding:'14px', background:'var(--bg3)', borderRadius:10, border:'1px solid var(--bdr)' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: sc.enabled ? 14 : 0 }}>
                  <div>
                    <div style={{ fontSize:13, fontWeight:600, color:'var(--t1)' }}>Service charge</div>
                    <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>Applies to dine-in table orders only</div>
                  </div>
                  <button onClick={() => updSC('enabled', !sc.enabled)} style={{
                    width:44, height:24, borderRadius:12, border:'none', cursor:'pointer',
                    background: sc.enabled ? 'var(--grn)' : 'var(--bg4)', transition:'all .2s', flexShrink:0, position:'relative',
                  }}>
                    <div style={{ width:18, height:18, borderRadius:'50%', background:'#fff', position:'absolute', top:3, left: sc.enabled ? 22 : 3, transition:'left .2s', boxShadow:'0 1px 3px rgba(0,0,0,.3)' }}/>
                  </button>
                </div>
                {sc.enabled && (
                  <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                      <label style={{ fontSize:12, color:'var(--t3)', flexShrink:0 }}>Rate</label>
                      <div style={{ display:'flex', alignItems:'center', gap:6, background:'var(--bg)', border:'1px solid var(--bdr)', borderRadius:8, padding:'6px 10px' }}>
                        <input type="number" min="0" max="100" step="0.5" value={sc.rate} onChange={e => updSC('rate', parseFloat(e.target.value)||0)}
                          style={{ width:50, border:'none', background:'transparent', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', textAlign:'right' }}/>
                        <span style={{ fontSize:12, color:'var(--t3)' }}>%</span>
                      </div>
                    </div>
                    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                      <label style={{ fontSize:12, color:'var(--t3)' }}>Apply to</label>
                      {[
                        { id:'all',       label:'All dine-in orders', desc:'Every table order' },
                        { id:'minCovers', label:'Minimum covers',     desc:`Only when covers ≥ threshold` },
                      ].map(opt => (
                        <button key={opt.id} onClick={() => updSC('applyTo', opt.id)} style={{
                          padding:'8px 12px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', textAlign:'left',
                          background: sc.applyTo === opt.id ? 'var(--acc-d)' : 'var(--bg)',
                          border:`1.5px solid ${sc.applyTo === opt.id ? 'var(--acc)' : 'var(--bdr)'}`,
                        }}>
                          <div style={{ fontSize:12, fontWeight:600, color:sc.applyTo===opt.id?'var(--acc)':'var(--t1)' }}>{opt.label}</div>
                          <div style={{ fontSize:10, color:'var(--t4)', marginTop:1 }}>{opt.desc}</div>
                        </button>
                      ))}
                    </div>
                    {sc.applyTo === 'minCovers' && (
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <label style={{ fontSize:12, color:'var(--t3)', flexShrink:0 }}>Minimum covers</label>
                        <div style={{ display:'flex', alignItems:'center', gap:6, background:'var(--bg)', border:'1px solid var(--bdr)', borderRadius:8, padding:'6px 10px' }}>
                          <input type="number" min="1" max="50" step="1" value={sc.minCovers} onChange={e => updSC('minCovers', parseInt(e.target.value)||1)}
                            style={{ width:40, border:'none', background:'transparent', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', textAlign:'right' }}/>
                          <span style={{ fontSize:12, color:'var(--t3)' }}>+</span>
                        </div>
                        <span style={{ fontSize:11, color:'var(--t4)' }}>covers to trigger service charge</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Menu assignment */}
          <div style={{ marginBottom:18 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Menu</label>
            <div style={{ fontSize:11, color:'var(--t4)', marginBottom:8 }}>Which menu this terminal shows. Create and manage menus in Menu Manager → Menus tab.</div>
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {[{ id:null, name:'All menus (default)', description:'Shows all categories from all menus' }, ...(menus||[])].map(m => (
                <button key={String(m.id)} onClick={()=>upd('menuId', m.id)}
                  style={{ padding:'9px 12px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', textAlign:'left', transition:'all .1s',
                    background: form.menuId === m.id ? 'var(--acc-d)' : 'var(--bg3)',
                    border:`1.5px solid ${form.menuId === m.id ? 'var(--acc)' : 'var(--bdr)'}` }}>
                  <div style={{ fontSize:12, fontWeight:700, color:form.menuId===m.id?'var(--acc)':'var(--t1)' }}>📋 {m.name}</div>
                  {m.description && <div style={{ fontSize:10, color:'var(--t4)', marginTop:2 }}>{m.description}</div>}
                </button>
              ))}
            </div>
          </div>

          {/* Hidden features */}
          <div style={{ marginBottom:4 }}>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Hide features from this terminal</label>
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {FEATURES.map(f => {
                const hidden = (form.hiddenFeatures || []).includes(f.id);
                return (
                  <div key={f.id} onClick={() => toggleFeature(f.id)} style={{
                    display:'flex', justifyContent:'space-between', alignItems:'center',
                    padding:'9px 12px', borderRadius:9, cursor:'pointer',
                    background: hidden ? 'var(--red-d)' : 'var(--bg3)',
                    border:`1px solid ${hidden ? 'var(--red-b)' : 'var(--bdr)'}`,
                    transition:'all .1s',
                  }}>
                    <div>
                      <div style={{ fontSize:12, fontWeight:600, color: hidden ? 'var(--red)' : 'var(--t1)' }}>{f.label}</div>
                      <div style={{ fontSize:11, color:'var(--t4)', marginTop:1 }}>{f.desc}</div>
                    </div>
                    <div style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:20, background: hidden ? 'var(--red)' : 'var(--bg4)', color: hidden ? '#fff' : 'var(--t4)', flexShrink:0 }}>
                      {hidden ? 'Hidden' : 'Visible'}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Master POS toggle */}
        <div style={{ margin:'0 20px 16px', padding:'14px 16px', borderRadius:12,
          background: form.isMaster ? 'rgba(234,179,8,0.1)' : 'var(--bg3)',
          border: `1.5px solid ${form.isMaster ? '#ca8a04' : 'var(--bdr)'}`,
          cursor:'pointer', transition:'all .2s' }}
          onClick={() => upd('isMaster', !form.isMaster)}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div>
              <div style={{ fontSize:13, fontWeight:700, color: form.isMaster ? '#ca8a04' : 'var(--t1)' }}>👑 Master POS</div>
              <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>Designate this terminal as the network master. Other devices monitor its heartbeat.</div>
            </div>
            <div style={{ width:36, height:20, borderRadius:10, background: form.isMaster ? '#ca8a04' : 'var(--bdr2)', position:'relative', flexShrink:0, transition:'background .2s' }}>
              <div style={{ position:'absolute', top:2, left: form.isMaster ? 18 : 2, width:16, height:16, borderRadius:'50%', background:'#fff', transition:'left .2s' }}/>
            </div>
          </div>
        </div>

        {/* Training Mode toggle — terminals on this profile commit NOTHING (no orders,
            payments, stock, receipts or kitchen tickets). For staff onboarding. */}
        <div style={{ margin:'0 20px 16px', padding:'14px 16px', borderRadius:12,
          background: form.trainingMode ? 'rgba(180,83,9,0.12)' : 'var(--bg3)',
          border: `1.5px solid ${form.trainingMode ? '#B45309' : 'var(--bdr)'}`,
          cursor:'pointer', transition:'all .2s' }}
          onClick={() => upd('trainingMode', !form.trainingMode)}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div>
              <div style={{ fontSize:13, fontWeight:700, color: form.trainingMode ? '#B45309' : 'var(--t1)' }}>🎓 Training mode</div>
              <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>Terminals on this profile work normally but commit NOTHING — no orders, card charges, stock changes, receipts or kitchen tickets. A banner shows on screen. For staff training.</div>
            </div>
            <div style={{ width:36, height:20, borderRadius:10, background: form.trainingMode ? '#B45309' : 'var(--bdr2)', position:'relative', flexShrink:0, transition:'background .2s' }}>
              <div style={{ position:'absolute', top:2, left: form.trainingMode ? 18 : 2, width:16, height:16, borderRadius:'50%', background:'#fff', transition:'left .2s' }}/>
            </div>
          </div>
        </div>

        <div style={{ padding:'12px 20px', borderTop:'1px solid var(--bdr)', display:'flex', gap:8, flexShrink:0 }}>
          {!isNew && onDelete && <button onClick={onDelete} style={{ padding:'8px 14px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)', fontSize:12, fontWeight:700 }}>Delete</button>}
          <button className="btn btn-ghost" style={{ flex:1 }} onClick={onClose}>Cancel</button>
          <button className="btn btn-acc" style={{ flex:2, height:42 }} disabled={!form.name.trim() || (form.enabledOrderTypes || []).length === 0 || badBrandColours.length > 0}
            title={badBrandColours.length ? 'Fix or clear the colour code in Customer display branding to save.' : undefined}
            onClick={() => onSave(form, touchedRef.current, profile)}>
            {isNew ? 'Create profile' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
