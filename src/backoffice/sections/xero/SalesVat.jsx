// src/backoffice/sections/xero/SalesVat.jsx
//
// The Xero rate for each ServOS tax rate (mapping.taxRateMap), "not VAT registered", the
// default rate and the service charge rate. One set of choices serves both ways of posting (the
// daily sales invoice and the older bank transactions), so it is shown on the VAT and accounts
// tab and on the Posting tab's older mapping card (moved here from XeroIntegration.jsx, 30 Sep
// 2026 review: the invoice depends on these, and they were only on the older card).

import { pickSalesTaxType, healedTaxType } from '../../../../supabase/functions/_shared/xeroTax.js';
import { S, sel, fieldRow, flabel } from './xeroUi';

// A Xero sales rate select. Blank is Auto (shown with what Auto picks). A saved choice that is
// not a sales rate stays visible so it can be changed (the save refuses expense rates).
function TaxSelect({ value, onChange, rates, autoLabel }) {
  const known = !value || rates.some(t => t.taxType === value);
  return (
    <select value={value || ''} onChange={e => onChange(e.target.value)} style={sel}>
      <option value="">{autoLabel}</option>
      {!known && <option value={value}>{value} (not a sales rate: choose again)</option>}
      {rates.map(t => <option key={t.taxType} value={t.taxType}>{t.name} ({t.rate}%)</option>)}
    </select>
  );
}

// 28 Sep 2026: VAT on sales is chosen PER ServOS tax rate, so zero rated food never posts with
// 20% VAT, and only Xero's rates for income are offered (the old single list included
// "20% (VAT on Expenses)", which Xero refuses on sales). The rows mirror the server
// (_shared/xeroTax.js): a venue that adds tax on top (US) keeps one sales line at one rate,
// and whole sales with no VAT breakdown at a venue with no default rate post at taxDefault.
// heading false: embedded under a section of its own (VAT and accounts), which says the same.
export default function SalesVat({ opts, map, set, detail, blocked = [], heading = true }) {
  const rates = opts.salesTaxRates || (opts.taxRates || []).filter(t => t.revenue !== false);
  const servos = opts.servosTaxRates || [];
  const hasExclusive = servos.some(r => r.mode === 'exclusive');
  const addedOn = opts.addedOnTax ?? (hasExclusive && !servos.some(r => r.mode === 'inclusive' && r.active !== false && r.pct > 0));
  const inclusive = addedOn ? [] : servos.filter(r => r.mode === 'inclusive');
  const inclusiveDefault = servos.some(r => r.isDefault && r.active !== false && r.mode === 'inclusive');
  const showDefault = !opts.servosRatesError && (addedOn || hasExclusive || !inclusiveDefault);
  const rateName = (tt) => rates.find(t => t.taxType === tt)?.name || (tt === 'NONE' ? 'No VAT' : tt);
  // The older single choice still applies at its own percentage, as it does on the server.
  const legacy = map.taxDefault ? rates.find(t => t.taxType === map.taxDefault) : null;
  // Percentages a push was refused for that no ServOS rate of this venue has, and any chosen.
  const pctRows = new Map();
  for (const b of [...(opts.unmatchedTaxBuckets || []), ...(blocked || [])]) {
    if (String(b?.key || '').startsWith('pct:')) pctRows.set(b.key, b);
  }
  for (const k of Object.keys(map.taxRateMap || {})) {
    if (!k.startsWith('pct:') || pctRows.has(k)) continue;
    const p = Number(k.slice(4));
    pctRows.set(k, { key: k, name: `${k.slice(4)}%`, pct: Number.isFinite(p) ? p : null });
  }
  const auto = (key, pct) => {
    if (legacy && pct > 0 && Math.abs(legacy.rate - pct) < 0.0005) return `Auto (${legacy.name})`;
    let tt;
    if (key.startsWith('pct:')) tt = pickSalesTaxType(rates, { pct });
    else if (!opts.autoTax || !(key in opts.autoTax)) return 'Auto (match by percentage)';
    else tt = opts.autoTax[key];
    return tt ? `Auto (${rateName(tt)})` : 'Auto: no match, choose one';
  };
  const setRate = (key, v) => {
    const next = { ...(map.taxRateMap || {}) };
    if (v) next[key] = v; else delete next[key];
    set({ taxRateMap: next });
  };
  const defaultLabel = addedOn || hasExclusive ? 'Sales with added-on tax' : 'Sales with no VAT breakdown';
  const defaultNote = addedOn || hasExclusive
    ? `Sales tax added on top of prices posts as before: one sales line with the tax included, at this rate.${!addedOn && !inclusiveDefault ? ' So do checks saved with no VAT breakdown.' : ''}`
    : `Checks saved with no VAT breakdown post at this rate, because this venue has no default VAT rate in ServOS.`;
  const serviceKnown = !map.serviceTax || rates.some(t => t.taxType === map.serviceTax);
  return (
    <>
      {heading && <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--t1)', margin: '18px 0 4px' }}>{addedOn ? 'Sales tax' : 'VAT on sales'}</div>}
      {heading && (
        <div style={S.note}>
          {addedOn
            ? 'This venue adds sales tax on top of its prices, so each sale posts as one line at one Xero rate, as before.'
            : 'Each ServOS tax rate posts as its own sales line at its own Xero rate. Only Xero rates for income are listed. Auto matches by percentage; a rate with no match stops the day until you choose one.'}
        </div>
      )}
      {(!addedOn || map.salesNoVat) && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', margin: '10px 0' }}>
          <input type="checkbox" checked={!!map.salesNoVat} onChange={e => set({ salesNoVat: e.target.checked })} style={{ width: 16, height: 16 }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>Not VAT registered: post every sale with No VAT</span>
        </label>
      )}
      {opts.taxRatesError && (
        <div style={{ ...S.banner(false), marginTop: 10 }}>Could not load Xero&rsquo;s tax rates, so the VAT choices are hidden. Close this screen and open it again to retry. Saving keeps them as they are.</div>
      )}
      {!map.salesNoVat && !opts.taxRatesError && (
        <div style={{ marginTop: 6 }}>
          {opts.servosRatesError && <div style={{ ...S.banner(false), marginBottom: 10 }}>Could not load this venue&rsquo;s ServOS tax rates. Close this screen and open it again to retry. Saving keeps your choices as they are.</div>}
          {!opts.servosRatesError && servos.length === 0 && <div style={{ fontSize: 12, color: 'var(--t4)', marginBottom: 10 }}>This venue has no tax rates set up in ServOS, so its sales post at the rate below.</div>}
          {inclusive.map(r => (
            <div key={r.id} style={fieldRow}>
              <span style={flabel}>{r.name || 'Rate'} ({r.pct}%){r.active === false ? ' (inactive)' : ''}</span>
              <TaxSelect value={(map.taxRateMap || {})[r.id]} onChange={v => setRate(r.id, v)} rates={rates} autoLabel={auto(r.id, r.pct)} />
            </div>
          ))}
          {!addedOn && [...pctRows.values()].map(b => (
            <div key={b.key} style={fieldRow}>
              <span style={flabel}>{b.pct != null ? `${b.pct}%` : b.name} (no ServOS rate)</span>
              <TaxSelect value={(map.taxRateMap || {})[b.key]} onChange={v => setRate(b.key, v)} rates={rates} autoLabel={auto(b.key, b.pct)} />
            </div>
          ))}
          {inclusive.length > 0 && (
            <div style={fieldRow}>
              <span style={flabel}>Items with no tax rate</span>
              <TaxSelect value={(map.taxRateMap || {}).none} onChange={v => setRate('none', v)} rates={rates} autoLabel={auto('none', 0)} />
            </div>
          )}
          {showDefault && (
            <>
              <div style={fieldRow}>
                <span style={flabel}>{defaultLabel}</span>
                <TaxSelect value={map.taxDefault} onChange={v => set({ taxDefault: v || undefined })} rates={rates} autoLabel={`Auto (${rateName(healedTaxType(detail || {}, rates))})`} />
              </div>
              <div style={{ ...S.note, marginBottom: 10 }}>{defaultNote}</div>
            </>
          )}
        </div>
      )}
      {!opts.taxRatesError && (
        <div style={fieldRow}>
          <span style={flabel}>Service charge {addedOn ? 'tax' : 'VAT'}</span>
          <select value={map.salesNoVat ? '' : (map.serviceTax || '')} disabled={!!map.salesNoVat} onChange={e => set({ serviceTax: e.target.value || undefined })} style={sel}>
            <option value="">{addedOn ? 'Same rate as the sales line (as before)' : 'No VAT (optional service charge is outside the scope of VAT)'}</option>
            {!map.salesNoVat && !serviceKnown && <option value={map.serviceTax}>{map.serviceTax} (not a sales rate: choose again)</option>}
            {rates.map(t => <option key={t.taxType} value={t.taxType}>{t.name} ({t.rate}%)</option>)}
          </select>
        </div>
      )}
    </>
  );
}
