// src/backoffice/sections/workforce/WfSettings.jsx
//
// Workforce → SETTINGS. Three cards:
//   (1) VENUE   — labour target %, holiday accrual rate %, currency, sales source.
//   (2) SECTIONS— add / edit / delete service sections (name, colour, min coverage).
//   (3) ROLES   — pointer to the rate card, which lives under Pay & rates.
// Percentages are shown as whole numbers but stored as 0..1 fractions.

import { useState, useEffect } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { Card, EmptyState, th, td, inputStyle, labelStyle, LoadingCard } from '../../../staff/wfUi';
import * as wf from '../../../staff/wfData';
import { payPeriod, shiftPayPeriod } from '../../../staff/wfWeek';

// Live "what you'll get" line under the pay-period fields — current period,
// the next one, and the computed pay day, straight from the same function
// "Run payroll" uses, so what you see here is exactly what payroll runs on.
function PayPeriodPreview({ payType, payStartDay, payAnchor, payDayDom, payDayOffset, payDayMonthOffset, payDayShift }) {
  const fixed = payType !== 'monthly';
  if (fixed && !payAnchor) return <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 10 }}>Set the first period start date to see the schedule.</div>;
  const cfg = {
    payPeriodType: payType,
    payPeriodStartDay: parseInt(payStartDay, 10) || 1,
    payPeriodAnchor: fixed ? payAnchor : null,
    payDay: fixed ? (payDayOffset === '' ? null : parseInt(payDayOffset, 10) || 0)
      : (payDayDom === '' ? null : parseInt(payDayDom, 10) || 0),
    payDayMonthOffset: parseInt(payDayMonthOffset, 10) || 0,
    payDayShift: payDayShift || 'none',
  };
  let cur, next;
  try { cur = payPeriod(cfg); next = shiftPayPeriod(cfg, cur.startIso, 1); } catch { return null; }
  const fmt = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return (
    <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 10, lineHeight: 1.7 }}>
      <span style={{ fontWeight: 700, color: 'var(--t2)' }}>Current period:</span> {cur.label} · paid <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{fmt(cur.payDateIso)}</span>
      <br /><span style={{ fontWeight: 700, color: 'var(--t2)' }}>Next:</span> {next.label} · paid <span style={{ fontFamily: 'var(--font-mono)' }}>{fmt(next.payDateIso)}</span>
    </div>
  );
}

const CURRENCIES = [
  { v: 'GBP', lbl: 'GBP — British Pound (£)' },
  { v: 'EUR', lbl: 'EUR — Euro (€)' },
  { v: 'USD', lbl: 'USD — US Dollar ($)' },
];
const SALES_SOURCES = [
  { v: 'pos', lbl: 'POS — live till takings' },
  { v: 'manual', lbl: 'Manual — entered by managers' },
];
const SECTION_COLOURS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];

const pct = frac => Math.round(Number(frac || 0) * 1000) / 10; // fraction -> whole-ish %

export default function WfSettings({ ctx, staff, roles, sections, settings, week, showToast, onSettingsSaved }) {
  const [loading, setLoading] = useState(true);
  const [secList, setSecList] = useState(sections || []);
  const [editing, setEditing] = useState(null); // section being added/edited

  // Venue form fields (whole-number percentages for the inputs)
  const [labourTarget, setLabourTarget] = useState('');
  const [accrualRate, setAccrualRate] = useState('');
  const [currency, setCurrency] = useState('GBP');
  const [salesSource, setSalesSource] = useState('pos');
  const [payStartDay, setPayStartDay] = useState('1');
  const [payType, setPayType] = useState('monthly');
  const [payAnchor, setPayAnchor] = useState('');       // fixed-length: first period start (date)
  const [payDayDom, setPayDayDom] = useState('');       // monthly: day-of-month paid (0 = last day)
  const [payDayOffset, setPayDayOffset] = useState(''); // fixed-length: days after period end
  // v5.5.989 — pay DATE policy. The day-of-month resolves in the month the
  // period ENDS; this offset pushes it a further whole month on, and the shift
  // implements the "paid on the last working day" ask.
  const [payDayMonthOffset, setPayDayMonthOffset] = useState('0');
  const [payDayShift, setPayDayShift] = useState('none');
  const [paidBreaks, setPaidBreaks] = useState(false);  // venue policy: breaks paid by default
  // v5.5.969 break policy: venue default break length + auto-deduct when no
  // break was punched (customer ask: "30 min unpaid as standard, automatic").
  const [defaultBreakMins, setDefaultBreakMins] = useState('30');
  const [autoBreak, setAutoBreak] = useState(false);
  const [autoBreakHours, setAutoBreakHours] = useState('6');
  // Tipping policy (Employment (Allocation of Tips) Act 2023): how card tips
  // are distributed + who decides allocation (drives NIC treatment).
  const [tipMode, setTipMode] = useState('pool');           // pool | direct | hybrid
  const [directPct, setDirectPct] = useState('50');         // hybrid: % the seller keeps
  const [tipAllocator, setTipAllocator] = useState('employer'); // employer | troncmaster
  const [troncmasterName, setTroncmasterName] = useState('');
  const [savingVenue, setSavingVenue] = useState(false);

  // Seed venue form from props.settings
  useEffect(() => {
    setLabourTarget(String(pct(settings?.labourTargetPct ?? 0.28)));
    setAccrualRate(String(pct(settings?.accrualRate ?? 0.1207)));
    setCurrency(settings?.currency || 'GBP');
    setSalesSource(settings?.salesSource || 'pos');
    setPayStartDay(String(settings?.payPeriodStartDay ?? 1));
    setPayType(settings?.payPeriodType || 'monthly');
    setPayAnchor(settings?.payPeriodAnchor || '');
    const fixed = ['weekly', 'fortnightly', 'fourweekly'].includes(settings?.payPeriodType);
    setPayDayDom(!fixed && settings?.payDay != null ? String(settings.payDay) : '');
    setPayDayOffset(fixed && settings?.payDay != null ? String(settings.payDay) : '');
    setPayDayMonthOffset(String(settings?.settings?.payDayMonthOffset ?? 0));
    setPayDayShift(settings?.settings?.payDayShift === 'prevWorkingDay' ? 'prevWorkingDay' : 'none');
    setPaidBreaks(!!settings?.settings?.paidBreaks);
    setDefaultBreakMins(String(settings?.settings?.defaultBreakMins ?? 30));
    setAutoBreak(!!settings?.settings?.autoBreak);
    setAutoBreakHours(String(settings?.settings?.autoBreakHours ?? 6));
    const sj = settings?.settings || {};
    setTipMode(['pool', 'direct', 'hybrid'].includes(sj.tipMode) ? sj.tipMode : 'pool');
    setDirectPct(sj.directPct != null ? String(sj.directPct) : '50');
    setTipAllocator(sj.tipAllocator === 'troncmaster' ? 'troncmaster' : 'employer');
    setTroncmasterName(sj.troncmasterName || '');
  }, [settings]);

  // Sections: seed from props, reload fresh on mount / location change
  useEffect(() => {
    let alive = true;
    setLoading(true);
    wf.loadSections(ctx.locationId)
      .then(rows => { if (alive && rows && rows.length) setSecList(rows); })
      .catch(e => showToast(e.message || 'Could not load sections', 'error'))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.locationId]);

  async function reloadSections() {
    try {
      const rows = await wf.loadSections(ctx.locationId);
      setSecList(rows || []);
    } catch (e) {
      showToast(e.message || 'Could not reload sections', 'error');
    }
  }

  async function saveVenue() {
    const lt = Number(labourTarget);
    const ac = Number(accrualRate);
    if (!Number.isFinite(lt) || lt < 0 || lt > 100) { showToast('Labour target must be between 0 and 100%', 'error'); return; }
    if (!Number.isFinite(ac) || ac < 0 || ac > 100) { showToast('Accrual rate must be between 0 and 100%', 'error'); return; }
    const psd = Math.min(28, Math.max(1, parseInt(payStartDay, 10) || 1));
    const fixed = payType !== 'monthly';
    if (fixed && !payAnchor) { showToast('Set the first period start date for a weekly/fortnightly pay period', 'error'); return; }
    setSavingVenue(true);
    const patch = {
      currency,
      salesSource,
      labourTargetPct: lt / 100,
      accrualRate: ac / 100,
      payPeriodType: payType,
      payPeriodStartDay: psd,
      payPeriodAnchor: fixed ? payAnchor : null,
      payDay: fixed
        ? (payDayOffset === '' ? null : Math.max(0, parseInt(payDayOffset, 10) || 0))
        : (payDayDom === '' ? null : Math.min(28, Math.max(0, parseInt(payDayDom, 10) || 0))),
      premiums: settings?.premiums || {},
      settings: {
        ...(settings?.settings || {}),
        // Pay DATE policy. Lives here rather than in its own column — same home
        // as the other venue policy knobs (COGS%, overhead, break policy).
        payDayMonthOffset: Math.min(1, Math.max(0, parseInt(payDayMonthOffset, 10) || 0)),
        payDayShift: payDayShift === 'prevWorkingDay' ? 'prevWorkingDay' : 'none',
        paidBreaks,
        // Break policy — the default is clamped 0–120; the auto-deduct floor to
        // the STATUTORY minimum happens at clock-out (workforce-clock), so a
        // venue can never configure itself below UK law on a triggering shift.
        defaultBreakMins: Math.min(120, Math.max(0, parseInt(defaultBreakMins, 10) || 0)),
        autoBreak,
        autoBreakHours: Math.min(13, Math.max(1, Number(autoBreakHours) || 6)),
        tipMode,
        directPct: Math.min(100, Math.max(0, parseInt(directPct, 10) || 0)),
        tipAllocator,
        troncmasterName: troncmasterName.trim() || null,
      },
    };
    try {
      const saved = await wf.saveSettings(patch, ctx.locationId, ctx.orgId);
      onSettingsSaved?.(saved || patch);
      showToast('Venue settings saved', 'success');
    } catch (e) {
      showToast(e.message || 'Could not save venue settings', 'error');
    } finally {
      setSavingVenue(false);
    }
  }

  async function saveSection(sec) {
    const isNew = !sec.id;
    // optimistic
    setSecList(prev => {
      if (isNew) return [...prev, { ...sec, id: 'tmp-' + Date.now() }];
      return prev.map(s => (s.id === sec.id ? { ...s, ...sec } : s));
    });
    setEditing(null);
    try {
      await wf.saveSection(sec, ctx.locationId, ctx.orgId);
      showToast(isNew ? 'Section added' : 'Section saved', 'success');
      await reloadSections();
    } catch (e) {
      showToast(e.message || 'Could not save section', 'error');
      await reloadSections();
    }
  }

  async function removeSection(sec) {
    setSecList(prev => prev.filter(s => s.id !== sec.id));
    try {
      await wf.deleteSection(sec.id);
      showToast('Section removed', 'success');
    } catch (e) {
      showToast(e.message || 'Could not remove section', 'error');
      await reloadSections();
    }
  }

  const roleCount = roles?.list?.length || 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ───────────── VENUE ───────────── */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
          <Icon name="status" size={15} /> Venue
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.6, maxWidth: 520, marginBottom: 16 }}>
          The labour target drives the rota’s cost-vs-sales gauge. Holiday accrues at the statutory UK rate of 12.07% by default. Currency and sales source affect how takings appear across Workforce.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
          <div>
            <label style={labelStyle}>Labour target %</label>
            <input
              style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
              type="number" min="0" max="100" step="0.1" inputMode="decimal"
              value={labourTarget} onChange={e => setLabourTarget(e.target.value)} disabled={savingVenue}
            />
          </div>
          <div>
            <label style={labelStyle}>Holiday accrual rate %</label>
            <input
              style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
              type="number" min="0" max="100" step="0.01" inputMode="decimal"
              value={accrualRate} onChange={e => setAccrualRate(e.target.value)} disabled={savingVenue}
            />
          </div>
          <div>
            <label style={labelStyle}>Currency</label>
            <select style={inputStyle} value={currency} onChange={e => setCurrency(e.target.value)} disabled={savingVenue}>
              {CURRENCIES.map(c => <option key={c.v} value={c.v}>{c.lbl}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Sales source</label>
            <select style={inputStyle} value={salesSource} onChange={e => setSalesSource(e.target.value)} disabled={savingVenue}>
              {SALES_SOURCES.map(s => <option key={s.v} value={s.v}>{s.lbl}</option>)}
            </select>
          </div>
        </div>

        {/* ── Pay period — type + anchor + pay day; locks "Run payroll" to these dates ── */}
        <div style={{ marginTop: 18, padding: '14px 16px', borderRadius: 12, background: 'var(--inset)', border: '1px solid var(--inset-border)' }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 10 }}>Pay period</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
            <div>
              <label style={labelStyle}>Frequency</label>
              <select style={inputStyle} value={payType} onChange={e => setPayType(e.target.value)} disabled={savingVenue}>
                <option value="monthly">Monthly</option>
                <option value="weekly">Weekly</option>
                <option value="fortnightly">Fortnightly (2 weeks)</option>
                <option value="fourweekly">Every 4 weeks</option>
              </select>
            </div>
            {payType === 'monthly' ? (<>
              <div>
                <label style={labelStyle}>Starts on day</label>
                <input style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }} type="number" min="1" max="28" step="1" inputMode="numeric"
                  value={payStartDay} onChange={e => setPayStartDay(e.target.value)} disabled={savingVenue} />
                <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 5 }}>e.g. 26 → periods run 26th–25th.</div>
              </div>
              <div>
                <label style={labelStyle}>Pay day (day of month)</label>
                <input style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }} type="number" min="0" max="28" step="1" inputMode="numeric" placeholder="—"
                  value={payDayDom} onChange={e => setPayDayDom(e.target.value)} disabled={savingVenue} />
                <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 5 }}>0 = last day of the month.</div>
              </div>
            </>) : (<>
              <div>
                <label style={labelStyle}>First period starts</label>
                <input style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }} type="date"
                  value={payAnchor} onChange={e => setPayAnchor(e.target.value)} disabled={savingVenue} />
                <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 5 }}>All later periods roll on from this date.</div>
              </div>
              <div>
                <label style={labelStyle}>Paid (days after period ends)</label>
                <input style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }} type="number" min="0" max="28" step="1" inputMode="numeric" placeholder="0"
                  value={payDayOffset} onChange={e => setPayDayOffset(e.target.value)} disabled={savingVenue} />
                <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 5 }}>0 = paid on the period’s last day.</div>
              </div>
            </>)}
            {payType === 'monthly' && (
              <div>
                <label style={labelStyle}>Paid in</label>
                <select style={inputStyle} value={payDayMonthOffset} onChange={e => setPayDayMonthOffset(e.target.value)} disabled={savingVenue}>
                  <option value="0">The month the period ends</option>
                  <option value="1">The month after it ends</option>
                </select>
                <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 5 }}>A 23rd–22nd period ends in the following month, so that is its pay run.</div>
              </div>
            )}
            <div>
              <label style={labelStyle}>If the pay day is not a working day</label>
              <select style={inputStyle} value={payDayShift} onChange={e => setPayDayShift(e.target.value)} disabled={savingVenue}>
                <option value="none">Leave it (pay on the date)</option>
                <option value="prevWorkingDay">Pay on the previous working day</option>
              </select>
              <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 5 }}>Skips weekends and <b>England &amp; Wales</b> bank holidays. Scotland and Northern Ireland differ.</div>
            </div>
          </div>
          <PayPeriodPreview payType={payType} payStartDay={payStartDay} payAnchor={payAnchor} payDayDom={payDayDom} payDayOffset={payDayOffset} payDayMonthOffset={payDayMonthOffset} payDayShift={payDayShift} />
        </div>

        {/* ── Tipping policy (Employment (Allocation of Tips) Act 2023) ──
              Pooling is NOT mandatory under the Act — "customer intention" is a
              recognised fairness factor, so direct/keep-your-own is lawful.
              The allocator drives NIC treatment (HMRC E24): employer-allocated
              tips attract NICs; an independent troncmaster's allocation is
              NIC-free. Either way: 100% pass-through, paid by the end of the
              month after the customer tipped, written policy + 3-year records. ── */}
        <div style={{ marginTop: 18, padding: '14px 16px', borderRadius: 12, background: 'var(--inset)', border: '1px solid var(--inset-border)' }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 4 }}>Tipping policy</div>
          <div style={{ fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.6, marginBottom: 12 }}>
            {currency === 'GBP'
              ? 'How card tips are shared. Service charge is always pooled and distributed via Tronc. UK law: 100% of tips must reach staff (no deductions), paid no later than the end of the month after the customer tipped — keep a written policy.'
              : 'How card tips are shared. Service charge is always pooled and distributed via the weekly pool run. US federal law (FLSA): all tips belong to staff — owners, managers and supervisors can’t keep or receive pooled tips, and tip-credit rules vary by state.'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14 }}>
            <div>
              <label style={labelStyle}>Card tips go to</label>
              <select style={inputStyle} value={tipMode} onChange={e => setTipMode(e.target.value)} disabled={savingVenue}>
                <option value="pool">Pool everything (US: “shared pool”)</option>
                <option value="direct">Seller keeps their own (US: “no pooling”)</option>
                <option value="hybrid">Keep own + tip-out a % to the pool</option>
              </select>
            </div>
            {tipMode === 'hybrid' && (
              <div>
                <label style={labelStyle}>Tip-out to the pool (%)</label>
                <input style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }} type="number" min="0" max="100" step="5"
                  value={String(100 - (parseInt(directPct, 10) || 0))}
                  onChange={e => setDirectPct(String(Math.min(100, Math.max(0, 100 - (parseInt(e.target.value, 10) || 0)))))}
                  disabled={savingVenue} />
                <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 5 }}>US-style tip-out: each seller gives this % of their own tips to the pool and keeps the rest.</div>
              </div>
            )}
            {currency === 'GBP' && (<>
              <div>
                <label style={labelStyle}>Who decides allocation</label>
                <select style={inputStyle} value={tipAllocator} onChange={e => setTipAllocator(e.target.value)} disabled={savingVenue}>
                  <option value="employer">The business (NICs due on tips)</option>
                  <option value="troncmaster">Independent troncmaster (NIC-free)</option>
                </select>
                <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 5 }}>HMRC E24: tips allocated by an independent troncmaster are free of employee + employer NICs; employer-decided shares are not.</div>
              </div>
              {tipAllocator === 'troncmaster' && (
                <div>
                  <label style={labelStyle}>Troncmaster name</label>
                  <input style={inputStyle} value={troncmasterName} onChange={e => setTroncmasterName(e.target.value)} disabled={savingVenue} placeholder="e.g. Jane Doe / WMT Troncmaster Ltd" />
                  <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 5 }}>Must genuinely set the rules independently; HMRC must be told the tronc exists.</div>
                </div>
              )}
            </>)}
          </div>
          {/* Live worked example — the rule in plain money, both framings. */}
          {(() => {
            const keep = tipMode === 'direct' ? 100 : tipMode === 'hybrid' ? Math.min(100, Math.max(0, parseInt(directPct, 10) || 0)) : 0;
            const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '£';
            return (
              <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 12, lineHeight: 1.7 }}>
                <span style={{ fontWeight: 700, color: 'var(--t2)' }}>So with {sym}100 of card tips:</span>{' '}
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{sym}{keep}</span> stays with the sellers whose tables tipped it ·{' '}
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{sym}{100 - keep}</span> joins the weekly pool — split in <b>Tronc / tips</b> by hours × role weights (that's how kitchen and support staff share).
                Service charge always joins the pool. Payroll then shows each person's two tip lines: <b>direct</b> (their own tables) + <b>pooled</b> (their tronc share). The Tips report in Reports opens on this same policy.
              </div>
            );
          })()}
        </div>

        {/* ── Breaks policy (UK Working Time Regs 1998: 20-min break due over
              6h worked, 30-min for under-18s over 4.5h — paying it is optional
              and set here; timesheets flag any shortfall either way) ── */}
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 14, cursor: 'pointer', fontSize: 13, color: 'var(--t1)' }}>
          <input type="checkbox" checked={paidBreaks} onChange={e => setPaidBreaks(e.target.checked)} disabled={savingVenue} style={{ marginTop: 3 }} />
          <span>
            <b>Breaks are paid</b>
            <span style={{ display: 'block', fontSize: 11.5, color: 'var(--t3)', marginTop: 2 }}>
              When on, break minutes are paid on top of worked hours on new timesheets (changeable per timesheet). UK law requires a 20-minute rest break when working over 6 hours (30 minutes for under-18s over 4.5 hours) but does not require it to be paid — timesheets flag missing statutory breaks either way.
            </span>
          </span>
        </label>

        {/* v5.5.969 — venue break policy: default length + auto-deduct */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13, color: 'var(--t1)' }}>
          <b>Default break</b>
          <input type="number" min="0" max="120" value={defaultBreakMins}
            onChange={e => setDefaultBreakMins(e.target.value)} disabled={savingVenue}
            style={{ width: 64, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontFamily: 'inherit', fontSize: 13 }} />
          <span style={{ fontSize: 12, color: 'var(--t3)' }}>minutes — used for new rota shifts and manual timesheets</span>
        </div>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 10, cursor: 'pointer', fontSize: 13, color: 'var(--t1)' }}>
          <input type="checkbox" checked={autoBreak} onChange={e => setAutoBreak(e.target.checked)} disabled={savingVenue} style={{ marginTop: 3 }} />
          <span>
            <b>Auto-deduct the default break at clock-out</b>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 11.5, color: 'var(--t3)' }}>
              when no break was punched and the shift is over
              <input type="number" min="1" max="13" step="0.5" value={autoBreakHours}
                onChange={e => setAutoBreakHours(e.target.value)} disabled={savingVenue || !autoBreak}
                style={{ width: 52, padding: '3px 6px', borderRadius: 6, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontFamily: 'inherit', fontSize: 12 }} />
              hours. Never deducts less than the UK statutory minimum for the worker's age; managers can still edit any timesheet.
            </span>
          </span>
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn btn-acc" onClick={saveVenue} disabled={savingVenue}>
            <Icon name={savingVenue ? 'clock' : 'check'} size={14} /> {savingVenue ? 'Saving…' : 'Save venue settings'}
          </button>
        </div>
      </Card>

      {/* ───────────── SECTIONS ───────────── */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 700 }}>
            <Icon name="tag" size={15} /> Sections
          </div>
          <button className="btn btn-acc btn-sm" onClick={() => setEditing({ name: '', color: SECTION_COLOURS[0], minCoverage: 1 })}>
            <Icon name="plus" size={14} /> Add section
          </button>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.6, maxWidth: 520, marginBottom: 16 }}>
          Sections are the service zones you schedule against — Bar, Floor, Kitchen and so on. Minimum coverage warns you on the rota when a section is under-staffed.
        </div>

        {loading ? (
          <LoadingCard label="Loading sections…" />
        ) : secList.length === 0 ? (
          <EmptyState
            icon="tag"
            title="No sections yet"
            body="Add your first service section to start building rotas around it. Most venues begin with Bar, Floor and Kitchen."
            cta="Add section"
            onCta={() => setEditing({ name: '', color: SECTION_COLOURS[0], minCoverage: 1 })}
          />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Section</th>
                  <th style={{ ...th, textAlign: 'right' }}>Min coverage</th>
                  <th style={{ ...th, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {secList.map(s => (
                  <tr key={s.id}>
                    <td style={td}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
                        <span style={{ width: 11, height: 11, borderRadius: 3, background: s.color || 'var(--t3)', flexShrink: 0 }} />
                        <span style={{ fontWeight: 600 }}>{s.name || 'Untitled'}</span>
                      </span>
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--t2)' }}>{s.minCoverage ?? 1}</td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <span style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn btn-ghost btn-xs" onClick={() => setEditing(s)}><Icon name="edit" size={12} /> Edit</button>
                        <button className="btn btn-ghost btn-xs" onClick={() => removeSection(s)}><Icon name="trash" size={12} /></button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ───────────── ROLES POINTER ───────────── */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
          <Icon name="team" size={15} /> Roles &amp; pay rates
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.6, maxWidth: 560 }}>
          Your venue has {roleCount} role{roleCount === 1 ? '' : 's'} configured. Roles and their hourly rates, salaries, tronc weighting and SIA requirements are managed on the rate card under{' '}
          <span style={{ color: 'var(--t1)', fontWeight: 600 }}>Pay &amp; rates</span>. Changes there flow through to rota costing, timesheets and tronc automatically.
        </div>
      </Card>

      <WfTemplatesCard ctx={ctx} roles={roles} showToast={showToast} />

      {editing && (
        <SectionModal
          section={editing}
          onClose={() => setEditing(null)}
          onSave={saveSection}
        />
      )}
    </div>
  );
}

// ── Offer-letter & contract templates (create / edit / merge) ────────────────
const TOKENS = ['first_name', 'full_name', 'position', 'rate', 'contract_type', 'start_date', 'weekly_hours', 'business_name', 'today'];
const SAMPLE_VARS = { first_name: 'Jordan', full_name: 'Jordan Lee', position: 'Bartender', rate: '£12.50 per hour', contract_type: 'Part time', start_date: '1 July 2026', weekly_hours: '20', business_name: 'The Anchor', today: '9 June 2026' };

function WfTemplatesCard({ ctx, roles, showToast }) {
  const [tpls, setTpls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // template being edited/created

  async function reload() {
    setLoading(true);
    try { setTpls(await wf.loadTemplates(ctx.locationId) || []); }
    catch { setTpls(wf.DEFAULT_TEMPLATES); }
    finally { setLoading(false); }
  }
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [ctx.locationId]);

  const save = async (t) => {
    try {
      await wf.saveTemplate(t, ctx.locationId, ctx.orgId);
      setEditing(null);
      showToast('Template saved', 'success');
      reload();
    } catch (e) { showToast(e.message || 'Could not save template', 'error'); }
  };
  const remove = async (t) => {
    if (t.builtin) return;
    setTpls(prev => prev.filter(x => x.id !== t.id));
    try { await wf.deleteTemplate(t.id); showToast('Template deleted', 'info'); } catch { reload(); }
  };

  const offers = tpls.filter(t => t.kind === 'offer');
  const contracts = tpls.filter(t => t.kind === 'contract');

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Offer letters &amp; contracts</div>
          <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 2 }}>Reusable templates with merge fields — onboarding fills in each person's details and sends them. Edit the wording to suit your business.</div>
        </div>
        <button className="btn btn-acc btn-sm" onClick={() => setEditing({ kind: 'offer', name: '', body: '', contractType: '' })}><Icon name="plus" size={14} /> New template</button>
      </div>
      {loading ? <div style={{ color: 'var(--t3)', fontSize: 13, padding: 8 }}>Loading…</div> : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <TemplateList title="Offer letters" list={offers} onEdit={setEditing} onRemove={remove} />
          <TemplateList title="Contracts" list={contracts} onEdit={setEditing} onRemove={remove} />
        </div>
      )}
      {editing && <TemplateEditor tpl={editing} onClose={() => setEditing(null)} onSave={save} />}
    </Card>
  );
}

function TemplateList({ title, list, onEdit, onRemove }) {
  return (
    <div>
      <div className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t4)', marginBottom: 8 }}>{title}</div>
      <div style={{ display: 'grid', gap: 6 }}>
        {list.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--t4)' }}>None yet.</div>}
        {list.map(t => (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 11px', borderRadius: 10, background: 'var(--inset)', border: '1px solid var(--inset-border)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}{t.builtin && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--t4)', fontFamily: 'var(--font-mono)' }}>BUILT-IN</span>}</div>
              {t.contractType && <div style={{ fontSize: 10.5, color: 'var(--t4)' }}>For {t.contractType}</div>}
            </div>
            <button className="btn btn-ghost btn-xs" onClick={() => onEdit(t.builtin ? { ...t, id: undefined, builtin: false, name: t.name + ' (copy)' } : t)}>{t.builtin ? 'Duplicate' : 'Edit'}</button>
            {!t.builtin && <button className="btn btn-ghost btn-xs" onClick={() => onRemove(t)} title="Delete"><Icon name="close" size={12} /></button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function TemplateEditor({ tpl, onClose, onSave }) {
  const [f, setF] = useState({ id: tpl.id, kind: tpl.kind || 'offer', name: tpl.name || '', body: tpl.body || '', contractType: tpl.contractType || '' });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const valid = f.name.trim() && f.body.trim();
  const preview = wf.mergeTemplate(f.body, SAMPLE_VARS);
  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 760, maxHeight: '88vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 14 }}>{tpl.id && !tpl.builtin ? 'Edit template' : 'New template'}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div><label style={labelStyle}>Name</label><input style={inputStyle} value={f.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Part-time contract" /></div>
          <div><label style={labelStyle}>Type</label><select style={inputStyle} value={f.kind} onChange={e => set('kind', e.target.value)}><option value="offer">Offer letter</option><option value="contract">Contract</option></select></div>
          {f.kind === 'contract' && <div style={{ gridColumn: '1 / -1' }}><label style={labelStyle}>Applies to (optional)</label><select style={inputStyle} value={f.contractType} onChange={e => set('contractType', e.target.value)}><option value="">Any contract type</option><option value="zeroHours">Zero hours</option><option value="partTime">Part time</option><option value="fullTime">Full time</option><option value="salaried">Salaried</option></select></div>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div>
            <label style={labelStyle}>Body</label>
            <textarea style={{ ...inputStyle, height: 300, padding: 12, fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.6, resize: 'vertical' }} value={f.body} onChange={e => set('body', e.target.value)} placeholder="Type your letter/contract. Use merge fields like {{first_name}}." />
            <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 6 }}>Merge fields (click to insert): {TOKENS.map(tk => <button key={tk} onClick={() => set('body', f.body + `{{${tk}}}`)} style={{ margin: '2px 3px 0 0', padding: '2px 6px', borderRadius: 6, border: '1px solid var(--inset-border)', background: 'var(--inset)', color: 'var(--t2)', fontFamily: 'var(--font-mono)', fontSize: 10.5, cursor: 'pointer' }}>{`{{${tk}}}`}</button>)}</div>
          </div>
          <div>
            <label style={labelStyle}>Preview (sample data)</label>
            <div style={{ height: 300, overflowY: 'auto', padding: 14, borderRadius: 10, background: 'var(--bg3)', border: '1px solid var(--bdr2)', fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{preview}</div>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-acc" disabled={!valid} onClick={() => onSave(f)}>Save template</button>
        </div>
      </div>
    </div>
  );
}

function SectionModal({ section, onClose, onSave }) {
  const [name, setName] = useState(section.name || '');
  const [color, setColor] = useState(section.color || SECTION_COLOURS[0]);
  const [minCoverage, setMinCoverage] = useState(String(section.minCoverage ?? 1));
  const isNew = !section.id;
  const valid = name.trim().length > 0;

  function submit() {
    const mc = Number(minCoverage);
    onSave({
      ...section,
      name: name.trim(),
      color,
      minCoverage: Number.isFinite(mc) && mc >= 0 ? Math.round(mc) : 1,
    });
  }

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 480 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{isNew ? 'Add section' : 'Edit section'}</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><Icon name="close" size={14} /></button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelStyle}>Section name</label>
            <input style={inputStyle} autoFocus value={name} placeholder="e.g. Terrace" onChange={e => setName(e.target.value)} />
          </div>

          <div>
            <label style={labelStyle}>Colour</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {SECTION_COLOURS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  style={{
                    width: 30, height: 30, borderRadius: 8, background: c, cursor: 'pointer',
                    border: color === c ? '2.5px solid var(--t1)' : '2px solid var(--bdr2)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
                  }}
                >
                  {color === c && <Icon name="check" size={14} />}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label style={labelStyle}>Minimum coverage</label>
            <input
              style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
              type="number" min="0" step="1" inputMode="numeric"
              value={minCoverage} onChange={e => setMinCoverage(e.target.value)}
            />
            <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 6 }}>People required on the floor for this section during service.</div>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-acc" disabled={!valid} onClick={submit}>
            <Icon name="check" size={14} /> {isNew ? 'Add section' : 'Save section'}
          </button>
        </div>
      </div>
    </div>
  );
}
