// src/backoffice/sections/XeroIntegration.jsx
//
// Back office → Settings → "Xero (accounting)". Connects THIS venue to its own Xero
// organisation (OAuth) so we can push sales, bills/expenses and payment data. The tokens live
// server-side (xero_connections); this screen only ever sees the non-secret status.
//
// 30 Sep 2026: the screen is a shell with four tabs:
//   Connection        the organisation, who else posts to it (sites sharing one Xero org)
//   Posting           push a day, auto posting, and the bank transactions mapping (older model)
//   VAT and accounts  the daily sales invoice setup per site (xero/SiteSetup.jsx); called "Tax
//                     and accounts" where tax is added on top of prices (US)
//   Postings          one row per site per day, with exactly what was sent (xero/PostingsHistory.jsx)
// 2 Oct 2026: a day that answers "Already pushed" and is in Xero as bank transactions (the old
// way), at a site that now posts sales invoices, offers "Replace with a daily sales invoice"
// (xero/ReplaceDay.jsx). Peter at Leeds: "these are supposed to be invoices, I cannot find the
// invoice at all".

import { useCallback, useEffect, useRef, useState } from 'react';
import { tabVenue } from '../../store';
import { xeroStatus, xeroOAuthStart, xeroDisconnect, xeroSyncSales, xeroOptions, xeroGetMapping, xeroSaveMapping, xeroSetAutoDaily } from '../../lib/xero';
import { money } from '../../lib/currency';
import { migrateTaxMapping } from '../../../supabase/functions/_shared/xeroTax.js';
import { mappingHash, setupTabName } from '../../../supabase/functions/_shared/xeroInvoicePlan.js';
import { offerForAnswer, answerAfterFailure, OLD_REMOVED } from '../../../supabase/functions/_shared/xeroReplacePlan.js';
import ReplaceDay from './xero/ReplaceDay';
import SiteSetup from './xero/SiteSetup';
import PostingsHistory from './xero/PostingsHistory';
import InvoicePreview from './xero/InvoicePreview';
import SalesVat from './xero/SalesVat';
import OrganisationPicker from './xero/OrganisationPicker';

const tabsFor = (addedOn) => [
  { id: 'connection', label: 'Connection' },
  { id: 'posting', label: 'Posting' },
  { id: 'setup', label: setupTabName(addedOn) },
  { id: 'postings', label: 'Postings' },
];

// A site live on the sales invoice posts only while its "figures checked" tick matches its
// choices (a saved change lapses it): nightly posting then waits, and the screens say so.
const figuresLapsed = (postMode, mapping) => postMode === 'sales_invoice'
  && (!mapping?.figuresChecked?.hash || mapping.figuresChecked.hash !== mappingHash(mapping || {}));
const tabBtn = (on) => ({ padding: '8px 14px', borderRadius: 9, cursor: 'pointer', fontSize: 13, fontWeight: 800, fontFamily: 'inherit', border: `1px solid ${on ? 'var(--acc)' : 'var(--bdr2)'}`, background: on ? 'var(--acc)' : 'transparent', color: on ? '#0b0c10' : 'var(--t2)' });

// v5.9.11: tender methods as xero-sales posts them (closed_checks.tenders), each with the
// ServOS clearing account it lands in when the operator has not chosen one.
const KIND_DEFAULT = {
  card: 'Card Clearing', cash: 'Cash Clearing', gift_card: 'Gift Card Clearing',
  deposit: 'Deposits Clearing', unallocated: 'Unallocated Clearing', other: 'Card Clearing',
};
function methodLabel(m) {
  if (m === 'unallocated') return 'Unallocated (older split bills)';
  const t = String(m || '').replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18, maxWidth: 620, lineHeight: 1.5 },
  card: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 20, marginBottom: 14, maxWidth: 620 },
  btn: { padding: '11px 18px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 800, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  ghost: { padding: '9px 14px', borderRadius: 9, cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  note: { fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.55 },
  pill: (bg, fg) => ({ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 800, background: bg, color: fg }),
  banner: (ok) => ({ padding: '10px 14px', borderRadius: 10, fontSize: 13, fontWeight: 700, marginBottom: 14, maxWidth: 620, background: ok ? 'rgba(46,143,78,.14)' : 'rgba(200,60,60,.14)', color: ok ? '#2f8f4e' : '#c33', border: `1px solid ${ok ? 'rgba(46,143,78,.3)' : 'rgba(200,60,60,.3)'}` }),
};

const sel = { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 9, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' };
const fieldRow = { display: 'grid', gridTemplateColumns: '150px 1fr', gap: 12, alignItems: 'center', marginBottom: 10 };
const flabel = { fontSize: 12.5, fontWeight: 700, color: 'var(--t2)' };

// An account select for the older mapping card, at module scope so a focused select keeps its
// focus when its own value changes (it was declared inside the card's render).
function TypedAcctSelect({ value, onChange, accounts, types, placeholder = 'Default (Sales)' }) {
  const list = accounts.filter(a => !a.bank && (!types || types.includes(String(a.type).toUpperCase())));
  return (
    <select value={value || ''} onChange={e => onChange(e.target.value)} style={sel}>
      <option value="">{placeholder}</option>
      {list.map(a => <option key={a.id} value={a.code || a.id}>{a.code ? `${a.code} · ` : ''}{a.name}</option>)}
    </select>
  );
}

// The older posting's choices: each money flow to a Xero account, the Xero rate per ServOS tax
// rate, and which clearing account each payment method lands in. All optional: sensible defaults
// apply if left blank. The VAT rates, tips and service charge here are the same choices as on
// the VAT and accounts tab, so they apply to both ways of posting.
function MappingCard({ locId, blocked, postMode, tabName, onSaved }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState(null);
  const [map, setMap] = useState({});
  const [savedMap, setSavedMap] = useState({});
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [err, setErr] = useState('');

  const load = async () => {
    setLoading(true); setErr('');
    try {
      const [o, m] = await Promise.all([xeroOptions(locId), xeroGetMapping(locId)]);
      // The older single VAT choice (taxDefault) moves to the per rate choices; saved on the next save.
      setOpts(o); setDetail((m && m.detail) || null); setSavedMap((m && m.mapping) || {}); setMap(migrateTaxMapping((m && m.mapping) || {}, o || {}));
    } catch (e) { setErr(e.message || 'Could not load your Xero accounts'); }
    finally { setLoading(false); }
  };
  const toggle = () => { const n = !open; setOpen(n); if (n && !opts && !loading) load(); };
  const set = (patch) => setMap(m => ({ ...m, ...patch }));
  const setPay = (method, acctId) => setMap(m => ({ ...m, paymentMap: { ...(m.paymentMap || {}), [method]: acctId } }));
  const save = async () => {
    // A site live on the sales invoice: a change to these choices pauses nightly posting until a
    // day's figures are checked again. Asked first, never silent.
    if (!figuresLapsed(postMode, savedMap) && postMode === 'sales_invoice' && mappingHash(map) !== mappingHash(savedMap)
      && !window.confirm(`These changes pause nightly posting to Xero until you check a day's figures again (${tabName}, Check figures). Save them?`)) return;
    setSaving(true); setSaved(''); setErr('');
    try {
      const r = await xeroSaveMapping(locId, map);
      setSavedMap(map);
      setSaved(r?.paused ? r.message : '✓ Saved');
      if (!r?.paused) setTimeout(() => setSaved(''), 2200);
      onSaved?.();
    }
    catch (e) { setErr(e.message || 'Save failed'); } finally { setSaving(false); }
  };

  const accounts = opts?.accounts || [];
  const purchaseRates = opts?.purchaseTaxRates || (opts?.taxRates || []).filter(t => t.expense !== false);
  const banks = accounts.filter(a => a.bank);
  const byType = (types) => accounts.filter(a => !a.bank && (!types || types.includes(String(a.type).toUpperCase())));

  return (
    <div style={{ ...S.card, marginTop: 0 }}>
      <button onClick={toggle} style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--t1)' }}>Accounts, {opts?.addedOnTax ? 'sales tax' : 'VAT'} rates and payment methods <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t4)' }}>· optional</span></span>
        <span style={{ color: 'var(--t3)', fontSize: 13 }}>{open ? 'Hide ▲' : 'Set up ▼'}</span>
      </button>
      {open && (
        <div style={{ marginTop: 14 }}>
          <ul style={{ ...S.note, margin: 0, paddingLeft: 18 }}>
            <li><b style={{ color: 'var(--t2)' }}>Bank transactions:</b> choose where each part of a sale posts. Leave anything blank to use the default.</li>
            <li><b style={{ color: 'var(--t2)' }}>Shared:</b> the {opts?.addedOnTax ? 'sales tax' : 'VAT'} rates, tips and service charge here are the same choices as under {tabName}, so they apply to the daily sales invoice too.</li>
            <li><b style={{ color: 'var(--t2)' }}>Tips</b> are a liability (money owed to staff), never income. By default they post to ServOS Tips Payable.</li>
          </ul>
          {loading && <div style={{ ...S.note, marginTop: 12 }}>Loading your Xero accounts…</div>}
          {err && <div style={{ ...S.banner(false), marginTop: 12 }}>{err}</div>}
          {opts && !loading && (
            <div style={{ marginTop: 14 }}>
              <div style={fieldRow}><span style={flabel}>Sales revenue</span><TypedAcctSelect accounts={accounts} value={map.revenueAccount} onChange={v => set({ revenueAccount: v })} types={['REVENUE', 'SALES']} /></div>
              <div style={fieldRow}><span style={flabel}>Tips / gratuities</span><TypedAcctSelect accounts={accounts} value={map.tipsAccount} onChange={v => set({ tipsAccount: v })} types={['CURRLIAB', 'LIABILITY', 'REVENUE']} placeholder="Default (ServOS Tips Payable)" /></div>
              <div style={fieldRow}><span style={flabel}>Service charge</span><TypedAcctSelect accounts={accounts} value={map.serviceAccount} onChange={v => set({ serviceAccount: v })} types={['REVENUE', 'CURRLIAB', 'LIABILITY']} placeholder="Default (ServOS Service Charge Payable)" /></div>
              <div style={fieldRow}><span style={flabel}>Purchases / COGS</span>
                <select value={map.purchasesAccount || ''} onChange={e => set({ purchasesAccount: e.target.value })} style={sel}>
                  <option value="">Auto (cost of sales)</option>
                  {byType(['DIRECTCOSTS', 'EXPENSE', 'OVERHEADS']).map(a => <option key={a.id} value={a.code || a.id}>{a.code ? `${a.code} · ` : ''}{a.name}</option>)}
                </select>
              </div>
              <div style={fieldRow}><span style={flabel}>VAT on purchases</span>
                <select value={map.purchaseTax || ''} onChange={e => set({ purchaseTax: e.target.value })} style={sel}>
                  <option value="">None</option>
                  {/* A saved choice missing from the purchase rates stays visible (React would show "None" while it still posts). */}
                  {map.purchaseTax && !purchaseRates.some(t => t.taxType === map.purchaseTax) && (
                    <option value={map.purchaseTax}>{map.purchaseTax}{opts.taxRatesError ? '' : ' (not a purchase rate: choose again)'}</option>
                  )}
                  {purchaseRates.map(t => <option key={t.taxType} value={t.taxType}>{t.name} ({t.rate}%)</option>)}
                </select>
              </div>

              <SalesVat opts={opts} map={map} set={set} detail={detail} blocked={blocked} />

              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--t1)', margin: '18px 0 4px' }}>Payment method → bank account</div>
              <div style={S.note}>Each method lands in a Xero “clearing” bank account so its payout reconciles there. Gift card redemptions and booking deposits have their own, because that money was taken earlier. Loyalty and promo credit are discounts, not money, so they are not listed.</div>
              <div style={{ marginTop: 10 }}>
                {(opts.paymentMethods || []).length === 0 && <div style={{ fontSize: 12, color: 'var(--t4)' }}>No sales yet to map.</div>}
                {(opts.paymentMethods || []).map(m => (
                  <div key={m} style={fieldRow}>
                    <span style={flabel}>{methodLabel(m)}</span>
                    <select value={(map.paymentMap || {})[m] || ''} onChange={e => setPay(m, e.target.value)} style={sel}>
                      <option value="">Auto ({KIND_DEFAULT[(opts.paymentMethodKinds || {})[m]] || (/cash/i.test(m) ? 'Cash Clearing' : 'Card Clearing')})</option>
                      {banks.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
                <button style={S.btn} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save mapping'}</button>
                {saved && <span style={{ color: saved.startsWith('✓') ? '#2f8f4e' : '#c89628', fontWeight: 700, fontSize: 13 }}>{saved}</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function XeroIntegration() {
  const [locId, setLocId] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [flash, setFlash] = useState('');
  // v5.9.11: the date is a VENUE BUSINESS DAY (the venue's time zone and day start, from
  // the server), never the browser's UTC date, and only a day that has ended can be posted.
  const [venue, setVenue] = useState(null);
  const [syncDate, setSyncDate] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [syncErr, setSyncErr] = useState('');
  const [refused, setRefused] = useState([]);   // rates the last push or check was refused for
  const [refusedDay, setRefusedDay] = useState(null);   // a day part way through a replace: a push it refused, or a replace that stopped
  const [startDate, setStartDate] = useState(null);     // the site's first invoice day
  const [autoDaily, setAutoDaily] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoErr, setAutoErr] = useState('');
  const [tab, setTab] = useState('connection');
  const [siblings, setSiblings] = useState([]);
  const [tenantName, setTenantName] = useState('');
  const [postMode, setPostMode] = useState('bank_tx');
  const [lapsed, setLapsed] = useState(false);
  const [addedOnTax, setAddedOnTax] = useState(false);

  // 7 Oct 2026: the venue is THIS tab's own (store tabVenue, as the menu screens since 27 Sep),
  // taken ONCE per visit to this screen. It used to be read on every reload from a key every
  // browser tab shares, so after another tab switched venue this screen could open or reload as
  // that venue while the header still named this one (a venue switch in THIS tab reloads the
  // page, so the one taken here never goes stale).
  const venueRef = useRef(null);
  const load = useCallback(async () => {
    setLoading(true); setErr('');
    const id = venueRef.current || tabVenue(); venueRef.current = id; setLocId(id);
    if (!id) { setLoading(false); return; }
    try {
      setStatus(await xeroStatus(id));
      try {
        const m = await xeroGetMapping(id);
        setAutoDaily(!!m.autoDaily);
        if (m.venue) setVenue(m.venue);
        setSiblings(m.siblings || []);
        setTenantName(m.tenantName || '');
        setPostMode(m.postMode || 'bank_tx');
        setStartDate(m.mapping?.invoiceStartDate || null);
        setLapsed(figuresLapsed(m.postMode, m.mapping));
        setAddedOnTax(!!m.addedOnTax);
        // The server's figure; the fallback (venue clock unreadable) is only a starting point,
        // the server still checks the day against the venue clock before posting.
        setSyncDate(d => d || m.venue?.lastCompletedDay || new Date(Date.now() - 86400000).toISOString().slice(0, 10));
      } catch { /* non-fatal */ }
    } catch (e) { setErr(e.message || 'Could not load Xero status'); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  // After the setup switches the posting model: refresh the model and the sites, not the whole screen.
  const refreshMode = useCallback(async () => {
    if (!locId) return;
    try {
      const m = await xeroGetMapping(locId);
      setPostMode(m.postMode || 'bank_tx'); setSiblings(m.siblings || []); setAutoDaily(!!m.autoDaily);
      setTenantName(m.tenantName || '');   // the sites listed above belong to this organisation
      setStartDate(m.mapping?.invoiceStartDate || null);
      setLapsed(figuresLapsed(m.postMode, m.mapping));
    } catch { /* the next load shows it */ }
  }, [locId]);

  // After the organisation box moves the site: the connection and the posting model again, with
  // no Loading screen (that would take the box, and what it just said, off the page).
  const refreshAfterMove = useCallback(async () => {
    if (!locId) return;
    try { setStatus(await xeroStatus(locId)); } catch { /* the next load shows it */ }
    await refreshMode();
  }, [locId, refreshMode]);

  // Handle the redirect back from Xero (?xero=connected|error|expired|invalid|no_org).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const x = p.get('xero');
    if (!x) return;
    setFlash(x);
    p.delete('xero');
    const q = p.toString();
    window.history.replaceState({}, '', window.location.pathname + (q ? '?' + q : '') + window.location.hash);
    load();
  }, [load]);

  const connect = async () => {
    if (!locId) return;
    setBusy(true); setErr('');
    try {
      const { url } = await xeroOAuthStart(locId, window.location.href);
      if (url) window.location.href = url;        // full-page redirect to Xero consent
      else { setErr('Could not start the Xero connection.'); setBusy(false); }
    } catch (e) { setErr(e.message || 'Could not start the Xero connection.'); setBusy(false); }
  };

  const disconnect = async () => {
    const others = siblings.length ? ` ${siblings.map((x) => x.name).join(', ')} also post${siblings.length === 1 ? 's' : ''} to this Xero organisation and will stay connected.` : '';
    if (!locId || !window.confirm(`Disconnect this venue from Xero? You can reconnect any time.${others}`)) return;
    setBusy(true); setErr('');
    try { await xeroDisconnect(locId); await load(); } catch (e) { setErr(e.message || 'Disconnect failed'); } finally { setBusy(false); }
  };

  const syncSales = async (dryRun = false) => {
    if (!locId || !syncDate) return;
    setSyncing(dryRun ? 'preview' : 'push'); setSyncErr(''); setSyncResult(null); setRefusedDay(null);
    try { const r = await xeroSyncSales(locId, syncDate, dryRun ? { dryRun: true } : {}); setSyncResult(r); setRefused(r?.blocked || []); }
    catch (e) {
      const why = (e.notReady || []).map((n) => n.message).join(' ');
      setSyncErr(`${e.message || 'Sync failed'}${why && !String(e.message || '').includes(why) ? ` ${why}` : ''}`); setRefused(e.blocked || []);
      // A day part way through being replaced refuses a push and offers to finish the replace.
      if (e.replace) setRefusedDay({ model: 'bank_tx', date: e.date || syncDate, replace: e.replace });
    }
    finally { setSyncing(false); }
  };
  const cur = syncResult?.currency || venue?.currency;
  const tabName = setupTabName(addedOnTax);
  // The day just asked about, when it is in Xero the old way: can it become a sales invoice?
  const oldDay = syncResult?.ok && syncResult.already ? syncResult : refusedDay;
  const offer = offerForAnswer(oldDay, { postMode, startDate });
  // 2 Oct 2026 review: a replace that removed old entries and then failed (the invoice not sent,
  // or only some removed) left "Already pushed" and the old lines on screen, with links to
  // transactions Xero had deleted. They come down; the replace panel stays open with what to do.
  const replaceFailed = (e) => {
    const next = answerAfterFailure(oldDay, e);
    if (next) { setRefusedDay(next); setSyncResult(null); }
  };

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!locId) return <div style={S.empty}>Pick a location to connect Xero.</div>;

  const connected = !!status?.connected;
  const configured = status?.configured !== false;

  return (
    <div>
      <h1 style={S.h1}>Xero (accounting)</h1>
      <div style={S.sub}>
        Connect this venue to its own Xero organisation so your books stay up to date automatically:
        daily sales &amp; VAT, supplier bills/expenses, and payment data for bank reconciliation.
      </div>

      {flash === 'connected' && <div style={S.banner(true)}>✓ Connected to Xero.</div>}
      {flash && flash !== 'connected' && <div style={S.banner(false)}>Xero connection didn’t complete ({flash}). Please try again.</div>}
      {err && <div style={S.banner(false)}>{err}</div>}

      {!configured ? (
        <div style={S.card}>
          <div style={S.pill('rgba(200,150,40,.16)', '#c89628')}>● Not set up yet</div>
          <div style={{ ...S.note, marginTop: 12 }}>
            The Xero app hasn’t been configured on the server yet (missing keys). Once the
            <b> Client ID</b> and <b>Secret</b> are in place, a <b>Connect Xero</b> button will appear here.
          </div>
        </div>
      ) : connected ? (
        <>
        {siblings.length > 0 && (
          <div style={{ ...S.banner(true), background: 'rgba(80,120,200,.12)', color: 'var(--t2)', border: '1px solid rgba(80,120,200,.3)' }}>
            {siblings.map((x) => x.name).join(', ')} also post{siblings.length === 1 ? 's' : ''} to {tenantName || status.tenant_name || 'this Xero organisation'}. Sites that share a Xero organisation are one company with one VAT number; each site&rsquo;s postings carry its own name, number and tracking option.
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          {tabsFor(addedOnTax).map((t) => <button key={t.id} style={tabBtn(tab === t.id)} onClick={() => setTab(t.id)}>{t.label}</button>)}
        </div>
        {tab === 'connection' && (
        <div style={S.card}>
          <div style={S.pill('rgba(46,143,78,.16)', '#2f8f4e')}>● Connected</div>
          <div style={{ marginTop: 12, fontSize: 15, fontWeight: 800, color: 'var(--t1)' }}>{status.tenant_name || 'Xero organisation'}</div>
          <div style={{ fontSize: 12, color: 'var(--t4)', marginTop: 2 }}>Linked {status.connected_at ? new Date(status.connected_at).toLocaleDateString() : ''}</div>
          <OrganisationPicker locId={locId} currentName={status.tenant_name} postMode={postMode} autoDaily={autoDaily} startDate={startDate}
            needsSetup={postMode === 'sales_invoice' && lapsed} changed={status.organisation_changed}
            setupTab={tabName} busy={busy} onSignIn={connect} onChanged={refreshAfterMove} S={S} />
          <div style={{ ...S.note, marginTop: 10 }}>
            {postMode === 'sales_invoice' ? 'This site posts a daily sales invoice.' : `This site posts bank transactions each day. The daily sales invoice is set up under ${tabName}.`}
            {siblings.length > 0 && <> Other sites on this organisation: {siblings.map((x) => `${x.name} (${x.postMode === 'sales_invoice' ? 'sales invoice' : 'bank transactions'})`).join(', ')}.</>}
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
            <a href={status.manager_url || 'https://go.xero.com'} target="_blank" rel="noreferrer" style={{ ...S.ghost, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>Open in Xero ↗</a>
            <button style={S.ghost} onClick={disconnect} disabled={busy}>Disconnect</button>
          </div>
        </div>
        )}
        {tab === 'posting' && (
        <>
        <div style={S.card}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--t1)', marginBottom: 6 }}>Push sales to Xero</div>
            {postMode === 'sales_invoice'
              ? <div style={S.note}>This site posts each day from its start day as one <b>sales invoice</b>, paid into its clearing accounts, with a credit note for refunds (set up under {tabName}). Days before the start day post as bank transactions, as before.</div>
              : <div style={S.note}>Posts that day’s takings into Xero as “received money” in a clearing account per payment type (card, cash and gift card kept separate), and that day’s refunds as “spent money”. When your card <b>payout</b> lands in the bank, reconcile it against the clearing account. That is how sales connect to the cash in the bank.</div>}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
              <input type="date" value={syncDate} max={venue?.lastCompletedDay || undefined} onChange={e => setSyncDate(e.target.value)}
                style={{ border: '1px solid var(--bdr2)', borderRadius: 9, padding: '9px 11px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)' }} />
              <button style={S.btn} onClick={() => syncSales(false)} disabled={!!syncing || !syncDate}>{syncing === 'push' ? 'Pushing…' : 'Push sales to Xero'}</button>
              <button style={S.ghost} onClick={() => syncSales(true)} disabled={!!syncing || !syncDate}>{syncing === 'preview' ? 'Working out…' : 'Preview this day'}</button>
            </div>
            {venue && (
              <div style={{ ...S.note, marginTop: 8 }}>
                A day is the venue’s business day: from {venue.dayStart} to {venue.dayStart} the next morning, {venue.timezone} time, so after-midnight trade counts with the night before. Only a day that has ended can be posted.
              </div>
            )}
            {syncErr && <div style={S.banner(false)}>{syncErr}</div>}
            {syncResult?.ok && syncResult.already && <div style={{ ...S.banner(true), marginTop: 12 }}>✓ Already pushed for {syncResult.date}.</div>}
            {offer.show !== 'none' && (
              <div style={{ marginTop: 12, marginBottom: 12, padding: '10px 14px', borderRadius: 10, background: 'rgba(80,120,200,.12)', border: '1px solid rgba(80,120,200,.3)' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', lineHeight: 1.5 }}>{offer.text}</div>
                {offer.show === 'button' && (
                  <ReplaceDay key={oldDay.date} locId={locId} date={oldDay.date} currency={cur} resume={offer.resume} style={{ marginTop: 10 }}
                    onDone={(r) => { setSyncErr(''); setRefusedDay(null); setSyncResult(r); }} onFail={replaceFailed} />
                )}
              </div>
            )}
            {syncResult?.ok && syncResult.empty && <div style={{ ...S.banner(true), marginTop: 12 }}>No sales or refunds on {syncResult.date}. Nothing to post.</div>}
            {syncResult?.ok && !syncResult.empty && syncResult.model === 'sales_invoice' && (
              <div style={{ marginTop: 12 }}>
                {!syncResult.already && (
                  <div style={{ ...S.banner(true), marginBottom: 8 }}>
                    {syncResult.dryRun ? `Sales invoice figures for ${syncResult.date}. Nothing has been sent to Xero.` : `✓ Posted ${syncResult.date} to Xero as a sales invoice.${syncResult.replaced ? ` ${OLD_REMOVED}` : ''}`}
                  </div>
                )}
                {(syncResult.documents || []).map((d) => (
                  <div key={d.key || d.xeroId} style={{ fontSize: 13, padding: '7px 10px', border: '1px solid var(--bdr2)', borderRadius: 8, marginBottom: 6, background: 'var(--bg2)', display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <span style={{ color: 'var(--t1)', fontWeight: 700 }}>{d.type === 'invoice' ? 'Invoice' : d.type === 'credit_note' ? 'Credit note' : d.type === 'refund' ? 'Refund payment' : 'Payment'} {d.type === 'invoice' || d.type === 'credit_note' ? d.number : d.reference} · {money(d.total, cur)}</span>
                    {d.link && <a href={d.link} target="_blank" rel="noreferrer" style={{ color: 'var(--acc)', fontWeight: 700, textDecoration: 'none', fontSize: 12, whiteSpace: 'nowrap' }}>Open in Xero ↗</a>}
                  </div>
                ))}
                {syncResult.dryRun && <InvoicePreview result={syncResult} currency={cur} />}
              </div>
            )}
            {syncResult?.ok && !syncResult.empty && syncResult.model !== 'sales_invoice' && (
              <div style={{ marginTop: 12 }}>
                {!syncResult.already && (
                  <div style={{ ...S.banner(true), marginBottom: 8 }}>
                    {syncResult.dryRun ? `Figures for ${syncResult.date}. Nothing has been sent to Xero.` : `✓ Pushed ${syncResult.date} to Xero${syncResult.sample ? ' (test figures: no real sales that day)' : ''}.`}
                  </div>
                )}
                {(syncResult.lines || []).map((l, i) => (
                  <div key={l.key || i} style={{ fontSize: 13, padding: '7px 10px', border: '1px solid var(--bdr2)', borderRadius: 8, marginBottom: 6, background: 'var(--bg2)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                      <span style={{ color: 'var(--t1)', fontWeight: 700 }}>
                        {l.direction === 'refunds' ? 'Refunds' : 'Takings'} · {(l.methods || []).map(methodLabel).join(', ')} · {money(l.total, cur)}
                        {l.account && <span style={{ fontWeight: 600, color: 'var(--t4)' }}> · {l.account}</span>}
                      </span>
                      {l.link && <a href={l.link} target="_blank" rel="noreferrer" style={{ color: 'var(--acc)', fontWeight: 700, textDecoration: 'none', fontSize: 12, whiteSpace: 'nowrap' }}>View in Xero ↗</a>}
                    </div>
                    {/* 28 Sep 2026: one row per VAT rate line, with the VAT Xero works out and what ServOS booked. */}
                    {(l.rates || []).length > 0 && (
                      <div style={{ marginTop: 4, fontSize: 12, color: 'var(--t3)', lineHeight: 1.6 }}>
                        {l.rates.map((r, j) => (
                          <div key={`${r.taxType}|${r.label}|${j}`}>
                            {r.label || 'Sales'} · {money(r.amount, cur)}
                            {r.vat != null && <> · VAT {money(r.vat, cur)}</>}
                            {r.vatBooked != null && r.vatBooked !== r.vat && <span style={{ color: 'var(--t4)' }}> (ServOS booked {money(r.vatBooked, cur)})</span>}
                            {!r.taxType && <b style={{ color: '#c33' }}> · no Xero rate chosen</b>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {(syncResult?.warnings || []).length > 0 && !(syncResult.model === 'sales_invoice' && syncResult.dryRun) && (
              <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'rgba(200,150,40,.12)', border: '1px solid rgba(200,150,40,.3)' }}>
                {(syncResult.warnings || []).map((w, i) => (
                  <div key={w.code || i} style={{ fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.5, marginTop: i ? 6 : 0 }}>
                    <b>{w.count ? `${w.count} × ` : ''}</b>{w.message}
                  </div>
                ))}
              </div>
            )}
            <div style={{ ...S.note, marginTop: 10 }}>Safe to click more than once. A day already sent won’t be duplicated, and a day that stopped halfway finishes without sending the first half again.</div>
            {lapsed && (
              <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 10, background: 'rgba(200,150,40,.12)', border: '1px solid rgba(200,150,40,.3)', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: 'var(--t1)' }}><b>Paused:</b> nightly posting waits until a day&rsquo;s figures are checked again, because the choices changed.</span>
                <button style={S.ghost} onClick={() => setTab('setup')}>Check figures</button>
              </div>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--bdr)' }}>
              <input type="checkbox" checked={autoDaily} disabled={autoBusy}
                onChange={async (e) => {
                  const v = e.target.checked;
                  setAutoDaily(v); setAutoBusy(true); setAutoErr('');
                  try { await xeroSetAutoDaily(locId, v); } catch (er) { setAutoDaily(!v); setAutoErr(er.message || 'Could not change auto posting'); } finally { setAutoBusy(false); }
                }}
                style={{ width: 17, height: 17 }} />
              <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--t1)' }}>Auto-post each night</span>
              <span style={{ fontSize: 12, color: 'var(--t4)' }}>Each business day posts automatically about four hours after it ends, so a till that was offline has time to catch up. Days with no sales are skipped.</span>
            </label>
            {autoErr && <div style={{ ...S.banner(false), marginTop: 10 }}>{autoErr}</div>}
          </div>
        </div>
        <MappingCard locId={locId} blocked={refused} postMode={postMode} tabName={tabName} onSaved={refreshMode} />
        </>
        )}
        {tab === 'setup' && <SiteSetup locId={locId} venue={venue} siblings={siblings} postMode={postMode} onModeChange={refreshMode} />}
        {tab === 'postings' && <PostingsHistory locId={locId} hasSiblings={siblings.length > 0} currency={venue?.currency} postMode={postMode} startDate={startDate} />}
        </>
      ) : (
        <div style={S.card}>
          <div style={S.pill('rgba(120,120,120,.16)', 'var(--t2)')}>● Not connected</div>
          <div style={{ ...S.note, marginTop: 12, marginBottom: 16 }}>
            Click below and sign in to Xero, then choose the organisation for this venue. You’ll be brought straight back here.
          </div>
          <button style={S.btn} onClick={connect} disabled={busy}>{busy ? 'Opening Xero…' : 'Connect Xero'}</button>
        </div>
      )}

      <div style={{ ...S.note, maxWidth: 620, marginTop: 6 }}>
        Your Xero login and tokens are stored securely on the server and never shown here. Disconnecting removes them and revokes access in Xero.
      </div>
    </div>
  );
}
