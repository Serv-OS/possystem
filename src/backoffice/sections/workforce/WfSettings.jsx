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

export default function WfSettings({ ctx, staff, roles, sections, settings, week, showToast }) {
  const [loading, setLoading] = useState(true);
  const [secList, setSecList] = useState(sections || []);
  const [editing, setEditing] = useState(null); // section being added/edited

  // Venue form fields (whole-number percentages for the inputs)
  const [labourTarget, setLabourTarget] = useState('');
  const [accrualRate, setAccrualRate] = useState('');
  const [currency, setCurrency] = useState('GBP');
  const [salesSource, setSalesSource] = useState('pos');
  const [savingVenue, setSavingVenue] = useState(false);

  // Seed venue form from props.settings
  useEffect(() => {
    setLabourTarget(String(pct(settings?.labourTargetPct ?? 0.28)));
    setAccrualRate(String(pct(settings?.accrualRate ?? 0.1207)));
    setCurrency(settings?.currency || 'GBP');
    setSalesSource(settings?.salesSource || 'pos');
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
    setSavingVenue(true);
    const patch = {
      currency,
      salesSource,
      labourTargetPct: lt / 100,
      accrualRate: ac / 100,
      premiums: settings?.premiums || {},
      settings: settings?.settings || {},
    };
    try {
      await wf.saveSettings(patch, ctx.locationId, ctx.orgId);
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
