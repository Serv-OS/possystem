// src/backoffice/sections/workforce/WfRota.jsx
//
// THE ROTA — the spine of Workforce. A weekly grid of staff (grouped by their
// role's section) × the 7 days of the week. Cells hold shifts; footer rows hold
// forecast / actual sales / wage cost / labour %. Publish pushes draft shifts
// live. A "By section" view checks coverage against minCoverage.

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { Card, EmptyState, Badge, RoleChip, money, th, td, inputStyle, labelStyle, groupColor, cellTint, GRP_SECTION, initials, LoadingCard } from '../../../staff/wfUi';
import * as wf from '../../../staff/wfData';
import { buildWeek, addWeeks, weekRangeLabel, ymd } from '../../../staff/wfWeek';
import { bucketShiftsBySection, UNASSIGNED } from '../../../staff/rotaSections.js';
import { caseDone, missingSteps, normalizeCase } from './WfOnboarding';
import { hoursOf, resolveRate, resolveRateOn, labourPct, venueBreakPolicy } from '../../../staff/labour';
// Clash logic (shift overlap = hard block; approved leave / unavailable day =
// soft warning, place anyway) is pure + unit-tested in wfClash.js.
import { findClash, clashWarnings } from '../../../staff/wfClash';

const GRP_ORDER = ['mgmt', 'bar', 'floor', 'kitchen', 'door'];
const TPL_COLOURS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];

// ── small shared bits ───────────────────────────────────────────────────────
/** Amber "place anyway" warning box (approved leave / unavailable day). */
function WarnBox({ warnings }) {
  if (!warnings?.length) return null;
  return (
    <div style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(245,166,35,.10)', border: '1px solid rgba(245,166,35,.30)', borderRadius: 10, fontSize: 12.5, color: 'var(--amber)', lineHeight: 1.6 }}>
      {warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
    </div>
  );
}

// ── Shift editor modal ──────────────────────────────────────────────────────
// `staff` is the person when you opened this from their row. Opening from the
// SECTION grid instead means the day + section are known but the person is not,
// so pass `staffOptions` and the modal picks them here (v5.5.990).
function ShiftModal({ staff, staffOptions, presetSectionId, day, shift, sections, templates, warningsFor, onSave, onDelete, onDuplicate, onNoShow, onClose, saving, defaultBreakMins = 30 }) {
  const picking = !staff;
  const [pickedId, setPickedId] = useState(staff?.id || staffOptions?.[0]?.id || '');
  const person = staff || (staffOptions || []).find(p => p.id === pickedId) || null;
  const [start, setStart] = useState(shift?.start || '09:00');
  const [finish, setFinish] = useState(shift?.finish || '17:00');
  // v5.5.969: new shifts default to the VENUE break policy (was hardcoded 30)
  const [breakMins, setBreakMins] = useState(shift?.breakMins ?? defaultBreakMins);
  const [sectionId, setSectionId] = useState(shift?.sectionId || presetSectionId || sections[0]?.id || '');
  const hrs = useMemo(() => Math.max(0, hoursOf(start, finish) - (Number(breakMins) || 0) / 60), [start, finish, breakMins]);
  // Clash / time-off / availability warnings follow whoever is currently picked.
  const warnings = useMemo(() => (person && warningsFor ? warningsFor(person, day) : []), [person, day, warningsFor]);

  // One tap fills the times from a standard shift (Morning / Evening / …).
  const applyTpl = (t) => {
    setStart(t.start); setFinish(t.finish);
    if (t.breakMins != null) setBreakMins(t.breakMins);
    if (t.sectionId && sections.some(s => s.id === t.sectionId)) setSectionId(t.sectionId);
  };

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 420 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{shift ? 'Edit shift' : 'Add shift'}</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>
              {picking
                ? <>{sections.find(s => s.id === presetSectionId)?.name || 'Rota'} · {day.label} {day.dom}</>
                : <>{staff.name} · {day.label} {day.dom}</>}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><Icon name="close" size={14} /></button>
        </div>
        {picking && (
          <div style={{ marginTop: 12 }}>
            <label style={labelStyle}>Who is working</label>
            <select style={inputStyle} value={pickedId} onChange={e => setPickedId(e.target.value)}>
              {(staffOptions || []).length === 0 && <option value="">— everyone is already on this day —</option>}
              {(staffOptions || []).map(p => <option key={p.id} value={p.id}>{p.name}{p.gated ? ' (onboarding not finished)' : p.busy ? ' (already on today)' : ''}</option>)}
            </select>
          </div>
        )}
        {!!templates?.length && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
            {templates.map(t => (
              <button key={t.id} className="btn btn-ghost btn-xs" onClick={() => applyTpl(t)}
                title={`${t.start}–${t.finish}`}
                style={{ borderRadius: 999, border: '1px solid var(--inset-border)', background: 'var(--inset)' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: t.color || 'var(--t3)', flexShrink: 0 }} />
                {t.name} <span className="mono" style={{ color: 'var(--t4)', fontSize: 10 }}>{t.start}–{t.finish}</span>
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
              {sections.length === 0 && <option value="">— none —</option>}
              {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>
        <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--inset)', border: '1px solid var(--inset-border)', borderRadius: 10, fontSize: 12, color: 'var(--t2)' }}>
          <Icon name="clock" size={13} /> &nbsp;Paid hours: <b className="mono" style={{ color: 'var(--t1)' }}>{hrs.toFixed(2)}h</b>
        </div>
        <WarnBox warnings={warnings} />
        <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: shift ? 'space-between' : 'flex-end' }}>
          {shift && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-ghost btn-sm" disabled={saving} onClick={() => onDelete(shift)} style={{ color: 'var(--red)' }}><Icon name="close" size={13} /> Delete</button>
              <button className="btn btn-ghost btn-sm" disabled={saving} onClick={() => onDuplicate(shift)} title="Copy this shift to another day or person"><Icon name="clipboard" size={13} /> Copy</button>
              {/* Only a shift that was actually on the rota (published) and whose
                  day has arrived can be a no-show — future shifts get cancelled
                  or deleted, not no-showed. */}
              {(shift.status === 'published' || shift.status === 'no_show') && day?.iso <= new Date().toISOString().slice(0, 10) && (
                <button className="btn btn-ghost btn-sm" disabled={saving} onClick={() => onNoShow(shift)}
                  style={{ color: shift.status === 'no_show' ? 'var(--t2)' : 'var(--amber)' }}>
                  <Icon name={shift.status === 'no_show' ? 'check' : 'close'} size={13} /> {shift.status === 'no_show' ? 'Showed up after all' : 'No show'}
                </button>
              )}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-acc btn-sm" disabled={saving || !person} onClick={() => onSave({ staffId: person?.id, start, finish, breakMins: Number(breakMins) || 0, sectionId, section: sections.find(s => s.id === sectionId)?.name || null })}>
              <Icon name="check" size={13} /> {saving ? 'Saving…' : warnings?.length ? 'Save anyway' : 'Save shift'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Standard shifts (templates) manager ─────────────────────────────────────
// Presets live on wf_venue_settings.settings.shiftTemplates — no new table.
function TemplatesModal({ templates, sections, onSave, onClose, saving, defaultBreakMins = 30 }) {
  const [list, setList] = useState(templates || []);
  const [form, setForm] = useState(null); // { id?, name, start, finish, breakMins, sectionId, color }
  const blank = { name: '', start: '09:00', finish: '17:00', breakMins: defaultBreakMins, sectionId: '', color: TPL_COLOURS[0] };

  const upsert = () => {
    if (!form.name.trim()) return;
    const t = { ...form, name: form.name.trim(), breakMins: Number(form.breakMins) || 0, id: form.id || 'tpl-' + Date.now() };
    setList(prev => form.id ? prev.map(x => x.id === form.id ? t : x) : [...prev, t]);
    setForm(null);
  };

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 460 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Standard shifts</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>Presets you can drop onto the rota in one tap.</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><Icon name="close" size={14} /></button>
        </div>

        {list.length === 0 && !form && (
          <div style={{ margin: '14px 0', padding: '14px 16px', background: 'var(--inset)', border: '1px solid var(--inset-border)', borderRadius: 12, fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.6 }}>
            No standard shifts yet. Create presets like <b>Morning 09:00–17:00</b> or <b>Evening 17:00–23:00</b> — they appear as one-tap chips when you add a shift.
          </div>
        )}

        {list.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 14 }}>
            {list.map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--inset)', border: '1px solid var(--inset-border)', borderRadius: 10 }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: t.color || 'var(--t3)', flexShrink: 0 }} />
                <span style={{ fontWeight: 600, fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                <span className="mono" style={{ fontSize: 11.5, color: 'var(--t3)' }}>{t.start}–{t.finish}</span>
                {t.sectionId && <span style={{ fontSize: 11, color: 'var(--t4)' }}>{sections.find(s => s.id === t.sectionId)?.name || ''}</span>}
                <button className="btn btn-ghost btn-xs" onClick={() => setForm({ ...blank, ...t })}><Icon name="edit" size={12} /></button>
                <button className="btn btn-ghost btn-xs" style={{ color: 'var(--red)' }} onClick={() => setList(prev => prev.filter(x => x.id !== t.id))}><Icon name="close" size={12} /></button>
              </div>
            ))}
          </div>
        )}

        {form ? (
          <div style={{ marginTop: 14, padding: 14, border: '1px solid var(--bdr2)', borderRadius: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div style={{ gridColumn: '1 / -1' }}><label style={labelStyle}>Name</label><input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Morning" autoFocus /></div>
              <div><label style={labelStyle}>Start</label><input type="time" style={inputStyle} value={form.start} onChange={e => setForm(f => ({ ...f, start: e.target.value }))} /></div>
              <div><label style={labelStyle}>Finish</label><input type="time" style={inputStyle} value={form.finish} onChange={e => setForm(f => ({ ...f, finish: e.target.value }))} /></div>
              <div><label style={labelStyle}>Break (mins)</label><input type="number" min="0" style={inputStyle} value={form.breakMins} onChange={e => setForm(f => ({ ...f, breakMins: e.target.value }))} /></div>
              <div><label style={labelStyle}>Section (optional)</label>
                <select style={inputStyle} value={form.sectionId} onChange={e => setForm(f => ({ ...f, sectionId: e.target.value }))}>
                  <option value="">— none —</option>
                  {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div style={{ gridColumn: '1 / -1' }}><label style={labelStyle}>Colour</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {TPL_COLOURS.map(c => (
                    <button key={c} onClick={() => setForm(f => ({ ...f, color: c }))}
                      style={{ width: 24, height: 24, borderRadius: '50%', background: c, border: form.color === c ? '2px solid var(--t1)' : '2px solid transparent', cursor: 'pointer' }} />
                  ))}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setForm(null)}>Cancel</button>
              <button className="btn btn-acc btn-sm" disabled={!form.name.trim()} onClick={upsert}><Icon name="check" size={13} /> {form.id ? 'Update' : 'Add'}</button>
            </div>
          </div>
        ) : (
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} onClick={() => setForm({ ...blank })}><Icon name="plus" size={13} /> Add standard shift</button>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-acc btn-sm" disabled={saving || !!form} onClick={() => onSave(list)}>
            <Icon name="check" size={13} /> {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Copy shift modal ────────────────────────────────────────────────────────
// Duplicate an existing shift to another day and/or person. The copy lands as
// a DRAFT. Overlaps block; leave/availability warn but never block.
function CopyShiftModal({ source, staff, wk, shifts, timeOff, avail, onCopy, onClose, saving }) {
  const [staffId, setStaffId] = useState(source.staffId);
  const [dateIso, setDateIso] = useState(source.date);
  const target = staff.find(s => s.id === staffId);
  const clash = findClash(shifts, staffId, dateIso, source.start, source.finish);
  const warnings = useMemo(() => clashWarnings({ staffName: target?.name, staffId, dateIso, timeOff, availability: avail }), [target, staffId, dateIso, timeOff, avail]);

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 420 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Copy shift</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }} className="mono">{source.start}–{source.finish}{source.section ? ` · ${source.section}` : ''}</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><Icon name="close" size={14} /></button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
          <div><label style={labelStyle}>To person</label>
            <select style={inputStyle} value={staffId} onChange={e => setStaffId(e.target.value)}>
              {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div><label style={labelStyle}>To day</label>
            <select style={inputStyle} value={dateIso} onChange={e => setDateIso(e.target.value)}>
              {wk.days.map(d => <option key={d.iso} value={d.iso}>{d.label} {d.dom}</option>)}
            </select>
          </div>
        </div>
        {clash && (
          <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--red-d)', border: '1px solid var(--red-b)', borderRadius: 10, fontSize: 12.5, color: 'var(--red)' }}>
            Clashes with their {clash.start}–{clash.finish} shift that day — pick another day or person.
          </div>
        )}
        <WarnBox warnings={warnings} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-acc btn-sm" disabled={saving || !!clash || !target} onClick={() => onCopy(target, dateIso)}>
            <Icon name="check" size={13} /> {saving ? 'Copying…' : warnings.length ? 'Copy anyway' : 'Copy shift'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Copy week modal ─────────────────────────────────────────────────────────
function CopyWeekModal({ wk, shiftCount, onCopy, onClose, saving }) {
  const [target, setTarget] = useState(addWeeks(wk.startIso, 1));
  const same = target.startIso === wk.startIso;
  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 420 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Copy week</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>Copy all of <b>{weekRangeLabel(wk)}</b> to another week.</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><Icon name="close" size={14} /></button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 16 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setTarget(addWeeks(target.startIso, -1))}><Icon name="chevron" size={14} style={{ transform: 'rotate(180deg)' }} /></button>
          <div style={{ minWidth: 150, textAlign: 'center', fontSize: 15, fontWeight: 700 }}>{weekRangeLabel(target)}</div>
          <button className="btn btn-ghost btn-sm" onClick={() => setTarget(addWeeks(target.startIso, 1))}><Icon name="chevron" size={14} /></button>
        </div>
        <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--inset)', border: '1px solid var(--inset-border)', borderRadius: 10, fontSize: 12, color: 'var(--t2)', lineHeight: 1.6 }}>
          Copies <b>{shiftCount}</b> shift{shiftCount === 1 ? '' : 's'} as <b>drafts</b> — publish when ready. Shifts that would overlap an existing shift, or belong to someone who has left, are skipped. Holiday or availability clashes are flagged, not blocked.
        </div>
        {same && <div style={{ marginTop: 10, fontSize: 12, color: 'var(--amber)' }}>Pick a different week.</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-acc btn-sm" disabled={saving || same || !shiftCount} onClick={() => onCopy(target)}>
            <Icon name="check" size={13} /> {saving ? 'Copying…' : 'Copy week'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main section ─────────────────────────────────────────────────────────────
export default function WfRota({ ctx, staff, roles, sections, settings, week, showToast, onSettingsSaved }) {
  const [wk, setWk] = useState(week);
  const [shifts, setShifts] = useState([]);
  const [forecast, setForecast] = useState({});   // { iso: amount }
  const [actual, setActual] = useState({});        // { iso: amount }
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);    // { staff, day, shift }
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);     // AI rota generation in progress
  const [view, setView] = useState('staff');       // 'staff' | 'section'
  const [secs, setSecs] = useState(sections || []); // sections loaded fresh (Settings may have changed them)
  const [timesheets, setTimesheets] = useState([]); // for actual wage cost
  const [timeOff, setTimeOff] = useState([]);       // wf_time_off — approved leave drives warnings
  const [avail, setAvail] = useState([]);           // wf_availability — weekly pattern drives warnings
  const [tplOpen, setTplOpen] = useState(false);    // Standard shifts manager
  const [copying, setCopying] = useState(null);     // shift being duplicated
  // v5.5.970: scheduled future-dated rate changes — shifts on/after a change's
  // effective date stamp the NEW rate at publish (resolveRateOn).
  const [rateChanges, setRateChanges] = useState([]);
  const [copyWeekOpen, setCopyWeekOpen] = useState(false);

  const targetPct = settings?.labourTargetPct ?? 0.3;
  // Standard shifts (venue presets) live on wf_venue_settings.settings jsonb.
  const templates = settings?.settings?.shiftTemplates || [];

  async function reload(w) {
    setLoading(true);
    try {
      const [sh, fc, ac, sc, ts, lv, av, rc, ob] = await Promise.all([
        wf.loadShifts(ctx.locationId, w.startIso, w.endIso),
        wf.loadForecast(ctx.locationId, w.startIso, w.endIso),
        wf.loadActualSales(ctx.locationId, w.startIso, w.endIso),
        wf.loadSections(ctx.locationId),
        wf.loadTimesheets(ctx.locationId, w.startIso, w.endIso),
        wf.loadTimeOff(ctx.locationId),
        wf.loadAvailability(ctx.locationId),
        wf.loadRateChanges(ctx.locationId),
        wf.loadOnboarding(ctx.locationId),
      ]);
      setShifts(sh || []);
      setForecast(fc || {});
      setActual(ac || {});
      if (sc) setSecs(sc);
      setTimesheets(ts || []);
      setTimeOff(lv || []);
      setAvail(av || []);
      setRateChanges(rc || []);
      // Heal legacy label-keyed steps from meta evidence FIRST — the Onboarding
      // screen does this on load, and the gate must agree with what that screen
      // shows or a person displayed as "Completed" gets blocked here.
      setOnbCases((ob || []).map(c => normalizeCase(c, (staff || []).find(m => m.id === c.staffId))));
    } catch (e) {
      showToast('Could not load the rota: ' + e.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { reload(wk); /* eslint-disable-next-line */ }, [ctx.locationId, wk.startIso]);

  // staff grouped by their role's section
  const groups = useMemo(() => {
    const by = {};
    staff.forEach(s => {
      const grp = roles.map[s.role]?.grp || 'mgmt';
      (by[grp] = by[grp] || []).push(s);
    });
    return GRP_ORDER.filter(g => by[g]?.length).map(g => ({ grp: g, label: GRP_SECTION[g] || g, rows: by[g] }));
  }, [staff, roles]);

  // ALL shifts for a staff/day — a person can work multiple (split shifts),
  // and rendering only the first used to HIDE duplicates (e.g. repeated AI
  // builder runs) that still counted in wages and showed up in Timesheets.
  const shiftsFor = (staffId, iso) => shifts.filter(s => s.staffId === staffId && s.date === iso).sort((a, b) => (a.start || '').localeCompare(b.start || ''));

  // per-day SCHEDULED wage from shift computedCost
  const wageByIso = useMemo(() => {
    const m = {};
    wk.days.forEach(d => { m[d.iso] = 0; });
    shifts.forEach(s => { if (m[s.date] != null) m[s.date] += Number(s.computedCost || 0); });
    return m;
  }, [shifts, wk]);

  // per-day ACTUAL wage from timesheets (pay_amount, else actual_hours × rate), by clock-in date
  const actualWageByIso = useMemo(() => {
    const m = {}; wk.days.forEach(d => { m[d.iso] = 0; });
    (timesheets || []).forEach(t => {
      // LOCAL date of the clock-in — toISOString() is UTC and shifts evening
      // clock-ins across midnight depending on the device timezone.
      const iso = t.clockIn ? ymd(new Date(t.clockIn)) : null;
      if (iso == null || m[iso] == null) return;
      const pay = t.payAmount != null ? Number(t.payAmount) : Number(t.actualHours || 0) * Number(t.effectiveRate || 0);
      m[iso] += pay;
    });
    return m;
  }, [timesheets, wk]);

  // no_show is NOT a draft: without this filter, "Publish all" would quietly
  // resurrect every no-show back into a published shift.
  const draftIds = useMemo(() => shifts.filter(s => s.status !== 'published' && s.status !== 'no_show').map(s => s.id), [shifts]);
  const staffById = useMemo(() => Object.fromEntries((staff || []).map(s => [s.id, s])), [staff]);
  const [onbCases, setOnbCases] = useState([]);

  // ── The onboarding gate (Peter, 6 Aug): someone whose onboarding is OPEN
  // cannot be put on a shift. People with NO case at all (added before
  // onboarding existed) stay schedulable — otherwise the existing roster
  // would lock up. Returns null when clear, or the human reason when gated.
  const onboardingBlock = useCallback((staffId) => {
    const member = staffById[staffId];
    const c = (onbCases || []).filter(x => x.staffId === staffId)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
    if (!c || caseDone(c, member)) return null;
    const missing = missingSteps(c, member);
    return `${member?.name || 'They'} can't be scheduled yet — onboarding isn't finished (${missing.join(', ') || 'steps outstanding'}). Complete it in Workforce → Onboarding.`;
  }, [onbCases, staffById]);
  // Same resolved venue break policy the Timesheets screen uses, so a new rota
  // shift and a new manual timesheet can no longer disagree about the default.
  const breakPolicy = useMemo(() => venueBreakPolicy(settings?.settings), [settings?.settings]);

  // Time-off / availability warnings for a given person on a given day. Passed
  // to ShiftModal as a callback so it re-runs when the modal's own person picker
  // changes (the section grid opens the modal before anyone is chosen).
  const warningsFor = useCallback(
    (person, day) => clashWarnings({ staffName: person.name, staffId: person.id, dateIso: day.iso, timeOff, availability: avail }),
    [timeOff, avail],
  );

  // ── Section view: every shift MUST land in a row ──────────────────────────
  // v5.5.992 — the section grid filtered on `shift.sectionId === section.id`, so
  // any shift with no section assigned (which is most of them) was silently
  // dropped. A week showing 12 shifts under "By staff" showed 3 under
  // "By section". The two views also group by different things entirely: By
  // staff groups by the person's ROLE GROUP (Floor / Kitchen, from wfUi's
  // GRP_SECTION), By section groups by the shift's own section.
  //
  // Resolution order for a shift: its explicit section → a section whose NAME
  // matches the person's role group (a Chef lands in "Kitchen") → Unassigned.
  // The Unassigned row is what makes the drop impossible rather than unlikely.
  // The person's role-group display name ('Kitchen', 'Floor'), which is what the
  // By-staff view groups on. Bridging the two models is the whole fix.
  const groupNameOf = useCallback((sh) => {
    const grp = roles?.map?.[sh.roleKey || staffById[sh.staffId]?.role]?.grp;
    return grp ? (GRP_SECTION[grp] || grp) : null;
  }, [roles, staffById]);

  // Bucketed once, so the cells and the footer total read the SAME map and can
  // never disagree. Logic + the "nothing is dropped" invariant are unit-tested
  // in src/staff/rotaSections.test.js.
  // The person's OWN sections (wf_staff.section_ids). "Jane works Runner", so
  // her shifts with no section of their own belong under Runner.
  const staffSectionsOf = useCallback(
    (sh) => staffById[sh.staffId]?.sectionIds || [],
    [staffById],
  );
  const { map: sectionGrid, unassigned: unassignedCount } = useMemo(
    () => bucketShiftsBySection(shifts, secs, groupNameOf, staffSectionsOf),
    [shifts, secs, groupNameOf, staffSectionsOf],
  );

  // Who can be added to a section on a given day, already-scheduled people last
  // and marked, so you can still add a split shift but won't pick them by accident.
  const staffOptionsFor = useCallback((dayIso) => {
    const onDay = new Set(shifts.filter(s => s.date === dayIso).map(s => s.staffId));
    return (staff || [])
      .map(p => ({ ...p, busy: onDay.has(p.id), gated: !!onboardingBlock(p.id) }))
      .sort((a, b) => (a.busy === b.busy ? a.name.localeCompare(b.name) : a.busy ? 1 : -1));
  }, [staff, shifts, onboardingBlock]);

  // ── handlers ────────────────────────────────────────────────────────────
  async function saveShift(payload) {
    const { day, shift } = editing;
    // The person comes from the row you clicked, or from the modal's picker when
    // you started from a SECTION cell and only the day + section were known.
    const s = editing.staff || staff.find(x => x.id === payload.staffId);
    if (!s) { showToast('Pick who is working this shift', 'error'); return; }
    const gate = onboardingBlock(s.id);
    if (gate) { showToast(gate, 'error'); return; }
    // No clashing shifts: a person can work split shifts, but the times must
    // not overlap an existing shift that day (editing a shift ignores itself).
    const clash = findClash(shifts, s.id, day.iso, payload.start, payload.finish, shift?.id);
    if (clash) {
      showToast(`Clashes with their ${clash.start}–${clash.finish} shift on ${day.label} — change the times, or edit that shift instead`, 'error');
      return;
    }
    const role = roles.map[s.role];
    const { rate, source } = resolveRateOn(s, role, day.iso, rateChanges);
    const hours = Math.max(0, hoursOf(payload.start, payload.finish) - payload.breakMins / 60);
    const next = {
      ...(shift || {}),
      id: shift?.id || 'tmp-' + Date.now(),
      staffId: s.id, roleKey: s.role, date: day.iso,
      start: payload.start, finish: payload.finish, breakMins: payload.breakMins,
      sectionId: payload.sectionId, section: payload.section,
      status: shift?.status || 'draft', note: shift?.note || '',
      effectiveRate: rate, rateSource: source,
      computedHours: Math.round(hours * 100) / 100,
      computedCost: Math.round(hours * rate * 100) / 100,
    };
    setShifts(prev => { const o = prev.filter(x => x.id !== next.id); return [...o, next]; });
    setSaving(true);
    try {
      const saved = await wf.saveShift(next, ctx.locationId, ctx.orgId);
      setShifts(prev => prev.map(x => x.id === next.id ? saved : x));
      setEditing(null);
      showToast('Shift saved', 'success');
    } catch (e) {
      showToast('Save failed: ' + e.message, 'error');
      reload(wk);
    } finally { setSaving(false); }
  }

  async function markNoShow(shift) {
    const on = shift.status !== 'no_show';
    if (on && !confirm(`Mark this shift as a NO SHOW?\n\nIt drops out of tip allocation and the staff portal, and is reported under no-shows. You can undo it from the same place.`)) return;
    try {
      await wf.setShiftStatus(shift.id, on ? 'no_show' : 'published');
      setShifts(prev => prev.map(x => x.id === shift.id ? { ...x, status: on ? 'no_show' : 'published' } : x));
      setEditing(null);
      showToast(on ? 'Marked as no-show' : 'Shift restored to published', 'success');
    } catch (e) { showToast(e.message || 'Could not update the shift', 'error'); }
  }

  async function removeShift(shift) {
    setShifts(prev => prev.filter(x => x.id !== shift.id));
    setEditing(null);
    try {
      await wf.deleteShift(shift.id);
      showToast('Shift removed', 'info');
    } catch (e) {
      showToast('Delete failed: ' + e.message, 'error');
      reload(wk);
    }
  }

  // Persist the standard-shift presets onto wf_venue_settings.settings jsonb
  // (whole settings row is upserted — pass the full current settings through).
  async function saveTemplates(list) {
    setSaving(true);
    try {
      const saved = await wf.saveSettings({ ...settings, settings: { ...(settings?.settings || {}), shiftTemplates: list } }, ctx.locationId, ctx.orgId);
      onSettingsSaved?.(saved);
      setTplOpen(false);
      showToast('Standard shifts saved', 'success');
    } catch (e) {
      showToast('Could not save standard shifts: ' + e.message, 'error');
    } finally { setSaving(false); }
  }

  // Duplicate one shift to another day and/or person — lands as a DRAFT with
  // the rate re-snapshotted for the target person (never carried across).
  async function copyShift(target, dateIso) {
    const gate = onboardingBlock(target.id);
    if (gate) { showToast(gate, 'error'); return; }
    const src = copying;
    const role = roles.map[target.role];
    const { rate, source } = resolveRateOn(target, role, dateIso, rateChanges);
    const hours = Math.max(0, hoursOf(src.start, src.finish) - (src.breakMins || 0) / 60);
    const next = {
      id: 'tmp-' + Date.now(),
      staffId: target.id, roleKey: target.role, date: dateIso,
      start: src.start, finish: src.finish, breakMins: src.breakMins || 0,
      sectionId: src.sectionId || null, section: src.section || null,
      status: 'draft', note: '',
      effectiveRate: rate, rateSource: source,
      computedHours: Math.round(hours * 100) / 100,
      computedCost: Math.round(hours * rate * 100) / 100,
    };
    setSaving(true);
    try {
      const saved = await wf.saveShift(next, ctx.locationId, ctx.orgId);
      setShifts(prev => [...prev, saved]);
      setCopying(null);
      showToast('Shift copied — drafted, publish when ready', 'success');
    } catch (e) {
      showToast('Copy failed: ' + e.message, 'error');
    } finally { setSaving(false); }
  }

  // Copy the whole week's shifts to another week as DRAFTS. Skips leavers
  // (no longer in the staff list) and shifts that would overlap; leave/
  // availability clashes are placed but counted in the results toast.
  async function copyWeek(target) {
    setSaving(true);
    try {
      const existing = await wf.loadShifts(ctx.locationId, target.startIso, target.endIso);
      const working = [...(existing || [])];
      const staffById = Object.fromEntries(staff.map(s => [s.id, s]));
      const toInsert = [];
      let skipped = 0, warned = 0;
      for (const s of shifts) {
        const idx = wk.days.findIndex(d => d.iso === s.date);
        const person = staffById[s.staffId];
        if (idx < 0 || !person) { skipped++; continue; }             // leaver / out of week
        if (onboardingBlock(s.staffId)) { skipped++; continue; }     // onboarding gate
        const dateIso = target.days[idx].iso;
        if (findClash(working, s.staffId, dateIso, s.start, s.finish)) { skipped++; continue; }
        if (clashWarnings({ staffName: person.name, staffId: s.staffId, dateIso, timeOff, availability: avail }).length) warned++;
        const role = roles.map[person.role];
        const { rate, source } = resolveRateOn(person, role, dateIso, rateChanges);
        const hours = Math.max(0, hoursOf(s.start, s.finish) - (s.breakMins || 0) / 60);
        const copy = {
          staffId: s.staffId, roleKey: person.role, date: dateIso,
          start: s.start, finish: s.finish, breakMins: s.breakMins || 0,
          sectionId: s.sectionId || null, section: s.section || null, status: 'draft',
          effectiveRate: rate, rateSource: source,
          computedHours: Math.round(hours * 100) / 100,
          computedCost: Math.round(hours * rate * 100) / 100,
        };
        working.push(copy);
        toInsert.push(copy);
      }
      let added = 0;
      if (toInsert.length) {
        const saved = await wf.saveShiftsBulk(toInsert, ctx.locationId, ctx.orgId);
        added = saved.length;
        await wf.logAudit({ action: 'rota.copy_week', entity: 'wf_shifts', entityId: target.startIso, reason: `Copied ${added} shift(s) from ${weekRangeLabel(wk)} to ${weekRangeLabel(target)}`, after: { from: wk.startIso, to: target.startIso, count: added } }, ctx.locationId, ctx.orgId);
      }
      setCopyWeekOpen(false);
      const bits = [`${added} shift${added === 1 ? '' : 's'} copied as drafts`];
      if (warned) bits.push(`${warned} with warnings`);
      if (skipped) bits.push(`${skipped} skipped`);
      showToast(bits.join(' · '), added ? 'success' : 'info');
      if (added) setWk(target); // jump to the target week to review the drafts
    } catch (e) {
      showToast('Copy week failed: ' + e.message, 'error');
    } finally { setSaving(false); }
  }

  async function saveForecastCell(iso, raw) {
    const amt = Number(raw);
    if (!Number.isFinite(amt)) return;
    const prevAmt = forecast[iso];
    setForecast(prev => ({ ...prev, [iso]: amt }));
    try {
      await wf.saveForecast(iso, amt, ctx.locationId, ctx.orgId);
    } catch (e) {
      // Put the old figure back immediately — the labour % rows read off this
      // map, so a rejected forecast would keep showing a (reassuring) wrong %.
      setForecast(prev => ({ ...prev, [iso]: prevAmt }));
      showToast('Forecast not saved: ' + e.message, 'error');
      reload(wk);
    }
  }

  async function publish() {
    if (!draftIds.length) { showToast('No draft shifts to publish', 'info'); return; }
    setPublishing(true);
    // PHASE 1 — the server-side publish, on its own, and it THROWS now.
    // Everything below it (audit row, local "published" flags, staff SMS AND
    // email) is downstream of the write actually landing: publishShifts used to
    // only console.warn, so staff were told about a rota the database had
    // rejected and the audit trail claimed it was live.
    try {
      await wf.publishShifts(draftIds);
    } catch (e) {
      showToast('Publish failed — nothing was published and no-one was notified: ' + e.message, 'error');
      reload(wk);          // back to server truth; the shifts stay drafts
      setPublishing(false);
      return;
    }
    // PHASE 2 — the rota IS live from here on.
    try {
      setShifts(prev => prev.map(s => draftIds.includes(s.id) ? { ...s, status: 'published' } : s));
      await wf.logAudit({ action: 'rota.publish', entity: 'wf_shifts', entityId: wk.startIso, reason: `Published ${draftIds.length} shift(s) for ${weekRangeLabel(wk)}`, after: { ids: draftIds, week: wk.startIso } }, ctx.locationId, ctx.orgId);

      // Notify each affected staff member of their week's shifts — by SMS AND
      // email (whichever contact details are on file), so no-one is missed.
      const affected = new Set(shifts.filter(s => draftIds.includes(s.id)).map(s => s.staffId));
      const published = shifts.map(s => draftIds.includes(s.id) ? { ...s, status: 'published' } : s).filter(s => s.status === 'published');
      const dayLabel = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      const nameOf = id => (staff.find(s => s.id === id) || {});
      // Notify everyone IN PARALLEL — this used to await one SMS/email at a
      // time, so a 20-person publish took 20× a single send's latency.
      let notified = 0, noContact = 0, failed = 0;
      await Promise.all([...affected].map(async (sid) => {
        const member = nameOf(sid);
        const mine = published.filter(x => x.staffId === sid).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
        if (!mine.length) return;
        const first = (member.name || 'there').split(' ')[0];
        const lines = mine.map(x => `${dayLabel(x.date)} ${x.start}–${x.finish}${x.section ? ` (${x.section})` : ''}`);
        const smsMsg = `Hi ${first}, your rota for w/c ${weekRangeLabel(wk)}:\n${lines.join('\n')}`;
        const emailHtml = `<div style="font-family:system-ui,sans-serif;max-width:560px"><p>Hi ${first},</p><p>Your shifts for the week commencing <strong>${weekRangeLabel(wk)}</strong>${ctx.locName ? ` at ${ctx.locName}` : ''}:</p><ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul><p>See you then!</p></div>`;
        const [smsRes, emailRes] = await Promise.allSettled([
          member.mobile ? wf.sendStaffSms(member.mobile, smsMsg, ctx.locationId, 'rota_notification', wk.startIso) : Promise.resolve(null),
          member.email ? wf.sendEmail(member.email, `Your rota — w/c ${weekRangeLabel(wk)}`, emailHtml, ctx.locationId) : Promise.resolve(null),
        ]);
        const any = (smsRes.status === 'fulfilled' && smsRes.value?.ok) || (member.email && emailRes.status === 'fulfilled');
        if (any) notified++;
        else if (!member.mobile && !member.email) noContact++;
        else failed++;
      }));
      const bits = [];
      if (notified) bits.push(`notified ${notified}`);
      if (failed) bits.push(`${failed} failed`);
      if (noContact) bits.push(`${noContact} no contact details`);
      const tail = bits.length ? ` · ${bits.join(', ')}` : '';
      showToast(`Published ${draftIds.length} shift${draftIds.length === 1 ? '' : 's'}${tail}`, 'success');
    } catch (e) {
      // The shifts ARE published (phase 1 succeeded) — only the notifications
      // fell over, so don't tell the operator the publish failed.
      showToast('Rota published, but notifying the team failed: ' + e.message, 'error');
      reload(wk);
    } finally { setPublishing(false); }
  }

  // ── AI rota builder: availability + forecast + target % → draft shifts ──────
  async function buildWithAI() {
    if (!staff.length) return;
    setAiBusy(true);
    try {
      const availability = await wf.loadAvailability(ctx.locationId).catch(() => []);
      const avByStaff = {};
      (availability || []).forEach(a => { avByStaff[a.staffId] = (avByStaff[a.staffId] || []).concat(a.perDay || []); });
      const staffInfo = staff.map(s => {
        const role = roles.map[s.role] || {};
        // AI generation plans the VISIBLE week — cost with that week's rates
        const { rate } = resolveRateOn(s, role, wk?.days?.[0]?.iso, rateChanges);
        return {
          staffId: s.id, name: s.name, position: role.lbl || s.role, section: GRP_SECTION[role.grp] || role.grp || 'Floor',
          rate: Math.round((rate || 0) * 100) / 100, maxWeeklyHours: s.weeklyHoursTarget || s.contractedWeek || null,
          availability: avByStaff[s.id] && avByStaff[s.id].length ? avByStaff[s.id] : 'flexible',
        };
      });
      const sectionReq = (secs || []).map(sec => ({ section: sec.name, minCoverage: sec.minCoverage }));
      const days = wk.days.map(d => ({ date: d.iso, day: d.label, forecastSales: Math.round(forecast[d.iso] || 0) }));
      const targetPctNum = Math.round((settings?.labourTargetPct ?? 0.28) * 100);
      const userMsg =
        `Build a one-week rota.\n` +
        `Week: ${weekRangeLabel(wk)} (use these exact dates).\n` +
        `Days + sales forecast (£): ${JSON.stringify(days)}\n` +
        `Staff (use staffId verbatim): ${JSON.stringify(staffInfo)}\n` +
        `Section minimum coverage: ${JSON.stringify(sectionReq)}\n` +
        `Target labour cost: ${targetPctNum}% of each day's forecast sales.\n` +
        `Return ONLY the JSON array of shifts.`;
      const resp = await wf.callAI([{ role: 'user', content: userMsg }], 'rota');
      const text = (resp?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      const m = text.match(/\[[\s\S]*\]/);
      if (!m) throw new Error('the AI did not return a usable rota — try again');
      let proposed;
      try { proposed = JSON.parse(m[0]); } catch { throw new Error('could not read the AI rota — try again'); }
      if (!Array.isArray(proposed) || !proposed.length) throw new Error('the AI returned no shifts');

      const valid = new Set(staff.map(s => s.id));
      const weekDates = new Set(wk.days.map(d => d.iso));
      // Clash guard: against existing shifts AND the batch as it grows — this
      // is what previously let repeated AI runs pile duplicates onto the week.
      const working = [...shifts];
      let skippedClash = 0;
      const toInsert = [];
      for (const p of proposed) {
        if (!valid.has(p.staffId) || !weekDates.has(p.date) || !p.start || !p.finish) continue;
        if (findClash(working, p.staffId, p.date, p.start, p.finish)) { skippedClash++; continue; }
        const s = staff.find(x => x.id === p.staffId);
        const role = roles.map[s.role];
        const { rate, source } = resolveRateOn(s, role, p.date, rateChanges);
        const breakMins = Number(p.breakMins) || 0;
        const hours = Math.max(0, hoursOf(p.start, p.finish) - breakMins / 60);
        const shift = {
          staffId: s.id, roleKey: s.role, date: p.date, start: p.start, finish: p.finish, breakMins,
          section: p.section || (GRP_SECTION[role?.grp] || null), status: 'draft',
          effectiveRate: rate, rateSource: source,
          computedHours: Math.round(hours * 100) / 100, computedCost: Math.round(hours * rate * 100) / 100,
        };
        working.push(shift); // future proposals clash-check against this one too
        toInsert.push(shift);
      }
      // ONE bulk insert instead of N sequential saves — a 30-shift week is a
      // single round-trip rather than 30.
      let added = 0;
      if (toInsert.length) {
        const saved = await wf.saveShiftsBulk(toInsert, ctx.locationId, ctx.orgId);
        added = saved.length;
      }
      await reload(wk);
      const skipNote = skippedClash ? ` (${skippedClash} skipped — clashed with shifts already on the rota)` : '';
      showToast(added ? `AI added ${added} draft shift${added === 1 ? '' : 's'}${skipNote} — review, tweak, then publish` : `AI produced no new shifts${skipNote || ' — try adding availability/forecast'}`, added ? 'success' : 'info');
    } catch (e) {
      showToast('AI rota: ' + (e.message || 'failed'), 'error');
    } finally { setAiBusy(false); }
  }

  // ── empty / loading ───────────────────────────────────────────────────────
  if (staff.length === 0) {
    return <EmptyState icon="team" title="Add your team first" body="The rota is built from your staff. Once you have people on the books, you'll be able to drop shifts onto a weekly grid, forecast sales, and watch your labour % live." />;
  }
  if (loading) return <LoadingCard label="Loading the rota…" />;

  // ── week switcher + view toggle + publish (shared header) ──────────────────
  const Header = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setWk(addWeeks(wk.startIso, -1))}><Icon name="chevron" size={14} style={{ transform: 'rotate(180deg)' }} /></button>
        <div style={{ minWidth: 150, textAlign: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{weekRangeLabel(wk)}</div>
          <button className="btn btn-ghost btn-xs" style={{ marginTop: 2 }} onClick={() => setWk(buildWeek())}>This week</button>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => setWk(addWeeks(wk.startIso, 1))}><Icon name="chevron" size={14} /></button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ display: 'inline-flex', background: 'var(--inset)', border: '1px solid var(--inset-border)', borderRadius: 999, padding: 3 }}>
          {[['staff', 'By staff'], ['section', 'By section']].map(([k, lbl]) => (
            <button key={k} className={view === k ? 'btn btn-acc btn-xs' : 'btn btn-ghost btn-xs'} style={{ borderRadius: 999 }} onClick={() => setView(k)}>{lbl}</button>
          ))}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => setTplOpen(true)} title="Set up standard shifts (Morning, Evening…) to drop onto the rota in one tap">
          <Icon name="clock" size={14} /> Standard shifts
        </button>
        <button className="btn btn-ghost btn-sm" disabled={saving || !shifts.length} onClick={() => setCopyWeekOpen(true)} title="Copy this week's shifts to another week as drafts">
          <Icon name="clipboard" size={14} /> Copy week
        </button>
        <button className="btn btn-ghost btn-sm" disabled={aiBusy || publishing} onClick={buildWithAI} title="Generate a draft rota from availability, forecast and your target labour %">
          <Icon name="sparkle" size={14} /> {aiBusy ? 'Building…' : 'Build with AI'}
        </button>
        <button className="btn btn-acc btn-sm" disabled={publishing || !draftIds.length} onClick={publish}>
          {publishing ? 'Publishing…' : <>Publish rota <Icon name="arrow" size={13} /></>}
          {!!draftIds.length && <Badge tone="amber">{draftIds.length}</Badge>}
        </button>
      </div>
    </div>
  );

  const dayCols = wk.days.map(d => (
    <th key={d.iso} style={{ ...th, textAlign: 'center', color: d.isToday ? 'var(--acc)' : 'var(--t3)' }}>
      {d.label}<br /><span className="mono" style={{ fontSize: 11 }}>{d.dom}</span>
    </th>
  ));

  // Modals shared by both views (templates / copy shift / copy week / editor).
  const Modals = (
    <>
      {editing && (
        <ShiftModal
          staff={editing.staff} day={editing.day} shift={editing.shift}
          staffOptions={editing.staffOptions} presetSectionId={editing.sectionId}
          sections={secs} templates={templates} saving={saving}
          defaultBreakMins={breakPolicy.defaultMins}
          warningsFor={warningsFor}
          onSave={saveShift} onDelete={removeShift} onNoShow={markNoShow} onClose={() => setEditing(null)}
          onDuplicate={(sh) => { setEditing(null); setCopying(sh); }}
        />
      )}
      {tplOpen && (
        <TemplatesModal templates={templates} sections={secs} saving={saving} defaultBreakMins={breakPolicy.defaultMins} onSave={saveTemplates} onClose={() => setTplOpen(false)} />
      )}
      {copying && (
        <CopyShiftModal source={copying} staff={staff} wk={wk} shifts={shifts} timeOff={timeOff} avail={avail} saving={saving} onCopy={copyShift} onClose={() => setCopying(null)} />
      )}
      {copyWeekOpen && (
        <CopyWeekModal wk={wk} shiftCount={shifts.length} saving={saving} onCopy={copyWeek} onClose={() => setCopyWeekOpen(false)} />
      )}
    </>
  );

  // ── By section view ────────────────────────────────────────────────────────
  if (view === 'section') {
    return (
      <Card>
        {Header}
        {Modals}
        {secs.length === 0 && !unassignedCount
          ? <EmptyState icon="floor" title="No sections yet" body="Create sections (Bar, Floor, Kitchen…) in Settings to track coverage per area. Then assign each shift to a section and we'll flag any day that's understaffed." />
          : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead><tr><th style={th}>Section</th>{dayCols}</tr></thead>
                <tbody>
                  {[...secs, ...(unassignedCount ? [{ id: UNASSIGNED, name: 'No section assigned', color: 'var(--t4)', minCoverage: 0, ghost: true }] : [])].map(sec => (
                    <tr key={sec.id}>
                      <td style={{ ...td, verticalAlign: 'top' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 600, color: sec.ghost ? 'var(--t3)' : undefined }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: sec.color || 'var(--t3)', opacity: sec.ghost ? 0.6 : 1 }} />{sec.name}
                        </span>
                        {sec.ghost && (
                          <div style={{ fontSize: 10, color: 'var(--t4)', marginTop: 3, lineHeight: 1.4, maxWidth: 190 }}>
                            These shifts exist on the rota but aren’t in any section. Open one to assign it.
                          </div>
                        )}
                      </td>
                      {wk.days.map(d => {
                        const on = sectionGrid.get(`${sec.id}|${d.iso}`) || [];
                        const under = sec.minCoverage > 0 && on.length < sec.minCoverage;
                        return (
                          <td key={d.iso} style={{ ...td, verticalAlign: 'top', padding: '7px 8px', background: under ? cellTint('var(--red)', 9) : 'transparent' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              <span className="mono" style={{ fontWeight: 700, fontSize: 12, color: under ? 'var(--red)' : 'var(--t2)' }}>
                                {on.length}{sec.minCoverage > 0 && <span style={{ fontSize: 10, color: 'var(--t4)' }}>/{sec.minCoverage}</span>}
                              </span>
                              {!sec.ghost && (
                                <button
                                  className="btn btn-ghost btn-xs"
                                  title={`Add someone to ${sec.name} on ${d.label} ${d.dom}`}
                                  onClick={() => setEditing({ staff: null, day: d, shift: null, sectionId: sec.id, staffOptions: staffOptionsFor(d.iso) })}
                                  style={{ padding: '0 5px', minWidth: 0, lineHeight: 1.5, fontSize: 13, opacity: 0.6 }}
                                >+</button>
                              )}
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: on.length ? 5 : 0 }}>
                              {on.map(s => {
                                const p = staffById[s.staffId];
                                const draft = s.status !== 'published';
                                return (
                                  <button
                                    key={s.id}
                                    onClick={() => p && setEditing({ staff: p, day: d, shift: s })}
                                    title={`${p?.name || 'Unknown'} · ${s.start}–${s.finish}${draft ? ' · draft' : ''}${sec.ghost ? ' · no section assigned' : ''}`}
                                    style={{
                                      display: 'flex', alignItems: 'center', gap: 5, width: '100%', textAlign: 'left',
                                      padding: '3px 5px', borderRadius: 7, cursor: p ? 'pointer' : 'default',
                                      border: `1px ${draft ? 'dashed' : 'solid'} var(--inset-border)`,
                                      background: 'var(--inset)', color: 'var(--t1)', font: 'inherit', fontSize: 11,
                                    }}
                                  >
                                    <span style={{
                                      width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                                      background: sec.color || 'var(--t3)', color: '#fff',
                                      fontSize: 8, fontWeight: 700, display: 'grid', placeItems: 'center',
                                    }}>{initials(p?.name)}</span>
                                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
                                      {(p?.name || 'Unknown').split(' ')[0]}
                                    </span>
                                    <span className="mono" style={{ fontSize: 9.5, color: 'var(--t3)', flexShrink: 0 }}>{s.start}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
                {/* The invariant made visible: this total must equal the number of
                    shifts the By-staff view shows. Before v5.5.992 a week with 12
                    shifts rendered 3 here and nothing said so. */}
                <tfoot>
                  <tr>
                    <td style={{ ...td, fontSize: 11, color: 'var(--t3)' }}>
                      {shifts.length} shift{shifts.length === 1 ? '' : 's'} this week
                      {unassignedCount > 0 && <>, <b style={{ color: 'var(--amber)' }}>{unassignedCount} unassigned</b></>}
                    </td>
                    <td colSpan={wk.days.length} style={{ ...td, fontSize: 11, color: 'var(--t4)' }}>
                      Same shifts as “By staff”, arranged by section.
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
      </Card>
    );
  }

  // ── By staff view (the grid) ───────────────────────────────────────────────
  return (
    <>
      <Card>
        {Header}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
            <thead><tr><th style={{ ...th, minWidth: 160 }}>Team</th>{dayCols}</tr></thead>
            <tbody>
              {groups.map(g => (
                <RotaGroup key={g.grp} g={g} wk={wk} roles={roles} shiftsFor={shiftsFor}
                  warnFor={(s, iso) => clashWarnings({ staffName: s.name, staffId: s.id, dateIso: iso, timeOff, availability: avail })}
                  onCell={(s, d, shift) => setEditing({ staff: s, day: d, shift })} />
              ))}

              {/* ── footer metric rows ── */}
              <tr><td colSpan={8} style={{ padding: '6px 0' }} /></tr>

              <FooterRow label="Forecast" tint="blu">
                {wk.days.map(d => (
                  <td key={d.iso} style={{ ...td, textAlign: 'center', borderTop: '1px solid var(--glass-border)' }}>
                    <input
                      defaultValue={forecast[d.iso] != null ? forecast[d.iso] : ''}
                      placeholder="–" inputMode="numeric"
                      onBlur={e => { const v = e.target.value.trim(); if (v !== '' && Number(v) !== forecast[d.iso]) saveForecastCell(d.iso, v); }}
                      className="mono"
                      style={{ width: 64, textAlign: 'center', background: 'transparent', border: '1px solid var(--bdr)', borderRadius: 8, padding: '4px 6px', fontSize: 12, color: 'var(--t1)', outline: 'none' }}
                    />
                  </td>
                ))}
              </FooterRow>

              <FooterRow label="Actual sales" tint="grey">
                {wk.days.map(d => (
                  <td key={d.iso} style={{ ...td, textAlign: 'center' }}>
                    <span className="mono" style={{ fontSize: 12, color: actual[d.iso] != null ? 'var(--t2)' : 'var(--t4)' }}>{actual[d.iso] != null ? money(actual[d.iso]) : '–'}</span>
                  </td>
                ))}
              </FooterRow>

              <FooterRow label="Scheduled wage" tint="amber">
                {wk.days.map(d => (
                  <td key={d.iso} style={{ ...td, textAlign: 'center' }}>
                    <span className="mono" style={{ fontSize: 12, color: wageByIso[d.iso] > 0 ? 'var(--t1)' : 'var(--t4)' }}>{wageByIso[d.iso] > 0 ? money(wageByIso[d.iso]) : '–'}</span>
                  </td>
                ))}
              </FooterRow>

              <FooterRow label="Actual wage" tint="amber">
                {wk.days.map(d => (
                  <td key={d.iso} style={{ ...td, textAlign: 'center' }}>
                    <span className="mono" style={{ fontSize: 12, color: actualWageByIso[d.iso] > 0 ? 'var(--t1)' : 'var(--t4)' }}>{actualWageByIso[d.iso] > 0 ? money(actualWageByIso[d.iso]) : '–'}</span>
                  </td>
                ))}
              </FooterRow>

              <FooterRow label="Labour % (plan)" tint="grey">
                {wk.days.map(d => {
                  const sales = forecast[d.iso] || actual[d.iso] || 0;
                  const wage = wageByIso[d.iso] || 0;
                  const pct = labourPct(wage, sales); const over = pct > targetPct;
                  return (
                    <td key={d.iso} style={{ ...td, textAlign: 'center' }}>
                      {sales > 0 && wage > 0 ? <Badge tone={over ? 'red' : 'green'}>{(pct * 100).toFixed(0)}%</Badge> : <span style={{ fontSize: 12, color: 'var(--t4)' }}>–</span>}
                    </td>
                  );
                })}
              </FooterRow>

              <FooterRow label="Labour % (actual)" tint="grey">
                {wk.days.map(d => {
                  const sales = actual[d.iso] || 0;
                  const wage = actualWageByIso[d.iso] || 0;
                  const pct = labourPct(wage, sales); const over = pct > targetPct;
                  return (
                    <td key={d.iso} style={{ ...td, textAlign: 'center' }}>
                      {sales > 0 && wage > 0 ? <Badge tone={over ? 'red' : 'green'}>{(pct * 100).toFixed(0)}%</Badge> : <span style={{ fontSize: 12, color: 'var(--t4)' }}>–</span>}
                    </td>
                  );
                })}
              </FooterRow>
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--t4)' }}>
          Labour target {(targetPct * 100).toFixed(0)}% · <b>Plan</b> = scheduled wage ÷ forecast (or actual) sales · <b>Actual</b> = timesheet wage ÷ actual POS sales.
        </div>
      </Card>

      {Modals}
    </>
  );
}

// ── group of staff rows under a section heading ───────────────────────────────
function RotaGroup({ g, wk, roles, shiftsFor, warnFor, onCell }) {
  const col = groupColor(g.grp);
  return (
    <>
      <tr>
        <td colSpan={8} style={{ padding: '10px 10px 4px', borderBottom: '1px solid var(--bdr)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: col }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: col }} />{g.label}
          </span>
        </td>
      </tr>
      {g.rows.map(s => (
        <tr key={s.id}>
          <td style={{ ...td, background: cellTint(col, 4) }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, background: cellTint(col, 18), color: col, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>{initials(s.name)}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</div>
                <RoleChip role={s.role} roles={roles.map} />
              </div>
            </div>
          </td>
          {wk.days.map(d => {
            const list = shiftsFor(s.id, d.iso);
            const warns = list.length ? (warnFor?.(s, d.iso) || []) : [];
            return (
              <td key={d.iso} style={{ ...td, textAlign: 'center', padding: 4, background: d.isToday ? cellTint('var(--acc)', 5) : 'transparent', verticalAlign: 'top' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {list.map(sh => (
                    <button
                      key={sh.id}
                      onClick={() => onCell(s, d, sh)}
                      title={`${sh.start}–${sh.finish} · ${money(sh.computedCost)}${warns.length ? `\n⚠ ${warns.join('\n⚠ ')}` : ''}`}
                      style={{ width: '100%', cursor: 'pointer', textAlign: 'center', borderRadius: 9, padding: '6px 4px', fontFamily: 'inherit', opacity: sh.status === 'no_show' ? 0.75 : 1, background: sh.status === 'published' ? cellTint(col, 16) : sh.status === 'no_show' ? 'rgba(255,90,74,.10)' : 'var(--inset)', border: `1px solid ${sh.status === 'no_show' ? 'rgba(255,90,74,.45)' : warns.length ? 'rgba(245,166,35,.45)' : sh.status === 'published' ? cellTint(col, 32) : 'var(--inset-border)'}` }}
                    >
                      <div className="mono" style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--t1)', textDecoration: sh.status === 'no_show' ? 'line-through' : 'none' }}>{warns.length ? '⚠ ' : ''}{sh.start}–{sh.finish}</div>
                      <div style={{ fontSize: 10, color: sh.status === 'no_show' ? 'var(--red)' : 'var(--t3)', marginTop: 1, fontWeight: sh.status === 'no_show' ? 700 : 400 }}>{sh.status === 'no_show' ? 'NO SHOW' : `${Number(sh.computedHours || 0).toFixed(1)}h${sh.status !== 'published' ? ' · draft' : ''}`}</div>
                    </button>
                  ))}
                  {/* add (another) shift — multiple per day = split shifts */}
                  <button onClick={() => onCell(s, d, null)} className="btn btn-ghost btn-xs"
                    title={list.length ? 'Add another shift (split shift)' : 'Add shift'}
                    style={list.length
                      ? { width: '100%', height: 18, padding: 0, borderRadius: 6, color: 'var(--t4)', fontSize: 10, lineHeight: 1 }
                      : { width: 30, height: 30, padding: 0, borderRadius: 8, color: 'var(--t4)', margin: '0 auto' }}>
                    <Icon name="plus" size={list.length ? 10 : 14} />
                  </button>
                </div>
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

// ── footer metric row shell ───────────────────────────────────────────────────
function FooterRow({ label, tint, children }) {
  return (
    <tr>
      <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--t3)' }}>{label}</td>
      {children}
    </tr>
  );
}
