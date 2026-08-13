// src/backoffice/sections/PackageBuilder.jsx
//
// Back Office → Channels → Packages & events. Phase 4 of the Table Bookings
// build (handoff screen 4, redrawn in the BO's own visual language). A package
// is priced, has a payment rule (hold / deposit / prepay), its own availability
// window and — the half that matters — the order lines that land on the POS tab
// when the party is seated, each carrying a course int (0=Immediate … 3) that
// maps to menu_categories.default_course EXACTLY, so the KDS fires in order.
//
// All persistence goes through the store seams from bookingsSlice: upsertPackage
// (mints the id, replaces lines wholesale) and deletePackage. Failure toasts
// come from the slice; this screen only shows saving/saved state.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { money } from '../../lib/currency';

const MONO = 'var(--font-mono, ui-monospace, monospace)';
const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];   // ints 0-6, Sunday first
const UNIT_LABEL = { per_cover: 'per cover', per_booking: 'per booking', minimum_spend: 'min spend' };
const COURSES = [[0, 'Immediate'], [1, 'Course 1'], [2, 'Course 2'], [3, 'Course 3']];

const payLabel = (p) =>
  p.paymentModel === 'hold' ? 'card hold'
  : p.paymentModel === 'prepay' ? 'prepaid in full'
  : `deposit ${money(p.depositPerCover || 0)}/cover`;

const newDraft = (sortOrder) => ({
  name: 'New package', description: '',
  price: 0, priceUnit: 'per_cover',
  paymentModel: 'deposit', depositPerCover: 0,
  turnMinutes: null,
  availableFrom: null, availableTo: null,
  availableDays: [0, 1, 2, 3, 4, 5, 6],
  availableStart: null, availableEnd: null,
  minCovers: 1, maxCovers: null, maxPerService: null,
  sections: [], requiresPreorder: false, preorderDaysBefore: 0, isActive: true,
  sortOrder, lines: [],
});

const newLine = () => ({
  _key: `ln-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  itemId: null, displayName: '', qtyPerCover: 1, course: 0,
  priceOverride: null, isPreorderChoice: false, sortOrder: 0,
});

export default function PackageBuilder() {
  const packages = useStore(s => s.packages);
  const menuItems = useStore(s => s.menuItems);
  const upsertPackage = useStore(s => s.upsertPackage);
  const deletePackage = useStore(s => s.deletePackage);
  const loadBookingsFromDB = useStore(s => s.loadBookingsFromDB);

  const [selId, setSelId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  // Idempotent load so the BO has packages even without a POS boot.
  useEffect(() => { loadBookingsFromDB?.(); }, [loadBookingsFromDB]);

  const items = useMemo(
    () => (menuItems || []).filter(m => !m.archived).sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [menuItems]
  );

  // Auto-select the first package once loaded (never steals an in-flight
  // draft). State adjustment during render — React re-runs immediately with
  // the new state, so this converges in one pass and needs no effect.
  if (!selId && !draft && packages?.length) {
    setSelId(packages[0].id);
    setDraft(JSON.parse(JSON.stringify(packages[0])));
  }

  const selected = (packages || []).find(p => p.id === selId) || null;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(selected);

  const guardDirty = () => !dirty || window.confirm('Discard unsaved changes to this package?');
  const selectPkg = (id) => {
    if (id === selId) return;
    if (!guardDirty()) return;
    const p = (packages || []).find(x => x.id === id);
    setSelId(id);
    setDraft(p ? JSON.parse(JSON.stringify(p)) : null);
  };
  const startNew = () => {
    if (!guardDirty()) return;
    setSelId(null);
    setDraft(newDraft((packages || []).length));
  };

  const upd = (patch) => setDraft(d => ({ ...d, ...patch }));
  const updLine = (i, patch) => setDraft(d => ({ ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const removeLine = (i) => setDraft(d => ({ ...d, lines: d.lines.filter((_, j) => j !== i) }));
  const moveLine = (i, dir) => setDraft(d => {
    const to = i + dir;
    if (to < 0 || to >= d.lines.length) return d;
    const a = [...d.lines]; const [m] = a.splice(i, 1); a.splice(to, 0, m);
    return { ...d, lines: a };
  });
  const addLine = () => setDraft(d => ({ ...d, lines: [...(d.lines || []), newLine()] }));
  const pickItem = (i, mi) => setDraft(d => ({
    ...d,
    lines: d.lines.map((l, j) => {
      if (j !== i) return l;
      const prev = l.itemId ? items.find(x => x.id === l.itemId) : null;
      const keepName = l.displayName && l.displayName !== (prev?.name || '');
      return { ...l, itemId: mi ? mi.id : null, displayName: mi && !keepName ? mi.name : l.displayName };
    }),
  }));

  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    // sortOrder = visual order; the slice replaces lines wholesale on save.
    const res = await upsertPackage({ ...draft, lines: (draft.lines || []).map((l, i) => ({ ...l, sortOrder: i })) });
    setBusy(false);
    if (res?.package?.id) {
      setSelId(res.package.id);
      setDraft(d => (d ? { ...d, id: res.package.id } : d));
    }
    if (res?.ok) { setSaved(true); setTimeout(() => setSaved(false), 1800); }
    // On failure the slice already raised the error toast.
  };

  const del = async () => {
    if (!draft) return;
    if (!draft.id) { setDraft(null); setSelId(null); return; }
    if (!window.confirm(`Delete “${draft.name}”? The booking widget and host stand will stop offering it.`)) return;
    await deletePackage(draft.id);
    setDraft(null); setSelId(null);
  };

  const hasAny = (packages || []).length > 0 || !!draft;

  return (
    <div style={{ maxWidth: 1400 }}>
      <Head title="Packages & events"
        sub="Sold through the booking widget and the host stand. Each package carries its own price and payment rule, its own availability, and the order lines that land on the POS when the party is seated." />

      <div style={{ display: 'flex', gap: 18, marginTop: 14, alignItems: 'flex-start' }}>
        {/* ── list ── */}
        <div style={{ width: 400, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(packages || []).map(p => (
            <button key={p.id} onClick={() => selectPkg(p.id)} style={p.id === selId ? S.cardOn : S.card}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--t1)' }}>{p.name}</span>
                {!p.isActive && <span style={S.offTag}>Inactive</span>}
                <span style={{ marginLeft: 'auto', fontSize: 15, fontWeight: 800, fontFamily: MONO, color: 'var(--grn)' }}>{money(p.price)}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 3 }}>
                {UNIT_LABEL[p.priceUnit] || p.priceUnit} · {payLabel(p)}
              </div>
            </button>
          ))}
          {draft && !draft.id && (
            <div style={{ ...S.cardOn, cursor: 'default' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--t1)' }}>{draft.name}</span>
                <span style={{ ...S.offTag, color: 'var(--acc)', borderColor: 'var(--acc-b, var(--acc))' }}>Unsaved</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 3 }}>{UNIT_LABEL[draft.priceUnit]} · {payLabel(draft)}</div>
            </div>
          )}
          <button style={S.addCard} onClick={startNew}>+ New package</button>
        </div>

        {/* ── detail ── */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {!hasAny ? (
            <div style={S.empty}>No packages yet — create your first.</div>
          ) : !draft ? (
            <div style={S.empty}>Select a package to edit it.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* name + description — one header row: name left, description grows right */}
              <div style={{ ...S.section, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <input style={{ ...S.inp, flex: '0 1 240px', minWidth: 160, fontSize: 19, fontWeight: 800, background: 'transparent', border: 'none', padding: 0, borderRadius: 0 }}
                  value={draft.name} onChange={e => upd({ name: e.target.value })} placeholder="Package name" />
                <input style={{ ...S.inp, flex: '1 1 300px', minWidth: 0, textOverflow: 'ellipsis' }} value={draft.description || ''}
                  onChange={e => upd({ description: e.target.value })}
                  placeholder="Description — shown on the booking widget" />
              </div>

              {/* the four metric cards */}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'stretch' }}>
                <Metric label="Price" flex="1 1 210px">
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input type="number" min="0" step="0.5" style={{ ...S.inp, flex: '1 1 96px', minWidth: 0, fontFamily: MONO, fontWeight: 700 }}
                      value={draft.price ?? 0} onChange={e => upd({ price: e.target.value === '' ? 0 : Number(e.target.value) })} />
                    <select style={{ ...S.inp, flex: '1.2 1 120px', minWidth: 0, paddingRight: 26 }} value={draft.priceUnit}
                      onChange={e => upd({ priceUnit: e.target.value })}>
                      <option value="per_cover">Per cover</option>
                      <option value="per_booking">Per booking</option>
                      <option value="minimum_spend">Minimum spend</option>
                    </select>
                  </div>
                </Metric>

                <Metric label="Payment rule" flex="1 1 220px">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <select style={{ ...S.inp, width: '100%', minWidth: 0, paddingRight: 26 }}
                      value={draft.paymentModel} onChange={e => upd({ paymentModel: e.target.value })}>
                      <option value="hold">Card hold — charged only on no-show</option>
                      <option value="deposit">Deposit — part paid up front</option>
                      <option value="prepay">Prepay — paid in full at booking</option>
                    </select>
                    {draft.paymentModel === 'deposit' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input type="number" min="0" step="0.5" style={{ ...S.inp, width: 90, fontFamily: MONO }}
                          value={draft.depositPerCover ?? 0}
                          onChange={e => upd({ depositPerCover: e.target.value === '' ? 0 : Number(e.target.value) })} />
                        <span style={{ fontSize: 11, color: 'var(--t3)' }}>deposit per cover</span>
                      </div>
                    )}
                  </div>
                </Metric>

                <Metric label="Availability" flex="2 1 320px">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 8, alignItems: 'center' }}>
                      <input type="date" style={{ ...S.inp, width: '100%', minWidth: 0 }} value={draft.availableFrom || ''}
                        onChange={e => upd({ availableFrom: e.target.value || null })} title="Available from" />
                      <span style={{ fontSize: 11, color: 'var(--t4)' }}>→</span>
                      <input type="date" style={{ ...S.inp, width: '100%', minWidth: 0 }} value={draft.availableTo || ''}
                        onChange={e => upd({ availableTo: e.target.value || null })} title="Available until (blank = no end)" />
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {DAYS.map((d, i) => {
                        const on = (draft.availableDays || []).includes(i);
                        return (
                          <button key={d} onClick={() => upd({
                            availableDays: on ? draft.availableDays.filter(x => x !== i) : [...(draft.availableDays || []), i].sort(),
                          })} style={on ? S.dayOn : S.day} title={on ? `Offered on ${d}` : `Not offered on ${d}`}>{d}</button>
                        );
                      })}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 8, alignItems: 'center' }}>
                      <input type="time" style={{ ...S.inp, width: '100%', minWidth: 0 }} value={draft.availableStart || ''}
                        onChange={e => upd({ availableStart: e.target.value || null })} title="From this time (blank = all service)" />
                      <span style={{ fontSize: 11, color: 'var(--t4)' }}>–</span>
                      <input type="time" style={{ ...S.inp, width: '100%', minWidth: 0 }} value={draft.availableEnd || ''}
                        onChange={e => upd({ availableEnd: e.target.value || null })} title="Until this time" />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="number" min="0" style={{ ...S.inp, width: 72, minWidth: 64, fontFamily: MONO }}
                        value={draft.maxPerService ?? ''} placeholder="∞"
                        onChange={e => upd({ maxPerService: e.target.value === '' ? null : Number(e.target.value) })} />
                      <span style={{ fontSize: 11, color: 'var(--t3)' }}>cap / service</span>
                    </div>
                  </div>
                </Metric>

                <Metric label="Turn" flex="1 1 150px" caption="overrides the default turn time">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button style={S.step} onClick={() => upd({
                      turnMinutes: draft.turnMinutes == null ? null : draft.turnMinutes <= 30 ? null : draft.turnMinutes - 15,
                    })}>−</button>
                    <div style={{ flex: 1, textAlign: 'center', fontSize: draft.turnMinutes ? 17 : 12, fontWeight: 800, fontFamily: draft.turnMinutes ? MONO : 'inherit', color: draft.turnMinutes ? 'var(--t1)' : 'var(--t4)' }}>
                      {draft.turnMinutes ? `${draft.turnMinutes}m` : 'Inherit'}
                    </div>
                    <button style={S.step} onClick={() => upd({
                      turnMinutes: draft.turnMinutes == null ? 90 : draft.turnMinutes + 15,
                    })}>+</button>
                  </div>
                </Metric>
              </div>

              {/* covers + flags */}
              <div style={{ ...S.section, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={S.lbl}>Covers</span>
                  <input type="number" min="1" style={{ ...S.inp, width: 64, fontFamily: MONO }} value={draft.minCovers ?? 1}
                    onChange={e => upd({ minCovers: e.target.value === '' ? 1 : Number(e.target.value) })} title="Minimum covers" />
                  <span style={{ fontSize: 11, color: 'var(--t4)' }}>to</span>
                  <input type="number" min="1" style={{ ...S.inp, width: 64, fontFamily: MONO }} value={draft.maxCovers ?? ''}
                    placeholder="∞" onChange={e => upd({ maxCovers: e.target.value === '' ? null : Number(e.target.value) })} title="Maximum covers (blank = no cap)" />
                </span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--t2)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!draft.requiresPreorder} onChange={e => upd({ requiresPreorder: e.target.checked })} />
                  Requires pre-order — one choice per course, per guest
                </label>
                {draft.requiresPreorder && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--t2)' }}>
                    due
                    <input type="number" min="0" max="60" style={{ ...S.inp, width: 58, fontFamily: MONO }}
                      value={draft.preorderDaysBefore ?? 0}
                      onChange={e => upd({ preorderDaysBefore: Math.max(0, Math.min(60, Number(e.target.value) || 0)) })}
                      title="How many days before the visit choices must be in. 0 = at booking. Booked earlier than this, guests get an email + SMS link to choose." />
                    days before — else guests are emailed + texted a link
                  </span>
                )}
                <button style={{ ...(draft.isActive ? S.pillOn : S.pill), marginLeft: 'auto' }}
                  onClick={() => upd({ isActive: !draft.isActive })}>
                  {draft.isActive ? '✓ Active' : 'Inactive — hidden from sale'}
                </button>
              </div>

              {/* what lands on the POS */}
              <div style={S.section}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--t2)' }}>What lands on the POS</div>
                  <div style={{ fontSize: 11, color: 'var(--t4)' }}>
                    {(draft.lines || []).length} line{(draft.lines || []).length === 1 ? '' : 's'} · pre-loaded on the tab when the party is seated, course-fired like the catering flow
                  </div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 4 }}>
                  Price override: leave blank to inherit the item's price; 0 = included in the package price.
                </div>

                <div style={{ marginTop: 10, border: '1px solid var(--bdr)', borderRadius: 10, overflow: 'visible', background: 'var(--bg2)' }}>
                  {(draft.lines || []).length === 0 && (
                    <div style={{ padding: '18px 14px', fontSize: 12, color: 'var(--t4)' }}>No lines yet — add what the kitchen should see.</div>
                  )}
                  {(draft.lines || []).map((l, i) => {
                    const linked = l.itemId ? items.find(m => m.id === l.itemId) : null;
                    return (
                      <div key={l.id || l._key || i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: i === (draft.lines.length - 1) ? 'none' : '1px solid var(--bdr)', flexWrap: 'wrap' }}>
                        <span style={{ width: 22, fontSize: 11, fontFamily: MONO, color: 'var(--t4)', flexShrink: 0 }}>{String(i + 1).padStart(2, '0')}</span>
                        <ItemPicker linked={linked} hasId={!!l.itemId} items={items} onPick={(mi) => pickItem(i, mi)} />
                        <input style={{ ...S.inp, flex: '1 1 160px', minWidth: 120 }} value={l.displayName || ''}
                          onChange={e => updLine(i, { displayName: e.target.value })} placeholder="Display name on the ticket" />
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                          <input type="number" min="0" step="0.5" style={{ ...S.inp, width: 56, fontFamily: MONO }} value={l.qtyPerCover ?? 1}
                            onChange={e => updLine(i, { qtyPerCover: e.target.value === '' ? 1 : Number(e.target.value) })} title="Quantity per cover" />
                          <span style={{ fontSize: 10, color: 'var(--t4)' }}>/cover</span>
                        </span>
                        <span style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                          {COURSES.map(([v, lab]) => (
                            <button key={v} style={(l.course ?? 0) === v ? S.coursePillOn : S.coursePill}
                              onClick={() => updLine(i, { course: v })}>{lab}</button>
                          ))}
                        </span>
                        <input type="number" min="0" step="0.5" style={{ ...S.inp, width: 92, fontFamily: MONO }}
                          value={l.priceOverride == null ? '' : l.priceOverride}
                          placeholder={linked ? money(linked.price) : 'inherit'}
                          onChange={e => updLine(i, { priceOverride: e.target.value === '' ? null : Number(e.target.value) })}
                          title="Price override — blank inherits the item's price, 0 = included in the package price" />
                        <span style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                          <button style={S.mini} onClick={() => moveLine(i, -1)} disabled={i === 0} title="Move up">↑</button>
                          <button style={S.mini} onClick={() => moveLine(i, +1)} disabled={i === draft.lines.length - 1} title="Move down">↓</button>
                          <button style={S.miniX} onClick={() => removeLine(i)} title="Remove line">×</button>
                        </span>
                      </div>
                    );
                  })}
                </div>
                <button style={{ ...S.btn, marginTop: 10 }} onClick={addLine}>+ Add line</button>
              </div>

              {/* footnotes */}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ ...S.note, background: 'var(--grn-d)', borderColor: 'var(--grn-b)' }}>
                  <div style={{ ...S.noteTitle, color: 'var(--grn)' }}>Money</div>
                  <div style={S.noteBody}>Prepay and deposits post to the check as a tender line, so the closing balance is the difference, not the full amount. Refunds follow the same route back.</div>
                </div>
                <div style={{ ...S.note, background: 'var(--blu-d)', borderColor: 'var(--blu-b)' }}>
                  <div style={{ ...S.noteTitle, color: 'var(--blu)' }}>Kitchen</div>
                  <div style={S.noteBody}>Lines carry their course so the KDS fires them in order. Pre-orders taken at booking arrive on the ticket with the guest's name against each seat.</div>
                </div>
              </div>

              {/* save bar */}
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button style={S.btnPrimary} onClick={save} disabled={busy}>
                  {busy ? 'Saving…' : saved ? '✓ Saved' : 'Save package'}
                </button>
                {dirty && !busy && <span style={{ fontSize: 11.5, color: 'var(--acc)' }}>Unsaved changes</span>}
                <button style={{ ...S.btnGhost, marginLeft: 'auto', color: 'var(--red)' }} onClick={del}>
                  {draft.id ? 'Delete' : 'Discard'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Searchable select over the menu. Picking an item links itemId + defaults the
// ticket display name; "No linked item" keeps a free-text line (e.g. "Arrival
// fizz") that the kitchen still sees.
function ItemPicker({ linked, hasId, items, onPick }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const boxRef = useRef(null);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (s ? items.filter(m => (m.name || '').toLowerCase().includes(s)) : items).slice(0, 40);
  }, [items, q]);
  return (
    <div ref={boxRef} style={{ position: 'relative', width: 190, flexShrink: 0 }}
      onBlur={(e) => { if (!boxRef.current?.contains(e.relatedTarget)) { setOpen(false); setQ(''); } }}>
      <button type="button" onClick={() => setOpen(o => !o)}
        style={{ ...S.inp, width: '100%', textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: linked ? 'var(--t1)' : 'var(--t4)' }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {linked ? linked.name : hasId ? 'Unknown item' : 'Link a menu item…'}
        </span>
        {linked && <span style={{ fontSize: 11, fontFamily: MONO, color: 'var(--grn)', flexShrink: 0 }}>{money(linked.price)}</span>}
      </button>
      {open && (
        <div style={S.dropdown}>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search the menu…"
            style={{ ...S.inp, width: '100%', borderRadius: 6, marginBottom: 4 }} />
          <button type="button" style={S.dropOpt}
            onMouseDown={(e) => { e.preventDefault(); onPick(null); setOpen(false); setQ(''); }}>
            <span style={{ color: 'var(--t4)' }}>— No linked item —</span>
          </button>
          {results.map(m => (
            <button key={m.id} type="button" style={S.dropOpt}
              onMouseDown={(e) => { e.preventDefault(); onPick(m); setOpen(false); setQ(''); }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
              <span style={{ fontSize: 11, fontFamily: MONO, color: 'var(--t4)', flexShrink: 0 }}>{money(m.price)}</span>
            </button>
          ))}
          {results.length === 0 && <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--t4)' }}>No matches.</div>}
        </div>
      )}
    </div>
  );
}

const Head = ({ title, sub }) => (
  <div style={{ marginBottom: 4 }}>
    <div style={{ fontSize: 11, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 700 }}>Channels</div>
    <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--t1)', marginTop: 2 }}>{title}</div>
    <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4, maxWidth: 720, lineHeight: 1.5 }}>{sub}</div>
  </div>
);

const Metric = ({ label, caption, flex, children }) => (
  <div style={{ ...S.section, flex, minWidth: 0 }}>
    <div style={S.lbl}>{label}</div>
    <div style={{ marginTop: 8 }}>{children}</div>
    {caption && <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 6 }}>{caption}</div>}
  </div>
);

const S = {
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14, background: 'var(--bg1)', border: '1px dashed var(--bdr2)', borderRadius: 12 },
  section: { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 14 },
  card: { textAlign: 'left', width: '100%', background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '12px 14px', cursor: 'pointer', fontFamily: 'inherit' },
  cardOn: { textAlign: 'left', width: '100%', background: 'var(--acc-d)', border: '1px solid var(--acc)', borderRadius: 12, padding: '12px 14px', cursor: 'pointer', fontFamily: 'inherit' },
  addCard: { width: '100%', minHeight: 44, background: 'transparent', border: '1px dashed var(--bdr2)', borderRadius: 12, color: 'var(--acc)', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  offTag: { fontSize: 10, fontWeight: 700, color: 'var(--t4)', border: '1px solid var(--bdr2)', borderRadius: 6, padding: '1px 6px' },
  lbl: { fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.04em' },
  inp: { boxSizing: 'border-box', height: 38, border: '1px solid var(--bdr2)', borderRadius: 8, padding: '7px 9px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' },
  day: { width: 30, height: 28, borderRadius: 7, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t4)', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', padding: 0 },
  dayOn: { width: 30, height: 28, borderRadius: 7, border: '1px solid var(--acc)', background: 'var(--acc-d)', color: 'var(--acc)', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', padding: 0 },
  step: { width: 30, height: 30, borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 16, cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1, padding: 0 },
  coursePill: { fontSize: 11, padding: '4px 8px', borderRadius: 7, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t3)', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  coursePillOn: { fontSize: 11, padding: '4px 8px', borderRadius: 7, border: '1px solid var(--blu-b)', background: 'var(--blu-d)', color: 'var(--blu)', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700, whiteSpace: 'nowrap' },
  pill: { fontSize: 12.5, padding: '6px 11px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t2)', cursor: 'pointer', fontFamily: 'inherit' },
  pillOn: { fontSize: 12.5, padding: '6px 11px', borderRadius: 8, border: '1px solid var(--grn-b)', background: 'var(--grn-d)', color: 'var(--grn)', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700 },
  mini: { width: 26, height: 26, borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--bg2)', color: 'var(--t2)', cursor: 'pointer', fontFamily: 'inherit', padding: 0 },
  miniX: { width: 26, height: 26, borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--bg2)', color: 'var(--red)', cursor: 'pointer', fontFamily: 'inherit', padding: 0 },
  btn: { boxSizing: 'border-box', minHeight: 38, padding: '8px 14px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  btnGhost: { boxSizing: 'border-box', minHeight: 38, padding: '8px 14px', borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--t3)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  btnPrimary: { boxSizing: 'border-box', minHeight: 44, padding: '8px 18px', borderRadius: 8, border: 'none', background: 'var(--acc)', color: '#0b0c10', fontSize: 13, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' },
  note: { flex: '1 1 260px', padding: '12px 14px', borderRadius: 12, border: '1px solid' },
  noteTitle: { fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em' },
  noteBody: { fontSize: 11.5, color: 'var(--t2)', lineHeight: 1.55, marginTop: 5 },
  dropdown: { position: 'absolute', top: 'calc(100% + 4px)', left: 0, width: 280, maxHeight: 260, overflowY: 'auto', background: 'var(--bg2)', border: '1px solid var(--bdr2)', borderRadius: 10, padding: 6, zIndex: 50, boxShadow: '0 8px 26px rgba(0,0,0,.35)' },
  dropOpt: { boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 9px', borderRadius: 7, border: 'none', background: 'transparent', color: 'var(--t1)', fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit' },
};
