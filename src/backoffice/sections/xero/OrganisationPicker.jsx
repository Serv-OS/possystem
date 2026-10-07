// Back Office → Settings → Xero → Connection: which Xero organisation this site posts to.
// 7 Oct 2026: Coffee Boy has two Xero organisations under one Xero sign in, and every site was
// stored on the first. Two ways to put a site on the right one, neither needs a disconnect:
//   - the sign in can already see the organisation: pick it from the list;
//   - it cannot yet: Sign in to Xero and choose it on Xero's own screen.
// Either way the site's Xero setup (accounts, VAT rates, tracking, the figures check) is
// cleared by the server first, because those choices named things in the OLD organisation.
import { useCallback, useEffect, useState } from 'react';
import { xeroOrganisations, xeroSetOrganisation } from '../../../lib/xero';

const dayWords = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); } catch { return ''; } };

export default function OrganisationPicker({ locId, currentName, postMode, changed, setupTab = 'Setup', busy: parentBusy, onSignIn, onChanged, S }) {
  const [orgs, setOrgs] = useState(null);
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
      setPick(list.find((o) => o.current)?.tenantId || '');
      setErr(r?.error ? `ServOS could not ask Xero which organisations this sign in can see: ${r.error}` : '');
    } catch (e) {
      // The server function is older than this screen (not deployed yet): show nothing.
      if (/unknown action/i.test(String(e?.message || ''))) { setSupported(false); return; }
      setOrgs([]);
      setErr(e.message || 'Could not list the Xero organisations');
    }
  }, [locId]);
  useEffect(() => { load(); }, [load]);

  if (!supported || orgs === null) return null;
  const current = orgs.find((o) => o.current);
  const here = current?.tenantName || currentName || 'this organisation';
  const chosen = orgs.find((o) => o.tenantId === pick);
  const invoice = postMode === 'sales_invoice';
  const after = invoice
    ? `Nothing posts for this site until that is done. Then it posts by itself again.`
    : `Auto posting is turned off for this site. Turn it back on when the accounts are chosen.`;
  const whatHappens = (to) =>
    `Post this site's sales to ${to} instead of ${here}?\n\n` +
    `1. This site's Xero setup is cleared: accounts, VAT rates, payment accounts and the Site tracking option. They belong to ${here}. Choose them again for ${to} under ${setupTab}, then check a day's figures.\n` +
    `2. ${after}\n` +
    `3. Days already posted stay in ${here}. Ask the accountant to void them there if they should not be.`;

  const apply = async () => {
    if (!chosen || chosen.current || busy) return;
    if (!window.confirm(whatHappens(chosen.tenantName))) return;
    setBusy(true); setErr(''); setNote('');
    try {
      const r = await xeroSetOrganisation(locId, chosen.tenantId);
      setNote(`This site now posts to ${r?.tenant_name || chosen.tenantName}. Next: ${setupTab}, choose its accounts, VAT rates and tracking, then check a day's figures.${r?.autoTurnedOff ? ' Auto posting is off until you turn it back on.' : ''}`);
      await load();
      if (onChanged) await onChanged();
    } catch (e) { setErr(e.message || 'Could not change the organisation'); } finally { setBusy(false); }
  };

  const signIn = () => {
    if (!onSignIn || busy) return;
    const ok = window.confirm(
      `Sign in to Xero and choose the organisation this site's books are in.\n\n` +
      `If you choose a different organisation from ${here}:\n` + whatHappens('the one you choose').split('\n\n')[1],
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
          Moved here from <b>{changed.from}</b> on {dayWords(changed.at)}. Its accounts, VAT rates and tracking are chosen again under {setupTab}.
        </div>
      )}
      {orgs.length >= 2 ? (
        <>
          <div style={{ ...text, marginBottom: 10 }}>
            This Xero sign in can see {orgs.length} organisations. This site posts to <b>{here}</b>. If its books are in another one, pick it here.
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy || parentBusy}
              style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit' }}>
              {orgs.map((o) => <option key={o.tenantId} value={o.tenantId}>{o.tenantName}{o.current ? ' (current)' : ''}</option>)}
            </select>
            <button style={S?.ghost} onClick={apply} disabled={busy || parentBusy || !chosen || chosen.current}>{busy ? 'Changing…' : 'Use this organisation'}</button>
          </div>
        </>
      ) : (
        <div style={text}>This site posts to <b>{here}</b>, the only organisation this Xero sign in has connected to ServOS.</div>
      )}
      {onSignIn && (
        <div style={{ ...text, marginTop: 10 }}>
          Organisation not listed?{' '}
          <button style={{ ...(S?.ghost || {}), padding: '6px 10px' }} onClick={signIn} disabled={busy || parentBusy}>Sign in to Xero and choose it</button>
        </div>
      )}
      {err && <div style={{ marginTop: 8, fontSize: 14, color: 'var(--red)' }}>{err}</div>}
      {note && <div style={{ marginTop: 8, fontSize: 14, color: 'var(--grn)' }}>{note}</div>}
    </div>
  );
}
