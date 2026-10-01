// src/backoffice/sections/xero/CheckFigures.jsx
//
// "Check figures": the exact sales invoice and credit note ServOS would send to Xero for a
// chosen business day, worked out from the saved choices. Nothing is sent. Once someone (ideally
// the accountant) has read a real day through, they tick "I have checked these figures"; the
// tick lapses when the choices change, and the site cannot switch to the sales invoice without it.
// The result stays on screen after a save or the tick (the setup refreshes in the background);
// figures worked out before the last save say so and cannot be ticked.

import { useState } from 'react';
import { xeroCheckFigures, xeroFiguresChecked } from '../../../lib/xero';
import { S, btn } from './xeroUi';
import { Bullets } from './controls';
import InvoicePreview from './InvoicePreview';

export default function CheckFigures({ locId, venue, accounts, dirty, checked, savedHash, onChecked }) {
  const [date, setDate] = useState(venue?.lastCompletedDay || '');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const run = async () => {
    if (!date) return;
    setBusy('check'); setErr(''); setRes(null);
    try { setRes(await xeroCheckFigures(locId, date)); } catch (e) { setErr(e.message || 'Could not work out the figures'); } finally { setBusy(''); }
  };
  const tick = async () => {
    setBusy('tick'); setErr('');
    try { const r = await xeroFiguresChecked(locId, res.date, res.mappingHash); onChecked?.(r.figuresChecked); } catch (e) { setErr(e.message || 'Could not save'); } finally { setBusy(''); }
  };
  // Worked out before the last save: the choices have changed since.
  const stale = !!res?.ok && !!savedHash && !!res.mappingHash && res.mappingHash !== savedHash;
  const ticked = !!res?.ok && !!checked?.hash && checked.hash === res.mappingHash && checked.date === res.date;
  const canTick = res?.ok && !res.empty && !dirty && !stale && !ticked && !(res.problems || []).length && !(res.notReady || []).length;
  return (
    <div>
      <Bullets items={[
        ['Nothing is sent:', 'this works out the sales invoice for one business day from the saved choices, exactly as it would be sent.'],
        ['Pick a busy day,', 'and read it through with your accountant if you can.'],
        ['Then tick', '"I have checked these figures". Nightly posting needs the tick, and a saved change takes it away.'],
      ]} />
      {checked?.date && <div style={{ ...S.note, marginTop: 6 }}>Last checked: the figures for {checked.date}, on {new Date(checked.at).toLocaleDateString()}.</div>}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
        <input type="date" value={date} max={venue?.lastCompletedDay || undefined} onChange={(e) => setDate(e.target.value)}
          style={{ border: '1px solid var(--bdr2)', borderRadius: 9, padding: '9px 11px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)' }} />
        <button style={S.ghost} onClick={run} disabled={!!busy || !date}>{busy === 'check' ? 'Working out…' : 'Check figures'}</button>
      </div>
      {dirty && <div style={{ ...S.note, marginTop: 8, color: '#c89628' }}>You have unsaved changes. Save first: the figures use the saved choices.</div>}
      {err && <div style={{ ...S.banner(false), marginTop: 12 }}>{err}</div>}
      {res?.empty && <div style={{ ...S.info, marginTop: 12 }}>No sales or refunds on {res.date}. Pick another day.</div>}
      {res?.ok && !res.empty && (
        <div style={{ marginTop: 12 }}>
          <div style={{ ...S.banner(true), maxWidth: 'none' }}>Figures for {res.date}. Nothing has been sent to Xero.</div>
          <InvoicePreview result={res} accounts={accounts} />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
            <button style={btn(!canTick || !!busy)} onClick={tick} disabled={!canTick || !!busy}>{busy === 'tick' ? 'Saving…' : ticked ? '✓ Checked' : 'I have checked these figures'}</button>
            {!canTick && !ticked && <span style={S.note}>{(res.problems || []).length || (res.notReady || []).length ? 'Fix what stops this day first.' : dirty ? 'Save your changes first.' : stale ? 'These figures were worked out before your last save. Press Check figures again.' : ''}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
