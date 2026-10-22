// src/backoffice/sections/produce/RecipeSitesTab.jsx
//
// MULTI SITE STOCK Drop 2 (mockup scrRecipe 'sites', contract 3.2): one row per site in this login's
// list. Where the recipe is on, the till product it is linked to there, the sale price there (from
// the menu, read only), the cost and GP there (stock_recipe_cost, live), the target, what sold in
// the last 7 days; a batch or prep recipe adds How (Bought in, Made here, Made to order) and Holds.
//
//   On tick       stock_set_recipe_sites { on: true }: the site recipe, every ingredient, pack and
//                 bridge ticked there, in one transaction ('<recipe> is on at <site>. <n> ingredients
//                 were ticked there.')
//   On untick     asks first, then { on: false }: the till link goes, the site recipe is archived,
//                 the items stay on (the item rule decides their life)
//   Till product  that site's own menu (fetchSiteStockContext), the smart match offered first
//   How           stock_batch_set_how; 'Made to order' is refused while the site holds the made item
//                 (the Not yet dialog with the database's words)
//
// Company editors change all of it; everyone else sees it read only (RecipePage draws the lock
// line). The database decides (stock_co__guard, need 'company'); the screen only greys.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../../store';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { money } from '../../../lib/currency';
import { fetchSiteStockContext } from '../../../lib/stock/siteContext';
import { queuedNote } from '../../../lib/stock/itemPageRules';
import { siteRowModel, pctWords, tickWords, untickWords, notYetWords, HOW_CHOICES, HOW_WORDS, costWords } from '../../../lib/stock/recipeRules';
import { sellableMenuItems, suggestTillProduct } from '../../../lib/stock/recipeMatch';
import { Btn, Pill, Modal, Notice, TableWrap, Th, SavedTick, useConfirm, ui } from '../stock/stockUi';

const tdStyle = { padding: '9px 10px', borderBottom: '1px solid var(--bdr)', fontSize: 13, verticalAlign: 'top' };
const num = { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', textAlign: 'right' };
const grey = { color: 'var(--t4)' };
const selectStyle = { ...ui.input, width: 'auto', maxWidth: 240, padding: '5px 8px', fontSize: 12.5 };
const STRIP = 'How a recipe reaches a site: tick it here, or add the product to that site in the Multi site menu and its recipe ticks there by itself. Ticking a site also ticks every ingredient it needs there.';
const NOTE = 'Sale price here comes from the menu (read only). Where GP is under target, Price for target GP shows what the price would need to be.';

export default function RecipeSitesTab({ detail, editable = false, reload, focusSiteId = null }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const recipe = useMemo(() => detail?.recipe || {}, [detail]);
  const madeRecipe = (recipe.kind || 'dish') !== 'dish';
  const sites = useMemo(() => [...(sc.sites || []), ...(sc.showClosed ? (sc.closedSites || []) : [])], [sc.sites, sc.closedSites, sc.showClosed]);
  const [costs, setCosts] = useState({ key: null, map: null, error: null });
  const [menus, setMenus] = useState({});   // siteId -> 'loading' | [{ id, name, price }]
  const [busy, setBusy] = useState(null);
  const [savedKey, setSavedKey] = useState(null);
  const [errors, setErrors] = useState({});
  const [notYet, setNotYet] = useState(null);
  const [confirm, confirmDialog] = useConfirm();
  const rowRefs = useRef({});
  const savedTimer = useRef(null);
  const version = detail?.row_version ?? recipe.row_version ?? null;
  const say = (words, tone = 'success') => { try { showToast?.(words, tone); } catch { /* no toast, no harm */ } };
  const withQueue = (words, r) => { const note = queuedNote(r?.queued); return note ? `${words} ${note}` : words; };
  const setRowError = (siteId, words) => setErrors((e) => ({ ...e, [siteId]: words || null }));

  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);
  useEffect(() => {
    if (!focusSiteId) return;
    const el = rowRefs.current[focusSiteId];
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusSiteId]);
  const flash = (key) => {
    setSavedKey(key);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedKey(null), 2000);
  };

  // the live cost at every site the recipe is on: one stock_recipe_cost call, read again after each save
  const costKey = JSON.stringify([recipe.id, version]);
  useEffect(() => {
    if (!recipe.id) return undefined;
    let live = true;
    stockApi.recipeCost(recipe.id, null, null).then((r) => {
      if (!live) return;
      const map = new Map((r.data?.rows || []).map((row) => [row.location_id, row]));
      setCosts({ key: costKey, map: r.error ? null : map, error: r.error || null });
    });
    return () => { live = false; };
  }, [recipe.id, costKey]);
  const costMap = costs.key === costKey ? costs.map : null;
  const models = useMemo(() => {
    const map = costs.key === costKey ? costs.map : null;
    return sites.map((s) => siteRowModel(s, detail, map));
  }, [sites, detail, costs, costKey]);

  const loadMenu = useCallback(async (siteId) => {
    if (!siteId || menus[siteId]) return;
    setMenus((m) => ({ ...m, [siteId]: 'loading' }));
    const r = await fetchSiteStockContext(siteId);
    const rows = sellableMenuItems(r?.menuItems || []);
    const suggested = suggestTillProduct({ recipe, sites: detail?.sites || [], menuItems: r?.menuItems || [], siteId });
    setMenus((m) => ({ ...m, [siteId]: { rows, suggested } }));
  }, [menus, recipe, detail]);

  const run = async (m, changes, okWords, key) => {
    setBusy(key);
    setRowError(m.siteId, null);
    const r = await stockApi.setRecipeSites(recipe.id, changes, version, 'produce');
    setBusy(null);
    if (r.error) { setRowError(m.siteId, r.error.message); if (!r.conflict) say(r.error.message, 'error'); await reload?.(); return null; }
    const refused = (r.data?.refused || []).find((x) => x.location_id === m.siteId) || (r.data?.refused || [])[0];
    if (refused) { setRowError(m.siteId, refused.error); say(refused.error, 'error'); await reload?.(); return null; }
    flash(key);
    say(withQueue(typeof okWords === 'function' ? okWords(r.data) : okWords, r));
    await reload?.();
    return r.data;
  };

  const tickOn = (m) => run(m, [{ location_id: m.siteId, on: true }], (data) => {
    const site = (data?.sites || []).find((s) => s.location_id === m.siteId);
    return tickWords(recipe.name, m.name, site?.items_added ?? 0);
  }, `${m.siteId}|on`);
  const askUntick = async (m) => {
    const ok = await confirm({ title: untickWords(recipe.name, m.name), words: 'The ingredients ticked for it stay on at that site.', yes: `Take it off ${m.name}`, no: 'Go back', danger: true });
    if (!ok) return;
    run(m, [{ location_id: m.siteId, on: false }], `${recipe.name} is off at ${m.name}. Its sales there show under Recipe missing.`, `${m.siteId}|on`);
  };
  const linkProduct = (m, menuItemId) => {
    if (!menuItemId || menuItemId === m.menuItemId) return;
    const name = (menus[m.siteId]?.rows || []).find((x) => x.id === menuItemId)?.name || 'that product';
    run(m, [{ location_id: m.siteId, menu_item_id: menuItemId }], `Till product at ${m.name}: ${name}. Sales of it there take stock off through ${recipe.name}.`, `${m.siteId}|product`);
  };
  const setHow = async (m, how) => {
    if (!how || how === m.how) return;
    const key = `${m.siteId}|how`;
    setBusy(key);
    setRowError(m.siteId, null);
    const r = await stockApi.batchSetHow(recipe.id, m.siteId, how, version);
    setBusy(null);
    if (r.error) {
      const ny = notYetWords(r.error);
      if (ny) setNotYet(ny); else { setRowError(m.siteId, r.error.message); say(r.error.message, 'error'); }
      await reload?.();
      return;
    }
    flash(key);
    say(withQueue(`${m.name} gets ${recipe.name}: ${HOW_WORDS[how] || how}.`, r));
    await reload?.();
  };

  const cols = madeRecipe ? 11 : 9;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
      {confirmDialog}
      <Notice tone="info">{STRIP}</Notice>
      {sc.canOpen?.('multi-site-menu') && (
        <div><Btn small kind="link" onClick={() => sc.go('multi-site-menu')}>Open the Multi site menu</Btn></div>
      )}
      {costs.error && costs.key === costKey && <div style={ui.err}>Costs did not load: {costs.error.message}</div>}

      <TableWrap minWidth={madeRecipe ? 1320 : 1120}>
        <thead>
          <tr>
            <Th>On</Th>
            <Th>Site</Th>
            <Th>Till product</Th>
            <Th right hint="From the menu at that site. Change it in Menu Manager.">Sale price here</Th>
            <Th right hint="Costed now, from what this site pays its suppliers.">Cost here</Th>
            <Th right>GP here</Th>
            <Th right>Target</Th>
            <Th right>Sold, 7 days</Th>
            {madeRecipe && <Th hint="Bought in from a kitchen or supplier, made here in logged batches, or made to order (the sale takes the raw ingredients).">How</Th>}
            {madeRecipe && <Th right hint="What the site holds of the made item.">Holds</Th>}
          </tr>
        </thead>
        <tbody>
          {models.map((m) => {
            const focus = focusSiteId && focusSiteId === m.siteId;
            const rowStyle = focus ? { background: 'var(--bg2)', boxShadow: 'inset 3px 0 0 var(--acc)' } : undefined;
            const canTick = editable && !recipe.archived_at;
            const err = errors[m.siteId];
            const onKey = `${m.siteId}|on`;
            const tick = (
              <input type="checkbox" checked={m.on} disabled={!canTick || busy === onKey}
                aria-label={m.on ? `Used at ${m.name}` : `Use at ${m.name}`}
                onChange={(e) => { if (e.target.checked) tickOn(m); else askUntick(m); }} />
            );
            if (!m.on) {
              return (
                <Fragment key={m.siteId}>
                  <tr ref={(el) => { rowRefs.current[m.siteId] = el; }} style={rowStyle}>
                    <td style={tdStyle}>{tick}</td>
                    <td style={{ ...tdStyle, ...grey }}>{m.name}</td>
                    <td style={{ ...tdStyle, ...grey }} colSpan={cols - 2}>{busy === onKey ? 'Switching on…' : 'Not used here'}</td>
                  </tr>
                  {err && <tr><td colSpan={cols} style={{ ...tdStyle, ...ui.err, paddingTop: 0 }}>{err}</td></tr>}
                </Fragment>
              );
            }
            const menu = menus[m.siteId];
            const rows = menu && menu !== 'loading' ? menu.rows : [];
            const suggested = menu && menu !== 'loading' ? menu.suggested : null;
            const current = m.menuItemId && !rows.some((x) => x.id === m.menuItemId) ? [{ id: m.menuItemId, name: m.menuItemName || 'Linked product' }] : [];
            const ordered = [...current, ...(suggested ? rows.filter((x) => x.id === suggested) : []), ...rows.filter((x) => x.id !== suggested)];
            return (
              <Fragment key={m.siteId}>
                <tr ref={(el) => { rowRefs.current[m.siteId] = el; }} style={rowStyle}>
                  <td style={tdStyle}>{tick}</td>
                  <td style={{ ...tdStyle, minWidth: 150 }}>
                    <div style={{ fontWeight: 700, color: 'var(--t1)' }}>{m.name}</div>
                    {m.why && <div style={{ fontSize: 11.5, color: 'var(--blu, var(--t3))', marginTop: 2 }}>{m.why}</div>}
                    {m.needsCheck && <div style={{ marginTop: 4 }}><Pill tone="warn">Check again</Pill></div>}
                  </td>
                  <td style={tdStyle}>
                    <select aria-label={`Till product at ${m.name}`} value={m.menuItemId || ''} disabled={!editable || !!busy}
                      onFocus={() => loadMenu(m.siteId)} onMouseDown={() => loadMenu(m.siteId)}
                      onChange={(e) => linkProduct(m, e.target.value)} style={{ ...selectStyle, opacity: editable ? 1 : 0.55 }}>
                      {!m.menuItemId && <option value="">Not linked yet</option>}
                      {ordered.map((x) => <option key={x.id} value={x.id}>{x.name}{x.id === suggested && x.id !== m.menuItemId ? ' (suggested)' : ''}</option>)}
                      {menu === 'loading' && <option value="" disabled>Loading…</option>}
                    </select>
                    {savedKey === `${m.siteId}|product` && <SavedTick />}
                  </td>
                  <td style={{ ...tdStyle, ...num }}>{m.salePrice != null ? money(m.salePrice, m.currency) : <span style={grey}>No price</span>}</td>
                  <td style={{ ...tdStyle, ...num }}>
                    {costMap == null && costs.key !== costKey ? <span style={grey}>…</span> : m.cost != null ? costWords(m.cost, m.currency) : <span style={grey}>Not costed</span>}
                    {m.missing.length > 0 && <div style={{ fontSize: 11, color: 'var(--red)' }}>{m.missing.length} line{m.missing.length === 1 ? '' : 's'} not costed</div>}
                  </td>
                  <td style={{ ...tdStyle, ...num }}>
                    {m.gpPct != null ? pctWords(m.gpPct) : <span style={grey}>None</span>}
                    {m.under && <Pill tone="warn" style={{ marginLeft: 6 }}>Under</Pill>}
                    {m.under && m.priceForTarget != null && <div style={{ fontSize: 11, color: 'var(--t3)', whiteSpace: 'normal' }}>Price for target GP: {money(m.priceForTarget, m.currency)}</div>}
                  </td>
                  <td style={{ ...tdStyle, ...num }}>{m.target != null ? pctWords(m.target) : <span style={grey}>None</span>}</td>
                  <td style={{ ...tdStyle, ...num }}>{m.sold7d != null ? Number(m.sold7d).toLocaleString('en-GB') : <span style={grey}>0</span>}</td>
                  {madeRecipe && (
                    <td style={tdStyle}>
                      <select aria-label={`How ${m.name} gets ${recipe.name}`} value={m.how || 'batches'} disabled={!editable || !!busy}
                        onChange={(e) => setHow(m, e.target.value)} style={{ ...selectStyle, opacity: editable ? 1 : 0.55 }}>
                        {HOW_CHOICES.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
                      </select>
                      {savedKey === `${m.siteId}|how` && <SavedTick />}
                    </td>
                  )}
                  {madeRecipe && <td style={{ ...tdStyle, ...num }}>{m.holds != null ? `${Math.round(m.holds * 1000) / 1000} ${recipe.yield_unit || ''}`.trim() : <span style={grey}>0</span>}</td>}
                </tr>
                {err && <tr><td colSpan={cols} style={{ ...tdStyle, ...ui.err, paddingTop: 0 }}>{err}</td></tr>}
              </Fragment>
            );
          })}
        </tbody>
      </TableWrap>
      <div style={ui.sub}>{NOTE}</div>

      {notYet && (
        <Modal title={notYet.title} onClose={() => setNotYet(null)} width={480}
          footer={<><span style={{ flex: 1 }} /><Btn kind="primary" onClick={() => setNotYet(null)}>OK</Btn></>}>
          <div style={{ fontSize: 13.5, color: 'var(--t1)', lineHeight: 1.5 }}>{notYet.words}</div>
          <div style={{ ...ui.sub, marginTop: 8 }}>{notYet.note}</div>
        </Modal>
      )}
    </div>
  );
}
