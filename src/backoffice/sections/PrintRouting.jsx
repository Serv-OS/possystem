import { useState, useEffect, useMemo, useRef } from 'react';
import { useStore } from '../../store';
import { isMock, supabase, getLocationId } from '../../lib/supabase';
import { reportSave } from '../../lib/saveHealth';
import { mergeById, mergeKeys } from '../../lib/threeWayMerge';
import PrintAgentKeys from './PrintAgentKeys';
import { money } from '../../lib/currency';
import { ORDER_TYPES } from '../../lib/orderScreen/orderScreenStatus';
import {
  normaliseCentreOrderTypes, describeCentreOrderTypes, orderTypeLabelOf,
  nextCentreOrderTypes, fallbackOrderTypesForCentre, joinList,
  buildCatParentMap, nextCentreCategories,
} from '../../lib/productionRouting';
import {
  buildRoutingScreen, categoryLabel, categoryRowNote, clickCategory, clickItem,
  countOf, flattenNodes, liveTickCount, noticeHolds, nowhereNotice,
} from '../../lib/routingScreenModel';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const uid = () => `pc-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;

const CENTRE_ICONS = ['🔥','❄️','🍕','🍸','📋','🥗','🍔','🍣','🫕','🧁','🍳','🥩'];
const CENTRE_TYPES = [
  { id:'kitchen', label:'Kitchen' },
  { id:'bar',     label:'Bar' },
  { id:'expo',    label:'Expo / Pass' },
  { id:'cold',    label:'Cold section' },
];
const PRINTER_MODELS = ['Sunmi NT311','Epson TM-T88','Star TSP100','Generic ESC/POS'];

const load = () => {
  try { return JSON.parse(localStorage.getItem('rpos-print-routing') || 'null') || { centres:[], routing:{} }; }
  catch { return { centres:[], routing:{} }; }
};
const save = (data) => localStorage.setItem('rpos-print-routing', JSON.stringify(data)); // local cache for POS

async function loadRoutingFromDB() {
  if (isMock || !supabase) return load();
  try {
    const locationId = await getLocationId();
    if (!locationId) return load();
    const { data } = await supabase.from('print_routing').select('*').eq('location_id', locationId).single();
    if (data) {
      const config = { centres: data.centres || [], routing: data.routing || {} };
      localStorage.setItem('rpos-print-routing', JSON.stringify(config));
      return config;
    }
  } catch(e) { /* no row yet */ }
  return load();
}

// Returns { error, saved }: the caller reverts the screen (and this localStorage mirror, which
// the POS reads at print time) when the row never landed. A swallowed failure here routed
// tickets by a rule set that only ever existed on one browser.
// 27 Sep 2026 (Peter: "I archived choc babychino but its still on the menu board", the same
// stale window class): the whole centres list and routing map were written from this screen's
// copy, so a screen left open put back centres and rules changed in another window since. The
// row is read again now and only what THIS screen changed since its last save (`previous`) is
// laid over it: centres merged by id, routing by centre id (lib/threeWayMerge.js). `saved` is
// what the database now holds, and the screen shows it. A failed read writes nothing.
async function saveRoutingToDB(data, previous) {
  const mirror = (cfg) => { if (cfg) { try { save(cfg); } catch {} } };
  mirror(data); // update local cache immediately — printing must feel instant
  if (isMock || !supabase) return { error: null, saved: data };
  const rollback = (err) => { mirror(previous); return { error: err }; };
  const locationId = await getLocationId().catch(() => null);
  if (!locationId) return rollback(new Error('Could not resolve the location for this venue'));
  const { data: cur, error: readErr } = await supabase.from('print_routing').select('centres,routing').eq('location_id', locationId).maybeSingle();
  if (readErr) return rollback(readErr);
  const base = previous || { centres: [], routing: {} };
  const merged = {
    centres: mergeById(base.centres || [], data.centres || [], cur?.centres || []),
    routing: mergeKeys(base.routing || {}, data.routing || {}, cur?.routing || {}),
  };
  const { data: rows, error } = await supabase
    .from('print_routing')
    .upsert({ location_id:locationId, centres:merged.centres, routing:merged.routing, updated_at:new Date().toISOString() }, { onConflict:'location_id' })
    .select('location_id');
  if (error) return rollback(error);
  if (!rows || rows.length === 0) return rollback(new Error('Print routing write matched 0 rows — RLS blocked it'));
  mirror(merged);
  return { error: null, saved: merged };
}

// v5.5.835: VENUE DEFAULT RECEIPT PRINTER.
// Receipts now route to the printer set on the originating DEVICE (Back office →
// Devices), with no venue-wide fallback — that fallback is exactly what made an
// unconfigured MPOS print to the counter. But receipts from online / delivery /
// HubRise orders have no originating device: they belong to the venue. This setting
// is where those go. Still an explicit operator choice — unset means they don't print.
//
// Persisted on the OPS locations.pos_settings jsonb (same key space as
// printers.location_id and print_routing.location_id — no cross-DB join needed), and
// mirrored to localStorage so printer.js can resolve it synchronously at print time.
const VENUE_PRINTER_KEY = 'rpos-venue-receipt-printer';

async function loadVenueReceiptPrinter() {
  if (isMock || !supabase) { try { return localStorage.getItem(VENUE_PRINTER_KEY) || ''; } catch { return ''; } }
  try {
    const locationId = await getLocationId();
    if (!locationId) return '';
    const { data } = await supabase.from('locations').select('pos_settings').eq('id', locationId).maybeSingle();
    const id = data?.pos_settings?.default_receipt_printer_id || '';
    try { id ? localStorage.setItem(VENUE_PRINTER_KEY, id) : localStorage.removeItem(VENUE_PRINTER_KEY); } catch {}
    return id;
  } catch (e) { console.warn('venue receipt printer load failed', e); return ''; }
}

async function saveVenueReceiptPrinter(printerId, previousId) {
  const mirror = (id) => { try { id ? localStorage.setItem(VENUE_PRINTER_KEY, id) : localStorage.removeItem(VENUE_PRINTER_KEY); } catch {} };
  // Mirror locally first so the setting is live on this browser immediately.
  mirror(printerId);
  if (isMock || !supabase) return { error: null };
  const rollback = (err) => { mirror(previousId); return { error: err }; };
  const locationId = await getLocationId().catch(() => null);
  if (!locationId) return rollback(new Error('Could not resolve the location for this venue'));
  // Read-modify-merge so we never clobber other pos_settings keys (the pattern
  // LocationSettings.jsx uses for takeaway_customer_details). The READ must be checked
  // too — merging onto {} after a failed read would wipe every other pos_settings key.
  const { data, error: readErr } = await supabase.from('locations').select('pos_settings').eq('id', locationId).maybeSingle();
  if (readErr) return rollback(readErr);
  const { data: rows, error } = await supabase.from('locations').update({
    pos_settings: { ...(data?.pos_settings || {}), default_receipt_printer_id: printerId || null },
  }).eq('id', locationId).select('id');
  if (error) return rollback(error);
  if (!rows || rows.length === 0) return rollback(new Error('Location update matched 0 rows — RLS blocked it'));
  return { error: null };
}

// Default routing entry for a centre.
// orderTypes: [] means ALL order types, which is what every existing centre keeps.
// That is the OPPOSITE of `orderTypes` in lib/orderScreen/orderScreenStatus.js, where an
// empty list matches nothing. See the note at the top of lib/productionRouting.js.
const emptyRouting = () => ({ assignedCategories:[], excludedItems:[], orderTypes:[] });

const S = {
  page: { display:'flex', height:'100%', overflow:'hidden' },
  left: { width:280, flexShrink:0, borderRight:'1px solid var(--bdr)', display:'flex', flexDirection:'column', overflow:'hidden' },
  right: { flex:1, overflowY:'auto', padding:28 },
  h2: { fontSize:13, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.08em', padding:'16px 14px 8px' },
  centreRow: (active) => ({
    padding:'10px 14px', cursor:'pointer', display:'flex', alignItems:'center', gap:10,
    background: active ? 'var(--acc-d)' : 'transparent',
    borderLeft: active ? '3px solid var(--acc)' : '3px solid transparent',
    transition:'all .12s',
  }),
  btn: { padding:'8px 16px', borderRadius:8, border:'none', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:'inherit' },
  btnPrimary: { background:'var(--acc)', color:'#fff' },
  btnGhost: { background:'var(--bg3)', color:'var(--t2)', border:'1px solid var(--bdr)' },
  btnDanger: { background:'#fef2f2', color:'#dc2626', border:'1px solid #fecaca' },
  input: { width:'100%', padding:'8px 11px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box' },
  label: { fontSize:12, fontWeight:600, color:'var(--t3)', marginBottom:4, display:'block' },
  card: { background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:20, marginBottom:16 },
  cardTitle: { fontSize:16, fontWeight:700, color:'var(--t1)', marginBottom:14 },
  row: { display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 },
};

// ─── Order type routing ───────────────────────────────────────────────────────
// The house Back Office kit (15px or more, a real 18px checkbox), copied from
// OrderScreens.jsx so this card matches the screens already signed off. Deliberately NOT
// the 11px to 14px `S` scale the rest of this older file uses.
const OT = {
  card: { background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:20, marginBottom:16 },
  // 16px to match S.cardTitle, so Category routing and Order types read as a matched pair
  // rather than the newer card looking like the more important one.
  title: { fontSize:16, fontWeight:800, color:'var(--t1)', margin:'0 0 4px' },
  help: { fontSize:15, color:'var(--t3)', lineHeight:1.5, margin:'6px 0 0', maxWidth:760 },
  checkWrap: { display:'flex', flexWrap:'wrap', gap:'6px 18px', margin:'12px 0' },
  check: { display:'inline-flex', alignItems:'center', gap:8, fontSize:15, color:'var(--t1)', cursor:'pointer', minHeight:32 },
  checkbox: { width:18, height:18, accentColor:'var(--acc)', cursor:'pointer', margin:0 },
  status: { fontSize:15, fontWeight:700, color:'var(--t1)', marginTop:12 },
  warn: { marginTop:12, fontSize:15, color:'var(--t1)', background:'var(--acc-d)', border:'1px solid var(--acc-b)', borderRadius:8, padding:'8px 12px', lineHeight:1.5 },
};

const Check = ({ checked, onChange, label, disabled }) => (
  <label style={{ ...OT.check, cursor: disabled ? 'default' : 'pointer' }}>
    <input type="checkbox" checked={!!checked} disabled={!!disabled}
      onChange={e => onChange(e.target.checked)}
      style={{ ...OT.checkbox, cursor: disabled ? 'default' : 'pointer' }} />
    <span>{label}</span>
  </label>
);

// A centre serves the categories ticked AND the order types ticked. All order types is the
// default: it is what every existing centre keeps until someone changes it here.
// Wording note: every sentence on screen says "center" and "order", matching the rest of
// this page, and never "centre" or "food". A centre can be a Bar, a Cold section or an
// Expo / pass, none of which make food.
function OrderTypeRouter({ centreId, centreName, routing, setRouting, centres, catParents }) {
  const r = routing[centreId] || emptyRouting();
  const list = normaliseCentreOrderTypes(r.orderTypes);
  const takesAll = list.length === 0;
  // Order types alone route nothing: the category stage runs first and a centre with no
  // categories ticked receives nothing at all. Saying "Kitchen takes Takeaway" on such a
  // centre would be the exact opposite of the truth.
  const hasCats = (r.assignedCategories || []).length > 0;

  // Rides the same debounced save effect, and the same revert, as the category ticks.
  // Same value in means the same object back, so a no-op click never triggers a save.
  const write = (next) => setRouting(prev => {
    const clean = normaliseCentreOrderTypes(next);
    const cur = prev[centreId] || emptyRouting();
    const before = normaliseCentreOrderTypes(cur.orderTypes);
    if (before.length === clean.length && before.every((k, i) => k === clean[i])) return prev;
    return { ...prev, [centreId]: { ...cur, orderTypes: clean } };
  });

  // nextCentreOrderTypes owns the All behaviour and is covered by node:test.
  const toggleType = (key, on) => write(nextCentreOrderTypes(list, key, on));

  // Asked per category, not per venue: a takeaway pizza whose only centre is Eat in only
  // is the case that bites, and a venue wide check hides it the moment any other centre
  // takes Takeaway.
  const gaps = fallbackOrderTypesForCentre(centreId, centres, routing, catParents);

  return (
    <div style={OT.card}>
      <h2 style={OT.title}>🍽 Order types</h2>
      <p style={OT.help}>An item needs a <strong>ticked category</strong> and a <strong>ticked order type</strong> to reach this center.</p>
      <div style={OT.checkWrap}>
        {/* Disabled while it is on: a centre can never be saved serving nothing, so
            unticking All is meaningless. Narrowing happens by ticking one of the types. */}
        <Check checked={takesAll} disabled={takesAll} onChange={() => write([])} label="All order types" />
        {ORDER_TYPES.map(t => (
          <Check
            key={t.key}
            checked={!takesAll && list.includes(t.key)}
            onChange={(on) => toggleType(t.key, on)}
            label={t.label}
          />
        ))}
      </div>
      {!hasCats && (
        <div style={OT.warn}>
          No categories are ticked above, so nothing reaches this center yet. Tick a category first.
        </div>
      )}
      {hasCats && (
        <div style={OT.status}>
          {takesAll
            ? 'This center takes every order type. Ticking every type is the same as All order types.'
            : `${centreName} takes ${joinList(list.map(orderTypeLabelOf))}.`}
        </div>
      )}
      {hasCats && gaps.length > 0 && (
        <div style={OT.warn}>
          No center takes {joinList(gaps.map(orderTypeLabelOf))} for some of the categories ticked above.
          {' '}Those orders go to every center that matches the category, so nothing is lost.
        </div>
      )}
      {/* Only while it can bite, and never alongside the warning above, which says it
          already in the specific. A centre on All order types cannot reach the fallback. */}
      {!takesAll && gaps.length === 0 && (
        <p style={OT.help}>If no center takes an order type, the order still goes to every center that matches the category.</p>
      )}
      <p style={OT.help}>Tills use this after you press <strong>Push to POS</strong>. Kiosk and online orders use it straight away.</p>
    </div>
  );
}

// ─── Category/Item routing picker ─────────────────────────────────────────────
// 30 Sep 2026 (Peter at Coffee Boy): the whole category tree with a box on every sub
// category, and sizes grouped under their product ("Matcha, Small Boy"). Every box is
// built by lib/routingScreenModel.js on the SAME rule the tills and channel orders route
// with (lib/productionRouting.js), so a ticked box means it really reaches this centre.
// Every write goes through setRouting(prev => ...), never a copy from this render, so two
// quick clicks can never undo each other.
const CR = {
  help: { fontSize:15, color:'var(--t3)', lineHeight:1.5, margin:'0 0 14px', paddingLeft:20, maxWidth:760 },
  row: (on) => ({
    display:'flex', alignItems:'center', gap:10, padding:'8px 12px', minHeight:44, boxSizing:'border-box',
    background: on ? 'var(--acc-d)' : 'var(--bg3)',
    border:`1.5px solid ${on ? 'var(--acc-b)' : 'var(--bdr)'}`, borderRadius:10,
  }),
  name: (on) => ({ fontSize:15, fontWeight:700, color: on ? 'var(--acc)' : 'var(--t1)', cursor:'pointer', overflowWrap:'anywhere' }),
  note: { fontSize:15, color:'var(--t3)' },
  pill: { fontSize:13, padding:'2px 8px', borderRadius:20, background:'var(--red)', color:'#fff', fontWeight:700, whiteSpace:'nowrap' },
  chevron: { background:'none', border:'none', cursor:'pointer', color:'var(--acc)', fontSize:15, padding:'4px 8px', fontFamily:'inherit', flexShrink:0 },
  body: { margin:'6px 0 0 22px', display:'flex', flexDirection:'column', gap:6 },
  items: { border:'1px solid var(--bdr)', borderRadius:10, overflow:'hidden', background:'var(--bg)' },
  itemRow: (dim) => ({
    display:'flex', alignItems:'center', gap:10, padding:'8px 12px', minHeight:40, boxSizing:'border-box',
    borderBottom:'1px solid var(--bdr)', opacity: dim ? 0.6 : 1,
  }),
  itemName: (off) => ({ flex:1, fontSize:15, color: off ? 'var(--t4)' : 'var(--t1)', textDecoration: off ? 'line-through' : 'none', overflowWrap:'anywhere' }),
  price: { fontSize:14, color:'var(--t3)', fontFamily:'monospace', whiteSpace:'nowrap' },
  sub: { fontSize:15, fontWeight:700, color:'var(--t2)', margin:'4px 0 2px' },
  muted: { fontSize:15, color:'var(--t3)', lineHeight:1.5 },
  notice: { fontSize:15, color:'var(--t1)', background:'var(--acc-d)', border:'1px solid var(--acc-b)', borderRadius:8, padding:'8px 12px', lineHeight:1.5, margin:'6px 0 0' },
};

// A 20px box. 'on' ticked here, 'light' comes here with a ticked parent, 'some' only some
// sizes, 'off' does not come here. A real button, so it works from the keyboard.
function RouteBox({ state, disabled, onClick, label }) {
  const on = state === 'on' || state === 'some';
  const light = state === 'light';
  return (
    <button type="button" role="checkbox" aria-label={label} disabled={!!disabled}
      aria-checked={state === 'some' ? 'mixed' : (on || light) ? 'true' : 'false'}
      onClick={onClick}
      style={{
        width:20, height:20, borderRadius:5, flexShrink:0, padding:0, boxSizing:'border-box',
        border:`2px solid ${on || light ? 'var(--acc)' : 'var(--bdr2)'}`,
        background: on ? 'var(--acc)' : light ? 'var(--acc-d)' : 'transparent',
        color: on ? '#fff' : 'var(--acc)', fontSize:12, lineHeight:1, fontWeight:800,
        display:'flex', alignItems:'center', justifyContent:'center',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, fontFamily:'inherit',
      }}>
      {state === 'some' ? '−' : (on || light) ? '✓' : ''}
    </button>
  );
}

function CategoryRouter({ centreId, centres, routing, setRouting, menuCategories, menuItems }) {
  // What the person opened or closed by hand. Anything not in here is open exactly when
  // something inside it differs from the row itself (node.differs).
  // Both reset when another centre is picked: the parent renders this keyed by centre id.
  const [open, setOpen] = useState({});
  const [notice, setNotice] = useState(null);   // { catId, text, expect }

  const screen = useMemo(
    () => buildRoutingScreen({ centreId, centres, routing, categories: menuCategories, menuItems }),
    [centreId, centres, routing, menuCategories, menuItems],
  );
  const catById = useMemo(() => new Map((menuCategories || []).map(c => [c.id, c])), [menuCategories]);
  const nameOfCentre = (id) => (centres || []).find(c => c.id === id)?.name || null;
  const nameOfCategory = (id) => (catById.has(id) ? categoryLabel(catById.get(id)) : null);

  // Review 30 Sep 2026: a category that opened by itself (node.differs) snapped shut the
  // moment a click inside it fixed the difference, taking the clicked row and its notice with
  // it. On the first click every row keeps the open or closed state it has on screen now, so
  // nothing moves under the cursor; after that only the arrows open and close rows.
  const pinOpen = () => setOpen(o => {
    let next = o;
    flattenNodes(screen.roots).forEach(n => {
      if (next[n.id] !== undefined) return;
      if (next === o) next = { ...o };
      next[n.id] = n.differs;
    });
    return next;
  });

  const clickCat = (node) => {
    const want = !node.state.comesHere;
    const { notice: text, expect } = clickCategory({
      centreId, catId: node.id, want, centres, routing, parentMap: screen.parentMap, menuItems,
      nameOfCentre, nameOfCategory,
    });
    pinOpen();
    setRouting(prev => nextCentreCategories({ centres, routing: prev }, centreId, node.id, want, screen.parentMap, { menuItems }));
    setNotice(text ? { catId: node.id, text, expect } : null);
  };

  const clickEntry = (row, want) => {
    pinOpen();
    setRouting(prev => clickItem({
      centreId, routing: prev, productId: row.productId, sizeIds: row.sizeIds, targetId: row.id, want,
    }));
  };

  if (!screen.roots.length) return (
    <div style={{ textAlign:'center', padding:'32px 0', color:'var(--t3)', fontSize:15 }}>
      No menu categories yet. Add some in Menu first.
    </div>
  );

  const itemRow = (row, catOn, indent, last) => (
    <div key={row.id} style={{ ...CR.itemRow(!catOn), paddingLeft: 12 + indent, borderBottom: last ? 'none' : CR.itemRow(false).borderBottom }}>
      <RouteBox state={row.comesHere ? 'on' : 'off'} disabled={!catOn} label={row.label}
        onClick={() => clickEntry(row, !row.comesHere)} />
      <span style={CR.itemName(catOn && !row.comesHere)}>{row.label}</span>
      <span style={CR.price}>{money(row.price)}</span>
    </div>
  );

  const entryRows = (node) => {
    const catOn = node.state.comesHere;
    const flat = [];
    node.entries.forEach(e => {
      if (e.kind !== 'product') { flat.push({ type:'item', row:e }); return; }
      flat.push({ type:'product', row:e });
      e.sizes.forEach(s => flat.push({ type:'size', row:s }));
    });
    return (
      <div style={CR.items}>
        {flat.map((f, i) => {
          const last = i === flat.length - 1;
          if (f.type === 'item') return itemRow(f.row, catOn, 0, last);
          if (f.type === 'size') return itemRow(f.row, catOn, 30, last);
          const p = f.row;
          const state = p.box === 'all' ? 'on' : p.box === 'some' ? 'some' : 'off';
          return (
            <div key={p.id} style={{ ...CR.itemRow(!catOn), borderBottom: last ? 'none' : CR.itemRow(false).borderBottom, background:'var(--bg2)' }}>
              <RouteBox state={state} disabled={!catOn} label={`${p.label}, every size`}
                onClick={() => clickEntry(p, p.box !== 'all')} />
              <span style={{ ...CR.itemName(catOn && p.box === 'none'), fontWeight:700 }}>{p.label}</span>
              <span style={CR.note}>{countOf(p.sizeCount, 'size', 'sizes')}</span>
            </div>
          );
        })}
      </div>
    );
  };

  const renderNode = (node) => {
    const st = node.state;
    const isOpen = open[node.id] ?? node.differs;
    const hasBody = node.children.length > 0 || node.entries.length > 0 || node.alsoIn.length > 0;
    const boxState = !st.comesHere ? 'off' : st.how === 'ticked' ? 'on' : 'light';
    const note = categoryRowNote(st, nameOfCentre, nameOfCategory);
    return (
      <div key={node.id}>
        <div style={CR.row(st.comesHere)}>
          <RouteBox state={boxState} label={node.label} onClick={() => clickCat(node)} />
          {node.icon && <span style={{ fontSize:18, lineHeight:1 }}>{node.icon}</span>}
          <div style={{ flex:1, minWidth:0, display:'flex', alignItems:'baseline', gap:'2px 10px', flexWrap:'wrap' }}>
            <span onClick={() => clickCat(node)} style={CR.name(st.comesHere)}>{node.label}</span>
            {note && <span style={CR.note}>{note}</span>}
          </div>
          {node.offCount > 0 && <span style={CR.pill}>{countOf(node.offCount, 'item', 'items')} off</span>}
          {hasBody && (
            <button type="button" aria-expanded={!!isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} what is in ${node.label}`}
              onClick={() => setOpen(o => ({ ...o, [node.id]: !isOpen }))} style={CR.chevron}>
              {isOpen ? '▲' : '▼'}
            </button>
          )}
        </div>
        {/* Only while it is still true: a failed save puts the old routing back, and a save
            can bring back another window's change. */}
        {noticeHolds(notice, node, centreId) && <div style={CR.notice}>{notice.text}</div>}
        {isOpen && hasBody && (
          <div style={CR.body}>
            {node.children.map(renderNode)}
            {node.entries.length > 0 && node.children.length > 0 && (
              <div style={CR.sub}>In {node.label} itself</div>
            )}
            {node.entries.length > 0 && !st.comesHere && (
              <div style={CR.muted}>Tick {node.label} to choose which of its items come here.</div>
            )}
            {node.entries.length > 0 && entryRows(node)}
            {node.alsoIn.length > 0 && (
              <div style={CR.muted}>
                Also on the menu here, but they go with another category:{' '}
                {node.alsoIn.map(a => (a.catLabel ? `${a.label} (${a.catLabel})` : a.label)).join(', ')}.
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const nowhere = nowhereNotice(screen, nameOfCentre);
  const loose = screen.uncategorised;
  return (
    <div>
      <ul style={CR.help}>
        <li>Tick a category to send its items here. Its sub categories come too.</li>
        <li>Tick a sub category at another center to send it there instead.</li>
        <li>Untick a sub category here to stop it coming here.</li>
        <li>Items follow their Primary category in Menu, or an Also in category inside it. Sizes follow their product.</li>
      </ul>
      <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
        {screen.roots.map(renderNode)}
      </div>
      {loose.length > 0 && (
        <p style={{ ...CR.muted, marginTop:12 }}>
          Not in a category on the menu, so no tick here reaches {loose.length === 1 ? 'it' : 'them'}:{' '}
          {joinList([...loose.slice(0, 5).map(r => r.label), ...(loose.length > 5 ? [`${loose.length - 5} more`] : [])])}.
        </p>
      )}
      {screen.optionOnlyCount > 0 && (
        <p style={{ ...CR.muted, marginTop:12 }}>Options print with the item they are added to.</p>
      )}
      {nowhere && <div style={{ ...CR.notice, marginTop:12 }}>{nowhere}</div>}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────
export default function PrintRouting() {
  const { menuCategories, menuItems, markBOChange } = useStore();
  const showToast = useStore(s => s.showToast);
  const [data, setData] = useState(() => ({ centres:[], routing:{} }));
  const [routing, setRouting] = useState({});
  const [selected, setSelected] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editCentre, setEditCentre] = useState(null);
  const [kdsDevices, setKdsDevices] = useState([]);
  const [form, setForm] = useState({ name:'', icon:'🔥', type:'kitchen', printerId:'', kdsDeviceId:'', printAllergens:false });
  const [printers, setPrinters] = useState(() => { try { return JSON.parse(localStorage.getItem('rpos-printers')||'[]'); } catch { return []; } });
  const [_loaded, setLoaded] = useState(false);
  // v5.5.835: venue default receipt printer (online / delivery / HubRise receipts)
  const [venuePrinterId, setVenuePrinterId] = useState('');
  useEffect(() => { loadVenueReceiptPrinter().then(setVenuePrinterId); }, []);
  const changeVenuePrinter = async (id) => {
    const previous = venuePrinterId;
    setVenuePrinterId(id);
    const { error } = await saveVenueReceiptPrinter(id, previous);
    reportSave('default receipt printer', error);
    if (error) {
      setVenuePrinterId(previous); // never leave a destination on screen the DB rejected
      showToast?.('Default receipt printer NOT saved — the old setting is still in force', 'error');
      return;
    }
    markBOChange?.();
  };

  // Last config the database accepted — what we roll the screen back to on a failed save.
  const lastGoodRouting = useRef(null);

  // Load routing from Supabase on mount
  useEffect(() => {
    loadRoutingFromDB().then(config => {
      setData(config);
      setRouting(config.routing || {});
      lastGoodRouting.current = { centres: config.centres || [], routing: config.routing || {} };
      setLoaded(true);
    });
  }, []);

  // Keep printer list live
  useEffect(() => {
    const h = () => { try { setPrinters(JSON.parse(localStorage.getItem('rpos-printers')||'[]')); } catch {} };
    window.addEventListener('rpos-printers-updated', h);
    window.addEventListener('storage', h);
    return () => { window.removeEventListener('rpos-printers-updated', h); window.removeEventListener('storage', h); };
  }, []);

  // Load KDS devices from Supabase
  useEffect(() => {
    if (isMock) return;
    (async () => {
      const locId = await getLocationId();
      if (!locId) return;
      const { data: devs } = await supabase.from('devices').select('id,name,centre_id,status').eq('location_id',locId).eq('type','kds');
      if (devs) setKdsDevices(devs);
    })();
  }, []);

  // Persist changes to Supabase (and localStorage cache)
  useEffect(() => {
    if (!_loaded) return; // don't save on initial load
    const saved = { centres: data.centres, routing };
    const previous = lastGoodRouting.current;
    // The revert below puts the last accepted objects straight back into state, which re-runs
    // this effect — skip that pass (same references) or a rejected write would loop forever.
    if (previous && previous.centres === saved.centres && previous.routing === saved.routing) return;
    (async () => {
      const { error, saved: stored } = await saveRoutingToDB(saved, previous);
      reportSave('print routing', error);
      if (error) {
        if (previous) {
          setData(d => ({ ...d, centres: previous.centres }));
          setRouting(previous.routing);
        }
        showToast?.('Print routing NOT saved — reverted to the last saved version', 'error');
        return;
      }
      // 27 Sep 2026: another window's changes came back with the save: show them. The last good
      // copy is set FIRST (the same objects), so the effect this state change re-runs skips.
      const landed = stored || saved;
      lastGoodRouting.current = landed;
      if (landed !== saved) {
        if (JSON.stringify(landed.centres) !== JSON.stringify(saved.centres)) setData(d => ({ ...d, centres: landed.centres }));
        else lastGoodRouting.current = { ...landed, centres: saved.centres };
        if (JSON.stringify(landed.routing) !== JSON.stringify(saved.routing)) setRouting(landed.routing);
        else lastGoodRouting.current = { ...lastGoodRouting.current, routing: saved.routing };
      }
      markBOChange?.();
    })();
  }, [data.centres, routing]);

  const f = (k,v) => setForm(p => ({ ...p, [k]:v }));

  const addCentre = () => {
    if (!form.name.trim()) return;
    const centre = {
      id: uid(),
      name: form.name.trim(),
      icon: form.icon,
      type: form.type,
      printerId: form.printerId || null,
      printer: form.printerId ? printers.find(p => p.id === form.printerId) || null : null,
      kdsDeviceId: form.kdsDeviceId || null,
      printAllergens: form.printAllergens === true,
      splitPerItem: form.splitPerItem === true,
    };
    setData(d => ({ ...d, centres:[...d.centres, centre] }));
    setRouting(r => ({ ...r, [centre.id]: emptyRouting() }));
    setSelected(centre.id);
    setShowAdd(false);
    setForm({ name:'', icon:'🔥', type:'kitchen', printerId:'', kdsDeviceId:'', printAllergens:false, splitPerItem:false });
  };

  const saveCentre = () => {
    setData(d => ({ ...d, centres: d.centres.map(c => c.id===editCentre.id ? {
      ...c, name:form.name, icon:form.icon, type:form.type,
      printerId: form.printerId || null,
      printer: form.printerId ? printers.find(p => p.id === form.printerId) || null : null,
      kdsDeviceId: form.kdsDeviceId || null,
      printAllergens: form.printAllergens === true,
      splitPerItem: form.splitPerItem === true,
    } : c) }));
    setEditCentre(null);
  };

  const deleteCentre = (id) => {
    if (!confirm('Delete this production center?')) return;
    setData(d => ({ ...d, centres: d.centres.filter(c => c.id !== id) }));
    setRouting(r => { const copy = {...r}; delete copy[id]; return copy; });
    if (selected === id) setSelected(null);
  };

  const startEdit = (c) => {
    setEditCentre(c);
    setForm({ name:c.name, icon:c.icon, type:c.type,
      printerId: c.printerId || '',
      kdsDeviceId: c.kdsDeviceId||'',
      printAllergens: c.printAllergens === true,
      splitPerItem: c.splitPerItem === true });
    setShowAdd(false);
  };

  const activeCentre = data.centres.find(c => c.id === selected);

  // catId -> parentId, built by the same helper the tills use (lib/productionRouting.js),
  // so the order type warning and the rail count read the tree the rule routes by.
  const catParents = useMemo(() => buildCatParentMap(menuCategories || []), [menuCategories]);

  // Merge Supabase KDS data into centre display
  const kdsForCentre = (centreId) => kdsDevices.find(k => k.centre_id === centreId);
  const unassignedKds = kdsDevices.filter(k => !k.centre_id || !data.centres.find(c=>c.id===k.centre_id?.toString()));

  const CentreForm = ({ onSave, onCancel }) => (
    <div style={{ ...S.card, border:'2px solid var(--acc)' }}>
      <div style={S.cardTitle}>{editCentre ? 'Edit production center' : 'New production center'}</div>
      <div style={S.row}>
        <div>
          <label style={S.label}>Name *</label>
          <input style={S.input} value={form.name} onChange={e=>f('name',e.target.value)} placeholder="e.g. Hot kitchen" autoFocus />
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'60px 1fr', gap:8 }}>
          <div>
            <label style={S.label}>Icon</label>
            <select style={S.input} value={form.icon} onChange={e=>f('icon',e.target.value)}>
              {CENTRE_ICONS.map(i=><option key={i} value={i}>{i}</option>)}
            </select>
          </div>
          <div>
            <label style={S.label}>Type</label>
            <select style={S.input} value={form.type} onChange={e=>f('type',e.target.value)}>
              {CENTRE_TYPES.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div style={{ fontSize:13, fontWeight:700, color:'var(--t2)', marginBottom:10, marginTop:4 }}>🖨 Printer</div>
      <div style={{ marginBottom:14 }}>
        <label style={S.label}>Assign printer</label>
        {printers.length === 0 ? (
          <div style={{ padding:'10px 14px', borderRadius:8, background:'var(--acc-d)', border:'1px solid var(--acc-b)', fontSize:12, color:'var(--acc)' }}>
            No printers added yet — go to <strong>Devices → Printers</strong> to add your Sunmi NT311 first.
          </div>
        ) : (
          <select style={{ ...S.input, maxWidth:380 }} value={form.printerId} onChange={e=>f('printerId',e.target.value)}>
            <option value="">No printer assigned</option>
            {printers.map(p => (
              <option key={p.id} value={p.id}>
                🖨 {p.name}{p.location ? ` — ${p.location}` : ''}{p.address ? ` (${p.address})` : ''}
              </option>
            ))}
          </select>
        )}
      </div>

      {kdsDevices.length > 0 && (
        <>
          <div style={{ fontSize:13, fontWeight:700, color:'var(--t2)', marginBottom:10 }}>📺 KDS screen</div>
          <div style={{ marginBottom:14 }}>
            <label style={S.label}>Assign a KDS device</label>
            <select style={{ ...S.input, maxWidth:300 }} value={form.kdsDeviceId} onChange={e=>f('kdsDeviceId',e.target.value)}>
              <option value="">None</option>
              {kdsDevices.map(k=><option key={k.id} value={k.id}>{k.name}</option>)}
            </select>
          </div>
        </>
      )}

      <div style={{ fontSize:13, fontWeight:700, color:'var(--t2)', marginBottom:10 }}>🎟 Docket options</div>
      <div style={{ marginBottom:14, padding:'10px 12px', background:'var(--bg3)', border:'1px solid var(--bdr)', borderRadius:8, display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
        <div style={{ minWidth:0 }}>
          <div style={{ fontSize:13, fontWeight:600, color:'var(--t1)' }}>Print allergens on docket</div>
          <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>
            Off by default. KDS screen always shows allergens regardless of this setting.
          </div>
        </div>
        <button
          type="button"
          onClick={()=>f('printAllergens', !form.printAllergens)}
          style={{
            width:42, height:24, borderRadius:12, cursor:'pointer', border:'none',
            background: form.printAllergens ? 'var(--acc)' : 'var(--bg5)',
            position:'relative', transition:'background .15s', flexShrink:0,
          }}>
          <div style={{
            width:18, height:18, borderRadius:'50%', background:'#fff',
            position:'absolute', top:3, left: form.printAllergens ? 21 : 3,
            transition:'left .15s',
          }}/>
        </button>
      </div>

      <div style={{ marginBottom:14, padding:'10px 12px', background:'var(--bg3)', border:'1px solid var(--bdr)', borderRadius:8, display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
        <div style={{ minWidth:0 }}>
          <div style={{ fontSize:13, fontWeight:600, color:'var(--t1)' }}>One ticket per item ☕ (sticker mode)</div>
          <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>
            Coffee-shop style — prints a separate docket for every item (e.g. one sticker per cup), each numbered “ITEM 1 OF 3”. Off by default.
          </div>
        </div>
        <button
          type="button"
          onClick={()=>f('splitPerItem', !form.splitPerItem)}
          style={{
            width:42, height:24, borderRadius:12, cursor:'pointer', border:'none',
            background: form.splitPerItem ? 'var(--acc)' : 'var(--bg5)',
            position:'relative', transition:'background .15s', flexShrink:0,
          }}>
          <div style={{
            width:18, height:18, borderRadius:'50%', background:'#fff',
            position:'absolute', top:3, left: form.splitPerItem ? 21 : 3,
            transition:'left .15s',
          }}/>
        </button>
      </div>

      <div style={{ display:'flex', gap:8 }}>
        <button onClick={onSave} style={{ ...S.btn, ...S.btnPrimary }}>{editCentre ? 'Save changes' : 'Add center →'}</button>
        <button onClick={onCancel} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
      </div>
    </div>
  );

  return (
    <div style={S.page}>
      {/* ── Left: center list ── */}
      <div style={S.left}>
        <div style={{ padding:'16px 14px 8px', borderBottom:'1px solid var(--bdr)', flexShrink:0 }}>
          <div style={{ fontSize:16, fontWeight:800, color:'var(--t1)', marginBottom:2 }}>Production printing</div>
          <div style={{ fontSize:12, color:'var(--t3)' }}>Route categories to production centers</div>
        </div>

        <div style={{ flex:1, overflowY:'auto' }}>
          {/* v5.5.835: venue-level receipt destination. Till + handheld receipts follow
              the printer set on the device itself (Devices → edit terminal); this covers
              the receipts that have no device — online, delivery and HubRise orders. */}
          <div style={S.h2}>Customer receipts</div>
          <div style={{ padding:'0 14px 14px' }}>
            <label style={S.label}>Default receipt printer</label>
            {printers.length === 0 ? (
              <div style={{ fontSize:12, color:'var(--t3)', lineHeight:1.5 }}>
                No printers added yet — go to <strong>Devices → Printers</strong> to add one first.
              </div>
            ) : (
              <>
                <select style={S.input} value={venuePrinterId} onChange={e=>changeVenuePrinter(e.target.value)}>
                  <option value="">No default — these receipts won't print</option>
                  {printers.map(p => (
                    <option key={p.id} value={p.id}>
                      🖨 {p.name}{p.location ? ` — ${p.location}` : ''}{p.address ? ` (${p.address})` : ''}
                    </option>
                  ))}
                </select>
                <div style={{ fontSize:11, color: venuePrinterId ? 'var(--t3)' : 'var(--red)', marginTop:6, lineHeight:1.5 }}>
                  {venuePrinterId
                    ? 'Used for online, delivery and HubRise receipts. Till and handheld receipts use the printer set on each device.'
                    : 'Online, delivery and HubRise receipts have nowhere to print. Pick a printer above.'}
                </div>
              </>
            )}
          </div>

          <div style={S.h2}>Production centers</div>
          {data.centres.length === 0 && (
            <div style={{ padding:'12px 14px', fontSize:12, color:'var(--t3)' }}>No centers yet — add one below</div>
          )}
          {data.centres.map(c => {
            const kds = kdsForCentre(c.id);
            const r = routing[c.id] || emptyRouting();
            // Only ticks that still point at a category on the menu: a deleted category
            // routes nothing, so Provo's Kitchen read 9 with 7 real ones.
            const catCount = liveTickCount(r, catParents);
            return (
              <div key={c.id} onClick={()=>{ setSelected(c.id); setShowAdd(false); setEditCentre(null); }}
                style={S.centreRow(selected===c.id)}>
                <span style={{ fontSize:22, lineHeight:1 }}>{c.icon}</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{c.name}</div>
                  <div style={{ fontSize:11, color:'var(--t3)', display:'flex', alignItems:'center', gap:5, flexWrap:'wrap' }}>
                    {c.printer && <span>🖨 {c.printer.name}</span>}
                    {kds && <span>📺 {kds.name}</span>}
                    {catCount > 0 && <span style={{ color:'var(--acc)' }}>{catCount} categor{catCount===1?'y':'ies'}</span>}
                    {/* Only when the centre is narrowed: every centre reading "All order
                        types" says nothing and buries the one row that differs. 15px
                        because it is new Back Office copy; the 11px around it is older. */}
                    {normaliseCentreOrderTypes(r.orderTypes).length > 0 && (
                      <span style={{ color:'var(--acc)', fontSize:15, fontWeight:700 }}>{describeCentreOrderTypes(r)} only</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {/* Database fence stage 1 (contract G3): keys for LAN print agents. */}
          <PrintAgentKeys S={S} />
        </div>

        <div style={{ padding:12, borderTop:'1px solid var(--bdr)', flexShrink:0 }}>
          <button onClick={()=>{ setShowAdd(true); setSelected(null); setEditCentre(null); setForm({name:'',icon:'🔥',type:'kitchen',printerId:'',kdsDeviceId:'',printAllergens:false}); }}
            style={{ ...S.btn, ...S.btnPrimary, width:'100%' }}>
            + Add production center
          </button>
        </div>
      </div>

      {/* ── Right: detail panel ── */}
      <div style={S.right}>
        {/* Add new center form */}
        {showAdd && (
          <CentreForm onSave={addCentre} onCancel={()=>setShowAdd(false)} />
        )}

        {/* Edit center form */}
        {editCentre && (
          <CentreForm onSave={saveCentre} onCancel={()=>setEditCentre(null)} />
        )}

        {/* Center detail */}
        {activeCentre && !editCentre && (
          <>
            {/* Header */}
            <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:20 }}>
              <span style={{ fontSize:36 }}>{activeCentre.icon}</span>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:22, fontWeight:800, color:'var(--t1)' }}>{activeCentre.name}</div>
                <div style={{ fontSize:12, color:'var(--t3)' }}>
                  {CENTRE_TYPES.find(t=>t.id===activeCentre.type)?.label}
                  {activeCentre.printer && ` · 🖨 ${activeCentre.printer.name}`}
                  {kdsForCentre(activeCentre.id) && ` · 📺 ${kdsForCentre(activeCentre.id).name}`}
                </div>
              </div>
              <button onClick={()=>startEdit(activeCentre)} style={{ ...S.btn, ...S.btnGhost, fontSize:12 }}>Edit</button>
              <button onClick={()=>deleteCentre(activeCentre.id)} style={{ ...S.btn, ...S.btnDanger, fontSize:12 }}>Delete</button>
            </div>

            {/* Hardware summary */}
            <div style={{ ...S.card, display:'flex', gap:16 }}>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:12, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6 }}>🖨 Printer</div>
                {activeCentre.printer ? (
                  <>
                    <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>{activeCentre.printer.name}</div>
                    <div style={{ fontSize:12, color:'var(--t3)' }}>
                      {activeCentre.printer.model ? activeCentre.printer.model.replace(/-/g,' ') : 'ESC/POS printer'}
                      {activeCentre.printer.address ? ` · ${activeCentre.printer.address}` : ''}
                      {activeCentre.printer.location ? ` · ${activeCentre.printer.location}` : ''}
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize:13, color:'var(--t3)' }}>No printer assigned — <button onClick={()=>startEdit(activeCentre)} style={{ background:'none', border:'none', color:'var(--acc)', cursor:'pointer', fontFamily:'inherit', fontSize:13, padding:0 }}>Assign one</button></div>
                )}
              </div>
              <div style={{ width:1, background:'var(--bdr)' }}/>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:12, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6 }}>📺 KDS Screen</div>
                {kdsForCentre(activeCentre.id) ? (
                  <>
                    <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>{kdsForCentre(activeCentre.id).name}</div>
                    <div style={{ fontSize:12, color:'var(--t3)' }}>Kitchen display · {kdsForCentre(activeCentre.id).status || 'active'}</div>
                  </>
                ) : (
                  <div style={{ fontSize:13, color:'var(--t3)' }}>No KDS assigned{kdsDevices.length > 0 ? ' — ' : ''}{kdsDevices.length > 0 && <button onClick={()=>startEdit(activeCentre)} style={{ background:'none', border:'none', color:'var(--acc)', cursor:'pointer', fontFamily:'inherit', fontSize:13, padding:0 }}>Assign one</button>}</div>
                )}
              </div>
            </div>

            {/* Category routing */}
            <div style={{ ...S.card }}>
              <div style={S.cardTitle}>
                📋 Category routing
                <span style={{ fontSize:12, fontWeight:400, color:'var(--t3)', marginLeft:8 }}>
                  Select which categories print/display at this center
                </span>
              </div>
              <CategoryRouter
                key={activeCentre.id}
                centreId={activeCentre.id}
                centres={data.centres}
                routing={routing}
                setRouting={setRouting}
                menuCategories={menuCategories || []}
                menuItems={menuItems || []}
              />
            </div>

            {/* Order types (v5.8.63): same page, next to category routing */}
            <OrderTypeRouter
              centreId={activeCentre.id}
              centreName={activeCentre.name}
              routing={routing}
              setRouting={setRouting}
              centres={data.centres}
              catParents={catParents}
            />
          </>
        )}

        {/* Empty state */}
        {!activeCentre && !showAdd && !editCentre && (
          <div style={{ textAlign:'center', padding:'80px 40px', color:'var(--t3)' }}>
            <div style={{ fontSize:48, marginBottom:16 }}>🖨</div>
            <div style={{ fontSize:18, fontWeight:700, color:'var(--t2)', marginBottom:8 }}>Production printing</div>
            <div style={{ fontSize:14, lineHeight:1.6, marginBottom:24 }}>
              Create production centers for your kitchen, bar and expo stations.<br/>
              Assign printers, KDS screens and menu categories to each.
            </div>
            <button onClick={()=>setShowAdd(true)} style={{ ...S.btn, ...S.btnPrimary, fontSize:14 }}>
              + Add your first production center
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
