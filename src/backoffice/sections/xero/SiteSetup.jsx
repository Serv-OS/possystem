// src/backoffice/sections/xero/SiteSetup.jsx
//
// "VAT and accounts" ("Tax and accounts" where tax is added on top, US): everything a site
// needs before it posts a daily sales invoice to Xero (30 Sep 2026). In order:
//   1. The site: its name in Xero and a short code for invoice numbers, with a live preview.
//   2. Site tracking: the tracking option on every line (Coffee Boy's Lightspeed "Location").
//   3. Sales groups: each group to an income account; menu categories to groups (14 days of
//      sales beside each, bulk assign). Menu Manager's accounting group still counts.
//   4. VAT rates: the Xero rate per ServOS rate (xero/SalesVat.jsx, shared with the Posting tab).
//   5. Discounts, tips, service charge, gift cards and Other sales.
//   6. Payments: a clearing account per kind of money (card, cash, gift cards).
//   7. The Ready checklist, 8. Check figures, 9. the switch with its start day.
//   Helpers above: Copy my Lightspeed setup, Copy from another site, Create recommended accounts.
// The form is unsaved until Save; the start day and "figures checked" are kept on the server.
// After a save or the figures tick the page refreshes in the background: it keeps its place
// and the figures on screen.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  xeroOptions, xeroGetMapping, xeroSaveMapping, xeroSiteData, xeroReadiness, xeroSetMode, xeroSiteCreate, xeroCopySite,
} from '../../../lib/xero';
import { money } from '../../../lib/currency';
import { migrateTaxMapping } from '../../../../supabase/functions/_shared/xeroTax.js';
import { groupKeyOf, makeGroupResolver, DISCOUNT_GROUPS, DISCOUNT_GROUP_NAMES, OTHER_GROUP } from '../../../../supabase/functions/_shared/accountingGroups.js';
import {
  invoiceNumber, creditNoteNumber, takingsReference, contactName, clearingLabel, SITE_CODE_RE, mappingHash, taxRatesSection,
} from '../../../../supabase/functions/_shared/xeroInvoicePlan.js';
import { S, btn, sel, input, fieldRow, flabel, accountRef, canTakePayments, suggested } from './xeroUi';
import { AcctSelect, Bullets } from './controls';
import LightspeedCopy from './LightspeedCopy';
import CheckFigures from './CheckFigures';
import SalesVat from './SalesVat';

// Plain words for what ServOS filled in on first open (from the older posting's choices).
const PREFILL_WORDS = { site: 'the site name and code', otherSalesAccount: 'Other sales', clearing: 'the card and cash clearing accounts' };

const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const NESTED = ['groups', 'clearing', 'itemGroups'];

// Merge suggested choices into the form: nested maps merge, category choices already made stay.
function mergePatch(map, patch) {
  const next = { ...map };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'discountAccount') {
      const accounts = { ...(next.discounts?.accounts || {}) };
      for (const d of DISCOUNT_GROUPS) if (!accounts[d]) accounts[d] = v;
      next.discounts = { ...(next.discounts || {}), accounts };
    } else if (k === 'discounts') {
      next.discounts = { ...(next.discounts || {}), ...v, accounts: { ...(next.discounts?.accounts || {}), ...(v?.accounts || {}) }, labels: { ...(next.discounts?.labels || {}), ...(v?.labels || {}) } };
    } else if (k === 'categoryGroups') {
      next.categoryGroups = { ...(v || {}), ...(next.categoryGroups || {}) };
    } else if (NESTED.includes(k)) {
      next[k] = { ...(next[k] || {}), ...(v || {}) };
    } else next[k] = v;
  }
  return next;
}

const RECOMMEND = [
  ['cardClearing', 'Card clearing for this site (payments enabled)'],
  ['cashInTill', 'Cash in till for this site (a bank account)'],
  ['giftLiability', 'Gift card liability (payments enabled)'],
  ['tipsPayable', 'ServOS Tips Payable'],
  ['servicePayable', 'ServOS Service Charge Payable'],
  ['discounts', 'Sales discounts (for discount groups with no account)'],
];

export default function SiteSetup({ locId, venue, siblings = [], postMode, onModeChange }) {
  const [opts, setOpts] = useState(null);
  const [data, setData] = useState(null);
  const [server, setServer] = useState({});
  const [detail, setDetail] = useState(null);
  const [map, setMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [paused, setPaused] = useState('');
  const [prefilled, setPrefilled] = useState([]);
  const figuresRef = useRef(null);
  // The start day the Ready checklist is read for: the one in the date box, else the saved one,
  // else today (the box starts there), so "A start day" never shows missing beside a filled box.
  const startRef = useRef('');
  // The form as it is now, so a background refresh never overwrites an edit made while it ran.
  const mapRef = useRef({});
  useEffect(() => { mapRef.current = map; }, [map]);
  const [busy, setBusy] = useState('');
  const [ready, setReady] = useState(null);
  const [readyErr, setReadyErr] = useState('');
  const [showLs, setShowLs] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createKeys, setCreateKeys] = useState({ cardClearing: true, cashInTill: true, giftLiability: false, tipsPayable: false, servicePayable: false, discounts: false });
  const [newOption, setNewOption] = useState('');
  const [newGroup, setNewGroup] = useState('');
  const [copyFrom, setCopyFrom] = useState('');
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState({});
  const [bulk, setBulk] = useState('');
  const [startDate, setStartDate] = useState('');

  const checkReady = useCallback(async (start) => {
    setReadyErr('');
    try { setReady(await xeroReadiness(locId, start || undefined)); } catch (e) { setReady(null); setReadyErr(e.message || 'Could not check readiness'); }
  }, [locId]);

  // quiet: a refresh after Save, the figures tick, Create accounts or the switch. The page stays
  // as it is (no "Loading" screen), so it keeps its place and the figures on screen.
  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    setErr('');
    const before = mapRef.current;
    try {
      const [o, m, d] = await Promise.all([xeroOptions(locId), xeroGetMapping(locId), xeroSiteData(locId)]);
      const saved = m?.mapping || {};
      let form = migrateTaxMapping(saved, o || {});
      // Prefill what the older posting already knows (only where nothing is chosen yet), and say so.
      const pre = [];
      if (!form.site?.name || !form.site?.code) { form = { ...form, site: { name: form.site?.name || d.site?.name || '', code: form.site?.code || d.site?.suggestedCode || '' } }; pre.push('site'); }
      if (!form.otherSalesAccount && (saved.revenueAccount || m?.detail?.salesAccountCode)) { form.otherSalesAccount = saved.revenueAccount || m.detail.salesAccountCode; pre.push('otherSalesAccount'); }
      if (!form.clearing && saved.paymentMap) {
        const pm = saved.paymentMap;
        const accts = o?.accounts || [];
        const asRef = (v) => { const a = accts.find((x) => x.id === v || x.code === v); return a ? accountRef(a) : v; };
        const c = {};
        if (pm.card) c.card = asRef(pm.card);
        if (pm.cash) c.cash = asRef(pm.cash);
        if (Object.keys(c).length) { form.clearing = c; pre.push('clearing'); }
      }
      startRef.current = startRef.current || saved.invoiceStartDate || venue?.currentDay || '';
      setOpts(o); setData(d); setServer(saved); setDetail(m?.detail || null);
      // Edited while this refresh ran: the person's form stays as they left it.
      const kept = quiet && mapRef.current !== before;
      setMap((cur) => (kept ? cur : form));
      if (!kept) setPrefilled(pre);
      setStartDate(startRef.current);
    } catch (e) { setErr(e.message || 'Could not load the setup'); }
    finally { if (!quiet) setLoading(false); }
  }, [locId, venue?.currentDay]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { startRef.current = startDate; }, [startDate]);
  useEffect(() => { if (opts && !opts.error) checkReady(startRef.current); }, [opts, checkReady]);

  const accounts = useMemo(() => opts?.accounts || [], [opts]);
  const cls = (a) => String(a.cls || '').toUpperCase();
  const revenue = accounts.filter((a) => cls(a) === 'REVENUE' || ['REVENUE', 'SALES', 'OTHERINCOME'].includes(String(a.type).toUpperCase()));
  const nonBank = accounts.filter((a) => !a.bank);
  const liabilities = accounts.filter((a) => cls(a) === 'LIABILITY' || ['CURRLIAB', 'LIABILITY', 'TERMLIAB'].includes(String(a.type).toUpperCase()));
  const payable = accounts.filter(canTakePayments);
  const dirty = stable(map) !== stable(server);
  const set = (patch) => setMap((m) => ({ ...m, ...patch }));
  const setIn = (key, sub, value) => setMap((m) => {
    const cur = { ...(m[key] || {}) };
    if (value === '' || value == null) delete cur[sub]; else cur[sub] = value;
    return { ...m, [key]: cur };
  });

  const catRows = useMemo(() => (data?.categories || []).map((c) => ({ id: c.id, parent_id: c.parentId, label: c.label, accounting_group: c.accountingGroup, master_id: c.masterId, local: true })), [data]);
  const resolver = useMemo(() => makeGroupResolver(map, catRows), [map, catRows]);
  const catLabel = useMemo(() => new Map((data?.categories || []).map((c) => [c.id, c.label])), [data]);

  const groupKeys = useMemo(() => {
    const keys = new Set(Object.keys(map.groups || {}));
    for (const c of data?.categories || []) { const g = resolver.itemGroup({ cat: c.id }).key; if (g !== OTHER_GROUP) keys.add(g); }
    for (const g of data?.seen?.groups || []) if (g !== OTHER_GROUP) keys.add(g);
    return [...keys].sort((a, b) => String(resolver.groupName(a)).localeCompare(String(resolver.groupName(b))));
  }, [map.groups, data, resolver]);

  const addedOn = !!opts?.addedOnTax;
  // Live on the invoice with a valid figures tick: a save that changes the choices pauses nightly
  // posting until a day's figures are checked again. Asked first, and said after.
  const tickValid = postMode === 'sales_invoice' && !!server.figuresChecked?.hash && server.figuresChecked.hash === mappingHash(server);
  const goToFigures = () => figuresRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });

  const save = async () => {
    const clean = { ...map };
    delete clean.discountAccount;
    if (tickValid && mappingHash(clean) !== server.figuresChecked.hash
      && !window.confirm(`These changes pause nightly posting to Xero until you check a day's figures again (section 8, Check figures). Save them?`)) return;
    setBusy('save'); setErr(''); setNote(''); setPaused('');
    try {
      const r = await xeroSaveMapping(locId, clean);
      if (r?.paused) setPaused(r.message || "Saved. Nightly posting to Xero is paused until you check a day's figures again."); else setNote('Saved.');
      await load({ quiet: true });
      onModeChange?.();
    } catch (e) { setErr(e.message || 'Save failed'); } finally { setBusy(''); }
  };

  const copySite = async () => {
    if (!copyFrom) return;
    setBusy('copy'); setErr(''); setNote('');
    try {
      const r = await xeroCopySite(locId, copyFrom);
      setMap((m) => mergePatch(m, r.patch));
      setNote(`Copied. ${r.categories?.matched || 0} category choice(s) matched this site's menu${r.categories?.missed ? `, ${r.categories.missed} did not` : ''}. Choose this site's tracking option and clearing accounts, then Save.`);
    } catch (e) { setErr(e.message || 'Could not copy'); } finally { setBusy(''); }
  };

  const createAccounts = async () => {
    const keys = Object.entries(createKeys).filter(([, v]) => v).map(([k]) => k);
    if (!keys.length) return;
    if (!window.confirm(`Create these accounts in Xero (any that already exist are reused)?\n\n${keys.map((k) => RECOMMEND.find((r) => r[0] === k)?.[1]).join('\n')}`)) return;
    setBusy('create'); setErr(''); setNote('');
    try {
      const r = await xeroSiteCreate(locId, { kind: 'accounts', keys });
      setMap((m) => mergePatch(m, r.patch));
      setOpts(await xeroOptions(locId));
      setNote(`${r.created.map((c) => `${c.name}${c.existed ? ' (already there)' : ' (created)'}`).join(', ')}. They are filled in below; press Save.`);
      setShowCreate(false);
    } catch (e) { setErr(e.message || 'Could not create the accounts'); } finally { setBusy(''); }
  };

  const createOption = async () => {
    const cat = map.tracking?.categoryName || (opts?.trackingCategories || [])[0]?.name || 'Location';
    const name = newOption.trim();
    if (!name) return;
    if (!window.confirm(`Create the tracking option "${name}" under "${cat}" in Xero?`)) return;
    setBusy('tracking'); setErr('');
    try {
      const r = await xeroSiteCreate(locId, { kind: 'tracking', categoryName: cat, optionName: name });
      setMap((m) => mergePatch(m, r.patch));
      setOpts(await xeroOptions(locId));
      setNewOption('');
    } catch (e) { setErr(e.message || 'Could not create the tracking option'); } finally { setBusy(''); }
  };

  const switchMode = async (mode) => {
    const text = mode === 'sales_invoice'
      ? `From ${startDate}, each business day at this site posts to Xero as one sales invoice, paid into its clearing accounts. Days before that stay exactly as they are in Xero. Switch now?`
      : 'Switch this site back to bank transactions? Days already sent as invoices stay as they are, and a day part sent as an invoice still finishes as one.';
    if (!window.confirm(text)) return;
    setBusy('mode'); setErr(''); setNote('');
    try {
      const r = await xeroSetMode(locId, mode, startDate);
      setNote(mode === 'sales_invoice'
        ? `This site now posts a daily sales invoice from ${r.startDate}.${r.keptOldDays?.length ? ` Days already in Xero the older way stay as they are: ${r.keptOldDays.join(', ')}.` : ''}`
        : 'This site posts bank transactions again.');
      onModeChange?.();
      await load({ quiet: true });
    } catch (e) { setErr(e.message || 'Could not switch'); if (e.readiness) setReady(e.readiness); } finally { setBusy(''); }
  };

  if (loading) return <div style={S.empty}>Loading the setup…</div>;
  if (!opts || !data) return <div style={S.banner(false)}>{err || 'Could not load the setup.'}</div>;

  const day = venue?.lastCompletedDay || new Date().toISOString().slice(0, 10);
  const code = String(map.site?.code || '');
  const siteName = String(map.site?.name || '');
  const trackingCats = opts.trackingCategories || [];
  const cat = trackingCats.find((c) => c.id === map.tracking?.categoryId || c.name === map.tracking?.categoryName) || null;
  const activeOpts = (cat?.options || []).filter((o) => String(o.status || 'ACTIVE').toUpperCase() === 'ACTIVE');
  const seenMoney = [...new Set(['card', 'cash', ...(data.seen?.moneyKeys || []), ...Object.keys(map.clearing || {})])];
  const cats = (data.categories || []).filter((c) => !filter || String(c.label).toLowerCase().includes(filter.toLowerCase()));
  const labels = Object.entries(data.discountLabels || {}).sort((a, b) => b[1].amount - a[1].amount);
  const cur = venue?.currency;
  const tw = addedOn ? 'tax' : 'VAT';
  const isPre = (k) => dirty && prefilled.includes(k);

  return (
    <div>
      {err && <div style={S.banner(false)}>{err}</div>}
      {note && <div style={S.banner(true)}>{note}</div>}
      {paused && (
        <div style={{ ...S.warn, maxWidth: 620, marginTop: 0, marginBottom: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: 'var(--t1)' }}><b>Paused:</b> {paused.replace(/^Saved\.\s*/, '')}</span>
          <button style={S.ghost} onClick={goToFigures}>Go to Check figures</button>
        </div>
      )}
      {prefilled.length > 0 && dirty && (
        <div style={{ ...S.info, marginBottom: 14 }}>
          <b>Filled in for you:</b> {prefilled.map((k) => PREFILL_WORDS[k]).join(', ')}, from your current Xero setup. They are outlined below. Check them, then press Save.
        </div>
      )}

      <div style={S.wide}>
        <div style={S.h2}>Daily sales invoice for this site</div>
        <Bullets items={[
          ['One invoice a day:', `each business day posts to Xero as one sales invoice, with a line per sales group and ${tw} rate.`],
          ['Discounts', 'post as minus lines. Tips, service charge and gift cards go to their own accounts.'],
          ['Paid:', 'it is paid into this site’s clearing accounts, so it shows as Paid. Refunds post as a credit note.'],
          [`${addedOn ? 'Tax' : 'VAT'} ties:`, `each line carries the till’s own ${tw}, to the penny.`],
        ]} />
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
          <button style={S.ghost} onClick={() => setShowLs(true)}>Copy my Lightspeed setup</button>
          {siblings.length > 0 && (
            <span style={{ display: 'inline-flex', gap: 6 }}>
              <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} style={{ ...sel, width: 'auto' }}>
                <option value="">Copy from another site…</option>
                {siblings.map((x) => <option key={x.locationId} value={x.locationId}>{x.name}</option>)}
              </select>
              <button style={S.ghost} onClick={copySite} disabled={!copyFrom || !!busy}>{busy === 'copy' ? 'Copying…' : 'Copy'}</button>
            </span>
          )}
          <button style={S.ghost} onClick={() => setShowCreate((v) => !v)}>Create recommended accounts</button>
        </div>
        {showCreate && (
          <div style={{ marginTop: 12, padding: 12, border: '1px solid var(--bdr2)', borderRadius: 10 }}>
            <div style={S.note}>ServOS creates only the ones you tick, after you confirm. An account with the same name or code is reused, never duplicated.</div>
            {RECOMMEND.map(([k, label]) => (
              <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, fontSize: 13, color: 'var(--t1)' }}>
                <input type="checkbox" checked={!!createKeys[k]} onChange={(e) => setCreateKeys((c) => ({ ...c, [k]: e.target.checked }))} /> {label}
              </label>
            ))}
            <button style={{ ...btn(!!busy), marginTop: 10 }} onClick={createAccounts} disabled={!!busy}>{busy === 'create' ? 'Creating…' : 'Create in Xero'}</button>
          </div>
        )}
      </div>

      <div style={S.wide}>
        <div style={S.h2}>1. The site</div>
        <div style={fieldRow}><span style={flabel}>Name in Xero</span><input style={{ ...input, ...(suggested(isPre('site')) || {}) }} value={siteName} maxLength={100} onChange={(e) => set({ site: { ...(map.site || {}), name: e.target.value } })} /></div>
        <div style={fieldRow}><span style={flabel}>Code for invoice numbers</span>
          <input style={{ ...input, ...(suggested(isPre('site')) || {}) }} value={code} maxLength={12} onChange={(e) => set({ site: { ...(map.site || {}), code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') } })} />
        </div>
        {!SITE_CODE_RE.test(code) && <div style={{ ...S.note, color: '#c33' }}>The code must be 2 to 12 capital letters or digits.</div>}
        {siblings.some((x) => x.code && x.code === code) && <div style={{ ...S.note, color: '#c33' }}>Another site on this Xero already uses {code}.</div>}
        <Bullets style={{ marginTop: 6 }} items={[
          [`For ${day}:`, <>invoice <b>{invoiceNumber(code || 'CODE', day)}</b>, credit note <b>{creditNoteNumber(code || 'CODE', day)}</b>, to <b>{contactName(siteName || 'Site')}</b>, reference &ldquo;{takingsReference(siteName || 'Site', day)}&rdquo;.</>],
          ['Keep the code', 'once days are posted. Invoice numbers use it, so a day part sent under the old code stops until the code is put back.'],
        ]} />
      </div>

      <div style={S.wide}>
        <div style={S.h2}>2. Site tracking</div>
        <Bullets items={[
          ['A tracking option', 'is a label Xero puts on each line, such as Location: Leeds, so reports can be run per site.'],
          ['Use the category', 'Lightspeed used (usually Location), and this site’s option in it.'],
        ]} />
        {opts.trackingError && <div style={{ ...S.banner(false), marginTop: 8 }}>Could not load Xero&rsquo;s tracking categories. Close this tab and open it again.</div>}
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0', fontSize: 13, color: 'var(--t1)' }}>
          <input type="checkbox" checked={!!map.tracking?.none} disabled={siblings.length > 0 && !map.tracking?.none} onChange={(e) => set({ tracking: e.target.checked ? { none: true } : {} })} />
          No tracking (only when this is the only site on this Xero)
        </label>
        {!map.tracking?.none && (
          <>
            <div style={fieldRow}><span style={flabel}>Tracking category</span>
              <select style={sel} value={cat?.id || ''} onChange={(e) => { const c = trackingCats.find((x) => x.id === e.target.value); set({ tracking: c ? { categoryId: c.id, categoryName: c.name } : {} }); }}>
                <option value="">Choose a category</option>
                {trackingCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div style={fieldRow}><span style={flabel}>This site&rsquo;s option</span>
              <select style={sel} value={map.tracking?.optionId || ''} disabled={!cat} onChange={(e) => { const o = activeOpts.find((x) => x.id === e.target.value); set({ tracking: { ...(map.tracking || {}), optionId: o?.id || null, optionName: o?.name || null } }); }}>
                <option value="">Choose an option</option>
                {activeOpts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <input style={{ ...input, maxWidth: 260 }} value={newOption} placeholder="New option, e.g. Leeds" onChange={(e) => setNewOption(e.target.value)} />
              <button style={S.small} onClick={createOption} disabled={!newOption.trim() || !!busy}>{busy === 'tracking' ? 'Creating…' : 'Create in Xero'}</button>
            </div>
          </>
        )}
      </div>

      <div style={S.wide}>
        <div style={S.h2}>3. Sales groups</div>
        <Bullets items={[
          ['Each sales group', `posts to its own income account, one line per ${tw} rate.`],
          ['No group?', 'Those sales post to Other sales.'],
        ]} />
        <table style={{ ...S.table, marginTop: 8 }}>
          <thead><tr><th style={S.th}>Group</th><th style={S.th}>Income account</th><th style={S.th} /></tr></thead>
          <tbody>
            {groupKeys.map((g) => (
              <tr key={g}>
                <td style={S.td}><input style={input} value={map.groups?.[g]?.name ?? resolver.groupName(g)} maxLength={80}
                  onChange={(e) => setIn('groups', g, { ...(map.groups?.[g] || {}), name: e.target.value })} /></td>
                <td style={S.td}><AcctSelect value={map.groups?.[g]?.account} list={revenue} placeholder="Other sales" onChange={(v) => setIn('groups', g, { ...(map.groups?.[g] || { name: resolver.groupName(g) }), account: v })} /></td>
                <td style={S.td}>{map.groups?.[g] && <button style={S.small} onClick={() => setIn('groups', g, null)}>Remove</button>}</td>
              </tr>
            ))}
            <tr>
              <td style={S.td}><span style={flabel}>Other sales</span></td>
              <td style={S.td}><AcctSelect value={map.otherSalesAccount} list={revenue} style={suggested(isPre('otherSalesAccount'))} onChange={(v) => set({ otherSalesAccount: v })} /></td>
              <td style={S.td} />
            </tr>
          </tbody>
        </table>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input style={{ ...input, maxWidth: 260 }} value={newGroup} placeholder="New group, e.g. Hot drinks" onChange={(e) => setNewGroup(e.target.value)} />
          <button style={S.small} disabled={!groupKeyOf(newGroup)} onClick={() => { const k = groupKeyOf(newGroup); setIn('groups', k, { name: newGroup.trim(), account: map.groups?.[k]?.account || '' }); setNewGroup(''); }}>Add group</button>
        </div>

        <div style={S.h3}>Menu categories</div>
        <div style={S.note}>Sales in the last 14 days beside each. Automatic uses the category above it, then the accounting group set in Menu Manager.{data.totals?.unresolved > 0 ? ` ${money(data.totals.unresolved, cur)} of ${money(data.totals.goods, cur)} is in categories with no group.` : ''}</div>
        <div style={{ display: 'flex', gap: 8, margin: '8px 0', flexWrap: 'wrap' }}>
          <input style={{ ...input, maxWidth: 220 }} value={filter} placeholder="Find a category" onChange={(e) => setFilter(e.target.value)} />
          <select style={{ ...sel, width: 'auto' }} value={bulk} onChange={(e) => setBulk(e.target.value)}>
            <option value="">Put ticked categories in…</option>
            <option value="__auto">Automatic</option>
            {groupKeys.map((g) => <option key={g} value={g}>{resolver.groupName(g)}</option>)}
          </select>
          <button style={S.small} disabled={!bulk || !Object.values(picked).some(Boolean)} onClick={() => {
            setMap((m) => { const cg = { ...(m.categoryGroups || {}) }; for (const [id, on] of Object.entries(picked)) { if (!on) continue; if (bulk === '__auto') delete cg[id]; else cg[id] = bulk; } return { ...m, categoryGroups: cg }; });
            setPicked({}); setBulk('');
          }}>Assign</button>
        </div>
        <div style={{ maxHeight: 420, overflowY: 'auto', border: '1px solid var(--bdr)', borderRadius: 10 }}>
          <table style={S.table}>
            <thead><tr><th style={S.th} /><th style={S.th}>Category</th><th style={{ ...S.th, textAlign: 'right' }}>14 days</th><th style={S.th}>Group</th></tr></thead>
            <tbody>
              {cats.map((c) => {
                const eff = resolver.itemGroup({ cat: c.id });
                return (
                  <tr key={c.id}>
                    <td style={S.td}><input type="checkbox" checked={!!picked[c.id]} onChange={(e) => setPicked((p) => ({ ...p, [c.id]: e.target.checked }))} /></td>
                    <td style={S.td}>{c.label}{c.parentId && catLabel.get(c.parentId) ? <span style={{ color: 'var(--t4)' }}> in {catLabel.get(c.parentId)}</span> : null}</td>
                    <td style={S.num}>{c.goods ? money(c.goods, cur) : ''}</td>
                    <td style={S.td}>
                      <select style={sel} value={map.categoryGroups?.[c.id] || ''} onChange={(e) => setIn('categoryGroups', c.id, e.target.value)}>
                        <option value="">Automatic ({eff.key === OTHER_GROUP ? 'Other sales' : resolver.groupName(eff.key)})</option>
                        {groupKeys.map((g) => <option key={g} value={g}>{resolver.groupName(g)}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div style={S.wide}>
        <div style={S.h2}>4. {taxRatesSection(addedOn)}</div>
        <Bullets items={[
          ['Each ServOS rate', `posts at the Xero rate chosen here, on the invoice and in the older bank transactions alike.`],
          ['No match?', `A ServOS rate with no Xero rate stops the day until you choose one.`],
        ]} />
        <SalesVat opts={opts} map={map} set={set} detail={detail} heading={false} />
      </div>

      <div style={S.wide}>
        <div style={S.h2}>5. Discounts, tips, service charge and gift cards</div>
        <Bullets items={[
          ['Discounts', addedOn ? 'post as minus lines before tax (the till takes tax off what is left).' : 'post as minus lines at the same VAT rate as the goods.'],
          ['Tips and gift cards', `post with No ${tw}.`],
        ]} />
        {DISCOUNT_GROUPS.map((d) => (
          <div key={d} style={fieldRow}>
            <span style={flabel}>{DISCOUNT_GROUP_NAMES[d]}{(data.seen?.discountGroups || []).includes(d) ? ' (used)' : ''}</span>
            <AcctSelect value={map.discounts?.accounts?.[d]} list={nonBank} onChange={(v) => setMap((m) => ({ ...m, discounts: { ...(m.discounts || {}), accounts: { ...(m.discounts?.accounts || {}), [d]: v || undefined } } }))} />
          </div>
        ))}
        {labels.length > 0 && (
          <>
            <div style={S.h3}>Discounts used at the till in the last 14 days</div>
            <table style={S.table}>
              <tbody>
                {labels.map(([label, v]) => (
                  <tr key={label}>
                    <td style={S.td}>{label}<span style={{ color: 'var(--t4)' }}> · {v.count} × · {money(v.amount / 100, cur)}</span></td>
                    <td style={S.td}>
                      <select style={sel} value={map.discounts?.labels?.[label] || ''} onChange={(e) => setMap((m) => { const l = { ...(m.discounts?.labels || {}) }; if (e.target.value) l[label] = e.target.value; else delete l[label]; return { ...m, discounts: { ...(m.discounts || {}), labels: l } }; })}>
                        <option value="">Automatic ({DISCOUNT_GROUP_NAMES[v.group] || v.group})</option>
                        {DISCOUNT_GROUPS.map((d) => <option key={d} value={d}>{DISCOUNT_GROUP_NAMES[d]}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <div style={{ ...fieldRow, marginTop: 14 }}><span style={flabel}>Tips (owed to staff)</span><AcctSelect value={map.tipsAccount} list={liabilities} onChange={(v) => set({ tipsAccount: v })} /></div>
        <div style={fieldRow}><span style={flabel}>Service charge</span><AcctSelect value={map.serviceAccount} list={[...liabilities, ...revenue]} onChange={(v) => set({ serviceAccount: v })} /></div>
        <div style={fieldRow}><span style={flabel}>Gift card liability</span><AcctSelect value={map.giftLiabilityAccount} list={liabilities} onChange={(v) => set({ giftLiabilityAccount: v })} /></div>
        {data.seen?.onlineGift && <div style={S.note}>Gift cards sold online are not in the daily invoice yet. Record them in Xero by hand for now.</div>}
      </div>

      <div style={S.wide}>
        <div style={S.h2}>6. Payments</div>
        <Bullets items={[
          ['Required:', 'every kind of payment needs an account. A kind with no account stops the whole day; money is never guessed.'],
          ['A clearing account', 'holds money on its way to the bank: card takings wait there for the payout, cash waits there for the banking.'],
          ['Listed:', 'bank accounts, and accounts with "Enable payments to this account" in Xero.'],
        ]} />
        <div style={{ marginTop: 10 }}>
          {seenMoney.map((k) => (
            <div key={k} style={fieldRow}>
              <span style={flabel}>{clearingLabel(k)}{(data.seen?.moneyKeys || []).includes(k) ? ' (used)' : ''}</span>
              <AcctSelect value={map.clearing?.[k]} list={payable} style={suggested(isPre('clearing') && !!map.clearing?.[k])} placeholder={k.startsWith('card:') ? 'Same as Card' : 'Choose an account'} onChange={(v) => setIn('clearing', k, v)} />
            </div>
          ))}
        </div>
      </div>

      <div style={{ ...S.wide, position: 'sticky', bottom: 8, zIndex: 5, display: 'flex', gap: 12, alignItems: 'center', boxShadow: '0 4px 18px rgba(0,0,0,.18)' }}>
        <button style={btn(!!busy || !dirty)} onClick={save} disabled={!!busy || !dirty}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        {paused && !dirty
          ? <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5, color: 'var(--t1)' }}><span><b>Paused:</b> nightly posting waits until a day&rsquo;s figures are checked again.</span><button style={S.small} onClick={goToFigures}>Go to Check figures</button></span>
          : <span style={S.note}>{dirty ? 'You have unsaved changes.' : 'All changes saved.'}</span>}
      </div>

      <div style={S.wide}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={S.h2}>7. Ready checklist</div>
          <button style={S.small} onClick={() => checkReady(startDate)}>Check again</button>
        </div>
        <div style={S.note}>Read against Xero and the saved choices{dirty ? ': save first to see your changes here' : ''}.</div>
        {readyErr && <div style={S.banner(false)}>{readyErr}</div>}
        {!ready && !readyErr && <div style={S.note}>Checking…</div>}
        {ready && (
          <>
            {ready.items.map((i) => (
              <div key={i.key} style={{ display: 'flex', gap: 10, padding: '5px 0', fontSize: 13, color: 'var(--t1)' }}>
                <b style={{ color: i.ok ? '#2f8f4e' : '#c33', width: 16 }}>{i.ok ? '✓' : '✗'}</b>
                <span>{i.label}{!i.ok && i.detail ? <span style={{ display: 'block', color: 'var(--t3)', fontSize: 12.5 }}>{i.detail}</span> : null}</span>
              </div>
            ))}
            {(ready.warnings || []).length > 0 && <div style={S.warn}>{ready.warnings.map((w) => <div key={w.code} style={{ fontSize: 12.5, color: 'var(--t2)', marginTop: 4 }}>{w.message}</div>)}</div>}
          </>
        )}
      </div>

      <div style={S.wide} ref={figuresRef}>
        <div style={S.h2}>8. Check figures</div>
        <CheckFigures locId={locId} venue={venue} accounts={accounts} dirty={dirty} checked={server.figuresChecked} savedHash={mappingHash(server)}
          onChecked={async () => { setPaused(''); await load({ quiet: true }); onModeChange?.(); }} />
      </div>

      <div style={S.wide}>
        <div style={S.h2}>9. Switch this site</div>
        <div style={S.note}>
          {postMode === 'sales_invoice'
            ? <>This site posts a daily sales invoice from <b>{server.invoiceStartDate}</b>. Days before stay as they are.</>
            : <>This site posts bank transactions (Receive and Spend Money) each day. Days already in Xero stay exactly as they are; a day is never posted both ways.</>}
        </div>
        {postMode !== 'sales_invoice' && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
            <span style={flabel}>First day as an invoice</span>
            <input type="date" value={startDate} onChange={(e) => { startRef.current = e.target.value; setStartDate(e.target.value); checkReady(e.target.value); }}
              style={{ border: '1px solid var(--bdr2)', borderRadius: 9, padding: '9px 11px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)' }} />
            <button style={btn(!!busy || dirty || !startDate || !ready?.ready)} onClick={() => switchMode('sales_invoice')} disabled={!!busy || dirty || !startDate || !ready?.ready}>{busy === 'mode' ? 'Switching…' : 'Switch to the daily sales invoice'}</button>
          </div>
        )}
        {postMode !== 'sales_invoice' && !ready?.ready && <div style={{ ...S.note, marginTop: 6 }}>The switch opens when every item in the Ready checklist is ticked.</div>}
        {postMode === 'sales_invoice' && <button style={{ ...S.ghost, marginTop: 12 }} onClick={() => switchMode('bank_tx')} disabled={!!busy}>Switch back to bank transactions</button>}
        <div style={{ ...S.note, marginTop: 10 }}>Auto posting each night is on the Posting tab, and stays off until this site is Ready.</div>
      </div>

      {showLs && (
        <LightspeedCopy locId={locId} accounts={accounts} currency={cur} map={map}
          onApply={(patch) => { setMap((m) => mergePatch(m, patch)); setShowLs(false); setNote('Suggestions filled in. Check them, then press Save.'); }}
          onClose={() => setShowLs(false)} />
      )}
    </div>
  );
}
