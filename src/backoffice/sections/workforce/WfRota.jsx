// src/backoffice/sections/workforce/WfRota.jsx
//
// THE ROTA — the spine of Workforce. A weekly grid of staff (grouped by their
// role's section) × the 7 days of the week. Cells hold shifts; footer rows hold
// forecast / actual sales / wage cost / labour %. Publish pushes draft shifts
// live. A "By section" view checks coverage against minCoverage.

import { useState, useEffect, useMemo } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { Card, EmptyState, Badge, RoleChip, money, th, td, inputStyle, labelStyle, groupColor, cellTint, GRP_SECTION, initials, LoadingCard } from '../../../staff/wfUi';
import * as wf from '../../../staff/wfData';
import { buildWeek, addWeeks, weekRangeLabel, ymd } from '../../../staff/wfWeek';
import { hoursOf, resolveRate, labourPct } from '../../../staff/labour';

const GRP_ORDER = ['mgmt', 'bar', 'floor', 'kitchen', 'door'];

// ── shift clash detection ────────────────────────────────────────────────────
// Split shifts are allowed (several per day) but must NOT overlap. Touching
// endpoints (…–17:00 then 17:00–…) are fine. Overnight finishes roll past
// midnight for the comparison.
const toMins = hhmm => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const spanOf = (start, finish) => { const s = toMins(start); let f = toMins(finish); if (f <= s) f += 24 * 60; return [s, f]; };
function findClash(list, staffId, dateIso, start, finish, ignoreId) {
  const [s1, f1] = spanOf(start, finish);
  return (list || []).find(x => {
    if (x.staffId !== staffId || x.date !== dateIso || x.id === ignoreId) return false;
    const [s2, f2] = spanOf(x.start, x.finish);
    return s1 < f2 && s2 < f1;
  });
}

// ── Shift editor modal ──────────────────────────────────────────────────────
function ShiftModal({ staff, day, shift, sections, onSave, onDelete, onClose, saving }) {
  const [start, setStart] = useState(shift?.start || '09:00');
  const [finish, setFinish] = useState(shift?.finish || '17:00');
  const [breakMins, setBreakMins] = useState(shift?.breakMins ?? 30);
  const [sectionId, setSectionId] = useState(shift?.sectionId || sections[0]?.id || '');
  const hrs = useMemo(() => Math.max(0, hoursOf(start, finish) - (Number(breakMins) || 0) / 60), [start, finish, breakMins]);

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 420 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{shift ? 'Edit shift' : 'Add shift'}</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>{staff.name} · {day.label} {day.dom}</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><Icon name="close" size={14} /></button>
        </div>
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
        <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: shift ? 'space-between' : 'flex-end' }}>
          {shift && <button className="btn btn-ghost btn-sm" disabled={saving} onClick={() => onDelete(shift)} style={{ color: 'var(--red)' }}><Icon name="close" size={13} /> Delete</button>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-acc btn-sm" disabled={saving} onClick={() => onSave({ start, finish, breakMins: Number(breakMins) || 0, sectionId, section: sections.find(s => s.id === sectionId)?.name || null })}>
              <Icon name="check" size={13} /> {saving ? 'Saving…' : 'Save shift'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main section ─────────────────────────────────────────────────────────────
export default function WfRota({ ctx, staff, roles, sections, settings, week, showToast }) {
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

  const targetPct = settings?.labourTargetPct ?? 0.3;

  async function reload(w) {
    setLoading(true);
    try {
      const [sh, fc, ac, sc, ts] = await Promise.all([
        wf.loadShifts(ctx.locationId, w.startIso, w.endIso),
        wf.loadForecast(ctx.locationId, w.startIso, w.endIso),
        wf.loadActualSales(ctx.locationId, w.startIso, w.endIso),
        wf.loadSections(ctx.locationId),
        wf.loadTimesheets(ctx.locationId),
      ]);
      setShifts(sh || []);
      setForecast(fc || {});
      setActual(ac || {});
      if (sc) setSecs(sc);
      setTimesheets(ts || []);
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

  const draftIds = useMemo(() => shifts.filter(s => s.status !== 'published').map(s => s.id), [shifts]);

  // ── handlers ────────────────────────────────────────────────────────────
  async function saveShift(payload) {
    const { staff: s, day, shift } = editing;
    // No clashing shifts: a person can work split shifts, but the times must
    // not overlap an existing shift that day (editing a shift ignores itself).
    const clash = findClash(shifts, s.id, day.iso, payload.start, payload.finish, shift?.id);
    if (clash) {
      showToast(`Clashes with their ${clash.start}–${clash.finish} shift on ${day.label} — change the times, or edit that shift instead`, 'error');
      return;
    }
    const role = roles.map[s.role];
    const { rate, source } = resolveRate(s, role);
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

  async function saveForecastCell(iso, raw) {
    const amt = Number(raw);
    if (!Number.isFinite(amt)) return;
    setForecast(prev => ({ ...prev, [iso]: amt }));
    try {
      await wf.saveForecast(iso, amt, ctx.locationId, ctx.orgId);
    } catch (e) {
      showToast('Forecast not saved: ' + e.message, 'error');
      reload(wk);
    }
  }

  async function publish() {
    if (!draftIds.length) { showToast('No draft shifts to publish', 'info'); return; }
    setPublishing(true);
    try {
      await wf.publishShifts(draftIds);
      await wf.logAudit({ action: 'rota.publish', entity: 'wf_shifts', entityId: wk.startIso, reason: `Published ${draftIds.length} shift(s) for ${weekRangeLabel(wk)}`, after: { ids: draftIds, week: wk.startIso } }, ctx.locationId, ctx.orgId);
      setShifts(prev => prev.map(s => draftIds.includes(s.id) ? { ...s, status: 'published' } : s));

      // Notify each affected staff member of their week's shifts — by SMS AND
      // email (whichever contact details are on file), so no-one is missed.
      const affected = new Set(shifts.filter(s => draftIds.includes(s.id)).map(s => s.staffId));
      const published = shifts.map(s => draftIds.includes(s.id) ? { ...s, status: 'published' } : s).filter(s => s.status === 'published');
      const dayLabel = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      const nameOf = id => (staff.find(s => s.id === id) || {});
      let notified = 0, noContact = 0, failed = 0;
      for (const sid of affected) {
        const member = nameOf(sid);
        const mine = published.filter(x => x.staffId === sid).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
        if (!mine.length) continue;
        const first = (member.name || 'there').split(' ')[0];
        const lines = mine.map(x => `${dayLabel(x.date)} ${x.start}–${x.finish}${x.section ? ` (${x.section})` : ''}`);
        const smsMsg = `Hi ${first}, your rota for w/c ${weekRangeLabel(wk)}:\n${lines.join('\n')}`;
        const emailHtml = `<div style="font-family:system-ui,sans-serif;max-width:560px"><p>Hi ${first},</p><p>Your shifts for the week commencing <strong>${weekRangeLabel(wk)}</strong>${ctx.locName ? ` at ${ctx.locName}` : ''}:</p><ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul><p>See you then!</p></div>`;
        let any = false, fail = false;
        if (member.mobile) {
          try { const r = await wf.sendStaffSms(member.mobile, smsMsg, ctx.locationId, 'rota_notification', wk.startIso); if (r?.ok) any = true; else fail = true; } catch { fail = true; }
        }
        if (member.email) {
          try { await wf.sendEmail(member.email, `Your rota — w/c ${weekRangeLabel(wk)}`, emailHtml, ctx.locationId); any = true; } catch { fail = true; }
        }
        if (any) notified++;
        else if (!member.mobile && !member.email) noContact++;
        else failed++;
      }
      const bits = [];
      if (notified) bits.push(`notified ${notified}`);
      if (failed) bits.push(`${failed} failed`);
      if (noContact) bits.push(`${noContact} no contact details`);
      const tail = bits.length ? ` · ${bits.join(', ')}` : '';
      showToast(`Published ${draftIds.length} shift${draftIds.length === 1 ? '' : 's'}${tail}`, 'success');
    } catch (e) {
      showToast('Publish failed: ' + e.message, 'error');
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
        const { rate } = resolveRate(s, role);
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
      let added = 0, skippedClash = 0;
      for (const p of proposed) {
        if (!valid.has(p.staffId) || !weekDates.has(p.date) || !p.start || !p.finish) continue;
        if (findClash(working, p.staffId, p.date, p.start, p.finish)) { skippedClash++; continue; }
        const s = staff.find(x => x.id === p.staffId);
        const role = roles.map[s.role];
        const { rate, source } = resolveRate(s, role);
        const breakMins = Number(p.breakMins) || 0;
        const hours = Math.max(0, hoursOf(p.start, p.finish) - breakMins / 60);
        const shift = {
          staffId: s.id, roleKey: s.role, date: p.date, start: p.start, finish: p.finish, breakMins,
          section: p.section || (GRP_SECTION[role?.grp] || null), status: 'draft',
          effectiveRate: rate, rateSource: source,
          computedHours: Math.round(hours * 100) / 100, computedCost: Math.round(hours * rate * 100) / 100,
        };
        try { const saved = await wf.saveShift(shift, ctx.locationId, ctx.orgId); setShifts(prev => [...prev.filter(x => x.id !== saved.id), saved]); working.push(saved); added++; } catch { /* skip bad row */ }
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

  // ── By section view ────────────────────────────────────────────────────────
  if (view === 'section') {
    return (
      <Card>
        {Header}
        {secs.length === 0
          ? <EmptyState icon="floor" title="No sections yet" body="Create sections (Bar, Floor, Kitchen…) in Settings to track coverage per area. Then assign each shift to a section and we'll flag any day that's understaffed." />
          : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead><tr><th style={th}>Section</th>{dayCols}</tr></thead>
                <tbody>
                  {secs.map(sec => (
                    <tr key={sec.id}>
                      <td style={td}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 600 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: sec.color || 'var(--t3)' }} />{sec.name}</span></td>
                      {wk.days.map(d => {
                        const count = shifts.filter(s => s.date === d.iso && s.sectionId === sec.id).length;
                        const under = sec.minCoverage > 0 && count < sec.minCoverage;
                        return (
                          <td key={d.iso} style={{ ...td, textAlign: 'center', background: under ? cellTint('var(--red)', 9) : 'transparent' }}>
                            <span className="mono" style={{ fontWeight: 700, color: under ? 'var(--red)' : 'var(--t1)' }}>{count}</span>
                            {sec.minCoverage > 0 && <span style={{ fontSize: 10.5, color: 'var(--t4)' }}> /{sec.minCoverage}</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
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
                <RotaGroup key={g.grp} g={g} wk={wk} roles={roles} shiftsFor={shiftsFor} onCell={(s, d, shift) => setEditing({ staff: s, day: d, shift })} />
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

      {editing && (
        <ShiftModal
          staff={editing.staff} day={editing.day} shift={editing.shift}
          sections={secs} saving={saving}
          onSave={saveShift} onDelete={removeShift} onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

// ── group of staff rows under a section heading ───────────────────────────────
function RotaGroup({ g, wk, roles, shiftsFor, onCell }) {
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
            return (
              <td key={d.iso} style={{ ...td, textAlign: 'center', padding: 4, background: d.isToday ? cellTint('var(--acc)', 5) : 'transparent', verticalAlign: 'top' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {list.map(sh => (
                    <button
                      key={sh.id}
                      onClick={() => onCell(s, d, sh)}
                      title={`${sh.start}–${sh.finish} · ${money(sh.computedCost)}`}
                      style={{ width: '100%', cursor: 'pointer', textAlign: 'center', borderRadius: 9, padding: '6px 4px', fontFamily: 'inherit', background: sh.status === 'published' ? cellTint(col, 16) : 'var(--inset)', border: `1px solid ${sh.status === 'published' ? cellTint(col, 32) : 'var(--inset-border)'}` }}
                    >
                      <div className="mono" style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--t1)' }}>{sh.start}–{sh.finish}</div>
                      <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 1 }}>{Number(sh.computedHours || 0).toFixed(1)}h{sh.status !== 'published' ? ' · draft' : ''}</div>
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
