// src/backoffice/sections/xero/ReplaceDay.jsx
//
// "Replace with a daily sales invoice" for a day that is in Xero as bank transactions, the old
// way (2 Oct 2026). Peter switched Leeds to the sales invoice from 27 Sep, pushed 27 Sep again
// and said "these are supposed to be invoices, I cannot find the invoice at all": the push
// answered "already" and sent nothing, because a day is never posted both ways.
//
// Two steps, never one: the button first shows a preview (the old entries with their references
// and totals, reconciled or not, and the invoice number it will create; nothing is changed), then
// a confirm. Xero cannot restore a deleted transaction, so the confirm says so. After it: the
// invoice number and Open in Xero. If the invoice could not be sent after the old entries were
// removed, it says exactly that and offers Push again (a normal push finishes it as an invoice).
// Before xero-sales can replace (not deployed yet) the preview comes back without its
// `replacePreview`: an honest "needs a ServOS update" line, and no way to confirm.

import { useCallback, useEffect, useState } from 'react';
import { xeroReplaceDayPreview, xeroReplaceDay, xeroSyncSales } from '../../../lib/xero';
import { money } from '../../../lib/currency';
import { NEEDS_UPDATE, OLD_REMOVED } from '../../../../supabase/functions/_shared/xeroReplacePlan.js';
import { S, btn } from './xeroUi';
import { Bullets } from './controls';

const row = { fontSize: 13, padding: '7px 10px', border: '1px solid var(--bdr2)', borderRadius: 8, marginBottom: 6, background: 'var(--bg2)', display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' };
const tag = (bad) => ({ fontSize: 11.5, fontWeight: 800, color: bad ? '#c33' : 'var(--t3)', whiteSpace: 'nowrap' });

/** The invoice (or, on a day of refunds only, the credit note) a finished replace created. */
const mainDoc = (r) => (r?.documents || []).find((d) => d.type === 'invoice') || (r?.documents || []).find((d) => d.type === 'credit_note') || null;

// autoPreview: open straight on the preview (the Postings row's button already said "Replace").
// onDone(result): the invoice is in Xero. onAttempt(): a real attempt ended, whatever the outcome
// (the Postings list reloads). onFail(error): a real attempt (never the preview) failed; the
// Posting tab uses it to take down an "Already pushed" answer that is no longer true once old
// entries were removed (2 Oct 2026 review). onCancel(): the person backed out.
export default function ReplaceDay({ locId, date, currency, resume = false, autoPreview = false, onDone, onAttempt, onFail, onCancel, style }) {
  const [step, setStep] = useState('idle');   // idle | preview | done
  const [busy, setBusy] = useState('');       // '' | 'preview' | 'replace' | 'push'
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');
  const [pending, setPending] = useState(false);   // old entries removed, invoice not in Xero yet
  const [result, setResult] = useState(null);

  const fail = (e) => {
    const why = (e.notReady || []).map((n) => n.message).join(' ');
    setErr(`${e.message || 'That did not work.'}${why && !String(e.message || '').includes(why) ? ` ${why}` : ''}`);
    if (e.invoicePending) setPending(true);
    // The day is part way after all (some old entries still to remove): offer to finish, not Push again.
    else if (e.replace?.resume) setPending(false);
  };
  const finish = (r) => { setResult(r); setPending(false); setStep('done'); onDone?.(r); };
  const loadPreview = useCallback(async () => {
    setBusy('preview'); setErr('');
    try {
      const r = await xeroReplaceDayPreview(locId, date);
      // An xero-sales from before this feature answers an ordinary dry run: say so, change nothing.
      if (!r?.replacePreview) { setErr(`${NEEDS_UPDATE} Nothing was changed.`); setPreview(null); setStep('idle'); return; }
      setPreview(r.replacePreview); setPending(!!r.replacePreview.pending); setStep('preview');
    } catch (e) { fail(e); } finally { setBusy(''); }
  }, [locId, date]);
  useEffect(() => { if (autoPreview) loadPreview(); }, [autoPreview, loadPreview]);
  const confirm = async () => {
    setBusy('replace'); setErr('');
    try { finish(await xeroReplaceDay(locId, date)); }
    catch (e) { fail(e); setStep('idle'); onFail?.(e); } finally { setBusy(''); onAttempt?.(); }
  };
  // The old entries are gone and the invoice is not in Xero yet: a normal push sends it.
  const pushAgain = async () => {
    setBusy('push'); setErr('');
    try {
      const r = await xeroSyncSales(locId, date);
      if (r?.ok && !r.empty && r.model === 'sales_invoice') finish(r);
      else setErr('The sales invoice is still not in Xero. Press Push again.');
    } catch (e) { fail(e); onFail?.(e); } finally { setBusy(''); onAttempt?.(); }
  };

  const doc = mainDoc(result);
  if (step === 'done') {
    return (
      <div style={style}>
        <div style={{ ...S.banner(true), maxWidth: 'none', marginBottom: 8 }}>
          ✓ {date} is now in Xero as {doc ? `${doc.type === 'invoice' ? 'sales invoice' : 'credit note'} ${doc.number}` : 'a sales invoice'}.{result?.replaced ? ` ${OLD_REMOVED}` : ''}
          {doc?.link && <> <a href={doc.link} target="_blank" rel="noreferrer" style={{ color: 'inherit', fontWeight: 800 }}>Open in Xero ↗</a></>}
        </div>
        {onCancel && <button style={S.small} onClick={onCancel}>Close</button>}
      </div>
    );
  }

  const old = preview?.old || [];
  return (
    <div style={style}>
      {err && <div style={{ ...S.banner(false), maxWidth: 'none' }}>{err}</div>}
      {step !== 'preview' && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {pending
            ? <button style={btn(!!busy)} onClick={pushAgain} disabled={!!busy}>{busy === 'push' ? 'Pushing…' : 'Push again'}</button>
            : (
              <button style={S.ghost} onClick={loadPreview} disabled={!!busy}>
                {busy === 'preview' ? 'Checking Xero…' : resume ? 'Finish replacing with invoice' : err ? 'Check again' : 'Replace with invoice'}
              </button>
            )}
          {onCancel && <button style={S.ghost} onClick={onCancel} disabled={!!busy}>Close</button>}
        </div>
      )}
      {step === 'preview' && preview && (
        <div style={{ border: '1px solid var(--bdr2)', borderRadius: 10, padding: 12 }}>
          {preview.pending ? (
            <div style={{ ...S.note, color: 'var(--t1)', marginBottom: 8 }}>{OLD_REMOVED} The sales invoice {preview.invoice?.number || ''} has not been sent yet.</div>
          ) : (
            <>
              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--t1)', marginBottom: 6 }}>These will be removed from Xero</div>
              {old.map((o) => (
                <div key={o.key} style={row}>
                  <span style={{ color: 'var(--t1)', fontWeight: 700 }}>{o.kind} · {o.reference} · {money(o.total, currency)}</span>
                  <span style={tag(o.reconciled || o.state === 'missing' || o.state === 'not_ours')}>
                    {o.state === 'deleted' ? 'Already removed' : o.reconciled ? 'Reconciled in Xero' : o.state === 'missing' ? 'Not found in Xero' : o.state === 'not_ours' ? 'Not the same transaction' : o.xeroTotal != null ? `Xero now shows ${money(o.xeroTotal, currency)}` : 'Not reconciled'}
                  </span>
                </div>
              ))}
              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--t1)', margin: '10px 0 6px' }}>This will be sent instead</div>
              {preview.invoice && <div style={row}><span style={{ color: 'var(--t1)', fontWeight: 700 }}>Sales invoice {preview.invoice.number} · {money(preview.invoice.total, currency)}</span></div>}
              {preview.creditNote && <div style={row}><span style={{ color: 'var(--t1)', fontWeight: 700 }}>Credit note {preview.creditNote.number} (refunds) · {money(preview.creditNote.total, currency)}</span></div>}
            </>
          )}
          {(preview.problems || []).length > 0 && (
            <div style={{ ...S.banner(false), maxWidth: 'none', marginTop: 8 }}>
              {preview.problems.map((p, i) => <div key={i} style={{ marginTop: i ? 6 : 0 }}>{p}</div>)}
              <div style={{ marginTop: 6 }}>Nothing has been changed.</div>
            </div>
          )}
          {preview.canReplace && !preview.pending && (
            <Bullets style={{ marginBottom: 10 }} items={[
              ['Cannot be undone:', 'Xero cannot restore a deleted transaction.'],
              ['Safe to stop:', 'if Xero refuses one, nothing more is removed and this screen says what to do.'],
              ['Same figures:', 'the invoice is the one Check figures shows for this day.'],
            ]} />
          )}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
            {preview.canReplace && (preview.pending
              ? <button style={btn(!!busy)} onClick={pushAgain} disabled={!!busy}>{busy === 'push' ? 'Pushing…' : 'Send the invoice'}</button>
              : <button style={btn(!!busy)} onClick={confirm} disabled={!!busy}>{busy === 'replace' ? 'Replacing…' : preview.resume ? 'Finish: remove the rest and send the invoice' : 'Remove these and send the invoice'}</button>)}
            {!preview.canReplace && <button style={S.ghost} onClick={loadPreview} disabled={!!busy}>{busy === 'preview' ? 'Checking Xero…' : 'Check again'}</button>}
            <button style={S.ghost} onClick={() => { setStep('idle'); setErr(''); onCancel?.(); }} disabled={!!busy}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
