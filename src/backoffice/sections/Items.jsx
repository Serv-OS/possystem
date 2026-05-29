/**
 * Items — v4.6.1
 *
 * The new dedicated Items tab. Replaces the items-management surface inside
 * the legacy MenuManager.jsx. Designed for the food-hall pitch: clear list,
 * focused edit form, scope-aware (local / shared / global), allergen + modifier
 * pickers prominent, no pizza type, no visible-on toggle.
 *
 * Backend contract:
 *   - Reads menuItems and menuCategories from useStore
 *   - Reads modifier_groups via supabase
 *   - Saves via existing upsertMenuItem helper from lib/db (DataSafe-backed)
 *   - Image upload via uploadProductImage / deleteProductImage (existing)
 *   - All v4.6.0 schema fields are preserved on save (scope, org_id, master_id,
 *     lock_pricing) — defaults are local/null for now. Multi-loc UI lands in v4.7.
 *
 * What's intentionally out of scope (carved into later patch versions):
 *   - v4.6.1b — right-pane (where-used / activity log)
 *   - v4.6.1c — per-menu pricing tier rows
 *   - v4.6.1d — hide legacy MenuManager from nav once Peter signs off
 *
 * MenuManager remains in the nav as a fallback during this version.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store';
import { ALLERGENS } from '../../data/seed';
import { supabase, getLocationId } from '../../lib/supabase';
import { upsertMenuItem, uploadProductImage, deleteProductImage } from '../../lib/db';
import { money } from '../../lib/currency';

// ───────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────

const SCOPES = [
  { id: 'local',  label: 'Local',  desc: 'Only at this location.' },
  { id: 'shared', label: 'Shared', desc: 'All locations in this org. Each can override price, category, image.' },
  { id: 'global', label: 'Global', desc: 'Managed centrally. Edit once, applies everywhere. Locations cannot override.' },
];

const CHANNELS = [
  { id: 'base',       label: 'Base',       hint: 'Default if no channel set' },
  { id: 'dineIn',     label: 'Dine in' },
  { id: 'takeaway',   label: 'Takeaway' },
  { id: 'collection', label: 'Collection' },
  { id: 'delivery',   label: 'Delivery' },
];

// ───────────────────────────────────────────────────────────────────
// Top-level component
// ───────────────────────────────────────────────────────────────────

export default function Items() {
  const menuItems = useStore(s => s.menuItems) || [];
  const menuCategories = useStore(s => s.menuCategories) || [];
  const updateMenuItem = useStore(s => s.updateMenuItem);
  const addMenuItem = useStore(s => s.addMenuItem);
  const archiveMenuItem = useStore(s => s.archiveMenuItem);

  const [search, setSearch] = useState('');
  const [scopeFilter, setScopeFilter] = useState('all'); // all | local | shared | global | archived
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null); // editable copy of selected item
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(0); // for visual save confirm
  const [modifierGroups, setModifierGroups] = useState([]);

  // Load modifier groups from supabase once (they don't change often)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const locId = await getLocationId().catch(() => null);
        if (!locId) return;
        const { data, error } = await supabase
          .from('modifier_groups')
          .select('id, name, min_select, max_select, options')
          .eq('location_id', locId);
        if (error || !alive) return;
        setModifierGroups(data || []);
      } catch (e) {
        console.warn('[Items] modifier groups load failed:', e?.message || e);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Filter list — visible (non-archived unless filter is 'archived'), search, scope
  const visibleItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return menuItems
      .filter(i => {
        if (i.type === 'subitem' && !i.soldAlone) return false; // variants don't get top-level slots
        const archived = !!i.archived;
        if (scopeFilter === 'archived') return archived;
        if (archived) return false;
        if (scopeFilter !== 'all') {
          const s = i.scope || 'local';
          if (s !== scopeFilter) return false;
        }
        if (!q) return true;
        return (i.name || '').toLowerCase().includes(q)
          || (i.menuName || '').toLowerCase().includes(q)
          || (i.description || '').toLowerCase().includes(q);
      })
      .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999) || (a.name || '').localeCompare(b.name || ''));
  }, [menuItems, search, scopeFilter]);

  // Counts for filter pills
  const counts = useMemo(() => {
    const out = { all: 0, local: 0, shared: 0, global: 0, archived: 0 };
    menuItems.forEach(i => {
      if (i.type === 'subitem' && !i.soldAlone) return;
      if (i.archived) { out.archived++; return; }
      out.all++;
      const s = i.scope || 'local';
      if (out[s] != null) out[s]++;
    });
    return out;
  }, [menuItems]);

  // Auto-select first item when list changes & nothing selected
  useEffect(() => {
    if (selectedId && menuItems.find(i => i.id === selectedId)) return;
    if (visibleItems.length) setSelectedId(visibleItems[0].id);
    else setSelectedId(null);
  }, [visibleItems, selectedId, menuItems]);

  // Refresh draft when selection changes
  useEffect(() => {
    const item = menuItems.find(i => i.id === selectedId);
    if (!item) { setDraft(null); return; }
    // Normalise into a working draft. Defaults guard against legacy items.
    setDraft({
      id: item.id,
      name: item.name || '',
      menuName: item.menuName || '',
      receiptName: item.receiptName || '',
      kitchenName: item.kitchenName || '',
      description: item.description || '',
      cat: item.cat || null,
      cats: Array.isArray(item.cats) ? [...item.cats] : [],
      pricing: {
        base: item.pricing?.base ?? item.price ?? 0,
        dineIn: item.pricing?.dineIn ?? null,
        takeaway: item.pricing?.takeaway ?? null,
        collection: item.pricing?.collection ?? null,
        delivery: item.pricing?.delivery ?? null,
        menus: item.pricing?.menus || {},
      },
      allergens: Array.isArray(item.allergens) ? [...item.allergens] : [],
      assignedModifierGroups: Array.isArray(item.assignedModifierGroups)
        ? [...item.assignedModifierGroups]
        : (Array.isArray(item.assigned_modifier_groups) ? [...item.assigned_modifier_groups] : []),
      image: item.image || null,
      sortOrder: item.sortOrder ?? 999,
      scope: item.scope || 'local',
      lockPricing: !!item.lockPricing,
      archived: !!item.archived,
    });
  }, [selectedId, menuItems]);

  const dirty = useMemo(() => {
    if (!draft || !selectedId) return false;
    const orig = menuItems.find(i => i.id === selectedId);
    if (!orig) return false;
    // Cheap dirty check — JSON.stringify on the bits we care about
    const a = {
      name: orig.name, menuName: orig.menuName, receiptName: orig.receiptName,
      description: orig.description, cat: orig.cat, cats: orig.cats || [],
      pricing: orig.pricing || { base: orig.price ?? 0 },
      allergens: orig.allergens || [],
      mods: orig.assignedModifierGroups || orig.assigned_modifier_groups || [],
      scope: orig.scope || 'local', lockPricing: !!orig.lockPricing, image: orig.image || null,
    };
    const b = {
      name: draft.name, menuName: draft.menuName, receiptName: draft.receiptName,
      description: draft.description, cat: draft.cat, cats: draft.cats,
      pricing: draft.pricing,
      allergens: draft.allergens,
      mods: draft.assignedModifierGroups,
      scope: draft.scope, lockPricing: draft.lockPricing, image: draft.image,
    };
    return JSON.stringify(a) !== JSON.stringify(b);
  }, [draft, selectedId, menuItems]);

  const onNew = useCallback(() => {
    if (!addMenuItem) return;
    const id = 'm-' + Date.now();
    addMenuItem({
      id,
      type: 'simple',
      name: 'New item',
      cat: visibleItems[0]?.cat || menuCategories[0]?.id || null,
      cats: [],
      pricing: { base: 0, dineIn: null, takeaway: null, collection: null, delivery: null },
      allergens: [],
      assignedModifierGroups: [],
      scope: 'local',
      sortOrder: 999,
    });
    setSelectedId(id);
  }, [addMenuItem, visibleItems, menuCategories]);

  const onSave = useCallback(async () => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      // Update local store first (optimistic)
      if (updateMenuItem) {
        updateMenuItem(draft.id, {
          name: draft.name,
          menuName: draft.menuName,
          receiptName: draft.receiptName,
          kitchenName: draft.kitchenName,
          description: draft.description,
          cat: draft.cat,
          cats: draft.cats,
          pricing: draft.pricing,
          price: draft.pricing.base, // legacy mirror
          allergens: draft.allergens,
          assignedModifierGroups: draft.assignedModifierGroups,
          image: draft.image,
          sortOrder: draft.sortOrder,
          scope: draft.scope,
          lockPricing: draft.lockPricing,
          archived: draft.archived,
        });
      }
      // Persist to DB. v4.6.0 fields go through verbatim.
      await upsertMenuItem({
        id: draft.id,
        name: draft.name,
        menuName: draft.menuName,
        receiptName: draft.receiptName,
        kitchenName: draft.kitchenName,
        description: draft.description,
        cat: draft.cat,
        cats: draft.cats,
        pricing: draft.pricing,
        allergens: draft.allergens,
        assignedModifierGroups: draft.assignedModifierGroups,
        image: draft.image,
        sortOrder: draft.sortOrder,
        scope: draft.scope,
        lockPricing: draft.lockPricing,
        archived: draft.archived,
      });
      setSavedTick(t => t + 1);
    } catch (e) {
      console.error('[Items] save failed:', e?.message || e);
      alert('Save failed: ' + (e?.message || 'unknown error'));
    } finally {
      setSaving(false);
    }
  }, [draft, saving, updateMenuItem]);

  const onDiscard = useCallback(() => {
    // Reset draft from store
    const item = menuItems.find(i => i.id === selectedId);
    if (!item) return;
    setSelectedId(null);
    setTimeout(() => setSelectedId(item.id), 0);
  }, [selectedId, menuItems]);

  const onArchiveToggle = useCallback(async () => {
    if (!draft) return;
    const newArchived = !draft.archived;
    if (newArchived && !confirm(`Archive "${draft.name}"? It won't show on POS but is recoverable from the Archived filter.`)) return;
    setDraft(d => ({ ...d, archived: newArchived }));
    // Persist archived flag immediately. archiveMenuItem only archives;
    // for restore we go via updateMenuItem to preserve symmetry.
    try {
      if (newArchived && archiveMenuItem) await archiveMenuItem(draft.id);
      else if (updateMenuItem) updateMenuItem(draft.id, { archived: newArchived });
      // Push to DB regardless so it survives reload
      await upsertMenuItem({ id: draft.id, archived: newArchived });
    } catch (e) {
      console.warn('[Items] archive toggle failed:', e?.message || e);
    }
  }, [draft, archiveMenuItem, updateMenuItem]);

  const onUploadImage = useCallback(async (file) => {
    if (!draft) return;
    try {
      const url = await uploadProductImage(draft.id, file);
      setDraft(d => ({ ...d, image: url }));
    } catch (e) {
      console.warn('[Items] image upload failed:', e?.message || e);
      alert('Upload failed: ' + (e?.message || 'unknown error'));
    }
  }, [draft]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', height: '100%', minHeight: 0, background: 'var(--bg0)' }}>
      <ListPane
        items={visibleItems}
        selectedId={selectedId}
        onSelect={setSelectedId}
        search={search}
        onSearchChange={setSearch}
        scopeFilter={scopeFilter}
        onScopeFilterChange={setScopeFilter}
        counts={counts}
        onNew={onNew}
        categoriesById={Object.fromEntries(menuCategories.map(c => [c.id, c]))}
      />
      {draft ? (
        <EditPane
          draft={draft}
          setDraft={setDraft}
          dirty={dirty}
          saving={saving}
          savedTick={savedTick}
          categories={menuCategories}
          modifierGroups={modifierGroups}
          onSave={onSave}
          onDiscard={onDiscard}
          onArchiveToggle={onArchiveToggle}
          onUploadImage={onUploadImage}
        />
      ) : (
        <div style={{ display: 'grid', placeItems: 'center', color: 'var(--t3)', fontSize: 14 }}>
          Select an item to edit, or click + to create one.
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
// LIST PANE
// ───────────────────────────────────────────────────────────────────

function ListPane({ items, selectedId, onSelect, search, onSearchChange, scopeFilter, onScopeFilterChange, counts, onNew, categoriesById }) {
  const FILTERS = [
    { id: 'all',      label: 'All',      ct: counts.all },
    { id: 'local',    label: 'Local',    ct: counts.local },
    { id: 'shared',   label: 'Shared',   ct: counts.shared },
    { id: 'global',   label: 'Global',   ct: counts.global },
    { id: 'archived', label: 'Archived', ct: counts.archived },
  ];
  return (
    <aside style={{ borderRight: '1px solid var(--bdr)', background: 'var(--bg1)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--bdr)', position: 'relative' }}>
        <input
          value={search}
          onChange={e => onSearchChange(e.target.value)}
          placeholder="Search items…"
          style={{ width: '100%', background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '7px 10px', color: 'var(--t1)', outline: 'none', fontSize: 13 }}
        />
        <button
          onClick={onNew}
          title="New item"
          style={{ position: 'absolute', top: 14, right: 16, width: 28, height: 28, borderRadius: 6, background: 'var(--acc)', color: '#fff', border: 0, fontSize: 18, lineHeight: 1, cursor: 'pointer' }}
        >+</button>
        <div style={{ display: 'flex', gap: 5, marginTop: 10, flexWrap: 'wrap' }}>
          {FILTERS.map(f => (
            <button key={f.id}
              onClick={() => onScopeFilterChange(f.id)}
              style={{
                padding: '4px 9px',
                fontSize: 11.5,
                fontWeight: 500,
                borderRadius: 5,
                background: scopeFilter === f.id ? 'var(--bg3)' : 'transparent',
                color: scopeFilter === f.id ? 'var(--t1)' : 'var(--t3)',
                border: '1px solid ' + (scopeFilter === f.id ? 'var(--bg3)' : 'var(--bdr2, var(--bdr))'),
                cursor: 'pointer',
              }}
            >{f.label}<span style={{ marginLeft: 5, color: scopeFilter === f.id ? 'var(--t3)' : 'var(--t4, var(--t3))', fontSize: 10, fontFamily: 'ui-monospace, monospace' }}>{f.ct}</span></button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {items.length === 0 && (
          <div style={{ padding: 22, fontSize: 12.5, color: 'var(--t3)', textAlign: 'center' }}>No items match.</div>
        )}
        {items.map(it => {
          const sel = it.id === selectedId;
          const cat = it.cat ? categoriesById[it.cat] : null;
          const scope = it.scope || 'local';
          return (
            <button key={it.id}
              onClick={() => onSelect(it.id)}
              style={{
                display: 'flex', alignItems: 'center', padding: '10px 16px', gap: 11,
                width: '100%', textAlign: 'left',
                borderBottom: '1px solid var(--bdr)',
                cursor: 'pointer',
                background: sel ? 'var(--bg2)' : 'transparent',
                boxShadow: sel ? 'inset 3px 0 0 var(--acc)' : 'none',
                border: 0,
                color: 'inherit',
              }}
            >
              <div style={{ width: 36, height: 36, borderRadius: 6, background: cat?.color ? cat.color + '22' : 'var(--bg3)', flexShrink: 0, display: 'grid', placeItems: 'center', fontSize: 16, overflow: 'hidden' }}>
                {it.image ? <img src={it.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (cat?.icon || '🍽')}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, color: 'var(--t1)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</div>
                <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2, display: 'flex', gap: 8 }}>
                  <ScopePill scope={scope} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cat?.label || 'No category'}</span>
                </div>
              </div>
              <div style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--t2)', fontSize: 12, fontWeight: 500, flexShrink: 0 }}>
                {money(Number(it.pricing?.base ?? it.price ?? 0))}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function ScopePill({ scope }) {
  const styles = {
    local:  { bg: 'rgba(115,115,115,0.16)', fg: '#b8b8c0' },
    shared: { bg: 'rgba(59,130,246,0.16)',  fg: '#80b4ff' },
    global: { bg: 'rgba(168,85,247,0.18)',  fg: '#c89bff' },
  };
  const s = styles[scope] || styles.local;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '1px 6px',
      fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em',
      textTransform: 'uppercase',
      borderRadius: 3,
      fontFamily: 'ui-monospace, monospace',
      background: s.bg, color: s.fg,
    }}>{scope}</span>
  );
}

// ───────────────────────────────────────────────────────────────────
// EDIT PANE
// ───────────────────────────────────────────────────────────────────

function EditPane({ draft, setDraft, dirty, saving, savedTick, categories, modifierGroups, onSave, onDiscard, onArchiveToggle, onUploadImage }) {
  // Helper: update one field in draft
  const upd = useCallback((patch) => setDraft(d => ({ ...d, ...patch })), [setDraft]);
  const updPrice = useCallback((channel, val) => {
    setDraft(d => ({
      ...d,
      pricing: { ...d.pricing, [channel]: val === '' || val == null ? (channel === 'base' ? 0 : null) : Number(val) },
    }));
  }, [setDraft]);

  return (
    <main style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <header style={{ padding: '24px 36px 20px', borderBottom: '1px solid var(--bdr)' }}>
          <div style={{ fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--t4, var(--t3))', marginBottom: 6, fontFamily: 'ui-monospace, monospace' }}>
            Editing item · {draft.id.slice(0, 24)}
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.015em', margin: 0, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', color: 'var(--t1)' }}>
            <span>{draft.name || 'New item'}</span>
            <ScopePill scope={draft.scope} />
            {draft.archived && <ScopePillBadge label="archived" color="#f97171" bg="rgba(239,68,68,0.13)" />}
          </h1>
        </header>

        <Section title="Basics">
          <Row>
            <Field label="Display name">
              <Input value={draft.name} onChange={v => upd({ name: v })} />
            </Field>
            <Field label="Receipt & kitchen" optional="optional shorthand">
              <Input value={draft.menuName} onChange={v => upd({ menuName: v })} placeholder="Defaults to display name" mono />
            </Field>
          </Row>
          <Field label="Description" optional="shown on customer receipts & POS list">
            <textarea
              value={draft.description}
              onChange={e => upd({ description: e.target.value })}
              style={{ ...inputStyle(), minHeight: 56, resize: 'vertical', lineHeight: 1.5 }}
            />
          </Field>
          <Row>
            <Field label="Image">
              <ImageUpload current={draft.image} onUpload={onUploadImage} onClear={() => upd({ image: null })} />
            </Field>
            <Field label="Sort order" optional="lower = earlier in category">
              <Input value={String(draft.sortOrder)} onChange={v => upd({ sortOrder: Number(v) || 0 })} mono />
            </Field>
          </Row>
        </Section>

        <Section title="Pricing" help="Base is the default. Channel overrides apply when that order type is active.">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
            {CHANNELS.map(ch => (
              <Field key={ch.id} label={ch.label}>
                <PriceInput
                  value={draft.pricing[ch.id]}
                  onChange={v => updPrice(ch.id, v)}
                  isBase={ch.id === 'base'}
                  basePlaceholder={ch.id !== 'base' ? Number(draft.pricing.base ?? 0).toFixed(2) : null}
                />
              </Field>
            ))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>
            Empty channel = falls back to base. Per-menu price tiers (e.g. Deliveroo) coming in v4.6.1c.
          </div>
        </Section>

        <Section title="Categories" help="First pick = primary (used for kitchen routing). Add more for multi-listing.">
          <CategoryPicker
            categories={categories}
            primary={draft.cat}
            extras={draft.cats}
            onChange={(primary, extras) => upd({ cat: primary, cats: extras })}
          />
        </Section>

        <Section title="Allergens" help="Used for menu filtering and the allergen gate at checkout.">
          <PillPicker
            options={ALLERGENS.map(a => ({ id: a.id, label: a.label, icon: a.icon }))}
            selected={draft.allergens}
            onToggle={(id) => {
              const has = draft.allergens.includes(id);
              upd({ allergens: has ? draft.allergens.filter(x => x !== id) : [...draft.allergens, id] });
            }}
            colorClass="allergen"
          />
        </Section>

        <Section title="Modifier groups" help="Optional add-ons. Attach existing groups; manage them in the Modifiers tab.">
          <PillPicker
            options={modifierGroups.map(m => ({ id: m.id, label: m.name }))}
            selected={draft.assignedModifierGroups}
            onToggle={(id) => {
              const has = draft.assignedModifierGroups.includes(id);
              upd({ assignedModifierGroups: has ? draft.assignedModifierGroups.filter(x => x !== id) : [...draft.assignedModifierGroups, id] });
            }}
            colorClass="mod"
            empty="No modifier groups yet. Create some in the Modifiers tab."
          />
        </Section>

        <Section title="Sharing" help="Where this item lives across your locations.">
          <ScopeCards
            value={draft.scope}
            onChange={s => upd({ scope: s })}
          />
          {draft.scope !== 'local' && (
            <ToggleRow
              on={draft.lockPricing}
              onToggle={() => upd({ lockPricing: !draft.lockPricing })}
              title="Lock pricing"
              desc="When on, other locations can change category & image but not price."
            />
          )}
        </Section>
      </div>

      <ActionBar
        onArchive={onArchiveToggle}
        archived={draft.archived}
        onDiscard={onDiscard}
        onSave={onSave}
        dirty={dirty}
        saving={saving}
        savedTick={savedTick}
      />
    </main>
  );
}

// ───────────────────────────────────────────────────────────────────
// Sub-components
// ───────────────────────────────────────────────────────────────────

function Section({ title, help, children }) {
  return (
    <section style={{ padding: '20px 36px', borderBottom: '1px solid var(--bdr)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--t1)', letterSpacing: '-0.01em' }}>{title}</div>
        {help && <div style={{ fontSize: 11.5, color: 'var(--t3)' }}>{help}</div>}
      </div>
      {children}
    </section>
  );
}

function Row({ children }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 12 }}>{children}</div>;
}

function Field({ label, optional, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 10 }}>
      <label style={{ fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--t3)', fontFamily: 'ui-monospace, monospace' }}>
        {label}
        {optional && <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400, fontFamily: 'inherit', color: 'var(--t4, var(--t3))', marginLeft: 6, fontSize: 11 }}>{optional}</span>}
      </label>
      {children}
    </div>
  );
}

function inputStyle() {
  return {
    background: 'var(--bg1)',
    border: '1px solid var(--bdr)',
    borderRadius: 6,
    padding: '8px 12px',
    color: 'var(--t1)',
    outline: 'none',
    width: '100%',
    fontFamily: 'inherit',
    fontSize: 13,
  };
}
function Input({ value, onChange, placeholder, mono }) {
  return (
    <input
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{ ...inputStyle(), fontFamily: mono ? 'ui-monospace, monospace' : 'inherit', fontSize: mono ? 12.5 : 13 }}
    />
  );
}

function PriceInput({ value, onChange, isBase, basePlaceholder }) {
  const display = value == null ? '' : String(value);
  return (
    <div style={{ position: 'relative' }}>
      <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--t4, var(--t3))', fontFamily: 'ui-monospace, monospace', fontSize: 12, pointerEvents: 'none' }}>£</span>
      <input
        value={display}
        onChange={e => onChange(e.target.value)}
        placeholder={basePlaceholder || (isBase ? '0.00' : '')}
        type="number"
        step="0.01"
        style={{
          ...inputStyle(),
          padding: '7px 10px 7px 22px',
          fontFamily: 'ui-monospace, monospace',
          fontSize: 12.5,
          background: isBase ? 'var(--bg2)' : 'var(--bg1)',
          fontWeight: isBase ? 600 : 400,
          color: isBase ? 'var(--t1)' : 'var(--t2)',
        }}
      />
    </div>
  );
}

function ImageUpload({ current, onUpload, onClear }) {
  const inputId = useMemo(() => 'img-' + Math.random().toString(36).slice(2, 8), []);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {current ? (
        <>
          <img src={current} alt="" style={{ width: 40, height: 40, borderRadius: 6, objectFit: 'cover', border: '1px solid var(--bdr)' }} />
          <button onClick={onClear} style={{ ...btnGhost(), color: 'var(--t3)' }}>Remove</button>
        </>
      ) : (
        <label htmlFor={inputId} style={{ ...btnGhost(), cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          📷 Upload image
        </label>
      )}
      <input
        id={inputId}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) onUpload(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function CategoryPicker({ categories, primary, extras, onChange }) {
  // Order: roots first, then children indented
  const roots = categories.filter(c => !c.parentId).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const childrenOf = (id) => categories.filter(c => c.parentId === id).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const ordered = [];
  roots.forEach(r => {
    ordered.push({ ...r, depth: 0 });
    childrenOf(r.id).forEach(c => ordered.push({ ...c, depth: 1, parentLabel: r.label }));
  });

  const onClick = (id) => {
    if (id === primary) {
      // Demote primary to nothing (and promote first extra)
      if (extras.length) onChange(extras[0], extras.slice(1));
      else onChange(null, []);
      return;
    }
    if (extras.includes(id)) {
      // Already an extra; promote to primary
      const newExtras = extras.filter(x => x !== id);
      const old = primary ? [...newExtras, primary] : newExtras;
      onChange(id, old);
      return;
    }
    // New click
    if (!primary) onChange(id, extras);
    else onChange(primary, [...extras, id]);
  };

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 12, background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 7 }}>
      {ordered.length === 0 && <span style={{ color: 'var(--t3)', fontSize: 12.5 }}>No categories yet. Create some in the Categories tab.</span>}
      {ordered.map(c => {
        const isPrimary = c.id === primary;
        const isExtra = extras.includes(c.id);
        const on = isPrimary || isExtra;
        const tag = isPrimary ? 'PRIMARY' : (c.depth === 1 ? '↳ ' + c.parentLabel : null);
        return (
          <button key={c.id} onClick={() => onClick(c.id)}
            style={{
              padding: '5px 10px',
              fontSize: 12,
              borderRadius: 5,
              background: on ? (isPrimary ? 'rgba(249,115,22,0.08)' : 'var(--bg3)') : 'var(--bg2)',
              border: '1px solid ' + (isPrimary ? 'rgba(249,115,22,0.45)' : (on ? 'var(--bdr2, var(--bdr))' : 'var(--bdr)')),
              color: on ? 'var(--t1)' : 'var(--t2)',
              fontWeight: 500,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: 2, background: c.color || 'var(--t3)' }} />
            <span>{c.label}</span>
            {tag && <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', color: isPrimary ? 'var(--acc)' : 'var(--t4, var(--t3))', padding: isPrimary ? '1px 4px' : 0, background: isPrimary ? 'rgba(249,115,22,0.15)' : 'transparent', borderRadius: 2 }}>{tag}</span>}
          </button>
        );
      })}
    </div>
  );
}

function PillPicker({ options, selected, onToggle, colorClass, empty }) {
  if (!options.length) {
    return <div style={{ padding: 12, background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 7, fontSize: 12, color: 'var(--t3)' }}>{empty || 'Nothing to show.'}</div>;
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 12, background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 7 }}>
      {options.map(o => {
        const on = selected.includes(o.id);
        const styles = colorClass === 'allergen'
          ? { onBg: 'rgba(234,179,8,0.13)', onBd: 'rgba(234,179,8,0.28)', onFg: '#ddc270' }
          : { onBg: 'var(--acc-d, rgba(249,115,22,0.15))', onBd: 'var(--acc-b, rgba(249,115,22,0.45))', onFg: 'var(--acc)' };
        return (
          <button key={o.id} onClick={() => onToggle(o.id)}
            style={{
              padding: '5px 10px',
              fontSize: 12,
              borderRadius: 5,
              background: on ? styles.onBg : 'var(--bg2)',
              border: '1px solid ' + (on ? styles.onBd : 'var(--bdr)'),
              color: on ? styles.onFg : 'var(--t2)',
              fontWeight: 500,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {o.icon && <span style={{ fontSize: 13, lineHeight: 1 }}>{o.icon}</span>}
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ScopeCards({ value, onChange }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
      {SCOPES.map(s => {
        const on = s.id === value;
        return (
          <button key={s.id} onClick={() => onChange(s.id)}
            style={{
              background: on ? 'rgba(249,115,22,0.04)' : 'var(--bg1)',
              border: '1.5px solid ' + (on ? 'var(--acc-b, rgba(249,115,22,0.45))' : 'var(--bdr)'),
              borderRadius: 8,
              padding: 14,
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: 'inherit',
              color: 'inherit',
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: on ? 'var(--acc)' : 'var(--t1)', letterSpacing: '-0.005em', marginBottom: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>{s.label}</span>
              <span style={{
                width: 14, height: 14, borderRadius: '50%',
                border: '1.5px solid ' + (on ? 'var(--acc)' : 'var(--bdr2, var(--bdr))'),
                background: on ? 'var(--acc)' : 'transparent',
                position: 'relative',
              }}>
                {on && <span style={{ position: 'absolute', top: 3, left: 3, width: 5, height: 5, borderRadius: '50%', background: '#fff' }} />}
              </span>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.5 }}>{s.desc}</div>
          </button>
        );
      })}
    </div>
  );
}

function ToggleRow({ on, onToggle, title, desc }) {
  return (
    <button onClick={onToggle}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 12px',
        marginTop: 10,
        background: 'var(--bg1)',
        border: '1px solid var(--bdr)',
        borderRadius: 6,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit',
        color: 'inherit',
        width: '100%',
      }}
    >
      <span style={{ position: 'relative', width: 32, height: 18, background: on ? 'var(--acc)' : 'var(--bg3)', borderRadius: 9, flexShrink: 0, transition: 'background .15s' }}>
        <span style={{ position: 'absolute', top: 2, left: on ? 16 : 2, width: 14, height: 14, background: on ? '#fff' : 'var(--t3)', borderRadius: '50%', transition: 'all .15s' }} />
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--t1)' }}>{title}</span>
        <span style={{ fontSize: 11, color: 'var(--t3)', lineHeight: 1.4 }}>{desc}</span>
      </span>
    </button>
  );
}

function ScopePillBadge({ label, color, bg }) {
  return (
    <span style={{
      padding: '1.5px 6px',
      fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em',
      textTransform: 'uppercase',
      borderRadius: 3,
      fontFamily: 'ui-monospace, monospace',
      background: bg, color,
    }}>{label}</span>
  );
}

function ActionBar({ onArchive, archived, onDiscard, onSave, dirty, saving, savedTick }) {
  // Show "Saved" briefly after savedTick increments
  const [showSaved, setShowSaved] = useState(false);
  useEffect(() => {
    if (savedTick > 0) {
      setShowSaved(true);
      const t = setTimeout(() => setShowSaved(false), 1800);
      return () => clearTimeout(t);
    }
  }, [savedTick]);
  return (
    <div style={{ position: 'sticky', bottom: 0, background: 'var(--bg0)', borderTop: '1px solid var(--bdr)', padding: '12px 36px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, flexShrink: 0 }}>
      <button onClick={onArchive} style={{ ...btnGhost(), color: archived ? 'var(--acc)' : '#ef4444' }}>
        {archived ? 'Restore' : 'Archive'}
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {showSaved && <span style={{ fontSize: 12, color: '#22c55e', fontWeight: 500 }}>✓ Saved</span>}
        {dirty && !showSaved && <span style={{ fontSize: 11.5, color: 'var(--t3)' }}>Unsaved changes</span>}
        <button onClick={onDiscard} disabled={!dirty || saving} style={{ ...btnGhost(), opacity: (!dirty || saving) ? 0.5 : 1 }}>Discard</button>
        <button onClick={onSave} disabled={!dirty || saving} style={{ ...btnPrimary(), opacity: (!dirty || saving) ? 0.5 : 1 }}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}

function btnGhost() {
  return {
    padding: '8px 16px',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    border: '1px solid var(--bdr2, var(--bdr))',
    background: 'transparent',
    color: 'var(--t2)',
    fontFamily: 'inherit',
    cursor: 'pointer',
  };
}
function btnPrimary() {
  return {
    padding: '8px 16px',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    border: '1px solid var(--acc)',
    background: 'var(--acc)',
    color: '#fff',
    fontFamily: 'inherit',
    cursor: 'pointer',
  };
}
