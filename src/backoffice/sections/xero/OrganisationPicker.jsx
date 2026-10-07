// Back Office → Settings → Xero → Connection: which Xero organisation this site posts to.
// Shown only when the stored Xero sign in can see more than one organisation (a group with
// two companies, each with its own Xero). 7 Oct 2026: Coffee Boy's TDNZ sites were posting
// into Coffeeboy Retail LTD because the connect step stored the first organisation in the
// sign in's list, not the one chosen.
import { useCallback, useEffect, useState } from 'react';
import { xeroOrganisations, xeroSetOrganisation } from '../../../lib/xero';

export default function OrganisationPicker({ locId, currentName, onChanged, S }) {
  const [orgs, setOrgs] = useState(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    if (!locId) return;
    try {
      const r = await xeroOrganisations(locId);
      const list = r?.organisations || [];
      setOrgs(list);
      setPick(list.find((o) => o.current)?.tenantId || '');
      if (r?.error) setErr(`Could not list this sign in's organisations: ${r.error}`);
    } catch (e) { setErr(e.message || 'Could not list organisations'); }
  }, [locId]);
  useEffect(() => { load(); }, [load]);

  if (!orgs || orgs.length < 2) return null;
  const current = orgs.find((o) => o.current);
  const chosen = orgs.find((o) => o.tenantId === pick);

  const apply = async () => {
    if (!chosen || chosen.current) return;
    const ok = window.confirm(
      `Post this site's sales to ${chosen.tenantName} instead of ${current?.tenantName || currentName}?\n\n` +
      `Days already posted stay in ${current?.tenantName || currentName}: ask your accountant to void them there if they should not be.\n` +
      `The Site tracking option and the accounts are chosen again for ${chosen.tenantName} (Setup tab) before the next day posts.`,
    );
    if (!ok) return;
    setBusy(true); setErr(''); setNote('');
    try {
      const r = await xeroSetOrganisation(locId, chosen.tenantId);
      setNote(`This site now posts to ${r?.tenant_name || chosen.tenantName}. Check the Setup tab: tracking option and accounts.`);
      await load();
      if (onChanged) await onChanged();
    } catch (e) { setErr(e.message || 'Could not change organisation'); } finally { setBusy(false); }
  };

  return (
    <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: 'var(--bg3)', border: '1px solid var(--bdr2)' }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 6 }}>Xero organisation</div>
      <div style={{ fontSize: 15, color: 'var(--t2)', marginBottom: 10, lineHeight: 1.5 }}>
        This Xero sign in can see {orgs.length} organisations. This site posts to <b>{current?.tenantName || currentName}</b>.
        If this site's books live in another one, pick it here.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy}
          style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit' }}>
          {orgs.map((o) => <option key={o.tenantId} value={o.tenantId}>{o.tenantName}{o.current ? ' (current)' : ''}</option>)}
        </select>
        <button style={S?.ghost} onClick={apply} disabled={busy || !chosen || chosen.current}>{busy ? 'Changing…' : 'Use this organisation'}</button>
      </div>
      {err && <div style={{ marginTop: 8, fontSize: 14, color: 'var(--red)' }}>{err}</div>}
      {note && <div style={{ marginTop: 8, fontSize: 14, color: 'var(--grn)' }}>{note}</div>}
    </div>
  );
}
