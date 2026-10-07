// Back Office → Settings → Xero → Connection: which Xero organisation this site posts to.
// 7 Oct 2026: Coffee Boy has two Xero organisations under one Xero sign in, and every site was
// stored on the first. Two ways to put a site on the right one, neither needs a disconnect:
//   - the organisation is in the list: pick it;
//   - it is not: Sign in to Xero and choose it on Xero's own screen.
// Either way the server clears the site's Xero setup first (accounts, VAT rates, payment
// accounts, tracking, the figures check), because those choices named things in the OLD
// organisation. The words below say exactly that, and what does and does not then happen by
// itself (lib: supabase/functions/_shared/xeroOrg.js).
// When Xero did not ask which organisation, the amber box asks here (ask). For a site that was
// disconnected, the hourly job also posts nothing until the answer or half an hour (held).
import { useCallback, useEffect, useState } from 'react';
import { xeroOrganisations, xeroSetOrganisation } from '../../../lib/xero';
import { moveWords } from '../../../lib/accounting/xeroMoveWords';
import { autoDailyAfterOrganisationChange } from '../../../../supabase/functions/_shared/xeroOrg.js';

const dayWords = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); } catch { return ''; } };

export default function OrganisationPicker({ locId, currentName, postMode, autoDaily = false, startDate = null, needsSetup = false, changed, setupTab = 'Setup', busy: parentBusy, onSignIn, onChanged, S }) {
  const [orgs, setOrgs] = useState(null);
  const [siteName, setSiteName] = useState('');
  const [others, setOthers] = useState(0);
  const [ask, setAsk] = useState(false);          // just signed in, and Xero did not say which organisation
  const [held, setHeld] = useState(false);        // the hourly job is waiting for that answer (autoPostHeld)
  const [asked, setAsked] = useState(true);       // false: Xero could not be asked, so the list is not known
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [supported, setSupported] = useState(true);

  const load = useCallback(async () => {
    if (!locId) return;
    try {
      const r = await xeroOrganisations(locId);
      const list = r?.organisations || [];
      setOrgs(list);
      setSiteName(r?.siteName || '');
      setOthers(Number(r?.others) || 0);
      setAsk(!!r?.ask);
      setHeld(!!r?.held);
      setAsked(!r?.lookupError);
      setPick(list.find((o) => o.current)?.tenantId || '');
      setErr(r?.lookupError ? `ServOS could not ask Xero which organisations this sign in can see (${r.lookupError}). Try again in a minute.` : '');
    } catch (e) {
      // The server function is older than this screen (not deployed yet): show nothing.
      if (/unknown action/i.test(String(e?.message || ''))) { setSupported(false); return; }
      setOrgs([]); setAsked(false);
      setErr(e.message || 'Could not list the Xero organisations');
    }
  }, [locId]);
  useEffect(() => { load(); }, [load]);

  if (!supported || orgs === null) return null;
  const current = orgs.find((o) => o.current);
  const here = current?.tenantName || currentName || 'this organisation';
  const site = siteName || 'this site';
  const chosen = orgs.find((o) => o.tenantId === pick);
  const invoice = postMode === 'sales_invoice';
  // The server's own rule for what a move does to auto posting, so the words match what happens.
  const autoKept = autoDailyAfterOrganisationChange(postMode, autoDaily, startDate, new Date().toISOString().slice(0, 10));
  const words = (to) => moveWords({ site, from: here, to, invoice, autoKept, setupTab });

  const apply = async () => {
    if (!chosen || chosen.current || busy) return;
    if (!window.confirm(words(chosen.tenantName))) return;
    setBusy(true); setErr(''); setNote('');
    try {
      const r = await xeroSetOrganisation(locId, chosen.tenantId);
      const to = r?.tenant_name || chosen.tenantName;
      setNote(invoice
        ? `${r?.siteName || site} now posts to ${to}. Next: choose its accounts, VAT rates and tracking under ${setupTab}, then check a day's figures.${r?.autoTurnedOff ? ' Auto posting was turned off: turn it back on under Posting.' : ''}`
        : `${r?.siteName || site} now posts to ${to}. Next: choose its accounts under Posting (Account mapping). Auto posting is off until you turn it back on there.`);
      await load();
      if (onChanged) await onChanged();
    } catch (e) { setErr(e.message || 'Could not change the organisation'); } finally { setBusy(false); }
  };

  const signIn = () => {
    if (!onSignIn || busy) return;
    const ok = window.confirm(
      `Sign in to Xero.\n\n` +
      `If Xero asks which organisation, choose the one ${site}'s books are in.\n` +
      `If Xero only says how many organisations are connected, press Continue: you then pick the organisation here, on this screen.\n\n` +
      `Nothing changes for ${site} until you pick a different organisation from ${here}.`,
    );
    if (ok) onSignIn();
  };

  const box = { marginTop: 14, padding: 12, borderRadius: 10, background: 'var(--bg3)', border: '1px solid var(--bdr2)' };
  const text = { fontSize: 15, color: 'var(--t2)', lineHeight: 1.5 };
  return (
    <div style={box}>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 6 }}>Xero organisation</div>
      {changed?.at && (
        <div style={{ ...text, marginBottom: 8, color: 'var(--t1)' }}>
          Moved here from <b>{changed.from}</b> on {dayWords(changed.at)}.
          {needsSetup && <> Its Xero setup was cleared then: choose it again under {setupTab} and Posting, then check a day&rsquo;s figures.</>}
          {changed.autoTurnedOff && !autoDaily && <> Auto posting was turned off then and is still off.</>}
        </div>
      )}
      {!asked ? (
        <div style={text}>This site posts to <b>{here}</b>.</div>
      ) : orgs.length >= 2 ? (
        <>
          {ask ? (
            <div style={{ ...text, marginBottom: 10, padding: 10, borderRadius: 8, background: 'rgba(200,150,40,.14)', border: '1px solid rgba(200,150,40,.45)', color: 'var(--t1)' }}>
              <b>Which organisation are {site}&rsquo;s books in?</b> Your Xero sign in covers {orgs.length} organisations and Xero did not ask which one.
              {' '}{site} is on <b>{here}</b> for now. If that is wrong, pick the right one and press Use this organisation.
              {held && autoDaily && <> Nothing is posted by itself for {site} in the half hour after your sign in, so there is time to pick.</>}
            </div>
          ) : (
            <div style={{ ...text, marginBottom: 10 }}>
              <b>{site}</b> posts to <b>{here}</b>. If its books are in another organisation, pick it here.
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy || parentBusy}
              style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit' }}>
              {orgs.map((o) => <option key={o.tenantId} value={o.tenantId}>{o.tenantName}{o.current ? ' (current)' : ''}</option>)}
            </select>
            <button style={S?.ghost} onClick={apply} disabled={busy || parentBusy || !chosen || chosen.current}>{busy ? 'Changing…' : 'Use this organisation'}</button>
          </div>
        </>
      ) : (
        <div style={text}><b>{site}</b> posts to <b>{here}</b>.{others > 0 ? ' This Xero sign in covers other organisations too: press Sign in to Xero, then pick the right one here.' : ''}</div>
      )}
      {onSignIn && (
        <div style={{ ...text, marginTop: 10 }}>
          Organisation not listed?{' '}
          <button style={{ ...(S?.ghost || {}), padding: '6px 10px' }} onClick={signIn} disabled={busy || parentBusy}>Sign in to Xero</button>{' '}
          then pick it here.
        </div>
      )}
      {err && <div style={{ marginTop: 8, fontSize: 14, color: 'var(--red)' }}>{err}</div>}
      {note && <div style={{ marginTop: 8, fontSize: 14, color: 'var(--grn)' }}>{note}</div>}
    </div>
  );
}
