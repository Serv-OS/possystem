// src/backoffice/sections/xero/LightspeedCopy.jsx
//
// "Copy my Lightspeed setup": reads (read only) the most recent Lightspeed sales invoices in
// this Xero organisation, with their payments, tracking and accounts, and suggests this site's
// choices from what Lightspeed used. Each suggestion has a tick box and its evidence; "Use
// selected" fills the unsaved form. Nothing is saved until Save.
// Site safety (30 Sep 2026 review): payment accounts are per site, so they are suggested only
// from invoices carrying this site's tracking option. When no option clearly names the site,
// the person picks it here and the invoices are read again. Categories join a sales group only
// on an exact name match, one tick box per pair.

import { useState } from 'react';
import { xeroLightspeedSuggest } from '../../../lib/xero';
import { money } from '../../../lib/currency';
import { clearingLabel } from '../../../../supabase/functions/_shared/xeroInvoicePlan.js';
import { DISCOUNT_GROUP_NAMES } from '../../../../supabase/functions/_shared/accountingGroups.js';
import { S, btn, input, sel, findAccount, accountLabel } from './xeroUi';
import { Bullets } from './controls';

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 16px', overflowY: 'auto' };
const box = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 20, width: '100%', maxWidth: 760, boxSizing: 'border-box' };

// The suggestions as tickable rows: { id, label, detail, apply(patch, map) }.
function rowsFrom(s, accounts, currency) {
  if (!s) return [];
  const acct = (ref) => { const a = findAccount(accounts, ref); return a ? accountLabel(a) : ref; };
  const rows = [];
  if (s.tracking?.optionName) {
    rows.push({ id: 'tracking', label: `Site tracking: ${s.tracking.categoryName}, ${s.tracking.optionName}`, detail: s.tracking.confidence === 'chosen' ? 'The option you chose for this site.' : 'The option Lightspeed put on this site’s lines.',
      apply: (p) => { p.tracking = { categoryId: s.tracking.categoryId, categoryName: s.tracking.categoryName, optionId: s.tracking.optionId, optionName: s.tracking.optionName }; } });
  }
  for (const g of s.groups || []) {
    if (!g.account) continue;
    rows.push({ id: `g:${g.key}`, label: `Sales group "${g.name}" to ${acct(g.account)}`, detail: `${g.lines} line(s), ${money(g.amount, currency)}${g.taxTypes?.length ? `, ${g.taxTypes.join(', ')}` : ''}`,
      apply: (p, m) => { p.groups = { ...(p.groups || m.groups || {}), [g.key]: { name: g.name, account: g.account } }; } });
  }
  for (const [d, a] of Object.entries(s.discounts?.accounts || {})) {
    if (!a) continue;
    rows.push({ id: `d:${d}`, label: `${DISCOUNT_GROUP_NAMES[d] || d} to ${acct(a)}`, detail: 'From Lightspeed’s discount lines.',
      apply: (p, m) => { const cur = p.discounts || m.discounts || {}; p.discounts = { ...cur, accounts: { ...(cur.accounts || {}), [d]: a } }; } });
  }
  if (s.tipsAccount) rows.push({ id: 'tips', label: `Tips to ${acct(s.tipsAccount)}`, detail: '', apply: (p) => { p.tipsAccount = s.tipsAccount; } });
  if (s.serviceAccount) rows.push({ id: 'service', label: `Service charge to ${acct(s.serviceAccount)}`, detail: '', apply: (p) => { p.serviceAccount = s.serviceAccount; } });
  if (s.giftLiabilityAccount) rows.push({ id: 'gift', label: `Gift cards to ${acct(s.giftLiabilityAccount)}`, detail: 'Gift cards sold, and gift cards spent as payment.', apply: (p) => { p.giftLiabilityAccount = s.giftLiabilityAccount; } });
  for (const [k, a] of Object.entries(s.clearing || {})) {
    if (!a) continue;
    rows.push({ id: `c:${k}`, label: `${clearingLabel(k)} payments to ${acct(a)}`, detail: 'Where Lightspeed put this kind of payment for this site.',
      apply: (p, m) => { p.clearing = { ...(p.clearing || m.clearing || {}), [k]: a }; } });
  }
  // One row per category and group pair, so each can be checked and unticked on its own.
  for (const c of s.categoryPairs || []) {
    rows.push({ id: `cat:${c.id}`, label: `Menu category "${c.label}" in the sales group "${c.groupName}"`, detail: 'Same name. A category that already has a group keeps it.',
      apply: (p, m) => { const cur = { ...(p.categoryGroups || m.categoryGroups || {}) }; if (!cur[c.id]) cur[c.id] = c.group; p.categoryGroups = cur; } });
  }
  return rows;
}

export default function LightspeedCopy({ locId, accounts, currency, map, onApply, onClose }) {
  const [contact, setContact] = useState('');
  const [option, setOption] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState({});
  const s = res?.suggestion || null;
  const rows = rowsFrom(s, accounts, currency);
  const look = async (chosen) => {
    setBusy(true); setErr(''); setRes(null);
    try {
      const r = await xeroLightspeedSuggest(locId, contact.trim(), chosen ? { optionId: chosen } : undefined);
      setRes(r);
      setPicked(Object.fromEntries(rowsFrom(r.suggestion, accounts, currency).map((x) => [x.id, true])));
    } catch (e) { setErr(e.message || 'Could not read Xero'); } finally { setBusy(false); }
  };
  const use = () => {
    const patch = {};
    for (const r of rows) if (picked[r.id]) r.apply(patch, map);
    if (s?.lastLightspeedDate) patch.lightspeed = { lastDate: s.lastLightspeedDate, checkedAt: new Date().toISOString(), invoices: s.source?.count || 0 };
    onApply(patch);
  };
  const needsOption = !!s?.source?.count && !s.source.siteOnly && (s.tracking?.options || []).length > 0;
  return (
    <div style={overlay} onClick={onClose}>
      <div style={box} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={S.h2}>Copy my Lightspeed setup</div>
          <button style={S.small} onClick={onClose}>Close</button>
        </div>
        <Bullets items={[
          ['Read only:', 'ServOS reads the latest Lightspeed sales invoices in this Xero. Nothing in Xero changes.'],
          ['Suggests', 'the same accounts, tracking and payment accounts for this site.'],
          ['Tick', 'what to use. Nothing is saved until you press Save.'],
        ]} />
        <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
          <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Lightspeed's contact name in Xero (optional)" style={{ ...input, flex: 1, minWidth: 220 }} />
          <button style={S.btn} onClick={() => look(option)} disabled={busy}>{busy ? 'Reading Xero…' : res ? 'Look again' : 'Look in Xero'}</button>
        </div>
        {err && <div style={{ ...S.banner(false), marginTop: 12 }}>{err}</div>}
        {res && !s?.source?.count && (
          <div style={{ ...S.info, marginTop: 12 }}>
            No Lightspeed sales invoices were found{res.contactsFound?.length ? ` for ${res.contactsFound.join(', ')}` : ''}. If Lightspeed posted manual journals instead of invoices, this helper cannot read them yet. Try the name of the contact Lightspeed used, or set the choices by hand.
          </div>
        )}
        {s?.source?.count > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={S.note}>
              Read {s.source.count} invoice(s) {s.source.from ? `from ${s.source.from} to ${s.source.to}` : ''} for {s.source.contacts.join(', ') || 'Lightspeed'}{s.source.numbers?.length ? ` (${s.source.numbers.slice(0, 6).join(', ')}${s.source.numbers.length > 6 ? ', and more' : ''})` : ''}.
              {s.source.siteOnly ? ' Only the invoices with this site’s tracking option were used.' : ''}
            </div>
            {needsOption && (
              <div style={{ ...S.warn, marginTop: 10 }}>
                <Bullets style={{ marginTop: 0 }} items={[
                  ['Which site?', `No tracking option in ${s.tracking.categoryName || 'Xero'} clearly names this site, so these invoices are every site's.`],
                  ['Payment accounts', 'are not suggested yet: they would be another site’s. Choose this site’s option, then look again.'],
                ]} />
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <select value={option} onChange={(e) => setOption(e.target.value)} style={{ ...sel, width: 'auto', minWidth: 200 }}>
                    <option value="">This site&rsquo;s option…</option>
                    {s.tracking.options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                  <button style={S.ghost} onClick={() => look(option)} disabled={!option || busy}>Look again with this option</button>
                </div>
              </div>
            )}
            {s.lastLightspeedDate && <div style={{ ...S.info, marginTop: 10 }}>Lightspeed posted {s.source.siteOnly ? 'this site’s' : 'sales'} up to {s.lastLightspeedDate}. Start ServOS&rsquo;s invoices on a later day, or the same sales will be in Xero twice.</div>}
            <div style={{ marginTop: 10 }}>
              {rows.map((r) => (
                <label key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '7px 0', borderBottom: '1px solid var(--bdr)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!picked[r.id]} onChange={(e) => setPicked((p) => ({ ...p, [r.id]: e.target.checked }))} style={{ marginTop: 3 }} />
                  <span><span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{r.label}</span>{r.detail && <span style={{ display: 'block', fontSize: 12, color: 'var(--t3)' }}>{r.detail}</span>}</span>
                </label>
              ))}
            </div>
            {(s.unmatched || []).length > 0 && (
              <div style={{ ...S.note, marginTop: 10 }}>Not used: {s.unmatched.slice(0, 8).map((u) => `${u.description || 'a line'} (${money(u.amount, currency)})`).join(', ')}.</div>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button style={btn(!rows.some((r) => picked[r.id]))} onClick={use} disabled={!rows.some((r) => picked[r.id])}>Use selected</button>
              <button style={S.ghost} onClick={onClose}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
