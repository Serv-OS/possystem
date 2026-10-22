/**
 * Print labels (multi site stock Drop 2, v5.11.93, design 2.7 and 2.11, map 4.6 and 8.3 step 7,
 * contract 3.3): the batch label and the PPDS label on the Label printer role (Hardware, Printers).
 *
 *   mode 'batch'  pick a recent batch made at this site (production_batches) or type the label:
 *                 name, Made, Use by, allergens (filled from the recipe's facts at this site when
 *                 the batch has a company recipe), Made by, Lot, quantity; copies; preview; Print.
 *   mode 'ppds'   the product's facts at this site (stock_recipe_facts): the ingredient
 *                 declaration with the allergens in bold, Use by from the shelf life, Made now.
 *                 Refused with the contract words until the facts are checked (signed off) here.
 *
 * Every label is built by lib/stock/batchLabel.js and sent by lib/labelPrint.js; the printer's own
 * column count (58 mm: 32, 80 mm: 42) is used for the paper, the preview uses the label printer
 * found on this device. A label never carries cost, a price or a method.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { getVenueClock } from '../../../lib/locationTime';
import { fmtVenueDateTime } from '../../../lib/venueDate';
import { stockApi } from '../../../lib/stock/stockApi';
import { fetchBatches } from '../../../lib/stock/production';
import { fetchRecipes } from '../../../lib/stock/recipes';
import { printLabel, labelPrinter, isNoPrinter } from '../../../lib/labelPrint';
// useByFrom is the contract's name (3.3); it is not a hook, so it is imported under a name the hooks
// lint rule does not read as one.
import {
  ALLERGEN_LABELS, ALLERGEN_ORDER, LABEL_ROLE_WORDS, NO_LABEL_PRINTER, PPDS_NOT_SIGNED_OFF,
  batchLabelDoc, declarationSegments, labelCols, labelLines, ppdsLabelDoc, repeatDoc, useByFrom as labelUseBy,
} from '../../../lib/stock/batchLabel';
import { useStockScope } from '../../StockScope';
import { Btn, Modal, Notice, Segmented, Field, ErrorLine, ui } from '../stock/stockUi';

const preview = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5, lineHeight: 1.45, background: 'var(--bg2)', border: '1px dashed var(--bdr2)', borderRadius: 10, padding: '12px 14px', color: 'var(--t1)', whiteSpace: 'pre', overflowX: 'auto' };
const chip = (on) => ({ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 9px', borderRadius: 20, fontSize: 12, cursor: 'pointer', border: `1px solid ${on ? 'var(--acc)' : 'var(--bdr2)'}`, background: on ? 'var(--acc-d)' : 'var(--bg2)', color: on ? 'var(--acc)' : 'var(--t2)' });
const two = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };

/** 'YYYY-MM-DDTHH:mm' on the device clock, what a datetime-local box holds for an instant. */
function localInput(ts) {
  const d = ts ? new Date(ts) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const toIso = (local) => { const d = local ? new Date(local) : null; return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null; };

function formFromBatch(b, madeBy) {
  return {
    name: b?.outputName || '', madeAt: localInput(b?.producedAt || null), useBy: b?.expiryAt ? String(b.expiryAt).slice(0, 10) : '',
    allergens: [], madeBy: madeBy || '', lot: b?.lotCode || '', qty: b?.actualQty ?? '', unit: b?.outputUnit || '',
  };
}

function Preview({ doc, cols }) {
  const lines = labelLines(doc);
  if (!lines.length) return <div style={{ ...preview, color: 'var(--t4)' }}>Nothing to show yet.</div>;
  return (
    <div style={{ ...preview, width: `calc(${cols}ch + 28px)`, maxWidth: '100%' }} aria-label="Label preview">
      {lines.map((l, i) => (
        <div key={i} style={{ minHeight: '1.45em' }}>
          {l.segs.map((s, k) => <span key={k} style={{ fontWeight: s.bold ? 800 : 400, fontSize: s.big ? '1.3em' : undefined }}>{s.s}</span>)}
        </div>
      ))}
    </div>
  );
}

export default function BatchLabels({ siteId, mode = 'batch', batch = null, menuItemId = null, recipeId = null, onClose, madeBy = null }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const toast = useCallback((words, type = 'success') => { try { showToast?.(words, type); } catch { /* a toast never breaks a print */ } }, [showToast]);
  const siteName = sc.siteName(siteId) || 'this site';

  const [tab, setTab] = useState(mode === 'ppds' ? 'ppds' : 'batch');
  const [tz, setTz] = useState(null);
  const [printer, setPrinter] = useState({ read: false, row: null });
  const [copies, setCopies] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // batch mode
  const [batches, setBatches] = useState([]);
  const [companyRefs, setCompanyRefs] = useState({});   // site recipe id -> company recipe id
  const [pick, setPick] = useState(batch?.id || '');
  const [form, setForm] = useState(() => formFromBatch(batch, madeBy));
  const [factsNote, setFactsNote] = useState('');

  // ppds mode
  const [ppds, setPpds] = useState({ loading: !!recipeId, row: null, recipe: null, error: null });

  useEffect(() => {
    let live = true;
    getVenueClock(siteId).then((c) => { if (live) setTz(c?.timezone || null); }).catch(() => { /* London below */ });
    labelPrinter().then((p) => { if (live) setPrinter({ read: true, row: p }); });
    return () => { live = false; };
  }, [siteId]);

  useEffect(() => {
    let live = true;
    Promise.all([fetchBatches(siteId, 100), fetchRecipes(siteId)]).then(([bs, rs]) => {
      if (!live) return;
      setBatches((bs.data || []).filter((b) => b.status === 'COMPLETED'));
      const refs = {};
      for (const r of rs.data || []) if (r.companyRef) refs[r.id] = r.companyRef;
      setCompanyRefs(refs);
    });
    return () => { live = false; };
  }, [siteId]);

  useEffect(() => {
    if (!recipeId) return undefined;
    let live = true;
    Promise.all([stockApi.recipeFacts(recipeId, [siteId]), stockApi.recipeDetail(recipeId)]).then(([f, d]) => {
      if (!live) return;
      const rows = Array.isArray(f.data?.rows) ? f.data.rows : [];
      const row = (menuItemId && rows.find((r) => r.menu_item_id === menuItemId)) || rows.find((r) => String(r.location_id) === String(siteId)) || rows[0] || null;
      // Only the facts gate the label. The recipe read gives the shelf life; when it fails (a one
      // site recipe from RecipeFactsLine, an older database) the label prints with no Use by line.
      setPpds({ loading: false, row, recipe: d.error ? null : (d.data?.recipe || null), error: f.error || null });
    });
    return () => { live = false; };
  }, [recipeId, siteId, menuItemId]);

  const cols = labelCols(printer.row);
  const field = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggleAllergen = (id) => setForm((f) => ({ ...f, allergens: f.allergens.includes(id) ? f.allergens.filter((a) => a !== id) : [...f.allergens, id] }));

  /** A recent batch picked: the label takes its words, and its recipe's facts give the allergens and use by. */
  const pickBatch = async (id) => {
    setPick(id);
    const b = batches.find((x) => x.id === id);
    if (!b) return;
    setForm((f) => ({ ...formFromBatch(b, f.madeBy || madeBy) }));
    setFactsNote('');
    const companyRef = companyRefs[b.recipeId] || null;
    if (!companyRef) { setFactsNote('No company recipe behind this batch: tick the allergens by hand.'); return; }
    const [f, d] = await Promise.all([stockApi.recipeFacts(companyRef, [siteId]), stockApi.recipeDetail(companyRef)]);
    const row = (Array.isArray(f.data?.rows) ? f.data.rows : []).find((r) => String(r.location_id) === String(siteId)) || null;
    if (f.error || !row) { setFactsNote(f.needsUpdate ? 'Allergens from the recipe need the database update: tick them by hand.' : 'No allergen facts for this batch here yet: tick them by hand.'); return; }
    const shelf = d.data?.recipe?.shelf_life_days;
    setForm((cur) => ({
      ...cur,
      allergens: Array.isArray(row.allergens) ? row.allergens : [],
      useBy: cur.useBy || labelUseBy(toIso(cur.madeAt), shelf, tz) || '',
    }));
    setFactsNote(row.needs_check ? `Check again: ${row.check_words || 'the recipe facts changed'}.` : 'Allergens from the recipe at this site.');
  };

  const batchArgs = useMemo(() => ({
    name: form.name, madeAt: toIso(form.madeAt), useBy: form.useBy || null, allergens: form.allergens, madeBy: form.madeBy,
    lot: form.lot, qty: form.qty, unit: form.unit, venueTz: tz,
  }), [form, tz]);

  const signedOff = !!ppds.row && !!ppds.row.checked_at && !ppds.row.needs_check;
  const ppdsMadeAt = useMemo(() => new Date().toISOString(), []);
  const ppdsArgs = useMemo(() => ({
    name: ppds.row?.menu_item_name || ppds.recipe?.name || '',
    ingredientsText: ppds.row?.ingredients_text || '',
    allergens: Array.isArray(ppds.row?.allergens) ? ppds.row.allergens : [],
    madeAt: ppdsMadeAt,
    useBy: labelUseBy(ppdsMadeAt, ppds.recipe?.shelf_life_days, tz),
    venueTz: tz,
    signedOff,
  }), [ppds, ppdsMadeAt, tz, signedOff]);

  const buildAt = useCallback((c) => (tab === 'batch' ? batchLabelDoc(batchArgs, { cols: c }) : ppdsLabelDoc(ppdsArgs, { cols: c })), [tab, batchArgs, ppdsArgs]);
  const shown = useMemo(() => buildAt(cols), [buildAt, cols]);
  const canPrint = tab === 'batch' ? !!form.name.trim() : (!!recipeId && signedOff && !ppds.loading);

  const print = async () => {
    if (!canPrint || busy) return;
    setBusy(true); setError(null);
    const name = tab === 'batch' ? form.name.trim() : ppdsArgs.name;
    const r = await printLabel((p, spec) => repeatDoc(buildAt(labelCols({ ...p, cols: spec?.cols })), copies), {
      label: `${tab === 'ppds' ? 'PPDS label' : 'Batch label'}: ${name}`,
      metadata: { kind: tab, location_id: siteId, recipe_id: recipeId || null, copies: Number(copies) || 1 },
    });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    toast(`${copies > 1 ? `${copies} labels` : 'Label'} sent to ${r.printer || 'the label printer'}.`);
  };

  const noPrinter = printer.read && !printer.row;

  return (
    <Modal title="Print labels" sub={`${siteName}. ${LABEL_ROLE_WORDS}`} onClose={onClose} width={820}
      footer={<>
        <label style={{ ...ui.row, gap: 6, fontSize: 12.5, color: 'var(--t3)' }}>Copies
          <input type="number" min="1" max="50" value={copies} aria-label="Copies" onChange={(e) => setCopies(Math.min(50, Math.max(1, Math.floor(Number(e.target.value) || 1))))}
            style={{ ...ui.input, width: 70, padding: '6px 8px' }} />
        </label>
        <span style={{ flex: 1 }} />
        <Btn onClick={onClose}>Close</Btn>
        <Btn kind="primary" disabled={!canPrint || busy} onClick={print}>{busy ? 'Printing…' : 'Print'}</Btn>
      </>}>
      <div style={{ marginBottom: 12 }}>
        <Segmented value={tab} onChange={setTab} options={[{ value: 'batch', label: 'Batch' }, { value: 'ppds', label: 'PPDS' }]} />
      </div>

      {noPrinter && <div style={{ marginBottom: 12 }}><Notice tone="warn">{NO_LABEL_PRINTER}</Notice></div>}
      {error && !isNoPrinter(error) && <div style={{ marginBottom: 12 }}><ErrorLine error={{ message: error }} /></div>}
      {error && isNoPrinter(error) && !noPrinter && <div style={{ marginBottom: 12 }}><Notice tone="warn">{error}</Notice></div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1fr) auto', gap: 18, alignItems: 'start' }}>
        <div>
          {tab === 'batch' && (
            <>
              <Field label="Recent batch" hint="Pick one made here, or type the label below.">
                <select value={pick} onChange={(e) => pickBatch(e.target.value)} style={ui.input} aria-label="Recent batch">
                  <option value="">Type the label</option>
                  {batches.map((b) => (
                    <option key={b.id} value={b.id}>{b.outputName || 'Batch'}: {b.actualQty != null ? `${b.actualQty} ${b.outputUnit || ''}` : ''} made {fmtVenueDateTime(b.producedAt, tz, { year: false })}</option>
                  ))}
                </select>
              </Field>
              <Field label="Name"><input value={form.name} onChange={field('name')} style={ui.input} aria-label="Name" /></Field>
              <div style={two}>
                <Field label="Made"><input type="datetime-local" value={form.madeAt} onChange={field('madeAt')} style={ui.input} aria-label="Made" /></Field>
                <Field label="Use by"><input type="date" value={form.useBy} onChange={field('useBy')} style={ui.input} aria-label="Use by" /></Field>
              </div>
              <Field label="Allergens" hint={factsNote || 'Tick what the batch contains.'}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {ALLERGEN_ORDER.map((id) => {
                    const on = form.allergens.includes(id);
                    return (
                      <label key={id} style={chip(on)}>
                        <input type="checkbox" checked={on} onChange={() => toggleAllergen(id)} style={{ margin: 0 }} />
                        {ALLERGEN_LABELS[id]}
                      </label>
                    );
                  })}
                </div>
              </Field>
              <div style={two}>
                <Field label="Made by"><input value={form.madeBy} onChange={field('madeBy')} style={ui.input} aria-label="Made by" /></Field>
                <Field label="Lot"><input value={form.lot} onChange={field('lot')} style={ui.input} aria-label="Lot" /></Field>
              </div>
              <div style={two}>
                <Field label="Quantity"><input type="text" inputMode="decimal" value={form.qty} onChange={field('qty')} style={ui.input} aria-label="Quantity" /></Field>
                <Field label="Unit"><input value={form.unit} onChange={field('unit')} style={ui.input} aria-label="Unit" /></Field>
              </div>
            </>
          )}

          {tab === 'ppds' && !recipeId && (
            <Notice tone="info">A PPDS label belongs to one product. Open the recipe, go to Allergens and nutrition, and press Print PPDS label for this site.</Notice>
          )}
          {tab === 'ppds' && recipeId && (
            <>
              {ppds.loading && <div style={ui.sub}>Loading…</div>}
              <ErrorLine error={ppds.error} />
              {!ppds.loading && !ppds.error && !ppds.row && <Notice tone="warn">No allergen facts for this product at {siteName} yet.</Notice>}
              {!ppds.loading && ppds.row && !signedOff && (
                <div style={{ marginBottom: 12 }}>
                  <Notice tone="warn">{PPDS_NOT_SIGNED_OFF}{ppds.row.needs_check && ppds.row.check_words ? ` ${ppds.row.check_words}.` : ''}</Notice>
                </div>
              )}
              {!ppds.loading && ppds.row && (
                <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
                  <div><b>{ppdsArgs.name}</b></div>
                  <div style={ui.sub}>Ingredients, in weight order, allergens in bold:</div>
                  <div style={{ lineHeight: 1.5 }}>
                    <span>Ingredients: </span>
                    {ppdsArgs.ingredientsText
                      ? declarationSegments(ppdsArgs.ingredientsText).map((s, k) => <span key={k} style={{ fontWeight: s.bold ? 800 : 400 }}>{s.s}</span>)
                      : <span style={{ color: 'var(--t4)' }}>none listed</span>}
                  </div>
                  <div style={ui.sub}>
                    {signedOff ? `Checked by ${ppds.row.checked_by_name || 'someone'}` : 'Not checked yet'}
                    {ppds.recipe?.shelf_life_days != null ? ` · Shelf life ${ppds.recipe.shelf_life_days} days` : ' · No shelf life set, so no Use by line'}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div>
          <div style={{ ...ui.label }}>Preview{printer.row ? ` (${printer.row.name || 'label printer'}, ${cols} columns)` : ''}</div>
          <Preview doc={shown} cols={cols} />
        </div>
      </div>
    </Modal>
  );
}
