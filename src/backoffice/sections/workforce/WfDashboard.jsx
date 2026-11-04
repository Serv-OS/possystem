// src/backoffice/sections/workforce/WfDashboard.jsx
//
// 5.12.59 (Peter, 4 Nov 2026, Mozz Provo: "the workforce dashboard seems basic"): Today at the site.
// Who is clocked in now, who is rostered, late or in without a shift, hours and planned wage cost
// against the plan, what is waiting for a decision, and the week ahead. Every figure is read from
// the rows Workforce already loads (shifts, timesheets, time off, onboarding, documents); the rules
// are pure and tested in lib/wfDashboardRules.js. The day and the clock are the venue's own
// (lib/venueDates.js): a US venue reads its own zone and a 12 hour clock, a UK venue as before.

import { useState, useEffect, useMemo } from 'react';
import { Card, Badge, EmptyState, RoleChip, LoadingCard, money, th, td } from '../../../staff/wfUi';
import { loadShifts, loadTimesheets, loadTimeOff, loadOnboarding, loadDocuments } from '../../../staff/wfData';
import { venueToday, timeText, dayText, zoneOr, clockParts, venueYmd, venueHhmm, workweekStartDow } from '../../../lib/venueDates';
import { isHeadOfficeStaff } from '../../../lib/headOffice';
import { dashboardFrom, weekOf, addDaysYmd, DOC_WARN_DAYS } from '../../../lib/wfDashboardRules';
import { weekRangeLabel } from '../../../staff/wfWeek';
import { activeCountry } from '../../../lib/regionPack';

const TICK_MS = 60 * 1000;          // the clock on screen moves every minute
const RELOAD_EVERY_TICKS = 2;       // the rows are read again every two minutes

const hrs = (h) => `${Math.round((Number(h) || 0) * 10) / 10}h`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

export default function WfDashboard({ ctx, staff = [], roles = {}, settings = {} }) {
  const locationId = ctx?.locationId || null;
  const locName = ctx?.locName || 'this site';
  const [now, setNow] = useState(() => new Date());
  const [tick, setTick] = useState(0);
  const [rows, setRows] = useState(null);     // { shifts, timesheets, timeOff, onboarding, docs }
  const [error, setError] = useState('');

  const tz = zoneOr(null);
  const todayIso = venueToday(tz, now);
  const startDow = workweekStartDow(settings?.settings);
  const week = useMemo(() => weekOf(todayIso, startDow), [todayIso, startDow]);

  useEffect(() => {
    const id = setInterval(() => { setNow(new Date()); setTick((t) => t + 1); }, TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Timesheets from the day before to the day after the venue day: a clock in is stored as an
  // instant, so a late evening at a US venue sits on the next UTC date, and an overnight shift
  // still clocked in started on the day before. The rules pick the venue day from each row.
  const reloadKey = Math.floor(tick / RELOAD_EVERY_TICKS);
  useEffect(() => {
    let alive = true;
    if (!locationId || !todayIso) return undefined;   // the screen says why above the rows
    const from = week.startIso < addDaysYmd(todayIso, -1) ? week.startIso : addDaysYmd(todayIso, -1);
    Promise.all([
      loadShifts(locationId, from, week.endIso),
      loadTimesheets(locationId, addDaysYmd(todayIso, -1), addDaysYmd(todayIso, 1)),
      loadTimeOff(locationId),
      loadOnboarding(locationId),
      loadDocuments(locationId),
    ]).then(([shifts, timesheets, timeOff, onboarding, docs]) => {
      if (!alive) return;
      setRows({
        shifts: shifts || [],
        timesheets: (timesheets || []).map((t) => ({ ...t, day: t.clockIn ? venueYmd(t.clockIn, tz) : '' })),
        timeOff: timeOff || [], onboarding: onboarding || [], docs: docs || [],
      });
      setError('');
    }).catch((e) => { if (alive) { setError(e?.message || 'The rows could not be read'); setRows((r) => r || { shifts: [], timesheets: [], timeOff: [], onboarding: [], docs: [] }); } });
    return () => { alive = false; };
  }, [locationId, todayIso, week.startIso, week.endIso, tz, reloadKey]);

  const headOfficeIds = useMemo(() => new Set((staff || []).filter((m) => isHeadOfficeStaff(m, settings)).map((m) => String(m.id))), [staff, settings]);
  const staffById = useMemo(() => { const o = {}; (staff || []).forEach((m) => { if (m?.id) o[String(m.id)] = m; }); return o; }, [staff]);
  const rolesMap = useMemo(() => roles?.map || {}, [roles]);

  const view = useMemo(() => {
    if (!rows) return null;
    const parts = clockParts(now, tz);
    return dashboardFrom({
      ...rows, staff, rolesMap, settings, todayIso, headOfficeIds, week,
      nowMins: parts ? parts.hh * 60 + parts.mm : NaN, nowMs: now.getTime(),
    });
  }, [rows, staff, rolesMap, settings, todayIso, headOfficeIds, week, now, tz]);

  if (!locationId) return <EmptyState icon="team" title="Pick a site" body="The Today dashboard reads one site at a time. Choose a venue in the switcher, bottom left." />;
  if (!todayIso) return <EmptyState icon="clock" title="No clock for this site yet" body="Set the venue's time zone in Location settings. Today's shifts and clock ins read on the venue's own clock, so the dashboard waits for it." />;
  if (!view) return <LoadingCard label={`Reading today at ${locName}…`} />;

  const nameOf = (id) => staffById[String(id)]?.name || 'Staff';
  const roleOf = (id, roleKey) => roleKey || staffById[String(id)]?.role || '';
  const clockNow = timeText(now, tz);
  const positionCount = (roles?.list || []).length;
  const w = view.waiting;
  const docWords = w.docs.rows.length === 0 ? 'none'
    : [w.docs.expired.length ? plural(w.docs.expired.length, 'expired') : '', w.docs.expiring.length ? `${w.docs.expiring.length} expiring within ${DOC_WARN_DAYS} days` : ''].filter(Boolean).join(', ');
  const waiting = [
    { k: 'Time off requests', n: w.timeOff, words: w.timeOff ? `${plural(w.timeOff, 'request')} waiting for a decision` : 'none', where: 'Time off & availability' },
    { k: 'Onboarding', n: w.onboarding, words: w.onboarding ? `${plural(w.onboarding, 'new starter')} still in progress` : 'none', where: 'Onboarding' },
    { k: 'Documents', n: w.docs.rows.length, words: docWords, where: 'Compliance' },
    { k: 'Open shifts', n: w.openShifts, words: w.openShifts ? `${plural(w.openShifts, 'shift')} this week with nobody on it yet` : 'none', where: 'Rota' },
  ];
  const tiles = [
    { k: 'On shift now', v: String(view.onNow.length), sub: view.onNow.length ? 'clocked in' : 'nobody clocked in', col: 'var(--grn)' },
    { k: 'Rostered today', v: String(view.rostered.length), sub: view.rostered.length ? `${hrs(view.plannedHoursToday)} planned` : 'no shifts today', col: 'var(--acc)' },
    { k: 'Hours so far', v: hrs(view.hoursSoFar), sub: view.plannedHoursToday ? `of ${hrs(view.plannedHoursToday)} planned` : 'nothing planned', col: 'var(--blu)' },
    { k: 'Planned wage cost', v: money(view.costToday), sub: view.rostered.length ? 'today, from the rota' : 'no shifts today', col: 'var(--amber)' },
  ];
  const needsLook = view.late.length + view.unrostered.length;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Today at {locName}</div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--t3)', letterSpacing: '.06em' }}>{dayText(todayIso, { weekday: true })}{clockNow ? ` · ${clockNow}` : ''}</div>
        {error && <div style={{ fontSize: 12, color: 'var(--amber)' }}>Some rows could not be read: {error}. Showing what was read.</div>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
        {tiles.map((s) => <Tile key={s.k} {...s} />)}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14, alignItems: 'start' }}>
        <Card>
          <Head>On shift now</Head>
          {view.onNow.length === 0
            ? <Muted>Nobody is clocked in right now.</Muted>
            : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={th}>Who</th><th style={th}>Position</th><th style={th}>Clocked in</th><th style={th}>On for</th></tr></thead>
                <tbody>
                  {view.onNow.map((t) => {
                    const onMins = Math.max(0, Math.round((now.getTime() - Date.parse(t.clockIn)) / 60000));
                    const sh = view.rostered.find((s) => String(s.staffId) === String(t.staffId));
                    return (
                      <tr key={t.id}>
                        <td style={td}><b>{nameOf(t.staffId)}</b></td>
                        <td style={td}><RoleChip role={roleOf(t.staffId, sh?.roleKey)} roles={rolesMap} /></td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{timeText(t.clockIn, tz)}{t.day && t.day !== todayIso ? <span style={{ color: 'var(--t3)' }}> ({dayText(t.day, { year: false })})</span> : null}</td>
                        <td style={td}>{onMins >= 60 ? `${Math.floor(onMins / 60)}h ${onMins % 60}m` : `${onMins}m`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
        </Card>

        <Card>
          <Head>{needsLook ? <>Needs a look <Badge tone={view.late.length ? 'red' : 'amber'}>{needsLook}</Badge></> : 'Needs a look'}</Head>
          {needsLook === 0 && <Muted>{view.rostered.length ? 'Everyone rostered so far is in, and nobody is in without a shift.' : 'No shifts rostered today, and nobody is in without one.'}</Muted>}
          {view.late.length > 0 && (
            <div style={{ marginBottom: view.unrostered.length ? 12 : 0 }}>
              <Sub>Late or no show</Sub>
              {view.late.map((s) => (
                <Row key={s.id}>
                  <b>{nameOf(s.staffId)}</b>
                  <RoleChip role={s.roleKey} roles={rolesMap} />
                  <span className="mono" style={{ color: 'var(--t3)' }}>due {venueHhmm(s.start)}</span>
                  <span style={{ flex: 1 }} />
                  <Badge tone="red">{s.lateMins >= 60 ? `${Math.floor(s.lateMins / 60)}h ${s.lateMins % 60}m` : `${s.lateMins} min`} late</Badge>
                </Row>
              ))}
            </div>
          )}
          {view.unrostered.length > 0 && (
            <div>
              <Sub>Not rostered but in</Sub>
              {view.unrostered.map((t) => (
                <Row key={t.id}>
                  <b>{nameOf(t.staffId)}</b>
                  <RoleChip role={roleOf(t.staffId)} roles={rolesMap} />
                  <span className="mono" style={{ color: 'var(--t3)' }}>in at {timeText(t.clockIn, tz)}</span>
                  <span style={{ flex: 1 }} />
                  <Badge tone="amber">no shift today</Badge>
                </Row>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <Head>Waiting for you</Head>
          {waiting.map((x) => (
            <Row key={x.k}>
              <span className="mono" style={{ fontSize: 16, fontWeight: 800, minWidth: 28, color: x.n ? 'var(--t1)' : 'var(--t3)' }}>{x.n}</span>
              <span style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{x.k}</div>
                <div style={{ fontSize: 12, color: 'var(--t3)' }}>{x.words}{x.n ? <> · in {x.where}</> : null}</div>
              </span>
            </Row>
          ))}
        </Card>

        <Card>
          <Head>This week <span className="mono" style={{ fontSize: 10, color: 'var(--t3)', fontWeight: 600, letterSpacing: '.06em' }}>{week.startIso ? weekRangeLabel(week, activeCountry()) : ''}</span></Head>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
            <Tile small k="Planned hours" v={hrs(view.week.hours)} sub={view.week.shifts ? plural(view.week.shifts, 'shift') : 'no shifts yet'} col="var(--acc)" />
            <Tile small k="Planned wage cost" v={money(view.week.cost)} sub={view.week.shifts ? 'from the rota' : 'nothing rostered'} col="var(--amber)" />
            <Tile small k="Staff" v={String(view.staffCount)} sub={view.staffCount === 0 ? 'Add your team' : 'on the books'} col="var(--t1)" />
            <Tile small k="Positions" v={String(positionCount)} sub={positionCount === 0 ? 'Add them in Positions and rates' : 'with their pay'} col="var(--acc)" />
          </div>
        </Card>
      </div>
    </div>
  );
}

function Tile({ k, v, sub, col, small = false }) {
  return (
    <Card style={{ position: 'relative', overflow: 'hidden', padding: small ? 12 : 18 }}>
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: col }} />
      <div className="mono" style={{ fontSize: small ? 9.5 : 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)' }}>{k}</div>
      <div className="mono" style={{ fontSize: small ? 20 : 28, fontWeight: 800, letterSpacing: '-.02em', marginTop: small ? 6 : 10, color: col }}>{v}</div>
      <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: small ? 4 : 6 }}>{sub}</div>
    </Card>
  );
}
function Head({ children }) {
  return <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--t3)', margin: '0 0 10px' }}>{children}</div>;
}
function Sub({ children }) {
  return <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)', margin: '2px 0 4px' }}>{children}</div>;
}
function Muted({ children }) {
  return <div style={{ fontSize: 13, color: 'var(--t3)', padding: '4px 0' }}>{children}</div>;
}
function Row({ children }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--bdr)', fontSize: 13 }}>{children}</div>;
}
