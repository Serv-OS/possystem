// src/backoffice/sections/workforce/WfOnboarding.jsx
//
// Workforce › Onboarding — a real new-starter pipeline, per person:
//   1. Offer letter  — email the offer to the candidate (send-receipt)
//   2. Right to Work — upload the RTW document (private storage + compliance row)
//   3. Contract      — upload the contract + send a sign link; candidate signs
//                      via the public /sign/<token> page (lightweight e-sign)
//   4. Bank details  — captured for payroll (full details on the staff profile)
//   5. POS access    — set them up as a till user (auto-detected from posUserId)
// Each step writes through to wf_onboarding (steps + meta jsonb). Cases where
// every step is done show under the "Completed" tab.

import { useState, useEffect, useRef, useMemo } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { Card, EmptyState, Badge, RoleChip, initials, inputStyle, labelStyle, LoadingCard } from '../../../staff/wfUi';
import * as wf from '../../../staff/wfData';

export const STEPS = [
  { key: 'offer', label: 'Offer letter' },
  { key: 'rtw', label: 'Right to Work' },
  { key: 'contract', label: 'Contract' },
  { key: 'bank', label: 'Bank details' },
  { key: 'posUser', label: 'POS access' },
];
export const freshSteps = () => STEPS.map(s => ({ key: s.key, status: 'pending', completedAt: null }));

// A case counts as done when every step is complete, treating POS access as
// done if the staff record is already linked to a till user (that step is
// inferred from posUserId rather than ticked by hand).
export const caseDone = (c, member) => (c.steps || []).length > 0 && (c.steps || []).every(s => s.status === 'complete' || (s.key === 'posUser' && !!member?.posUserId));

// Older cases stored label-style step keys ("Right to work", "Bank & tax
// details", 7 steps). markStep matches on the short keys above, so against a
// legacy array it silently updates NOTHING — actions worked (email sent, doc
// uploaded, bank saved) but never ticked. Heal on load: rebuild the steps from
// the current STEPS, inferring completion from the meta evidence each action
// leaves behind. The healed shape persists on the next save.
const LEGACY_KEY_MAP = { 'Offer accepted': 'offer', 'Right to work': 'rtw', 'Contract signed': 'contract', 'Bank & tax details': 'bank', 'POS user created': 'posUser' };
function normalizeCase(c) {
  const meta = c.meta || {};
  const have = new Set((c.steps || []).map(s => s.key));
  if (STEPS.every(s => have.has(s.key))) return c;
  const legacy = {};
  (c.steps || []).forEach(s => { const k = LEGACY_KEY_MAP[s.key] || s.key; legacy[k] = s; });
  const inferred = {
    offer: meta.offerSentAt ? { status: 'complete', completedAt: meta.offerSentAt } : null,
    rtw: meta.rtwPath ? { status: 'complete', completedAt: null } : null,
    contract: meta.signature ? { status: 'complete', completedAt: meta.signature.signedAt || null }
      : (meta.contractHtml || meta.contractPath) ? { status: 'sent', completedAt: null } : null,
    bank: meta.bankMasked ? { status: 'complete', completedAt: meta.bankCapturedAt || null } : null,
    posUser: null,
  };
  const steps = STEPS.map(({ key }) => {
    const old = legacy[key];
    if (old?.status === 'complete') return { key, status: 'complete', completedAt: old.completedAt || null };
    const inf = inferred[key];
    return inf ? { key, ...inf } : { key, status: 'pending', completedAt: null };
  });
  const status = steps.every(s => s.status === 'complete') ? 'complete' : 'inProgress';
  return { ...c, steps, status };
}
export const genToken = () => (crypto?.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now()}${Math.random().toString(36).slice(2)}`) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const toHtml = text => `<div style="white-space:pre-wrap;font-family:system-ui,-apple-system,sans-serif;line-height:1.6;font-size:14px;color:#111">${esc(text)}</div>`;

// Pick an offer/contract template, merge in this person's details, preview, send.
// Exported — the staff profile reuses it to regenerate contracts post-onboarding.
export function PickTemplateModal({ kind, member, role, ctx, title, cta, onClose, onConfirm }) {
  const [tpls, setTpls] = useState([]);
  const [selId, setSelId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    (async () => {
      const all = await wf.loadTemplates(ctx.locationId, kind).catch(() => []);
      const scoped = kind === 'contract' ? all.filter(t => !t.contractType || t.contractType === member.contractType) : all;
      const list = scoped.length ? scoped : all;
      if (!live) return;
      setTpls(list); setSelId(list[0]?.id || ''); setLoading(false);
    })();
    return () => { live = false; };
  }, []);
  const sel = tpls.find(t => t.id === selId);
  const vars = wf.templateVars(member, role, ctx.locName);
  const merged = sel ? wf.mergeTemplate(sel.body, vars) : '';
  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 620, maxHeight: '88vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: 12.5, color: 'var(--t3)', marginBottom: 14 }}>For {member.name}. Pick a template — their details are merged in automatically. Edit templates in Workforce → Settings.</div>
        {loading ? <div style={{ color: 'var(--t3)', fontSize: 13 }}>Loading templates…</div> : !tpls.length ? <div style={{ color: 'var(--t4)', fontSize: 13 }}>No templates available.</div> : (<>
          <div style={{ marginBottom: 12 }}><label style={labelStyle}>Template</label><select style={inputStyle} value={selId} onChange={e => setSelId(e.target.value)}>{tpls.map(t => <option key={t.id} value={t.id}>{t.name}{t.builtin ? ' (built-in)' : ''}</option>)}</select></div>
          <label style={labelStyle}>Preview</label>
          <div style={{ maxHeight: 320, overflowY: 'auto', padding: 14, borderRadius: 10, background: 'var(--bg3)', border: '1px solid var(--bdr2)', fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{merged}</div>
        </>)}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-acc" disabled={busy || !sel} onClick={async () => { setBusy(true); try { await onConfirm(merged, sel); } finally { setBusy(false); } }}>{busy ? 'Sending…' : cta}</button>
        </div>
      </div>
    </div>
  );
}

export default function WfOnboarding({ ctx, staff = [], roles, sections, settings, week, showToast }) {
  const [cases, setCases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [picking, setPicking] = useState(false);
  const [tab, setTab] = useState('active'); // active | done
  const rolesMap = (roles && roles.map) || {};
  const nameOf = id => (staff.find(s => s.id === id) || {});

  async function reload() {
    setLoading(true);
    try { setCases((await wf.loadOnboarding(ctx.locationId) || []).map(normalizeCase)); }
    catch (e) { showToast(e.message || 'Could not load onboarding', 'error'); }
    finally { setLoading(false); }
  }
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [ctx.locationId]);

  const onboardedIds = useMemo(() => new Set(cases.map(c => c.staffId)), [cases]);
  const candidates = staff.filter(s => !onboardedIds.has(s.id));

  const patchCase = async (c, patch) => {
    const next = { ...c, ...patch };
    const steps = next.steps || [];
    next.status = steps.length && steps.every(s => s.status === 'complete') ? 'complete' : 'inProgress';
    setCases(prev => prev.map(x => x.id === c.id ? next : x));
    // Rethrow on failure — callers show their own toast. Swallowing here let
    // actions report success while the step save had actually failed.
    try { const saved = await wf.saveOnboarding(next, ctx.locationId, ctx.orgId); setCases(prev => prev.map(x => x.id === c.id ? normalizeCase(saved) : x)); return saved; }
    catch (e) { reload(); throw e; }
  };

  const markStep = (c, key, status = 'complete', meta) =>
    patchCase(c, {
      steps: (c.steps || []).map(s => s.key === key ? { ...s, status, completedAt: status === 'complete' ? new Date().toISOString() : null } : s),
      ...(meta ? { meta: { ...(c.meta || {}), ...meta } } : {}),
    });

  const startOnboarding = async (member) => {
    setPicking(false);
    const tmp = { id: `tmp-${Date.now()}`, staffId: member.id, roleKey: member.role, steps: freshSteps(), status: 'inProgress', meta: {} };
    setCases(prev => [tmp, ...prev]);
    try { const saved = await wf.saveOnboarding(tmp, ctx.locationId, ctx.orgId); setCases(prev => prev.map(x => x.id === tmp.id ? saved : x)); }
    catch (e) { showToast(e.message || 'Could not start onboarding', 'error'); setCases(prev => prev.filter(x => x.id !== tmp.id)); }
  };

  if (loading) return <LoadingCard label="Loading onboarding…" />;

  const activeCases = cases.filter(c => !caseDone(c, nameOf(c.staffId)));
  const doneCases = cases.filter(c => caseDone(c, nameOf(c.staffId)));
  const shown = tab === 'done' ? doneCases : activeCases;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>New starters</div>
          <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 2 }}>Take each new hire from offer to first shift — offer letter, Right to Work, signed contract, bank details and till access.</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={reload} title="Refresh (e.g. after a candidate signs)"><Icon name="status" size={14} /> Refresh</button>
          <button className="btn btn-acc" disabled={!candidates.length} onClick={() => setPicking(true)}><Icon name="plus" size={14} /> Start onboarding</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {[['active', `In progress (${activeCases.length})`], ['done', `Completed (${doneCases.length})`]].map(([k, lbl]) => (
          <button key={k} onClick={() => setTab(k)} className={tab === k ? 'btn btn-acc btn-sm' : 'btn btn-ghost btn-sm'}>{lbl}</button>
        ))}
      </div>

      {shown.length === 0 ? (
        tab === 'done'
          ? <EmptyState icon="team" title="No completed onboardings yet" body="Once every step on a starter is ticked (including till access), they move here automatically." />
          : <EmptyState icon="team" title="No one onboarding" body={candidates.length ? 'Start onboarding a new hire to email their offer, collect Right to Work, get the contract signed and capture bank details.' : 'Add a staff member first, then onboard them here.'} cta={candidates.length ? 'Start onboarding' : undefined} onCta={candidates.length ? () => setPicking(true) : undefined} />
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          {shown.map(c => <OnboardingCard key={c.id} c={c} member={nameOf(c.staffId)} rolesMap={rolesMap} ctx={ctx} showToast={showToast} markStep={markStep} patchCase={patchCase} />)}
        </div>
      )}

      {picking && <PickStaffModal candidates={candidates} rolesMap={rolesMap} onClose={() => setPicking(false)} onPick={startOnboarding} />}
    </>
  );
}

function OnboardingCard({ c, member, rolesMap, ctx, showToast, markStep, patchCase }) {
  const meta = c.meta || {};
  const stepStatus = k => (c.steps || []).find(s => s.key === k)?.status || 'pending';
  const posDone = !!member.posUserId || stepStatus('posUser') === 'complete';
  const done = STEPS.filter(s => (s.key === 'posUser' ? posDone : stepStatus(s.key) === 'complete')).length;
  const pct = Math.round((done / STEPS.length) * 100);
  const allDone = done === STEPS.length;

  return (
    <Card style={allDone ? { borderColor: 'var(--grn-b)' } : undefined}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <span style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--inset)', border: '1px solid var(--inset-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800, color: 'var(--t2)' }}>{initials(member.name)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{member.name || 'Unknown'}</div>
          <RoleChip role={member.role} roles={rolesMap} />
        </div>
        {allDone ? <Badge tone="green">Complete</Badge> : <Badge tone="amber">{done}/{STEPS.length} done</Badge>}
      </div>
      <div style={{ height: 6, borderRadius: 999, background: 'var(--inset)', overflow: 'hidden', marginBottom: 14 }}>
        <div style={{ height: '100%', width: `${pct}%`, background: allDone ? 'var(--grn)' : 'var(--acc)', transition: 'width .25s' }} />
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        <StepRow done={stepStatus('offer') === 'complete'} label="Offer letter" hint={
          meta.offerAccepted ? `Accepted ${new Date(meta.offerAccepted.acceptedAt).toLocaleDateString('en-GB')}${meta.offerAccepted.via === 'manual' ? ' (marked by manager)' : ''}`
            : meta.offerSentAt ? `Sent ${new Date(meta.offerSentAt).toLocaleDateString('en-GB')} — awaiting acceptance`
              : (member.email ? 'Email the offer to the candidate' : 'No email on file — add one in Staff')}>
          <OfferAction c={c} member={member} role={rolesMap[member.role]} ctx={ctx} showToast={showToast} markStep={markStep} done={stepStatus('offer') === 'complete'} />
        </StepRow>

        <StepRow done={stepStatus('rtw') === 'complete'} label="Right to Work" hint={meta.rtwPath ? 'Document on file' : 'Upload their RTW document'}>
          <UploadAction type="RTW" c={c} member={member} ctx={ctx} showToast={showToast} markStep={markStep} metaKey="rtwPath" stepKey="rtw" done={stepStatus('rtw') === 'complete'} />
        </StepRow>

        <StepRow done={stepStatus('contract') === 'complete'} label="Contract" hint={meta.signature ? `Signed by ${meta.signature.name} · ${new Date(meta.signature.signedAt).toLocaleDateString('en-GB')}` : (meta.contractHtml || meta.contractPath) ? (meta.contractSentAt ? 'Emailed — awaiting signature (or Sign now)' : 'Ready — Sign now on device, or email it') : 'Generate from a template or upload a PDF'}>
          <ContractAction c={c} member={member} role={rolesMap[member.role]} ctx={ctx} showToast={showToast} patchCase={patchCase} />
        </StepRow>

        <StepRow done={stepStatus('bank') === 'complete'} label="Bank details" hint={meta.bankMasked ? `On file · ${meta.bankMasked}` : 'Capture for payroll (stored masked)'}>
          <BankAction c={c} member={member} ctx={ctx} showToast={showToast} markStep={markStep} done={stepStatus('bank') === 'complete'} />
        </StepRow>

        <StepRow done={posDone} label="POS access" hint={posDone ? 'Till user created' : 'Set them up from Staff → Set as POS user'}>
          {posDone ? <Badge tone="green">Done</Badge> : <span style={{ fontSize: 12, color: 'var(--t4)' }}>In Staff</span>}
        </StepRow>
      </div>
    </Card>
  );
}

function StepRow({ done, label, hint, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', borderRadius: 10, background: done ? 'var(--grn-d)' : 'var(--inset)', border: `1px solid ${done ? 'var(--grn-b)' : 'var(--inset-border)'}` }}>
      <span style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: done ? 'var(--grn)' : 'transparent', border: `1.5px solid ${done ? 'var(--grn)' : 'var(--bdr2)'}`, color: '#06130C' }}>{done && <Icon name="check" size={12} stroke={2.5} />}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 11.5, color: 'var(--t3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{hint}</div>
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

const offerAcceptBlock = link => `<p style="margin-top:20px"><a href="${link}" style="display:inline-block;background:#15C26A;color:#06130C;font-weight:700;padding:12px 20px;border-radius:10px;text-decoration:none">Review &amp; accept your offer</a></p>
<p style="color:#666;font-size:13px">Or paste this link into your browser:<br/>${link}</p>`;

function OfferAction({ c, member, role, ctx, showToast, markStep, done }) {
  const [pick, setPick] = useState(false);
  const [busy, setBusy] = useState(false);
  const meta = c.meta || {};
  if (meta.offerAccepted) return <Badge tone="green">Accepted</Badge>;
  if (!member.email) return <span style={{ fontSize: 11, color: 'var(--t4)' }}>Add email</span>;

  const send = async (merged) => {
    const token = meta.signToken || genToken();
    const offerHtml = toHtml(merged);
    const link = `${window.location.origin}/sign/${token}`;
    await wf.sendEmail(member.email, `Your offer from ${ctx.locName}`, offerHtml + offerAcceptBlock(link), ctx.locationId);
    try {
      await markStep(c, 'offer', 'complete', { offerSentAt: new Date().toISOString(), offerHtml, signToken: token });
    } catch (e) {
      showToast('Offer emailed, but progress could not be saved: ' + (e.message || 'error'), 'error');
      setPick(false);
      return;
    }
    showToast(done ? 'Offer letter re-sent' : 'Offer letter emailed — they can accept from the link inside', 'success');
    setPick(false);
  };

  const markAccepted = async () => {
    setBusy(true);
    try {
      await markStep(c, 'offer', 'complete', { offerAccepted: { acceptedAt: new Date().toISOString(), via: 'manual' } });
      showToast('Offer marked as accepted', 'success');
    } catch (e) { showToast(e.message || 'Could not save', 'error'); }
    finally { setBusy(false); }
  };

  return (<>
    {done ? (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost btn-xs" disabled={busy} onClick={() => setPick(true)}>Resend</button>
        <button className="btn btn-acc btn-xs" disabled={busy} onClick={markAccepted} title="e.g. they accepted by reply or in person">Mark accepted</button>
      </div>
    ) : (
      <button className="btn btn-acc btn-xs" onClick={() => setPick(true)}>Send offer</button>
    )}
    {pick && <PickTemplateModal kind="offer" member={member} role={role} ctx={ctx} title={done ? 'Resend offer letter' : 'Send offer letter'} cta={done ? 'Resend offer' : 'Send offer'} onClose={() => setPick(false)}
      onConfirm={async (m) => { try { await send(m); } catch (e) { showToast('Could not send: ' + (e.message || 'error'), 'error'); } }} />}
  </>);
}

function UploadAction({ type, c, member, ctx, showToast, markStep, metaKey, stepKey, done }) {
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  if (done) return <Badge tone="green">On file</Badge>;
  const pick = async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { showToast('File must be under 10MB', 'error'); return; }
    setBusy(true);
    try {
      const { path } = await wf.uploadWfDocument(file, ctx.locationId, member.id, type);
      await wf.saveDocument({ staffId: member.id, type, fileUrl: path, status: 'valid' }, ctx.locationId, ctx.orgId).catch(() => {});
      await markStep(c, stepKey, 'complete', { [metaKey]: path });
      showToast(`${type === 'RTW' ? 'Right to Work' : type} uploaded`, 'success');
    } catch (err) { showToast('Upload failed: ' + (err.message || 'error'), 'error'); }
    finally { setBusy(false); }
  };
  return (<>
    <input ref={ref} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic" style={{ display: 'none' }} onChange={pick} />
    <button className="btn btn-acc btn-xs" disabled={busy} onClick={() => ref.current?.click()}>{busy ? 'Uploading…' : 'Upload'}</button>
  </>);
}

export const signEmailHtml = (name, locName, link) => `<div style="font-family:system-ui,sans-serif;max-width:560px"><p>Dear ${esc(name)},</p>
<p>Your contract with ${esc(locName)} is ready to sign. Please review and sign it here:</p>
<p><a href="${link}" style="display:inline-block;background:#15C26A;color:#06130C;font-weight:700;padding:12px 20px;border-radius:10px;text-decoration:none">Review &amp; sign your contract</a></p>
<p style="color:#666;font-size:13px">Or paste this link into your browser:<br/>${link}</p>
<p>Warm regards,<br/>${esc(locName)}</p></div>`;

function ContractAction({ c, member, role, ctx, showToast, patchCase }) {
  const meta = c.meta || {};
  const [pick, setPick] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  if (meta.signature) return <Badge tone="green">Signed</Badge>;

  const hasContract = !!(meta.contractHtml || meta.contractPath);
  const token = meta.signToken;
  const signUrl = token ? `${window.location.origin}/sign/${token}` : null;

  // Generate the contract from a template (no email required — sign in-app or email).
  const generate = async (merged) => {
    const t = meta.signToken || genToken();
    await patchCase(c, { meta: { ...meta, contractHtml: toHtml(merged), contractPath: null, signToken: t }, steps: (c.steps || []).map(s => s.key === 'contract' ? { ...s, status: 'sent' } : s) });
    showToast('Contract ready — tap "Sign now" to sign on this device, or email it', 'success');
    setPick(false);
  };

  // Upload a ready-made PDF instead.
  const uploadContract = async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const { path } = await wf.uploadWfDocument(file, ctx.locationId, member.id, 'contract');
      await wf.saveDocument({ staffId: member.id, type: 'other', fileUrl: path, status: 'valid' }, ctx.locationId, ctx.orgId).catch(() => {});
      const t = meta.signToken || genToken();
      await patchCase(c, { meta: { ...meta, contractPath: path, contractHtml: null, signToken: t }, steps: (c.steps || []).map(s => s.key === 'contract' ? { ...s, status: 'sent' } : s) });
      showToast('Contract uploaded — tap "Sign now" or email it', 'success');
    } catch (err) { showToast('Upload failed: ' + (err.message || 'error'), 'error'); }
    finally { setBusy(false); }
  };

  const emailLink = async () => {
    if (!member.email) { showToast('Add an email for this person in Staff first', 'error'); return; }
    setBusy(true);
    try {
      await wf.sendEmail(member.email, `Sign your contract — ${ctx.locName}`, signEmailHtml(member.name, ctx.locName, signUrl), ctx.locationId);
      await patchCase(c, { meta: { ...meta, contractSentAt: new Date().toISOString() } });
      showToast(`Contract emailed to ${member.email}`, 'success');
    } catch (e) { showToast('Email failed: ' + (e.message || 'error'), 'error'); }
    finally { setBusy(false); }
  };
  const copyLink = async () => { try { await navigator.clipboard.writeText(signUrl); showToast('Sign link copied', 'success'); } catch { showToast(signUrl || '', 'info'); } };

  return (<>
    <input ref={ref} type="file" accept=".pdf,.doc,.docx" style={{ display: 'none' }} onChange={uploadContract} />
    {hasContract && token ? (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <button className="btn btn-acc btn-xs" onClick={() => signUrl && window.open(signUrl, '_blank', 'noopener')}>Sign now</button>
        <button className="btn btn-ghost btn-xs" disabled={busy} onClick={emailLink}>{meta.contractSentAt ? 'Re-email' : 'Email'}</button>
        <button className="btn btn-ghost btn-xs" onClick={copyLink}>Copy link</button>
      </div>
    ) : (
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn btn-acc btn-xs" disabled={busy} onClick={() => setPick(true)}>Generate</button>
        <button className="btn btn-ghost btn-xs" disabled={busy} onClick={() => ref.current?.click()} title="Upload a PDF instead">{busy ? '…' : 'Upload'}</button>
      </div>
    )}
    {pick && <PickTemplateModal kind="contract" member={member} role={role} ctx={ctx} title="Generate contract" cta="Generate" onClose={() => setPick(false)}
      onConfirm={async (m) => { try { await generate(m); } catch (e) { showToast('Could not generate: ' + (e.message || 'error'), 'error'); } }} />}
  </>);
}

function BankAction({ c, member, ctx, showToast, markStep, done }) {
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState('');
  const [acct, setAcct] = useState('');
  const [busy, setBusy] = useState(false);
  if (done) return <Badge tone="green">Captured</Badge>;
  const save = async () => {
    setBusy(true);
    try {
      const { masked } = await wf.saveStaffBank(member.id, sort, acct);
      await markStep(c, 'bank', 'complete', { bankMasked: masked, bankCapturedAt: new Date().toISOString() });
      setOpen(false); setSort(''); setAcct('');
      showToast('Bank details captured (stored masked)', 'success');
    } catch (e) { showToast(e.message || 'Could not save', 'error'); }
    finally { setBusy(false); }
  };
  return (<>
    <button className="btn btn-acc btn-xs" onClick={() => setOpen(true)}>Enter</button>
    {open && (
      <div className="modal-back" onClick={e => e.target === e.currentTarget && setOpen(false)}>
        <div className="modal-box" style={{ maxWidth: 400 }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Bank details — {member.name}</div>
          <div style={{ fontSize: 12.5, color: 'var(--t3)', marginBottom: 16 }}>For payroll. Stored on their staff profile (org-fenced) — you can view or change them there any time.</div>
          <div style={{ marginBottom: 12 }}><label style={labelStyle}>Sort code</label><input style={inputStyle} value={sort} onChange={e => setSort(e.target.value)} placeholder="00-00-00" inputMode="numeric" /></div>
          <div style={{ marginBottom: 18 }}><label style={labelStyle}>Account number</label><input style={inputStyle} value={acct} onChange={e => setAcct(e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="12345678" inputMode="numeric" /></div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-acc" disabled={busy || acct.replace(/\D/g, '').length < 4} onClick={save}>{busy ? 'Saving…' : 'Save (masked)'}</button>
          </div>
        </div>
      </div>
    )}
  </>);
}

function FirstShiftActionRemoved() { return null; /* first-shift step removed from onboarding */ }
function _UnusedFirstShift({ c, showToast, patchCase, done }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  if (done) return <Badge tone="green">Booked</Badge>;
  const save = async () => {
    if (!date) return;
    await patchCase(c, { firstShiftDate: date, meta: { ...(c.meta || {}), firstShiftDate: date }, steps: (c.steps || []) });
    setOpen(false);
    showToast('First shift date set', 'success');
  };
  return (<>
    <button className="btn btn-acc btn-xs" onClick={() => setOpen(true)}>Set date</button>
    {open && (
      <div className="modal-back" onClick={e => e.target === e.currentTarget && setOpen(false)}>
        <div className="modal-box" style={{ maxWidth: 360 }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>First shift date</div>
          <input type="date" style={inputStyle} value={date} onChange={e => setDate(e.target.value)} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-acc" disabled={!date} onClick={save}>Save</button>
          </div>
        </div>
      </div>
    )}
  </>);
}

function PickStaffModal({ candidates, rolesMap, onClose, onPick }) {
  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 440 }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Start onboarding</div>
        <div style={{ fontSize: 12.5, color: 'var(--t3)', marginBottom: 16 }}>Pick the new starter to begin their onboarding checklist.</div>
        <div style={{ display: 'grid', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
          {candidates.map(s => (
            <button key={s.id} onClick={() => onPick(s)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: 'var(--inset)', border: '1px solid var(--inset-border)', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
              <span style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--bg3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--t2)' }}>{initials(s.name)}</span>
              <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>{s.name}</span>
              <RoleChip role={s.role} roles={rolesMap} />
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}><button className="btn btn-ghost" onClick={onClose}>Cancel</button></div>
      </div>
    </div>
  );
}
