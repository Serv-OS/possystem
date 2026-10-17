// src/backoffice/sections/msm/MsmChangePrices.jsx
//
// MULTI SITE MENU (v5.11.75): the Change prices tool. Peter, 17 Oct 2026: "choose a product, a
// category or the entire menu and say increase price by an amount or a percent, then say which
// locations or all locations".
//
// One panel, top to bottom: what (products, categories or the whole menu), the change (up or down
// by pounds or a percent, or set to an exact price), the rounding, the sites, then a preview of
// every price before and after at every site. Apply puts the changes in the draft; nothing reaches
// a till until the draft is published (with its own per site preview).
//
// The maths is supabase/functions/_shared/msmPrice.js (pure, tested): whole pence, half up,
// rounding never against the change, never below zero; at All sites the group price moves and
// every site that follows it moves too; at chosen sites each site's own price changes.

import { useEffect, useMemo, useState } from 'react';
import { applyPriceChange, priceChangeWords } from '../../../../supabase/functions/_shared/msmPrice.js';
import { categoryTree, CHANNEL_LABELS, channelLabel } from '../../../lib/msm/msmGrid';
import { withBefore, withoutUnticked } from '../../../lib/msm/msmEdit';
import { withMargins, vatMaps } from '../../../lib/msm/msmMargin';
import { normName } from '../../../../supabase/functions/_shared/msmModel.js';
import { groupHints } from '../../../../supabase/functions/_shared/msmSites.js';
import { Btn, Modal, Segmented, SiteChecklist, Field, Notice, Pill, WindowedList } from './msmUi';
import { ui, money } from './msmStyle';

const ROW_H = 36;

export default function MsmChangePrices({ api, menu, live, eff, ix, sites, stage, editable, costs, channel: gridChannel, initialScope, reload, setNote, onClose }) {
  const start = initialScope || { all: true };
  const [scopeMode, setScopeMode] = useState(start.productIds?.length ? 'products' : start.categoryIds?.length ? 'categories' : 'all');
  const [productIds, setProductIds] = useState(start.productIds || []);
  const [categoryIds, setCategoryIds] = useState(start.categoryIds || []);
  const [includeSizes, setIncludeSizes] = useState(true);
  const [direction, setDirection] = useState('up');
  const [mode, setMode] = useState('percent');
  const [value, setValue] = useState('');
  const [channel, setChannel] = useState(gridChannel || null);
  const [rounding, setRounding] = useState('none');
  const [endings, setEndings] = useState([5, 9]);
  const [siteMode, setSiteMode] = useState('all');
  const [chosen, setChosen] = useState(() => sites.map((s) => s.id));
  const [offProducts, setOffProducts] = useState(() => new Set());
  const [offSites, setOffSites] = useState(() => new Set());
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [showGp, setShowGp] = useState(false);
  const [find, setFind] = useState('');
  const [saving, setSaving] = useState(false);
  const [groupName, setGroupName] = useState(null);   // saving the chosen sites as a group
  const hints = useMemo(() => groupHints(live, 20).slice(0, 2), [live]);
  const saveGroup = async () => {
    const r = await api.saveSiteGroup(menu.id, { name: groupName, locationIds: chosen });
    if (!r.ok) { setNote?.({ tone: 'bad', text: r.words }); return; }
    setGroupName(null);
    setNote?.({ tone: 'good', text: `Saved the sites as "${r.data?.name || groupName}". It shows in every list of sites.` });
    reload?.();
  };
  const tree = useMemo(() => categoryTree(ix), [ix]);
  const siteName = useMemo(() => new Map(sites.map((s) => [s.id, s.name])), [sites]);

  // The preview is worked out a moment after typing stops (a whole menu at 20 sites is thousands of
  // prices), so typing "10" never stutters on an iPad.
  const [valueDeb, setValueDeb] = useState(value);
  useEffect(() => { const t = setTimeout(() => setValueDeb(value), 250); return () => clearTimeout(t); }, [value]);
  const parseValue = (v) => (v === '' ? null : Number(String(v).replace(/^[£$€]/, '')));
  // A cut of 100% or more would take every price to 0.00: refused. A rise up to 500%.
  const okValue = (n) => n != null && Number.isFinite(n) && n >= 0 && (mode !== 'percent' || (mode === 'percent' && (direction === 'down' ? n < 100 : n <= 500)));
  const valueOk = okValue(parseValue(value));
  const valueNum = parseValue(valueDeb);
  const debOk = okValue(valueNum);
  const scope = scopeMode === 'all' ? { all: true, includeSizes } : scopeMode === 'products' ? { productIds, includeSizes } : { categoryIds, includeSizes };
  const scopeEmpty = (scopeMode === 'products' && !productIds.length) || (scopeMode === 'categories' && !categoryIds.length);
  const siteList = siteMode === 'all' ? 'all' : chosen;

  const result = useMemo(() => {
    if (!debOk || !valueOk || scopeEmpty || (siteMode === 'chosen' && !chosen.length)) return null;
    return applyPriceChange(eff, {
      scope, channel,
      change: { direction, mode, value: valueNum },
      rounding: rounding === 'none' ? { mode: 'none' } : rounding === '5p' ? { mode: '5p' } : { mode: 'ending', endings },
      sites: siteList,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eff, scopeMode, productIds, categoryIds, includeSizes, direction, mode, valueNum, valueOk, debOk, channel, rounding, endings, siteMode, chosen]);

  // A new preview starts with everything ticked.
  useEffect(() => { setOffProducts(new Set()); setOffSites(new Set()); }, [result]);
  useEffect(() => { if (showGp) costs.load(sites.map((s) => s.id)); }, [showGp, costs, sites]);

  const rows = useMemo(() => {
    if (!result) return [];
    return showGp ? withMargins(result.rows, eff, costs.byLoc, vatMaps(eff, costs.ratesByLoc || {})) : result.rows;
  }, [result, showGp, eff, costs.byLoc, costs.ratesByLoc]);
  const groups = useMemo(() => {
    const by = new Map();
    for (const r of rows) {
      if (!by.has(r.productId)) by.set(r.productId, []);
      by.get(r.productId).push(r);
    }
    return [...by.entries()].map(([pid, list]) => ({ pid, list, changed: list.some((r) => r.changed) }))
      .filter((g) => showUnchanged || g.changed);
  }, [rows, showUnchanged]);

  const changes = result ? withoutUnticked(result.changes, offProducts, offSites) : [];
  // What reaches the tills: site prices on sale (never the group price row, never a site where it is off).
  const ticked = rows.filter((r) => !offProducts.has(r.productId) && !(r.locationId && offSites.has(`${r.productId}|${r.locationId}`)));
  const counted = ticked.filter((r) => r.changed && r.locationId && !r.off);
  const summary = result ? {
    prices: counted.length,
    sites: new Set(counted.map((r) => r.locationId)).size,
    clears: ticked.filter((r) => r.changed && r.clears).length,
    clamped: counted.filter((r) => r.clamped).length,
    offSites: new Set(ticked.filter((r) => r.off && r.staged).map((r) => r.locationId)).size,
  } : null;
  const pinnedCount = result && !channel ? new Set(rows.filter((r) => r.locationId && r.pinned?.length && !r.off).map((r) => r.productId)).size : 0;

  // The preview as one flat list (a product line, then its sites), drawn only where it is on screen.
  const flat = useMemo(() => {
    const out = [];
    for (const g of groups) {
      out.push({ kind: 'product', g });
      for (const r of g.list) if (showUnchanged || r.changed) out.push({ kind: 'site', g, r });
    }
    return out;
  }, [groups, showUnchanged]);

  const apply = async () => {
    if (!changes.length) return;
    setSaving(true);
    const r = await stage(withBefore(live, changes), { done: `Change prices: ${priceChangeWords(summary)}. They are in the draft; publish to send them to the tills.` });
    setSaving(false);
    if (r?.ok) onClose();
  };

  const matches = useMemo(() => {
    const q = normName(find);
    if (!q) return [];
    return [...ix.products.values()].filter((p) => !p.archived && !productIds.includes(p.id) && normName(p.menu_name || p.name).includes(q)).slice(0, 8);
  }, [find, ix, productIds]);

  const diffWords = (r) => {
    if (r.before == null || r.after == null) return '';
    const d = Math.round((r.after - r.before) * 100) / 100;
    if (!d) return '';
    const pct = r.before ? Math.round((d / r.before) * 1000) / 10 : null;
    return `${d > 0 ? '+' : ''}${d.toFixed(2)}${pct != null ? ` (${d > 0 ? '+' : ''}${pct}%)` : ''}`;
  };

  return (
    <Modal title="Change prices" width={980} onClose={onClose} dirty={value !== ""} dirtyWords="The change you typed is not in the draft yet."
      sub="Pick what, by how much and where. Nothing reaches a till until the draft is published."
      footer={(
        <>
          <div style={{ flex: 1, fontSize: 13.5, fontWeight: 700 }} data-testid="msm-price-summary">
            {summary ? priceChangeWords(summary) : 'Fill in the change to see every price before and after.'}
          </div>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" disabled={!editable || saving || !changes.length} onClick={apply}>{saving ? 'Adding…' : `Add ${summary?.prices || 0} price change${summary?.prices === 1 ? '' : 's'} to the draft`}</Btn>
        </>
      )}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, marginBottom: 14 }}>
        {/* 1. What */}
        <div style={ui.card}>
          <div style={ui.h2}>1. What</div>
          <div style={{ margin: '8px 0 10px' }}>
            <Segmented small value={scopeMode} onChange={setScopeMode} options={[{ value: 'products', label: 'Products' }, { value: 'categories', label: 'Categories' }, { value: 'all', label: 'Whole menu' }]} />
          </div>
          {scopeMode === 'products' && (
            <div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {productIds.map((id) => (
                  <Pill key={id} tone="neutral">{ix.products.get(id)?.menu_name || ix.products.get(id)?.name || 'Product'}
                    <button type="button" aria-label="Remove" onClick={() => setProductIds((l) => l.filter((x) => x !== id))} style={{ background: 'none', border: 'none', color: 'var(--t3)', cursor: 'pointer', padding: 0, marginLeft: 2 }}>×</button>
                  </Pill>
                ))}
              </div>
              <input style={ui.input} placeholder="Add a product: type its name" value={find} onChange={(e) => setFind(e.target.value)} />
              {matches.map((p) => <div key={p.id}><Btn small kind="link" onClick={() => { setProductIds((l) => [...l, p.id]); setFind(''); }}>+ {p.menu_name || p.name}</Btn></div>)}
            </div>
          )}
          {scopeMode === 'categories' && (
            <div style={{ maxHeight: 180, overflowY: 'auto' }}>
              {tree.map((t) => (
                <label key={t.id} style={{ ...ui.row, padding: `3px 0 3px ${t.depth * 14}px`, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={categoryIds.includes(t.id)} onChange={() => setCategoryIds((l) => (l.includes(t.id) ? l.filter((x) => x !== t.id) : [...l, t.id]))} />
                  {t.label}
                </label>
              ))}
              <div style={{ ...ui.sub, fontSize: 11.5, marginTop: 4 }}>A category includes the categories under it.</div>
            </div>
          )}
          {scopeMode === 'all' && <div style={ui.sub}>Every product in the group menu.</div>}
          <label style={{ ...ui.row, fontSize: 12.5, marginTop: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={includeSizes} onChange={(e) => setIncludeSizes(e.target.checked)} /> Sizes follow their product
          </label>
        </div>

        {/* 2. The change */}
        <div style={ui.card}>
          <div style={ui.h2}>2. The change</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0 10px' }}>
            {mode !== 'set' && <Segmented small value={direction} onChange={setDirection} options={[{ value: 'up', label: 'Up' }, { value: 'down', label: 'Down' }]} />}
            <Segmented small value={mode} onChange={setMode} options={[{ value: 'percent', label: 'By %' }, { value: 'amount', label: 'By £' }, { value: 'set', label: 'Set to £' }]} />
          </div>
          <Field label={mode === 'percent' ? 'Percent' : mode === 'set' ? 'New price' : 'Amount'} style={{ marginBottom: 10 }}>
            <input aria-label="Change value" style={{ ...ui.input, width: 140 }} inputMode="decimal" placeholder={mode === 'percent' ? '5' : '0.20'} value={value} onChange={(e) => setValue(e.target.value)} />
            {value !== '' && !valueOk && <div style={{ ...ui.err, marginTop: 4 }}>{mode === 'percent' ? (direction === 'down' ? 'A cut must be less than 100%.' : 'Type a percent between 0 and 500.') : 'Type pounds and pence, like 0.20.'}</div>}
          </Field>
          <Field label="Which price" style={{ marginBottom: 0 }}>
            <select style={ui.input} value={channel || ''} onChange={(e) => setChannel(e.target.value || null)}>
              <option value="">In store</option>
              {Object.entries(CHANNEL_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
        </div>

        {/* 3. Rounding */}
        <div style={ui.card}>
          <div style={ui.h2}>3. Rounding</div>
          <div style={{ margin: '8px 0 10px' }}>
            <Segmented small value={rounding} onChange={setRounding} options={[{ value: 'none', label: 'To the penny' }, { value: '5p', label: 'Nearest 5p' }, { value: 'ending', label: 'Ending in' }]} />
          </div>
          {rounding === 'ending' && (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => {
                const on = endings.includes(d);
                return <button key={d} type="button" onClick={() => setEndings((l) => (on ? l.filter((x) => x !== d) : [...l, d].sort()))}
                  style={{ width: 30, height: 30, borderRadius: 8, border: `1px solid ${on ? 'var(--acc)' : 'var(--bdr2)'}`, background: on ? 'var(--acc-d)' : 'transparent', color: on ? 'var(--acc)' : 'var(--t3)', fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' }}>{d}</button>;
              })}
              <div style={{ ...ui.sub, fontSize: 11.5, width: '100%', marginTop: 4 }}>The last digit of the pence, so 5 and 9 give prices like 2.85 or 2.89.</div>
            </div>
          )}
          <div style={{ ...ui.sub, fontSize: 11.5, marginTop: 6 }}>Rounding never goes against the change: a rise never ends lower, a cut never ends higher. An exact price is never rounded.</div>
        </div>

        {/* 4. Sites */}
        <div style={ui.card}>
          <div style={ui.h2}>4. Sites</div>
          <div style={{ margin: '8px 0 10px' }}>
            <Segmented small value={siteMode} onChange={setSiteMode} options={[{ value: 'all', label: 'All sites' }, { value: 'chosen', label: 'Chosen sites' }]} />
          </div>
          {siteMode === 'all'
            ? <div style={ui.sub}>The group price changes, and every site's own price changes with it.{mode === 'set' ? ' Set to clears each site\'s own price, so every site charges the new one.' : ''}</div>
            : (
              <>
                <SiteChecklist sites={sites} groups={live?.siteGroups || []} value={chosen} onChange={setChosen} />
                {editable && chosen.length > 1 && groupName === null && <Btn small kind="link" style={{ marginTop: 6 }} onClick={() => setGroupName('')}>Save these sites as a group</Btn>}
                {groupName !== null && (
                  <div style={{ ...ui.row, marginTop: 8 }}>
                    <input autoFocus style={ui.input} maxLength={60} placeholder="Like City sites" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
                    <Btn small kind="primary" disabled={!groupName.trim()} onClick={saveGroup}>Save</Btn>
                    <Btn small onClick={() => setGroupName(null)}>Cancel</Btn>
                  </div>
                )}
                {hints.map((h) => (
                  <div key={`${h.a}|${h.b}`} style={{ ...ui.sub, fontSize: 11.5, marginTop: 6 }}>
                    {siteName.get(h.a) || 'A site'} and {siteName.get(h.b) || 'another'} share {h.shared} prices of their own.{' '}
                    <Btn small kind="link" onClick={() => setChosen([h.a, h.b])}>Pick both</Btn>
                  </div>
                ))}
              </>
            )}
        </div>
      </div>

      {/* 5. Preview */}
      <div style={{ ...ui.row, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ ...ui.h2, flex: 1 }}>5. Preview</div>
        <label style={{ ...ui.row, fontSize: 12.5, cursor: 'pointer' }}><input type="checkbox" checked={showGp} onChange={(e) => setShowGp(e.target.checked)} /> GP before and after</label>
        <label style={{ ...ui.row, fontSize: 12.5, cursor: 'pointer' }}><input type="checkbox" checked={showUnchanged} onChange={(e) => setShowUnchanged(e.target.checked)} /> Show prices that stay the same</label>
      </div>
      {!result && <Notice>Type the change above to see every price.</Notice>}
      {result && !groups.length && <Notice>No price changes. {mode === 'set' ? 'Every price is already that.' : 'Try a bigger change or a different rounding.'}</Notice>}
      {result && pinnedCount > 0 && (
        <div style={{ marginBottom: 8 }}><Notice>{pinnedCount} product{pinnedCount === 1 ? ' has' : 's have'} a price set separately for a channel (such as Eat in), which the till charges first. Those stay as they are; pick that price under "Which price" to change it too.</Notice></div>
      )}
      {result && groups.length > 0 && (
        <div style={{ border: '1px solid var(--bdr)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ display: 'flex', background: 'var(--bg2)', color: 'var(--t3)', fontSize: 11.5, fontWeight: 700, height: ROW_H, alignItems: 'center' }}>
            <div style={{ ...cellL, flex: 1 }}>Product and site</div>
            <div style={cellR}>Before</div><div style={cellR}>After</div><div style={cellR}>Change</div>
            {showGp && <div style={{ ...cellR, width: 130 }}>GP before → after</div>}
          </div>
          <WindowedList items={flat} rowHeight={ROW_H} height={420} renderRow={(item) => {
            if (item.kind === 'product') {
              const p = ix.products.get(item.g.pid);
              const pOff = offProducts.has(item.g.pid);
              return (
                <div style={{ display: 'flex', alignItems: 'center', height: '100%', borderTop: '1px solid var(--bdr)', background: 'var(--bg1)', fontSize: 13, fontWeight: 750 }}>
                  <label style={{ ...ui.row, ...cellL, cursor: 'pointer', flex: 1, minWidth: 0 }}>
                    <input type="checkbox" checked={!pOff} onChange={() => setOffProducts((st) => { const n = new Set(st); if (n.has(item.g.pid)) n.delete(item.g.pid); else n.add(item.g.pid); return n; })} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p?.menu_name || p?.name}</span>
                  </label>
                </div>
              );
            }
            const r = item.r;
            const k = `${r.productId}|${r.locationId}`;
            const pOff = offProducts.has(r.productId);
            const canUntick = !!r.locationId && !!r.staged;
            const off = pOff || (r.locationId && offSites.has(k));
            return (
              <div style={{ display: 'flex', alignItems: 'center', height: '100%', borderTop: '1px solid var(--bdr)', fontSize: 13, opacity: off ? 0.4 : 1 }}>
                <label style={{ ...ui.row, ...cellL, paddingLeft: 34, cursor: canUntick ? 'pointer' : 'default', flex: 1, minWidth: 0, overflow: 'hidden' }}>
                  {canUntick && <input type="checkbox" checked={!off} disabled={pOff} onChange={() => setOffSites((st) => { const n = new Set(st); if (n.has(k)) n.delete(k); else n.add(k); return n; })} />}
                  <span style={{ whiteSpace: 'nowrap' }}>{r.locationId ? siteName.get(r.locationId) || 'Site' : `Group price (${channelLabel(channel)})`}</span>
                  {r.follows && r.locationId && <Pill>follows the group price</Pill>}
                  {r.clears && <Pill tone="blue">back on the group price</Pill>}
                  {r.off && <Pill>off at this site: kept in step</Pill>}
                  {r.clamped && <Pill tone="bad">stopped at 0.00</Pill>}
                  {!channel && r.locationId && r.pinned?.length > 0 && <Pill tone="warn" title="The till charges this channel price first; it stays as it is">{r.pinned.map((c) => CHANNEL_LABELS[c] || c).join(', ')} set separately: stays</Pill>}
                </label>
                <div style={{ ...cellR, color: 'var(--t3)' }}>{money(r.before)}</div>
                <div style={{ ...cellR, fontWeight: 750 }}>{money(r.after)}</div>
                <div style={{ ...cellR, color: r.after > r.before ? 'var(--grn, var(--acc))' : r.after < r.before ? 'var(--red)' : 'var(--t4)' }}>{diffWords(r)}</div>
                {showGp && <div style={{ ...cellR, width: 130, fontSize: 12 }}>{gpWords(r)}</div>}
              </div>
            );
          }} />
        </div>
      )}
    </Modal>
  );
}

const cellL = { padding: '0 12px', boxSizing: 'border-box' };
const cellR = { width: 90, padding: '0 12px', textAlign: 'right', flexShrink: 0, boxSizing: 'border-box' };
const gpWords = (r) => {
  if (!r.locationId) return '';
  const a = r.gpBefore, b = r.gpAfter;
  if (!a || !b) return '…';
  if (a.noRecipe) return 'No recipe';
  if (a.gpPct == null || b.gpPct == null) return 'No price';
  return `${a.gpPct}% → ${b.gpPct}%`;
};
