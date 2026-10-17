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
import { withMargins } from '../../../lib/msm/msmMargin';
import { normName } from '../../../../supabase/functions/_shared/msmModel.js';
import { groupHints } from '../../../../supabase/functions/_shared/msmSites.js';
import { Btn, Modal, Segmented, SiteChecklist, Field, Notice, Pill } from './msmUi';
import { ui, money } from './msmStyle';

const SHOW_MAX = 250;

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

  const valueNum = value === '' ? null : Number(String(value).replace(/^[£$€]/, ''));
  const valueOk = valueNum != null && Number.isFinite(valueNum) && valueNum >= 0 && (mode !== 'percent' || valueNum <= 500);
  const scope = scopeMode === 'all' ? { all: true, includeSizes } : scopeMode === 'products' ? { productIds, includeSizes } : { categoryIds, includeSizes };
  const scopeEmpty = (scopeMode === 'products' && !productIds.length) || (scopeMode === 'categories' && !categoryIds.length);
  const siteList = siteMode === 'all' ? 'all' : chosen;

  const result = useMemo(() => {
    if (!valueOk || scopeEmpty || (siteMode === 'chosen' && !chosen.length)) return null;
    return applyPriceChange(eff, {
      scope, channel,
      change: { direction, mode, value: valueNum },
      rounding: rounding === 'none' ? { mode: 'none' } : rounding === '5p' ? { mode: '5p' } : { mode: 'ending', endings },
      sites: siteList,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eff, scopeMode, productIds, categoryIds, includeSizes, direction, mode, valueNum, valueOk, channel, rounding, endings, siteMode, chosen]);

  // A new preview starts with everything ticked.
  useEffect(() => { setOffProducts(new Set()); setOffSites(new Set()); }, [result]);
  useEffect(() => { if (showGp) costs.load(sites.map((s) => s.id)); }, [showGp, costs, sites]);

  const rows = useMemo(() => {
    if (!result) return [];
    return showGp ? withMargins(result.rows, eff, costs.byLoc, {}) : result.rows;
  }, [result, showGp, eff, costs.byLoc]);
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
  const counted = rows.filter((r) => r.changed && !offProducts.has(r.productId) && !(r.locationId && offSites.has(`${r.productId}|${r.locationId}`)));
  const summary = result ? {
    prices: counted.length,
    sites: new Set(counted.filter((r) => r.locationId).map((r) => r.locationId)).size,
    clears: counted.filter((r) => r.clears).length,
    clamped: counted.filter((r) => r.clamped).length,
  } : null;

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
    <Modal title="Change prices" width={980} onClose={onClose}
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
            {value !== '' && !valueOk && <div style={{ ...ui.err, marginTop: 4 }}>{mode === 'percent' ? 'Type a percent between 0 and 500.' : 'Type pounds and pence, like 0.20.'}</div>}
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
      {result && groups.length > 0 && (
        <div style={{ border: '1px solid var(--bdr)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--bg2)', color: 'var(--t3)', fontSize: 11.5, textAlign: 'left' }}>
                <th style={th}>Product and site</th><th style={{ ...th, textAlign: 'right' }}>Before</th><th style={{ ...th, textAlign: 'right' }}>After</th><th style={{ ...th, textAlign: 'right' }}>Change</th>
                {showGp && <th style={{ ...th, textAlign: 'right' }}>GP before → after</th>}
              </tr>
            </thead>
            <tbody>
              {groups.slice(0, SHOW_MAX).map((g) => {
                const p = ix.products.get(g.pid);
                const pOff = offProducts.has(g.pid);
                return [
                  <tr key={g.pid} style={{ background: 'var(--bg1)', borderTop: '1px solid var(--bdr)' }}>
                    <td style={{ ...td, fontWeight: 750 }} colSpan={showGp ? 5 : 4}>
                      <label style={{ ...ui.row, cursor: 'pointer' }}>
                        <input type="checkbox" checked={!pOff} onChange={() => setOffProducts((s) => { const n = new Set(s); if (n.has(g.pid)) n.delete(g.pid); else n.add(g.pid); return n; })} />
                        {p?.menu_name || p?.name}
                      </label>
                    </td>
                  </tr>,
                  ...g.list.filter((r) => showUnchanged || r.changed).map((r) => {
                    const k = `${r.productId}|${r.locationId}`;
                    const canUntick = r.locationId && !r.follows;
                    const off = pOff || (r.locationId && offSites.has(k));
                    return (
                      <tr key={k} style={{ opacity: off ? 0.4 : 1, borderTop: '1px solid var(--bdr)' }}>
                        <td style={{ ...td, paddingLeft: 34 }}>
                          <label style={{ ...ui.row, cursor: canUntick ? 'pointer' : 'default' }}>
                            {canUntick && <input type="checkbox" checked={!off} disabled={pOff} onChange={() => setOffSites((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })} />}
                            <span>{r.locationId ? siteName.get(r.locationId) || 'Site' : `Group price (${channelLabel(channel)})`}</span>
                            {r.follows && r.locationId && <Pill>follows the group price</Pill>}
                            {r.clears && <Pill tone="blue">back on the group price</Pill>}
                            {r.clamped && <Pill tone="bad">stopped at 0.00</Pill>}
                          </label>
                        </td>
                        <td style={{ ...td, textAlign: 'right', color: 'var(--t3)' }}>{money(r.before)}</td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 750 }}>{money(r.after)}</td>
                        <td style={{ ...td, textAlign: 'right', color: r.after > r.before ? 'var(--grn, var(--acc))' : r.after < r.before ? 'var(--red)' : 'var(--t4)' }}>{diffWords(r)}</td>
                        {showGp && <td style={{ ...td, textAlign: 'right', fontSize: 12 }}>{gpWords(r)}</td>}
                      </tr>
                    );
                  }),
                ];
              })}
            </tbody>
          </table>
          {groups.length > SHOW_MAX && <div style={{ padding: 10, ...ui.sub }}>Showing the first {SHOW_MAX} products of {groups.length}. Every one is included.</div>}
        </div>
      )}
    </Modal>
  );
}

const th = { padding: '9px 12px', fontWeight: 700 };
const td = { padding: '7px 12px', verticalAlign: 'middle' };
const gpWords = (r) => {
  if (!r.locationId) return '';
  const a = r.gpBefore, b = r.gpAfter;
  if (!a || !b) return '…';
  if (a.noRecipe) return 'No recipe';
  if (a.gpPct == null || b.gpPct == null) return 'No price';
  return `${a.gpPct}% → ${b.gpPct}%`;
};
