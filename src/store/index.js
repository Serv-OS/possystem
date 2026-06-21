import { create } from 'zustand';
import { supabase, platformSupabase, isMock, getLocationId, ensureAuthToken, getActiveLocationSync } from '../lib/supabase';
import { calculateOrderTax } from '../lib/tax';
import { resolveServiceCharge } from '../lib/serviceCharge';
import { upsertMenuItem, upsertFloorTable, deleteFloorTable, insertKDSTicket, insertClosedCheck, toggle86DB, getNextOrderRefLocal, updateClosedCheckRefunds, upsertStockLevel, deleteStockLevel, decrementStockRPC, restoreStockRPC } from '../lib/db';
import { printService } from '../lib/printer';
import { hubrisePushStock, isHubriseConnected } from '../lib/hubrise';

// ── Payment-intent normaliser ────────────────────────────────────────────────
// v5.5.323: a check can have MULTIPLE card PaymentIntents — one per card portion
// of a split. Collapse whatever the checkout flow handed us into a single array
// [{ id, amountMinor }] stored on the closed check, so refundCheck can refund
// every card leg back to its own card. Falls back to the legacy single-id field
// (single-card POS flow) so that path is byte-for-byte unchanged.
function derivePaymentIntents(paymentInfo = {}) {
  const list = Array.isArray(paymentInfo.paymentIntents) ? paymentInfo.paymentIntents : null;
  if (list && list.length) {
    const clean = list
      .filter(p => p && p.id)
      .map(p => ({ id: p.id, amountMinor: Number.isFinite(p.amountMinor) ? p.amountMinor : null }));
    return clean.length ? clean : null;
  }
  if (paymentInfo.stripePaymentIntentId) {
    return [{ id: paymentInfo.stripePaymentIntentId, amountMinor: Math.round((paymentInfo.grand || 0) * 100) || null }];
  }
  // Single-flow card-present (Stripe reader OR Ryft terminal) hands back the id
  // as `paymentIntentId` (for Ryft this is the ps_ payment-session id). Capture
  // it so the check is refundable; refundCheck routes by the check's processor.
  if (paymentInfo.paymentIntentId) {
    return [{ id: paymentInfo.paymentIntentId, amountMinor: Math.round((paymentInfo.grand || 0) * 100) || null }];
  }
  return null;
}

// Marketing promo → an entry in the closed_check.discounts jsonb (reuses the existing discount slot).
function promoDiscountEntry(promo) {
  if (!promo?.code) return [];
  return [{ source: 'promo', code: promo.code, name: promo.label || promo.code, type: promo.type, value: promo.value, amount: Number(promo.amount) || 0 }];
}

// ── Supabase helpers ─────────────────────────────────────────────────────────
const sbUpsertMenu = async (menu) => {
  if (isMock) return;
  const locationId = getActiveLocationSync() || await getLocationId();
  if (!locationId) return console.warn('[Supabase] no location ID — menu not saved');
  const { error } = await supabase.from('menus').upsert({
    id: menu.id,
    location_id: locationId,
    name: menu.name,
    description: menu.description || '',
    is_default: menu.isDefault || false,
    is_active: menu.isActive !== false,
    sort_order: menu.sortOrder || 0,
    // v4.6.4: schedule (timed menus) + priority (tiebreaker when multiple menus active)
    schedule:   menu.schedule ?? null,
    priority:   menu.priority ?? 0,
    // v4.6.0 sharing fields
    scope:      menu.scope    || 'local',
    org_id:     menu.orgId    ?? menu.org_id    ?? null,
    updated_at: new Date().toISOString(),
  });
  if (error) console.error('[Supabase] menus upsert error:', error);
};
const sbDeleteMenu = async (id) => {
  if (isMock) return;
  const locationId = getActiveLocationSync() || await getLocationId();
  // v5.5.279: location_id guard — never delete across tenants
  await supabase.from('menus').delete().eq('id', id).eq('location_id', locationId);
};
const sbUpsertCategory = async (cat) => {
  if (isMock) return;
  const locationId = getActiveLocationSync() || await getLocationId();
  if (!locationId) return console.warn('[Supabase] no location ID — category not saved');
  const { error } = await supabase.from('menu_categories').upsert({
    id: cat.id,
    location_id: locationId,
    menu_id: cat.menuId || null,
    parent_id: cat.parentId || null,
    label: cat.label,
    icon: cat.icon || '🍽',
    color: cat.color || '#3b82f6',
    accounting_group: cat.accountingGroup || '',
    sort_order: cat.sortOrder || 0,
    default_course: cat.defaultCourse ?? 1,
    spacer_slots: cat.spacerSlots ?? [],
    is_special: cat.isSpecial ?? cat.is_special ?? false,  // v5.5.316: persist so kiosk/online hide special cats
    updated_at: new Date().toISOString(),
  });
  if (error) console.error('[Supabase] menu_categories upsert error:', error);
};
const sbDeleteCategory = async (id) => {
  if (isMock) return;
  const locationId = getActiveLocationSync() || await getLocationId();
  // v5.5.279: location_id guard — never delete across tenants
  await supabase.from('menu_categories').delete().eq('id', id).eq('location_id', locationId);
};
const sbUpsertMenuItem = async (item) => {
  if (isMock) return;
  const locationId = getActiveLocationSync() || await getLocationId();
  if (!locationId) return console.warn('[Supabase] no location ID — item not saved');
  await supabase.from('menu_items').upsert({
    id: item.id, location_id: locationId, name: item.menuName||item.menu_name||item.name||'Item',
    menu_name: item.menuName||item.menu_name||item.name||'Item', receipt_name: item.receiptName||item.name,
    kitchen_name: item.kitchenName||item.name, description: item.description||'',
    type: item.type||'simple', cat: item.cat||null, cats: item.cats||[],
    parent_id: item.parentId||null, sort_order: item.sortOrder||0,
    pricing: item.pricing||{base:0}, allergens: item.allergens||[],
    assigned_modifier_groups: item.assignedModifierGroups||[],
    visibility: item.visibility||{pos:true,kiosk:true,online:true},
    sold_alone: item.soldAlone||false, archived: item.archived||false,
    updated_at: new Date().toISOString()
  });
};
import { INITIAL_KDS, SHIFT, MENU_ITEMS, CATEGORIES, STAFF as STAFF_SEED, QUICK_IDS } from '../data/seed';
import { money } from '../lib/currency';

// ─── ID helpers ──────────────────────────────────────────────────────────────
let _itemUid = 1;
const uid = () => `i${_itemUid++}`;
let _orderNum = 1000;
let _tabNum   = 1;

const CAT_COURSE = { starters:1, mains:2, pizza:2, sides:2, desserts:3, drinks:0, cocktails:0, quick:1 };

// ─── Tables with static config + runtime session ──────────────────────────────
// session: null | { id, items[], firedCourses[], sentAt, server, covers, seatedAt, note }
const TABLES_CONFIG = [
  { id:'t1',  label:'T1',        maxCovers:2, shape:'sq', x:18,  y:30,  w:70,  h:60,  section:'main'  },
  { id:'t2',  label:'T2',        maxCovers:4, shape:'sq', x:110, y:30,  w:80,  h:60,  section:'main'  },
  { id:'t3',  label:'T3',        maxCovers:2, shape:'sq', x:214, y:30,  w:70,  h:60,  section:'main'  },
  { id:'t4',  label:'T4',        maxCovers:4, shape:'sq', x:306, y:30,  w:80,  h:60,  section:'main'  },
  { id:'t5',  label:'T5',        maxCovers:3, shape:'rd', x:18,  y:118, w:78,  h:78,  section:'main'  },
  { id:'t6',  label:'T6',        maxCovers:3, shape:'rd', x:120, y:118, w:78,  h:78,  section:'main'  },
  { id:'t7',  label:'Banquette', maxCovers:8, shape:'sq', x:224, y:120, w:150, h:68,  section:'main'  },
  { id:'t8',  label:'T8',        maxCovers:2, shape:'sq', x:18,  y:220, w:68,  h:60,  section:'main'  },
  { id:'t9',  label:'T9',        maxCovers:4, shape:'sq', x:108, y:220, w:80,  h:60,  section:'main'  },
  { id:'t10', label:'T10',       maxCovers:4, shape:'sq', x:208, y:220, w:80,  h:60,  section:'main'  },
  { id:'b1',  label:'B1',        maxCovers:1, shape:'rd', x:415, y:30,  w:50,  h:50,  section:'bar'   },
  { id:'b2',  label:'B2',        maxCovers:1, shape:'rd', x:415, y:96,  w:50,  h:50,  section:'bar'   },
  { id:'b3',  label:'B3',        maxCovers:1, shape:'rd', x:415, y:162, w:50,  h:50,  section:'bar'   },
  { id:'b4',  label:'B4',        maxCovers:1, shape:'rd', x:415, y:228, w:50,  h:50,  section:'bar'   },
  { id:'p1',  label:'P1',        maxCovers:4, shape:'sq', x:500, y:30,  w:78,  h:64,  section:'patio' },
  { id:'p2',  label:'P2',        maxCovers:4, shape:'sq', x:500, y:118, w:78,  h:64,  section:'patio' },
  { id:'p3',  label:'P3',        maxCovers:6, shape:'sq', x:500, y:206, w:90,  h:68,  section:'patio' },
];

// Seed with a couple of occupied tables for demo
function buildInitialTables() {
  return TABLES_CONFIG.map(t => {
    const base = { ...t, status:'available', session:null, reservation:null };
    if (t.id==='t2') return { ...base, status:'occupied', session:{ id:'ORD-DEMO1', items:[
      { uid:'d1', itemId:'m-soup',    name:'Soup of the day',  price:6.5,  qty:2, mods:[], notes:'', allergens:['gluten','milk'], course:1, fired:true, status:'sent', seat:'shared' },
      { uid:'d2', itemId:'m-salmon',  name:'Grilled salmon',   price:19.0, qty:2, mods:[], notes:'', allergens:['fish','milk'],   course:2, fired:true, status:'sent', seat:'shared' },
      { uid:'d3', itemId:'m-hwine-250',name:'House white 250ml',price:8.5, qty:1, mods:[], notes:'', allergens:['sulphites'],    course:0, fired:true, status:'sent', seat:'shared' },
    ], firedCourses:[0,1], sentAt:Date.now()-18*60000, server:'Sarah', covers:2, seatedAt:Date.now()-22*60000, note:'', orderNote:'' } };
    if (t.id==='t5') return { ...base, status:'occupied', session:{ id:'ORD-DEMO2', items:[
      { uid:'d4', itemId:'m-rib8',    name:'8oz Ribeye',       price:28.0, qty:1, mods:[{label:'Side: Chips',price:0},{label:'Sauce: Peppercorn',price:0}], notes:'', allergens:['milk'], course:2, fired:true, status:'sent', seat:'shared' },
      { uid:'d5', itemId:'m-sir6',    name:'6oz Sirloin',      price:22.0, qty:1, mods:[{label:'Side: Side salad',price:0},{label:'Cooking: Medium rare',price:0}], notes:'', allergens:['milk'], course:2, fired:true, status:'sent', seat:'shared' },
      { uid:'d6', itemId:'m-hrwine-175',name:'House red 175ml',price:6.5,  qty:2, mods:[], notes:'', allergens:['sulphites'], course:0, fired:true, status:'sent', seat:'shared' },
    ], firedCourses:[0,2], sentAt:Date.now()-35*60000, server:'Tom', covers:2, seatedAt:Date.now()-40*60000, note:'', orderNote:'' } };
    if (t.id==='t3') return { ...base, status:'reserved', reservation:{ name:'Johnson party', phone:'07700 900111', time:'7:30 PM', partySize:2 } };
    if (t.id==='p2') return { ...base, status:'reserved', reservation:{ name:'Chen table',   phone:'07700 900222', time:'8:00 PM', partySize:4 } };
    return base;
  });
}

// ─── Utility: recalc session totals ──────────────────────────────────────────
function calcSessionTotals(session) {
  if (!session) return null;
  const subtotal = session.items.reduce((s,i) => s + i.price * i.qty, 0);
  return { ...session, subtotal, total: subtotal * 1.125 };
}

export function getCollectionSlots() {
  const slots = [], now = new Date(), start = new Date(now);
  start.setMinutes(Math.ceil((now.getMinutes()+15)/15)*15, 0, 0);
  for (let i=0; i<12; i++) {
    const t = new Date(start.getTime() + i*15*60000);
    slots.push({ value:t.toISOString(), label:t.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}), isASAP:i===0 });
  }
  return slots;
}

// ─── Store ────────────────────────────────────────────────────────────────────
// Restore back-office config from localStorage — ONLY in mock mode
// In real mode, data comes from Supabase (loaded in BackOfficeApp on mount)
const _isMockMode = import.meta.env.VITE_USE_MOCK === 'true';
const _savedBO = (() => {
  if (!_isMockMode) return {}; // real mode: always load from Supabase
  try { return JSON.parse(localStorage.getItem('rpos-bo-config')||'{}'); } catch { return {}; }
})();

export const useStore = create((set, get) => ({

  // ── Location integrity (v5.5.238) ─────────
  // Stamps which location the in-memory data belongs to. SyncBridge sets this
  // after loading data. If a subsequent boot detects a mismatch, it purges
  // stale data BEFORE loading fresh — preventing cross-location bleed.
  _dataLocationId: null,

  // ── Auth ──────────────────────────────────
  staff: null,
  staffMembers: isMock ? STAFF_SEED : [],
  addStaffMember:    s    => set(st => ({ staffMembers: [...st.staffMembers, { ...s, id:`s-${Date.now()}` }] })),
  updateStaffMember: (id,patch) => set(st => ({ staffMembers: st.staffMembers.map(s => s.id===id ? {...s,...patch} : s) })),
  removeStaffMember: id  => set(st => ({ staffMembers: st.staffMembers.filter(s => s.id!==id) })),
  login:  s => set({ staff:s }),
  logout: () => set({ staff:null, activeTableId:null, orderType:'dine-in', customer:null }),

  // ── Navigation ────────────────────────────
  surface: (() => {
    // Apply defaultSurface from device config on startup
    try {
      const dc = JSON.parse(localStorage.getItem('rpos-device-config') || 'null');
      if (dc?.defaultSurface) return dc.defaultSurface;
    } catch {}
    return 'tables';
  })(),
  setSurface: s => set({ surface:s }),

  // ── Back Office config push workflow ────────────────────────────────────────
  // pendingBOChanges: count of BO changes not yet pushed to POS
  // configVersion: incremented on each push — POS compares this to know if it's stale
  // Print routing config — read from localStorage, updated via Push to POS
  printRouting: (() => {
    try { return JSON.parse(localStorage.getItem('rpos-print-routing') || 'null') || { centres:[], routing:{} }; }
    catch { return { centres:[], routing:{} }; }
  })(),

  // configUpdateAvailable: true on POS when a push has been received but not applied
  // configUpdateSnapshot: the incoming config snapshot waiting to be applied
  pendingBOChanges: 0,
  configVersion: 0,
  configUpdateAvailable: false,
  configUpdateSnapshot: null,
  markBOChange: () => set(s => ({ pendingBOChanges: s.pendingBOChanges + 1 })),
  clearBOChanges: () => set({ pendingBOChanges: 0 }),
  setConfigUpdate: (snapshot) => set({ configUpdateAvailable: true, configUpdateSnapshot: snapshot }),
  applyConfigUpdate: () => {
    const snap = useStore.getState().configUpdateSnapshot;
    if (!snap) return;

    // Tables: merge layout into existing live tables, AND add new tables from snapshot
    let updatedTables = useStore.getState().tables;
    if (snap.tables) {
      // v5.5.2: preserve table.locationId on every merge path so the cross-location upsert
      // guard has data to work with. Config snapshots may have a top-level snap.locationId
      // that the snapshot was generated for; fall back to that if the individual table row
      // doesn't carry it explicitly.
      const snapLoc = snap.locationId || null;
      // Update layout of existing tables
      updatedTables = updatedTables.map(t => {
        const st = snap.tables.find(s => s.id === t.id);
        return st ? { ...t, label:st.label, x:st.x, y:st.y, w:st.w, h:st.h, shape:st.shape, maxCovers:st.maxCovers, section:st.section, locationId: st.locationId ?? st.location_id ?? t.locationId ?? snapLoc } : t;
      });
      // Add new tables that exist in snapshot but not in store
      const existingIds = new Set(updatedTables.map(t => t.id));
      const newTables = snap.tables
        .filter(st => !existingIds.has(st.id))
        .map(st => ({ ...st, locationId: st.locationId ?? st.location_id ?? snapLoc, status:'available', session:null, firedCourses:[], sentAt:null }));
      updatedTables = [...updatedTables, ...newTables];
    }

    set({
      tables: updatedTables,
      // Sections
      locationSections: snap.locationSections || useStore.getState().locationSections,
      // Menu items — full replace with pushed version
      ...(snap.menuItems ? { menuItems: snap.menuItems } : {}),
      // Menus list
      ...(snap.menus ? { menus: snap.menus } : {}),
      // Menu categories — full replace
      ...(snap.menuCategories ? { menuCategories: snap.menuCategories } : {}),
      // Tax rates — full replace
      ...(snap.taxRates?.length ? { taxRates: snap.taxRates } : {}),
      // Discount presets + rules — full replace
      ...(snap.discountPresets ? { discountPresets: snap.discountPresets } : {}),
      ...(snap.discountRules ? { discountRules: snap.discountRules } : {}),
      // Modifier + instruction groups — full replace
      ...(snap.modifierGroupDefs ? { modifierGroupDefs: snap.modifierGroupDefs } : {}),
      ...(snap.instructionGroupDefs ? { instructionGroupDefs: snap.instructionGroupDefs } : {}),

      // Print routing config from back office
      ...(snap.printRouting ? { printRouting: snap.printRouting } : {}),

      configVersion: snap.version,
      configUpdateAvailable: false,
      configUpdateSnapshot: null,
    });
    // Persist print routing to localStorage so it survives reload
    if (snap.printRouting) {
      try { localStorage.setItem('rpos-print-routing', JSON.stringify(snap.printRouting)); } catch {}
    }
    // Sync printers registry to this device so FOH and print service can read them
    if (snap.printers?.length) {
      try { localStorage.setItem('rpos-printers', JSON.stringify(snap.printers)); } catch {}
      try { window.dispatchEvent(new Event('rpos-printers-updated')); } catch {}
    }
    try { sessionStorage.setItem('rpos-config-version', String(snap.version)); } catch {}
  },
  locationSections: [
    { id:'main',  label:'Main dining', color:'#3b82f6', icon:'🍽' },
    { id:'bar',   label:'Bar',         color:'#e8a020', icon:'🍸' },
    { id:'patio', label:'Patio',       color:'#22c55e', icon:'🌿' },
  ],
  addSection: (section) => set(s => ({ locationSections: [...s.locationSections, { id:`sec-${Date.now()}`, ...section }] })),
  updateSection: (id, patch) => set(s => ({ locationSections: s.locationSections.map(sec => sec.id===id ? { ...sec, ...patch } : sec) })),
  removeSection: (id) => set(s => ({
    locationSections: s.locationSections.filter(sec => sec.id !== id),
    // Move tables in deleted section to 'main'
    tables: s.tables.map(t => t.section===id ? { ...t, section:'main' } : t),
  })),
  // v4.6.56: reorder a section by moving it up or down within the array.
  moveSection: (id, direction) => set(s => {
    const arr = [...(s.locationSections || [])];
    const idx = arr.findIndex(sec => sec.id === id);
    if (idx < 0) return s;
    const target = direction === 'up' ? idx - 1 : idx + 1;
    if (target < 0 || target >= arr.length) return s;
    [arr[idx], arr[target]] = [arr[target], arr[idx]];
    return { locationSections: arr };
  }),

  // ── Sync status — tracks whether POS config is current ───────────────────
  syncStatus: {
    lastConfigChange: null,      // timestamp when BO last pushed a change
    lastTerminalSync: Date.now(), // timestamp when this terminal last received config
    pendingChanges: false,
    printerOnline: true,
    paymentTerminalOnline: true,
    kdsOnline: true,
  },
  setSyncStatus: (patch) => set(s => ({ syncStatus: { ...s.syncStatus, ...patch } })),
  markConfigChanged: () => set(s => ({
    syncStatus: { ...s.syncStatus, lastConfigChange: Date.now(), pendingChanges: true }
  })),
  markTerminalSynced: () => set(s => ({
    syncStatus: { ...s.syncStatus, lastTerminalSync: Date.now(), pendingChanges: false }
  })),
  appMode: 'pos',
  setAppMode: mode => set({ appMode: mode }),

  // ── Organisations & Locations ──────────────────────────────────────────────
  currentLocationId: 'loc-demo',
  locations: [
    { id:'loc-demo', name:'The Anchor — High Street', address:'1 High Street, London EC1A 1BB', timezone:'Europe/London', currency:'GBP', vat:20, serviceCharge:12.5, plan:'standard', isActive:true, receiptHeader:'', receiptFooter:'Thank you for dining with us!', createdAt:Date.now() },
  ],
  setCurrentLocation: id => set({ currentLocationId: id }),
  addLocation: loc => set(s => ({ locations: [...s.locations, loc] })),
  updateLocation: (id, patch) => set(s => ({ locations: s.locations.map(l => l.id===id ? { ...l,...patch } : l) })),
  removeLocation: id => set(s => ({ locations: s.locations.filter(l => l.id!==id) })),

  // ── Device config — uses sessionStorage so each browser tab is a separate terminal
  // URL param ?t=bar or ?t=counter2 overrides on load (for testing)
  // In Phase 2: loaded from Supabase by device ID on pairing
  deviceConfig: (() => {
    try {
      // Check URL param first — ?t=bar, ?t=counter, ?t=handheld etc.
      const urlParam = new URLSearchParams(window.location.search).get('t');
      const PRESET_PROFILES = {
        'counter':  { terminalName:'Counter 1',  profileName:'Main counter',    defaultSurface:'tables', enabledOrderTypes:['dine-in','takeaway','collection'], assignedSection:null,  hiddenFeatures:[],                    tableServiceEnabled:true,  quickScreenEnabled:true },
        'counter2': { terminalName:'Counter 2',  profileName:'Main counter',    defaultSurface:'tables', enabledOrderTypes:['dine-in','takeaway','collection'], assignedSection:null,  hiddenFeatures:[],                    tableServiceEnabled:true,  quickScreenEnabled:true },
        'bar':      { terminalName:'Bar',        profileName:'Bar terminal',     defaultSurface:'bar',    enabledOrderTypes:['dine-in'],                         assignedSection:'bar', hiddenFeatures:['courses','reports'], tableServiceEnabled:false, quickScreenEnabled:true, menuId:'menu-2' },
        'handheld': { terminalName:'Handheld 1', profileName:'Server handheld', defaultSurface:'pos',    enabledOrderTypes:['dine-in'],                         assignedSection:null,  hiddenFeatures:['reports','kiosk'],   tableServiceEnabled:true,  quickScreenEnabled:true },
        'kiosk':    { terminalName:'Kiosk 1',    profileName:'Kiosk',           defaultSurface:'pos',    enabledOrderTypes:['dine-in','takeaway'],               assignedSection:null,  hiddenFeatures:['reports','staff'],   tableServiceEnabled:false, quickScreenEnabled:true },
        'kds':      { terminalName:'KDS',        profileName:'Kitchen display',  defaultSurface:'kds',   enabledOrderTypes:[],                                   assignedSection:null,  hiddenFeatures:['reports'],           tableServiceEnabled:false, quickScreenEnabled:false },
      };
      if (urlParam && PRESET_PROFILES[urlParam]) {
        const config = { ...PRESET_PROFILES[urlParam], source:'url-param', param:urlParam };
        try { sessionStorage.setItem('rpos-terminal-config', JSON.stringify(config)); } catch {}
        return config;
      }
      // Then check sessionStorage (tab-specific — each tab is a separate terminal)
      const saved = sessionStorage.getItem('rpos-terminal-config');
      if (saved) {
        const cfg = JSON.parse(saved);
        // Backfill serviceCharge from stored profiles if missing
        if (!cfg.serviceCharge && cfg.profileId) {
          const profiles = JSON.parse(localStorage.getItem('rpos-device-profiles') || '[]');
          const match = profiles.find(p => p.id === cfg.profileId);
          if (match?.serviceCharge) cfg.serviceCharge = match.serviceCharge;
        }
        return cfg;
      }
      // Fall back to localStorage device config (set when device was paired/profiled)
      const localConfig = localStorage.getItem('rpos-device-config');
      if (localConfig) {
        const cfg = JSON.parse(localConfig);
        // Backfill serviceCharge from stored profiles if missing
        if (!cfg.serviceCharge && cfg.profileId) {
          const profiles = JSON.parse(localStorage.getItem('rpos-device-profiles') || '[]');
          const match = profiles.find(p => p.id === cfg.profileId);
          if (match?.serviceCharge) cfg.serviceCharge = match.serviceCharge;
        }
        return cfg;
      }
      return null;
    } catch { return null; }
  })(),
  setDeviceConfig: (config) => {
    // Always backfill serviceCharge from stored profiles if the config is missing it
    let finalConfig = config;
    if (config && !config.serviceCharge && config.profileId) {
      try {
        const profiles = JSON.parse(localStorage.getItem('rpos-device-profiles') || '[]');
        const match = profiles.find(p => p.id === config.profileId);
        if (match?.serviceCharge) finalConfig = { ...config, serviceCharge: match.serviceCharge };
      } catch {}
    }
    try { sessionStorage.setItem('rpos-terminal-config', JSON.stringify(finalConfig)); } catch {}
    set({ deviceConfig: finalConfig });
    if (finalConfig?.defaultSurface) set({ surface: finalConfig.defaultSurface });
  },
  clearDeviceConfig: () => {
    try { sessionStorage.removeItem('rpos-terminal-config'); } catch {}
    set({ deviceConfig: null });
  },

  // ── Registered POS terminals ───────────────────────────────────────────────
  devices: isMock ? [
    { id:'dev-1', label:'Counter 1', type:'counter', section:'main', status:'online', hardwareModel:'Sunmi T2s', ipAddress:'192.168.1.10' },
    { id:'dev-2', label:'Counter 2', type:'counter', section:'bar',  status:'offline',hardwareModel:'Sunmi T2s', ipAddress:'192.168.1.11' },
    { id:'dev-3', label:'Handheld 1',type:'handheld',section:'main', status:'online', hardwareModel:'Sunmi V2s', ipAddress:'192.168.1.20' },
  ] : [],
  addDevice: (device) => set(s => ({ devices:[...s.devices, { id:`dev-${Date.now()}`, status:'offline', ...device }] })),
  updateDevice: (id, patch) => set(s => ({ devices:s.devices.map(d=>d.id===id?{...d,...patch}:d) })),
  removeDevice: (id) => set(s => ({ devices:s.devices.filter(d=>d.id!==id) })),

  // ── Menus (multiple menus per location, assigned to device profiles) ─────────
  menus: _savedBO.menus || (isMock ? [
    { id:'menu-1', name:'Main menu',    description:'Full food and drinks', scope:'local', assignedProfiles:[], isDefault:true,  isActive:true, sortOrder:0 },
    { id:'menu-2', name:'Bar menu',     description:'Drinks and bar snacks',scope:'local', assignedProfiles:['prof-2'],isDefault:false, isActive:true, sortOrder:1 },
    { id:'menu-3', name:'Lunch menu',   description:'Midday menu',          scope:'local', assignedProfiles:[], isDefault:false, isActive:true, sortOrder:2 },
  ] : []),
  activeMenuId: 'menu-1',
  setActiveMenuId: id => set({ activeMenuId: id }),
  addMenu: menu => {
    const newMenu = { id:`menu-${Date.now()}`, ...menu };
    set(s => ({ menus: [...s.menus, newMenu] }));
    sbUpsertMenu(newMenu);
  },
  updateMenu: (id, patch) => {
    set(s => ({ menus: s.menus.map(m => m.id===id ? { ...m, ...patch } : m) }));
    const updated = useStore.getState().menus.find(m => m.id===id);
    if (updated) sbUpsertMenu(updated);
  },
  removeMenu: id => {
    set(s => ({ menus: s.menus.filter(m => m.id!==id) }));
    sbDeleteMenu(id);
  },

  // ── Categories (hierarchical — parentId for subcategories) ───────────────────
  // accountingGroup → for financial reporting (P&L, tax)
  // statisticGroup  → for operational reporting (bestsellers, waste)
  menuCategories: _savedBO.menuCategories || (isMock ? [
    // ── The Anchor — category tree ──────────────────────────────────────────
    // Root categories
    { id:'cat-starters',  menuId:'menu-1', parentId:null, label:'Starters',  icon:'🥗', color:'#22c55e', accountingGroup:'Food',      sortOrder:0 },
    { id:'cat-mains',     menuId:'menu-1', parentId:null, label:'Mains',     icon:'🍖', color:'#e8a020', accountingGroup:'Food',      sortOrder:1 },
    { id:'cat-pizza',     menuId:'menu-1', parentId:null, label:'Pizza',     icon:'🍕', color:'#f97316', accountingGroup:'Food',      sortOrder:2 },
    { id:'cat-desserts',  menuId:'menu-1', parentId:null, label:'Desserts',  icon:'🎂', color:'#ec4899', accountingGroup:'Food',      sortOrder:3 },
    { id:'cat-drinks',    menuId:'menu-1', parentId:null, label:'Drinks',    icon:'🍸', color:'#a855f7', accountingGroup:'Beverages', sortOrder:4 },
    { id:'cat-hot',       menuId:'menu-1', parentId:null, label:'Hot drinks',icon:'☕', color:'#78716c', accountingGroup:'Beverages', sortOrder:5 },
    // Mains subcategories
    { id:'cat-grills',    menuId:'menu-1', parentId:'cat-mains',  label:'From the grill', icon:'🥩', color:'#ef4444', accountingGroup:'Food',      sortOrder:0 },
    { id:'cat-fish',      menuId:'menu-1', parentId:'cat-mains',  label:'Fish',           icon:'🐟', color:'#3b82f6', accountingGroup:'Food',      sortOrder:1 },
    { id:'cat-veggie',    menuId:'menu-1', parentId:'cat-mains',  label:'Vegetarian',     icon:'🌿', color:'#22c55e', accountingGroup:'Food',      sortOrder:2 },
    // Drinks subcategories
    { id:'cat-draught',   menuId:'menu-1', parentId:'cat-drinks', label:'Draught beer', icon:'🍺', color:'#e8a020', accountingGroup:'Beverages', sortOrder:0 },
    { id:'cat-wine',      menuId:'menu-1', parentId:'cat-drinks', label:'Wine',         icon:'🍷', color:'#8b1e3f', accountingGroup:'Beverages', sortOrder:1 },
    { id:'cat-softs',     menuId:'menu-1', parentId:'cat-drinks', label:'Soft drinks',  icon:'🥤', color:'#22d3ee', accountingGroup:'Beverages', sortOrder:2 },

    // ── Bar menu (menu-2) ───────────────────────────────────────────────────
    { id:'bcat-draught',  menuId:'menu-2', parentId:null, label:'Draught',      icon:'🍺', color:'#e8a020', accountingGroup:'Beverages', sortOrder:0 },
    { id:'bcat-wine',     menuId:'menu-2', parentId:null, label:'Wine',         icon:'🍷', color:'#8b1e3f', accountingGroup:'Beverages', sortOrder:1 },
    { id:'bcat-spirits',  menuId:'menu-2', parentId:null, label:'Spirits',      icon:'🥃', color:'#a855f7', accountingGroup:'Beverages', sortOrder:2 },
    { id:'bcat-softs',    menuId:'menu-2', parentId:null, label:'Soft drinks',  icon:'🥤', color:'#22d3ee', accountingGroup:'Beverages', sortOrder:3 },
    { id:'bcat-hot',      menuId:'menu-2', parentId:null, label:'Hot drinks',   icon:'☕', color:'#78716c', accountingGroup:'Beverages', sortOrder:4 },
    { id:'bcat-snacks',   menuId:'menu-2', parentId:null, label:'Bar snacks',   icon:'🍟', color:'#22c55e', accountingGroup:'Food',      sortOrder:5 },
  ] : []),
  addCategory: cat => {
    const newCat = { id:`cat-${Date.now()}`, ...cat };
    set(s => ({ menuCategories: [...s.menuCategories, newCat] }));
    sbUpsertCategory(newCat);
  },
  updateCategory: (id, patch) => {
    set(s => ({ menuCategories: s.menuCategories.map(c => c.id===id ? { ...c, ...patch } : c) }));
    const updated = useStore.getState().menuCategories.find(c => c.id===id);
    if (updated) sbUpsertCategory(updated);
  },
  removeCategory: id => {
    set(s => ({ menuCategories: s.menuCategories.filter(c => c.id!==id) }));
    sbDeleteCategory(id);
  },

  // ── Modifier library — create modifiers here, add to groups ─────────────────
  modifierLibrary: [
    { id:'ml-1',  name:'Rare',           price:0,    category:'Cooking',   allergens:[] },
    { id:'ml-2',  name:'Medium rare',    price:0,    category:'Cooking',   allergens:[] },
    { id:'ml-3',  name:'Medium',         price:0,    category:'Cooking',   allergens:[] },
    { id:'ml-4',  name:'Medium well',    price:0,    category:'Cooking',   allergens:[] },
    { id:'ml-5',  name:'Well done',      price:0,    category:'Cooking',   allergens:[] },
    { id:'ml-6',  name:'Peppercorn',     price:0,    category:'Sauce',     allergens:['milk'] },
    { id:'ml-7',  name:'Béarnaise',      price:0,    category:'Sauce',     allergens:['eggs','milk'] },
    { id:'ml-8',  name:'Chimichurri',    price:0,    category:'Sauce',     allergens:[] },
    { id:'ml-9',  name:'No sauce',       price:0,    category:'Sauce',     allergens:[] },
    { id:'ml-10', name:'Truffle oil',    price:3.50, category:'Extra',     allergens:[] },
    { id:'ml-11', name:'Extra pancetta', price:2.50, category:'Extra',     allergens:[] },
    { id:'ml-12', name:'Side salad',     price:0,    category:'Side swap', allergens:[] },
    { id:'ml-13', name:'Mac & cheese',   price:3.00, category:'Side swap', allergens:['gluten','milk','eggs'] },
    { id:'ml-14', name:'Chips',          price:0,    category:'Side swap', allergens:['gluten'] },
    { id:'ml-15', name:'Gluten-free base',price:2.00,category:'Pizza base', allergens:[] },
    { id:'ml-16', name:'Sourdough base', price:0,    category:'Pizza base', allergens:['gluten'] },
    { id:'ml-17', name:'With bread',     price:0,    category:'Bread',     allergens:['gluten'] },
    { id:'ml-18', name:'No bread',       price:0,    category:'Bread',     allergens:[] },
  ],
  addModifier: mod => set(s => ({ modifierLibrary: [...s.modifierLibrary, { id:`ml-${Date.now()}`, ...mod }] })),
  updateModifier: (id, patch) => set(s => ({ modifierLibrary: s.modifierLibrary.map(m => m.id===id ? {...m,...patch} : m) })),
  removeModifier: id => set(s => ({ modifierLibrary: s.modifierLibrary.filter(m => m.id!==id) })),

  // ── Modifier groups — reusable paid option groups ─────────────────────────
  // These change the price. Assigned to items in the Product Builder.
  modifierGroupDefs: isMock ? [
    // Options reference sub item IDs from MENU_ITEMS (type:'subitem')
    { id:'mgd-sides',        name:'Side choice',       min:1, max:1,
      options:[
        {id:'sub-chips',   name:'Chips',               price:0,   soldAlone:true,  soldAloneCat:'cat-starters'},
        {id:'sub-salad',   name:'Side salad',          price:0,   soldAlone:true,  soldAloneCat:'cat-starters'},
        {id:'sub-spfries', name:'Sweet potato fries',  price:1.5, soldAlone:true,  soldAloneCat:'cat-starters'},
        {id:'sub-mash',    name:'Creamy mash',         price:0,   soldAlone:false},
      ]},
    { id:'mgd-sauces',       name:'Sauce',              min:0, max:1,
      options:[
        {id:'sub-pepper',  name:'Peppercorn sauce',    price:0, subGroupId:'mgd-sauce-temp'},
        {id:'sub-bearn',   name:'Béarnaise',           price:0},
        {id:'sub-chimich', name:'Chimichurri',         price:0},
        {id:'sub-nosace',  name:'No sauce',            price:0},
      ]},
    { id:'mgd-sauce-temp',   name:'Sauce preference',   min:0, max:1,
      options:[
        {id:'sub-st-hot',  name:'Served hot',          price:0},
        {id:'sub-st-side', name:'On the side',         price:0},
      ]},
    { id:'mgd-pizza-extras', name:'Pizza extras',       min:0, max:5,
      options:[
        {id:'sub-extra-ch',  name:'Extra cheese',      price:1.5},
        {id:'sub-extra-pep', name:'Extra pepperoni',   price:1.5},
        {id:'sub-truffle',   name:'Truffle oil',       price:3.0},
      ]},
    { id:'mgd-milk',         name:'Milk choice',        min:1, max:1,
      options:[
        {id:'sub-whole',   name:'Whole milk',          price:0},
        {id:'sub-oat',     name:'Oat milk',            price:0.5},
        {id:'sub-almond',  name:'Almond milk',         price:0.5},
        {id:'sub-soy',     name:'Soy milk',            price:0.5},
      ]},
  ] : [],
  // Helper: persist a modifier group to Supabase (upsert by id)
  _saveModGroup: async (group) => {
    if (isMock) return;
    try {
      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
      const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
      const locId = getActiveLocationSync() || await getLocationId();
      await fetch(`${SUPABASE_URL}/rest/v1/modifier_groups?on_conflict=id`, {
        method: 'POST',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ id: group.id, location_id: locId, name: group.name, min: group.min ?? 0, max: group.max ?? 1, selection_type: group.selectionType || 'single', options: group.options || [], sort_order: group.sortOrder || 0 }]),
      });
    } catch (e) { console.warn('modifier group save failed', e); }
  },

  addModifierGroupDef: g => {
    const newGroup = { id: `mgd-${Date.now()}`, ...g };
    set(s => ({ modifierGroupDefs: [...s.modifierGroupDefs, newGroup] }));
    useStore.getState()._saveModGroup(newGroup);
  },
  updateModifierGroupDef: (id, patch) => set(s => {
    const updated = s.modifierGroupDefs.map(g => g.id === id ? { ...g, ...patch } : g);
    const group = updated.find(g => g.id === id);
    if (group) useStore.getState()._saveModGroup(group);
    return { modifierGroupDefs: updated };
  }),
  updateModifierGroupOption: (groupId, optId, patch) => set(s => {
    const updated = s.modifierGroupDefs.map(g =>
      g.id === groupId ? { ...g, options: (g.options||[]).map(o => o.id===optId ? { ...o, ...patch } : o) } : g
    );
    const group = updated.find(g => g.id === groupId);
    if (group) useStore.getState()._saveModGroup(group);
    return { modifierGroupDefs: updated };
  }),
  removeModifierGroupDef: id => {
    set(s => ({ modifierGroupDefs: s.modifierGroupDefs.filter(g => g.id !== id) }));
    if (!isMock) {
      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
      const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
      fetch(`${SUPABASE_URL}/rest/v1/modifier_groups?id=eq.${id}`, {
        method: 'DELETE',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      }).catch(() => {});
    }
  },
  reorderModifierGroupDefs: (fromIdx, toIdx) => set(s => {
    const arr = [...s.modifierGroupDefs];
    const [moved] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, moved);
    // Save all with updated sort_order
    arr.forEach((g, i) => useStore.getState()._saveModGroup({ ...g, sortOrder: i }));
    return { modifierGroupDefs: arr };
  }),

  // ── Instruction groups — preparation instructions (no price change) ────────
  // These DON'T change the price. e.g. "Cooking preference: Rare / Medium / Well done"
  instructionGroupDefs: [
    { id:'igd-cook-temp', name:'Cooking preference',
      options:['Rare','Medium rare','Medium','Medium well','Well done'] },
    { id:'igd-bread',     name:'Bread service',
      options:['With bread','No bread','Gluten-free bread (+£1)'] },
    { id:'igd-spice',     name:'Spice level',
      options:['Mild','Medium','Hot','Extra hot'] },
    { id:'igd-allergen',  name:'Allergy note',
      options:['Gluten-free option please','Dairy-free please','Nut allergy — check with kitchen','Speak to server'] },
  ],
  addInstructionGroupDef: g => set(s => ({ instructionGroupDefs:[...s.instructionGroupDefs,{id:`igd-${Date.now()}`,...g}] })),
  updateInstructionGroupDef: (id,patch) => set(s => ({ instructionGroupDefs:s.instructionGroupDefs.map(g=>g.id===id?{...g,...patch}:g) })),
  removeInstructionGroupDef: id => set(s => ({ instructionGroupDefs:s.instructionGroupDefs.filter(g=>g.id!==id) })),
  reorderInstructionGroupDefs: (fromIdx, toIdx) => set(s => {
    const arr = [...s.instructionGroupDefs];
    const [moved] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, moved);
    return { instructionGroupDefs: arr };
  }),

  // ── Menu items — full enhanced model ─────────────────────────────────────────
  //
  // Triple naming:  menuName | receiptName | kitchenName
  // Pricing:        per order type (dineIn / takeaway / collection / delivery)
  //                 null = use base price for that channel
  // Scope:          local | shared | global
  // Routing:        productionCentreId (null = inherit from category), course
  // Type:           simple | modifiers | variants | pizza | bundle
  // Visibility:     { pos, kiosk, online, onlineDelivery }
  //
  // Quick Screen — list of item IDs shown on the ⚡ Quick tab, ordered
  quickScreenIds: isMock ? QUICK_IDS : [],
  locationConfig: { timezone: 'Europe/London', businessDayStart: '06:00', shifts: [] },
  taxRates: [],
  discountPresets: [],   // from discounts table — manual presets staff can apply
  discountRules: [],     // from discount_rules table — auto-discount rules
  setQuickScreenIds: (ids) => set({ quickScreenIds: ids }),

  menuItems: (isMock ? MENU_ITEMS : []).map((item, idx) => ({
    ...item,
    sortOrder: item.sortOrder ?? idx,  // assign sequential sortOrder if not set
    menuName:    item.menuName    || item.name,
    receiptName: item.receiptName || item.name,
    kitchenName: item.kitchenName || item.name,
    scope: item.scope || 'local',
    // Per-order-type pricing (replaces per-menu pricing)
    pricing: item.pricing || {
      base:       item.price || 0,
      dineIn:     null,   // null = use base
      takeaway:   null,
      collection: null,
      delivery:   null,
    },
    productionCentreId: item.centreId || null,
    course: item.course || null,
    instructions: item.instructions || '',
    image: item.image || null,
    tags: item.tags || [],
    visibility: item.visibility || { pos:true, kiosk:true, online:true, onlineDelivery:true },
    sortOrder: item.sortOrder || 0,
  })),

  updateMenuItem: (id, patch) => {
    set(s => {
      let items = s.menuItems.map(item => {
        if (item.id !== id) return item;
        const updated = { ...item, ...patch };
        if (patch.modifierGroups !== undefined && !['subitem','variants','combo','pizza'].includes(updated.type)) {
          updated.type = patch.modifierGroups?.length > 0 ? 'modifiable' : 'simple';
        }
        return updated;
      });
      if (patch.parentId) {
        items = items.map(item => {
          if (item.id !== patch.parentId || item.type === 'subitem') return item;
          return { ...item, type: 'variants' };
        });
      }
      if ('parentId' in patch && !patch.parentId) {
        const oldParentId = s.menuItems.find(i => i.id === id)?.parentId;
        if (oldParentId) {
          const remainingChildren = items.filter(i => i.parentId === oldParentId && i.id !== id && !i.archived);
          if (remainingChildren.length === 0) {
            items = items.map(item => item.id === oldParentId ? { ...item, type: 'simple' } : item);
          }
        }
      }
      // Write the FULL updated item to Supabase (not just the patch)
      const fullItem = items.find(i => i.id === id);
      if (fullItem) {
        upsertMenuItem(fullItem);
      }

      // v5.5.261: VARIANT INHERITANCE CASCADE — when certain parent fields
      // change, push them to every child variant. Variants are just sizes of
      // the same product — they must share category, allergens, tax rate, KDS
      // centre, and secondary categories with their parent. Without this,
      // moving a product to a new category (or editing allergens, tax, etc.)
      // leaves variants with stale data, breaking reports, stamp cards, KDS
      // routing, compliance, and more.
      const CASCADE_FIELDS = ['cat', 'cats', 'allergens', 'taxRateId', 'taxOverrides', 'centreId'];
      const hasCascade = CASCADE_FIELDS.some(f => f in patch);
      if (hasCascade && fullItem && !fullItem.parentId) {
        const cascadePatch = {};
        CASCADE_FIELDS.forEach(f => { if (f in patch) cascadePatch[f] = fullItem[f]; });
        const childIds = [];
        items = items.map(i => {
          if (i.parentId !== id) return i;
          // Only update children that actually differ
          const needsUpdate = Object.keys(cascadePatch).some(f =>
            JSON.stringify(i[f]) !== JSON.stringify(cascadePatch[f])
          );
          if (!needsUpdate) return i;
          childIds.push(i.id);
          return { ...i, ...cascadePatch };
        });
        // Persist each updated child to Supabase
        if (childIds.length > 0) {
          childIds.forEach(cid => {
            const child = items.find(i => i.id === cid);
            if (child) upsertMenuItem(child);
          });
        }
      }

      // RENAME CASCADE — if the display name changed, walk modifier_groups
      // and update any option that references this menu_item, so the picker
      // labels (and the cart-line mod entries built from them) reflect the
      // new name. Modifier-group options use composite ids of the form
      // "opt-NNN-m-<menu_item_id>"; we match on the m-<id> tail.
      const nameChanged = (
        ('menuName' in patch && patch.menuName !== undefined) ||
        ('name'     in patch && patch.name     !== undefined) ||
        ('menu_name' in patch && patch.menu_name !== undefined)
      ) && fullItem;
      if (nameChanged) {
        const newName = fullItem.menuName || fullItem.name || 'Item';
        const idTail = `-m-${id.replace(/^m-/, '')}`;
        let touched = 0;
        const updatedGroups = s.modifierGroupDefs.map(g => {
          if (!Array.isArray(g.options) || g.options.length === 0) return g;
          let groupChanged = false;
          const newOptions = g.options.map(o => {
            const matchesId = o.id === id || (typeof o.id === 'string' && o.id.endsWith(idTail));
            if (!matchesId) return o;
            if (o.name === newName) return o;
            groupChanged = true;
            touched++;
            return { ...o, name: newName };
          });
          return groupChanged ? { ...g, options: newOptions } : g;
        });
        if (touched > 0) {
          // Persist every group whose options changed (rare, so the parallel
          // saves are bounded).
          updatedGroups.forEach((g, i) => {
            if (g !== s.modifierGroupDefs[i]) useStore.getState()._saveModGroup(g);
          });
          return { menuItems: items, modifierGroupDefs: updatedGroups };
        }
      }
      return { menuItems: items };
    });
  },
  addMenuItem: item => {
    const base = item.price || item.basePrice || 0;
    const isSubitem = item.type === 'subitem';
    const newItem = {
      id:`m-${Date.now()}`, scope:'local', instructions:'', image:null, tags:[],
      // Subitems are hidden from POS/kiosk/online by default - they only appear in modifier groups
      visibility: isSubitem
        ? { pos:false, kiosk:false, online:false, onlineDelivery:false }
        : (item.visibility || { pos:true, kiosk:true, online:true, onlineDelivery:true }),
      sortOrder: useStore.getState().menuItems.length,
      ...item,
      menuName:    item.menuName    || item.name || 'New item',
      receiptName: item.receiptName || item.name || 'New item',
      kitchenName: item.kitchenName || item.name || 'New item',
      pricing: item.pricing || { base, dineIn:null, takeaway:null, collection:null, delivery:null },
    };
    set(s => ({ menuItems: [...s.menuItems, newItem] }));
    upsertMenuItem(newItem);
    return newItem;
  },

  // Get effective price for an order type
  // v4.7.7: per-menu pricing tiers. Resolution order:
  //   1. p.menus[menuId][channel]   — menu-specific channel price (e.g. Deliveroo takeaway)
  //   2. p.menus[menuId].all        — menu-wide flat (applies to every channel for this menu)
  //   3. p[channel]                 — channel default (the existing dineIn/takeaway/collection/delivery)
  //   4. p.base                     — fallback
  // Backward compatible: callers passing (item, orderType) still work — menuId is optional.
  getItemPrice: (item, orderType = 'dineIn', menuId = null) => {
    const p = item?.pricing;
    if (!p) return item?.price || 0;
    const MAP = { 'dine-in':'dineIn', 'takeaway':'takeaway', 'collection':'collection', 'delivery':'delivery', 'dineIn':'dineIn' };
    const key = MAP[orderType] || 'dineIn';
    // 1+2: menu-specific tier, if set
    if (menuId && p.menus && p.menus[menuId]) {
      const tier = p.menus[menuId];
      if (tier[key] !== null && tier[key] !== undefined) return tier[key];
      if (tier.all  !== null && tier.all  !== undefined) return tier.all;
    }
    // 3+4: channel default → base
    return (p[key] !== null && p[key] !== undefined) ? p[key] : (p.base || 0);
  },

  // Reorder items within a category
  reorderMenuItems: (catId, fromIdx, toIdx) => {
    set(s => {
      const catItems = s.menuItems.filter(i => i.cat === catId).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0));
      const others   = s.menuItems.filter(i => i.cat !== catId);
      const moved    = [...catItems];
      const [item]   = moved.splice(fromIdx, 1);
      moved.splice(toIdx, 0, item);
      const reindexed = moved.map((it, idx) => ({ ...it, sortOrder: idx }));
      return { menuItems: [...others, ...reindexed] };
    });
  },

  // Reorder categories
  reorderCategories: (fromIdx, toIdx) => {
    set(s => {
      const cats = [...s.menuCategories];
      const [cat] = cats.splice(fromIdx, 1);
      cats.splice(toIdx, 0, cat);
      const reindexed = cats.map((c, idx) => ({ ...c, sortOrder: idx }));
      return { menuCategories: reindexed };
    });
  },
  duplicateMenuItem: id => {
    const source = useStore.getState().menuItems.find(i => i.id === id);
    if (!source) return;
    const dupe = { ...source, id:`m-${Date.now()}`, menuName:`${source.menuName} (copy)`, receiptName:`${source.receiptName} (copy)`, kitchenName:`${source.kitchenName} (copy)` };
    set(s => ({ menuItems: [...s.menuItems, dupe] }));
  },
  archiveMenuItem: id => {
    // v5.5.261: CASCADE — archiving a parent also archives all its variants.
    // Orphaned variants with no parent would break the menu display and create
    // ghost items that appear in reports but not on the POS.
    set(s => {
      const target = s.menuItems.find(i => i.id === id);
      const childIds = target && !target.parentId
        ? s.menuItems.filter(i => i.parentId === id && !i.archived).map(i => i.id)
        : [];
      return {
        menuItems: s.menuItems.map(item => {
          if (item.id === id) return { ...item, archived: true };
          if (childIds.includes(item.id)) return { ...item, archived: true };
          return item;
        }),
      };
    });
    if (!isMock) {
      // v5.5.279: location_id guard on archive operations
      const locId = getActiveLocationSync();
      supabase.from('menu_items')
        .update({ archived: true, parent_id: null, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('location_id', locId)
        .then(({ error }) => { if (error) console.error('[Store] archiveMenuItem failed:', error.message); });
      // Archive children in DB too
      const children = useStore.getState().menuItems.filter(i => i.parentId === id);
      if (children.length > 0) {
        const childIds = children.map(c => c.id);
        supabase.from('menu_items')
          .update({ archived: true, parent_id: null, updated_at: new Date().toISOString() })
          .in('id', childIds)
          .eq('location_id', locId)
          .then(({ error }) => { if (error) console.error('[Store] archiveMenuItem children failed:', error.message); });
      }
    }
  },

  // ── Editable floor plan ────────────────────────────────────────────────────
  // Tables state already exists in `tables` — floor plan builder just edits positions
  updateTableLayout: (id, patch) => {
    set(s => ({ tables: s.tables.map(t => t.id===id ? { ...t, ...patch } : t) }));
    // v4.6.6 Bug: must upsert the FULL merged table, not { id, ...patch }. upsertFloorTable
    // builds a row from scratch and defaults every column that isn't passed in
    // (w/h→80, shape→'rect', section→null, label→undefined, max_covers→4, ...). Passing a
    // partial patch like {x,y} from a drag wiped label/size/shape/section on every mousemove,
    // so after a refresh every table came back as an 80×80 unlabelled rect with no section —
    // visually stacked/overlapping. Read the freshly-merged table and upsert the full object.
    const full = useStore.getState().tables.find(t => t.id === id);
    if (full) upsertFloorTable(full);
  },
  addTableToLayout: async (table) => {
    // v5.5.2: stamp locationId at creation time so the cross-location guard in upsertFloorTable
    // has data to work with from the very first upsert. Without this, a brand-new table has no
    // locationId and the guard can't tell whether subsequent moves are legitimate.
    let locId = null;
    try { locId = getActiveLocationSync() || await getLocationId(); } catch {}
    const newTable = { id:`t-${Date.now()}`, status:'available', session:null, locationId: locId, ...table };
    // If caller passed an explicit locationId in `table`, that wins (spread above).
    set(s => ({ tables: [...s.tables, newTable] }));
    upsertFloorTable(newTable);
  },
  removeTableFromLayout: (id) => {
    // v5.5.2: pull the table's locationId BEFORE we filter it out of state, so the DB delete
    // can be scoped to that exact location (defense against the cross-location-leak class).
    const tbl = useStore.getState().tables.find(t => t.id === id);
    const locId = tbl?.locationId || null;
    set(s => ({ tables: s.tables.filter(t => t.id!==id && t.parentId!==id) }));
    // v4.6.5 Bug 6: previously removed from local state only, so it re-appeared on every boot.
    deleteFloorTable(id, locId).catch(e => console.warn('[removeTableFromLayout] DB delete failed:', e?.message || e));
  },

  // ── Tables (source of truth for all orders) ──────────
  tables: isMock ? buildInitialTables() : [],

  // Helper to update a single table
  _updateTable: (id, patch) => set(s => ({ tables: s.tables.map(t => t.id===id ? { ...t, ...patch } : t) })),

  // Seat a table: create session, go to POS
  seatTable: (tableId, { covers, server }) => {
    // v4.6.67: pull the existing reservation's customer (if any) into the session
    // so the dine-in flow attributes loyalty automatically.
    const tbl = get().tables.find(t => t.id === tableId);
    const reservedCustomer = tbl?.reservation?.customer || null;
    const session = {
      id: `ORD-${++_orderNum}`,
      items: [], firedCourses: [],
      sentAt: null, covers, server,
      seatedAt: Date.now(), note: '', orderNote: '',
      subtotal: 0, total: 0,
      customer: reservedCustomer,
    };
    get()._updateTable(tableId, { status:'open', session, reservation:null });
    set({ activeTableId:tableId, surface:'pos', orderType:'dine-in' });
    // Auto-apply the customer's stored allergens (if any) on next visit.
    if (reservedCustomer?.allergens?.length) {
      set({ allergens: [...reservedCustomer.allergens] });
      get().showToast?.(`Allergen filter applied — ${reservedCustomer.name} is allergic to ${reservedCustomer.allergens.join(', ')}`, 'info');
    }
  },

  // Seat a table AND pre-populate its session with walk-in items
  seatTableWithItems: (tableId, items, { covers, server }) => {
    const now = Date.now();
    const session = {
      id: `ORD-${++_orderNum}`,
      items: items.map(i => ({ ...i, status:'pending' })),
      firedCourses: [], sentAt: null, covers, server,
      seatedAt: now, note: '', orderNote: '',
      subtotal: items.reduce((s,i)=>s+i.price*i.qty, 0),
      total: items.reduce((s,i)=>s+i.price*i.qty, 0) * 1.125,
    };
    get()._updateTable(tableId, { status:'open', session, reservation:null });
    set({ activeTableId:tableId, surface:'pos', orderType:'dine-in', walkInOrder:null, customer:null });
    get().showToast(`Items moved to ${get().tables.find(t=>t.id===tableId)?.label}`, 'success');
  },

  // Merge walk-in items into an already-occupied table
  mergeItemsToTable: (tableId, newItems) => {
    set(s => ({
      tables: s.tables.map(t => {
        if (t.id !== tableId || !t.session) return t;
        const items = [...t.session.items, ...newItems.map(i=>({...i, status:'pending'}))];
        const subtotal = items.reduce((s,i)=>s+i.price*i.qty, 0);
        return { ...t, session: { ...t.session, items, subtotal, total: subtotal*1.125 } };
      }),
      walkInOrder: null, customer: null,
    }));
    set({ activeTableId:tableId, surface:'pos', orderType:'dine-in' });
    get().showToast(`Items merged into ${get().tables.find(t=>t.id===tableId)?.label}`, 'success');
  },

  // Split a table — create a child table (T1.2) with the given items
  splitTableCheck: (parentTableId, splitItems, staffName) => {
    const parent = get().tables.find(t => t.id === parentTableId);
    if (!parent) return;

    // Determine child label: T1 → T1.2, T1.2 → T1.3, etc.
    const existingChildren = get().tables.filter(t => t.parentId === parentTableId);
    const checkNum = existingChildren.length + 2;
    const childLabel = `${parent.label}.${checkNum}`;
    const childId = `${parentTableId}-${checkNum}`;

    const childSession = {
      id: `ORD-${++_orderNum}`,
      items: splitItems.map(i => ({...i, status:'pending'})),
      firedCourses: [], sentAt: null,
      covers: parent.session?.covers || 2,
      server: staffName || parent.session?.server || 'Server',
      seatedAt: Date.now(), note: '', orderNote: '',
      subtotal: splitItems.reduce((s,i)=>s+i.price*i.qty, 0),
      total: splitItems.reduce((s,i)=>s+i.price*i.qty, 0) * 1.125,
    };

    // Remove split items from parent
    const parentItems = (parent.session?.items || []).filter(
      pi => !splitItems.some(si => si.uid === pi.uid)
    );
    const parentSub = parentItems.reduce((s,i)=>s+i.price*i.qty, 0);

    // Child table — same position as parent, flagged virtual
    const childTable = {
      ...parent,
      id: childId,
      label: childLabel,
      parentId: parentTableId,
      status: 'open',
      session: childSession,
      reservation: null,
    };

    set(s => ({
      tables: [
        ...s.tables.map(t => {
          if (t.id !== parentTableId) return t;
          const session = { ...t.session, items: parentItems, subtotal: parentSub, total: parentSub*1.125 };
          return { ...t, session, childIds: [...(t.childIds||[]), childId] };
        }),
        childTable,
      ],
      walkInOrder: null, customer: null,
      activeTableId: childId, surface: 'pos', orderType: 'dine-in',
    }));
    get().showToast(`Check 2 created — ${childLabel}`, 'success');
  },

  // Open an already-seated table (go to its POS)
  openTableInPOS: (tableId) => {
    set({ activeTableId:tableId, surface:'pos', orderType:'dine-in' });
  },

  // Save a table session without sending to kitchen — creates session if needed (seats the table)
  saveTableSession: (tableId, covers) => {
    set(s => ({
      tables: s.tables.map(t => {
        if (t.id !== tableId) return t;
        const session = t.session || {
          id: `ORD-${++_orderNum}`,
          items: [], firedCourses: [], sentAt: null,
          covers: covers || 2,
          server: s.staff?.name || 'Staff',
          seatedAt: Date.now(),
          note: '', orderNote: '', subtotal: 0, total: 0,
        };
        // Update covers if changed
        const updatedSession = { ...session, covers: covers || session.covers };
        return { ...t, status: 'occupied', session: updatedSession };
      }),
    }));
  },

  // Close / clear a table after payment
  clearTable: (tableId, paymentInfo = {}) => {
    get().recordClosedCheck(tableId, paymentInfo);
    const table = get().tables.find(t => t.id === tableId);

    if (table?.parentId) {
      // Child table (T1.2) — remove it, update parent childIds
      set(s => {
        const remaining = s.tables.filter(t => t.id !== tableId);
        const parent = remaining.find(t => t.id === table.parentId);
        const newChildIds = (parent?.childIds || []).filter(id => id !== tableId);
        // If parent has no more children and no active session, set to available
        const parentHasSession = parent?.session?.items?.some(i => !i.voided);
        return {
          tables: remaining.map(t => {
            if (t.id !== table.parentId) return t;
            if (newChildIds.length === 0 && !parentHasSession) {
              return { ...t, status:'available', session:null, childIds:[] };
            }
            return { ...t, childIds: newChildIds };
          }),
        };
      });
    } else {
      // Parent table — clear it and all its children
      const childIds = table?.childIds || [];
      set(s => ({
        tables: s.tables
          .filter(t => !childIds.includes(t.id))
          .map(t => t.id === tableId ? { ...t, status:'available', session:null, childIds:[] } : t),
      }));
    }
    set(s => ({ activeTableId: s.activeTableId === tableId ? null : s.activeTableId }));
  },

  // Add/remove reservation
  setReservation: (tableId, res) => {
    get()._updateTable(tableId, { status: res?'reserved':'available', reservation: res||null });
  },

  // Update covers count mid-service
  updateCovers: (tableId, covers) => {
    set(s => ({
      tables: s.tables.map(t =>
        t.id === tableId && t.session
          ? { ...t, session: { ...t.session, covers } }
          : t
      ),
    }));
  },

  // Transfer or combine a table's session onto another table.
  // v4.6.28:
  //   - Destination empty: straight transfer (session moves across, source freed).
  //   - Destination has a session: COMBINE — destination keeps its items and we
  //     append the source's items. Covers sum, totals recomputed.
  //   - If the source had any sent items, a transfer-notice docket is fired to
  //     every centre that saw any of those items, so kitchen/expo sees the new
  //     location for already-prepared food.
  transferTable: (fromId, toId) => {
    const { tables } = get();
    const from = tables.find(t => t.id === fromId);
    const to   = tables.find(t => t.id === toId);
    if (!from?.session || !to) return;

    const destHasSession = !!to.session;
    const fromItems = from.session.items || [];
    const toItems   = to.session?.items || [];
    const sentItems = fromItems.filter(i => i.status === 'sent' && !i.voided);

    const mergedItems = destHasSession ? [...toItems, ...fromItems] : fromItems;
    const mergedSubtotal = mergedItems.reduce((s, i) => s + (i.price||0)*(i.qty||1), 0);
    const mergedSession = destHasSession
      ? {
          ...to.session,
          items: mergedItems,
          covers: (to.session.covers || 0) + (from.session.covers || 0),
          subtotal: mergedSubtotal,
          total: mergedSubtotal * 1.125,
        }
      : { ...from.session, items: mergedItems, subtotal: mergedSubtotal, total: mergedSubtotal * 1.125 };

    set(s => ({
      tables: s.tables.map(t => {
        if (t.id === fromId) return { ...t, status:'available', session:null, childIds:[] };
        if (t.id === toId)   return { ...t, status:'occupied', session: mergedSession, reservation:null };
        return t;
      }),
      activeTableId: toId,
    }));

    if (sentItems.length) {
      try {
        const routingConfig = (() => {
          try {
            const stored = get().printRouting;
            if (stored?.centres?.length) return stored;
            return JSON.parse(localStorage.getItem('rpos-print-routing') || 'null') || { centres: [], routing: {} };
          } catch { return { centres: [], routing: {} }; }
        })();
        const byCenter = {};
        sentItems.forEach(item => {
          const centres = getCentresForItem(item, routingConfig);
          centres.forEach(cid => {
            if (!byCenter[cid]) byCenter[cid] = [];
            byCenter[cid].push(item);
          });
        });
        const centrePrinterName = (centreId) => {
          const c = routingConfig.centres?.find(x => x.id === centreId);
          return c?.printer?.name || c?.name || 'Kitchen';
        };
        Object.entries(byCenter).forEach(([centreId, items]) => {
          get().routePrintJob({
            centreId,
            printerName: centrePrinterName(centreId),
            fromTable: from.label,
            tableLabel: to.label,
            items: items.map(i => ({
              qty: i.qty,
              name: i.kitchenName || i.menu_name || i.menuName || i.name,
              mods: i.mods,
              course: i.course,
            })),
            server: from.session?.server || to.session?.server || '',
            type: 'transfer-notice',
          });
        });
      } catch (err) {
        // A printing failure must never block the in-memory transfer.
        console.warn('[transferTable] transfer notice failed:', err);
      }
    }

    get().showToast(
      destHasSession
        ? `Combined ${from.label} into ${to.label}`
        : `Transferred to ${to.label}`,
      'success'
    );
  },

  // ── Active table context ───────────────────
  activeTableId: null,
  setActiveTableId: id => set({ activeTableId:id }),

  getActiveTable: () => get().tables.find(t => t.id === get().activeTableId) || null,

  // ── Add item to active table's session ────
  addItem: (item, mods=[], pizzaConfig=null, opts={}) => {
    const { activeTableId, staff, tables } = get();
    const qty = opts.qty || 1;
    // v4.5.5: when caller doesn't pass an explicit linePrice (e.g. quick add),
    // resolve the price via getItemPrice(item, currentOrderType) so per-channel pricing
    // (dineIn / takeaway / collection / delivery) is applied. Fixes pricing schema being
    // wired but POS never reading channel keys.
    const _currentOrderType = get().orderType;
    const _channelPrice = (() => {
      try { return get().getItemPrice(item, _currentOrderType); }
      catch { return item?.pricing?.base ?? item?.price ?? 0; }
    })();
    // v4.5.7: if caller passed linePrice but it equals item.pricing.base * qty, the
    // caller is using the dumb-base shortcut (e.g. QuickAdd) and we should swap in the
    // channel-aware price instead. If linePrice differs from base*qty, modifiers are at
    // play (e.g. ProductModal added surcharges) — we SCALE the linePrice by the channel
    // ratio so per-channel pricing applies even when modifiers are stacked.
    let price;
    const _basePrice = item?.pricing?.base ?? item?.price ?? 0;
    if (opts.linePrice == null) {
      price = _channelPrice;
    } else if (_basePrice && Math.abs(opts.linePrice/qty - _basePrice) < 0.001) {
      // Caller passed plain base — use channel price instead
      price = _channelPrice;
    } else if (_basePrice && _channelPrice && _basePrice !== _channelPrice) {
      // Caller passed modifiers-included price — scale by channel ratio
      const ratio = _channelPrice / _basePrice;
      price = (opts.linePrice / qty) * ratio;
    } else {
      price = opts.linePrice / qty;
    }
    const newItem = {
      uid: uid(), itemId: item.id,
      name: opts.displayName || item.name,
      price, qty, mods: mods||[], notes: opts.notes||'',
      pizzaConfig, allergens: item.allergens||[],
      centreId: item.centreId,
      cat: (() => {
        // v5.5.259: Variants use the parent's category. Variant rows in the DB
        // can have a stale/wrong cat from creation or reassignment bugs.
        if (item.parentId) {
          const parent = (useStore.getState().menuItems || []).find(m => m.id === item.parentId);
          if (parent?.cat) return parent.cat;
        }
        return item.cat || null;
      })(),
      parentId: item.parentId || null,
      // v5.5.338: variants inherit the parent's tax settings (default rate +
      // per-order-type overrides). Variant rows store empty tax_overrides, so
      // without this a sized item's takeaway/zero-rate override is lost and it's
      // taxed at the default rate. Mirrors the category inheritance above.
      ...(() => {
        let txRate = item.taxRateId || item.tax_rate_id || null;
        let txOv = item.taxOverrides || item.tax_overrides || {};
        if (item.parentId && (!txOv || Object.keys(txOv).length === 0)) {
          const parent = (useStore.getState().menuItems || []).find(m => m.id === item.parentId);
          if (parent) {
            txOv = parent.taxOverrides || parent.tax_overrides || txOv;
            if (!txRate) txRate = parent.taxRateId || parent.tax_rate_id || null;
          }
        }
        return { taxRateId: txRate, taxOverrides: txOv };
      })(),
      seat: 'shared',
      course: (() => {
        const cats = useStore.getState().menuCategories || [];
        const cat = cats.find(c => c.id === item.cat) ||
                    cats.find(c => c.id === item.cats?.[0]) ||
                    (item.parentId ? cats.find(c => c.id === (useStore.getState().menuItems||[]).find(m=>m.id===item.parentId)?.cat) : null);
        return cat?.defaultCourse ?? 1;
      })(),
      fired: (() => {
        const cats = useStore.getState().menuCategories || [];
        const cat = cats.find(c => c.id === item.cat) ||
                    cats.find(c => c.id === item.cats?.[0]) ||
                    (item.parentId ? cats.find(c => c.id === (useStore.getState().menuItems||[]).find(m=>m.id===item.parentId)?.cat) : null);
        return (cat?.defaultCourse ?? 1) === 0;
      })(),
      status: 'pending',
    };

    // Decrement daily count if set (respects qty per v4.6.11)
    if (item.id) get().decrementDailyCount(item.id, qty);
    // v5.5.189: also decrement daily counts for modifier options that reference
    // menu items (e.g. "Bueno Donut" as a sub-item in a "Box of 3" combo).
    // Each mod's usage = (mod.qty || 1) per parent unit × parent qty.
    if (mods?.length) {
      mods.forEach(mod => {
        if (mod.itemId) get().decrementDailyCount(mod.itemId, (mod.qty || 1) * qty);
      });
    }

    if (activeTableId) {
      // Add to the table's session
      set(s => ({
        tables: s.tables.map(t => {
          if (t.id !== activeTableId) return t;
          const session = t.session || { id:`ORD-${++_orderNum}`, items:[], firedCourses:[], sentAt:null, covers:2, server:staff?.name||'Staff', seatedAt:Date.now(), note:'', orderNote:'', subtotal:0, total:0 };
          const items = [...session.items, newItem];
          const subtotal = items.reduce((s,i)=>s+i.price*i.qty, 0);
          return { ...t, status:t.status==='available'?'open':t.status, session:{ ...session, items, subtotal, total:subtotal*1.125 } };
        }),
      }));
    } else {
      // Walk-in / takeaway: use standalone order
      set(s => {
        const items = [...(s.walkInOrder?.items||[]), newItem];
        const subtotal = items.reduce((a,i)=>a+i.price*i.qty, 0);
        return { walkInOrder:{ ...(s.walkInOrder||{id:`ORD-${++_orderNum}`}), items, subtotal, total:subtotal } };
      });
    }
  },

  addCustomItem: (name, price, notes) => {
    const { activeTableId, staff } = get();
    const newItem = { uid:uid(), itemId:'custom', name, price:parseFloat(price)||0, qty:1, mods:[], notes, allergens:[], seat:'shared', course:1, fired:false, status:'pending' };
    if (activeTableId) {
      set(s=>({ tables:s.tables.map(t=>{
        if (t.id!==activeTableId) return t;
        const session = t.session||{ id:`ORD-${++_orderNum}`, items:[], firedCourses:[], sentAt:null, covers:2, server:staff?.name||'Staff', seatedAt:Date.now(), note:'', orderNote:'', subtotal:0, total:0 };
        const items=[...session.items, newItem];
        const subtotal=items.reduce((s,i)=>s+i.price*i.qty,0);
        return {...t, session:{...session, items, subtotal, total:subtotal*1.125}};
      }) }));
    } else {
      set(s=>{const items=[...(s.walkInOrder?.items||[]),newItem];return{walkInOrder:{...(s.walkInOrder||{id:`ORD-${++_orderNum}`}),items}};});
    }
  },

  removeItem: (itemUid) => {
    const { activeTableId } = get();
    // v4.6.11: restore daily count for the removed item (only if it was never sent —
    // sent items can't be removed via this path, only voided). Look up before mutation.
    const sourceItems = activeTableId
      ? (get().tables.find(t => t.id === activeTableId)?.session?.items || [])
      : (get().walkInOrder?.items || []);
    const removed = sourceItems.find(i => i.uid === itemUid);
    if (removed && !removed.voided && removed.status !== 'sent') {
      get().decrementDailyCount(removed.itemId, -(removed.qty || 1));
      // v5.5.189: restore modifier sub-item counts too
      (removed.mods || []).forEach(mod => {
        if (mod.itemId) get().decrementDailyCount(mod.itemId, -((mod.qty || 1) * (removed.qty || 1)));
      });
    }
    if (activeTableId) {
      set(s=>({ tables:s.tables.map(t=>{
        if(t.id!==activeTableId||!t.session)return t;
        const items=t.session.items.filter(i=>i.uid!==itemUid);
        const subtotal=items.reduce((s,i)=>s+i.price*i.qty,0);
        return {...t, session:{...t.session, items, subtotal, total:subtotal*1.125}};
      })}) );
    } else {
      set(s=>{const items=(s.walkInOrder?.items||[]).filter(i=>i.uid!==itemUid);return{walkInOrder:{...s.walkInOrder,items}};});
    }
  },

  updateItemQty: (itemUid, delta) => {
    const { activeTableId } = get();
    // v4.6.11: compute actual qty change first so we can adjust inventory.
    // The clamp can swallow a portion of delta (e.g. qty=1, delta=-1 → newQty=1,
    // actual change = 0) so we rely on the observed change, not the requested delta.
    const sourceItems = activeTableId
      ? (get().tables.find(t => t.id === activeTableId)?.session?.items || [])
      : (get().walkInOrder?.items || []);
    const target = sourceItems.find(i => i.uid === itemUid);
    let actualChange = 0;
    if (target && !target.voided) {
      const newQty = Math.max(1, target.qty + delta);
      actualChange = newQty - target.qty;
      if (actualChange !== 0) {
        get().decrementDailyCount(target.itemId, actualChange);
        // v5.5.189: adjust modifier sub-item counts too
        (target.mods || []).forEach(mod => {
          if (mod.itemId) get().decrementDailyCount(mod.itemId, (mod.qty || 1) * actualChange);
        });
      }
    }

    const applyQty = items => {
      const item = items.find(i => i.uid === itemUid);
      if (!item || item.voided) return items;
      const newQty = Math.max(1, item.qty + delta); // Clamp at 1 — never auto-remove
      return items.map(i => i.uid === itemUid ? { ...i, qty: newQty } : i);
    };
    if (activeTableId) {
      set(s=>({ tables:s.tables.map(t=>{
        if(t.id!==activeTableId||!t.session)return t;
        const items=applyQty(t.session.items);
        const subtotal=items.reduce((s,i)=>s+i.price*i.qty,0);
        return {...t,session:{...t.session,items,subtotal,total:subtotal*1.125}};
      })}) );
    } else {
      set(s=>{const items=applyQty(s.walkInOrder?.items||[]);return{walkInOrder:{...s.walkInOrder,items}};});
    }
  },

  updateItemNote: (itemUid, note) => {
    const { activeTableId } = get();
    const apply = items => items.map(i=>i.uid===itemUid?{...i,notes:note}:i);
    if (activeTableId) {
      set(s=>({ tables:s.tables.map(t=>{
        if(t.id!==activeTableId||!t.session)return t;
        return {...t,session:{...t.session,items:apply(t.session.items)}};
      })}) );
    } else {
      set(s=>({walkInOrder:{...s.walkInOrder,items:apply(s.walkInOrder?.items||[])}}));
    }
  },

  setOrderNote: (note) => {
    const { activeTableId } = get();
    if (activeTableId) {
      set(s=>({ tables:s.tables.map(t=>t.id===activeTableId&&t.session?{...t,session:{...t.session,orderNote:note}}:t) }));
    } else {
      set(s=>({ walkInOrder:{...s.walkInOrder,orderNote:note} }));
    }
  },

  // Toggle service charge waiver for the current order
  toggleServiceCharge: () => {
    const { activeTableId } = get();
    if (activeTableId) {
      set(s=>({ tables:s.tables.map(t=>{
        if(t.id!==activeTableId||!t.session)return t;
        return {...t,session:{...t.session,serviceChargeWaived:!t.session.serviceChargeWaived}};
      })}));
    } else {
      set(s=>({ walkInOrder:{...s.walkInOrder,serviceChargeWaived:!s.walkInOrder?.serviceChargeWaived} }));
    }
  },

  updateItemSeat: (itemUid, seat) => {
    const { activeTableId } = get();
    if (activeTableId) {
      set(s=>({ tables:s.tables.map(t=>{
        if(t.id!==activeTableId||!t.session)return t;
        return {...t,session:{...t.session,items:t.session.items.map(i=>i.uid===itemUid?{...i,seat}:i)}};
      })}) );
    }
  },

  updateItemCourse: (itemUid, course) => {
    const { activeTableId } = get();
    if (activeTableId) {
      set(s=>({ tables:s.tables.map(t=>{
        if(t.id!==activeTableId||!t.session)return t;
        return {...t,session:{...t.session,items:t.session.items.map(i=>i.uid===itemUid?{...i,course}:i)}};
      })}) );
    } else {
      // Walk-in / takeaway / collection order
      set(s=>({ walkInOrder: s.walkInOrder ? {
        ...s.walkInOrder,
        items: (s.walkInOrder.items||[]).map(i=>i.uid===itemUid?{...i,course}:i)
      } : s.walkInOrder }));
    }
  },

  // ── SEND TO KITCHEN ────────────────────────
  // Fires courses 0+1, marks table occupied, updates totals
  sendToKitchen: (opts) => {
    // v4.6.44: tolerate any arg shape. POSSurface legacy callers pass
    // sendToKitchen(null) or sendToKitchen(tableId) as positional args.
    // Destructuring `null` throws; this internal default doesn't.
    const bypassSchedule = (opts && typeof opts === 'object') ? !!opts.bypassSchedule : false;
    const { activeTableId, staff, orderType, customer, addToQueue, tables } = get();

    // Get routing config — prefer store value (pushed from back office), fall back to localStorage
    const getRoutingConfig = () => {
      try {
        const stored = useStore.getState().printRouting;
        if (stored?.centres?.length) return stored;
        return JSON.parse(localStorage.getItem('rpos-print-routing') || 'null') || { centres:[], routing:{} };
      } catch { return { centres:[], routing:{} }; }
    };

    // Build a map of catId → parentId for hierarchy traversal
    const buildCatParentMap = () => {
      try {
        const snap = JSON.parse(localStorage.getItem('rpos-config-snapshot') || '{}');
        const cats = snap.menuCategories || useStore.getState().menuCategories || [];
        const map = {};
        cats.forEach(c => { map[c.id] = c.parentId || null; });
        return map;
      } catch { return {}; }
    };

    // Check if catId or any of its ancestors is in the assignedCategories set
    const catOrAncestorMatches = (catId, assignedSet, parentMap, depth = 0) => {
      if (!catId || depth > 5) return false;
      if (assignedSet.has(catId)) return true;
      const parentId = parentMap[catId];
      if (!parentId) return false;
      return catOrAncestorMatches(parentId, assignedSet, parentMap, depth + 1);
    };

    // Determine which production center(s) an item routes to based on its category
    const getCentresForItem = (item, config) => {
      const { centres, routing } = config;
      if (!centres?.length || !routing) return [];

      // Order line items only carry itemId — look up the full menu item to get cat/parentId
      const allItems = useStore.getState().menuItems || [];
      const menuItem = allItems.find(i => i.id === (item.itemId || item.id));

      // Direct category from the item (or looked-up menu item)
      let itemCat = item.cat || item.cats?.[0] || menuItem?.cat || menuItem?.cats?.[0] || null;

      // For variant items (e.g. Small Latte), also check the parent item's category
      // (variants often inherit their routing from the parent: Latte → Coffee → Hot Drinks → KDS Bar)
      const parentId = item.parentId || menuItem?.parentId || null;
      const parentMenuItem = parentId ? allItems.find(i => i.id === parentId) : null;
      const parentCat = parentMenuItem?.cat || parentMenuItem?.cats?.[0] || null;

      const parentMap = buildCatParentMap();
      const matched = [];
      centres.forEach(centre => {
        const r = routing[centre.id];
        if (!r?.assignedCategories?.length) return;
        if (r.excludedItems?.includes(item.id) || r.excludedItems?.includes(item.itemId)) return;
        const assignedSet = new Set(r.assignedCategories);
        const catMatches = (itemCat && catOrAncestorMatches(itemCat, assignedSet, parentMap)) ||
                           (parentCat && catOrAncestorMatches(parentCat, assignedSet, parentMap));
        if (catMatches) matched.push(centre.id);
      });
      return matched;
    };

    // v5.5.191: compute which courses auto-fire on send. Always includes 0
    // (immediate) and 1 (starters). If the lowest occupied course is higher
    // than 1 (e.g. only course 2 items exist), auto-fire all empty leading
    // courses up through it so the kitchen doesn't hold items for a course
    // that has no food in it.
    const computeFiredOnSend = (items) => {
      const pending = (items || []).filter(i => !i.voided && (i.status === 'pending' || i.status === 'sent'));
      const courses = [...new Set(pending.map(i => i.course ?? 1))].filter(c => c >= 1).sort((a,b) => a-b);
      const lowest = courses[0] || 1;
      const fired = [0];
      for (let c = 1; c <= lowest; c++) fired.push(c);
      return fired;
    };

    const createKdsTickets = (items, tableLabel, serverName, covers, _firedOnSend) => {
      const routingConfig = getRoutingConfig();
      const byCenter = {};
      const FIRED_ON_SEND = _firedOnSend;
      // Send ALL non-voided pending items — not just courses 0+1
      items.filter(i => !i.voided && i.status === 'pending').forEach(item => {
        const centres = getCentresForItem(item, routingConfig);
        centres.forEach(cid => {
          if (!byCenter[cid]) byCenter[cid] = [];
          byCenter[cid].push(item);
        });
      });
      return Object.entries(byCenter).map(([centreId, centreItems]) => {
        const allCourses = [...new Set(centreItems.map(i => i.course ?? 1))].sort((a,b)=>a-b);
        return {
          id: `kds-${Date.now()}-${centreId}-${Math.random().toString(36).slice(2,6)}`,
          table: tableLabel, server: serverName, covers, centreId,
          sentAt: Date.now(), minutes: 0,
          firedCourses: FIRED_ON_SEND,
          allCourses,
          items: centreItems.map(i => ({
            qty: i.qty, name: i.kitchenName || i.menu_name || i.menuName || i.name,
            mods: [
              // v4.6.10: drop the `${groupLabel}: ` prefix on mods shown on KDS and
              // production dockets. Kitchens care about the modifier itself, not which
              // picker group it came from. The groupLabel field stays on the source mod
              // object (BarSurface.jsx:677) as metadata in case we need it later.
              ...(i.mods?.filter(m => !m._instruction).map(m => m.name || m.label).filter(Boolean) || []),
              ...(i.mods?.filter(m => m._instruction).map(m => m.label).filter(Boolean) || []),
              ...(i.allergens?.length ? [`⚠ ${i.allergens.map(a=>a.toUpperCase()).join(' · ')}`] : []),
              ...(i.notes ? [`📝 ${i.notes}`] : []),
            ],
            course: i.course ?? 1,
            fired: FIRED_ON_SEND.includes(i.course ?? 1),
            centreId, uid: i.uid,
          })),
        };
      });
    };

    if (activeTableId) {
      const table = tables.find(t => t.id === activeTableId);
      const session = table?.session;
      const pendingItems = session?.items?.filter(i => i.status === 'pending' && !i.voided) || [];
      const firedOnSend = computeFiredOnSend(session?.items || []);
      const newTickets = createKdsTickets(pendingItems, table?.label || activeTableId, staff?.name || 'Server', session?.covers || 2, firedOnSend);
      // Route print jobs for each ticket (fires to mapped printer per centre)
      const printConfig = getRoutingConfig();
      const getCentrePrinter = (centreId) => {
        const centre = printConfig.centres?.find(c => c.id === centreId);
        return centre?.printer?.name || centre?.name || { pc1:'Hot kitchen', pc2:'Cold section', pc3:'Pizza oven', pc4:'Bar', pc5:'Expo / pass' }[centreId] || 'Kitchen';
      };
      newTickets.forEach(t => {
        // v4.6.9: print ALL items — the docket mirrors the KDS, grouping by course
        // with FIRING/HOLD headers (see buildKitchenTicket). A later fireCourse()
        // emits a separate "FIRE COURSE N" marker docket. Revert of the v4.6.8
        // fired-only filter.
        if (t.items.length) get().routePrintJob({
          centreId: t.centreId,
          printerName: getCentrePrinter(t.centreId),
          tableLabel: t.table,
          server: t.server,
          covers: t.covers,
          course: t.firedCourses?.[0] ?? 1,
          items: t.items,
          type: 'kitchen',
        });
      });
      set(s=>({
        tables: s.tables.map(t=>{
          if(t.id!==activeTableId||!t.session)return t;
          // v5.5.4: TWO independent concepts on each item:
          //   status: 'pending' | 'sent'  — whether the kitchen has SEEN this item yet.
          //                                  An item is 'sent' as soon as it's printed.
          //   fired:  bool                — whether the kitchen should COOK it now.
          //                                  Course 0/1 are auto-fired, course 2+ are
          //                                  printed on a HOLD ticket and only become
          //                                  fired:true when fireCourse(N) is called.
          // Pre-v5.5.4 bug: this map only updated status to 'sent' when the course
          // was in firedCourses (= auto-fire courses). Course 2+ items stayed
          // 'pending' even after save+send had printed them, so the NEXT save+send
          // re-included them in pendingItems and re-printed every fired course's
          // tickets. Now: every printed item flips to status:'sent', and only the
          // 'fired' flag gates fire-vs-hold.
          const firedCourses=[...new Set([...(t.session.firedCourses||[]),...firedOnSend])];
          const items=t.session.items.map(i => {
            if (i.status !== 'pending' || i.voided) return i;
            return { ...i, fired: firedCourses.includes(i.course), status: 'sent' };
          });
          const subtotal=items.reduce((s,i)=>s+i.price*i.qty,0);
          return {...t, status:'occupied', session:{...t.session, items, firedCourses, sentAt:t.session.sentAt||Date.now(), server:staff?.name||t.session.server, subtotal, total:subtotal*1.125 }};
        }),
        kdsTickets: [...s.kdsTickets, ...newTickets],
      }));
      newTickets.forEach(t => insertKDSTicket(t));
      get().showToast('Sent to kitchen','success');
    } else {
      const order = get().walkInOrder;
      if (!order?.items?.length) return;

      // v4.6.29: scheduled-collection deferral. If the customer set a
      // non-ASAP collection time that's more than 30 minutes away, skip
      // the kitchen send entirely and stash the order as status=scheduled
      // with a scheduledFireAt timestamp. A background tick
      // (tickScheduledOrders → fireScheduledOrder) runs the print + KDS
      // path 30 minutes before the collection time.
      const _parseCollectionTimeToMs = (timeStr) => {
        if (!timeStr || typeof timeStr !== 'string') return null;
        const [h, m] = timeStr.split(':').map(Number);
        if (Number.isNaN(h) || Number.isNaN(m)) return null;
        const d = new Date();
        d.setHours(h, m, 0, 0);
        // If that time has already passed today, assume tomorrow
        // (handles overnight pre-orders).
        if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
        return d.getTime();
      };
      if (!bypassSchedule && customer?.collectionTime && !customer?.isASAP) {
        const collectAt = _parseCollectionTimeToMs(customer.collectionTime);
        // v4.6.60: lead time configurable via Location settings (default 30min, 5-min increments)
      const _leadMin = (typeof get().locationConfig?.collectionLeadMinutes === 'number') ? get().locationConfig.collectionLeadMinutes : 30;
      const LEAD_MS = _leadMin * 60 * 1000;
        if (collectAt && collectAt - Date.now() > LEAD_MS) {
          const scheduledFireAt = collectAt - LEAD_MS;
          const pendingItems = order.items.filter(i => i.status === 'pending' && !i.voided);
          if (!pendingItems.length) return;
          const label = customer?.name
            ? `${orderType.charAt(0).toUpperCase()+orderType.slice(1)} · ${customer.name}`
            : orderType;
          const ref = order.ref || getNextOrderRefLocal();
          const scheduledEntry = {
            ref, type: orderType,
            customer: { ...customer },
            // Keep items as pending — nothing has hit the kitchen yet.
            items: pendingItems.map(i => ({ ...i })),
            total: pendingItems.reduce((s, i) => s + i.price * i.qty, 0),
            status: 'scheduled',
            scheduledFireAt,
            createdAt: order.createdAt || Date.now(),
            collectionTime: customer.collectionTime,
            isASAP: false,
            staff: staff?.name,
            label,
          };
          const alreadyQueued = get().orderQueue.find(o => o.ref === ref);
          if (alreadyQueued) {
            set(s => ({ orderQueue: s.orderQueue.map(o => o.ref === ref ? { ...o, ...scheduledEntry } : o) }));
          } else {
            addToQueue(scheduledEntry);
          }
          const fireTime = new Date(scheduledFireAt).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
          get().showToast(
            customer?.name
              ? `${customer.name} — collection ${customer.collectionTime}, kitchen fires ${fireTime}`
              : `Scheduled — kitchen fires at ${fireTime}`,
            'success'
          );
          return;
        }
      }
      const pendingItems = order.items.filter(i => i.status === 'pending' && !i.voided);
      const label = customer?.name ? `${orderType.charAt(0).toUpperCase()+orderType.slice(1)} · ${customer.name}` : orderType;
      const wiFiredOnSend = computeFiredOnSend(order.items || []);
      const newTickets = createKdsTickets(pendingItems, label, staff?.name || 'Server', 1, wiFiredOnSend);
      // v4.6.5 Bug 3: walk-in / takeaway / collection / delivery orders must ALSO route
      // print jobs to each production centre. Previously only the table branch did this,
      // so non-table orders only hit the KDS screen and silently skipped every printer.
      const printConfig = getRoutingConfig();
      const getCentrePrinter = (centreId) => {
        const centre = printConfig.centres?.find(c => c.id === centreId);
        return centre?.printer?.name || centre?.name || { pc1:'Hot kitchen', pc2:'Cold section', pc3:'Pizza oven', pc4:'Bar', pc5:'Expo / pass' }[centreId] || 'Kitchen';
      };
      newTickets.forEach(t => {
        // v4.6.9: print ALL items (see comment at the table branch).
        if (t.items.length) get().routePrintJob({
          centreId: t.centreId,
          printerName: getCentrePrinter(t.centreId),
          tableLabel: t.table,
          server: t.server,
          covers: t.covers,
          course: t.firedCourses?.[0] ?? 1,
          items: t.items,
          type: 'kitchen',
        });
      });
      // Always add walk-in orders to queue so they appear in Orders Hub
      const ref = order.ref || getNextOrderRefLocal();
      const queueEntry = {
        ref, type: orderType,
        customer: customer ? { ...customer } : { name: customer?.name || label },
        // v4.6.5 follow-up: align with dine-in visual semantics. Table sessions persist
        // the fired+sent mutation on their items until payment, so reopening a table shows
        // them green. Walk-ins had the same mutation applied to walkInOrder but clearWalkIn()
        // wipes it immediately — and the queueEntry (the only persistent record OrdersHub can
        // rehydrate from) was capturing items pre-mutation, so reopens rendered them as
        // pending (not green). Apply the same mutation here so reopens show them sent/green.
        items: order.items.filter(i => !i.voided).map(i =>
          wiFiredOnSend.includes(i.course ?? 1) ? { ...i, fired: true, status: 'sent' } : i
        ),
        total: order.items.reduce((s, i) => s + i.price * i.qty, 0),
        status: 'prep', createdAt: order.createdAt || Date.now(), sentAt: Date.now(),
        collectionTime: customer?.collectionTime, isASAP: customer?.isASAP, staff: staff?.name,
      };
      const alreadyQueued = get().orderQueue.find(o => o.ref === ref);
      if (alreadyQueued) {
        set(s => ({ orderQueue: s.orderQueue.map(o => o.ref === ref ? { ...o, ...queueEntry } : o) }));
      } else {
        addToQueue(queueEntry);
      }
      set(s => ({
        walkInOrder: { ...(s.walkInOrder||{}), ref, sentAt: Date.now(), items: (s.walkInOrder?.items||[]).map(i => wiFiredOnSend.includes(i.course ?? 1) ? {...i, fired:true, status:'sent'} : i) },
        kdsTickets: [...s.kdsTickets, ...newTickets],
      }));
      newTickets.forEach(t => insertKDSTicket(t));
      get().showToast(customer?.name ? `Order sent — ${customer.name}` : 'Sent to kitchen', 'success');
    }
  },

  // v4.6.29: fires a previously-scheduled collection order through the normal
  // sendToKitchen path. Reconstructs walkInOrder/customer/orderType from the
  // stored queue entry, runs sendToKitchen with bypassSchedule=true so it
  // doesn't re-queue as scheduled, then restores the POS context.
  fireScheduledOrder: (ref) => {
    const { orderQueue } = get();
    const entry = orderQueue.find(o => o.ref === ref);
    if (!entry || entry.status !== 'scheduled') return;

    const reconstructed = {
      id: `ORD-scheduled-${Date.now()}`,
      ref: entry.ref,
      items: (entry.items || []).map(i => ({ ...i, status: 'pending', fired: false })),
      subtotal: entry.total || 0,
      total: entry.total || 0,
      createdAt: entry.createdAt || Date.now(),
    };
    const prev = {
      walkInOrder: get().walkInOrder,
      customer:    get().customer,
      orderType:   get().orderType,
    };
    set({
      walkInOrder: reconstructed,
      customer: entry.customer,
      orderType: entry.type || 'collection',
    });
    try {
      // bypassSchedule=true: this order is already at/past its fire time,
      // don't let the scheduler re-defer it.
      get().sendToKitchen({ bypassSchedule: true });
    } finally {
      // Restore prior POS context. orderQueue mutations persist because
      // sendToKitchen matched the ref via alreadyQueued and merged into the
      // existing entry (flipping status scheduled → prep, setting sentAt).
      set(prev);
    }
  },

  // v4.6.29: iterate orderQueue for any scheduled orders whose
  // scheduledFireAt is in the past and fire them. Called on an interval
  // from SyncBridge (every 60s).
  tickScheduledOrders: () => {
    const { orderQueue } = get();
    const now = Date.now();
    const due = orderQueue.filter(o => o.status === 'scheduled' && (o.scheduledFireAt || 0) <= now);
    if (!due.length) return;
    due.forEach(o => {
      try { get().fireScheduledOrder(o.ref); } catch (err) {
        console.warn('[tickScheduledOrders] failed to fire', o.ref, err);
      }
    });
  },

  fireCourse: (courseNum) => {
    const { activeTableId, tables } = get();
    if (!activeTableId) return;
    const table = tables.find(t => t.id === activeTableId);
    const session = table?.session;
    if (!session) return;

    // Mark course as fired in POS session
    set(s => ({
      tables: s.tables.map(t => {
        if (t.id !== activeTableId || !t.session) return t;
        const firedCourses = [...new Set([...(t.session.firedCourses||[]), courseNum])];
        const items = t.session.items.map(i => i.course === courseNum ? { ...i, fired:true, status:'sent' } : i);
        return { ...t, session: { ...t.session, items, firedCourses } };
      }),
      // Update in-store kds tickets: mark course items as fired
      kdsTickets: s.kdsTickets.map(ticket => {
        if (ticket.table !== (table?.label || activeTableId)) return ticket;
        if ((ticket.firedCourses||[]).includes(courseNum)) return ticket;
        const firedCourses = [...new Set([...(ticket.firedCourses||[0,1]), courseNum])];
        const items = (ticket.items||[]).map(i => i.course === courseNum ? { ...i, fired:true } : i);
        return { ...ticket, firedCourses, items };
      }),
    }));

    // Update kds_tickets in Supabase so KDS screen reacts via realtime
    import('../lib/supabase.js').then(async ({ supabase, getLocationId, getActiveLocationSync }) => {
      try {
        if (!supabase) return;
        const locId = getActiveLocationSync() || await getLocationId();
        if (!locId) return;
        const { data: tickets } = await supabase
          .from('kds_tickets')
          .select('id, fired_courses, items')
          .eq('location_id', locId)
          .eq('table_label', table?.label || activeTableId)
          .eq('status', 'pending')
          .order('sent_at', { ascending: false })
          .limit(3);
        if (!tickets?.length) return;
        for (const ticket of tickets) {
          if ((ticket.fired_courses||[]).includes(courseNum)) continue;
          const firedCourses = [...new Set([...(ticket.fired_courses||[0,1]), courseNum])];
          const updatedItems = (ticket.items||[]).map(i => i.course === courseNum ? { ...i, fired:true } : i);
          await supabase.from('kds_tickets')
            .update({ fired_courses: firedCourses, items: updatedItems })
            .eq('id', ticket.id);
        }
      } catch (e) { console.warn('fireCourse Supabase update failed', e); }
    });

    // v4.6.8: print a minimal "FIRE COURSE N" marker docket to each centre that
    // has items in the newly-fired course. Courses 0+1 already printed on initial
    // send, so skip those. Guard against double-fire by checking firedCourses
    // from the PRE-patch session above (already updated in our set() above — we use
    // kdsTickets snapshot to determine which centres to notify).
    if (courseNum > 1) {
      const tableLabel = table?.label || activeTableId;
      const centresInCourse = new Set();
      // Primary: read from in-memory kdsTickets (still populated if KDS hasn't bumped it)
      (get().kdsTickets || []).forEach(tk => {
        if (tk.table !== tableLabel) return;
        if ((tk.items || []).some(i => i.course === courseNum)) centresInCourse.add(tk.centreId);
      });
      // v4.6.58: fallback — derive centres directly from the table session items + routing.
      // kdsTickets gets cleared once dishes are bumped from KDS, so by the time staff hits
      // Fire course on a later course there may be no ticket left to read centres from.
      // The session items are still there and still carry their categories, so we can
      // route them ourselves using the SAME routing config used at send time.
      if (centresInCourse.size === 0) {
        try {
          const routingConfig = (() => {
            try {
              const snap = JSON.parse(localStorage.getItem('rpos-config-snapshot') || '{}')?.printRouting;
              if (snap?.centres?.length) return snap;
              return JSON.parse(localStorage.getItem('rpos-print-routing') || 'null') || { centres: [], routing: {} };
            } catch { return { centres: [], routing: {} }; }
          })();
          const { centres = [], routing = {} } = routingConfig;
          // Local copy of the centre-resolution logic. Same behaviour as the inline one
          // used inside sendToKitchen, just reused here.
          const menu = get().menuItems || [];
          const menuById = new Map(menu.map(m => [m.id, m]));
          const parentMap = new Map(menu.filter(m => m.parentId).map(m => [m.id, m.parentId]));
          const catOrAncestorMatches = (cat, assignedSet, pm) => {
            let cur = cat; let depth = 0;
            while (cur && depth < 10) {
              if (assignedSet.has(cur)) return true;
              cur = pm.get(cur) || null;
              depth++;
            }
            return false;
          };
          const courseItems = (table?.session?.items || []).filter(i => i.course === courseNum && i.status !== 'voided');
          courseItems.forEach(item => {
            const full = menuById.get(item.id) || menuById.get(item.itemId) || item;
            const cat = full.cat || full.category;
            const parentCat = full.parentId ? (menuById.get(full.parentId)?.cat || menuById.get(full.parentId)?.category) : null;
            centres.forEach(centre => {
              const r = routing?.[centre.id];
              if (!r?.assignedCategories?.length) return;
              if (r.excludedItems?.includes(item.id) || r.excludedItems?.includes(item.itemId)) return;
              const assignedSet = new Set(r.assignedCategories);
              const matches = (cat && catOrAncestorMatches(cat, assignedSet, parentMap))
                           || (parentCat && catOrAncestorMatches(parentCat, assignedSet, parentMap));
              if (matches) centresInCourse.add(centre.id);
            });
          });
          if (centresInCourse.size > 0) {
            console.log('[fireCourse] derived centres from session items:', [...centresInCourse]);
          }
        } catch (err) {
          console.warn('[fireCourse] fallback centre derivation failed:', err?.message || err);
        }
      }
      centresInCourse.forEach(centreId => {
        get().routePrintJob({
          centreId,
          tableLabel,
          course: courseNum,
          type: 'fire-marker',
        });
      });
    }
    get().showToast('Course ' + courseNum + ' fired to kitchen', 'success');
  },

  // ── Walk-in order (non-table) ──────────────
  walkInOrder: null,
  clearWalkIn: () => set({ walkInOrder:null, customer:null, orderType:'dine-in', pendingLoyaltyReward:null }),

  // activeSessions — map of tableId → session for all tables that have a session
  // Used by Reports, AI assistant, and back office dashboard
  getActiveSessions: () => {
    const tables = get().tables;
    return Object.fromEntries(
      tables.filter(t => t.session).map(t => [t.id, t.session])
    );
  },

  // Get current items/totals for POS (works for both table and walk-in)
  getPOSItems: () => {
    const { activeTableId, tables, walkInOrder } = get();
    if (activeTableId) {
      return tables.find(t=>t.id===activeTableId)?.session?.items || [];
    }
    return walkInOrder?.items || [];
  },

  getPOSTotals: () => {
    const { activeTableId, tables, walkInOrder, orderType, deviceConfig } = get();
    let items, checkDiscounts, covers, serviceChargeWaived;
    if (activeTableId) {
      const session = tables.find(t=>t.id===activeTableId)?.session;
      items = session?.items || [];
      checkDiscounts = session?.discounts || [];
      covers = session?.covers || 1;
      serviceChargeWaived = session?.serviceChargeWaived || false;
    } else {
      items = walkInOrder?.items || [];
      checkDiscounts = walkInOrder?.discounts || [];
      covers = 1;
      serviceChargeWaived = walkInOrder?.serviceChargeWaived || false;
    }
    // Subtotal — voided items excluded, item discounts applied
    const subtotal = items.filter(i=>!i.voided).reduce((s,i)=>{
      const base = i.price * i.qty;
      if (!i.discount) return s + base;
      return s + (i.discount.type==='percent' ? base*(1-i.discount.value/100) : Math.max(0,base-i.discount.value));
    }, 0);
    // Check-level discounts
    const checkDiscount = checkDiscounts.reduce((s,d) => s + (d.type==='percent'?subtotal*d.value/100:d.value), 0);
    const discountedSub = Math.max(0, subtotal - checkDiscount);

    // Service charge — from device profile config, dine-in only, respects waived flag
    const serviceRate = resolveServiceCharge({ deviceConfig, orderType, covers, waived: serviceChargeWaived });
    const service = discountedSub * serviceRate;

    return {
      subtotal, checkDiscount, discountedSub, service,
      serviceChargeWaived,
      serviceChargeApplicable: orderType === 'dine-in' && (deviceConfig?.serviceCharge?.enabled !== false),
      total: discountedSub + service,
      itemCount: items.filter(i=>!i.voided).reduce((s,i)=>s+i.qty,0),
    };
  },

  getPOSOrderNote: () => {
    const { activeTableId, tables, walkInOrder } = get();
    if (activeTableId) return tables.find(t=>t.id===activeTableId)?.session?.orderNote || '';
    return walkInOrder?.orderNote || '';
  },

  // ── Allergens ─────────────────────────────
  // v4.6.67: when allergen filter is set on a customer-attached order, the toast
  // offers Save to profile. This action runs upsertCustomer with the active filter.
  saveAllergensToCustomer: async (customer) => {
    if (!customer?.phone) return null;
    const list = get().allergens || [];
    return await get().upsertCustomer({ ...customer, allergens: list });
  },
  // ── Allergens ─────────────────────────────
  allergens: [],
  toggleAllergen: id => set(s=>({ allergens:s.allergens.includes(id)?s.allergens.filter(a=>a!==id):[...s.allergens,id] })),
  clearAllergens: () => set({ allergens:[] }),

  // ── Order type / customer ─────────────────
  orderType: 'dine-in',
  // v4.5.6: when order type changes (dine-in / takeaway / collection / delivery),
  // reprice every item in every cart against the new channel. Covers BOTH:
  //   - tables[].session.items (dine-in tables)
  //   - walkInOrder.items (walk-in / takeaway / collection / delivery flow)
  // Without this, items added BEFORE the toggle keep their old price (was the bug).
  setOrderType: t => set(s => {
    const fn = s.getItemPrice;
    if (!fn) return { orderType:t };
    const menu = (s.menuItems || []).concat(s.SEED_MENU_ITEMS || []);
    const repriceItems = (items) => (items || []).map(it => {
      const src = menu.find(m => m && m.id === it.itemId);
      if (!src) return it;
      const newUnitPrice = fn(src, t);
      if (newUnitPrice == null) return it;
      return { ...it, price: newUnitPrice };
    });
    const tables = (s.tables || []).map(tb => {
      if (!tb.session?.items) return tb;
      return { ...tb, session: { ...tb.session, items: repriceItems(tb.session.items) } };
    });
    const walkInOrder = s.walkInOrder?.items
      ? { ...s.walkInOrder, items: repriceItems(s.walkInOrder.items) }
      : s.walkInOrder;
    return { orderType:t, tables, walkInOrder };
  }),
  customer: null,
  setCustomer: c => set({ customer:c }),
  clearCustomer: () => set({ customer:null, pendingLoyaltyReward:null }),
  // v5.5.349: a loyalty reward the customer chose on the customer display, staged
  // until checkout (points are only deducted when CheckoutModal applies it).
  pendingLoyaltyReward: null,
  setPendingLoyaltyReward: r => set({ pendingLoyaltyReward: r }),

  // v4.4.9: write a customer record onto a specific table's session. Used by
  // TablesSurface (Add/Edit Guest from detail panel + ReservationModal) so that
  // the existing POSSurface hydrate-from-session-on-mount path picks the customer
  // up automatically when staff returns to the table. Persists immutably; if the
  // table has no session yet (rare, but possible during reservation), this is a
  // no-op since reservation flow stores the customer on tbl.reservation, not session.
  setSessionCustomer: (tableId, c) => set(s => ({
    tables: s.tables.map(t =>
      t.id === tableId && t.session
        ? { ...t, session: { ...t.session, customer: c || null } }
        : t
    ),
  })),
  // v4.6.62: customer cache (session). DB-backed via searchCustomersLive + upsertCustomer.
  customerHistory: [],
  _cachedOrgId: null,
  // ── Customers (v4.6.62) ──────────────────────────────────────
  // Phone is the primary identifier (normalised to E.164). DB-backed via Supabase.

  // Normalise UK-ish phone strings into E.164. Falls back to digits-only if format unknown.
  _normalisePhone: (raw) => {
    if (!raw) return null;
    const digits = String(raw).replace(/[^\d+]/g, '');
    if (!digits) return null;
    if (digits.startsWith('+')) return digits;
    if (digits.startsWith('07') && digits.length === 11) return '+44' + digits.slice(1);
    if (digits.startsWith('44')) return '+' + digits;
    return digits;
  },

  // Synchronous filter against the session cache. Used by CustomerModal alongside the live
  // Supabase search for instant feedback.
  searchCustomers: q => {
    if (!q || q.length < 2) return [];
    const l = String(q).toLowerCase();
    const qd = String(q).replace(/\s/g, '');
    return (get().customerHistory || []).filter(c =>
      (c.name || '').toLowerCase().includes(l) ||
      (c.phone || '').replace(/\s/g, '').includes(qd) ||
      (c.phone_raw || '').replace(/\s/g, '').includes(qd) ||
      (c.email || '').toLowerCase().includes(l)
    ).slice(0, 8);
  },

  // Live Supabase search. CustomerModal calls this with debounce.
  // v5.5.280: raised minimum from 2→3 chars for Supabase queries to reduce
  // load at scale. Phone queries additionally gated to 6+ digits in CustomerModal.
  searchCustomersLive: async (q) => {
    if (!q || q.length < 3) return [];
    if (isMock || !supabase) return get().searchCustomers(q);
    try {
      const locId = getActiveLocationSync() || await getLocationId();
      if (!locId) { console.warn('[searchCustomersLive] no locId'); return []; }
      let orgId = get()._cachedOrgId;
      if (!orgId) {
        const { data: loc, error: locErr } = await supabase.from('locations').select('org_id').eq('id', locId).single();
        if (locErr) console.warn('[searchCustomersLive] locations lookup failed:', locErr.message);
        orgId = loc?.org_id;
        if (orgId) set({ _cachedOrgId: orgId });
      }
      const term = String(q).trim();
      const safe = term.replace(/[,%]/g, '');
      let enriched = [];
      if (orgId) {
        // Primary path: search within the organisation
        const { data, error: searchErr } = await supabase
          .from('customers')
          .select('id, name, phone, phone_raw, email, marketing_opt_in, notes, allergens')
          .eq('org_id', orgId)
          .is('deleted_at', null)
          .or(`name.ilike.%${safe}%,phone.ilike.%${safe}%,phone_raw.ilike.%${safe}%,email.ilike.%${safe}%`)
          .limit(8);
        if (searchErr) console.warn('[searchCustomersLive] query failed:', searchErr.message);
        enriched = data || [];
      }
      // v5.5.248: fallback — if org_id lookup failed or query returned nothing,
      // try a direct phone match using normalised phone. Ensures POS devices
      // with anonymous auth can still find customers by phone number.
      // v5.5.279: MUST scope fallback by org_id — the previous version queried
      // the entire customers table, leaking PII across organisations.
      // v5.5.280: raised phone fallback threshold from 3→6 digits to reduce result set at scale
      if (enriched.length === 0 && safe.length >= 6 && orgId) {
        const phoneN = get()._normalisePhone(safe);
        const phoneFilters = [safe];
        if (phoneN && phoneN !== safe) phoneFilters.push(phoneN);
        const orFilter = phoneFilters.map(p => `phone.eq.${p},phone_raw.eq.${p}`).join(',');
        const { data: fallback } = await supabase
          .from('customers')
          .select('id, name, phone, phone_raw, email, marketing_opt_in, notes, allergens')
          .eq('org_id', orgId)
          .is('deleted_at', null)
          .or(orFilter)
          .limit(8);
        if (fallback?.length) enriched = fallback;
      }
      // Merge into customerHistory cache, deduped
      const merged = [...enriched, ...(get().customerHistory || [])];
      const seen = new Set();
      const dedup = merged.filter(c => {
        const key = c.phone || c.email || c.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 50);
      set({ customerHistory: dedup });
      return enriched;
    } catch (err) {
      console.warn('[searchCustomersLive] failed:', err?.message || err);
      return get().searchCustomers(q);
    }
  },

  // Entry point from CustomerModal when the operator confirms customer details.
  addToHistory: (c) => {
    const phoneN = get()._normalisePhone(c.phone);
    const cached = {
      ...c,
      id: c.id || `c${Date.now()}`,
      phone: phoneN,
      phone_raw: c.phone,
      visits: (c.visits || 0) + 1,
      lastOrder: 'Just now',
    };
    set(s => ({
      customerHistory: [
        cached,
        ...(s.customerHistory || []).filter(x => x.phone !== phoneN && x.phone_raw !== c.phone),
      ].slice(0, 50),
    }));
    // Async upsert to Supabase (don't block the UI)
    get().upsertCustomer(c).catch(err => console.warn('[addToHistory upsert]', err?.message || err));
    return cached;
  },

  // Persist a customer. Returns the customer's UUID. Phone wins on conflict;
  // if a different operator types a different name, the existing one stands.
  upsertCustomer: async (c) => {
    if (isMock || !supabase) return null;
    try {
      const locId = getActiveLocationSync() || await getLocationId();
      if (!locId) {
        console.warn('[upsertCustomer] no locationId resolved — customer not saved');
        return null;
      }
      let orgId = get()._cachedOrgId;
      if (!orgId) {
        const { data: loc, error: locErr } = await supabase.from('locations').select('org_id').eq('id', locId).single();
        if (locErr) {
          console.warn('[upsertCustomer] failed to read locations.org_id for', locId, ':', locErr.message);
        }
        orgId = loc?.org_id;
        if (orgId) set({ _cachedOrgId: orgId });
      }
      if (!orgId) {
        console.warn('[upsertCustomer] no orgId for location', locId, '— customer not saved. The location row may be missing org_id.');
        return null;
      }
      const phoneN = get()._normalisePhone(c.phone);
      if (!phoneN) {
        console.warn('[upsertCustomer] phone normalisation returned null for', c.phone);
        return null;
      }
      const row = {
        org_id: orgId,
        phone: phoneN,
        phone_raw: c.phone || phoneN,
        email: c.email || null,
        name: c.name || 'Customer',
        notes: c.notes || null,
        marketing_opt_in: !!c.marketingOptIn,
        marketing_opt_in_at: c.marketingOptIn ? new Date().toISOString() : null,
        // v4.6.67: allergens carried through. Caller decides whether to include them.
        allergens: Array.isArray(c.allergens) ? c.allergens : undefined,
        updated_at: new Date().toISOString(),
      };
      const { data: existing, error: lookupErr } = await supabase.from('customers')
        .select('id, name, email, marketing_opt_in, allergens')
        .eq('org_id', orgId).eq('phone', phoneN).is('deleted_at', null).maybeSingle();
      if (lookupErr) {
        console.warn('[upsertCustomer] lookup failed:', lookupErr.message, '(may be RLS — check customers SELECT policy)');
      }
      if (existing?.id) {
        const patch = { updated_at: row.updated_at };
        if (!existing.name && row.name) patch.name = row.name;
        if (!existing.email && row.email) patch.email = row.email;
        if (row.marketing_opt_in && !existing.marketing_opt_in) {
          patch.marketing_opt_in = true;
          patch.marketing_opt_in_at = row.marketing_opt_in_at;
        }
        // v4.6.67: replace allergens array if caller passed one (explicit save
        // from the toast / detail page). Don't merge — operator decides exact set.
        if (Array.isArray(row.allergens)) patch.allergens = row.allergens;
        if (Object.keys(patch).length > 1) {
          const { error: updErr } = await supabase.from('customers').update(patch).eq('id', existing.id);
          if (updErr) console.warn('[upsertCustomer] update existing failed:', updErr.message);
        }
        return existing.id;
      } else {
        const { data: created, error } = await supabase.from('customers').insert(row).select('id').single();
        if (error) {
          console.warn('[upsertCustomer] insert failed:', error.message, '(may be RLS — check customers INSERT policy; or unique constraint on (org_id, phone))');
          return null;
        }
        return created?.id || null;
      }
    } catch (err) {
      console.warn('[upsertCustomer] failed:', err?.message || err);
      return null;
    }
  },

  // Attribute a closed check / walk-in to a customer. Increments visit_count + spend
  // on customer_locations and inserts a customer_orders row. Returns customer_id.
  attributeOrderToCustomer: async ({ customer, orderRecord }) => {
    if (isMock || !supabase) return null;
    if (!customer?.phone || !orderRecord) {
      console.warn('[attributeOrderToCustomer] skipped — missing customer.phone or orderRecord');
      return null;
    }
    try {
      const locId = getActiveLocationSync() || await getLocationId();
      if (!locId) {
        console.warn('[attributeOrderToCustomer] skipped — no locationId resolved');
        return null;
      }
      // v5.5.5: explicit step logging so we can see exactly which write failed when
      // a customer doesn't appear in the CRM after an order. Previous version was
      // fire-and-forget with a generic catch-all that hid which step broke.
      const customerId = await get().upsertCustomer(customer);
      if (!customerId) {
        console.warn('[attributeOrderToCustomer] upsertCustomer returned null for', customer.phone, '— check upsertCustomer logs above');
        return null;
      }
      console.log('[attributeOrderToCustomer] step 1/3 — customer upserted:', customerId, 'phone:', customer.phone, 'location:', locId);

      // Step 2: bump visit_count + lifetime_revenue on customer_locations.
      // v5.5.7: removed dependency on the upsert_customer_visit RPC entirely.
      // Two failure modes that the v5.5.5 fallback didn't catch:
      //   (a) RPC returns error:null but writes nothing (broken function body,
      //       missing GRANT, RLS in SECURITY INVOKER mode that hides write).
      //       v5.5.5's fallback only fired on rpcErr — silent success was fatal.
      //   (b) The fallback's onConflict:'customer_id,location_id' upsert
      //       requires that unique constraint to exist on the table. If the
      //       v4.6.62 migration ran without creating it, the upsert errors.
      // New approach: explicit read → INSERT or UPDATE. No RPC. No onConflict.
      // No DB-side requirements beyond the table existing. Race-prone if two
      // devices close orders for the same customer simultaneously, but for
      // restaurant load that's a non-issue, and correctness > theoretical races.
      let cl_step_status = 'unknown';
      try {
        const { data: existingLoc, error: readErr } = await supabase
          .from('customer_locations')
          .select('visit_count, lifetime_revenue')
          .eq('customer_id', customerId)
          .eq('location_id', locId)
          .maybeSingle();
        if (readErr) {
          console.warn('[attributeOrderToCustomer] customer_locations read failed:', readErr.message, '(may be RLS — check customer_locations SELECT policy)');
        }
        const incRevenue = Number(orderRecord.total) || 0;
        const nowIso = new Date().toISOString();
        if (existingLoc) {
          // UPDATE existing row
          const newCount = (Number(existingLoc.visit_count) || 0) + 1;
          const newRevenue = (Number(existingLoc.lifetime_revenue) || 0) + incRevenue;
          const { error: updErr } = await supabase
            .from('customer_locations')
            .update({
              visit_count: newCount,
              lifetime_revenue: newRevenue,
              last_visit_at: nowIso,
            })
            .eq('customer_id', customerId)
            .eq('location_id', locId);
          if (updErr) {
            console.warn('[attributeOrderToCustomer] customer_locations UPDATE failed:', updErr.message, '(may be RLS — check customer_locations UPDATE policy)');
            cl_step_status = 'update_failed';
          } else {
            console.log('[attributeOrderToCustomer] step 2/3 — customer_locations UPDATE (visit', newCount, ', rev', newRevenue.toFixed(2), ')');
            cl_step_status = 'updated';
          }
        } else {
          // INSERT new row
          const { error: insErr } = await supabase
            .from('customer_locations')
            .insert({
              customer_id: customerId,
              location_id: locId,
              visit_count: 1,
              lifetime_revenue: incRevenue,
              last_visit_at: nowIso,
            });
          if (insErr) {
            // If a concurrent insert beat us, the row exists now — try update.
            if (/duplicate|conflict/i.test(insErr.message)) {
              console.warn('[attributeOrderToCustomer] customer_locations INSERT raced — retrying as UPDATE');
              const { error: retryErr } = await supabase
                .from('customer_locations')
                .update({ last_visit_at: nowIso })
                .eq('customer_id', customerId).eq('location_id', locId);
              if (retryErr) {
                console.warn('[attributeOrderToCustomer] customer_locations retry-update failed:', retryErr.message);
                cl_step_status = 'race_retry_failed';
              } else {
                cl_step_status = 'inserted_via_race_retry';
              }
            } else {
              console.warn('[attributeOrderToCustomer] customer_locations INSERT failed:', insErr.message, '(may be RLS — check customer_locations INSERT policy)');
              cl_step_status = 'insert_failed';
            }
          } else {
            console.log('[attributeOrderToCustomer] step 2/3 — customer_locations INSERT (first visit at this location)');
            cl_step_status = 'inserted';
          }
        }
      } catch (e) {
        console.warn('[attributeOrderToCustomer] customer_locations write threw:', e?.message || e);
        cl_step_status = 'threw';
      }
      void cl_step_status; // keep for breakpoint readability if needed

      // Step 3: insert customer_orders row.
      const itemSummary = (orderRecord.items || []).map(i => ({
        name: i.name, qty: i.qty, price: i.price,
      }));
      const { error: ordersErr } = await supabase.from('customer_orders').insert({
        customer_id: customerId,
        location_id: locId,
        closed_check_id: orderRecord.ref || orderRecord.id || null,
        ordered_at: new Date().toISOString(),
        total: Number(orderRecord.total) || 0,
        channel: orderRecord.orderType || orderRecord.type || orderRecord.source || 'unknown',
        item_summary: itemSummary,
      });
      if (ordersErr) {
        console.warn('[attributeOrderToCustomer] customer_orders insert failed:', ordersErr.message);
      } else {
        console.log('[attributeOrderToCustomer] step 3/3 — customer_orders inserted');
      }

      // Stamp customer_id on the closed_check (best-effort; scope by location_id
      // to avoid the cross-location ref collision that would otherwise update
      // closed_checks at OTHER locations sharing the same ref string).
      if (orderRecord.ref) {
        const { error: stampErr } = await supabase.from('closed_checks')
          .update({ customer_id: customerId })
          .eq('ref', orderRecord.ref)
          .eq('location_id', locId);
        if (stampErr) console.warn('[attributeOrderToCustomer] closed_checks customer_id stamp failed:', stampErr.message);
      }

      // v5.5.272: Send welcome SMS invite for new customers (pre-register for loyalty).
      // Fire-and-forget — send-welcome has atomic dedup via welcome_sent_at so calling
      // it for existing customers is a harmless no-op. Covers kiosk guest checkout,
      // POS customer capture, and any other surface using attributeOrderToCustomer.
      // (Online ordering already fires this from customerLookup.js; OTP-verified
      // customers get it from loyalty-otp verify. The dedup prevents double sends.)
      (async () => {
        try {
          let companyId = null;
          if (platformSupabase) {
            const { data: pLoc } = await platformSupabase
              .from('locations')
              .select('company_id')
              .or(`ops_location_id.eq.${locId},id.eq.${locId}`)
              .limit(1).maybeSingle();
            companyId = pLoc?.company_id;
          }
          if (companyId) {
            const wToken = await ensureAuthToken();
            fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-welcome`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...(wToken ? { Authorization: `Bearer ${wToken}` } : {}) },
              body: JSON.stringify({
                customer_id: customerId,
                company_id: companyId,
                location_id: locId,
              }),
            }).catch(() => {});
          }
        } catch (e) {
          console.warn('[attributeOrderToCustomer] welcome send failed (non-fatal):', e?.message);
        }
      })();

      // v5.5.315: link any reward redemption to this check so a future refund
      // restores the spent points. The redeem ran in CheckoutModal BEFORE the
      // check existed, so its loyalty_transactions row has closed_check_id=NULL
      // — loyalty-refund (which reverses by closed_check_id) would never find it.
      // Back-patch it to the same unique check id the earn uses. Best-effort: if
      // it no-ops, behaviour is unchanged from before (redeem just won't reverse).
      const redeemKey = orderRecord.loyaltyRedemption?.idempotency_key;
      if (redeemKey && supabase) {
        supabase.from('loyalty_transactions')
          .update({ closed_check_id: orderRecord.id })
          .eq('idempotency_key', redeemKey)
          .is('closed_check_id', null)
          .then(({ error }) => { if (error) console.warn('[attributeOrderToCustomer] redeem link failed:', error.message); });
      }

      // v5.5.218: Loyalty points earn — fire-and-forget after customer is resolved.
      // Same async IIFE pattern as gift card reversal: local mutation already happened
      // so UX stays snappy. If the edge function is unreachable the points aren't
      // earned — acceptable because the customer can contact support, and we log it.
      (async () => {
        try {
          const token = await ensureAuthToken();
          if (!token) { console.warn('[attributeOrderToCustomer] loyalty earn skipped — no auth token'); return; }
          // v5.5.256: resolve parent category for variants so stamp cards can
          // match qualifying categories. Variants (sizes) don't have their own
          // cat field — they inherit from their master product.
          const allMenuItems = get().menuItems || [];
          const menuById = new Map(allMenuItems.map(m => [m.id, m]));
          const earnBody = {
            customer_id: customerId,
            location_id: locId,
            // v5.5.311: use the globally-unique closed-check id (chk-<ts>, the
            // closed_checks PK) NOT the display ref. Refs cycle R1–R99 per
            // location and repeat across locations, so an `earn:<ref>`
            // idempotency key collided — a 2nd customer 99 orders later (or in
            // another tenant) was told "already processed" and earned 0 points,
            // or hit the global UNIQUE constraint and silently dropped the
            // ledger row. The chk id is unique, so the key never collides.
            closed_check_id: orderRecord.id || orderRecord.ref,
            channel: orderRecord.orderType || orderRecord.source || 'pos',
            items: (orderRecord.items || []).map(i => {
              let cat = i.cat || i.category || null;
              // v5.5.259: Variants ALWAYS use parent's category. Variant
              // rows in the DB can have a stale/wrong cat (e.g. Sandwiches
              // instead of Coffee) from category reassignment or creation
              // bugs. The parent's cat is the source of truth for what
              // "type" of product this is.
              if (i.parentId) {
                const parent = menuById.get(i.parentId);
                const parentCat = parent?.cat || parent?.cats?.[0] || null;
                if (parentCat) cat = parentCat;
              }
              // Double fallback: look up the original menu item's cat
              if (!cat) {
                const mi = menuById.get(i.itemId || i.id);
                if (mi?.parentId) {
                  // Variant via menu lookup — use parent's cat
                  const parent = menuById.get(mi.parentId);
                  cat = parent?.cat || parent?.cats?.[0] || null;
                } else {
                  cat = mi?.cat || mi?.cats?.[0] || null;
                }
              }
              return {
                name: i.name, qty: i.qty || 1, price: i.price || 0,
                cat,
                id: i.itemId || i.id || null,
                isComp: !!i.isComp,
                staffDiscount: !!i.isStaffDiscount,
                isGiftCard: !!i.isGiftCard,
              };
            }),
            subtotal: Number(orderRecord.total) || 0,
            staff_id: orderRecord.staffId || null,
          };
          const res = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/loyalty-earn`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
              body: JSON.stringify(earnBody),
            }
          );
          const j = await res.json().catch(() => ({}));
          if (res.ok) {
            console.info('[loyalty-earn] ✓', j.points_earned, 'pts → balance:', j.balance, j.is_new_member ? '(new member)' : '');
            // Show points-earned toast (fire after short delay so payment toast clears first)
            if (j.points_earned > 0) {
              setTimeout(() => {
                get().showToast?.(
                  j.is_new_member
                    ? `⭐ Welcome! ${j.points_earned} loyalty points earned`
                    : `⭐ ${j.points_earned} loyalty points earned (balance: ${j.balance})`,
                  'success'
                );
              }, 1500);
            }
            // Stamp card notifications
            if (j.stamps_awarded && j.stamps_awarded.length > 0) {
              j.stamps_awarded.forEach((sa, idx) => {
                setTimeout(() => {
                  get().showToast?.(
                    sa.completed
                      ? `☕ ${sa.program_name} COMPLETE! Reward earned 🎁`
                      : `☕ +${sa.stamps} stamp${sa.stamps > 1 ? 's' : ''} on ${sa.program_name} (${sa.new_total} collected)`,
                    sa.completed ? 'success' : 'info'
                  );
                }, 2500 + idx * 1200);
              });
            }
            // Stamp loyalty summary on the closed check in local state for receipt/refund use
            if (j.points_earned > 0 || j.is_new_member) {
              const loyaltySummary = {
                points_earned: j.points_earned,
                balance: j.balance,
                member_code: j.member_code || null,
                is_new_member: !!j.is_new_member,
              };
              set(s => ({
                closedChecks: s.closedChecks.map(chk =>
                  chk.id === orderRecord.id ? { ...chk, loyalty: loyaltySummary } : chk
                ),
              }));
              // Best-effort persist loyalty jsonb to Supabase
              // v5.5.279: location_id guard on closed_checks update
              const loyLocId = getActiveLocationSync();
              supabase.from('closed_checks')
                .update({ loyalty: loyaltySummary })
                .eq('id', orderRecord.id)
                .eq('location_id', loyLocId)
                .then(({ error: le }) => { if (le) console.warn('[loyalty-earn] closed_check update:', le.message); });
            }
          } else {
            // 404 = loyalty not configured for this company — not an error
            if (res.status !== 404) {
              console.warn('[loyalty-earn] HTTP', res.status, j.error || '');
            }
          }
        } catch (e) {
          console.warn('[loyalty-earn] failed:', e?.message || e);
        }
      })();

      return customerId;
    } catch (err) {
      console.warn('[attributeOrderToCustomer] failed:', err?.message || err);
      return null;
    }
  },

  // ── Collection queue ──────────────────────
  orderQueue: [],
  addToQueue: o => set(s => ({ orderQueue: [o, ...s.orderQueue] })),
  updateQueueStatus: (ref, status) => set(s => ({ orderQueue: s.orderQueue.map(o => o.ref===ref ? {...o, status} : o) })),
  updateQueueItem: (ref, patch) => set(s => ({ orderQueue: s.orderQueue.map(o => o.ref===ref ? {...o,...patch} : o) })),
  removeFromQueue: ref => set(s => ({ orderQueue: s.orderQueue.filter(o => o.ref!==ref) })),

  // ── 86 ────────────────────────────────────
  eightySixIds: [],
  showItemImages: false,
  setShowItemImages: (val) => set({ showItemImages: val }),
  toggle86: id => {
    const is86 = get().eightySixIds.includes(id);
    set(s => ({ eightySixIds: is86 ? s.eightySixIds.filter(x=>x!==id) : [...s.eightySixIds, id] }));
    // Write to Supabase (no-op in mock mode)
    toggle86DB(id, is86);
    // Best-effort: mirror the new 86 state to HubRise channels (instant out-of-stock).
    // The reconcile cron also resyncs, so a missed push self-heals. !is86 = now 86'd.
    try {
      const locId = getActiveLocationSync();
      if (locId && isHubriseConnected(locId)) hubrisePushStock(locId, [{ itemId: id, is86: !is86 }]).catch(() => {});
    } catch { /* non-fatal */ }
  },

  // ── Daily counts / par levels ──────────────────────────────────────────────
  dailyCounts: {},
  setDailyCount: (itemId, count) => {
    const n = parseInt(count);
    if (!n || n <= 0) return;
    const was86 = get().eightySixIds.includes(itemId);
    set(s => ({
      dailyCounts: { ...s.dailyCounts, [itemId]: { par: n, remaining: n } },
      eightySixIds: was86 ? s.eightySixIds.filter(x => x !== itemId) : s.eightySixIds,
    }));
    // v5.5.241: persist to stock_levels for cross-device sync.
    // Pass the location from getActiveLocationSync() so we never wait on
    // getLocationId()'s async auth.getUser() call, and log the full response
    // so PostgREST errors are visible (the previous .catch() only caught
    // thrown errors — Supabase returns { data, error } as resolved promises).
    const _loc = getActiveLocationSync();
    upsertStockLevel(itemId, n, null, _loc).then(res => {
      if (res?.error) console.error('[setDailyCount] upsertStockLevel error:', res.error.message, res.error);
    }).catch(err => console.error('[setDailyCount] upsertStockLevel threw:', err?.message));
    // Un-86 in DB too if applicable
    if (was86) {
      toggle86DB(itemId, true).catch(err =>
        console.warn('[setDailyCount] toggle86DB un-86:', err?.message));
    }
  },
  clearDailyCount: (itemId) => {
    set(s => ({
      dailyCounts: { ...s.dailyCounts, [itemId]: undefined },
    }));
    // v5.5.241: remove from stock_levels — pass location directly
    const _loc2 = getActiveLocationSync();
    deleteStockLevel(itemId, _loc2).then(res => {
      if (res?.error) console.error('[clearDailyCount] deleteStockLevel error:', res.error.message);
    }).catch(err => console.error('[clearDailyCount] deleteStockLevel threw:', err?.message));
  },
  decrementDailyCount: (itemId, qty = 1) => {
    // v4.6.11: single source of truth for daily-count adjustments.
    // qty > 0: item consumed (remaining goes down, auto-86 when crossing to 0)
    // qty < 0: item returned (remaining goes back up, capped at par — no auto un-86)
    // Propagates to parent menu item if the child's parent also has a count set
    // (supports tracking stock on a variant-parent like "House Wine" when children
    // like "House Wine 175ml" are what actually get ordered).
    if (!itemId || !qty) return;
    const state = get();
    const menuItems = state.menuItems || [];
    const item = menuItems.find(m => m.id === itemId);
    const parentId = (item?.parentId || item?.parent_id) || null;

    const ids = [];
    if (state.dailyCounts[itemId]) ids.push(itemId);
    if (parentId && state.dailyCounts[parentId]) ids.push(parentId);
    if (!ids.length) return;

    // Local optimistic update (instant UI responsiveness)
    set(s => {
      const newCounts = { ...s.dailyCounts };
      const newEightySix = [...s.eightySixIds];
      const soldOutNames = [];

      ids.forEach(id => {
        const cur = newCounts[id];
        if (!cur) return;
        const newRem = Math.max(0, Math.min(cur.par, cur.remaining - qty));
        newCounts[id] = { ...cur, remaining: newRem };

        // Auto-86 on the transition from positive to zero. Repeated decrements at
        // 0 don't re-trigger the toast. Restores (qty<0) never un-86 automatically —
        // that's setDailyCount's job so manual toggle86's aren't clobbered.
        if (cur.remaining > 0 && newRem <= 0) {
          if (!newEightySix.includes(id)) {
            newEightySix.push(id);
            // v5.5.239: auto-86 is now also handled atomically by the
            // decrement_stock RPC, but we keep the local push for instant UI
          }
          soldOutNames.push(menuItems.find(mi => mi.id === id)?.name || id);
        }
      });

      if (soldOutNames.length) {
        setTimeout(() => get().showToast(`${soldOutNames[0]} sold out — auto 86'd`, 'warning'), 0);
      }
      return { dailyCounts: newCounts, eightySixIds: newEightySix };
    });

    // v5.5.241: DB-level atomic decrement — pass location directly.
    const _loc3 = getActiveLocationSync();
    ids.forEach(id => {
      if (qty > 0) {
        decrementStockRPC(id, qty, _loc3).then(res => {
          if (res?.error) console.error('[decrementDailyCount] decrement RPC error:', res.error.message);
        }).catch(err => console.error('[decrementDailyCount] decrement RPC threw:', err?.message));
      } else {
        restoreStockRPC(id, Math.abs(qty), _loc3).then(res => {
          if (res?.error) console.error('[decrementDailyCount] restore RPC error:', res.error.message);
        }).catch(err => console.error('[decrementDailyCount] restore RPC threw:', err?.message));
      }
    });
  },

  // ── Bar tabs ──────────────────────────────
  tabs: [],
  activeTabId: null,
  openTab: ({ name, seatId=null, tableId=null, preAuth=false, preAuthAmount=50, note='', preAuthPaymentIntentId=null, preAuthStripeAccount=null, preAuthHeldMinor=null }) => {
    // v5.5.324: when a real card hold was placed at open, the PaymentIntent +
    // connected-account + held amount ride along on the tab so close can
    // capture it (and void can release it). Null when no reader / hold skipped.
    const tab = { id:`tab-${Date.now()}`, ref:`TAB-${_tabNum++}`, name:name.trim(), seatId, tableId, openedBy:get().staff?.name||'Staff', openedAt:Date.now(), status:'open', preAuth, preAuthAmount, preAuthPaymentIntentId, preAuthStripeAccount, preAuthHeldMinor, rounds:[], note, total:0 };
    set(s=>({ tabs:[tab,...s.tabs], activeTabId:tab.id }));
    // v4.6.26: when a bar tab is linked to a real table, flip that table on
    // the floor plan to 'occupied' so it renders correctly. Only do this if
    // the table is currently 'available' — don't stomp an active dine-in
    // session or a reservation.
    if (tableId) {
      const st = get();
      const tbl = (st.tables||[]).find(t => t.id === tableId);
      if (tbl && tbl.status === 'available') {
        get()._updateTable(tableId, { status: 'occupied' });
      }
    }
    return tab;
  },
  setActiveTab: id => set({ activeTabId:id }),
  addRoundToTab: (tabId, items, note='') => {
    const round = { id:uid(), sentAt:Date.now(), items:items.map(i=>({...i})), subtotal:items.reduce((s,i)=>s+i.price*i.qty,0), note };
    // v4.6.11: bar rounds deplete daily counts too — previously a bar tab could
    // sell an item past its stock with no auto-86 triggered.
    (items || []).forEach(i => {
      const id = i.itemId || i.id;
      if (id) get().decrementDailyCount(id, i.qty || 1);
      // v5.5.189: bar rounds also deplete modifier sub-item counts
      (i.mods || []).forEach(mod => {
        if (mod.itemId) get().decrementDailyCount(mod.itemId, (mod.qty || 1) * (i.qty || 1));
      });
    });
    set(s=>({ tabs:s.tabs.map(t=>{ if(t.id!==tabId)return t; const rounds=[...t.rounds,round]; return{...t,rounds,status:'running',total:rounds.reduce((s,r)=>s+r.subtotal,0)}; }) }));
    // v4.6.5 Bug 5: bar tab rounds never hit production centres. Now mirrors sendToKitchen
    // so each round fires KDS tickets + print jobs for every centre its items touch.
    try {
      const state = get();
      const tab = state.tabs.find(t => t.id === tabId) || { name: 'Bar tab' };
      const staffName = state.staff?.name || 'Server';
      const label = `Bar · ${tab.name || tabId}`;
      const getRoutingConfig = () => {
        try {
          const stored = state.printRouting;
          if (stored?.centres?.length) return stored;
          return JSON.parse(localStorage.getItem('rpos-print-routing') || 'null') || { centres: [], routing: {} };
        } catch { return { centres: [], routing: {} }; }
      };
      const routingConfig = getRoutingConfig();
      const centres = routingConfig.centres || [];
      const routing = routingConfig.routing || {};
      const parentMap = (() => {
        try {
          const snap = JSON.parse(localStorage.getItem('rpos-config-snapshot') || '{}');
          const cats = snap.menuCategories || state.menuCategories || [];
          const m = {}; cats.forEach(c => { m[c.id] = c.parentId || null; }); return m;
        } catch { return {}; }
      })();
      const catOrAncestor = (catId, set, depth=0) => {
        if (!catId || depth > 5) return false;
        if (set.has(catId)) return true;
        return catOrAncestor(parentMap[catId], set, depth + 1);
      };
      const allMenuItems = state.menuItems || [];
      const centresForItem = (item) => {
        if (!centres.length) return [];
        const mi = allMenuItems.find(i => i.id === (item.itemId || item.id));
        const itemCat = item.cat || item.cats?.[0] || mi?.cat || mi?.cats?.[0] || null;
        const parentCat = (mi?.parentId ? allMenuItems.find(i => i.id === mi.parentId)?.cat : null) || null;
        const matched = [];
        centres.forEach(c => {
          const r = routing[c.id];
          if (!r?.assignedCategories?.length) return;
          if (r.excludedItems?.includes(item.id) || r.excludedItems?.includes(item.itemId)) return;
          const set = new Set(r.assignedCategories);
          if ((itemCat && catOrAncestor(itemCat, set)) || (parentCat && catOrAncestor(parentCat, set))) matched.push(c.id);
        });
        return matched;
      };
      const byCentre = {};
      items.forEach(it => {
        if (it.voided) return;
        centresForItem(it).forEach(cid => {
          if (!byCentre[cid]) byCentre[cid] = [];
          byCentre[cid].push(it);
        });
      });
      const getCentrePrinter = (cid) => {
        const c = centres.find(x => x.id === cid);
        return c?.printer?.name || c?.name || { pc1:'Hot kitchen', pc2:'Cold section', pc3:'Pizza oven', pc4:'Bar', pc5:'Expo / pass' }[cid] || 'Kitchen';
      };
      const newTickets = Object.entries(byCentre).map(([centreId, centreItems]) => ({
        id: `kds-${Date.now()}-${centreId}-${Math.random().toString(36).slice(2,6)}`,
        table: label, server: staffName, covers: 1, centreId,
        sentAt: Date.now(), minutes: 0,
        firedCourses: [0, 1], allCourses: [1],
        items: centreItems.map(i => ({
          qty: i.qty,
          name: i.kitchenName || i.menu_name || i.menuName || i.name,
          mods: [
            ...(i.mods?.filter(m => !m._instruction).map(m => m.name || m.label).filter(Boolean) || []),  // v4.6.10: no groupLabel prefix on bar-round tickets either
            ...(i.mods?.filter(m => m._instruction).map(m => m.label).filter(Boolean) || []),
            ...(i.notes ? [`📝 ${i.notes}`] : []),
            ...(note ? [`📝 ${note}`] : []),
          ],
          course: i.course ?? 1,
          fired: true,
          centreId, uid: i.uid,
        })),
      }));
      if (newTickets.length) {
        set(s => ({ kdsTickets: [...s.kdsTickets, ...newTickets] }));
        newTickets.forEach(t => {
          insertKDSTicket(t);
          if (t.items.length) state.routePrintJob?.({
            centreId: t.centreId,
            printerName: getCentrePrinter(t.centreId),
            tableLabel: t.table,
            server: t.server,
            covers: t.covers,
            course: 1,
            items: t.items,
            type: 'kitchen',
          });
        });
      }
    } catch (e) { console.warn('[addRoundToTab] KDS/print dispatch failed:', e?.message || e); }
    return round;
  },
  updateTabNote: (tabId,note) => set(s=>({ tabs:s.tabs.map(t=>t.id===tabId?{...t,note}:t) })),
  updateTabStatus: (tabId,status) => set(s=>({ tabs:s.tabs.map(t=>t.id===tabId?{...t,status}:t) })),
  closeTab: tabId => {
    const st = get();
    const closing = st.tabs.find(t => t.id === tabId);
    set(s=>({ tabs:s.tabs.map(t=>t.id===tabId?{...t,status:'closed'}:t), activeTabId:s.activeTabId===tabId?null:s.activeTabId }));
    // v4.6.26: release the floor-plan table if this was a bar tab linked to
    // one, and no other open bar tab is still on it.
    if (closing && closing.tableId) {
      const remaining = get().tabs.some(t => t.tableId === closing.tableId && t.status !== 'closed' && t.id !== tabId);
      if (!remaining) {
        const tbl = (get().tables||[]).find(t => t.id === closing.tableId);
        if (tbl && tbl.status === 'occupied') {
          get()._updateTable(closing.tableId, { status: 'available' });
        }
      }
    }
  },
  voidTabRound: (tabId,roundId) => set(s=>({ tabs:s.tabs.map(t=>{ if(t.id!==tabId)return t; const rounds=t.rounds.filter(r=>r.id!==roundId); return{...t,rounds,total:rounds.reduce((s,r)=>s+r.subtotal,0)}; }) })),
  seedTabs: () => set({ tabs:[
    { id:'t-demo1', ref:'TAB-001', name:'Maria G.', seatId:'B1', tableId:null, openedBy:'Maria', openedAt:Date.now()-22*60000, status:'running', preAuth:false, preAuthAmount:0, note:'Birthday drinks', total:29.8,
      rounds:[
        { id:'r1', sentAt:Date.now()-20*60000, subtotal:17.4, note:'', items:[
          {uid:'ri1',name:'Lager — Pint',price:5.8,qty:2,mods:[],notes:''},
          {uid:'ri2',name:'Sparkling water',price:2.8,qty:1,mods:[],notes:'No ice'},
        ]},
        { id:'r2', sentAt:Date.now()-8*60000, subtotal:12.4, note:'', items:[
          {uid:'ri3',name:'Stout — Pint',price:6.2,qty:1,mods:[],notes:''},
          {uid:'ri4',name:'House white 250ml',price:8.5,qty:1,mods:[],notes:'Extra cold'},
        ]},
      ]},
    { id:'t-demo2', ref:'TAB-002', name:'Table 4 bar', seatId:null, tableId:'t4', openedBy:'Tom', openedAt:Date.now()-45*60000, status:'running', preAuth:false, preAuthAmount:0, note:'', total:35.2,
      rounds:[
        { id:'r3', sentAt:Date.now()-40*60000, subtotal:20.7, note:'', items:[
          {uid:'ri5',name:'Lager — Pint',price:5.8,qty:2,mods:[],notes:''},
          {uid:'ri6',name:'House red 175ml',price:6.5,qty:1,mods:[],notes:''},
          {uid:'ri7',name:'Coke',price:3.5,qty:1,mods:[],notes:''},
        ]},
        { id:'r4', sentAt:Date.now()-15*60000, subtotal:14.5, note:'', items:[
          {uid:'ri8',name:'Stout — Pint',price:6.2,qty:1,mods:[],notes:''},
          {uid:'ri9',name:'House white 250ml',price:8.5,qty:1,mods:[],notes:''},
        ]},
      ]},
  ] }),

  // ── Cash drawers (v4.6.35) ──────────────────────────────────────
  // First-class drawer entities. Each drawer has a printer that ejects it
  // and (optionally) a POS device strictly assigned to it. Persisted in
  // Supabase cash_drawers; hydrated on mount via useSupabaseInit.
  cashDrawers: [],

  loadCashDrawers: async () => {
    if (isMock || !supabase) return;
    try {
      const locId = getActiveLocationSync() || await getLocationId();
      if (!locId) return;
      const { data } = await supabase
        .from('cash_drawers')
        .select('*')
        .eq('location_id', locId)
        .order('created_at', { ascending: true });
      if (Array.isArray(data)) {
        set({ cashDrawers: data.map(r => ({
          id: r.id, name: r.name,
          printerId: r.printer_id, deviceId: r.device_id,
          status: r.status || 'idle',
          currentFloat: Number(r.current_float) || 0,
          openedAt: r.opened_at, openedByStaffId: r.opened_by_staff_id,
        })) });
      }
    } catch (err) {
      console.warn('[loadCashDrawers] failed:', err?.message || err);
    }
  },

  createCashDrawer: async (drawer) => {
    const locId = getActiveLocationSync() || await getLocationId();
    if (!locId) { get().showToast?.('No location selected', 'error'); return null; }
    const row = {
      id: drawer.id || `drw-${Date.now()}`,
      location_id: locId,
      name: drawer.name,
      printer_id: drawer.printerId || null,
      device_id: drawer.deviceId || null,
      status: 'idle',
      current_float: 0,
    };
    // Optimistic local insert
    set(s => ({ cashDrawers: [...(s.cashDrawers||[]), {
      id: row.id, name: row.name, printerId: row.printer_id, deviceId: row.device_id,
      status: 'idle', currentFloat: 0, openedAt: null, openedByStaffId: null,
    }] }));
    if (!isMock && supabase) {
      try {
        const { error } = await supabase.from('cash_drawers').insert(row);
        if (error) throw error;
        get().showToast?.(`Drawer "${row.name}" created`, 'success');
      } catch (err) {
        console.warn('[createCashDrawer] failed:', err?.message || err);
        get().showToast?.(`Save failed: ${err?.message || 'unknown error'}`, 'error');
      }
    }
    return row.id;
  },

  updateCashDrawer: async (id, patch) => {
    // Optimistic local update
    set(s => ({ cashDrawers: (s.cashDrawers||[]).map(d => d.id === id ? { ...d, ...patch } : d) }));
    if (!isMock && supabase) {
      try {
        const row = {};
        if ('name' in patch)          row.name = patch.name;
        if ('printerId' in patch)     row.printer_id = patch.printerId;
        if ('deviceId' in patch)      row.device_id = patch.deviceId;
        if ('status' in patch)        row.status = patch.status;
        if ('currentFloat' in patch)  row.current_float = patch.currentFloat;
        if ('openedAt' in patch)      row.opened_at = patch.openedAt;
        if ('openedByStaffId' in patch) row.opened_by_staff_id = patch.openedByStaffId;
        row.updated_at = new Date().toISOString();
        // v5.5.279: location_id guard on cash drawer updates
        const locId = getActiveLocationSync() || await getLocationId();
        await supabase.from('cash_drawers').update(row).eq('id', id).eq('location_id', locId);
      } catch (err) {
        console.warn('[updateCashDrawer] failed:', err?.message || err);
      }
    }
  },

  deleteCashDrawer: async (id) => {
    set(s => ({ cashDrawers: (s.cashDrawers||[]).filter(d => d.id !== id) }));
    if (!isMock && supabase) {
      try {
        // v5.5.279: location_id guard — never delete across tenants
        const locId = getActiveLocationSync() || await getLocationId();
        await supabase.from('cash_drawers').delete().eq('id', id).eq('location_id', locId);
      } catch (err) {
        console.warn('[deleteCashDrawer] failed:', err?.message || err);
      }
    }
  },

  // Find the drawer assigned to the current POS device. Returns null if none.
  // Used by openCashDrawer and cash-sale auto-fire to route to the right drawer.
  // v4.6.38: match against the physical device id (from rpos-device.id uuid)
  // NOT the profile id. Profiles are shared templates; drawers bind strictly
  // to individual terminals.
  myDrawer: () => {
    const { cashDrawers } = get();
    let deviceId = null;
    try {
      const dev = JSON.parse(localStorage.getItem('rpos-device') || '{}');
      deviceId = dev?.id || null;
    } catch { deviceId = null; }
    if (!deviceId) return null;
    return (cashDrawers || []).find(d => d.deviceId === deviceId) || null;
  },

  // ── Drawer sessions (v4.6.40) ───────────────────────────────────
  // A drawer session is one cash-in → cash-out cycle. Every cash sale
  // or movement while the drawer is open carries this sessions id, so
  // at cash-up we can compute the expected cash exactly = opening_float
  // + cash_sales − drops − expenses + adjustments within this session.
  currentDrawerSession: null,

  loadCurrentDrawerSession: async () => {
    if (isMock || !supabase) return null;
    try {
      const drw = get().myDrawer?.();
      if (!drw) { set({ currentDrawerSession: null }); return null; }
      const { data } = await supabase
        .from('drawer_sessions')
        .select('*')
        .eq('drawer_id', drw.id)
        .in('status', ['open', 'counting'])
        .order('cash_in_at', { ascending: false })
        .limit(1);
      const row = data?.[0] || null;
      set({ currentDrawerSession: row });
      return row;
    } catch (err) {
      console.warn('[loadCurrentDrawerSession] failed:', err?.message || err);
      return null;
    }
  },

  // Open a drawer for trading. Writes drawer_sessions row, updates
  // cash_drawers.status='open'+opening_float, writes float_in movement.
  cashInDrawer: async (drawerId, { openingFloat, denominations = null, notes = '' } = {}) => {
    if (isMock || !supabase) return null;
    try {
      const locId = getActiveLocationSync() || await getLocationId();
      if (!locId) { get().showToast?.('No location', 'error'); return null; }
      const staff = get().staff;
      const shiftId = get().currentShift?.id || null;
      const now = new Date().toISOString();
      const row = {
        id: `ds-${Date.now()}`,
        drawer_id: drawerId,
        shift_id: shiftId,
        location_id: locId,
        cash_in_at: now,
        cash_in_by_staff_id: staff?.id || null,
        opening_float: Number(openingFloat) || 0,
        denominations,
        status: 'open',
        notes: notes || null,
      };
      const { data, error } = await supabase.from('drawer_sessions').insert(row).select().single();
      if (error) {
        // Duplicate — drawer already has an open session
        if (error.code === '23505') {
          get().showToast?.('Drawer already has an open session', 'error');
          await get().loadCurrentDrawerSession?.();
          return null;
        }
        throw error;
      }
      // Flip the drawer to open
      await get().updateCashDrawer?.(drawerId, {
        status: 'open',
        currentFloat: Number(openingFloat) || 0,
        openedAt: now,
        openedByStaffId: staff?.id || null,
      });
      // Float-in movement
      await get().insertCashMovement?.({
        type: 'float_in',
        amount: Number(openingFloat) || 0,
        drawerId,
        shiftId,
        sessionId: data.id,
        reason: 'Opening float',
        staffId: staff?.id || null,
        staffName: staff?.name || 'Unknown',
      });
      set({ currentDrawerSession: data });
      get().showToast?.(`Drawer opened with ${money(Number(openingFloat) || 0)}`, 'success');
      return data;
    } catch (err) {
      console.warn('[cashInDrawer] failed:', err?.message || err);
      get().showToast?.(`Cash in failed: ${err?.message}`, 'error');
      return null;
    }
  },

  // Calculate expected cash for a drawer's current open session.
  // expected = opening_float + sum(cash_sales) − sum(drops) − sum(expenses) + sum(adjustments)
  computeExpectedCash: async (drawerId) => {
    if (isMock || !supabase) return 0;
    try {
      // v5.5.11: look up the OPEN session for THIS specific drawer.
      // The previous version relied on currentDrawerSession (which is the
      // device-bound drawer's session) — when called from the back office
      // where there's no device-bound drawer, that path returned 0 even when
      // the drawer's actual cash_movements summed to £182.85. Resulting
      // discrepancy: Shift card showed £182.85 (read from drawer.currentFloat
      // which is the running total), Cash up modal showed £0 (read from
      // computeExpectedCash → wrong session). Fix: query session by drawer_id
      // directly, same pattern cashOutDrawer already uses.
      const { data: sessions, error: sessErr } = await supabase
        .from('drawer_sessions')
        .select('id, opening_float')
        .eq('drawer_id', drawerId)
        .in('status', ['open', 'counting'])
        .order('cash_in_at', { ascending: false })
        .limit(1);
      if (sessErr) {
        console.warn('[computeExpectedCash] drawer_sessions read failed:', sessErr.message);
        return 0;
      }
      const sess = sessions?.[0];
      if (!sess) {
        console.warn('[computeExpectedCash] no open session for drawer', drawerId, '— returning 0');
        return 0;
      }
      const { data: movements, error: movErr } = await supabase
        .from('cash_movements')
        .select('type, amount')
        .eq('session_id', sess.id);
      if (movErr) {
        console.warn('[computeExpectedCash] cash_movements read failed:', movErr.message);
        return Number(sess.opening_float) || 0;
      }
      const SIGN = { float_in: +1, cash_sale: +1, adjustment: +1, downlift_from_safe: +1, cash_drop: -1, drop: -1, expense: -1, uplift_to_safe: -1, drawer_open: 0 };
      // Note: opening_float is already accounted for in cash_movements as a
      // float_in row at session start, so we don't double-count it.
      const net = (movements || []).reduce((s, m) => s + (SIGN[m.type] || 0) * (Number(m.amount) || 0), 0);
      return net;
    } catch (err) {
      console.warn('[computeExpectedCash] failed:', err?.message || err);
      return 0;
    }
  },

  // Cash out a drawer. Closes the session, logs variance, flips drawer to idle,
  // and if all drawers are now idle, auto-closes the shift.
  cashOutDrawer: async (drawerId, { declaredCash, denominations = null, notes = '' } = {}) => {
    if (isMock || !supabase) return null;
    try {
      // Find the open session for this drawer (don't trust currentDrawerSession — might be another device's drawer)
      const { data: sessions } = await supabase
        .from('drawer_sessions')
        .select('*')
        .eq('drawer_id', drawerId)
        .in('status', ['open', 'counting'])
        .order('cash_in_at', { ascending: false })
        .limit(1);
      const sess = sessions?.[0];
      if (!sess) {
        get().showToast?.('No open session for this drawer', 'error');
        return null;
      }
      // Compute expected directly from cash_movements for THIS session (reliable)
      const { data: movs } = await supabase
        .from('cash_movements')
        .select('type, amount')
        .eq('session_id', sess.id);
      const SIGN = { float_in: +1, cash_sale: +1, adjustment: +1, downlift_from_safe: +1, cash_drop: -1, drop: -1, expense: -1, uplift_to_safe: -1, drawer_open: 0 };
      const expected = (movs || []).reduce((s, m) => s + (SIGN[m.type] || 0) * (Number(m.amount) || 0), 0);
      const declared = Number(declaredCash) || 0;
      const variance = declared - expected;
      const now = new Date().toISOString();
      const staff = get().staff;

      // 1. Update the session row to closed
      // v5.5.279: location_id guard via drawer_id's parent location
      const drawerLocId = getActiveLocationSync() || await getLocationId();
      const { error: updErr } = await supabase
        .from('drawer_sessions')
        .update({
          cash_out_at: now,
          cash_out_by_staff_id: staff?.id || null,
          declared_cash: declared,
          expected_cash: expected,
          variance,
          denominations,
          status: 'closed',
          notes: [sess.notes, notes].filter(Boolean).join(' · ') || null,
        })
        .eq('id', sess.id)
        .eq('location_id', drawerLocId);
      if (updErr) throw updErr;

      // 2. Log variance as an adjustment movement (always — even £0.00 for audit)
      if (Math.abs(variance) >= 0.01) {
        await get().insertCashMovement?.({
          type: 'adjustment',
          amount: Math.abs(variance),
          drawerId,
          sessionId: sess.id,
          reason: variance > 0 ? 'Cash-up variance (drawer over)' : 'Cash-up variance (drawer short)',
          note: `Declared ${money(declared)} vs expected ${money(expected)}`,
          staffId: staff?.id || null,
          staffName: staff?.name || 'Unknown',
        });
      }

      // 3. Flip drawer to idle, zero float
      await get().updateCashDrawer?.(drawerId, {
        status: 'idle',
        currentFloat: 0,
        openedAt: null,
        openedByStaffId: null,
      });
      set({ currentDrawerSession: null });

      get().showToast?.(
        Math.abs(variance) < 0.01 ? 'Drawer closed — balanced' : `Drawer closed — variance ${money(Math.abs(variance))} ${variance > 0 ? 'over' : 'short'}`,
        Math.abs(variance) < 0.01 ? 'success' : 'warning',
      );

      // v4.6.49: removed auto-finalise. Shift stays open after all drawers
      // cash up. Manager must manually run Close day from Back Office, which
      // aggregates totals across the full location. Just refresh drawer state.
      await get().loadCashDrawers?.();

      return { expected, declared, variance };
    } catch (err) {
      console.warn('[cashOutDrawer] failed:', err?.message || err);
      get().showToast?.(`Cash out failed: ${err?.message}`, 'error');
      return null;
    }
  },

  // Returns true when the POS should block itself because the assigned drawer
  // needs cashing in. Only POSes with a drawer assigned ever see this block.
  needsCashIn: () => {
    const drw = get().myDrawer?.();
    if (!drw) return false;
    return drw.status === 'idle' || !drw.status;
  },

  // ── Shifts (v4.6.37) ────────────────────────────────────────────
  // The shift is the reporting window: opened by a manager (or auto
  // on first boot of the business day), closed when all drawers are
  // cashed up. Every closed_check and cash_movement written while a
  // shift is open stamps its shift_id. At most one shift is open per
  // location (DB-enforced with a partial unique index).
  currentShift: null,
  shiftHistory: [],

  loadCurrentShift: async () => {
    if (isMock || !supabase) return null;
    try {
      const locId = getActiveLocationSync() || await getLocationId();
      if (!locId) return null;
      const { data } = await supabase
        .from('shifts')
        .select('*')
        .eq('location_id', locId)
        .eq('status', 'open')
        .order('opened_at', { ascending: false })
        .limit(1);
      const row = data?.[0] || null;
      if (row) {
        set({ currentShift: {
          id: row.id, locationId: row.location_id,
          openedAt: row.opened_at, openedByStaffId: row.opened_by_staff_id,
          closedAt: row.closed_at, closedByStaffId: row.closed_by_staff_id,
          status: row.status, notes: row.notes, zReport: row.z_report,
        } });
      } else {
        set({ currentShift: null });
      }
      return row;
    } catch (err) {
      console.warn('[loadCurrentShift] failed:', err?.message || err);
      return null;
    }
  },

  loadShiftHistory: async (limit = 30) => {
    if (isMock || !supabase) return;
    try {
      const locId = getActiveLocationSync() || await getLocationId();
      if (!locId) return;
      const { data } = await supabase
        .from('shifts')
        .select('*')
        .eq('location_id', locId)
        .order('opened_at', { ascending: false })
        .limit(limit);
      if (Array.isArray(data)) set({ shiftHistory: data });
    } catch (err) {
      console.warn('[loadShiftHistory] failed:', err?.message || err);
    }
  },

  openShift: async (staffId = null) => {
    // If one is already open, just return it (idempotent).
    if (get().currentShift?.status === 'open') return get().currentShift;
    if (isMock || !supabase) return null;
    try {
      const locId = getActiveLocationSync() || await getLocationId();
      if (!locId) return null;
      const row = {
        id: `shift-${Date.now()}`,
        location_id: locId,
        opened_at: new Date().toISOString(),
        opened_by_staff_id: staffId || get().staff?.id || null,
        status: 'open',
      };
      const { data, error } = await supabase.from('shifts').insert(row).select().single();
      if (error) {
        // Unique constraint means another device beat us — reload and use theirs
        if (error.code === '23505') {
          await get().loadCurrentShift?.();
          return get().currentShift;
        }
        throw error;
      }
      set({ currentShift: {
        id: data.id, locationId: data.location_id,
        openedAt: data.opened_at, openedByStaffId: data.opened_by_staff_id,
        status: 'open',
      } });
      get().showToast?.(`Shift opened`, 'success');
      return get().currentShift;
    } catch (err) {
      console.warn('[openShift] failed:', err?.message || err);
      return null;
    }
  },

  // v4.6.43: Location-wide Z-read. Writes the aggregated report to the shifts
  // row and closes the shift. Enforces Manager/Admin role at the call site —
  // the EOD page checks staff.role before calling this, and closeShift also
  // enforces the check below as a second guard.
  finaliseShift: async ({ zReport, notes = '' } = {}) => {
    const current = get().currentShift;
    if (!current || current.status !== 'open') {
      get().showToast?.('No open shift to finalise', 'error');
      return null;
    }
    // Defence in depth: block if any drawer is still non-idle
    const stillOpen = (get().cashDrawers || []).find(d => d.status && d.status !== 'idle');
    if (stillOpen) {
      get().showToast?.(`Can't finalise — ${stillOpen.name} is still ${stillOpen.status}`, 'error');
      return null;
    }
    // Role check — Manager/Admin only
    const { staff } = get();
    const isAdmin = staff?.role === 'Manager' || staff?.role === 'Admin';
    const hasEOD  = Array.isArray(staff?.permissions) && staff.permissions.includes('eod');
    // Back office is already auth-gated via Supabase Auth, so if staff is empty
    // that means this was called from the back office (where the page itself
    // is behind Supabase Auth). Allow that.
    const fromBackOffice = !staff?.id;
    if (!isAdmin && !hasEOD && !fromBackOffice) {
      get().showToast?.('Manager/Admin required to close a shift', 'error');
      return null;
    }
    // closeShift persists z_report on the shifts row
    return await get().closeShift?.({ auto: false, notes, zReport });
  },

  closeShift: async ({ auto = false, notes = '', zReport = null } = {}) => {
    const current = get().currentShift;
    if (!current || current.status !== 'open') {
      get().showToast?.('No open shift to close', 'error');
      return null;
    }
    // Permission gate — manual close requires admin/manager role, cashup/eod
    // perm, OR back-office auth (empty staff = user signed in via Supabase
    // Auth as the business owner, not a POS PIN login).
    if (!auto) {
      const { staff } = get();
      const role = staff?.role;
      const hasPerm = Array.isArray(staff?.permissions) && (staff.permissions.includes('cashup') || staff.permissions.includes('eod'));
      const fromBackOffice = !staff?.id; // v4.6.46: allow when called from BO
      if (role !== 'Manager' && role !== 'Admin' && !hasPerm && !fromBackOffice) {
        get().showToast?.('Only manager/admin can close a shift', 'error');
        return null;
      }
      // Block close if any drawer is still in open/counting state
      const openDrawer = (get().cashDrawers || []).find(d => d.status && d.status !== 'idle');
      if (openDrawer) {
        get().showToast?.(`Cannot close shift — ${openDrawer.name} is still ${openDrawer.status}`, 'error');
        return null;
      }
    }
    if (isMock || !supabase) return null;
    try {
      const patch = {
        status: auto ? 'auto_closed' : 'closed',
        closed_at: new Date().toISOString(),
        closed_by_staff_id: get().staff?.id || null,
        notes: notes || null,
        z_report: zReport || null,
      };
      // v5.5.279: location_id guard on shift close
      const shiftLocId = getActiveLocationSync() || await getLocationId();
      const { error } = await supabase.from('shifts').update(patch).eq('id', current.id).eq('location_id', shiftLocId);
      if (error) throw error;
      set({ currentShift: null });
      await get().loadShiftHistory?.();
      get().showToast?.(auto ? 'Shift auto-closed at business day start' : 'Shift closed', 'success');
      return true;
    } catch (err) {
      console.warn('[closeShift] failed:', err?.message || err);
      get().showToast?.(`Shift close failed: ${err?.message}`, 'error');
      return null;
    }
  },

  // Auto-open/close logic — run on app mount from useSupabaseInit.
  // If no shift is open: open one with opened_at = max(now, businessDayStart).
  // If the current shift's opened_at is older than today's businessDayStart,
  // auto-close the old one and open a fresh one.
  reconcileShiftOnMount: async () => {
    if (isMock) return;
    try {
      await get().loadCurrentShift?.();
      const current = get().currentShift;
      // v5.5.11: use the timezone-aware getBusinessDayStart() helper instead of
      // device-local setHours(). The previous version computed "today's 6am" in
      // the device's local timezone — wrong if the device is in a different
      // timezone than the location. Combined with v5.5.11's fix to
      // getLocationConfig (which previously pulled the wrong location's config
      // in multi-location setups), shift boundaries are now consistently the
      // location's configured business_day_start in the location's timezone.
      const { getLocationConfig: getCfg, getBusinessDayStart } = await import('../lib/locationTime');
      const cfg = await getCfg(); // resolves current location internally
      const businessDayStartMs = getBusinessDayStart(cfg).getTime();

      if (current) {
        const openedMs = new Date(current.openedAt).getTime();
        if (openedMs < businessDayStartMs) {
          // v4.6.45: shift has crossed the business-day boundary. We close the
          // shift itself (so reports roll over) but LEAVE drawers in whatever
          // state they were in — no fabricated close events, no null-variance
          // rows. A POS with a still-open drawer will refuse to start new cash
          // trading until a manager cashes it up from the back office. Open
          // orders carry over untouched.
          await get().loadCashDrawers?.();
          const stillOpen = (get().cashDrawers || []).filter(d => d.status && d.status !== 'idle');
          if (stillOpen.length > 0) {
            console.warn(`[reconcileShiftOnMount] shift auto-closed with ${stillOpen.length} drawer(s) still open — they need manual cash-up before new trading`);
          }
          await get().closeShift?.({ auto: true, notes: stillOpen.length > 0 ? `Auto-closed at business day boundary — ${stillOpen.length} drawer(s) still open, need manual cash-up` : 'Auto-closed at business day boundary' });
          await get().openShift?.();
        }
      } else {
        // No open shift — open one automatically so cash sales can happen
        await get().openShift?.();
      }
    } catch (err) {
      console.warn('[reconcileShiftOnMount] failed:', err?.message || err);
    }
  },

  // ── Petty cash + cash drawer (v4.6.30) ────────
  pettyCashEntries: [],

  // Append a petty cash log entry. Shape:
  //   { id, timestamp, type, amount, reason?, note?, staff?, ref? }
  // type is one of:
  //   'cash_sale'       — auto-logged by recordClosedCheck etc when method==='cash'
  //   'drawer_open'     — manual drawer pulse from POS (no money change)
  //   'float'           — cash float added at start of shift
  //   'drop'            — cash removed to safe / deposit
  //   'expense'         — cash paid out for supplies etc
  //   'adjustment'      — manual reconciliation tweak
  addPettyCashEntry: (entry) => {
    const full = {
      id: `pc-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      timestamp: Date.now(),
      type: 'drawer_open',
      amount: 0,
      ...entry,
    };
    set(s => ({ pettyCashEntries: [full, ...(s.pettyCashEntries || [])] }));
    return full;
  },

  // Running balance = sum of signed amounts. Positive for sales/floats,
  // negative for drops/expenses.
  getPettyCashBalance: () => {
    const SIGN = { cash_sale: +1, float: +1, adjustment: +1, drop: -1, expense: -1, drawer_open: 0 };
    return (get().pettyCashEntries || []).reduce((s, e) => s + (SIGN[e.type] ?? 0) * (Number(e.amount) || 0), 0);
  },

  // Pulse the cash drawer via the printer (if a cash-drawer-attached printer
  // is configured) AND log to the petty cash ledger. Swallow print failures —
  // the drawer pulse is best-effort and should never block a payment flow.
  openCashDrawer: ({ reason = 'Manual open', amount = 0, type = 'drawer_open', ref = null, note = '', force = false, drawerId = null } = {}) => {
    // v4.6.32: permission gate. 'force' is passed by the automatic cash-sale
    // firing path — no permission check needed there (the sale itself was
    // already authorised). Manual opens from the POS or the petty cash page
    // must have the 'openDrawer' staff permission.
    // v4.6.36: drawer-aware routing. If drawerId is provided (or myDrawer()
    // resolves one) the pulse fires at that drawer's printer, and the
    // movement row carries drawer_id + shift_id.
    const { staff } = get();
    if (!force) {
      const allowed = Array.isArray(staff?.permissions) && staff.permissions.includes('openDrawer');
      if (!allowed) {
        get().showToast?.('No permission — drawer open requires manager override', 'error');
        return null;
      }
    }
    // Resolve the drawer: explicit drawerId > myDrawer() > null
    const resolvedDrawer = drawerId
      ? (get().cashDrawers || []).find(d => d.id === drawerId)
      : get().myDrawer?.() || null;
    const resolvedDrawerId = resolvedDrawer?.id || null;
    const resolvedPrinterId = resolvedDrawer?.printerId || null;
    try {
      // printService.openCashDrawer accepts printerId as its first arg.
      // If we have the drawer's printer, use it; else fall back to legacy
      // behaviour (search for cashDrawerAttached flag).
      const pulsePromise = printService?.openCashDrawer?.(resolvedPrinterId);
      pulsePromise?.catch?.(err => {
        console.warn('[openCashDrawer] pulse failed:', err?.message || err);
        get().showToast?.(`Drawer pulse failed: ${err?.message || 'no printer'}`, 'error');
      });
    } catch (err) { console.warn('[openCashDrawer] pulse threw:', err); }
    // v4.6.39: visible feedback for manual opens. Auto-fire on cash sale
    // skips the toast (the sale already renders a 'paid' toast).
    if (type === 'drawer_open' && !force) {
      const _drawerName = resolvedDrawer?.name;
      get().showToast?.(_drawerName ? `${_drawerName} opened` : 'Drawer opened', 'success');
    }
    // Legacy pettyCashEntries for backwards-compat UI; also mirror to
    // cash_movements (Supabase-backed, per-drawer, per-shift).
    const entry = get().addPettyCashEntry({
      type, amount, reason, ref, note,
      staff: staff?.name || 'Unknown',
      staffId: staff?.id || null,
      drawerId: resolvedDrawerId,
    });
    // Mirror to cash_movements (async, fire-and-forget)
    get().insertCashMovement?.({
      type, amount,
      drawerId: resolvedDrawerId,
      reason, note, ref,
      staffId: staff?.id || null,
      staffName: staff?.name || 'Unknown',
    });
    // Update drawer's current_float locally + in DB
    if (resolvedDrawerId && type !== 'drawer_open') {
      const SIGN = { cash_sale: +1, float_in: +1, adjustment: +1, drop: -1, cash_drop: -1, expense: -1, uplift_to_safe: -1, downlift_from_safe: +1 };
      const delta = (SIGN[type] || 0) * (Number(amount) || 0);
      if (delta !== 0) {
        const current = resolvedDrawer.currentFloat || 0;
        get().updateCashDrawer?.(resolvedDrawerId, { currentFloat: current + delta });
      }
    }
    return entry;
  },

  // v4.6.36: persist a movement row to Supabase cash_movements. Fire-and-forget;
  // failure is logged not fatal. Dual-writes here: Zustand (via addPettyCashEntry
  // above which still populates pettyCashEntries) and Supabase (this function).
  insertCashMovement: async ({ type, amount, drawerId = null, shiftId = null, sessionId = null, fromDrawerId = null, toDrawerId = null, reason = '', note = '', ref = null, staffId = null, staffName = '' }) => {
    if (isMock || !supabase) return null;
    // v4.6.39: if no shiftId was passed, default to the currently open shift.
    // v4.6.40: also default session_id to the currentDrawerSession when the caller
    // didn't specify. This is what links every cash-sale to the session it occurred in.
    const resolvedShiftId = shiftId || get().currentShift?.id || null;
    const resolvedSessionId = sessionId || get().currentDrawerSession?.id || null;
    try {
      const locId = getActiveLocationSync() || await getLocationId();
      if (!locId) return null;
      const row = {
        id: `mov-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        location_id: locId,
        timestamp: new Date().toISOString(),
        type, amount: Number(amount) || 0,
        drawer_id: drawerId,
        shift_id: resolvedShiftId,
        from_drawer_id: fromDrawerId,
        to_drawer_id: toDrawerId,
        reason, note, ref,
        staff_id: staffId,
        staff_name: staffName,
        session_id: resolvedSessionId,
      };
      const { error } = await supabase.from('cash_movements').insert(row);
      if (error) console.warn('[insertCashMovement] DB error:', error.message);
      return row.id;
    } catch (err) {
      console.warn('[insertCashMovement] failed:', err?.message || err);
      return null;
    }
  },

  // ── Closed check history ──────────────────
  closedChecks: isMock ? [
    { id:'cc1', ref:'#1042', tableId:'t1', tableLabel:'T1', server:'Sarah', covers:2, orderType:'dine-in', customer:null,
      items:[{uid:'cc1i1',name:'Carbonara pasta',price:14.5,qty:2,mods:[],notes:'',allergens:[]},{uid:'cc1i2',name:'House red wine — 250ml',price:10.5,qty:2,mods:[],notes:'',allergens:[]}],
      discounts:[], subtotal:50, service:6.25, tip:7.50, total:63.75, method:'card',
      closedAt:Date.now()-25*60000, status:'paid', refunds:[] },
    { id:'cc2', ref:'#1041', tableId:'t3', tableLabel:'T3', server:'Tom', covers:4, orderType:'dine-in', customer:null,
      items:[{uid:'cc2i1',name:'Ribeye steak 8oz',price:32,qty:2,mods:[{label:'Cooking: Medium rare',price:0}],notes:'',allergens:[]},{uid:'cc2i2',name:'Chicken supreme',price:22,qty:1,mods:[],notes:'',allergens:[]},{uid:'cc2i3',name:'Tiramisu',price:8.5,qty:2,mods:[],notes:'',allergens:[]}],
      discounts:[], subtotal:103, service:12.88, tip:15, total:130.88, method:'card',
      closedAt:Date.now()-62*60000, status:'partial_refund',
      refunds:[{id:'r1',timestamp:Date.now()-30*60000,manager:'Alex',managerId:'s1',reason:'Quality issue',isFullRefund:false,items:[{uid:'cc2i3',name:'Tiramisu',price:8.5,qty:2,refundQty:1}],amount:8.5}] },
    { id:'cc3', ref:'#1040', tableId:null, tableLabel:null, server:'Alex', covers:1, orderType:'collection',
      customer:{name:'James Wilson',phone:'07700 900123',collectionTime:'6:30 PM'},
      items:[{uid:'cc3i1',name:'Pepperoni pizza',price:14,qty:1,mods:[],notes:'Extra cheese',allergens:[]},{uid:'cc3i2',name:'Garlic bread',price:4.5,qty:1,mods:[],notes:'',allergens:[]}],
      discounts:[], subtotal:18.5, service:0, tip:0, total:18.5, method:'card',
      closedAt:Date.now()-90*60000, status:'paid', refunds:[] },
  ] : [],

  // v5.5.163 — Challenge 21 (UK alcohol ID-check) state + actions
  //   `challenge21Config` is a snapshot of the platform.locations columns,
  //   refreshed on demand from loadChallenge21Config().
  //   `challenge21Prompt` is the trigger state — when .open=true the POS
  //   surface renders Challenge21Modal.
  challenge21Config: null,
  challenge21Prompt: { open: false, triggerCount: 0 },

  loadChallenge21Config: async () => {
    if (isMock || !platformSupabase) return;
    try {
      const opsId = getActiveLocationSync() || await getLocationId();
      if (!opsId || opsId === 'loc-demo') return;
      const { data, error } = await platformSupabase.from('locations')
        .select('id, ops_location_id, challenge_21_enabled, challenge_21_alcohol_category_ids, challenge_21_trigger_every, challenge_21_counter')
        .eq('ops_location_id', opsId).maybeSingle();
      if (error) {
        if (!/column .* does not exist/i.test(error.message)) console.warn('[challenge21] config load:', error.message);
        return;
      }
      if (!data) return;
      set({
        challenge21Config: {
          locationId:        data.id,
          opsLocationId:     data.ops_location_id || opsId,
          enabled:           !!data.challenge_21_enabled,
          alcoholCategoryIds: Array.isArray(data.challenge_21_alcohol_category_ids) ? data.challenge_21_alcohol_category_ids : [],
          triggerEvery:      Number(data.challenge_21_trigger_every) || 10,
          counter:           Number(data.challenge_21_counter) || 0,
        },
      });
    } catch (e) { console.warn('[challenge21] config load failed:', e?.message); }
  },

  // Called from every recordClosedCheck path. Checks for alcohol-flagged
  // items in the closed record, increments the counter on platform.locations
  // if found, and opens the prompt when the counter hits triggerEvery.
  // Best-effort — wrapped in try/catch so any failure here never blocks
  // the close flow.
  triggerChallenge21Check: async (record) => {
    try {
      if (isMock || !platformSupabase) return;
      let cfg = get().challenge21Config;
      if (!cfg) { await get().loadChallenge21Config(); cfg = get().challenge21Config; }
      if (!cfg?.enabled) return;
      if (!cfg.alcoholCategoryIds?.length) return;
      const items = record?.items || [];
      if (!items.length) return;

      const flagged = new Set(cfg.alcoholCategoryIds);
      const hasAlcohol = items.some(i => {
        if (!i || i.voided) return false;
        if (i.cat && flagged.has(i.cat)) return true;
        if (Array.isArray(i.cats) && i.cats.some(c => flagged.has(c))) return true;
        if (i.parentCat && flagged.has(i.parentCat)) return true;
        return false;
      });
      if (!hasAlcohol) return;

      const next = (cfg.counter || 0) + 1;
      try {
        await platformSupabase.from('locations')
          .update({ challenge_21_counter: next })
          .eq('id', cfg.locationId);
      } catch (e) { console.warn('[challenge21] counter update failed:', e?.message); }

      set({ challenge21Config: { ...cfg, counter: next } });

      if (next >= cfg.triggerEvery) {
        set({
          challenge21Prompt: {
            open: true,
            triggerCount: next,
            locationId: cfg.locationId,
            opsLocationId: cfg.opsLocationId,
          },
        });
      }
    } catch (e) { console.warn('[challenge21] trigger failed:', e?.message); }
  },

  dismissChallenge21Prompt: (resetCounter = true) => {
    const cfg = get().challenge21Config;
    set({ challenge21Prompt: { open: false, triggerCount: 0 } });
    if (resetCounter && cfg) set({ challenge21Config: { ...cfg, counter: 0 } });
  },

  recordClosedCheck: (tableId, paymentInfo = {}) => {
    const { tables, staff, taxRates } = get();
    const table = tables.find(t => t.id === tableId);
    const session = table?.session;
    if (!session) return;

    // Calculate tax breakdown at point of close
    let taxBreakdown = null;
    if (taxRates?.length) {
      try { taxBreakdown = calculateOrderTax(session.items.filter(i=>!i.voided), taxRates, 'dine-in'); } catch {}
    }

    const ref = getNextOrderRefLocal();
    // v5.5.279: stamp locationId on in-memory record so the cross-location
    // merge filter in BOReports can exclude checks from other locations.
    // v5.5.311: fall back to the durable rpos-active-location tag if the sync
    // resolver returns null — a null locationId on the cached check passes the
    // "exclude other locations" filter for EVERY location → report bleed.
    let recLocId = getActiveLocationSync();
    if (!recLocId) { try { recLocId = localStorage.getItem('rpos-active-location') || null; } catch {} }
    const record = {
      id: `chk-${Date.now()}`,
      ref,
      tableId,
      tableLabel: table.label,
      locationId: recLocId,
      server:     session.server || staff?.name || 'Staff',
      staffId:    staff?.id || null,                          // v4.6.19
      covers:     session.covers || 1,
      orderType:  'dine-in',
      items:      session.items.filter(i => !i.voided).map(i => ({ ...i })),
      discounts:  [...(session.discounts || []), ...promoDiscountEntry(paymentInfo.promoRedemption)],
      subtotal:   session.subtotal || 0,
      service:    (session.subtotal || 0) * 0.125,
      tip:        paymentInfo.tip || 0,
      total:      paymentInfo.grand || session.total || 0,
      taxAmount:  taxBreakdown?.totalTax != null ? taxBreakdown.totalTax : null,  // v4.6.19
      method:     paymentInfo.method || 'card',
      giftCard:   paymentInfo.giftCard || null,                  // v5.5.217: gift card reversal on refund
      stripePaymentIntentId: paymentInfo.stripePaymentIntentId || paymentInfo.paymentIntentId || null,  // v5.5.301: for card refunds
      processor:  paymentInfo.processor || 'stripe',             // which processor took the payment (refund routes by this)
      paymentIntents: derivePaymentIntents(paymentInfo),  // v5.5.323: all card legs (split portions) for multi-card refund
      loyaltyRedemption: paymentInfo.loyaltyRedemption || null,  // v5.5.315: link redeem→check for refund restore
      closedAt:   Date.now(),
      status:     'paid',
      refunds:    [],
      taxBreakdown,
    };
    set(s => ({ closedChecks: [record, ...s.closedChecks] }));
    insertClosedCheck(record);
    if (paymentInfo.promoRedemption) get().redeemPromoCode?.(paymentInfo.promoRedemption, record, session.customer);
    // v5.5.163: Challenge 21 — increment alcohol counter; fire prompt at threshold.
    get().triggerChallenge21Check?.(record);
    // v4.6.65: dine-in customer attribution. Reads session.customer (attached
    // manually via the Add customer button on the order panel — no order-type
    // switch required).
    if (session.customer?.phone) {
      get().attributeOrderToCustomer({
        customer: session.customer, orderRecord: record,
      }).catch(err => console.warn('[recordClosedCheck customer]', err?.message || err));
    }
    // v4.6.30: fire cash drawer + log petty cash entry for cash sales.
    if (record.method === 'cash') {
      // v4.6.32: force=true — cash sale itself is the authorisation.
      get().openCashDrawer({
        type: 'cash_sale',
        amount: Number(record.total) || 0,
        reason: `Cash sale · ${record.tableLabel || record.ref || ''}`.trim(),
        ref: record.ref,
        force: true,
      });
    }
    return record;
  },

  // Redeem a held promo code against a recorded check — atomic + race-safe server-side, bound to the
  // order id. Fire-and-forget: validate already confirmed eligibility at apply time; never blocks a sale.
  redeemPromoCode: (promo, record, customer) => {
    if (!promo?.code || !supabase || !record?.id) return;
    const { staff } = get();
    let locId = getActiveLocationSync(); if (!locId) { try { locId = localStorage.getItem('rpos-active-location') || null; } catch {} }
    supabase.functions.invoke('promo-redeem', { body: {
      action: 'redeem', code: promo.code, order_id: record.id, location_id: locId,
      customer_id: customer?.customerId || customer?.id || null, staff_id: staff?.id || null,
      basket_value: record.subtotal || 0, idempotency_key: `${record.id}:${promo.code}`,
    } }).then(({ data }) => { if (data && !data.ok && !data.redeemed) console.warn('[promo redeem]', data.reason); })
      .catch(err => console.warn('[promo redeem]', err?.message || err));
  },

  // Direct record insertion — used by bar tabs and other ad-hoc payment flows
  recordWalkInClosedCheck: (record) => {
    const { staff } = get();
    const fullRecord = {
      id: `chk-${Date.now()}`,
      closedAt: Date.now(),
      status: 'paid',
      refunds: [],
      locationId: getActiveLocationSync() || (() => { try { return localStorage.getItem('rpos-active-location') || null; } catch { return null; } })(),  // v5.5.279/311: stamp locationId (durable-tag fallback) for cross-location filter
      staffId: record.staffId || staff?.id || null,   // v4.6.19
      ...record,
    };
    set(s => ({ closedChecks: [fullRecord, ...s.closedChecks] }));
    insertClosedCheck(fullRecord).catch(()=>{});
    // v5.5.163: Challenge 21 — alcohol counter + prompt
    get().triggerChallenge21Check?.(fullRecord);
    // v4.6.30: cash drawer auto-fire on cash payment
    // v4.6.62: attribute bar-tab orders to customer DB if customer was set on tab
    if (fullRecord.customer?.phone) {
      get().attributeOrderToCustomer({
        customer: fullRecord.customer, orderRecord: fullRecord,
      }).catch(err => console.warn('[recordWalkInClosedCheck customer]', err?.message || err));
    }
    if (fullRecord.method === 'cash') {
      // v4.6.32: force=true — cash sale itself is the authorisation.
      get().openCashDrawer({
        type: 'cash_sale',
        amount: Number(fullRecord.total) || 0,
        reason: `Cash sale · ${fullRecord.tableLabel || fullRecord.ref || 'Bar tab'}`.trim(),
        ref: fullRecord.ref,
        force: true,
      });
    }
    return fullRecord;
  },

  recordWalkInClosed: (walkInOrder, orderType, customer, paymentInfo = {}) => {
    if (!walkInOrder?.items?.length) return;
    const { staff, taxRates } = get();
    const subtotal = walkInOrder.items.reduce((s, i) => s + i.price * i.qty, 0);
    // v4.6.19 — compute tax at close so tax_amount can be stored with the row
    let taxBreakdown = null;
    if (taxRates?.length) {
      try { taxBreakdown = calculateOrderTax(walkInOrder.items.filter(i=>!i.voided), taxRates, orderType); } catch {}
    }
    // If the walk-in was reopened from orderQueue (OrdersHub openOrder) it already
    // has a ref (e.g. '#6720'). Reuse it so the closed check matches what the user
    // sees and so we can remove the stale queue entry below. Only generate a new
    // random ref for genuinely-new walk-ins.
    const existingRef = walkInOrder.ref || null;
    const record = {
      id: `chk-${Date.now()}`,
      ref: existingRef || getNextOrderRefLocal(),
      tableId: null,
      tableLabel: null,
      locationId: getActiveLocationSync() || (() => { try { return localStorage.getItem('rpos-active-location') || null; } catch { return null; } })(),  // v5.5.279/311: stamp locationId (durable-tag fallback) for cross-location filter
      server: staff?.name || 'Staff',
      staffId: staff?.id || null,                                              // v4.6.19
      covers: 1,
      orderType,
      customer,
      items: walkInOrder.items.filter(i => !i.voided).map(i => ({ ...i })),
      discounts: [...(walkInOrder.discounts || []), ...promoDiscountEntry(paymentInfo.promoRedemption)],
      subtotal,
      service: 0,
      tip: paymentInfo.tip || 0,
      total: paymentInfo.grand || subtotal,
      taxAmount: taxBreakdown?.totalTax != null ? taxBreakdown.totalTax : null, // v4.6.19
      taxBreakdown,                                                                  // v5.5.341: store full breakdown so receipts/reports show VAT lines (walk-in/MPOS)
      method: paymentInfo.method || 'card',
      giftCard: paymentInfo.giftCard || null,                                        // v5.5.217
      stripePaymentIntentId: paymentInfo.stripePaymentIntentId || paymentInfo.paymentIntentId || null,              // v5.5.301
      processor: paymentInfo.processor || 'stripe',                                  // refund routes by this
      paymentIntents: derivePaymentIntents(paymentInfo),                             // v5.5.323: multi-card refund
      loyaltyRedemption: paymentInfo.loyaltyRedemption || null,                      // v5.5.315
      drawerId: get().myDrawer?.()?.id || null,                                   // v4.6.37
      shiftId:  get().currentShift?.id || null,                                   // v4.6.37
      closedAt: Date.now(),
      status: 'paid',
      refunds: [],
    };
    // Single set: append to closedChecks AND, if this came from the queue, drop
    // the stale entry so the order stops showing as open. Previously only the
    // closedCheck was written — queue entry persisted, so 'cash off' left the
    // order visible in Orders and re-cashing produced duplicate closed checks.
    set(s => ({
      closedChecks: [record, ...s.closedChecks],
      orderQueue: existingRef ? s.orderQueue.filter(o => o.ref !== existingRef) : s.orderQueue,
    }));
    // v4.6.30: cash drawer auto-fire on cash payment
    // v4.6.62: attribute to customer DB (fire-and-forget)
    if (customer?.phone) {
      get().attributeOrderToCustomer({
        customer, orderRecord: record,
      }).catch(err => console.warn('[recordWalkInClosed customer]', err?.message || err));
    }
    if (record.method === 'cash') {
      // v4.6.32: force=true — cash sale itself is the authorisation.
      get().openCashDrawer({
        type: 'cash_sale',
        amount: Number(record.total) || 0,
        reason: `Cash sale · ${customer?.name || record.ref || orderType}`.trim(),
        ref: record.ref,
        force: true,
      });
    }
    insertClosedCheck(record);
    if (paymentInfo.promoRedemption) get().redeemPromoCode?.(paymentInfo.promoRedemption, record, customer);
    // v5.5.163: Challenge 21 — alcohol counter + prompt
    get().triggerChallenge21Check?.(record);
    return record;
  },

  refundCheck: (checkId, { items: refundItems, isFullRefund, manager, reason, tenderMethod, amount }) => {
    let nextRefunds = null;
    let nextStatus = null;
    set(s => ({
      closedChecks: s.closedChecks.map(chk => {
        if (chk.id !== checkId) return chk;
        const refund = {
          id: `ref-${Date.now()}`,
          timestamp: Date.now(),
          manager: manager.name,
          managerId: manager.id,
          reason,
          isFullRefund,
          tenderMethod: tenderMethod || 'card',
          items: refundItems,
          amount: amount || refundItems.reduce((s, ri) => s + ri.price * ri.refundQty, 0),
        };
        const allRefunds = [...chk.refunds, refund];
        const totalRefunded = allRefunds.reduce((s, r) => s + r.amount, 0);
        const status = totalRefunded >= chk.subtotal ? 'refunded' : 'partial_refund';
        nextRefunds = allRefunds;
        nextStatus = status;
        return { ...chk, refunds: allRefunds, status };
      }),
    }));
    // Persist to Supabase so other POS devices at the location see this refund
    // via the realtime UPDATE listener (lib/realtime.js). Fire-and-forget — the
    // local mutation already happened so UX stays snappy; if the network call
    // fails it logs a warning and the next refund / boot reconciles.
    if (nextRefunds && nextStatus) {
      updateClosedCheckRefunds(checkId, nextRefunds, nextStatus)
        .catch(err => console.warn('[refundCheck] persist failed', err?.message || err));
    }
    // v5.5.217: Gift card balance reversal — restore the debited amount back
    // to the card. Fire-and-forget (same pattern as updateClosedCheckRefunds):
    // the local refund mutation already happened so UX stays responsive.
    // The edge function is idempotent (refund:{original_key}) — safe to retry.
    const check = get().closedChecks.find(c => c.id === checkId);
    // v5.5.311: gift-reverse-redeem restores the FULL original gift redemption.
    // Only run it on a FULL refund — on a partial refund it would credit the
    // whole gift balance back regardless of the (smaller) refund amount, badly
    // over-refunding. Partial refunds of gift-paid checks need a dedicated
    // amount-aware flow (flagged for follow-up); for now they don't auto-reverse
    // the gift card.
    if (check?.giftCard?.card_id && check.giftCard.idempotency_key && isFullRefund) {
      (async () => {
        try {
          const token = await ensureAuthToken();
          if (!token) { console.warn('[refundCheck] gift reversal skipped — no auth token'); return; }
          const res = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gift-reverse-redeem`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
              body: JSON.stringify({
                card_id: check.giftCard.card_id,
                original_idempotency_key: check.giftCard.idempotency_key,
                reason: `POS refund: ${reason || 'refund'}`,
                staff_id: manager?.id || null,
                location_id: getActiveLocationSync(),
              }),
            }
          );
          const j = await res.json().catch(() => ({}));
          if (res.ok) {
            console.info('[refundCheck] gift card reversed:', j.status || 'ok', 'restored:', j.restored);
          } else {
            console.warn('[refundCheck] gift reversal HTTP error:', res.status, j.error || '');
          }
        } catch (e) {
          console.warn('[refundCheck] gift reversal failed:', e?.message || e);
        }
      })();
    }
    // v5.5.218: Loyalty points reversal — clawback earned points and restore
    // redeemed points. Fire-and-forget, same pattern as gift card reversal.
    // The edge function is idempotent via refund:{closed_check_id}.
    if (check?.customer?.phone || check?.customer_id || check?.loyalty) {
      (async () => {
        try {
          const token = await ensureAuthToken();
          if (!token) { console.warn('[refundCheck] loyalty reversal skipped — no auth token'); return; }
          // Resolve customer_id: check may have it directly, or we find it from loyalty data
          const customerId = check.customer_id || check.loyalty?.customer_id || null;
          if (!customerId) {
            console.warn('[refundCheck] loyalty reversal skipped — no customer_id on check');
            return;
          }
          const res = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/loyalty-refund`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
              body: JSON.stringify({
                customer_id: customerId,
                location_id: getActiveLocationSync(),
                // v5.5.311: must match the unique id used at earn time (chk-<ts>)
                // so loyalty-refund finds the right earn rows. Was check.ref
                // which cycles R1–R99 and could reverse the WRONG order's points.
                closed_check_id: check.id || check.ref,
                reason: reason || 'refund',
                staff_id: manager?.id || null,
              }),
            }
          );
          const j = await res.json().catch(() => ({}));
          if (res.ok) {
            console.info('[refundCheck] loyalty reversed:', j.status, 'points:', j.points_reversed);
          } else if (res.status !== 404) {
            // 404 = no loyalty transactions for this check — not an error
            console.warn('[refundCheck] loyalty reversal HTTP', res.status, j.error || '');
          }
        } catch (e) {
          console.warn('[refundCheck] loyalty reversal failed:', e?.message || e);
        }
      })();
    }
    // v5.5.301/323: Stripe card refund — return funds to the original card(s).
    // A check can carry MULTIPLE card PaymentIntents (one per card portion of a
    // split). Normalise the legacy single id + the paymentIntents[] array into
    // one list, then refund across all legs. For a single-card check this is a
    // 1-element list → byte-for-byte the original single-refund behaviour.
    const cardPIs = (() => {
      const arr = (Array.isArray(check?.paymentIntents) && check.paymentIntents.length)
        ? check.paymentIntents
        : (check?.stripePaymentIntentId
            ? [{ id: check.stripePaymentIntentId, amountMinor: Math.round((check.total || 0) * 100) }]
            : []);
      return arr.filter(p => p && p.id);
    })();
    const refundAmountMinor = Math.round((amount || 0) * 100);
    // Route the card refund to the processor that ORIGINALLY took the payment —
    // never the location's current setting (it may have changed since). Ryft's id
    // is a payment-session (ps_); Stripe's is a PaymentIntent (pi_).
    const refundProcessor = check?.processor === 'ryft' ? 'ryft' : 'stripe';
    const refundEndpoint = refundProcessor === 'ryft' ? 'ryft-refund' : 'stripe-refund';
    if (cardPIs.length && refundAmountMinor > 0) {
      (async () => {
        const token = await ensureAuthToken();
        if (!token) { console.warn('[refundCheck] card refund skipped — no auth token'); return; }
        // Allocate the refund across the card legs in order: each leg gets up to
        // its captured amount, earlier legs first, until the refund is exhausted.
        // A full refund tops every card leg out; a partial fills from the front.
        // Each leg keeps its own idempotency key so a retry after a partial
        // failure never double-refunds a leg that already went through.
        let remainMinor = refundAmountMinor;
        for (const pi of cardPIs) {
          if (remainMinor <= 0) break;
          // Single leg: refund the full requested amount and let Stripe enforce
          // the real captured cap (identical to the pre-v5.5.323 single-card
          // path — no regression). Multiple legs: cap each at its own captured
          // amount so one card isn't over-refunded with another card's share.
          const legCap = (cardPIs.length > 1 && Number.isFinite(pi.amountMinor) && pi.amountMinor > 0)
            ? pi.amountMinor
            : remainMinor;
          const legRefund = Math.min(remainMinor, legCap);
          if (legRefund <= 0) continue;
          try {
            const res = await fetch(
              `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${refundEndpoint}`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({
                  // Ryft refunds by payment-session id; Stripe by PaymentIntent id.
                  ...(refundProcessor === 'ryft' ? { payment_session_id: pi.id } : { payment_intent_id: pi.id }),
                  amount_minor: legRefund,
                  location_id: getActiveLocationSync(),
                  reason: 'requested_by_customer',
                  closed_check_id: check.ref || check.id,
                  idempotency_key: `refund:${check.id || check.ref}:${pi.id}`,  // v5.5.323: per-leg, retry-safe
                  staff_id: manager?.id || null,
                }),
              }
            );
            const j = await res.json().catch(() => ({}));
            if (res.ok) {
              console.info(`[refundCheck] ${refundProcessor} refund created:`, j.refund_id || j.refund?.id, 'id:', pi.id, 'amount:', j.amount);
              remainMinor -= legRefund;
            } else {
              console.warn(`[refundCheck] ${refundProcessor} refund HTTP error:`, res.status, j.error || '', 'id:', pi.id);
            }
          } catch (e) {
            console.warn(`[refundCheck] ${refundProcessor} refund failed:`, e?.message || e, 'id:', pi.id);
          }
        }
      })();
    }
    // v5.5.311/323: be honest about card refunds. If the customer paid (partly)
    // by card but we have NO PaymentIntent to refund against (legacy checks that
    // predate the column, or a simulated/no-reader payment), don't claim it was
    // processed — tell staff to refund the card manually so money is actually
    // returned. With ≥1 captured PI the loop above auto-refunded the card legs.
    // (Splits store their card legs in paymentIntents[], so cardPIs covers them.)
    const cardInMethod = check?.method?.includes('card');  // single-card / gift+card
    if (cardInMethod && cardPIs.length === 0) {
      get().showToast(`Refund of ${money(amount)} recorded — issue the card refund manually (no linked card payment found)`, 'warning');
    } else {
      get().showToast(`Refund of ${money(amount)} processed via ${tenderMethod}`, 'success');
    }
  },

  // ── Void log ──────────────────────────────
  voidLog: [],

  voidItem: (tableId, itemUid, { manager, reason }) => {
    const { tables, voidLog, showToast } = get();
    const table = tables.find(t => t.id === tableId);
    const item  = table?.session?.items?.find(i => i.uid === itemUid);
    if (!item) return;

    // v4.6.11: restore daily count — the voided item is not being consumed.
    if (item.itemId && !item.voided) {
      get().decrementDailyCount(item.itemId, -(item.qty || 1));
      // v5.5.189: restore modifier sub-item counts too
      (item.mods || []).forEach(mod => {
        if (mod.itemId) get().decrementDailyCount(mod.itemId, -((mod.qty || 1) * (item.qty || 1)));
      });
    }

    // Mark item as voided (keep visible with strikethrough)
    set(s => ({
      tables: s.tables.map(t => {
        if (t.id !== tableId || !t.session) return t;
        const items = t.session.items.map(i => i.uid === itemUid ? { ...i, status:'voided', voided:true } : i);
        const subtotal = items.filter(i=>!i.voided).reduce((s,i)=>s+i.price*i.qty,0);
        return { ...t, session:{ ...t.session, items, subtotal, total:subtotal*1.125 } };
      }),
      voidLog: [{
        id:`void-${Date.now()}`, timestamp:Date.now(), type:'item',
        tableId, tableLabel:table.label,
        items:[{ name:item.name, price:item.price, qty:item.qty }],
        totalValue: item.price * item.qty,
        reason, manager: manager.name, managerId: manager.id,
      }, ...s.voidLog],
    }));
    showToast(`${item.name} voided — ${reason}`, 'warning');
  },

  voidCheck: (tableId, { manager, reason }) => {
    const { tables, showToast } = get();
    const table  = tables.find(t => t.id === tableId);
    const session = table?.session;
    if (!session) return;

    // v4.6.11: restore daily count for every non-voided item before we void the check.
    (session.items || []).forEach(i => {
      if (i.itemId && !i.voided) {
        get().decrementDailyCount(i.itemId, -(i.qty || 1));
        // v5.5.189: restore modifier sub-item counts too
        (i.mods || []).forEach(mod => {
          if (mod.itemId) get().decrementDailyCount(mod.itemId, -((mod.qty || 1) * (i.qty || 1)));
        });
      }
    });

    const totalValue = session.items.reduce((s,i) => s+i.price*i.qty, 0);
    set(s => ({
      tables: s.tables.map(t => {
        if (t.id !== tableId || !t.session) return t;
        const items = t.session.items.map(i => ({ ...i, status:'voided', voided:true }));
        return { ...t, status:'available', session:null };
      }),
      voidLog: [{
        id:`void-${Date.now()}`, timestamp:Date.now(), type:'check',
        tableId, tableLabel:table.label,
        items: session.items.map(i => ({ name:i.name, price:i.price, qty:i.qty })),
        totalValue, reason, manager:manager.name, managerId:manager.id,
      }, ...s.voidLog],
      activeTableId: s.activeTableId === tableId ? null : s.activeTableId,
    }));
    showToast(`Check voided by ${manager.name} — ${reason}`, 'error');
  },

  // ── Discounts ──────────────────────────────
  // Check-level discounts stored on the session
  addCheckDiscount: (tableId, discount) => {
    set(s => ({
      tables: s.tables.map(t => {
        if (t.id !== tableId || !t.session) return t;
        const discounts = [...(t.session.discounts||[]), discount];
        return { ...t, session:{ ...t.session, discounts } };
      }),
    }));
  },

  removeCheckDiscount: (tableId, discountId) => {
    set(s => ({
      tables: s.tables.map(t => {
        if (t.id !== tableId || !t.session) return t;
        const discounts = (t.session.discounts||[]).filter(d => d.id !== discountId);
        return { ...t, session:{ ...t.session, discounts } };
      }),
    }));
  },

  addWalkInDiscount: (discount) => set(s => ({
    walkInOrder: { ...s.walkInOrder, discounts:[...(s.walkInOrder?.discounts||[]), discount] },
  })),

  removeWalkInDiscount: (discountId) => set(s => ({
    walkInOrder: { ...s.walkInOrder, discounts:(s.walkInOrder?.discounts||[]).filter(d=>d.id!==discountId) },
  })),

  // Item-level discount
  addItemDiscount: (tableId, itemUid, discount) => {
    if (tableId) {
      set(s => ({ tables:s.tables.map(t => {
        if (t.id!==tableId||!t.session) return t;
        const items = t.session.items.map(i => i.uid===itemUid ? {...i, discount} : i);
        const subtotal = items.filter(i=>!i.voided).reduce((s,i)=>s+(i.discount?i.price*(1-i.discount.value/100)*i.qty:i.price*i.qty),0);
        return {...t, session:{...t.session, items, subtotal, total:subtotal*1.125}};
      })}));
    } else {
      set(s => ({ walkInOrder:{ ...s.walkInOrder, items:(s.walkInOrder?.items||[]).map(i=>i.uid===itemUid?{...i,discount}:i) } }));
    }
  },

  removeItemDiscount: (tableId, itemUid) => {
    if (tableId) {
      set(s => ({ tables:s.tables.map(t => {
        if(t.id!==tableId||!t.session) return t;
        const items=t.session.items.map(i=>i.uid===itemUid?{...i,discount:null}:i);
        return {...t,session:{...t.session,items}};
      })}));
    } else {
      set(s=>({walkInOrder:{...s.walkInOrder,items:(s.walkInOrder?.items||[]).map(i=>i.uid===itemUid?{...i,discount:null}:i)}}));
    }
  },

  // ── KDS ───────────────────────────────────
  kdsTickets: isMock ? INITIAL_KDS : [],
  bumpTicket: id => {
    set(s => ({ kdsTickets: s.kdsTickets.filter(t => t.id !== id) }));
    import('../lib/db.js').then(({ bumpKDSTicket }) => bumpKDSTicket(id));
  },

  // ── Print job routing ─────────────────────────────────────────────────────
  // Dispatches a kitchen/bar/pass ticket to the printer assigned to the centre.
  // Retries 3x with exponential backoff on transient failures.
  // When fully offline (navigator.onLine === false AND no native bridge), the
  // job is persisted to Supabase print_jobs as 'pending' via _submitJob → the
  // existing OfflineQueue + Node agent pick it up when connectivity returns.
  printJobs: [],
  routePrintJob: async (job) => {
    // job shape: { centreId, printerName, tableLabel, items, type, server, covers, course }
    //
    // v4.3.0 — DURABLE-FIRST dispatch.
    // printService._submitJob inserts a print_jobs row before attempting any
    // dispatch. That row is the durable source of truth. This function just
    // does ONE immediate attempt; the master-side PrintRetrier handles retries.
    const jobId = `pj-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    const basePrintJob = { ...job, id: jobId, sentAt: Date.now() };

    // Look up the printer configured for this centre
    const routingConfig = (() => {
      try {
        const stored = useStore.getState().printRouting;
        if (stored?.centres?.length) return stored;
        return JSON.parse(localStorage.getItem('rpos-print-routing') || 'null') || { centres: [], routing: {} };
      } catch { return { centres: [], routing: {} }; }
    })();

    const centre = routingConfig.centres?.find(c => c.id === job.centreId);
    const printerId = centre?.printer?.id || null;

    // No printer mapped → still creates KDS ticket, warns staff
    if (!printerId) {
      set(s => ({ printJobs: [{ ...basePrintJob, status: 'no-printer' }, ...s.printJobs.slice(0, 49)] }));
      get().showToast(`No printer mapped for ${centre?.name || job.centreId} — ticket shown on KDS only`, 'warn');
      return;
    }

    // v4.6.8: Fire-marker jobs take a dedicated idempotency key and a different
    // ticket builder — otherwise treated identically by the rest of this function
    // (status tracking, retries, health updates, error handling all reuse the same path).
    const isFireMarker = job.type === 'fire-marker';
    // v4.6.28: transfer-notice — kitchen alert fired when a table moves/combines.
    const isTransferNotice = job.type === 'transfer-notice';
    const idempotencyKey = isFireMarker
      ? `fire-${job.tableLabel || 'walkin'}-${job.centreId}-${job.course || 0}-${basePrintJob.sentAt}`
      : isTransferNotice
        ? `transfer-${job.fromTable || '?'}-${job.tableLabel || '?'}-${job.centreId}-${basePrintJob.sentAt}`
        : `kitchen-${job.tableLabel || 'walkin'}-${job.centreId}-${job.course || 0}-${basePrintJob.sentAt}`;

    // Local UI job marker — reflects Supabase-side state via realtime subs
    set(s => ({ printJobs: [{ ...basePrintJob, status: 'sending', printerId, attempts: 0 }, ...s.printJobs.slice(0, 49)] }));

    try {
      // v4.6.7: strip allergen mod lines from printed docket unless the centre
      // has opted in via printAllergens=true. KDS still shows the full mods list
      // (see createKdsTickets) so kitchen staff retain the safety info on-screen.
      // Allergen lines are stamped with a leading '⚠' in createKdsTickets; filter on that.
      const printItems = centre?.printAllergens
        ? (job.items || [])
        : (job.items || []).map(it => ({
            ...it,
            mods: Array.isArray(it.mods) ? it.mods.filter(m => {
              const text = typeof m === 'string' ? m : (m?.label || '');
              return !text.startsWith('⚠');
            }) : it.mods,
          }));

      const result = isFireMarker
        ? await printService.printFireCourseTicket({
            table: job.tableLabel || '',
            courseNum: job.course,
            centreName: centre?.name || job.printerName || 'Kitchen',
            sentAt: basePrintJob.sentAt,
          }, printerId, { idempotencyKey })
        : isTransferNotice
        ? await printService.printTransferNoticeTicket({
            fromTable: job.fromTable || '',
            toTable:   job.tableLabel || '',
            centreName: centre?.name || job.printerName || 'Kitchen',
            items: printItems,
            server: job.server,
            sentAt: basePrintJob.sentAt,
          }, printerId, { idempotencyKey })
        : await printService.printKitchenTicket({
            table: job.tableLabel || '',
            server: job.server || '',
            covers: job.covers || 0,
            course: job.course || null,
            centreName: centre?.name || job.printerName || 'Kitchen',
            items: printItems,
            sentAt: basePrintJob.sentAt,
            delivery: job.delivery || null,   // HubRise/delivery context block (null for all other tickets)
          }, printerId, { idempotencyKey });

      // Any outcome here is "first attempt done". PrintRetrier handles persistent retries.
      if (result?.ok) {
        set(s => ({
          printJobs: s.printJobs.map(pj =>
            pj.id === jobId ? { ...pj, status: result.transport === 'queued' ? 'queued' : 'printed', transport: result.transport, supabaseJobId: result.jobId } : pj
          ),
        }));
        if (result.transport !== 'queued') printService.recordPrinterHealth(printerId, 'online');
      } else {
        // Native bridge failed — durable row is in place, PrintRetrier will pick it up.
        // Update local UI to show pending retry instead of hard failure.
        set(s => ({
          printJobs: s.printJobs.map(pj =>
            pj.id === jobId ? { ...pj, status: 'retry-pending', error: result.error, supabaseJobId: result.jobId, attempts: 1 } : pj
          ),
        }));
        // Don't toast yet — retrier may still succeed. Only toast on permanent failure (handled elsewhere).
      }
    } catch (err) {
      // Shouldn't normally happen — _submitJob catches its own errors
      set(s => ({
        printJobs: s.printJobs.map(pj =>
          pj.id === jobId ? { ...pj, status: 'failed', error: err.message } : pj
        ),
      }));
      printService.recordPrinterHealth(printerId, 'offline', err.message);
      get().showToast(`Print failed: ${err.message}. Check the status drawer.`, 'error');
    }
  },

  // v5.5.57: route kiosk-originated orders through production centres.
  // Buckets items by centre using the same routing config the POS uses,
  // creates per-centre kds_tickets, and calls routePrintJob per centre.
  // Idempotent via a conditional UPDATE on kitchen_routed_at — only the
  // first claimer (typically master POS) does the work.
  routeKioskOrderPrints: async (order) => {
    if (!order?.ref || !Array.isArray(order.items) || !order.items.length) return;
    if (!supabase) return;
    // v5.5.131: surface routing diagnostics as on-screen toasts on the master
    // device — DevTools isn't accessible on Sunmi/Android-APK installs.
    const showToast = useStore.getState().showToast;
    const srcLabel = order.source ? order.source.toUpperCase() : 'ORDER';
    // Log AND toast the entry so the operator sees the order arrive.
    console.log('[routeKioskOrderPrints] ENTRY', order.ref, 'source:', order.source,
      'items:', order.items.map(i => ({
        id: i.id || i.itemId, name: i.name, cat: i.cat, cats: i.cats,
        parentId: i.parentId || i.parent_id,
      })));
    showToast?.(`Routing ${srcLabel} ${order.ref}…`, 'info');
    try {
      // v5.5.126: scheduled-order deferral. order_queue.sent_at is the
      // kitchen-fire moment (collection_time − online_collection_lead_min).
      // For ASAP orders sent_at ≈ now and we route immediately. For a
      // scheduled order whose sent_at is in the future we set a timer to
      // re-call ourselves at that moment. We DON'T claim the row yet —
      // claiming gates against duplicate routing once the timer fires;
      // claiming early would block other devices from picking it up if
      // this device disconnects before the timer pops.
      const sentAtMs = order.sentAt || Date.now();
      const waitMs = sentAtMs - Date.now();
      if (waitMs > 60_000) {
        // Cap at 24h so a scheduled-for-tomorrow order doesn't keep a
        // setTimeout pinned forever. Master-boot backfill picks it up
        // closer to the time. setTimeout's max safe delay is ~24.8 days.
        const cappedWait = Math.min(waitMs, 24 * 60 * 60_000);
        console.log('[routeKioskOrderPrints] deferring', order.ref,
          'until', new Date(sentAtMs).toISOString(),
          `(in ${Math.round(cappedWait/60000)} min)`);
        setTimeout(() => useStore.getState().routeKioskOrderPrints?.(order), cappedWait);
        return;
      }
      // v5.5.138/143: atomic claim with graceful fallback when the
      // kitchen_routed_at column is missing on the venue's DB (migration
      // v5.5.57 not applied). When the column exists, IS NULL → NOW gives
      // us cross-device dedup. When missing, in-memory _routedRefs Set
      // gives best-effort same-device dedup so the same realtime event
      // doesn't produce duplicate KDS tickets if it fires twice locally.
      const COL_MISSING = (err) => err?.message?.includes('kitchen_routed_at')
        && err?.message?.includes('schema cache');
      // v5.5.279: CRITICAL — add location_id guard. `ref` is a short sequential
      // number (#1042) that WILL collide across locations; without this guard,
      // routing at Location A could claim Location B's order_queue row.
      const locId = getActiveLocationSync() || await getLocationId();
      const r = await supabase
        .from('order_queue')
        .update({ kitchen_routed_at: new Date().toISOString() })
        .eq('ref', order.ref)
        .eq('location_id', locId)
        .is('kitchen_routed_at', null)
        .select('ref');
      if (r.error && COL_MISSING(r.error)) {
        console.warn('[routeKioskOrderPrints] kitchen_routed_at column missing — proceeding without idempotency claim. Run: alter table order_queue add column kitchen_routed_at timestamptz;');
        // v5.5.159: surface a loud, visible toast — silent console warnings
        // were missed for weeks while every venue with N master devices
        // got N duplicate kitchen tickets per round. The ONE-LINE SQL fix
        // is right there in the toast.
        try {
          if (!useStore._colWarningShown) {
            useStore._colWarningShown = true;
            useStore.getState().showToast?.(
              '⚠ Duplicate prints risk: order_queue.kitchen_routed_at column missing. Run: alter table order_queue add column if not exists kitchen_routed_at timestamptz; (one-time, on Supabase SQL editor)',
              'error', 15000
            );
          }
        } catch {}
        if (!useStore._routedRefs) useStore._routedRefs = new Set();
        if (useStore._routedRefs.has(order.ref)) return;
        useStore._routedRefs.add(order.ref);
      } else {
        if (r.error) { console.warn('[routeKioskOrderPrints] claim failed', r.error); return; }
        if (!r.data?.length) return; // Another device already routed
      }

      // Routing config + cat parent map (mirror getCentresForItem from sendToKitchen)
      let routingConfig = useStore.getState().printRouting;
      if (!routingConfig?.centres?.length) {
        try { routingConfig = JSON.parse(localStorage.getItem('rpos-print-routing') || 'null') || { centres:[], routing:{} }; }
        catch { routingConfig = { centres:[], routing:{} }; }
      }
      let parentMap = {};
      try {
        const snap = JSON.parse(localStorage.getItem('rpos-config-snapshot') || '{}');
        const cats = snap.menuCategories || useStore.getState().menuCategories || [];
        cats.forEach(c => { parentMap[c.id] = c.parentId || null; });
      } catch {}
      const allMenuItems = useStore.getState().menuItems || [];
      const catOrAncestorMatches = (catId, set, depth = 0) => {
        if (!catId || depth > 5) return false;
        if (set.has(catId)) return true;
        const p = parentMap[catId];
        return p ? catOrAncestorMatches(p, set, depth + 1) : false;
      };
      const centresForItem = (item) => {
        const { centres, routing } = routingConfig;
        if (!centres?.length || !routing) return [];
        const menuItem = allMenuItems.find(i => i.id === (item.itemId || item.id));
        const itemCat = item.cat || item.cats?.[0] || menuItem?.cat || menuItem?.cats?.[0] || null;
        const parentId = item.parentId || menuItem?.parentId || null;
        const parentMenuItem = parentId ? allMenuItems.find(i => i.id === parentId) : null;
        const parentCat = parentMenuItem?.cat || parentMenuItem?.cats?.[0] || null;
        const matched = [];
        centres.forEach(centre => {
          const r = routing[centre.id];
          if (!r?.assignedCategories?.length) return;
          if (r.excludedItems?.includes(item.id) || r.excludedItems?.includes(item.itemId)) return;
          const set = new Set(r.assignedCategories);
          if ((itemCat && catOrAncestorMatches(itemCat, set)) || (parentCat && catOrAncestorMatches(parentCat, set))) {
            matched.push(centre.id);
          }
        });
        return matched;
      };

      // Bucket items by centre
      const byCentre = {};
      order.items.forEach(item => {
        centresForItem(item).forEach(cid => {
          if (!byCentre[cid]) byCentre[cid] = [];
          byCentre[cid].push(item);
        });
      });

      // v5.5.555: FALLBACK — a channel/online order whose items match no centre (e.g. a
      // HubRise sku_ref that isn't in our catalog) must STILL print, not silently drop
      // (HubRise rule: handle unknown items gracefully). Route everything to a default
      // kitchen centre (first with a printer, else first centre).
      if (Object.keys(byCentre).length === 0 && order.items.length && routingConfig.centres?.length) {
        const fb = routingConfig.centres.find(c => c.printer?.id) || routingConfig.centres[0];
        if (fb) byCentre[fb.id] = [...order.items];
      }

      // v5.5.126: source-correct labels so the kitchen ticket / KDS card says
      // "Online OL-XXX" or "QR T5" instead of always "Kiosk". Falls back to
      // the previous "Kiosk" wording when source is unknown.
      const SRC_LABEL = { kiosk: 'Kiosk', online: 'Online', qr: 'QR', hubrise: 'HubRise' };
      const srcLabel = SRC_LABEL[order.source] || 'Kiosk';
      const tableLabel = order.source === 'qr' && order.tableLabel
        ? `Table ${order.tableLabel}`
        : `${srcLabel} ${order.ref}`;
      const serverName = order.customer?.name || `${srcLabel} ${order.ref}`;
      const sentAt = order.sentAt || Date.now();

      // HubRise delivery-channel context printed on each centre's kitchen ticket.
      const deliveryBlock = order.source === 'hubrise' ? {
        channel: order.customer?.channel,
        serviceType: order.customer?.serviceType || order.type,
        paid: order.customer?.paid,
        collectionCode: order.customer?.collectionCode,
        name: order.customer?.name,
        phone: order.customer?.phone,
        address: order.customer?.address,
        notes: order.customer?.notes,
        expected: order.isASAP ? 'ASAP'
          : (order.collectionTime ? new Date(order.collectionTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null),
      } : null;

      // Per-centre KDS tickets. v5.5.132: status MUST be 'pending' — that's
      // what the KDS surface filters on (OtherSurfaces.jsx:420 — `status
      // IN (pending, held)`). We were writing 'fired' and KDS never showed
      // anything. Bumped via the existing bumpKDSTicket() flow → 'bumped'.
      // Same shape insertKDSTicket builds for the dine-in / walk-in path.
      const ticketLocationId = useStore.getState().locationConfig?.id
        || getActiveLocationSync()
        || (await getLocationId().catch(() => null));
      const tickets = Object.entries(byCentre).map(([centreId, items]) => ({
        id: `kds-${sentAt}-${centreId}-${Math.random().toString(36).slice(2,6)}`,
        location_id: ticketLocationId,
        centre_id: centreId,
        course: 1,
        all_courses: [1],
        fired_courses: [1],
        items: items.map(i => ({
          qty: i.qty,
          name: i.kitchenName || i.name,
          mods: Array.isArray(i.mods) ? i.mods.map(m => m?.name || m?.label || m).filter(Boolean) : [],
          course: 1, fired: true, status: 'sent', centreId,
        })),
        status: 'pending',                                                   // ← was 'fired'
        sent_at: new Date(sentAt).toISOString(),
        table_id: null,
        table_label: tableLabel,
        server: serverName,
        covers: 1,
      }));
      if (tickets.length) {
        const { error: kdsErr } = await supabase.from('kds_tickets').insert(tickets);
        if (kdsErr) console.warn('[routeKioskOrderPrints] kds insert', kdsErr);
      }
      // v5.5.128: log routing outcome so silent failures (no centres / no
      // matching cats / printer not mapped) surface clearly in DevTools.
      console.log('[routeKioskOrderPrints]', order.ref, 'centres matched:', Object.keys(byCentre).length, 'items routed:', Object.values(byCentre).flat().length);

      // Print jobs per centre
      const getCentrePrinter = (centreId) => {
        const c = routingConfig.centres?.find(c => c.id === centreId);
        return c?.printer?.name || c?.name || 'Kitchen';
      };
      Object.entries(byCentre).forEach(([centreId, items]) => {
        if (!items.length) return;
        // v5.5.129: log per-centre so we can see exactly where the path
        // breaks down — centre matched but no printer? Centre matched and
        // printer mapped? Surfaces the root cause when "didn't print".
        const centre = routingConfig.centres?.find(c => c.id === centreId);
        const printerId = centre?.printer?.id || null;
        console.log('[routeKioskOrderPrints]', order.ref, 'centre:', centre?.name || centreId,
          'printer:', printerId ? `${centre.printer.name} (${printerId})` : 'NONE — KDS only, no paper',
          'items:', items.length);
        get().routePrintJob({
          centreId,
          printerName: getCentrePrinter(centreId),
          tableLabel,
          server: serverName,
          covers: 1,
          course: 1,
          items: items.map(i => ({
            qty: i.qty,
            kitchenName: i.kitchenName,
            name: i.name,
            mods: i.mods,
          })),
          type: 'kitchen',
          delivery: deliveryBlock,
        });
      });

      console.log('[routeKioskOrderPrints] routed', order.ref, 'to', Object.keys(byCentre).length, 'centres');
      // v5.5.129: when zero centres matched, log WHY so the operator can
      // see what's mis-configured (no centres at all? no cats on items?
      // routing config not loaded yet?). One of these is almost always
      // the cause when "didn't print".
      if (Object.keys(byCentre).length === 0) {
        const dump = {
          centres: routingConfig.centres?.length || 0,
          routingKeys: Object.keys(routingConfig.routing || {}).length,
          allCats: order.items?.map(i => i.cat || i.cats?.[0] || null),
        };
        console.warn('[routeKioskOrderPrints] NOTHING ROUTED for', order.ref, '— diagnostic dump:', dump);
        // v5.5.131: on-screen diagnostic toast for Sunmi (no DevTools).
        // Tells the operator EXACTLY which side is broken.
        let reason;
        if (!dump.centres) reason = 'no production centres configured';
        else if (!dump.routingKeys) reason = 'centres exist but no category routing rules';
        else if (dump.allCats?.every(c => !c)) reason = 'order items have no `cat` field — try refreshing customer browser';
        else reason = `item cats (${dump.allCats?.join(', ')}) don\'t match any centre`;
        showToast?.(`⚠ ${srcLabel} ${order.ref} did not print: ${reason}`, 'error');
      } else {
        const centreNames = Object.keys(byCentre).map(cid =>
          routingConfig.centres?.find(c => c.id === cid)?.name || cid
        );
        // Also report which (if any) centres lack a printer mapping.
        const noPrinter = centreNames.filter((_, idx) => {
          const cid = Object.keys(byCentre)[idx];
          const c = routingConfig.centres?.find(c => c.id === cid);
          return !c?.printer?.id;
        });
        if (noPrinter.length) {
          showToast?.(`⚠ ${srcLabel} ${order.ref} routed to ${centreNames.join(', ')} — but ${noPrinter.join(', ')} has no printer mapped (KDS only)`, 'warning');
        } else {
          showToast?.(`✓ ${srcLabel} ${order.ref} routed → ${centreNames.join(', ')}`, 'success');
        }
      }

      // v5.5.128: AFTER prints have fired (or we tried — the print path is
      // durable so the row was at minimum queued), flip status from
      // 'received' → 'prep' so the customer's tracker and the operator's
      // queue both reflect "kitchen has it". Conditional on the row still
      // being 'received' so we never clobber an operator who's already
      // advanced it. Skipped entirely if zero centres matched — in that
      // case nothing was routed, the order genuinely is still just queued.
      if (Object.keys(byCentre).length > 0) {
        try {
          // v5.5.279: location_id guard — refs collide across locations
          await supabase.from('order_queue')
            .update({ status: 'prep' })
            .eq('ref', order.ref)
            .eq('location_id', locId)
            .eq('status', 'received');
        } catch (e) {
          console.warn('[routeKioskOrderPrints] status→prep update failed:', e?.message);
        }
      }
    } catch (e) {
      console.warn('[routeKioskOrderPrints] failed:', e?.message);
    }
  },

  // Print a customer/dispatch receipt for a HubRise delivery order — order number +
  // channel + customer/address details + itemised totals + PAID. Triggered on Accept
  // (or auto-accept) when the venue's "auto-print receipt" setting is on.
  printHubriseReceipt: async (order) => {
    try {
      if (!order) return;
      const c = order.customer || {};
      const items = (order.items || []).map(i => ({ ...i, voided: false }));
      const subtotal = items.reduce((s, it) => s + (Number(it.qty) || 1) * ((Number(it.price) || 0) + (it.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0)), 0);
      const total = Number(order.total) || 0;
      const a = c.address || {};
      const addr = [a.line1, a.line2, [a.city, a.postcode].filter(Boolean).join(' '), a.country].filter(Boolean);
      const check = {
        ref: c.collectionCode || order.ref,
        server: c.channel || 'HubRise',
        orderType: c.serviceType === 'delivery' ? 'Delivery' : c.serviceType === 'collection' ? 'Collection' : 'Order',
        method: c.paid ? 'card' : null,
        delivery: {
          channel: c.channel, serviceType: c.serviceType, paid: !!c.paid,
          name: c.name, phone: c.phone, address: addr, notes: c.notes,
          expected: order.isASAP ? 'ASAP' : (order.collectionTime ? new Date(order.collectionTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null),
        },
      };
      const totals = { subtotal, service: Math.max(0, +(total - subtotal).toFixed(2)), tip: 0, grand: total };
      await printService.printReceipt({ check, items, totals });
    } catch (e) { console.warn('[hubrise] receipt print failed:', e?.message); }
  },

  // Print a customer receipt (called from close-check flow, ReceiptModal, etc.)
  // Safe to call even if no receipt printer is configured — falls back to browser print.
  printCustomerReceipt: async ({ location, check, items, totals }, printerId = null) => {
    try {
      const result = await printService.printReceipt({ location, check, items, totals }, printerId);
      if (result?.ok && result.transport !== 'browser' && printerId) {
        printService.recordPrinterHealth(printerId, 'online');
      }
      return result;
    } catch (err) {
      get().showToast(`Receipt print failed: ${err.message}`, 'error');
      return { ok: false, error: err.message };
    }
  },

  // v4.6.34: legacy openCashDrawer removed — it was overriding the permission-
  // gated + petty-cash-logging version defined earlier in the object. Two
  // actions with the same key collapse to the last declared one in JS object
  // literals, which is what caused 'No printer with cash drawer configured'
  // even when the flag was correctly set.

  // Manually reprint a failed or pending print_jobs row (called from StatusDrawer)
  // Uses the job's stored payload rather than rebuilding — exact reprint.
  reprintJob: async (supabaseRow) => {
    try {
      if (!supabase) throw new Error('No Supabase connection');
      // Reset the job to pending so the agent / native path picks it up again
      // v5.5.279: location_id guard on print job reprint
      const locId = getActiveLocationSync() || await getLocationId();
      const { error } = await supabase
        .from('print_jobs')
        .update({ status: 'pending', error: null, attempts: 0 })
        .eq('id', supabaseRow.id)
        .eq('location_id', locId);
      if (error) throw error;
      get().showToast('Job requeued for printing', 'info');
      return { ok: true };
    } catch (err) {
      get().showToast(`Reprint failed: ${err.message}`, 'error');
      return { ok: false, error: err.message };
    }
  },

  // ── Shift ─────────────────────────────────
  // Shift stats — computed live from closed checks
  get shift() {
    const allChecks = useStore.getState().closedChecks;
    const config    = useStore.getState().locationConfig;
    const seed = SHIFT;

    // Use business day start from location config, fallback to midnight
    const sod = new Date(); sod.setHours(0, 0, 0, 0);
    const checks = allChecks.filter(c => c.closedAt && new Date(c.closedAt) >= sod);

    if (!checks.length) return isMock ? seed : {
      name: 'Current shift', opened: new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }),
      covers: 0, sales: 0, avgCheck: 0, cashSales: 0, cardSales: 0, tips: 0, voids: 0, voidValue: 0,
    };
    const revenue  = checks.reduce((s,c) => s + c.total, 0);
    const covers   = checks.reduce((s,c) => s + (c.covers || 1), 0);
    const tips     = checks.reduce((s,c) => s + (c.tip || 0), 0);
    const voids    = checks.reduce((s,c) => s + c.voids?.length || 0, 0);
    const card     = checks.filter(c => c.method !== 'cash').reduce((s,c) => s + c.total, 0);
    const cash     = checks.filter(c => c.method === 'cash').reduce((s,c) => s + c.total, 0);
    return {
      name: isMock ? seed.name : 'Current shift',
      opened: isMock ? seed.opened : new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }),
      covers, sales: revenue, avgCheck: covers > 0 ? revenue / covers : 0,
      cashSales: cash, cardSales: card, tips, voids, voidValue: 0,
    };
  },

  // ── Toast ─────────────────────────────────
  toast: null,
  theme: localStorage.getItem('rpos-theme') || 'dark',
  setTheme: (t) => {
    localStorage.setItem('rpos-theme', t);
    document.documentElement.setAttribute('data-theme', t);
    set({ theme: t });
  },
  showToast: (msg,type='info') => { set({ toast:{ msg,type,key:Date.now() } }); setTimeout(()=>set({toast:null}),2800); },

  // ── Order alert (big top-of-screen banner for new customer orders) ─────
  // Set by realtime.js when a new kiosk / online / QR order arrives.
  // Shape: { source: 'kiosk'|'online'|'qr', who: 'name or table label', ref, total, key }
  // Stays on screen until the operator dismisses it (× button or swipe up).
  // No auto-dismiss — missing a new-order alert because you blinked is worse
  // than a slightly cluttered screen.
  orderAlert: null,
  showOrderAlert: (alert) => {
    set({ orderAlert: { ...alert, key: Date.now() } });
  },
  dismissOrderAlert: () => set({ orderAlert: null }),

  // ── Allergen pending ──────────────────────
  pendingItem: null,
  setPendingItem: item => set({ pendingItem:item }),
  clearPendingItem: () => set({ pendingItem:null }),
}));
// NOTE: these are appended but the store is defined above — we patch via the create callback
