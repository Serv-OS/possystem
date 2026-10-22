// src/backoffice/sections/produce/RecipeMissing.jsx
//
// MULTI SITE STOCK Drop 2 (mockup scrRecipes 'missing', contract 3.2): till products that sold in
// the last 7 venue days with no live recipe link, per site, from stock_recipe_missing
// (sales_day_sums, never closed_checks). Each row carries the database's suggestion (the same msm
// product, the same master id, or the name within 15% on price). They never link by themselves:
// tick and Link matched calls stock_recipe_link_products, which switches the recipe on at that site
// when it is not and links the till product. A No match row takes a recipe picked by hand.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../../store';
import { money } from '../../../lib/currency';
import { stockApi } from '../../../lib/stock/stockApi';
import { siteList, sortSites, pageSites } from '../../../lib/stock/itemListRules';
import { daysHeldWords } from '../../../lib/stock/recipeRules';
import { suggestWords, linksOf, rowKey } from '../../../lib/stock/recipeMatch';
import { useStockScope } from '../../StockScope';
import { Btn, Notice, TableWrap, Th, Td, ShowMore, ErrorLine, EmptyLine, ui } from '../stock/stockUi';
import { SearchPick } from './RecipeLinesEditor';

const grey = { color: 'var(--t4)' };
const card = { ...ui.card, padding: '4px 16px' };

// Rendered as <RecipeMissing orgCtx={orgCtx} /> (contract 3.2). The database stamps the login's name
// on each link itself (why_on 'Linked under Recipe missing by <name>'), so nothing is read from orgCtx.
export default function RecipeMissing({ onOpen = null } = {}) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const say = useCallback((words, tone = 'success') => { try { showToast?.(words, tone); } catch { /* no toast, no harm */ } }, [showToast]);
  const orgId = sc.orgId;
  const oneId = sc.oneSite?.id || null;
  const editor = !!sc.canEditCompany('produce');
  const sites = useMemo(() => sortSites(siteList(sc.scopeSites, sc.siteName)), [sc.scopeSites, sc.siteName]);
  const siteIds = useMemo(() => sites.map((s) => s.id), [sites]);
  const sitesArg = useMemo(() => pageSites({ isAll: !!sc.isAll && !oneId, showClosed: !!sc.showClosed, scopeIds: siteIds }), [sc.isAll, sc.showClosed, oneId, siteIds]);
  const cur = (oneId ? sites.find((s) => s.id === oneId)?.currency : sites[0]?.currency) || undefined;

  const [page, setPage] = useState({ key: null, rows: [], next: null, total: null, daysHeld: null, error: null });
  const [moreBusy, setMoreBusy] = useState(false);
  const [ticked, setTicked] = useState(() => new Set());
  const [picked, setPicked] = useState({});   // rowKey -> { recipe_id, name }
  const [fromSite, setFromSite] = useState({});   // recipe id -> the name of another site it is on
  const [refused, setRefused] = useState({});   // rowKey -> words
  const [busy, setBusy] = useState(false);
  const [again, setAgain] = useState(0);
  const key = JSON.stringify([orgId, sitesArg, again]);
  const keyRef = useRef(key);
  useEffect(() => { keyRef.current = key; }, [key]);

  useEffect(() => {
    if (!orgId) return undefined;
    let live = true;
    stockApi.recipeMissing({ orgId, sites: sitesArg, after: null }).then((r) => {
      if (!live) return;
      const rows = r.data?.rows || [];
      setPage({ key, rows, next: r.data?.next || null, total: r.data?.total ?? rows.length, daysHeld: r.data?.days_held ?? null, error: r.error || null });
      // the suggested rows start ticked, as the mockup shows
      setTicked(new Set(rows.filter((x) => x.suggested?.recipe_id).map(rowKey)));
      setRefused({});
    });
    return () => { live = false; };
  }, [orgId, sitesArg, key]);

  const loading = page.key !== key;
  const rows = useMemo(() => (loading ? [] : page.rows), [loading, page.rows]);

  // "Use <site>'s recipe here": where the suggested recipe is on today (one recipesPage read per page of ids)
  useEffect(() => {
    const ids = [...new Set(rows.map((r) => r.suggested).filter((s) => s && (s.how === 'msm' || s.how === 'master')).map((s) => s.recipe_id))].filter((id) => !(id in fromSite));
    if (!ids.length || !orgId) return undefined;
    let live = true;
    (async () => {
      const out = {};
      for (let i = 0; i < ids.length; i += 100) {
        const r = await stockApi.recipesPage({ orgId, sites: null, search: null, filters: { ids: ids.slice(i, i + 100) }, after: null, limit: 100 });
        if (r.error) break;
        for (const rec of r.data?.rows || []) {
          const on = (rec.sites || []).filter((s) => s.on && s.menu_item_id);
          out[rec.id] = on.length ? (sc.siteName(on[0].location_id) || '') : '';
        }
      }
      for (const id of ids) if (!(id in out)) out[id] = '';
      if (live) setFromSite((m) => ({ ...m, ...out }));
    })();
    return () => { live = false; };
  }, [rows, orgId, fromSite, sc]);

  const more = async () => {
    if (!page.next || moreBusy) return;
    const at = key;
    setMoreBusy(true);
    const r = await stockApi.recipeMissing({ orgId, sites: sitesArg, after: page.next });
    setMoreBusy(false);
    if (r.error) { say(r.error.message, 'error'); return; }
    setPage((p) => {
      if (p.key !== at) return p;
      const have = new Set(p.rows.map(rowKey));
      const fresh = (r.data?.rows || []).filter((x) => !have.has(rowKey(x)));
      return { ...p, rows: [...p.rows, ...fresh], next: r.data?.next || null };
    });
    setTicked((t) => { const n = new Set(t); for (const x of r.data?.rows || []) if (x.suggested?.recipe_id) n.add(rowKey(x)); return n; });
  };

  const flip = (k) => setTicked((t) => { const n = new Set(t); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const recipeOf = (row) => picked[rowKey(row)]?.recipe_id || row.suggested?.recipe_id || null;
  const linkable = rows.filter((r) => ticked.has(rowKey(r)) && recipeOf(r));

  const linkMatched = async () => {
    const { links, over } = linksOf(rows, ticked, Object.fromEntries(Object.entries(picked).map(([k, v]) => [k, v.recipe_id])));
    if (!links.length) { say('Tick a row with a recipe first.', 'info'); return; }
    setBusy(true);
    const r = await stockApi.linkProducts(links, 'produce');
    setBusy(false);
    if (r.error) { say(r.error.message, 'error'); return; }
    const bad = r.data?.refused || [];
    const words = {};
    for (const x of bad) words[`${x.location_id}|${x.menu_item_id}`] = x.error || 'Not linked.';
    setRefused(words);
    const n = Number(r.data?.linked) || 0;
    if (n > 0) say(`Linked. Sales from now on take stock off through the recipe.${bad.length ? ` ${bad.length} did not link.` : ''}${over ? ` ${over} more wait for another press.` : ''}`, bad.length ? 'warning' : 'success');
    else if (bad.length) say(bad[0].error || 'Nothing was linked.', 'error');
    if (!bad.length) setAgain((a) => a + 1);
    else {
      // keep the refused rows on screen with their words; drop the linked ones
      const gone = new Set(links.filter((l) => !bad.some((b) => b.location_id === l.location_id && b.menu_item_id === l.menu_item_id)).map((l) => `${l.location_id}|${l.menu_item_id}`));
      setPage((p) => ({ ...p, rows: p.rows.filter((x) => !gone.has(rowKey(x))), total: p.total == null ? null : Math.max(0, p.total - gone.size) }));
      setTicked((t) => new Set([...t].filter((k) => !gone.has(k))));
    }
  };

  const searchRecipes = useCallback(async (text) => {
    const r = await stockApi.recipesPage({ orgId, sites: null, search: text || null, filters: null, after: null, limit: 20 });
    return (r.data?.rows || []).map((x) => ({ id: x.id, name: x.name, hint: x.kind === 'dish' ? '' : (x.kind || '') }));
  }, [orgId]);

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Notice tone="info">
          <b>Till products that sold with no recipe.</b> They never link by themselves (that would suddenly start taking stock off). Tick and <b>Link matched</b>.
        </Notice>
      </div>
      {!loading && page.daysHeld != null && <div style={{ ...ui.sub, marginBottom: 8 }}>{daysHeldWords(page.daysHeld)}</div>}
      {page.error && !loading && <div style={{ marginBottom: 12 }}><ErrorLine error={page.error} /></div>}

      {loading ? <div style={card}><EmptyLine>Loading…</EmptyLine></div> : !rows.length ? <div style={card}><EmptyLine>Every till product that sold here has a recipe. Nothing waits.</EmptyLine></div> : (
        <>
          <TableWrap minWidth={900}>
            <thead>
              <tr>
                <Th><span aria-hidden="true" /></Th>
                <Th>Site</Th>
                <Th>Till product</Th>
                <Th right>Sold, 7 days</Th>
                <Th right>Sales value</Th>
                <Th>Suggested recipe</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const k = rowKey(row);
                const rec = recipeOf(row);
                const pickedName = picked[k]?.name || null;
                const words = pickedName || suggestWords(row, { fromSiteName: row.suggested ? fromSite[row.suggested.recipe_id] || '' : '' });
                const bad = refused[k];
                return (
                  <tr key={k}>
                    <Td>
                      <input type="checkbox" checked={ticked.has(k) && !!rec} disabled={!editor || !rec || busy} aria-label={`Link ${row.name}`} onChange={() => flip(k)} />
                    </Td>
                    <Td>{row.site_name || sc.siteName(row.location_id) || ''}</Td>
                    <Td strong>{row.name}</Td>
                    <Td right num>{row.sold_7d != null ? Number(row.sold_7d).toLocaleString('en-GB') : ''}</Td>
                    <Td right num>{row.sales_7d_net != null ? money(row.sales_7d_net, cur) : ''}</Td>
                    <Td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {rec ? <span>{words}</span> : <span style={grey}>No match</span>}
                        {rec && typeof onOpen === 'function' && (
                          <Btn small kind="link" onClick={() => onOpen(rec, { tab: 'sites', siteId: row.location_id || null })}>Open recipe</Btn>
                        )}
                        {editor && (
                          <SearchPick label="" placeholder="Pick a recipe" search={searchRecipes} style={{ width: 220 }}
                            onPick={(r) => { if (!r) return; setPicked((p) => ({ ...p, [k]: { recipe_id: r.id, name: r.name } })); setTicked((t) => new Set([...t, k])); }} />
                        )}
                      </div>
                      {bad && <div style={{ ...ui.err, marginTop: 4 }}>{bad}</div>}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
            {editor && <Btn kind="primary" disabled={busy || !linkable.length} onClick={linkMatched}>{busy ? 'Linking…' : 'Link matched'}</Btn>}
            {editor && linkable.length > 0 && <span style={ui.sub}>{linkable.length} ticked</span>}
            {!editor && <span style={ui.sub}>Linking a recipe is a company change. Ask {sc.editorsText || 'head office'}.</span>}
          </div>
          <div style={{ marginTop: 6 }}><ShowMore next={page.next} busy={moreBusy} onMore={more} /></div>
        </>
      )}
    </div>
  );
}
