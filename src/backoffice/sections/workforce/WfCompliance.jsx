// src/backoffice/sections/workforce/WfCompliance.jsx
//
// Workforce › Compliance — the document vault. One row per required/held
// document per staff member, with a traffic-light status derived purely from
// the expiry date. Flags staff who are missing legally-required docs (Right to
// Work always; SIA licence when their role requires it).

import { useState, useEffect, useMemo, useRef } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { Card, EmptyState, Badge, RoleChip, th, td, inputStyle, labelStyle, initials, LoadingCard } from '../../../staff/wfUi';
import * as wf from '../../../staff/wfData';

/** Open a stored document via a short-lived signed URL (private bucket). */
function ViewDocLink({ path }) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try { const url = await wf.signedDocUrl(path, 120); if (url) window.open(url, '_blank', 'noopener'); }
    finally { setBusy(false); }
  };
  return <button className="btn btn-ghost btn-xs" disabled={busy} onClick={open}><Icon name="tag" size={13} /> {busy ? '…' : 'View'}</button>;
}

const DOC_TYPES = ['RTW', 'foodHygieneL2', 'allergenTraining', 'SIA', 'firstAid', 'other'];
const DOC_LABEL = {
  RTW: 'Right to Work',
  foodHygieneL2: 'Food Hygiene L2',
  allergenTraining: 'Allergen Training',
  SIA: 'SIA Licence',
  firstAid: 'First Aid',
  other: 'Other',
};
const EXPIRING_DAYS = 30;

const todayIso = () => new Date().toISOString().slice(0, 10);
const fmtDate = iso => iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const daysBetween = (a, b) => Math.round((new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 86400000);

/** Traffic-light status from an expiry date. No expiry held → missing. */
function docStatus(doc) {
  if (!doc) return 'missing';
  // A document that's been uploaded (has a file) but carries no expiry — e.g. a
  // Right to Work share code or a permanent certificate — is held & valid, not "missing".
  if (!doc.expiry) return doc.fileUrl ? 'valid' : 'missing';
  const d = daysBetween(doc.expiry, todayIso());
  if (d < 0) return 'expired';
  if (d <= EXPIRING_DAYS) return 'expiring';
  return 'valid';
}
const STATUS_TONE = { valid: 'green', expiring: 'amber', expired: 'red', missing: 'grey' };
const STATUS_LBL = { valid: 'Valid', expiring: 'Expiring', expired: 'Expired', missing: 'Missing' };
const NEEDS_ATTENTION = new Set(['expiring', 'expired', 'missing']);

/** Required docs for a staff member: RTW always, SIA when role.requiresSIA. */
function requiredTypes(member, rolesMap) {
  const req = ['RTW'];
  const role = rolesMap && rolesMap[member.role];
  if (role && role.requiresSIA) req.push('SIA');
  return req;
}

export default function WfCompliance({ ctx, staff, roles, sections, settings, week, showToast }) {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const rolesMap = (roles && roles.map) || {};

  useEffect(() => {
    let live = true;
    setLoading(true);
    wf.loadDocuments(ctx.locationId)
      .then(rows => { if (live) setDocs(rows || []); })
      .catch(() => { if (live) setDocs([]); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [ctx.locationId]);

  // Group held docs by staff, fold in the required-but-missing placeholders.
  const byStaff = useMemo(() => {
    const map = new Map();
    (docs || []).forEach(d => {
      if (!map.has(d.staffId)) map.set(d.staffId, []);
      map.get(d.staffId).push(d);
    });
    return map;
  }, [docs]);

  const rowsFor = member => {
    const held = byStaff.get(member.id) || [];
    const req = requiredTypes(member, rolesMap);
    const missing = req
      .filter(t => !held.some(d => d.type === t))
      .map(t => ({ id: `req-${member.id}-${t}`, staffId: member.id, type: t, expiry: null, issuedOn: null, fileUrl: null, _placeholder: true }));
    return [...held, ...missing].sort((a, b) => a.type.localeCompare(b.type));
  };

  const attentionCount = useMemo(() => {
    let n = 0;
    (staff || []).forEach(m => rowsFor(m).forEach(d => { if (NEEDS_ATTENTION.has(docStatus(d))) n++; }));
    return n;
  }, [staff, byStaff, rolesMap]);

  async function handleSave(form) {
    const tmp = { id: `tmp-${Date.now()}`, staffId: form.staffId, type: form.type, issuedOn: form.issuedOn || null, expiry: form.expiry || null, fileUrl: form.fileUrl || null };
    tmp.status = docStatus(tmp);
    setDocs(prev => [...prev, tmp]);
    setAdding(false);
    try {
      const saved = await wf.saveDocument(tmp, ctx.locationId, ctx.orgId);
      setDocs(prev => prev.map(d => (d.id === tmp.id ? saved : d)));
      showToast('Document added', 'success');
    } catch (err) {
      showToast((err && err.message) || 'Could not save document', 'error');
      const fresh = await wf.loadDocuments(ctx.locationId).catch(() => []);
      setDocs(fresh || []);
    }
  }

  if (loading) return <LoadingCard label="Loading documents…" />;

  if (!staff || staff.length === 0) {
    return (
      <EmptyState
        icon="team"
        title="No staff to track yet"
        body="Add team members in the Staff section first. Compliance documents — Right to Work, SIA, food hygiene — appear here per person once you have a team."
      />
    );
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Compliance vault</div>
          <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 2 }}>Right to Work, licences and training records — one row per document.</div>
        </div>
        <button className="btn btn-acc" onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} /> Add document
        </button>
      </div>

      <AttentionBanner count={attentionCount} />

      <div style={{ display: 'grid', gap: 14 }}>
        {(staff || []).map(member => {
          const rows = rowsFor(member);
          const role = rolesMap[member.role];
          const flagged = rows.some(d => d._placeholder && requiredTypes(member, rolesMap).includes(d.type));
          return (
            <Card key={member.id} style={flagged ? { borderColor: 'var(--red-b)' } : undefined}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <span style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--inset)', border: '1px solid var(--inset-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, fontWeight: 700, color: 'var(--t2)' }}>{initials(member.name)}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{member.name}</div>
                  <RoleChip role={member.role} roles={rolesMap} />
                </div>
                {flagged && (
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 700, color: 'var(--red)' }}>
                    <Icon name="warn" size={14} /> Missing required docs
                  </span>
                )}
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Document</th>
                    <th style={th}>Status</th>
                    <th style={th}>Issued</th>
                    <th style={th}>Expiry</th>
                    <th style={th}>File</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(d => {
                    const st = docStatus(d);
                    const req = requiredTypes(member, rolesMap).includes(d.type);
                    return (
                      <tr key={d.id}>
                        <td style={td}>
                          <span style={{ fontWeight: 600 }}>{DOC_LABEL[d.type] || d.type}</span>
                          {req && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: 'var(--t4)', fontFamily: 'var(--font-mono)' }}>REQ</span>}
                        </td>
                        <td style={td}><Badge tone={STATUS_TONE[st]}>{STATUS_LBL[st]}</Badge></td>
                        <td style={td} className="mono" >{fmtDate(d.issuedOn)}</td>
                        <td style={td} className="mono">{fmtDate(d.expiry)}</td>
                        <td style={td}>
                          {d.fileUrl ? <ViewDocLink path={d.fileUrl} /> : <span style={{ color: 'var(--t4)' }}>—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          );
        })}
      </div>

      {adding && (
        <AddDocModal
          staff={staff}
          ctx={ctx}
          onClose={() => setAdding(false)}
          onSave={handleSave}
        />
      )}
    </>
  );
}

function AttentionBanner({ count }) {
  const ok = count === 0;
  return (
    <Card style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 12, borderColor: ok ? 'var(--grn-b)' : 'var(--amber)', background: ok ? 'var(--grn-d)' : 'rgba(245,166,35,.10)' }}>
      <span style={{ width: 34, height: 34, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: ok ? 'var(--grn-d)' : 'rgba(245,166,35,.18)', color: ok ? 'var(--grn)' : 'var(--amber)' }}>
        <Icon name={ok ? 'check' : 'warn'} size={18} />
      </span>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: ok ? 'var(--grn)' : 'var(--amber)' }}>
          {ok ? 'All documents in order' : `${count} document${count === 1 ? '' : 's'} need attention`}
        </div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>
          {ok ? 'No missing, expired or expiring documents across the team.' : `Expiring within ${EXPIRING_DAYS} days, already expired, or required but not yet held.`}
        </div>
      </div>
    </Card>
  );
}

function AddDocModal({ staff, ctx, onClose, onSave }) {
  const [form, setForm] = useState({ staffId: (staff[0] && staff[0].id) || '', type: 'RTW', issuedOn: '', expiry: '', fileUrl: '', fileName: '' });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const valid = form.staffId && form.type;
  const [uploading, setUploading] = useState(false);
  const [upErr, setUpErr] = useState('');
  const fileRef = useRef(null);
  const onPickFile = async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    setUpErr('');
    if (file.size > 10 * 1024 * 1024) { setUpErr('File must be under 10MB'); return; }
    setUploading(true);
    try {
      const { path, name } = await wf.uploadWfDocument(file, ctx.locationId, form.staffId, form.type);
      setForm(f => ({ ...f, fileUrl: path, fileName: name }));
    } catch (err) { setUpErr((err && err.message) || 'Upload failed'); }
    finally { setUploading(false); }
  };

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 480 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Add document</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><Icon name="close" size={14} /></button>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Staff member</label>
          <select style={inputStyle} value={form.staffId} onChange={e => set('staffId', e.target.value)}>
            {staff.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Document type</label>
          <select style={inputStyle} value={form.type} onChange={e => set('type', e.target.value)}>
            {DOC_TYPES.map(t => <option key={t} value={t}>{DOC_LABEL[t]}</option>)}
          </select>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={labelStyle}>Issued</label>
            <input type="date" style={inputStyle} value={form.issuedOn} onChange={e => set('issuedOn', e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Expiry</label>
            <input type="date" style={inputStyle} value={form.expiry} onChange={e => set('expiry', e.target.value)} />
          </div>
        </div>

        <div style={{ marginBottom: 18 }}>
          <label style={labelStyle}>Document file</label>
          <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.doc,.docx" style={{ display: 'none' }} onChange={onPickFile} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-ghost" disabled={uploading} onClick={() => fileRef.current?.click()}>
              <Icon name={uploading ? 'clock' : 'plus'} size={14} /> {uploading ? 'Uploading…' : (form.fileUrl ? 'Replace file' : 'Upload file')}
            </button>
            {form.fileName && <span style={{ fontSize: 12.5, color: 'var(--grn)', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="check" size={13} /> {form.fileName}</span>}
          </div>
          {upErr && <div style={{ fontSize: 11.5, color: 'var(--red)', marginTop: 6 }}>{upErr}</div>}
          <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 6 }}>PDF or image, under 10MB. Stored privately — opened via a short-lived signed link.</div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-acc" disabled={!valid} onClick={() => onSave(form)}>
            <Icon name="check" size={14} /> Save document
          </button>
        </div>
      </div>
    </div>
  );
}
