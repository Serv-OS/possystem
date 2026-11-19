// src/backoffice/sections/headoffice/HqTargets.jsx
//
// Head office, Targets: the red, amber, green band for every figure the scorecard colours. One
// row per metric (src/lib/hq/targets.js HQ_METRICS): a company band (location_id null) that every
// site reads, and a site override picked from the select above the table. The rule and the
// words are the lib's (bandProblem, bandWords); this file reads, saves and draws. Only a company
// owner (the database's own answer, isCompanyOwner) may change a band; everyone else reads.

import { useEffect, useMemo, useState } from 'react';
import { fetchTargets, saveTarget, deleteTarget, isCompanyOwner, NOT_SET_UP_2 } from '../../../lib/hq/data.js';
import { HQ_METRICS, HQ_TARGET_DEFAULTS, bandProblem, bandWords, resolveTargets } from '../../../lib/hq/targets.js';
import {
  page, card, mono, accBtn, smallBtn, field, th, td, disabled, exactMoney, NA,
  PageHead, Chip, AbsentCard, AmberLine, GreenLine, LoadingLine, Field,
} from './hqUi';

/** The unit in plain words, with the company's currency for money. */
export function unitWords(unit, currency) {
  if (unit === '%') return '%';
  if (unit === '/10') return 'out of 10';
  if (unit === '/5') return 'out of 5';
  if (unit === 'days') return 'days';
  if (unit === 'money') return currency || 'money';
  return unit || '';
}

/** How a band number reads in the colour words: "60%", "4.5", "2 days", "$1,500". */
export function fmtFor(unit, currency) {
  if (unit === '%') return (n) => `${n}%`;
  if (unit === 'days') return (n) => `${n} day${Number(n) === 1 ? '' : 's'}`;
  if (unit === 'money') return (n) => exactMoney(n, currency);
  return (n) => String(n);
}

const str = (v) => (v === null || v === undefined ? '' : String(v));

export default function HqTargets({ hq }) {
  const [state, setState] = useState({ loading: true, absent: false, error: null, rows: [], isOwner: false });
  const [tick, setTick] = useState(0);
  const [siteId, setSiteId] = useState('');
  const [savedKey, setSavedKey] = useState(null);   // which band just saved, so its Saved line survives the reload
  // Slice 4: a site override reads money in that site's own currency; the company band in the active venue's.
  const currency = (siteId && typeof hq.currencyOf === 'function' && hq.currencyOf(siteId)) || hq.currency;
  const companyCurrencies = useMemo(() => [...new Set((hq.sites || []).map((s) => (typeof hq.currencyOf === 'function' ? hq.currencyOf(s.id) : null)).filter(Boolean))], [hq]);

  useEffect(() => {
    let live = true;
    Promise.all([fetchTargets(hq.orgId), isCompanyOwner(hq.orgId)]).then(([t, owner]) => {
      if (!live) return;
      if (t.absent) { setState((s) => ({ ...s, loading: false, absent: true, error: t.message })); return; }
      setState({ loading: false, absent: false, error: t.error ? t.message : null, rows: t.data || [], isOwner: owner === true });
    });
    return () => { live = false; };
  }, [hq.orgId, tick]);
  const reload = () => setTick((n) => n + 1);

  const companyRows = useMemo(() => new Map(state.rows.filter((r) => !r.location_id).map((r) => [r.metric, r])), [state.rows]);
  const siteRows = useMemo(() => new Map(state.rows.filter((r) => siteId && r.location_id === siteId).map((r) => [r.metric, r])), [state.rows, siteId]);
  const resolved = useMemo(() => resolveTargets(state.rows, siteId || null), [state.rows, siteId]);
  const site = hq.sites.find((s) => s.id === siteId) || null;

  const sub = 'Green, amber, red for every figure the scorecard colours. The company band applies everywhere; a site override wins at that site.';
  if (state.absent) {
    return (
      <div style={page}>
        <PageHead title="Targets" sub={sub} />
        <AbsentCard message={state.error || NOT_SET_UP_2} />
      </div>
    );
  }

  return (
    <div style={page}>
      <PageHead title="Targets" sub={sub}
        right={<Field label="Override for site" style={{ minWidth: 240 }}><select style={field} value={siteId} onChange={(e) => setSiteId(e.target.value)}><option value="">None, company bands only</option>{hq.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>} />
      {state.loading && <LoadingLine>Loading</LoadingLine>}
      <AmberLine>{state.error}</AmberLine>
      {!state.loading && !state.isOwner && <AmberLine>Only a company owner can change targets.</AmberLine>}
      <div style={{ fontSize: 12.5, color: 'var(--t3)', marginBottom: 12 }}>
        Green to: the figure is green up to (or from) this number. Amber to: amber up to (or from) this one. Past it the figure is red. Money targets are in {currency}.
        {companyCurrencies.length > 1 && !siteId && ` This company's sites use ${companyCurrencies.join(' and ')}: a money figure in the company band is read as that number in each site's own currency. Pick a site to give it a band of its own.`}
      </div>

      <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
          <thead><tr>
            <th style={{ ...th, minWidth: 220 }}>Metric</th><th style={th}>Unit</th><th style={{ ...th, minWidth: 260 }}>Company band</th>
            <th style={{ ...th, minWidth: 260 }}>{site ? `${site.name} override` : 'Site override'}</th><th style={{ ...th, minWidth: 220 }}>Colours{site ? ` at ${site.name}` : ''}</th>
          </tr></thead>
          <tbody>
            {HQ_METRICS.map((m) => {
              const company = companyRows.get(m.key) || null;
              const siteRow = siteRows.get(m.key) || null;
              const def = HQ_TARGET_DEFAULTS[m.key] || null;
              const words = bandWords(m.key, resolved[m.key], fmtFor(m.unit, currency));
              return (
                <tr key={m.key}>
                  <td style={{ ...td, verticalAlign: 'top' }}>
                    <div style={{ fontWeight: 600 }}>{m.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 3, lineHeight: 1.5, maxWidth: 260 }}>{m.hint}</div>
                  </td>
                  <td style={{ ...td, ...mono, verticalAlign: 'top', color: 'var(--t3)' }}>{unitWords(m.unit, currency)}</td>
                  <td style={{ ...td, verticalAlign: 'top' }}>
                    <BandEditor key={`c|${m.key}|${company?.id || 'none'}|${str(company?.green_to)}|${str(company?.amber_to)}`}
                      hq={hq} metric={m} row={company} fallback={def} locationId={null} canEdit={state.isOwner} justSaved={savedKey === `c|${m.key}`} onSaved={(did) => { setSavedKey(did ? `c|${m.key}` : null); reload(); }}
                      chip={<Chip tone={company ? 'acc' : 't3'}>{company ? 'set' : 'default'}</Chip>} />
                  </td>
                  <td style={{ ...td, verticalAlign: 'top' }}>
                    {siteId ? (
                      <BandEditor key={`s|${m.key}|${siteId}|${siteRow?.id || 'none'}|${str(siteRow?.green_to)}|${str(siteRow?.amber_to)}`}
                        hq={hq} metric={m} row={siteRow} fallback={null} locationId={siteId} canEdit={state.isOwner} justSaved={savedKey === `s|${m.key}|${siteId}`} onSaved={(did) => { setSavedKey(did ? `s|${m.key}|${siteId}` : null); reload(); }}
                        chip={siteRow ? <Chip tone="orn">override</Chip> : <Chip tone="t4">company band</Chip>} />
                    ) : <span style={{ fontSize: 12, color: 'var(--t4)' }}>Pick a site above</span>}
                  </td>
                  <td style={{ ...td, verticalAlign: 'top' }}>
                    {words ? <ColourWords words={words} source={resolved[m.key]?.source} /> : <span style={{ fontSize: 12, color: 'var(--t4)' }}>No colour until a target is set.</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ColourWords({ words, source }) {
  const line = (color, label, text) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: color, display: 'inline-block' }} />
      <span style={{ color: 'var(--t3)', minWidth: 44 }}>{label}</span>
      <span style={{ ...mono, color: 'var(--t1)' }}>{text}</span>
    </div>
  );
  return (
    <div style={{ display: 'grid', gap: 3 }}>
      {line('var(--grn)', 'Green', words.grn)}
      {line('var(--orn)', 'Amber', words.orn)}
      {line('var(--red)', 'Red', words.red)}
      {source && <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 2 }}>{source === 'site' ? 'From the site override' : source === 'company' ? 'From the company band' : 'The built in default'}</div>}
    </div>
  );
}

/**
 * Two boxes and a Save for one band (company or site). Prefilled from the row, else the default,
 * else blank. The parent keys this on the row's values so a reload resets the boxes.
 */
function BandEditor({ hq, metric, row, fallback, locationId, canEdit, justSaved = false, onSaved, chip }) {
  const [g, setG] = useState(str(row?.green_to ?? fallback?.green_to));
  const [a, setA] = useState(str(row?.amber_to ?? fallback?.amber_to));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const dirty = g !== str(row?.green_to ?? fallback?.green_to) || a !== str(row?.amber_to ?? fallback?.amber_to);
  const problem = dirty ? bandProblem(metric.key, g, a) : null;

  const save = async () => {
    const p = bandProblem(metric.key, g, a);
    if (p) { setMsg(p); return; }
    setSaving(true); setMsg(null);
    const res = await saveTarget({ location_id: locationId, metric: metric.key, green_to: Number(g), amber_to: Number(a) }, hq.orgId, hq.userName);
    setSaving(false);
    if (res.error) { setMsg(res.message); return; }
    onSaved(true);
  };
  const clear = async () => {
    if (!row?.id) return;
    setSaving(true); setMsg(null);
    const res = await deleteTarget(row.id);
    setSaving(false);
    if (res.error) { setMsg(res.message); return; }
    onSaved(false);
  };

  if (!canEdit) {
    const has = row || fallback;
    return (
      <div style={{ display: 'grid', gap: 4 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ ...mono, fontSize: 13 }}>{has ? `Green to ${str(row?.green_to ?? fallback?.green_to) || NA}` : NA}</span>
          {has && <span style={{ ...mono, fontSize: 13 }}>Amber to {str(row?.amber_to ?? fallback?.amber_to) || NA}</span>}
          {chip}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="Green to" style={{ width: 90 }}><input style={{ ...field, ...mono }} inputMode="decimal" value={g} onChange={(e) => setG(e.target.value)} placeholder="none" aria-label={`${metric.label} green to`} /></Field>
        <Field label="Amber to" style={{ width: 90 }}><input style={{ ...field, ...mono }} inputMode="decimal" value={a} onChange={(e) => setA(e.target.value)} placeholder="none" aria-label={`${metric.label} amber to`} /></Field>
        <button type="button" style={{ ...(dirty ? accBtn : smallBtn), padding: '8px 12px', fontSize: 12.5, ...disabled(saving || !dirty) }} disabled={saving || !dirty} onClick={save}>{saving ? 'Saving' : 'Save'}</button>
        {row?.id && <button type="button" style={{ ...smallBtn, ...disabled(saving) }} disabled={saving} onClick={clear} title={locationId ? 'Back to the company band' : 'Back to the default'}>Clear</button>}
        {chip}
      </div>
      <AmberLine style={{ margin: 0 }}>{problem || msg}</AmberLine>
      {justSaved && !dirty && <GreenLine style={{ margin: 0 }}>Saved</GreenLine>}
    </div>
  );
}
