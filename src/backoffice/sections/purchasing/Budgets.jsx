// purchasing/Budgets.jsx: Purchasing > Budgets (multi site stock Drop 3, v5.11.96, contract 3.2 and
// 4.2, mockup INFO budgets). A weekly purchase budget per site: the company default and one row per
// site (% of forecast or Fixed, the figure, this week's forecast, spent, left). Company editors edit;
// everyone else reads. Standing orders still go out when a site is over budget (decision 8).

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { listSites } from '../../../lib/stock/supplierListRules';
import { moneyWords } from '../../../lib/stock/purchasingRules';
import { BUDGET_RULES, PILLS } from '../../../lib/stock/purchasingWords';
import { PageHead, TableWrap, Th, Td, Pill, Btn, ErrorLine, EmptyLine, ui } from '../stock/stockUi';

function RuleEditor({ row, onSave, disabled }) {
  const [rule, setRule] = useState(row?.rule || 'pct_of_forecast');
  const [val, setVal] = useState(row?.rule === 'fixed' ? String(row?.amount ?? '') : String(row?.pct ?? ''));
  const dirty = rule !== (row?.rule || 'pct_of_forecast') || val !== (row?.rule === 'fixed' ? String(row?.amount ?? '') : String(row?.pct ?? ''));
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <select value={rule} disabled={disabled} onChange={(e) => setRule(e.target.value)} style={{ ...ui.input, width: 150 }} aria-label="Rule">
        {BUDGET_RULES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
      <input inputMode="decimal" value={val} disabled={disabled} onChange={(e) => setVal(e.target.value)} placeholder={rule === 'fixed' ? 'Amount' : '%'} style={{ ...ui.input, width: 90, textAlign: 'right' }} aria-label={rule === 'fixed' ? 'Budget amount' : 'Percent of forecast'} />
      {!disabled && dirty && <Btn small kind="primary" onClick={() => onSave({ rule, value: val })}>Save</Btn>}
      {!disabled && row?.budget_row && <Btn small kind="link" onClick={() => onSave({ delete: true })}>Remove</Btn>}
    </span>
  );
}

export default function Budgets({ orgCtx = null }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  void orgCtx; // the contract's prop; the board needs only the scope
  const [board, setBoard] = useState(null);
  const [error, setError] = useState(null);
  const [again, setAgain] = useState(0);
  const sites = useMemo(() => listSites({ isAll: sc.isAll, scopeSites: sc.scopeSites }) || (sc.sites || []).map((s) => s.id), [sc.isAll, sc.scopeSites, sc.sites]);
  const editor = sc.canEditCompany('purchasing');
  useEffect(() => {
    let on = true;
    stockApi.budgetBoard(sc.orgId, sites.slice(0, 50)).then((r) => { if (on) { setBoard(r.error ? null : r.data); setError(r.error || null); } });
    return () => { on = false; };
  }, [sc.orgId, sites, again]);
  // { rows: [stock_budget_status + site_name + own: the site's own budget row or null], company: the default row or null }
  const rows = Array.isArray(board?.rows) ? board.rows : (Array.isArray(board?.sites) ? board.sites : []);
  const company = board?.company || null;
  const save = async (locationId, input, version) => {
    let body;
    if (input.delete) body = { location_id: locationId, delete: true };
    else {
      const n = Number(input.value);
      if (!(n > 0) || (input.rule === 'pct_of_forecast' && n > 100)) { showToast?.(input.rule === 'fixed' ? 'Type the weekly amount.' : 'Type a percent between 0 and 100.', 'error'); return; }
      body = input.rule === 'fixed' ? { location_id: locationId, rule: 'fixed', amount: n } : { location_id: locationId, rule: 'pct_of_forecast', pct: n };
    }
    const r = await stockApi.saveBudget(body, version ?? null);
    if (r.error) { showToast?.(r.error.message, 'error'); return; }
    showToast?.('Budget saved.', 'success');
    setAgain((x) => x + 1);
  };
  return (
    <div style={ui.page}>
      <PageHead title="Budgets" sub="A weekly purchase budget per site." />
      <ErrorLine error={error} />
      {!board && !error ? <EmptyLine>Loading…</EmptyLine> : board && (
        <TableWrap minWidth={900}>
          <thead><tr><Th>Site</Th><Th>Rule</Th><Th right>Budget</Th><Th right>Forecast</Th><Th right>Spent</Th><Th right>Left</Th></tr></thead>
          <tbody>
            <tr>
              <Td strong>Company default</Td>
              <Td><RuleEditor key={`co:${company?.rule}:${company?.pct}:${company?.amount}`} row={company ? { ...company, budget_row: true } : null} disabled={!editor} onSave={(x) => save(null, x, company?.row_version)} /></Td>
              <Td num grey> </Td><Td num grey> </Td><Td num grey> </Td><Td num grey> </Td>
            </tr>
            {rows.map((b) => (
              <tr key={b.location_id}>
                <Td strong>{sc.siteName(b.location_id) || b.site_name || ''}{b.over && <> <Pill tone={PILLS.overBudget.tone}>{PILLS.overBudget.text}</Pill></>}</Td>
                <Td><RuleEditor key={`${b.location_id}:${b.rule}:${b.pct}:${b.amount}`} row={b.own ? { ...b.own, budget_row: true } : null} disabled={!editor} onSave={(x) => save(b.location_id, x, b.own?.row_version)} /></Td>
                <Td num>{b.budget != null ? moneyWords(b.budget) : 'No budget'}</Td>
                <Td num grey>{moneyWords(b.forecast)}</Td>
                <Td num>{moneyWords(b.spent)}</Td>
                <Td num>{b.budget != null ? moneyWords(b.left) : ''}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
