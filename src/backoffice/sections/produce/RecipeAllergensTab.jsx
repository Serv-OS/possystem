// src/backoffice/sections/produce/RecipeAllergensTab.jsx
//
// MULTI SITE STOCK Drop 2 (mockup scrRecipe 'allergens', map 4.24, contract 3.2): the facts of one
// recipe per site, from stock_recipe_facts: rolled up from the supplier items each site actually
// buys, through every batch. Columns Site, Allergens (the shown set: what was typed on the menu
// plus what the recipe says, never fewer), May contain, Kcal, Checked. 'Check again: <words>' when
// a supplier item changed or an allergen left the recipe; Checked (stock_facts_signoff) stamps who
// and when at that site. A From expander names each ingredient's supplier item. Print PPDS label
// prints once the recipe is checked at that site (web-batches' BatchLabels in PPDS mode).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../../store';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { getLocationConfig } from '../../../lib/locationTime';
import { fmtVenueDate } from '../../../lib/venueDate';
import { allergenWords, factsWords, signedOff, PPDS_NOT_CHECKED, costSiteOf } from '../../../lib/stock/recipeRules';
import { Btn, Pill, TableWrap, Th, Td, ErrorLine, EmptyLine, ui } from '../stock/stockUi';
import BatchLabels from './BatchLabels';

const NOTE = 'Rolled up per site from the supplier items each site actually buys. Ingredient declaration in weight order with allergens in bold, for PPDS labels. Every channel reads it: till, kiosk, online, QR, printed menus, HubRise.';
const grey = { color: 'var(--t4)' };

/** The declaration with every *word* in bold (the label renderer's marks). */
export function Declaration({ text }) {
  const t = String(text || '');
  if (!t) return <span style={grey}>No ingredient declaration yet: the supplier items need their ingredients typed in.</span>;
  const parts = t.split(/(\*[^*]+\*)/g).filter(Boolean);
  return <span>{parts.map((p, i) => (p.startsWith('*') && p.endsWith('*') ? <b key={i}>{p.slice(1, -1)}</b> : <span key={i}>{p}</span>))}</span>;
}

export default function RecipeAllergensTab({ detail, editable = false }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const say = (words, tone = 'success') => { try { showToast?.(words, tone); } catch { /* no toast, no harm */ } };
  const recipe = detail?.recipe || {};
  const [state, setState] = useState({ rows: [], error: null, loading: true });
  const [open, setOpen] = useState({});
  const [busy, setBusy] = useState(null);
  const [label, setLabel] = useState(null);   // { siteId, menuItemId }
  const [tz, setTz] = useState(null);
  const seq = useRef(0);
  const homeSite = costSiteOf(detail, sc.homeSite);

  useEffect(() => {
    if (!homeSite) return undefined;
    let live = true;
    getLocationConfig(homeSite).then((c) => { if (live) setTz(c?.timezone || null); }).catch(() => {});
    return () => { live = false; };
  }, [homeSite]);

  const load = useCallback(async () => {
    if (!recipe.id) return;
    const mine = ++seq.current;
    const r = await stockApi.recipeFacts(recipe.id, null);
    if (mine !== seq.current) return;
    setState({ rows: r.error ? [] : (r.data?.rows || []), error: r.error || null, loading: false });
  }, [recipe.id]);
  useEffect(() => {
    if (!recipe.id) return undefined;
    let live = true;
    const mine = ++seq.current;
    stockApi.recipeFacts(recipe.id, null).then((r) => {
      if (!live || mine !== seq.current) return;
      setState({ rows: r.error ? [] : (r.data?.rows || []), error: r.error || null, loading: false });
    });
    return () => { live = false; };
  }, [recipe.id]);

  // only sites in this login's list, in the list's order
  const rows = useMemo(() => {
    const order = new Map((sc.sites || []).map((s, i) => [s.id, i]));
    return [...state.rows].filter((r) => !sc.multi || order.has(r.location_id)).sort((a, b) => (order.get(a.location_id) ?? 999) - (order.get(b.location_id) ?? 999));
  }, [state.rows, sc.sites, sc.multi]);

  const check = async (row) => {
    const key = `${row.location_id}|check`;
    setBusy(key);
    const r = await stockApi.factsSignoff(row.location_id, row.menu_item_id, 'produce');
    setBusy(null);
    if (r.error) { say(r.error.message, 'error'); return; }
    const who = r.data?.checked_by_name || 'you';
    say(`Checked by ${who} at ${row.site_name || sc.siteName(row.location_id)}. Every channel there shows these allergens.`);
    await load();
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
      <ErrorLine error={state.error} />
      {state.loading ? <div style={ui.card}><EmptyLine>Loading…</EmptyLine></div> : rows.length === 0 ? (
        <div style={ui.card}><EmptyLine>No facts yet. Tick a site on the Sites tab and the recipe's allergens roll up there.</EmptyLine></div>
      ) : (
        <TableWrap minWidth={900}>
          <thead>
            <tr>
              <Th>Site</Th>
              <Th>Allergens</Th>
              <Th>May contain</Th>
              <Th right hint="A portion, from the portion weight and cooking yield.">Kcal</Th>
              <Th>Checked</Th>
              <Th><span aria-hidden="true" /></Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const w = factsWords(row, tz);
              const canCheck = !!row.menu_item_id && sc.canEditSite(row.location_id, 'site_facts');
              const isOpen = !!open[row.location_id];
              const signed = signedOff(row);
              const siteName = row.site_name || sc.siteName(row.location_id) || 'Site';
              return (
                <RowGroup key={`${row.location_id}|${row.menu_item_id || ''}`} isOpen={isOpen}>
                  <tr>
                    <Td strong>
                      <div>{siteName}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 2 }}>{row.menu_item_name || 'Not linked to a till product here'}</div>
                    </Td>
                    <Td strong>{allergenWords(row.allergens) || <span style={{ ...grey, fontWeight: 400 }}>None from the ingredients yet</span>}</Td>
                    <Td>{allergenWords(row.may_contain) || <span style={grey}>None</span>}</Td>
                    <Td right num>{row.kcal != null ? Math.round(Number(row.kcal)) : <span style={grey} title={row.kcal_complete === false ? 'Not enough data: an ingredient has no calories yet' : undefined}>Not yet</span>}</Td>
                    <Td>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        {w.state === 'check_again' ? <Pill tone="warn">{w.words}</Pill> : w.state === 'checked' ? <span>{w.words}</span> : <span style={grey}>{w.words}</span>}
                        {canCheck && w.state !== 'checked' && <Btn small kind="primary" disabled={busy === `${row.location_id}|check`} onClick={() => check(row)}>{busy === `${row.location_id}|check` ? 'Saving…' : 'Checked'}</Btn>}
                        {canCheck && w.state === 'checked' && editable && <Btn small kind="ghost" disabled={!!busy} onClick={() => check(row)}>Check again</Btn>}
                      </div>
                    </Td>
                    <Td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <Btn small kind="link" onClick={() => setOpen((o) => ({ ...o, [row.location_id]: !isOpen }))}>{isOpen ? 'Hide' : 'From'}</Btn>
                        <Btn small kind="soft" disabled={!signed || !row.menu_item_id} title={signed ? undefined : PPDS_NOT_CHECKED}
                          onClick={() => setLabel({ siteId: row.location_id, menuItemId: row.menu_item_id })}>Print PPDS label</Btn>
                      </div>
                    </Td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={6} style={{ padding: '8px 12px 14px', background: 'var(--bg2)', borderBottom: '1px solid var(--bdr)' }}>
                        <div style={{ display: 'grid', gap: 10 }}>
                          <div>
                            <div style={ui.label}>From</div>
                            {(row.from || []).length === 0 ? <div style={ui.sub}>No supplier items carry facts for these ingredients yet.</div> : (
                              <table style={{ borderCollapse: 'collapse', fontSize: 12.5 }}>
                                <thead><tr>{['Ingredient', 'Supplier', 'Allergens', 'May contain', 'Changed'].map((h) => <th key={h} style={{ textAlign: 'left', padding: '4px 10px 4px 0', color: 'var(--t3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em' }}>{h}</th>)}</tr></thead>
                                <tbody>
                                  {(row.from || []).map((f, i) => (
                                    <tr key={`${f.item_name}|${f.supplier_name}|${i}`}>
                                      <td style={{ padding: '3px 10px 3px 0', color: 'var(--t1)' }}>{f.item_name}</td>
                                      <td style={{ padding: '3px 10px 3px 0', color: 'var(--t2)' }}>{f.supplier_name || <span style={grey}>Own facts</span>}</td>
                                      <td style={{ padding: '3px 10px 3px 0' }}>{allergenWords(f.allergens) || <span style={grey}>None</span>}</td>
                                      <td style={{ padding: '3px 10px 3px 0' }}>{allergenWords(f.may_contain) || <span style={grey}>None</span>}</td>
                                      <td style={{ padding: '3px 0', color: 'var(--t3)' }}>{f.changed_at ? fmtVenueDate(f.changed_at, tz, { year: false }) : ''}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                          <div>
                            <div style={ui.label}>Ingredient declaration</div>
                            <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--t1)' }}><Declaration text={row.ingredients_text} /></div>
                          </div>
                          {(row.diets || []).length > 0 && <div style={ui.sub}>Suitable for: {row.diets.map((d) => String(d).replace(/_/g, ' ')).join(', ')}</div>}
                          {row.nutrition && <Nutrition n={row.nutrition} portionG={row.portion_g} />}
                        </div>
                      </td>
                    </tr>
                  )}
                </RowGroup>
              );
            })}
          </tbody>
        </TableWrap>
      )}
      <div style={ui.sub}>{NOTE}</div>
      {label && <BatchLabels siteId={label.siteId} mode="ppds" menuItemId={label.menuItemId} recipeId={recipe.id} onClose={() => setLabel(null)} />}
    </div>
  );
}

function RowGroup({ children }) { return <>{children}</>; }

const NUTRITION = [['kcal', 'kcal'], ['fat_g', 'Fat (g)'], ['saturates_g', 'of which saturates (g)'], ['carbs_g', 'Carbs (g)'], ['sugars_g', 'of which sugars (g)'], ['protein_g', 'Protein (g)'], ['salt_g', 'Salt (g)'], ['fibre_g', 'Fibre (g)']];

/** Nutrition a portion, each figure or 'Not yet' when incomplete. */
function Nutrition({ n, portionG }) {
  return (
    <div>
      <div style={ui.label}>Nutrition a portion{portionG != null ? ` (${Math.round(Number(portionG))} g)` : ''}</div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5 }}>
        {NUTRITION.map(([k, label]) => (
          <span key={k}><span style={{ color: 'var(--t3)' }}>{label}</span> <b>{n?.[k] != null ? Math.round(Number(n[k]) * 10) / 10 : 'Not yet'}</b></span>
        ))}
      </div>
    </div>
  );
}
