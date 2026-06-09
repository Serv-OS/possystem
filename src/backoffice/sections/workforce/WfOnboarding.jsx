// src/backoffice/sections/workforce/WfOnboarding.jsx
//
// Workforce › Onboarding — a real new-starter pipeline, per person:
//   1. Offer letter  — email the offer to the candidate (send-receipt)
//   2. Right to Work — upload the RTW document (private storage + compliance row)
//   3. Contract      — upload the contract + send a sign link; candidate signs
//                      via the public /sign/<token> page (lightweight e-sign)
//   4. Bank details  — captured for payroll, stored MASKED (sort code + last 4)
//   5. POS access    — set them up as a till user (auto-detected from posUserId)
//   6. First shift   — book their first shift date
// Each step writes through to wf_onboarding (steps + meta jsonb).

import { useState, useEffect, useRef, useMemo } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { Card, EmptyState, Badge, RoleChip, initials, inputStyle, labelStyle, LoadingCard } from '../../../staff/wfUi';
import * as wf from '../../../staff/wfData';

const STEPS = [
  { key: 'offer', label: 'Offer letter' },
  { key: 'rtw', label: 'Right to Work' },
  { key: 'contract', label: 'Contract' },
  { key: 'bank', label: 'Bank details' },
  { key: 'posUser', label: 'POS access' },
  { key: 'firstShift', label: 'First shift' },
];
const freshSteps = () => STEPS.map(s => ({ key: s.key, status: 'pending', completedAt: null }));
const genToken = () => (crypto?.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now()}${Math.random().toString(36).slice(2)}`) + Math.random().toString(36).slice(2, 8);

export default function WfOnboarding({ ctx, staff = [], roles, sections, settings, week, showToast }) {
  const [cases, setCases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [picking, setPicking] = useState(false);
  const rolesMap = (roles && roles.map) || {};
  const nameOf = id => (staff.find(s => s.id === id) || {});

  async function reload() {
    setLoading(true);
    try { setCases(await wf.loadOnboarding(ctx.locationId) || []); }
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
    try { const saved = await wf.saveOnboarding(next, ctx.locationId, ctx.orgId); setCases(prev => prev.map(x => x.id === c.id ? saved : x)); return saved; }
    catch (e) { showToast(e.message || 'Save failed', 'error'); reload(); }
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

      {cases.length === 0 ? (
        <EmptyState icon="team" title="No one onboarding" body={candidates.length ? 'Start onboarding a new hire to email their offer, collect Right to Work, get the contract signed and capture bank details.' : 'Add a staff member first, then onboard them here.'} cta={candidates.length ? 'Start onboarding' : undefined} onCta={candidates.length ? () => setPicking(true) : undefined} />
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          {cases.map(c => <OnboardingCard key={c.id} c={c} member={nameOf(c.staffId)} rolesMap={rolesMap} ctx={ctx} showToast={showToast} markStep={markStep} patchCase={patchCase} />)}
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

  return (
    <Card style={c.status === 'complete' ? { borderColor: 'var(--grn-b)' } : undefined}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <span style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--inset)', border: '1px solid var(--inset-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800, color: 'var(--t2)' }}>{initials(member.name)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{member.name || 'Unknown'}</div>
          <RoleChip role={member.role} roles={rolesMap} />
        </div>
        {c.status === 'complete' ? <Badge tone="green">Complete</Badge> : <Badge tone="amber">{done}/{STEPS.length} done</Badge>}
      </div>
      <div style={{ height: 6, borderRadius: 999, background: 'var(--inset)', overflow: 'hidden', marginBottom: 14 }}>
        <div style={{ height: '100%', width: `${pct}%`, background: c.status === 'complete' ? 'var(--grn)' : 'var(--acc)', transition: 'width .25s' }} />
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        <StepRow done={stepStatus('offer') === 'complete'} label="Offer letter" hint={meta.offerSentAt ? `Sent ${new Date(meta.offerSentAt).toLocaleDateString('en-GB')}` : (member.email ? 'Email the offer to the candidate' : 'No email on file — add one in Staff')}>
          <OfferAction c={c} member={member} role={rolesMap[member.role]} ctx={ctx} showToast={showToast} markStep={markStep} done={stepStatus('offer') === 'complete'} />
        </StepRow>

        <StepRow done={stepStatus('rtw') === 'complete'} label="Right to Work" hint={meta.rtwPath ? 'Document on file' : 'Upload their RTW document'}>
          <UploadAction type="RTW" c={c} member={member} ctx={ctx} showToast={showToast} markStep={markStep} metaKey="rtwPath" stepKey="rtw" done={stepStatus('rtw') === 'complete'} />
        </StepRow>

        <StepRow done={stepStatus('contract') === 'complete'} label="Contract" hint={meta.signature ? `Signed by ${meta.signature.name} · ${new Date(meta.signature.signedAt).toLocaleDateString('en-GB')}` : meta.contractSentAt ? 'Sent — awaiting signature' : meta.contractPath ? 'Uploaded — send for signing' : 'Upload the contract'}>
          <ContractAction c={c} member={member} ctx={ctx} showToast={showToast} patchCase={patchCase} />
        </StepRow>

        <StepRow done={stepStatus('bank') === 'complete'} label="Bank details" hint={meta.bankMasked ? `On file · ${meta.bankMasked}` : 'Capture for payroll (stored masked)'}>
          <BankAction c={c} member={member} ctx={ctx} showToast={showToast} markStep={markStep} done={stepStatus('bank') === 'complete'} />
        </StepRow>

        <StepRow done={posDone} label="POS access" hint={posDone ? 'Till user created' : 'Set them up from Staff → Set as POS user'}>
          {posDone ? <Badge tone="green">Done</Badge> : <span style={{ fontSize: 12, color: 'var(--t4)' }}>In Staff</span>}
        </StepRow>

        <StepRow done={stepStatus('firstShift') === 'complete'} label="First shift" hint={meta.firstShiftDate ? new Date(meta.firstShiftDate + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : 'Book their first shift date'}>
          <FirstShiftAction c={c} showToast={showToast} patchCase={patchCase} done={stepStatus('firstShift') === 'complete'} />
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

function OfferAction({ c, member, role, ctx, showToast, markStep, done }) {
  const [busy, setBusy] = useState(false);
  if (done) return <Badge tone="green">Sent</Badge>;
  const send = async () => {
    if (!member.email) { showToast('Add an email for this person in Staff first', 'error'); return; }
    setBusy(true);
    try {
      const roleLbl = role?.lbl || 'team member';
      const rate = member.rateOverride != null ? `£${Number(member.rateOverride).toFixed(2)}/h` : (role?.rate != null ? `£${Number(role.rate).toFixed(2)}/h` : 'to be confirmed');
      const html = `<div style="font-family:system-ui,sans-serif;max-width:560px"><p>Dear ${member.name},</p>
<p>We're delighted to offer you the position of <strong>${roleLbl}</strong> at ${ctx.locName}.</p>
<ul><li>Rate of pay: ${rate}</li>${member.startDate ? `<li>Proposed start date: ${new Date(member.startDate + 'T00:00:00').toLocaleDateString('en-GB')}</li>` : ''}</ul>
<p>We're really pleased to have you joining the team. Please reply to accept and we'll send your contract to sign and get you set up.</p>
<p>Warm regards,<br/>${ctx.locName}</p></div>`;
      await wf.sendEmail(member.email, `Your offer from ${ctx.locName}`, html, ctx.locationId);
      await markStep(c, 'offer', 'complete', { offerSentAt: new Date().toISOString() });
      showToast('Offer letter emailed', 'success');
    } catch (e) { showToast('Could not send offer: ' + (e.message || 'error'), 'error'); }
    finally { setBusy(false); }
  };
  return <button className="btn btn-acc btn-xs" disabled={busy || !member.email} onClick={send}>{busy ? 'Sending…' : 'Send offer'}</button>;
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

function ContractAction({ c, member, ctx, showToast, patchCase }) {
  const meta = c.meta || {};
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  if (meta.signature) return <Badge tone="green">Signed</Badge>;

  const uploadContract = async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const { path } = await wf.uploadWfDocument(file, ctx.locationId, member.id, 'contract');
      await wf.saveDocument({ staffId: member.id, type: 'other', fileUrl: path, status: 'valid' }, ctx.locationId, ctx.orgId).catch(() => {});
      await patchCase(c, { meta: { ...meta, contractPath: path } });
      showToast('Contract uploaded — now send it for signing', 'success');
    } catch (err) { showToast('Upload failed: ' + (err.message || 'error'), 'error'); }
    finally { setBusy(false); }
  };

  const sendForSigning = async () => {
    if (!member.email) { showToast('Add an email for this person in Staff first', 'error'); return; }
    setBusy(true);
    try {
      const token = meta.signToken || genToken();
      const link = `${window.location.origin}/sign/${token}`;
      const html = `<div style="font-family:system-ui,sans-serif;max-width:560px"><p>Dear ${member.name},</p>
<p>Your contract with ${ctx.locName} is ready to sign. Please review and sign it here:</p>
<p><a href="${link}" style="display:inline-block;background:#15C26A;color:#06130C;font-weight:700;padding:12px 20px;border-radius:10px;text-decoration:none">Review &amp; sign your contract</a></p>
<p style="color:#666;font-size:13px">Or paste this link into your browser:<br/>${link}</p>
<p>Warm regards,<br/>${ctx.locName}</p></div>`;
      await wf.sendEmail(member.email, `Sign your contract — ${ctx.locName}`, html, ctx.locationId);
      await patchCase(c, { meta: { ...meta, signToken: token, contractSentAt: new Date().toISOString() }, steps: (c.steps || []).map(s => s.key === 'contract' ? { ...s, status: 'sent' } : s) });
      showToast('Contract sent for signing', 'success');
    } catch (e) { showToast('Could not send: ' + (e.message || 'error'), 'error'); }
    finally { setBusy(false); }
  };

  return (<>
    <input ref={ref} type="file" accept=".pdf,.doc,.docx" style={{ display: 'none' }} onChange={uploadContract} />
    {!meta.contractPath
      ? <button className="btn btn-acc btn-xs" disabled={busy} onClick={() => ref.current?.click()}>{busy ? 'Uploading…' : 'Upload'}</button>
      : <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-ghost btn-xs" disabled={busy} onClick={() => ref.current?.click()} title="Replace contract">↻</button>
          <button className="btn btn-acc btn-xs" disabled={busy || !member.email} onClick={sendForSigning}>{busy ? '…' : (meta.contractSentAt ? 'Resend' : 'Send to sign')}</button>
        </div>}
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
          <div style={{ fontSize: 12.5, color: 'var(--t3)', marginBottom: 16 }}>For payroll. Only the sort code + last 4 digits are stored in Serv OS — key the full number into your payroll/BACS system.</div>
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

function FirstShiftAction({ c, showToast, patchCase, done }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  if (done) return <Badge tone="green">Booked</Badge>;
  const save = async () => {
    if (!date) return;
    await patchCase(c, { firstShiftDate: date, meta: { ...(c.meta || {}), firstShiftDate: date }, steps: (c.steps || []).map(s => s.key === 'firstShift' ? { ...s, status: 'complete', completedAt: new Date().toISOString() } : s) });
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
