// v4.6.17: Product Mix+ report.
// Four sub-tabs: Items, Categories, Modifiers, 86'd.
// Each sub-tab has its own CSV export.
//
// Data model note: closed_checks.items[] already carries cat (category id), name, qty, price, mods[].
// menuCategories provides id -> label mapping. eightySixIds from the store lists currently 86'd menu items.

import { useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { StatTile, ExportBtn, EmptyState } from './_charts';
import { toCsv, downloadCsv } from './_csv';
import { daySlot } from './_filters';
import { isSplit, sumFields } from '../../../lib/reportSplit.js';
import { siteItemRows, siteCategoryRows, siteModifierRows, joinSiteRows } from '../../../lib/reportSiteMenu.js';
import { useParts, exportSites } from './_siteSplit';
import { useSiteMenus, useOtherSiteMenu } from './_siteMenus';
import { SplitHeader, Blocks, SiteRows, SiteMatrix } from './SiteSplit';

// One empty list, so a view with nothing to show does not rebuild its tables every render.
const NONE = Object.freeze([]);

const SUB_TABS = [
  { id:'items',      label:'Items',      icon:'🍽' },
  { id:'categories', label:'Categories', icon:'🗂' },
  { id:'modifiers',  label:'Modifiers',  icon:'➕' },
  { id:'eighty_six', label:"86'd",       icon:'🚫' },
];

// 5 Oct 2026 (Peter: "make every report we have multi site when sites are connected
// together"): with more than one site on screen this is the site split at the foot of the
// file, each site's lines read against ITS OWN menu (src/lib/reportSiteMenu.js). One site is
// the report exactly as it was.
export default function ProductMix(props) {
  return isSplit(props.sites) ? <ProductMixSites {...props}/> : <ProductMixOne {...props}/>;
}

function ProductMixOne({ checks, fmt, fmtN, locationConfig, sites }) {
  const store = useStore();
  // 5 Oct 2026: one OTHER site ticked. Its categories and products are its own, read fresh
  // (the store holds the signed in site's). The signed in site reads the store as it always has.
  const other = useOtherSiteMenu(sites);
  const menuCategories = other.other ? (other.menu?.categories || NONE) : (store.menuCategories || NONE);
  const menuItems      = other.other ? (other.menu?.items || NONE) : (store.menuItems || NONE);
  const eightySixIds   = other.other ? NONE : (store.eightySixIds || NONE);
  const [sub, setSub] = useState('items');

  // Category lookup: id -> label
  const catLabel = useMemo(() => {
    const map = {};
    menuCategories.forEach(c => { map[c.id] = c.label || c.name || c.id; });
    return map;
  }, [menuCategories]);

  // -------------- Aggregations --------------

  // Per-item totals with qty, revenue, share and time-of-day slots (lunch/dinner/other).
  // v5.11.1: the slot is the venue's hour (daySlot), never the browser's.
  const timeZone = locationConfig?.timezone;
  const itemRows = useMemo(() => {
    const map = {};
    let totalRev = 0;
    checks.filter(c => c.status !== 'voided').forEach(c => {
      const slot = daySlot(c.closedAt, timeZone);
      (c.items || []).forEach(i => {
        if (i.voided) return;
        const key = i.name || 'Unknown';
        if (!map[key]) map[key] = { name: key, itemId: i.itemId || null, cat: i.cat || null, qty:0, rev:0, morning:0, lunch:0, afternoon:0, dinner:0, late:0 };
        const qty = i.qty || 1;
        const rev = (i.price || 0) * qty;
        map[key].qty += qty;
        map[key].rev += rev;
        map[key][slot] += qty;
        totalRev += rev;
      });
    });
    const rows = Object.values(map).sort((a, b) => b.rev - a.rev);
    rows.forEach(r => { r.share = totalRev > 0 ? (r.rev / totalRev) * 100 : 0; r.avgPrice = r.qty ? r.rev / r.qty : 0; });
    return { rows, totalRev };
  }, [checks, timeZone]);

  // Per-category totals
  const categoryRows = useMemo(() => {
    const map = {};
    let totalRev = 0;
    checks.filter(c => c.status !== 'voided').forEach(c => {
      (c.items || []).forEach(i => {
        if (i.voided) return;
        const key = i.cat || '__uncat';
        if (!map[key]) map[key] = { cat: key, label: key === '__uncat' ? 'Uncategorized' : (catLabel[key] || key), qty:0, rev:0, itemCount: new Set() };
        const qty = i.qty || 1;
        const rev = (i.price || 0) * qty;
        map[key].qty += qty;
        map[key].rev += rev;
        map[key].itemCount.add(i.name);
        totalRev += rev;
      });
    });
    const rows = Object.values(map).map(r => ({ ...r, itemCount: r.itemCount.size })).sort((a, b) => b.rev - a.rev);
    rows.forEach(r => { r.share = totalRev > 0 ? (r.rev / totalRev) * 100 : 0; });
    return { rows, totalRev };
  }, [checks, catLabel]);

  // Per-modifier totals with attach rate (% of checks / items that included this modifier)
  const modifierRows = useMemo(() => {
    const map = {};
    let totalItemCount = 0;
    checks.filter(c => c.status !== 'voided').forEach(c => {
      (c.items || []).forEach(i => {
        if (i.voided) return;
        const qty = i.qty || 1;
        totalItemCount += qty;
        (i.mods || []).forEach(m => {
          const name = m.name || m.label || 'Unnamed modifier';
          if (!map[name]) map[name] = { name, qty:0, revenue:0 };
          map[name].qty     += qty;
          map[name].revenue += (m.price || 0) * qty;
        });
      });
    });
    const rows = Object.values(map).sort((a, b) => b.qty - a.qty);
    rows.forEach(r => { r.attachRate = totalItemCount > 0 ? (r.qty / totalItemCount) * 100 : 0; });
    return { rows, totalItemCount };
  }, [checks]);

  // Currently 86'd items + items that had 0 sales in the period (dormant)
  const eightySixRows = useMemo(() => {
    const soldIds = new Set();
    const soldNames = new Set();
    checks.filter(c => c.status !== 'voided').forEach(c => {
      (c.items || []).forEach(i => {
        if (i.voided) return;
        if (i.itemId) soldIds.add(i.itemId);
        if (i.name)   soldNames.add(i.name);
      });
    });
    // 1. Items explicitly 86'd right now
    const activelyEightySixed = (menuItems || [])
      .filter(m => eightySixIds.includes(m.id) && !m.archived)
      .map(m => ({ kind:'86', id:m.id, name:m.name, cat:m.cat, catLabel: m.cat ? (catLabel[m.cat] || '—') : '—' }));
    // 2. Items that sold 0 in this period but are still on the menu (dormant)
    const dormant = (menuItems || [])
      .filter(m => !m.archived && !eightySixIds.includes(m.id) && !soldIds.has(m.id) && !soldNames.has(m.name))
      .slice(0, 100)
      .map(m => ({ kind:'dormant', id:m.id, name:m.name, cat:m.cat, catLabel: m.cat ? (catLabel[m.cat] || '—') : '—' }));
    return { activelyEightySixed, dormant };
  }, [checks, menuItems, eightySixIds, catLabel]);

  // -------------- Exports --------------

  const exportFn = {
    items: () => downloadCsv(`product-mix-items-${date()}.csv`, toCsv(itemRows.rows, [
      { label:'Item',      key:'name' },
      { label:'Category',  key: r => catLabel[r.cat] || '' },
      { label:'Qty',       key:'qty' },
      { label:'Revenue',   key: r => r.rev.toFixed(2) },
      { label:'Avg price', key: r => r.avgPrice.toFixed(2) },
      { label:'Share %',   key: r => r.share.toFixed(2) },
      { label:'Morning',   key:'morning' },
      { label:'Lunch',     key:'lunch' },
      { label:'Afternoon', key:'afternoon' },
      { label:'Dinner',    key:'dinner' },
      { label:'Late',      key:'late' },
    ])),
    categories: () => downloadCsv(`product-mix-categories-${date()}.csv`, toCsv(categoryRows.rows, [
      { label:'Category',   key:'label' },
      { label:'Unique items', key:'itemCount' },
      { label:'Qty',        key:'qty' },
      { label:'Revenue',    key: r => r.rev.toFixed(2) },
      { label:'Share %',    key: r => r.share.toFixed(2) },
    ])),
    modifiers: () => downloadCsv(`product-mix-modifiers-${date()}.csv`, toCsv(modifierRows.rows, [
      { label:'Modifier',    key:'name' },
      { label:'Times used',  key:'qty' },
      { label:'Revenue',     key: r => r.revenue.toFixed(2) },
      { label:'Attach rate', key: r => r.attachRate.toFixed(2) },
    ])),
    eighty_six: () => {
      const rows = [
        ...eightySixRows.activelyEightySixed.map(r => ({ kind:'86\'d now', name:r.name, cat:r.catLabel })),
        ...eightySixRows.dormant.map(r => ({ kind:'Zero sales', name:r.name, cat:r.catLabel })),
      ];
      downloadCsv(`product-mix-eighty-six-${date()}.csv`, toCsv(rows, [
        { label:'Status',   key:'kind' },
        { label:'Item',     key:'name' },
        { label:'Category', key:'cat' },
      ]));
    },
  };

  // -------------- Render --------------

  if (other.loading) return <div style={{ textAlign:'center', padding:'48px 0', color:'var(--t4)', fontSize:13 }}>Loading this site's menu…</div>;

  return (
    <div>
      {other.failed && <div style={{ marginBottom:10, fontSize:11, color:'var(--amber)' }}>{other.site.name}: the menu could not be read, so categories show their ids and the 86 list is not available.</div>}
      {other.other && !other.failed && sub === 'eighty_six' && <div style={{ marginBottom:10, fontSize:11, color:'var(--t4)' }}>The 86 list is live at the site itself; here dormant items are this site's products with no sales in the period.</div>}
      {/* Sub-tab bar */}
      <div style={{ display:'flex', gap:6, marginBottom:14, flexWrap:'wrap' }}>
        {SUB_TABS.map(t => (
          <button key={t.id} onClick={() => setSub(t.id)} style={{
            padding:'6px 14px', borderRadius:8,
            border:`1px solid ${sub === t.id ? 'var(--acc-b)' : 'var(--bdr)'}`,
            background: sub === t.id ? 'var(--acc-d)' : 'var(--bg3)',
            color: sub === t.id ? 'var(--acc)' : 'var(--t3)',
            fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'inherit',
            display:'flex', alignItems:'center', gap:6,
          }}>
            <span style={{ fontSize:13 }}>{t.icon}</span>{t.label}
          </button>
        ))}
        <div style={{ flex:1 }}/>
        <ExportBtn onClick={exportFn[sub]}/>
      </div>

      {sub === 'items'      && <ItemsTable       rows={itemRows.rows}      totalRev={itemRows.totalRev} fmt={fmt} catLabel={catLabel}/>}
      {sub === 'categories' && <CategoriesTable  rows={categoryRows.rows}  totalRev={categoryRows.totalRev} fmt={fmt}/>}
      {sub === 'modifiers'  && <ModifiersTable   rows={modifierRows.rows}  totalItemCount={modifierRows.totalItemCount} fmt={fmt} fmtN={fmtN}/>}
      {sub === 'eighty_six' && <EightySixList    data={eightySixRows}      fmt={fmt} fmtN={fmtN}/>}
    </div>
  );
}

const date = () => new Date().toISOString().slice(0,10);

// ----- Sub views -----

function ItemsTable({ rows, totalRev, fmt, catLabel }) {
  if (rows.length === 0) return <EmptyState icon="🍽" message="No items sold in this period."/>;
  return (
    <>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:14 }}>
        <StatTile label="Unique items"     value={rows.length.toLocaleString()}/>
        <StatTile label="Units sold"       value={rows.reduce((s,r)=>s+r.qty,0).toLocaleString()}/>
        <StatTile label="Total item revenue" value={fmt(totalRev)} color="var(--acc)"/>
      </div>
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'hidden' }}>
        <div style={{ display:'grid', gridTemplateColumns:'32px 2fr 1fr 70px 90px 90px 1.4fr', padding:'9px 14px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em' }}>
          <span>#</span><span>Item</span><span>Category</span>
          <span style={{ textAlign:'right' }}>Qty</span>
          <span style={{ textAlign:'right' }}>Revenue</span>
          <span style={{ textAlign:'right' }}>Share</span>
          <span>Time of day (qty)</span>
        </div>
        {rows.slice(0, 100).map((r, i) => (
          <div key={r.name} style={{ display:'grid', gridTemplateColumns:'32px 2fr 1fr 70px 90px 90px 1.4fr', padding:'9px 14px', borderBottom:'1px solid var(--bdr)', fontSize:12, alignItems:'center', background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
            <span style={{ color:'var(--t4)', fontFamily:'var(--font-mono)' }}>{i + 1}</span>
            <span style={{ color:'var(--t1)', fontWeight:600 }}>{r.name}</span>
            <span style={{ color:'var(--t3)', fontSize:11 }}>{r.cat ? (catLabel[r.cat] || '—') : '—'}</span>
            <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{r.qty}</span>
            <span style={{ textAlign:'right', color:'var(--acc)', fontFamily:'var(--font-mono)', fontWeight:700 }}>{fmt(r.rev)}</span>
            <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{r.share.toFixed(1)}%</span>
            <TimeOfDay item={r}/>
          </div>
        ))}
        {rows.length > 100 && (
          <div style={{ padding:'10px 14px', fontSize:11, color:'var(--t4)', textAlign:'center' }}>
            Showing top 100 of {rows.length} — export CSV for the full list.
          </div>
        )}
      </div>
    </>
  );
}

function TimeOfDay({ item }) {
  // Tiny stacked bar showing qty split across morning/lunch/afternoon/dinner/late
  const total = item.morning + item.lunch + item.afternoon + item.dinner + item.late;
  if (total === 0) return <span style={{ fontSize:10, color:'var(--t4)' }}>—</span>;
  const segs = [
    { key:'morning',   v:item.morning,   color:'#60a5fa' },
    { key:'lunch',     v:item.lunch,     color:'#22c55e' },
    { key:'afternoon', v:item.afternoon, color:'#a1a1aa' },
    { key:'dinner',    v:item.dinner,    color:'#e8a020' },
    { key:'late',      v:item.late,      color:'#a78bfa' },
  ];
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
      <div style={{ display:'flex', height:8, width:'100%', borderRadius:4, overflow:'hidden', background:'var(--bg3)' }}>
        {segs.map(s => s.v > 0 && <div key={s.key} title={`${s.key}: ${s.v}`} style={{ width:`${(s.v/total)*100}%`, background:s.color }}/>)}
      </div>
    </div>
  );
}

function CategoriesTable({ rows, totalRev, fmt }) {
  if (rows.length === 0) return <EmptyState icon="🗂" message="No category data."/>;
  return (
    <>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:14 }}>
        <StatTile label="Categories sold" value={rows.length.toLocaleString()}/>
        <StatTile label="Total units" value={rows.reduce((s,r)=>s+r.qty,0).toLocaleString()}/>
        <StatTile label="Category revenue" value={fmt(totalRev)} color="var(--acc)"/>
      </div>
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'hidden' }}>
        <div style={{ display:'grid', gridTemplateColumns:'2fr 100px 70px 100px 1fr', padding:'9px 14px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em' }}>
          <span>Category</span>
          <span style={{ textAlign:'right' }}>Unique items</span>
          <span style={{ textAlign:'right' }}>Qty</span>
          <span style={{ textAlign:'right' }}>Revenue</span>
          <span>Share</span>
        </div>
        {rows.map((r, i) => (
          <div key={r.cat} style={{ display:'grid', gridTemplateColumns:'2fr 100px 70px 100px 1fr', padding:'10px 14px', borderBottom:'1px solid var(--bdr)', fontSize:12, alignItems:'center', background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
            <span style={{ color:'var(--t1)', fontWeight:600 }}>{r.label}</span>
            <span style={{ textAlign:'right', color:'var(--t3)', fontFamily:'var(--font-mono)' }}>{r.itemCount}</span>
            <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{r.qty}</span>
            <span style={{ textAlign:'right', color:'var(--acc)', fontFamily:'var(--font-mono)', fontWeight:700 }}>{fmt(r.rev)}</span>
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <div style={{ flex:1, height:5, background:'var(--bg3)', borderRadius:3, overflow:'hidden' }}>
                <div style={{ height:'100%', width:`${Math.min(r.share, 100)}%`, background:'var(--acc)' }}/>
              </div>
              <span style={{ fontSize:11, color:'var(--t4)', fontFamily:'var(--font-mono)', width:38, textAlign:'right' }}>{r.share.toFixed(0)}%</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function ModifiersTable({ rows, totalItemCount, fmt, fmtN }) {
  if (rows.length === 0) return <EmptyState icon="➕" message="No modifiers used in this period."/>;
  return (
    <>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:14 }}>
        <StatTile label="Unique modifiers"  value={rows.length.toLocaleString()}/>
        <StatTile label="Total attaches"    value={rows.reduce((s,r)=>s+r.qty,0).toLocaleString()}/>
        <StatTile label="Modifier revenue"  value={fmt(rows.reduce((s,r)=>s+r.revenue,0))} color="var(--acc)"/>
      </div>
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'hidden' }}>
        <div style={{ display:'grid', gridTemplateColumns:'2fr 100px 110px 1fr', padding:'9px 14px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em' }}>
          <span>Modifier</span>
          <span style={{ textAlign:'right' }}>Times used</span>
          <span style={{ textAlign:'right' }}>Revenue</span>
          <span>Attach rate</span>
        </div>
        {rows.map((r, i) => (
          <div key={r.name} style={{ display:'grid', gridTemplateColumns:'2fr 100px 110px 1fr', padding:'10px 14px', borderBottom:'1px solid var(--bdr)', fontSize:12, alignItems:'center', background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
            <span style={{ color:'var(--t1)', fontWeight:600 }}>{r.name}</span>
            <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{fmtN(r.qty)}</span>
            <span style={{ textAlign:'right', color:'var(--acc)', fontFamily:'var(--font-mono)', fontWeight:r.revenue > 0 ? 700 : 400 }}>{r.revenue > 0 ? fmt(r.revenue) : '—'}</span>
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <div style={{ flex:1, height:5, background:'var(--bg3)', borderRadius:3, overflow:'hidden' }}>
                <div style={{ height:'100%', width:`${Math.min(r.attachRate, 100)}%`, background:'#3b82f6' }}/>
              </div>
              <span style={{ fontSize:11, color:'var(--t4)', fontFamily:'var(--font-mono)', width:46, textAlign:'right' }}>{r.attachRate.toFixed(1)}%</span>
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop:12, padding:'10px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)', lineHeight:1.7 }}>
        ⓘ Attach rate = modifier uses ÷ {fmtN(totalItemCount)} total items sold. High attach rate = natural upsell territory.
      </div>
    </>
  );
}

function EightySixList({ data, fmt, fmtN }) {
  const { activelyEightySixed, dormant } = data;
  const hasNothing = activelyEightySixed.length === 0 && dormant.length === 0;
  if (hasNothing) return <EmptyState icon="🚫" message="No 86'd or dormant items. Menu is fully live."/>;
  return (
    <>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:10, marginBottom:14 }}>
        <StatTile label="86'd right now" value={fmtN(activelyEightySixed.length)} color={activelyEightySixed.length > 0 ? 'var(--red)' : 'var(--t1)'}/>
        <StatTile label="Zero sales in period" value={fmtN(dormant.length)} sub="menu items that did not sell"/>
      </div>

      {activelyEightySixed.length > 0 && (
        <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'hidden', marginBottom:14 }}>
          <div style={{ padding:'10px 14px', background:'var(--red-d)', borderBottom:'1px solid var(--bdr)', fontSize:11, fontWeight:700, color:'var(--red)', textTransform:'uppercase', letterSpacing:'.06em' }}>
            Currently 86'd — not orderable right now
          </div>
          {activelyEightySixed.map(r => (
            <div key={r.id} style={{ display:'grid', gridTemplateColumns:'2fr 1fr', padding:'10px 14px', borderBottom:'1px solid var(--bdr)', fontSize:12, alignItems:'center' }}>
              <span style={{ color:'var(--t1)', fontWeight:600 }}>{r.name}</span>
              <span style={{ color:'var(--t3)', fontSize:11 }}>{r.catLabel}</span>
            </div>
          ))}
        </div>
      )}

      {dormant.length > 0 && (
        <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'hidden' }}>
          <div style={{ padding:'10px 14px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em' }}>
            Dormant — on the menu but zero sales this period ({dormant.length > 100 ? 'first 100' : 'all'})
          </div>
          {dormant.map(r => (
            <div key={r.id} style={{ display:'grid', gridTemplateColumns:'2fr 1fr', padding:'10px 14px', borderBottom:'1px solid var(--bdr)', fontSize:12, alignItems:'center' }}>
              <span style={{ color:'var(--t2)' }}>{r.name}</span>
              <span style={{ color:'var(--t3)', fontSize:11 }}>{r.catLabel}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop:12, padding:'10px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)', lineHeight:1.7 }}>
        ⓘ Dormant items are candidates for removal or repricing. Consider menu engineering (under Sales reports) before cutting.
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Several sites: each site's lines are read against ITS OWN menu (a category id is a per
// site copy; the signed in site's menu named another site's categories wrongly), then the
// sites are joined on what they share: a shared product by its master id, a local one by its
// name (src/lib/reportSiteMenu.js). A column per site, the group first. Shared products are
// one row across all sites. The 86 list is a menu state, so it stays one site at a time.
// ─────────────────────────────────────────────────────────────────────────────
const MIX_METRICS = [{ id:'rev', label:'Revenue' }, { id:'qty', label:'Qty sold' }];
const SITE_TABS = SUB_TABS.filter(t => t.id !== 'eighty_six');

function ProductMixSites(props) {
  const { fmtN } = props;
  const { parts, blocks } = useParts(props);
  const { menus, loading, failed } = useSiteMenus(parts);
  const [sub, setSub] = useState('items');
  const [metric, setMetric] = useState('rev');

  const bySite = useMemo(() => new Map(parts.map(p => {
    const menu = menus[p.id] || null;
    return [p.id, {
      items: siteItemRows(p.rows, menu, ts => daySlot(ts, p.clock.timeZone)),
      cats:  siteCategoryRows(p.rows, menu),
      mods:  siteModifierRows(p.rows),
    }];
  })), [parts, menus]);

  const joined = (block, pick, fields, opts) => joinSiteRows(block.parts.map(p => ({ siteId: p.id, rows: pick(bySite.get(p.id)).rows })), fields, opts);
  const tagged = (pick, extra = () => ({})) => parts.flatMap(p => pick(bySite.get(p.id)).rows.map(r => ({ ...r, siteId: p.id, siteName: p.name, currency: p.currency || '', ...extra(r, p) })));

  const exportFn = {
    items: () => exportSites('product-mix-items', tagged(s => s.items), [
      { label:'Currency',  key:'currency' },
      { label:'Item',      key:'name' },
      { label:'Category',  key:'catLabel' },
      { label:'Qty',       key:'qty' },
      { label:'Revenue',   key: r => r.rev.toFixed(2) },
      { label:'Avg price', key: r => r.avgPrice.toFixed(2) },
      { label:'Share % (of site)', key: r => r.share.toFixed(2) },
      { label:'Morning',   key:'morning' },
      { label:'Lunch',     key:'lunch' },
      { label:'Afternoon', key:'afternoon' },
      { label:'Dinner',    key:'dinner' },
      { label:'Late',      key:'late' },
    ]),
    categories: () => exportSites('product-mix-categories', tagged(s => s.cats), [
      { label:'Currency',     key:'currency' },
      { label:'Category',     key:'label' },
      { label:'Unique items', key:'itemCount' },
      { label:'Qty',          key:'qty' },
      { label:'Revenue',      key: r => r.rev.toFixed(2) },
      { label:'Share % (of site)', key: r => r.share.toFixed(2) },
    ]),
    modifiers: () => exportSites('product-mix-modifiers', tagged(s => s.mods), [
      { label:'Currency',    key:'currency' },
      { label:'Modifier',    key:'name' },
      { label:'Times used',  key:'qty' },
      { label:'Revenue',     key: r => r.revenue.toFixed(2) },
      { label:'Attach rate', key: r => r.attachRate.toFixed(2) },
    ]),
    eighty_six: null,
  };

  if (loading) return <div style={{ textAlign:'center', padding:'48px 0', color:'var(--t4)', fontSize:13 }}>Loading each site's menu…</div>;

  const nameCell = (label, sub2) => (
    <span>
      <span style={{ color:'var(--t1)', fontWeight:600 }}>{label}</span>
      {sub2 ? <span style={{ color:'var(--t4)', fontSize:10, marginLeft:6 }}>{sub2}</span> : null}
    </span>
  );
  const kind = metric === 'qty' ? 'count' : 'money';
  const metricPick = metric === 'qty' ? 'qty' : 'rev';

  return (
    <div>
      <SplitHeader parts={parts} chips={false} onExport={exportFn[sub] || undefined}>
        {failed.map(id => {
          const p = parts.find(x => x.id === id);
          return <div key={id} style={{ color:'var(--amber)' }}>{p?.name || id}: the menu could not be read, so its products are matched by name and its categories show their ids.</div>;
        })}
      </SplitHeader>
      <div style={{ display:'flex', gap:6, marginBottom:14, flexWrap:'wrap', alignItems:'center' }}>
        {SUB_TABS.map(t => (
          <button key={t.id} onClick={() => setSub(t.id)} style={{
            padding:'6px 14px', borderRadius:8,
            border:`1px solid ${sub === t.id ? 'var(--acc-b)' : 'var(--bdr)'}`,
            background: sub === t.id ? 'var(--acc-d)' : 'var(--bg3)',
            color: sub === t.id ? 'var(--acc)' : 'var(--t3)',
            fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'inherit',
            display:'flex', alignItems:'center', gap:6,
          }}>
            <span style={{ fontSize:13 }}>{t.icon}</span>{t.label}
          </button>
        ))}
        <div style={{ flex:1 }}/>
        {SITE_TABS.some(t => t.id === sub) && (
          <select value={metric} onChange={e => setMetric(e.target.value)} style={{ padding:'6px 10px', borderRadius:8, background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t2)', fontSize:12, cursor:'pointer', fontFamily:'inherit' }}>
            {MIX_METRICS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        )}
      </div>

      {sub === 'eighty_six' && (
        <div style={{ padding:'28px 16px', textAlign:'center', color:'var(--t3)', fontSize:13, background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12 }}>
          The 86 list and dormant items belong to one site's menu. Pick one site to see them.
        </div>
      )}

      {sub !== 'eighty_six' && (
        <Blocks blocks={blocks}>{b => {
          if (sub === 'items') {
            const rows = joined(b, s => s.items, ['qty', 'rev'], { sortBy: metricPick });
            const site = b.parts.map(p => ({ part: p, cells: { ...sumFields(bySite.get(p.id).items.rows, ['qty', 'rev']), items: bySite.get(p.id).items.rows.length } }));
            const all = { ...sumFields(site.map(x => x.cells), ['qty', 'rev']), items: rows.length };
            if (!rows.length) return <EmptyState icon="🍽" message="No items sold at these sites in this period."/>;
            return (
              <>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:14 }}>
                  <StatTile label="Unique items"       value={fmtN(all.items)} sub="shared products counted once"/>
                  <StatTile label="Units sold"         value={fmtN(all.qty)}/>
                  <StatTile label="Total item revenue" value={b.fmt(all.rev)} color="var(--acc)"/>
                </div>
                <SiteRows block={b} rows={site} total={all} columns={[
                  { label:'Items',   cell: c => fmtN(c.items) },
                  { label:'Units',   cell: c => fmtN(c.qty) },
                  { label:'Revenue', cell: (c, f) => f(c.rev), color:'var(--acc)' },
                ]}/>
                <SiteMatrix block={b} first="Item" fmtN={fmtN} rows={rows.slice(0, 100).map(r => ({
                  key: r.key, label: nameCell(r.label, r.catLabel), kind,
                  total: r[metricPick], bySite: Object.fromEntries(b.parts.map(p => [p.id, r.bySite[p.id]?.[metricPick] || 0])),
                }))}/>
                {rows.length > 100 && <div style={{ fontSize:11, color:'var(--t4)', textAlign:'center', marginTop:-6, marginBottom:14 }}>Showing top 100 of {rows.length}. Export CSV for the full list.</div>}
              </>
            );
          }
          if (sub === 'categories') {
            const rows = joined(b, s => s.cats, ['qty', 'rev'], { sortBy: metricPick });
            const site = b.parts.map(p => ({ part: p, cells: { ...sumFields(bySite.get(p.id).cats.rows, ['qty', 'rev']), cats: bySite.get(p.id).cats.rows.length } }));
            const all = { ...sumFields(site.map(x => x.cells), ['qty', 'rev']), cats: rows.length };
            if (!rows.length) return <EmptyState icon="🗂" message="No category data at these sites."/>;
            return (
              <>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:14 }}>
                  <StatTile label="Categories sold"  value={fmtN(all.cats)}/>
                  <StatTile label="Total units"      value={fmtN(all.qty)}/>
                  <StatTile label="Category revenue" value={b.fmt(all.rev)} color="var(--acc)"/>
                </div>
                <SiteRows block={b} rows={site} total={all} columns={[
                  { label:'Categories', cell: c => fmtN(c.cats) },
                  { label:'Units',      cell: c => fmtN(c.qty) },
                  { label:'Revenue',    cell: (c, f) => f(c.rev), color:'var(--acc)' },
                ]}/>
                <SiteMatrix block={b} first="Category" fmtN={fmtN} rows={rows.map(r => ({
                  key: r.key, label: nameCell(r.label, `${fmtN(r.itemCount)} item${r.itemCount === 1 ? '' : 's'}`), kind,
                  total: r[metricPick], bySite: Object.fromEntries(b.parts.map(p => [p.id, r.bySite[p.id]?.[metricPick] || 0])),
                }))}/>
              </>
            );
          }
          const modPick = metric === 'qty' ? 'qty' : 'revenue';
          const rows = joined(b, s => s.mods, ['qty', 'revenue'], { sortBy: modPick });
          const site = b.parts.map(p => ({ part: p, cells: { ...sumFields(bySite.get(p.id).mods.rows, ['qty', 'revenue']), mods: bySite.get(p.id).mods.rows.length, items: bySite.get(p.id).mods.totalItemCount } }));
          const all = { ...sumFields(site.map(x => x.cells), ['qty', 'revenue', 'items']), mods: rows.length };
          if (!rows.length) return <EmptyState icon="➕" message="No modifiers used at these sites in this period."/>;
          return (
            <>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:14 }}>
                <StatTile label="Unique modifiers" value={fmtN(all.mods)}/>
                <StatTile label="Total attaches"   value={fmtN(all.qty)} sub={all.items ? `${((all.qty / all.items) * 100).toFixed(1)}% attach rate` : null}/>
                <StatTile label="Modifier revenue" value={b.fmt(all.revenue)} color="var(--acc)"/>
              </div>
              <SiteRows block={b} rows={site} total={all} columns={[
                { label:'Modifiers', cell: c => fmtN(c.mods) },
                { label:'Attaches',  cell: c => fmtN(c.qty) },
                { label:'Revenue',   cell: (c, f) => f(c.revenue), color:'var(--acc)' },
              ]}/>
              <SiteMatrix block={b} first="Modifier" fmtN={fmtN} rows={rows.map(r => ({
                key: r.key, label: nameCell(r.label), kind,
                total: r[modPick], bySite: Object.fromEntries(b.parts.map(p => [p.id, r.bySite[p.id]?.[modPick] || 0])),
              }))}/>
            </>
          );
        }}</Blocks>
      )}

      <div style={{ marginTop:12, padding:'10px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)', lineHeight:1.7 }}>
        ⓘ Each site's sales are read against its own menu. A product shared across sites is one row; a product made at one site is matched to another site's by its name. Share % in the CSV is of that site's own revenue.
      </div>
    </div>
  );
}
