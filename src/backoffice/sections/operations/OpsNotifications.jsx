// OpsNotifications — admin editor for the alert/escalation rules the ops-escalate
// engine reads (Back Office → Operations → Alert rules). One rule per event type:
// minimum severity, channels (in-app always + SMS/email), recipients (roles / people /
// direct contacts) and how fast it escalates. In-app alerts always fire on creation;
// these rules add the out-of-band SMS/email + the escalation ladder.

import { useEffect, useState, useCallback } from 'react';
import { useStore } from '../../../store';
import { getActiveLocationSync, getLocationId } from '../../../lib/supabase';
import { fetchNotificationRules, upsertNotificationRule, deleteNotificationRule, fetchOpsRecipients } from '../../../lib/ops/data';
import { reportSave } from '../../../lib/saveHealth';
import { Icon } from '../../../components/ServOSIcons';

const EVENT_TYPES = [
  ['temp_breach', 'Temperature breach', 'A unit logged a reading out of its safe range'],
  ['missed_check', 'Missed check', 'A scheduled temperature round was not completed in time'],
  ['overdue_task', 'Overdue task', 'A checklist task passed its due time'],
  ['maintenance', 'Maintenance raised', 'A maintenance request was created'],
  ['corrective', 'Corrective action', 'A corrective action was recorded against a breach'],
];
const SEVERITIES = [['minor', 'Minor'], ['major', 'Major'], ['critical', 'Critical']];
const ROLE_PRESETS = ['MOD', 'manager', 'admin', 'Kitchen', 'Front of house', 'Cleaner'];
const field = { background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '7px 10px', fontSize: 13, outline: 'none', fontFamily: 'inherit' };
const lbl = { fontSize: 10.5, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 7, fontFamily: 'var(--font-mono, ui-monospace), monospace' };

const blankRule = (eventType) => ({ id: null, eventType, severityMin: 'major', channels: ['inapp'], recipients: [], escalateAfterMin: 15, active: true });
const recipKey = (r) => r.role ? `role:${r.role}` : r.userId ? `user:${r.userId}` : r.email ? `email:${r.email}` : r.phone ? `phone:${r.phone}` : JSON.stringify(r);
const recipLabel = (r) => r.role ? r.role : r.name ? r.name : r.email || r.phone || '—';

export default function OpsNotifications() {
  const showToast = useStore(s => s.showToast);
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [staff, setStaff] = useState([]);
  const [drafts, setDrafts] = useState({});   // eventType → rule draft
  const [loading, setLoading] = useState(true);
  const [savingType, setSavingType] = useState(null);

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const [{ data: rules }, { data: s }] = await Promise.all([fetchNotificationRules(loc), fetchOpsRecipients(loc)]);
    const byType = {}; (rules || []).forEach(r => { byType[r.eventType] = r; });
    const next = {}; EVENT_TYPES.forEach(([t]) => { next[t] = byType[t] || blankRule(t); });
    setDrafts(next); setStaff(s || []); setLoading(false);
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const patch = (type, k, v) => setDrafts(d => ({ ...d, [type]: { ...d[type], [k]: v } }));
  const toggleChannel = (type, ch) => setDrafts(d => {
    const cur = new Set(d[type].channels); cur.has(ch) ? cur.delete(ch) : cur.add(ch); cur.add('inapp');
    return { ...d, [type]: { ...d[type], channels: [...cur] } };
  });
  const addRecipient = (type, r) => setDrafts(d => {
    const cur = d[type].recipients || [];
    if (cur.some(x => recipKey(x) === recipKey(r))) return d;
    return { ...d, [type]: { ...d[type], recipients: [...cur, r] } };
  });
  const removeRecipient = (type, key) => setDrafts(d => ({ ...d, [type]: { ...d[type], recipients: (d[type].recipients || []).filter(x => recipKey(x) !== key) } }));

  const save = async (type) => {
    setSavingType(type);
    const { data, error } = await upsertNotificationRule(drafts[type], locId);
    setSavingType(null);
    reportSave('alert rule', error);
    if (error) { showToast?.(error.message || 'Save failed', 'error'); return; }
    if (data) setDrafts(d => ({ ...d, [type]: { ...d[type], id: data.id || d[type].id } }));
    showToast?.('Alert rule saved', 'success');
  };
  const turnOff = async (type) => {
    const r = drafts[type];
    if (r.id) {
      const { error } = await deleteNotificationRule(r.id, locId);
      reportSave('alert rule delete', error);
      // Only blank the card once the row is really gone — otherwise the screen says
      // "in-app only" while the rule keeps sending SMS/email.
      if (error) { showToast?.('Rule NOT removed — it is still sending', 'error'); return; }
      showToast?.('Rule removed — in-app only', 'success');
    }
    setDrafts(d => ({ ...d, [type]: blankRule(type) }));
  };

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 4px', color: 'var(--t1)' }}>Alert rules</h1>
      <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 18, maxWidth: 640 }}>
        Who gets notified when something needs attention, and how fast it escalates. In-app alerts always appear in Compliance; these rules add SMS &amp; email and the escalation ladder for unacknowledged alerts.
      </div>

      {loading ? <div style={{ color: 'var(--t3)' }}>Loading…</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 860 }}>
          {EVENT_TYPES.map(([type, title, desc]) => (
            <RuleCard
              key={type} type={type} title={title} desc={desc} rule={drafts[type]} staff={staff}
              saving={savingType === type}
              onPatch={patch} onToggleChannel={toggleChannel} onAddRecipient={addRecipient} onRemoveRecipient={removeRecipient}
              onSave={save} onTurnOff={turnOff}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RuleCard({ type, title, desc, rule, staff, saving, onPatch, onToggleChannel, onAddRecipient, onRemoveRecipient, onSave, onTurnOff }) {
  const [contact, setContact] = useState('');
  const configured = !!rule.id;
  const sms = rule.channels.includes('sms'), email = rule.channels.includes('email');
  // roles available = presets ∪ roles actually present on staff
  const roles = [...new Set([...ROLE_PRESETS, ...staff.map(s => s.role).filter(Boolean)])];
  const activeRoleSet = new Set(rule.recipients.filter(r => r.role).map(r => r.role));

  const addContact = () => {
    const v = contact.trim(); if (!v) return;
    onAddRecipient(type, v.includes('@') ? { email: v } : { phone: v });
    setContact('');
  };
  const addPerson = (id) => {
    const s = staff.find(x => x.id === id); if (!s) return;
    onAddRecipient(type, { userId: s.id, name: s.name, phone: s.phone || null, email: s.email || null });
  };

  return (
    <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 18, opacity: rule.active ? 1 : 0.7 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>{title}</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: configured ? 'var(--grn)' : 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.06em', fontFamily: 'var(--font-mono, ui-monospace), monospace' }}>{configured ? (rule.active ? 'active' : 'paused') : 'in-app only'}</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 3 }}>{desc}</div>
        </div>
        {/* active toggle */}
        <button onClick={() => onPatch(type, 'active', !rule.active)} title={rule.active ? 'Active' : 'Paused'} style={{ width: 38, height: 21, borderRadius: 11, border: 0, cursor: 'pointer', padding: 0, position: 'relative', flexShrink: 0, background: rule.active ? 'var(--grn)' : 'var(--bg4, var(--bg3))', transition: 'background .15s' }}>
          <span style={{ position: 'absolute', top: 2, left: rule.active ? 19 : 2, width: 17, height: 17, borderRadius: '50%', background: '#fff', transition: 'left .15s', boxShadow: '0 1px 2px rgba(0,0,0,.3)' }} />
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 18, marginBottom: 16 }}>
        {/* severity */}
        <div>
          <div style={lbl}>Trigger at severity ≥</div>
          <select style={{ ...field, width: '100%' }} value={rule.severityMin} onChange={e => onPatch(type, 'severityMin', e.target.value)}>
            {SEVERITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        {/* channels */}
        <div>
          <div style={lbl}>Channels</div>
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            <Chan label="In-app" on locked />
            <Chan label="SMS" on={sms} onClick={() => onToggleChannel(type, 'sms')} />
            <Chan label="Email" on={email} onClick={() => onToggleChannel(type, 'email')} />
          </div>
        </div>
        {/* escalation */}
        <div>
          <div style={lbl}>Escalate every</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="number" min="1" style={{ ...field, width: 70 }} value={rule.escalateAfterMin} onChange={e => onPatch(type, 'escalateAfterMin', e.target.value)} />
            <span style={{ fontSize: 13, color: 'var(--t3)' }}>minutes if unacknowledged</span>
          </div>
        </div>
      </div>

      {/* recipients */}
      <div>
        <div style={lbl}>Notify</div>
        {/* role chips */}
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 10 }}>
          {roles.map(role => {
            const on = activeRoleSet.has(role);
            return (
              <button key={role} onClick={() => on ? onRemoveRecipient(type, `role:${role}`) : onAddRecipient(type, { role })} style={{
                padding: '6px 12px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
                border: `1px solid ${on ? 'var(--acc)' : 'var(--bdr)'}`, color: on ? 'var(--acc)' : 'var(--t2)', background: on ? 'var(--acc-d, rgba(21,194,106,.12))' : 'var(--bg2)',
              }}>{role}</button>
            );
          })}
        </div>
        {/* people + direct contact pickers */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          {staff.length > 0 && (
            <select style={{ ...field }} value="" onChange={e => { addPerson(e.target.value); e.target.value = ''; }}>
              <option value="">+ Add person…</option>
              {staff.map(s => <option key={s.id} value={s.id}>{s.name}{s.role ? ` · ${s.role}` : ''}</option>)}
            </select>
          )}
          <input style={{ ...field, minWidth: 180 }} placeholder="+ Add email or phone" value={contact}
            onChange={e => setContact(e.target.value)} onKeyDown={e => e.key === 'Enter' && addContact()} />
          <button onClick={addContact} style={{ ...field, cursor: 'pointer', fontWeight: 700, color: 'var(--t1)' }}>Add</button>
        </div>
        {/* selected non-role recipients as chips */}
        {rule.recipients.filter(r => !r.role).length > 0 && (
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            {rule.recipients.filter(r => !r.role).map(r => (
              <span key={recipKey(r)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 8px 5px 11px', borderRadius: 999, background: 'var(--bg2)', border: '1px solid var(--bdr)', fontSize: 12.5, color: 'var(--t1)' }}>
                {recipLabel(r)}
                {r.userId && !(r.phone || r.email) && <span title="No phone/email on file — won't receive SMS/email" style={{ color: 'var(--orn)' }}><Icon name="warn" size={12} /></span>}
                <button onClick={() => onRemoveRecipient(type, recipKey(r))} aria-label="Remove" style={{ background: 'none', border: 0, color: 'var(--t3)', cursor: 'pointer', display: 'grid', placeItems: 'center', padding: 0 }}><Icon name="close" size={13} /></button>
              </span>
            ))}
          </div>
        )}
        {(sms || email) && rule.recipients.length === 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--orn)', marginTop: 8 }}>Pick at least one recipient, or SMS/email won't reach anyone.</div>
        )}
      </div>

      {/* actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, borderTop: '1px solid var(--bg2)', paddingTop: 14 }}>
        {configured && <button onClick={() => onTurnOff(type)} style={{ padding: '8px 14px', borderRadius: 8, background: 'transparent', border: '1px solid var(--bdr2)', color: 'var(--t3)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5 }}>Remove rule</button>}
        <button onClick={() => onSave(type)} disabled={saving} className="btn btn-acc" style={{ marginLeft: 'auto', padding: '9px 20px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 0, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save rule'}</button>
      </div>
    </div>
  );
}

function Chan({ label, on, onClick, locked }) {
  return (
    <button onClick={locked ? undefined : onClick} disabled={locked} style={{
      padding: '6px 12px', borderRadius: 8, cursor: locked ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
      border: `1px solid ${on ? 'var(--acc)' : 'var(--bdr)'}`, color: on ? (locked ? 'var(--t2)' : 'var(--acc)') : 'var(--t3)',
      background: on ? (locked ? 'var(--bg2)' : 'var(--acc-d, rgba(21,194,106,.12))') : 'var(--bg2)', opacity: locked ? 0.85 : 1,
    }}>{label}{locked ? ' ·' : ''}</button>
  );
}
