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
import { buildWeek, addWeeks, weekRangeLabel } from '../../../staff/wfWeek';
import { hoursOf, resolveRate, labourPct } from '../../../staff/labour';

const GRP_ORDER = ['mgmt', 'bar', 'floor', 'kitchen', 'door'];

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
  const [view, setView] = useState('staff');       // 'staff' | 'section'

  const targetPct = settings?.labourTargetPct ?? 0.3;

  async function reload(w) {
    setLoading(true);
    try {
      const [sh, fc, ac] = await Promise.all([
        wf.loadShifts(ctx.locationId, w.startIso, w.endIso),
        wf.loadForecast(ctx.locationId, w.startIso, w.endIso),
        wf.loadActualSales(ctx.locationId, w.startIso, w.endIso),
      ]);
      setShifts(sh || []);
      setForecast(fc || {});
      setActual(ac || {});
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

  const shiftFor = (staffId, iso) => shifts.find(s => s.staffId === staffId && s.date === iso);

  // per-day wage from computedCost
  const wageByIso = useMemo(() => {
    const m = {};
    wk.days.forEach(d => { m[d.iso] = 0; });
    shifts.forEach(s => { if (m[s.date] != null) m[s.date] += Number(s.computedCost || 0); });
    return m;
  }, [shifts, wk]);

  const draftIds = useMemo(() => shifts.filter(s => s.status !== 'published').map(s => s.id), [shifts]);

  // ── handlers ────────────────────────────────────────────────────────────
  async function saveShift(payload) {
    const { staff: s, day, shift } = editing;
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

      // Notify each affected staff member their week's shifts by SMS.
      const affected = new Set(shifts.filter(s => draftIds.includes(s.id)).map(s => s.staffId));
      const published = shifts.map(s => draftIds.includes(s.id) ? { ...s, status: 'published' } : s).filter(s => s.status === 'published');
      const dayLabel = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      const nameOf = id => (staff.find(s => s.id === id) || {});
      let sent = 0, skipped = 0;
      for (const sid of affected) {
        const member = nameOf(sid);
        const mine = published.filter(x => x.staffId === sid).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
        if (!mine.length) continue;
        if (!member.mobile) { skipped++; continue; }
        const lines = mine.map(x => `${dayLabel(x.date)} ${x.start}–${x.finish}${x.section ? ` (${x.section})` : ''}`).join('\n');
        const first = (member.name || '').split(' ')[0];
        const msg = `Hi ${first}, your rota for w/c ${weekRangeLabel(wk)}:\n${lines}`;
        try { await wf.sendStaffSms(member.mobile, msg, ctx.locationId, 'rota_notification', wk.startIso); sent++; }
        catch { skipped++; }
      }
      const tail = sent || skipped ? ` · texted ${sent}${skipped ? `, ${skipped} skipped (no mobile)` : ''}` : '';
      showToast(`Published ${draftIds.length} shift${draftIds.length === 1 ? '' : 's'}${tail}`, 'success');
    } catch (e) {
      showToast('Publish failed: ' + e.message, 'error');
      reload(wk);
    } finally { setPublishing(false); }
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
        {sections.length === 0
          ? <EmptyState icon="floor" title="No sections yet" body="Create sections (Bar, Floor, Kitchen…) in Settings to track coverage per area. Then assign each shift to a section and we'll flag any day that's understaffed." />
          : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead><tr><th style={th}>Section</th>{dayCols}</tr></thead>
                <tbody>
                  {sections.map(sec => (
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
                <RotaGroup key={g.grp} g={g} wk={wk} roles={roles} shiftFor={shiftFor} onCell={(s, d, shift) => setEditing({ staff: s, day: d, shift })} />
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

              <FooterRow label="Wage cost" tint="amber">
                {wk.days.map(d => (
                  <td key={d.iso} style={{ ...td, textAlign: 'center' }}>
                    <span className="mono" style={{ fontSize: 12, color: wageByIso[d.iso] > 0 ? 'var(--t1)' : 'var(--t4)' }}>{wageByIso[d.iso] > 0 ? money(wageByIso[d.iso]) : '–'}</span>
                  </td>
                ))}
              </FooterRow>

              <FooterRow label="Labour %" tint="grey">
                {wk.days.map(d => {
                  const sales = forecast[d.iso] || actual[d.iso] || 0;
                  const wage = wageByIso[d.iso] || 0;
                  const pct = labourPct(wage, sales);
                  const over = pct > targetPct;
                  return (
                    <td key={d.iso} style={{ ...td, textAlign: 'center' }}>
                      {sales > 0 && wage > 0
                        ? <Badge tone={over ? 'red' : 'green'}>{(pct * 100).toFixed(0)}%</Badge>
                        : <span style={{ fontSize: 12, color: 'var(--t4)' }}>–</span>}
                    </td>
                  );
                })}
              </FooterRow>
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--t4)' }}>
          Labour target {(targetPct * 100).toFixed(0)}% · labour % uses forecast where set, else actual sales.
        </div>
      </Card>

      {editing && (
        <ShiftModal
          staff={editing.staff} day={editing.day} shift={editing.shift}
          sections={sections} saving={saving}
          onSave={saveShift} onDelete={removeShift} onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

// ── group of staff rows under a section heading ───────────────────────────────
function RotaGroup({ g, wk, roles, shiftFor, onCell }) {
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
            const sh = shiftFor(s.id, d.iso);
            return (
              <td key={d.iso} style={{ ...td, textAlign: 'center', padding: 4, background: d.isToday ? cellTint('var(--acc)', 5) : 'transparent' }}>
                {sh ? (
                  <button
                    onClick={() => onCell(s, d, sh)}
                    title={`${sh.start}–${sh.finish} · ${money(sh.computedCost)}`}
                    style={{ width: '100%', cursor: 'pointer', textAlign: 'center', borderRadius: 9, padding: '6px 4px', fontFamily: 'inherit', background: sh.status === 'published' ? cellTint(col, 16) : 'var(--inset)', border: `1px solid ${sh.status === 'published' ? cellTint(col, 32) : 'var(--inset-border)'}` }}
                  >
                    <div className="mono" style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--t1)' }}>{sh.start}–{sh.finish}</div>
                    <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 1 }}>{Number(sh.computedHours || 0).toFixed(1)}h{sh.status !== 'published' ? ' · draft' : ''}</div>
                  </button>
                ) : (
                  <button onClick={() => onCell(s, d, null)} className="btn btn-ghost btn-xs" style={{ width: 30, height: 30, padding: 0, borderRadius: 8, color: 'var(--t4)' }}>
                    <Icon name="plus" size={14} />
                  </button>
                )}
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
