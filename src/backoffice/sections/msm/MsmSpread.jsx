// src/backoffice/sections/msm/MsmSpread.jsx
//
// MULTI SITE MENU (v5.11.75): the Price spread tab (design 4f). Per product: the lowest and highest
// price where it is on sale, the spread in pounds and percent, and every site's price, with the
// sites more than 15% from the middle price marked. Widest first, so the sites that drifted apart
// stand out at once. Shows the draft (what will be), In store or a channel. Click a product to
// open it. Only the rows on screen are drawn.
//
// ROUND 2, builder 3 (design 4 and 2 item 25): option prices too (each option of a group, its price
// at every site where it is on; tap one to open its group), and plain words: "the usual price".

import { useMemo, useState } from 'react';
import { spreadRows, spreadSummary } from '../../../lib/msm/msmPublishView';
import { optionSpreadRows, optionSpreadSummary } from '../../../lib/msm/msmOptionSpread';
import { CHANNEL_LABELS } from '../../../lib/msm/msmGrid';
import { PUBLISHED_CHANNELS } from '../../../../supabase/functions/_shared/msmModel.js';
import { Popover, SiteChecklist, Segmented, WindowedList } from './msmUi';
import { ui, money } from './msmStyle';

const NAME_W = 250, NUM_W = 78, SITE_W = 92;

export default function MsmSpread({ ix, live, eff, sites, rows, channel, setChannel, openProduct, openGroup }) {
  const [what, setWhat] = useState('products');      // products | options
  const [shown, setShown] = useState(() => sites.map((s) => s.id));
  const [search, setSearch] = useState('');
  const [only, setOnly] = useState('differ');        // differ | outliers | all
  const [sort, setSort] = useState('pounds');
  const cols = useMemo(() => sites.filter((s) => shown.includes(s.id)), [sites, shown]);
  const all = useMemo(() => {
    if (what === 'options') return optionSpreadRows(eff || live, cols.map((s) => s.id));
    return ix ? spreadRows(ix, cols.map((s) => s.id), { channel }) : [];
  }, [what, eff, live, ix, cols, channel]);
  const open = (r) => (what === 'options' ? openGroup?.(r.product.groupId) : openProduct?.(r.product.id));
  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = all.filter((r) => (only === 'all' || (only === 'differ' ? r.spread > 0 : r.outliers.size > 0)) && (!q || String(r.label || r.product.menu_name || r.product.name).toLowerCase().includes(q)));
    if (sort === 'pct') out = [...out].sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
    if (sort === 'name') out = [...out].sort((a, b) => String(a.product.name).localeCompare(String(b.product.name)));
    return out;
  }, [all, search, only, sort]);
  const width = NAME_W + NUM_W * 4 + cols.length * SITE_W;
  const outlierCount = all.filter((r) => r.outliers.size).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
      <div style={{ ...ui.card, padding: '14px 18px' }}>
        <div style={{ fontSize: 15, fontWeight: 750, marginBottom: 2 }}>{what === 'options' ? optionSpreadSummary(all) : spreadSummary(all, all.length)}</div>
        <div style={ui.sub}>
          {outlierCount ? `${outlierCount} ${what === 'options' ? 'option' : 'product'}${outlierCount === 1 ? ' has' : 's have'} a site more than 15% off the usual price (marked). ` : ''}
          Compared across {cols.length} site{cols.length === 1 ? '' : 's'}{rows.length ? ', with the draft\'s changes in' : ''}.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Segmented small value={what} onChange={setWhat} options={[{ value: 'products', label: 'Products' }, { value: 'options', label: 'Options' }]} />
        <input aria-label={what === 'options' ? 'Search options' : 'Search products'} style={{ ...ui.input, width: 220 }} placeholder={what === 'options' ? 'Search options' : 'Search products'} value={search} onChange={(e) => setSearch(e.target.value)} />
        <Segmented small value={only} onChange={setOnly} options={[{ value: 'differ', label: 'Priced differently' }, { value: 'outliers', label: 'Outliers' }, { value: 'all', label: 'Everything' }]} />
        <select aria-label="Sort" style={{ ...ui.input, width: 190 }} value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="pounds">Widest spread first</option>
          <option value="pct">Widest in percent first</option>
          <option value="name">A to Z</option>
        </select>
        {what === 'products' && (
          <select aria-label="Showing" style={{ ...ui.input, width: 'auto', minWidth: 190 }} value={channel || ''} onChange={(e) => setChannel(e.target.value || null)}>
            <option value="">Showing: Standard price</option>
            {PUBLISHED_CHANNELS.map((k) => <option key={k} value={k}>Showing: {CHANNEL_LABELS[k]} price</option>)}
          </select>
        )}
        <Popover label={`Sites (${cols.length}/${sites.length})`} width={260}>
          <SiteChecklist sites={sites} value={shown} groups={live?.siteGroups || []} onChange={setShown} />
        </Popover>
        <div style={{ flex: 1 }} />
        <span style={ui.sub}>{list.length} {what === 'options' ? 'option' : 'product'}{list.length === 1 ? '' : 's'}</span>
      </div>

      {cols.length < 2 && <div style={{ ...ui.card, ...ui.sub }}>Pick at least two sites to compare.</div>}
      {cols.length >= 2 && <div style={{ ...ui.card, padding: 0, overflowX: 'auto' }}>
        <div style={{ minWidth: width }}>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--bdr)', background: 'var(--bg2)', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
            <div style={{ width: NAME_W, padding: '10px 14px', flexShrink: 0 }}>{what === 'options' ? 'Option (group)' : 'Product'}</div>
            {['Lowest', 'Highest', 'Spread', '%'].map((h) => <div key={h} style={{ width: NUM_W, padding: '10px 8px', textAlign: 'right', flexShrink: 0 }}>{h}</div>)}
            {cols.map((s) => <div key={s.id} title={s.name} style={{ width: SITE_W, padding: '10px 8px', textAlign: 'right', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>)}
          </div>
          <WindowedList items={list} rowHeight={38} height={560}
            empty={<div style={{ padding: 20, ...ui.sub }}>{only === 'differ' ? `Every ${what === 'options' ? 'option' : 'product'} costs the same at every site shown.` : 'Nothing to show.'}</div>}
            renderRow={(r) => {
              const at = new Map(r.prices.map((p) => [p.loc, p]));
              return (
                <div style={{ display: 'flex', alignItems: 'center', height: '100%', borderBottom: '1px solid var(--bdr)', fontSize: 13 }}>
                  <button type="button" onClick={() => open(r)} style={{ width: NAME_W, padding: '0 14px', flexShrink: 0, textAlign: 'left', background: 'none', border: 'none', color: 'var(--t1)', fontFamily: 'inherit', fontSize: 13, fontWeight: 650, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.label || r.product.menu_name || r.product.name}
                  </button>
                  <div style={{ width: NUM_W, padding: '0 8px', textAlign: 'right', flexShrink: 0 }}>{money(r.min)}</div>
                  <div style={{ width: NUM_W, padding: '0 8px', textAlign: 'right', flexShrink: 0 }}>{money(r.max)}</div>
                  <div style={{ width: NUM_W, padding: '0 8px', textAlign: 'right', flexShrink: 0, fontWeight: 750, color: r.spread > 0 ? 'var(--t1)' : 'var(--t4)' }}>{money(r.spread)}</div>
                  <div style={{ width: NUM_W, padding: '0 8px', textAlign: 'right', flexShrink: 0, color: 'var(--t3)' }}>{r.pct != null ? `${r.pct}%` : ''}</div>
                  {cols.map((s) => {
                    const p = at.get(s.id);
                    const out = r.outliers.has(s.id);
                    return (
                      <div key={s.id} style={{ width: SITE_W, padding: '0 8px', textAlign: 'right', flexShrink: 0 }}>
                        {p ? (
                          <span title={out ? `More than 15% off the usual price (${money(r.median)})` : undefined} style={{
                            padding: '2px 6px', borderRadius: 6, fontWeight: out ? 800 : 500,
                            background: out ? 'color-mix(in srgb, var(--amber, #F5A623) 18%, transparent)' : 'transparent',
                            color: out ? 'var(--t1)' : p.price === r.min && r.spread > 0 ? 'var(--acc)' : 'var(--t2)',
                          }}>{money(p.price)}</span>
                        ) : <span style={{ color: 'var(--t4)' }}>not sold</span>}
                      </div>
                    );
                  })}
                </div>
              );
            }} />
        </div>
      </div>}
    </div>
  );
}
