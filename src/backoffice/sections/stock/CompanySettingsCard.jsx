// src/backoffice/sections/stock/CompanySettingsCard.jsx
//
// MULTI SITE STOCK, Drop 1 (map 4.21, contract 3.5 and 4.4, Peter's decision 8): the company's stock
// settings, in a multi site company only. Drop 1 shows the cost rule (where an item's cost here comes
// from: the price list, or deliveries); the other company settings arrive with the Drop that reads
// them.
//
//   CompanySettingsCard (Overview, All sites): the company rule, 'Applies to every site.'; for an
//     owner of this company (or ServOS staff) 'A different rule at one site' and 'Use the company
//     rule' to clear it. stock_save_cost_rule(p_org, p_rule, p_override_location).
//   SiteCostRuleCard (Overview, one site picked): the rule that applies at that site, the company's
//     unless the site has its own; an owner sees 'Use a different rule at this site'.
//
// Who may change what is the database's call (the Drop 1 guard: the company rule needs Stock control
// All sites, a site's own rule needs an owner of the company): the screen greys what it would refuse
// and shows the lock line. No number moves when the rule changes: the next price save or delivery
// follows it.

import { useEffect, useState } from 'react';
import { useStore } from '../../../store';
import { supabase } from '../../../lib/supabase';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { COST_RULES, COST_RULE_WORDS } from '../../../lib/stock/phase0Rules';
import { settingsOf, ruleAt } from '../../../lib/stock/goLiveRules';
import { ownsCompany } from '../../../lib/stock/stockControlWords';
import { Btn, ErrorLine, ui } from './stockUi';
import LockLine from './LockLine';

const card = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 18 };
const AFTER = 'No cost changed now; the next price save or delivery follows it.';

// Is the signed in login an owner of this company (or ServOS staff)? One read of its own profile.
function useOwnsCompany(orgId, userId) {
  const key = orgId && userId ? `${orgId}:${userId}` : null;
  const [seen, setSeen] = useState(null);   // { key, owner }
  useEffect(() => {
    if (!key || !supabase) return undefined;
    let live = true;
    Promise.resolve(supabase.from('user_profiles').select('role, org_id').eq('id', userId).maybeSingle())
      .then(({ data }) => { if (live) setSeen({ key, owner: ownsCompany(data, orgId) }); })
      .catch(() => { if (live) setSeen({ key, owner: false }); });
    return () => { live = false; };
  }, [key, orgId, userId]);
  return !!(seen && seen.key === key && seen.owner);
}

// The company's settings, read on mount and again after each save.
function useCostSettings(orgId) {
  const [read, setRead] = useState(null);   // { orgId, settings, error }
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    if (!orgId) return undefined;
    let live = true;
    stockApi.settings(orgId).then((r) => {
      if (live) setRead({ orgId, settings: r.error ? null : settingsOf(r.data), error: r.error || null });
    });
    return () => { live = false; };
  }, [orgId, reloads]);
  const mine = read && read.orgId === orgId ? read : null;
  return { settings: mine?.settings || null, error: mine?.error || null, load: () => setReloads((n) => n + 1) };
}

// The two rules as today's Cost here card draws them (same look, same words).
function RuleList({ name, value, disabled, onPick }) {
  return COST_RULES.map((r) => (
    <label key={r} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0', cursor: disabled ? 'default' : 'pointer' }}>
      <input type="radio" name={name} checked={value === r} disabled={disabled} onChange={() => onPick(r)} />
      <span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{COST_RULE_WORDS[r].label}{r === 'price_list' ? ' (the default)' : ''}</span>
        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--t3)', marginTop: 2 }}>{COST_RULE_WORDS[r].help}</span>
      </span>
    </label>
  ));
}

// One save of the rule (the company's, or one site's with siteId; rule null clears a site's own).
function useRuleSave(orgId, load) {
  const showToast = useStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const save = async (rule, siteId = null, okWords = '') => {
    if (busy) return false;
    setBusy(true);
    const r = await stockApi.saveCostRule(orgId, rule, siteId);
    setBusy(false);
    if (r.error) { showToast?.(`Cost rule not saved: ${r.error.message || r.error}`, 'error'); return false; }
    load();
    if (okWords) showToast?.(okWords, 'success');
    return true;
  };
  return { busy, save };
}

/** Overview, All sites: 'Company stock settings'. */
export default function CompanySettingsCard({ orgId }) {
  const sc = useStockScope();
  const company = orgId || sc.orgId;
  const editable = sc.canEditCompany('inventory');
  const owner = useOwnsCompany(company, sc.userId);
  const { settings, error, load } = useCostSettings(company);
  const { busy, save } = useRuleSave(company, load);
  const [siteId, setSiteId] = useState('');

  const sites = sc.sites || [];
  const own = settings ? sites.filter((s) => settings.overrides[s.id]) : [];
  const chosen = siteId && settings ? ruleAt(settings, siteId) : null;
  const chosenName = sc.siteName(siteId) || 'that site';

  return (
    <div style={card} data-testid="stock-company-settings">
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 10 }}>Company stock settings</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>Cost here</div>
      <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 4 }}>Applies to every site.</div>
      {error && <ErrorLine error={error} />}
      {!settings && !error && <div style={{ fontSize: 12, color: 'var(--t3)', padding: '6px 0' }}>Loading{'…'}</div>}
      {settings && (
        <RuleList name="company-cost-rule" value={settings.companyRule} disabled={!editable || busy}
          onPick={(r) => save(r, null, `${COST_RULE_WORDS[r].label}: saved. Applies to every site. ${AFTER}`)} />
      )}
      {settings && own.length > 0 && (
        <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
          {own.map((s) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 10px', borderRadius: 8, background: 'var(--bg2)', border: '1px solid var(--bdr)' }}>
              <span style={{ flex: '1 1 200px', fontSize: 12.5, color: 'var(--t1)' }}>{s.name}: {COST_RULE_WORDS[settings.overrides[s.id]].label}</span>
              {owner && <Btn small kind="soft" disabled={busy} onClick={() => save(null, s.id, `${s.name} uses the company rule again.`)}>Use the company rule</Btn>}
            </div>
          ))}
        </div>
      )}
      {settings && owner && sites.length > 0 && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--bdr)' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', marginBottom: 6 }}>A different rule at one site</div>
          <select aria-label="Site" value={siteId} onChange={(e) => setSiteId(e.target.value)} style={{ ...ui.input, maxWidth: 320 }}>
            <option value="">Pick a site</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {chosen && (
            <div style={{ marginTop: 6 }}>
              <RuleList name={`site-cost-rule-${siteId}`} value={chosen.own ? chosen.rule : null} disabled={busy}
                onPick={(r) => save(r, siteId, `${COST_RULE_WORDS[r].label} at ${chosenName}: saved. ${AFTER}`)} />
              {chosen.own && <Btn small kind="soft" disabled={busy} onClick={() => save(null, siteId, `${chosenName} uses the company rule again.`)}>Use the company rule</Btn>}
            </div>
          )}
        </div>
      )}
      {!editable && <div style={{ marginTop: 12 }}><LockLine /></div>}
    </div>
  );
}

/** Overview, one site of a multi site company: the 'Cost here' card for that site. */
export function SiteCostRuleCard({ siteId }) {
  const sc = useStockScope();
  const company = sc.orgId;
  const editable = sc.canEditCompany('inventory');
  const owner = useOwnsCompany(company, sc.userId);
  const { settings, error, load } = useCostSettings(company);
  const { busy, save } = useRuleSave(company, load);
  const [different, setDifferent] = useState(false);
  const name = sc.siteName(siteId) || 'this site';
  const at = settings ? ruleAt(settings, siteId) : null;

  return (
    <div style={card} data-testid="stock-cost-rule">
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 6 }}>Cost here</div>
      {error && <ErrorLine error={error} />}
      {!settings && !error && <div style={{ fontSize: 12, color: 'var(--t3)', padding: '6px 0' }}>Loading{'…'}</div>}
      {at && at.own && (
        <>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 2 }}>{name} uses its own rule.</div>
          <RuleList name={`site-cost-rule-${siteId}`} value={at.rule} disabled={!owner || busy}
            onPick={(r) => save(r, siteId, `${COST_RULE_WORDS[r].label} at ${name}: saved. ${AFTER}`)} />
          {owner && <Btn small kind="soft" disabled={busy} onClick={() => save(null, siteId, `${name} uses the company rule again.`)}>Use the company rule</Btn>}
        </>
      )}
      {at && !at.own && !different && (
        <>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 2 }}>Applies to every site.</div>
          <RuleList name="company-cost-rule-here" value={settings.companyRule} disabled={!editable || busy}
            onPick={(r) => save(r, null, `${COST_RULE_WORDS[r].label}: saved. Applies to every site. ${AFTER}`)} />
          {owner && <Btn small kind="link" disabled={busy} onClick={() => setDifferent(true)} style={{ paddingLeft: 0 }}>Use a different rule at this site</Btn>}
        </>
      )}
      {at && !at.own && different && (
        <>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 2 }}>A different rule at {name}:</div>
          <RuleList name={`site-cost-rule-new-${siteId}`} value={null} disabled={busy}
            onPick={async (r) => { if (await save(r, siteId, `${COST_RULE_WORDS[r].label} at ${name}: saved. ${AFTER}`)) setDifferent(false); }} />
          <Btn small kind="ghost" disabled={busy} onClick={() => setDifferent(false)}>Use the company rule</Btn>
        </>
      )}
      {!editable && !(at && at.own && owner) && <div style={{ marginTop: 10 }}><LockLine /></div>}
    </div>
  );
}
