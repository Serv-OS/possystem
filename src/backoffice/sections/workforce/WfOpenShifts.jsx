// src/backoffice/sections/workforce/WfOpenShifts.jsx
//
// v5.11.101: OPEN SHIFTS AND SWAPS on the Back Office rota.
//   * An open shift: on the rota with nobody on it yet, for anyone in its position to claim from the
//     staff app. Publishing the rota texts the people who could take it.
//   * Requests: a member of staff who cannot do a shift (open to everyone in the position, or offered
//     to one colleague), and claims waiting for a manager. With the venue setting "Need manager
//     approval" (Workforce settings) a claim waits here and in the Manager app until a manager
//     approves or declines it; approving checks every rule again (manager-approve swap.decide and the
//     database judge wf_swap_decide), so nothing on this screen can break a rule.

import { useState, useMemo } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { Card, Badge, inputStyle, labelStyle } from '../../../staff/wfUi';
import { hoursOf } from '../../../staff/labour';
import { shiftWords } from '../../../../supabase/functions/_shared/openShiftRules.js';
import { activeCountry } from '../../../lib/regionPack';

/** Editor for an open shift: the day, the position, the times. */
export function OpenShiftModal({ days, day, shift, roles, sections, templates, saving, defaultBreakMins = 30, onSave, onDelete, onClose }) {
  const roleList = roles?.list || [];
  const [dateIso, setDateIso] = useState(shift?.date || day?.iso || days?.[0]?.iso || '');
  const [roleKey, setRoleKey] = useState(shift?.roleKey || roleList[0]?.key || '');
  const [start, setStart] = useState(shift?.start || '09:00');
  const [finish, setFinish] = useState(shift?.finish || '17:00');
  const [breakMins, setBreakMins] = useState(shift?.breakMins ?? defaultBreakMins);
  const [sectionId, setSectionId] = useState(shift?.sectionId || sections?.[0]?.id || '');
  const hrs = useMemo(() => Math.max(0, hoursOf(start, finish) - (Number(breakMins) || 0) / 60), [start, finish, breakMins]);
  const applyTpl = (t) => {
    setStart(t.start); setFinish(t.finish);
    if (t.breakMins != null) setBreakMins(t.breakMins);
    if (t.sectionId && (sections || []).some(s => s.id === t.sectionId)) setSectionId(t.sectionId);
  };
  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 420 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{shift ? 'Edit open shift' : 'Add an open shift'}</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>Nobody on it yet. Anyone in the position can claim it from the staff app once the rota is published.</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><Icon name="close" size={14} /></button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
          <div><label style={labelStyle}>Day</label>
            <select style={inputStyle} value={dateIso} onChange={e => setDateIso(e.target.value)}>
              {(days || []).map(d => <option key={d.iso} value={d.iso}>{d.label} {d.dom}</option>)}
            </select>
          </div>
          <div><label style={labelStyle}>Position</label>
            <select style={inputStyle} value={roleKey} onChange={e => setRoleKey(e.target.value)}>
              {roleList.length === 0 && <option value="">No positions set up</option>}
              {roleList.map(r => <option key={r.key} value={r.key}>{r.lbl}</option>)}
            </select>
          </div>
        </div>
        {!!templates?.length && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
            {templates.map(t => (
              <button key={t.id} className="btn btn-ghost btn-xs" onClick={() => applyTpl(t)} style={{ borderRadius: 999, border: '1px solid var(--inset-border)', background: 'var(--inset)' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: t.color || 'var(--t3)', flexShrink: 0 }} />
                {t.name} <span className="mono" style={{ color: 'var(--t4)', fontSize: 10 }}>{t.start} to {t.finish}</span>
              </button>
            ))}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
          <div><label style={labelStyle}>Start</label><input type="time" style={inputStyle} value={start} onChange={e => setStart(e.target.value)} /></div>
          <div><label style={labelStyle}>Finish</label><input type="time" style={inputStyle} value={finish} onChange={e => setFinish(e.target.value)} /></div>
          <div><label style={labelStyle}>Break (mins)</label><input type="number" min="0" style={inputStyle} value={breakMins} onChange={e => setBreakMins(e.target.value)} /></div>
          <div><label style={labelStyle}>Section</label>
            <select style={inputStyle} value={sectionId} onChange={e => setSectionId(e.target.value)}>
              {(sections || []).length === 0 && <option value="">None</option>}
              {(sections || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>
        <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--inset)', border: '1px solid var(--inset-border)', borderRadius: 10, fontSize: 12, color: 'var(--t2)' }}>
          <Icon name="clock" size={13} /> &nbsp;Paid hours: <b className="mono" style={{ color: 'var(--t1)' }}>{hrs.toFixed(2)}h</b>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: shift ? 'space-between' : 'flex-end' }}>
          {shift && <button className="btn btn-ghost btn-sm" disabled={saving} onClick={() => onDelete(shift)} style={{ color: 'var(--red)' }}><Icon name="close" size={13} /> Delete</button>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-acc btn-sm" disabled={saving || !roleKey || !dateIso}
              onClick={() => onSave({ date: dateIso, roleKey, start, finish, breakMins: Number(breakMins) || 0, sectionId, section: (sections || []).find(s => s.id === sectionId)?.name || null })}>
              <Icon name="check" size={13} /> {saving ? 'Saving…' : 'Save open shift'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The week's open shifts and the requests waiting on the venue. */
export function OpenShiftsCard({ openShifts, requests, shiftsById, staffById, roles, mode, deciding, onAdd, onEdit, onDecide }) {
  const country = activeCountry();
  const roleLbl = (k) => roles?.map?.[k]?.lbl || k || 'Any position';
  const nameOf = (id) => staffById[id]?.name || 'Someone';
  const pending = (requests || []).filter(r => r.status === 'pending');
  const up = (requests || []).filter(r => r.status === 'open' && r.kind !== 'claim');
  const pendingFor = (shiftId) => pending.find(r => r.shiftId === shiftId);
  const whenOf = (r) => {
    const sh = shiftsById[r.shiftId];
    const s = sh || (r.snapshot ? { date: r.snapshot.date, start: r.snapshot.start, finish: r.snapshot.finish } : null);
    return s ? shiftWords(s, country) : 'a shift';
  };
  return (
    <Card style={{ marginBottom: 14, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Open shifts and swaps</div>
          <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 2 }}>
            {mode === 'instant' ? 'Claims and swaps happen straight away (Workforce settings).' : 'Claims and swaps need a manager to approve them (Workforce settings).'}
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onAdd}><Icon name="plus" size={13} /> Add an open shift</button>
      </div>

      {pending.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ ...labelStyle, marginBottom: 6 }}>Waiting for a manager</div>
          {pending.map(r => {
            const busy = deciding === r.id;
            return (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 10, background: 'rgba(245,166,35,.08)', border: '1px solid rgba(245,166,35,.30)', marginBottom: 6, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220, fontSize: 12.5, lineHeight: 1.5 }}>
                  <b>{nameOf(r.toStaffId)}</b> {r.kind === 'claim' ? 'wants the open shift' : <>wants to take <b>{nameOf(r.fromStaffId)}</b>'s shift</>} <span className="mono">{whenOf(r)}</span>
                  {r.note && <div style={{ color: 'var(--t3)', fontSize: 11.5 }}>Note: {r.note}</div>}
                </div>
                <button className="btn btn-ghost btn-xs" disabled={busy} onClick={() => onDecide(r, 'declined')}>Decline</button>
                <button className="btn btn-acc btn-xs" disabled={busy} onClick={() => onDecide(r, 'approved')}>{busy ? 'Saving…' : 'Approve'}</button>
              </div>
            );
          })}
        </div>
      )}

      {up.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ ...labelStyle, marginBottom: 6 }}>Up for someone to take</div>
          {up.map(r => (
            <div key={r.id} style={{ fontSize: 12.5, padding: '6px 2px', borderTop: '1px solid var(--bdr)' }}>
              <b>{nameOf(r.fromStaffId)}</b> cannot do <span className="mono">{whenOf(r)}</span>
              {r.kind === 'offer' ? <> and offered it to <b>{nameOf(r.toStaffId)}</b></> : <>, open to everyone in the position</>}
              {r.note && <span style={{ color: 'var(--t3)' }}> · {r.note}</span>}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <div style={{ ...labelStyle, marginBottom: 6 }}>Open shifts this week</div>
        {!openShifts.length
          ? <div style={{ fontSize: 12, color: 'var(--t4)' }}>None. Add one when you need cover and nobody is down for it yet.</div>
          : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {openShifts.map(sh => {
                const p = pendingFor(sh.id);
                return (
                  <button key={sh.id} onClick={() => onEdit(sh)} className="btn btn-ghost btn-xs"
                    style={{ borderRadius: 10, border: `1px ${sh.status === 'published' ? 'solid' : 'dashed'} var(--inset-border)`, background: 'var(--inset)', padding: '6px 10px', textAlign: 'left' }}>
                    <span className="mono" style={{ fontWeight: 700 }}>{shiftWords(sh, country)}</span>
                    <span style={{ color: 'var(--t3)' }}> · {roleLbl(sh.roleKey)}</span>
                    {sh.status !== 'published' && <Badge tone="grey">draft</Badge>}
                    {p && <Badge tone="amber">{nameOf(p.toStaffId).split(' ')[0]} asked</Badge>}
                  </button>
                );
              })}
            </div>
          )}
      </div>
    </Card>
  );
}
